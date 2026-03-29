# Baanbaan Merchant Appliance — Architecture Blueprint

## 1. System Identity

The Merchant Appliance is a **thin bridge** between customers and restaurant
POS systems. It handles pickup and delivery ordering. The merchant's POS is the
system of record. The appliance is a transient relay with minimal data retention.

```
Customer (phone/web)
      │
      ▼
┌─────────────────────────────────────────────────┐
│           Baanbaan Merchant Appliance            │
│                                                 │
│   Accepts orders from customers                 │
│   Relays to merchant's POS                      │
│   Tracks status until pickup/delivery           │
│   Forgets after 7 days (archives to 2 months)   │
│                                                 │
└─────────────────────────────────────────────────┘
      │
      ▼
Merchant POS (Square, Toast, Clover, ...)
      │
      └── System of record
          Refunds, disputes, history = merchant's responsibility
```

### What This System Does NOT Do

- Does not own the customer relationship (refunds, complaints → merchant)
- Does not replace the POS — it feeds orders into it
- Does not store permanent records — 7-day hot, 2-month archive, then purged
- Does not run in the cloud (designed for ARM clusters, can be adapted to cloud)
- Does not require a sysadmin — install and forget


## 2. Deployment Model

### ARM Cluster Appliance

```
┌────────────────────────────────────────────────────────┐
│              ARM Cluster Node (4GB RAM)                 │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │          Single Bun Process (~30-50MB)            │  │
│  │                                                   │  │
│  │  Bun.serve()       → HTTP + API layer             │  │
│  │  bun:sqlite (WAL)  → Hot data (7-day rolling)     │  │
│  │  SAM instances     → Workflow state machines       │  │
│  │  POS adapters      → Relay orders to POS systems   │  │
│  │  Cron scheduler    → Nightly archive + purge       │  │
│  │  Auto-updater      → Pull + restart on new version │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  data/                                                 │
│  ├── merchant.db           (~1.4GB hot, 7-day window)  │
│  ├── archive/                                          │
│  │   ├── 2026-02-15.orders.jsonl   (~200MB/day)        │
│  │   ├── ...                                           │
│  │   └── (auto-purged at 60 days)                      │
│  └── config/                                           │
│      └── appliance.json    (version, update URL)       │
│                                                        │
│  External dependencies: ZERO                           │
│  Total RAM: ~30-50MB                                   │
│  Total disk: ~12GB (hot + cold)                        │
│  Capacity: 500-1,000 merchants per node                │
└────────────────────────────────────────────────────────┘
```

### Capacity Math

| Metric | Value |
|---|---|
| Merchants per cluster | up to 1,000 |
| Orders per merchant per month | ~2,000 |
| Peak orders per second (cluster) | ~4 |
| Hot data window | 7 days |
| Hot order rows | ~467,000 |
| Hot DB size | ~1.4 GB |
| Cold archive per day | ~200 MB (JSONL) |
| Cold archive total (2 months) | ~10 GB |
| Archive search | Off-hours only (before 11am, after 10pm) |


## 3. SAM Pattern Architecture

The SAM (State-Action-Model) pattern governs all stateful workflows in the
appliance. SAM provides a unidirectional, reactive data flow grounded in
TLA+ temporal logic semantics.

Libraries: `sam-pattern` (v1.5.10) and `sam-fsm` (v0.9.24)

### SAM Step Semantics

Each SAM step is an atomic, synchronized sequence:

```
  Action ──propose──▶ Model (Acceptors → Reactors) ──▶ State Repr. ──▶ Render
                                                            │
                                                       NAP (next-action-predicate)
                                                            │
                                                            ▼
                                                       Next Action (automatic)
```

- **Actions** present data to the model as a proposal (they never mutate)
- **Acceptors** accept/reject proposals and mutate application state
- **Reactors** compute invariant mutations (derived state, functions of state only)
- **State Representation** computes the control state for rendering
- **NAPs** trigger automatic follow-up actions (suspend rendering until complete)

### SAM on the Server — Workflow Orchestration

Each server-side workflow is a SAM instance created via `createInstance()`.
Workflows with well-defined state transitions use `sam-fsm`.

#### Order Relay Workflow (sam-fsm)

The order relay is the core workflow. It manages the lifecycle of an order
as it flows from customer → appliance → POS → merchant → customer.

```
States:
  ┌──────────┐    ┌───────────┐    ┌───────────┐    ┌──────────┐
  │ received │───▶│ submitted │───▶│ confirmed │───▶│ preparing│
  └──────────┘    │  (to POS) │    │ (by merch)│    └──────────┘
                  └───────────┘    └───────────┘         │
                       │                                  ▼
                       ▼                            ┌──────────┐
                  ┌───────────┐                     │  ready   │
                  │ pos_error │                     └──────────┘
                  └───────────┘                          │
                       │                                  ▼
                       ▼                            ┌───────────┐
                  ┌───────────┐                     │ picked_up │
                  │ cancelled │◀────────────────────│ /completed│
                  └───────────┘    (any state)      └───────────┘
```

**FSM Definition (using sam-fsm):**

```typescript
import { fsm } from 'sam-fsm'

const orderRelayFSM = fsm({
  pc: 'status',       // control state stored as 'status' in the model
  pc0: 'received',    // initial state

  transitions: [
    { from: 'received',  to: 'submitted', on: 'SUBMIT_TO_POS' },
    { from: 'received',  to: 'cancelled', on: 'CANCEL' },
    { from: 'submitted', to: 'confirmed', on: 'POS_CONFIRMED' },
    { from: 'submitted', to: 'pos_error', on: 'POS_ERROR' },
    { from: 'submitted', to: 'cancelled', on: 'CANCEL' },
    { from: 'pos_error', to: 'submitted', on: 'SUBMIT_TO_POS' },
    { from: 'pos_error', to: 'cancelled', on: 'CANCEL' },
    { from: 'confirmed', to: 'preparing', on: 'START_PREPARING' },
    { from: 'confirmed', to: 'cancelled', on: 'CANCEL' },
    { from: 'preparing', to: 'ready',     on: 'MARK_READY' },
    { from: 'preparing', to: 'cancelled', on: 'CANCEL' },
    { from: 'ready',     to: 'completed', on: 'COMPLETE' },
    { from: 'ready',     to: 'cancelled', on: 'CANCEL' },
  ],

  deterministic: true,
  enforceAllowedTransitions: true,
  blockUnexpectedActions: true,

  // NAPs: automatic actions triggered by state
  states: {
    received: {
      transitions: ['SUBMIT_TO_POS', 'CANCEL'],
      naps: [{
        condition: () => true,
        // Auto-submit to POS immediately after receiving
        nextAction: (state) => submitToPOS(state.orderId)
      }]
    },
    pos_error: {
      transitions: ['SUBMIT_TO_POS', 'CANCEL'],
      naps: [{
        condition: ({ retryCount }) => retryCount < 3,
        // Auto-retry with backoff
        nextAction: (state) =>
          setTimeout(() => submitToPOS(state.orderId), state.retryCount * 2000)
      }, {
        condition: ({ retryCount }) => retryCount >= 3,
        // Give up after 3 retries — merchant handles manually
        nextAction: (state) => notifyMerchant(state.orderId, 'pos_unreachable')
      }]
    },

    // Guards: can only cancel if not yet picked up
    ready: {
      transitions: ['COMPLETE', 'CANCEL'],
      guards: [{
        action: 'CANCEL',
        condition: ({ pickedUpAt }) => !pickedUpAt
      }]
    }
  }
})
```

**SAM Component (using sam-pattern):**

```typescript
import { api, createInstance } from 'sam-pattern'

// Each active order gets its own SAM instance
function createOrderWorkflow(orderId: string, initialOrder: OrderData) {
  const instance = createInstance({ instanceName: `order:${orderId}` })
  const SAM = api(instance)

  return SAM({
    initialState: orderRelayFSM.initialState({
      orderId,
      order: initialOrder,
      retryCount: 0,
      posOrderId: null,
      pickupCode: null,
      estimatedReadyAt: null,
    }),

    component: {
      actions: [
        // Actions propose data — they never mutate state
        ['SUBMIT_TO_POS', (orderId) => {
          const adapter = posRegistry.getAdapter(initialOrder.merchantId)
          return adapter.submitOrder(initialOrder)
            .then(result => ({ posResponse: result }))
            .catch(error => ({ posError: error.message }))
        }],
        ['POS_CONFIRMED', (posData) => ({ posConfirmation: posData })],
        ['POS_ERROR',      (error)  => ({ posError: error })],
        ['START_PREPARING', ()      => ({ preparingAt: new Date().toISOString() })],
        ['MARK_READY',     ()       => ({ readyAt: new Date().toISOString() })],
        ['COMPLETE',       ()       => ({ completedAt: new Date().toISOString() })],
        ['CANCEL',         (reason) => ({ cancelledAt: new Date().toISOString(), reason })],
        // FSM events from POS webhooks
        orderRelayFSM.event('POS_STATUS_UPDATE'),
      ],

      acceptors: [
        // FSM acceptors handle state transitions automatically
        ...orderRelayFSM.acceptors,

        // Domain acceptors — mutate model from proposals
        model => proposal => {
          if (proposal.posResponse?.success) {
            model.posOrderId = proposal.posResponse.posOrderId
            model.estimatedReadyAt = proposal.posResponse.estimatedMinutes
              ? new Date(Date.now() + proposal.posResponse.estimatedMinutes * 60000).toISOString()
              : null
            model.pickupCode = generatePickupCode()
          }
          if (proposal.posResponse && !proposal.posResponse.success) {
            model.retryCount = (model.retryCount || 0) + 1
          }
          if (proposal.posError) {
            model.retryCount = (model.retryCount || 0) + 1
            model.lastError = proposal.posError
          }
          if (proposal.reason) model.cancellationReason = proposal.reason
          if (proposal.preparingAt) model.preparingAt = proposal.preparingAt
          if (proposal.readyAt) model.readyAt = proposal.readyAt
          if (proposal.completedAt) model.completedAt = proposal.completedAt
          if (proposal.cancelledAt) model.cancelledAt = proposal.cancelledAt
        }
      ],

      reactors: [
        // FSM state machine reactor computes control state
        ...orderRelayFSM.stateMachine,

        // Domain reactor: persist to SQLite after every step
        (model) => {
          dehydrateOrder(model.orderId, model)
        }
      ],

      options: {
        ignoreOutdatedProposals: true, // cancel stale POS responses
        retry: { delay: 2000, max: 3 } // built-in retry for failed actions
      }
    },

    render: (state) => {
      // Broadcast status change via SSE to connected clients
      broadcastOrderUpdate(state.orderId, state.status)
    },

    // NAPs from the FSM definition
    naps: orderRelayFSM.naps
  })
}
```

**Key SAM features used:**
- `createInstance()` — one SAM instance per active order (isolated state)
- `orderRelayFSM.acceptors` — FSM auto-mutates `status` (the `pc` variable)
- `orderRelayFSM.stateMachine` — reactor that enforces valid transitions
- `orderRelayFSM.naps` — automatic follow-up actions (auto-submit, auto-retry)
- `ignoreOutdatedProposals` — cancels stale POS responses if a newer action arrived
- `retry` — built-in retry with backoff for POS adapter failures
- Transition guards — prevent cancellation after pickup
- `blockUnexpectedActions` — silently ignore actions invalid for current state

**Hydration/Dehydration:**

The library does not provide built-in serialization. We dehydrate by
persisting the model state (which includes `status` from the FSM's `pc`)
to SQLite after every step via a reactor. On restart, we read active
orders from SQLite and recreate SAM instances with `addInitialState()`
using the persisted model. The NAPs fire automatically and resume each
workflow from where it left off.

```sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  status TEXT NOT NULL,           -- FSM control state (pc: 'status')
  sam_state TEXT,                 -- full dehydrated model as JSON
  order_data TEXT NOT NULL,       -- original order as JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Crash recovery**: On startup, query all orders where
`status NOT IN ('completed', 'cancelled')`, deserialize `sam_state`,
recreate SAM+FSM instances with that state, and the NAPs automatically
trigger the next action for each one.

#### POS Sync Workflow (sam-pattern)

Menu synchronization from the POS. Uses plain sam-pattern (no FSM needed
— this is a simple fetch-diff-apply cycle).

```typescript
const posSyncSAM = api(createInstance({ instanceName: 'pos-sync' }))

posSyncSAM({
  initialState: { syncing: false, lastSyncAt: null, errors: [] },

  component: {
    actions: [
      ['SYNC_MENU', async (merchantId) => {
        const adapter = posRegistry.getAdapter(merchantId)
        const menuData = await adapter.fetchMenu()
        return { merchantId, menuData }
      }],
    ],

    acceptors: [
      model => proposal => {
        if (proposal.menuData) {
          model.syncing = false
          model.lastSyncAt = new Date().toISOString()
          // Diff and apply to SQLite happens here
          applyMenuDiff(proposal.merchantId, proposal.menuData)
        }
      }
    ],

    options: {
      retry: { delay: 5000, max: 2 }
    }
  },

  render: (state) => {
    // Log sync status
  }
})
```

#### Auto-Updater Workflow (sam-fsm)

```typescript
const updaterFSM = fsm({
  pc: 'updateStatus',
  pc0: 'current',
  transitions: [
    { from: 'current',      to: 'checking',    on: 'CHECK' },
    { from: 'checking',     to: 'downloading',  on: 'DOWNLOAD' },
    { from: 'checking',     to: 'current',      on: 'NO_UPDATE' },
    { from: 'downloading',  to: 'ready',        on: 'VERIFIED' },
    { from: 'downloading',  to: 'current',      on: 'CHECKSUM_FAIL' },
    { from: 'ready',        to: 'applying',     on: 'APPLY' },
    { from: 'applying',     to: 'current',      on: 'RESTART' },
  ],
  deterministic: true,
  states: {
    current: {
      transitions: ['CHECK'],
      naps: [{
        condition: ({ lastCheckAt }) => {
          const hourAgo = Date.now() - 3600_000
          return !lastCheckAt || new Date(lastCheckAt).getTime() < hourAgo
        },
        nextAction: () => setTimeout(checkForUpdate, 1000)
      }]
    },
    ready: {
      transitions: ['APPLY'],
      naps: [{
        condition: () => true,
        // Auto-apply: dehydrate all SAM instances, then restart
        nextAction: () => applyUpdate()
      }]
    }
  }
})
```

### SAM on the Client — UI State Management

The client (TanStack/Vite SPA) uses SAM for UI state with
hydration/dehydration to localStorage.

#### Merchant Dashboard (sam-fsm)

```typescript
import { api, createInstance } from 'sam-pattern'
import { fsm } from 'sam-fsm'

const dashboardFSM = fsm({
  pc: 'view',
  pc0: 'idle',
  transitions: {
    idle:             { LOAD: 'loading' },
    loading:          { LOADED: 'viewing_orders', ERROR: 'idle' },
    viewing_orders:   { VIEW_MENU: 'managing_menu', VIEW_ARCHIVE: 'viewing_archive' },
    managing_menu:    { VIEW_ORDERS: 'viewing_orders' },
    viewing_archive:  { VIEW_ORDERS: 'viewing_orders' },
  },
  deterministic: true,
})

const DashboardSAM = createInstance({ instanceName: 'dashboard' })

const { intents } = api(DashboardSAM)({
  initialState: dashboardFSM.initialState({
    merchantId: null,
    orders: [],
    menu: [],
    // Rehydrate from localStorage if available
    ...rehydrateClientState('dashboard', 30 * 60_000)  // 30min TTL
  }),

  component: {
    actions: [
      ['LOAD', async (merchantId) => {
        const orders = await fetch(`/api/merchant/orders`).then(r => r.json())
        return { orders, merchantId }
      }],
      ['LOADED', (data) => data],
    ],

    acceptors: [
      ...dashboardFSM.acceptors,
      model => proposal => {
        if (proposal.orders) model.orders = proposal.orders
        if (proposal.merchantId) model.merchantId = proposal.merchantId
      }
    ],

    reactors: [
      ...dashboardFSM.stateMachine,
      // Dehydrate to localStorage after every step
      (model) => {
        dehydrateClientState('dashboard', model)
      }
    ],
  },

  render: (state) => {
    // TanStack Router renders the appropriate view based on state.view
    updateUI(state)
  },

  naps: dashboardFSM.naps,
})

const [load] = intents
```

#### Customer Order Flow (sam-fsm)

```typescript
const customerFlowFSM = fsm({
  pc: 'step',
  pc0: 'browsing',
  transitions: [
    { from: 'browsing',     to: 'cart',          on: 'ADD_TO_CART' },
    { from: 'cart',         to: 'cart',          on: 'ADD_TO_CART' },
    { from: 'cart',         to: 'cart',          on: 'REMOVE_ITEM' },
    { from: 'cart',         to: 'browsing',      on: 'CLEAR_CART' },
    { from: 'cart',         to: 'checkout',      on: 'CHECKOUT' },
    { from: 'checkout',     to: 'cart',          on: 'BACK_TO_CART' },
    { from: 'checkout',     to: 'order_placed',  on: 'PLACE_ORDER' },
    { from: 'order_placed', to: 'tracking',      on: 'ORDER_CONFIRMED' },
  ],
  deterministic: true,
  states: {
    order_placed: {
      transitions: ['ORDER_CONFIRMED'],
      naps: [{
        condition: () => true,
        // Auto-start polling for order status
        nextAction: (state) => pollOrderStatus(state.orderId)
      }]
    },
    checkout: {
      transitions: ['BACK_TO_CART', 'PLACE_ORDER'],
      guards: [{
        action: 'PLACE_ORDER',
        // Can only place if cart has items and contact info provided
        condition: ({ cart, customerPhone }) =>
          cart.length > 0 && !!customerPhone
      }]
    }
  },
})

// Cart persists across page refreshes via localStorage
const CustomerSAM = createInstance({ instanceName: 'customer-order' })

api(CustomerSAM)({
  initialState: customerFlowFSM.initialState({
    cart: [],
    merchantSlug: null,
    customerName: '',
    customerPhone: '',
    orderId: null,
    ...rehydrateClientState('customer-order', 24 * 60 * 60_000) // 24hr TTL
  }),

  component: {
    actions: [
      ['ADD_TO_CART', (item) => ({ cartAdd: item })],
      ['REMOVE_ITEM', (index) => ({ cartRemove: index })],
      ['CHECKOUT', () => ({ checkout: true })],
      ['PLACE_ORDER', async (orderData) => {
        const result = await fetch('/api/orders', {
          method: 'POST',
          body: JSON.stringify(orderData),
        }).then(r => r.json())
        return { orderResult: result }
      }],
    ],

    acceptors: [
      ...customerFlowFSM.acceptors,
      model => proposal => {
        if (proposal.cartAdd) model.cart.push(proposal.cartAdd)
        if (proposal.cartRemove !== undefined) model.cart.splice(proposal.cartRemove, 1)
        if (proposal.orderResult?.id) model.orderId = proposal.orderResult.id
      }
    ],

    reactors: [
      ...customerFlowFSM.stateMachine,
      (model) => dehydrateClientState('customer-order', model)
    ],

    options: {
      // Reject stale async responses (e.g., slow place-order calls)
      ignoreOutdatedProposals: true,
    }
  },

  render: (state) => updateUI(state),
  naps: customerFlowFSM.naps,
})
```

**Client hydration flow on page load:**

```
1. Call rehydrateClientState(key, maxAgeMs)
   → reads from localStorage, checks TTL
2. If valid state found:
   → Pass as spread into initialState (merges with FSM defaults)
   → FSM's pc variable restores the control state
   → Render fires immediately with restored view
   → NAPs fire any pending actions (e.g., resume polling)
3. If not found or expired:
   → Fresh SAM instance with default initial state
   → Fetch data from server
```

### SAM Model Checker — Verifying Workflows

The sam-pattern library includes a model checker that exhaustively explores
state space to verify liveness and safety properties. We use this in tests
to prove our FSM workflows are correct.

```typescript
import { checker } from 'sam-pattern'

checker({
  instance: orderRelayInstance,
  intents: [submitToPOS, posConfirmed, posError, cancel, complete],
  reset: () => createOrderWorkflow('test', testOrder),
  // Liveness: every order eventually reaches completed or cancelled
  liveness: (state) =>
    state.status === 'completed' || state.status === 'cancelled',
  // Safety: a completed order must have a pickup code
  safety: (state) =>
    state.status === 'completed' && !state.pickupCode,
  options: {
    depthMax: 8,
    noDuplicateAction: true,
  },
  success: (behavior) => console.log('All paths verified:', behavior),
  err: (violation) => console.error('Violation found:', violation),
})
```


## 4. POS Adapter Interface

The POS adapter is the core integration abstraction. Each POS system
(Square, Toast, Clover, custom) gets an adapter that implements this
interface.

```typescript
/**
 * POS Adapter Interface
 *
 * Each POS integration implements this interface.
 * Adapters handle the translation between the appliance's
 * order format and the POS's native API.
 */
interface POSAdapter {
  /** Unique identifier for this POS type */
  readonly posType: string

  /**
   * Submit an order to the POS system.
   * Returns a POS-specific order reference.
   */
  submitOrder(order: OrderData): Promise<POSOrderResult>

  /**
   * Check the status of an order in the POS.
   * Used for polling-based POS systems.
   */
  getOrderStatus(posOrderId: string): Promise<POSOrderStatus>

  /**
   * Fetch the current menu from the POS.
   * Used for menu synchronization.
   */
  fetchMenu(): Promise<POSMenuData>

  /**
   * Test the connection to the POS.
   * Used during merchant onboarding and health checks.
   */
  testConnection(): Promise<{ ok: boolean; error?: string }>

  /**
   * Register a webhook URL with the POS for status updates.
   * Not all POS systems support this — returns false if unsupported.
   */
  registerWebhook?(callbackUrl: string): Promise<boolean>
}

interface POSOrderResult {
  success: boolean
  posOrderId?: string
  error?: string
  estimatedMinutes?: number
}

type POSOrderStatus =
  | 'accepted'
  | 'rejected'
  | 'preparing'
  | 'ready'
  | 'completed'
  | 'unknown'

interface POSMenuData {
  categories: Array<{
    name: string
    items: Array<{
      posItemId: string
      name: string
      description?: string
      priceCents: number
      available: boolean
      modifierGroups?: Array<{
        name: string
        required: boolean
        minSelect: number
        maxSelect: number
        options: Array<{
          name: string
          priceCents: number
          available: boolean
        }>
      }>
    }>
  }>
}
```

### Adapter Registry

```typescript
/**
 * POS Adapter Registry
 *
 * Merchants register their POS type and credentials.
 * The registry creates the appropriate adapter instance.
 */
interface POSAdapterRegistry {
  /** Register an adapter factory for a POS type */
  register(posType: string, factory: POSAdapterFactory): void

  /** Get an adapter instance for a merchant */
  getAdapter(merchant: MerchantConfig): POSAdapter

  /** List available POS types */
  listAvailable(): string[]
}

type POSAdapterFactory = (config: POSConnectionConfig) => POSAdapter

interface POSConnectionConfig {
  posType: string
  apiKey?: string
  apiSecret?: string
  locationId?: string
  webhookSecret?: string
  baseUrl?: string
  [key: string]: unknown  // POS-specific config
}
```

### Initial Adapters

| POS | Integration Model | Priority |
|---|---|---|
| **Generic Webhook** | Receive orders via webhook callback | P0 (MVP) |
| **Manual** | Merchant confirms via dashboard UI | P0 (MVP) |
| **Square** | Square Orders API | P1 |
| **Toast** | Toast Orders API | P1 |
| **Clover** | Clover Orders API | P2 |


## 5. Data Architecture

### SQLite Schema (Hot Data — 7-Day Window)

```sql
-- Core merchant record
-- Minimal: just enough to route orders and serve menus
CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  pos_type TEXT NOT NULL DEFAULT 'manual',
  pos_config TEXT,              -- JSON: POSConnectionConfig
  contact_phone TEXT,
  contact_email TEXT,
  timezone TEXT DEFAULT 'America/New_York',
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Menu data (synced from POS or entered manually)
CREATE TABLE menu_items (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  modifiers TEXT,               -- JSON: modifier groups
  available INTEGER DEFAULT 1,
  display_order INTEGER DEFAULT 0,
  pos_item_id TEXT,             -- reference back to POS
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Orders (7-day rolling window)
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  customer_name TEXT,
  customer_phone TEXT,
  delivery_method TEXT NOT NULL, -- 'pickup' or 'delivery'
  status TEXT NOT NULL DEFAULT 'received',
  sam_state TEXT,                -- dehydrated SAM workflow state
  items TEXT NOT NULL,           -- JSON: order items with modifiers
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  pos_order_id TEXT,             -- POS reference after submission
  pickup_code TEXT,
  notes TEXT,
  estimated_ready_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for hot queries
CREATE INDEX idx_orders_merchant_status ON orders(merchant_id, status);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_menu_items_merchant ON menu_items(merchant_id);
CREATE INDEX idx_merchants_slug ON merchants(slug);

-- Simple auth: merchant users
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  merchant_id TEXT REFERENCES merchants(id),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff', -- 'owner', 'manager', 'staff'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Appliance metadata
CREATE TABLE appliance_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Stores: version, last_update_check, last_archive_run, etc.
```

### JSONL Archive Format (Cold Data)

File: `data/archive/YYYY-MM-DD.orders.jsonl`

One order per line, complete with items. Written during nightly rollover.

```jsonl
{"id":"ord_a1b2","merchantId":"m_xyz","customerName":"Jane","phone":"555-0101","delivery":"pickup","status":"completed","items":[{"name":"Pad Thai","qty":1,"cents":1499,"mods":[{"name":"Extra spicy","cents":0}]}],"totalCents":1499,"posOrderId":"sq_123","pickupCode":"A7K2","createdAt":"2026-02-08T18:30:00Z","completedAt":"2026-02-08T18:52:00Z"}
```

### Nightly Rollover Process

```
Schedule: 3:00 AM local time (per merchant timezone, or cluster-wide)

1. BEGIN IMMEDIATE                         -- exclusive write lock
2. SELECT * FROM orders
   WHERE created_at < datetime('now', '-7 days')
   ORDER BY created_at
3. Group by date → append to YYYY-MM-DD.orders.jsonl
4. DELETE FROM orders
   WHERE created_at < datetime('now', '-7 days')
5. COMMIT
6. Delete archive files older than 60 days
7. PRAGMA wal_checkpoint(TRUNCATE)         -- reclaim WAL space
```

### Off-Hours Archive Search

```
Available: before 11:00 AM and after 10:00 PM (merchant local time)

1. Validate time window
2. Read requested date file(s): data/archive/YYYY-MM-DD.orders.jsonl
3. Stream line-by-line, filter by merchantId
4. Return matching orders (read-only, no DB involvement)
```


## 6. API Design

### Endpoint Structure

Given the appliance's simplicity (~15 operations), a typed REST API is
the lightest option. GraphQL can be added later if the frontend benefits
from it.

```
── Public (customer-facing) ─────────────────────────────

GET    /api/merchants                    List active merchants
GET    /api/merchants/:slug              Merchant detail + menu
GET    /api/merchants/:slug/menu         Full menu with modifiers
POST   /api/orders                       Place an order
GET    /api/orders/:id/status            Track order status (polling)

── Authenticated (merchant-facing) ──────────────────────

POST   /api/auth/login                   Get JWT token
POST   /api/auth/refresh                 Refresh token

GET    /api/merchant/orders              Active orders (last 7 days)
GET    /api/merchant/orders/archive      Search archived orders (off-hours)
PATCH  /api/merchant/orders/:id          Update order status
GET    /api/merchant/menu                Current menu
PUT    /api/merchant/menu                Replace menu
PATCH  /api/merchant/menu/:itemId        Update single item
PATCH  /api/merchant/settings            Update merchant settings

── Internal (appliance management) ──────────────────────

GET    /health                           Liveness probe
GET    /health/ready                     Readiness probe
GET    /api/appliance/version            Current version info
POST   /api/appliance/update             Trigger manual update check

── Webhook (POS callbacks) ──────────────────────────────

POST   /api/webhooks/pos/:merchantId     Receive POS status updates
```

### Authentication

- **Customer endpoints**: No auth (public)
- **Merchant endpoints**: JWT (HS256, signed with appliance secret)
- **Appliance endpoints**: Local-only or API key
- **Webhook endpoints**: HMAC signature verification per POS adapter


## 7. Project Structure

```
merchant/
├── src/
│   ├── index.ts                  # Entry point: Bun.serve() + startup
│   │
│   ├── server/
│   │   ├── router.ts             # Hono router setup
│   │   ├── middleware/
│   │   │   ├── auth.ts           # JWT verification
│   │   │   ├── time-gate.ts      # Off-hours restriction for archive
│   │   │   └── cors.ts           # CORS configuration
│   │   └── routes/
│   │       ├── public.ts         # Customer-facing routes
│   │       ├── merchant.ts       # Authenticated merchant routes
│   │       ├── webhook.ts        # POS webhook receivers
│   │       └── appliance.ts      # Health, version, update routes
│   │
│   ├── sam/
│   │   ├── order-relay.ts        # Order relay SAM-FSM workflow
│   │   ├── pos-sync.ts           # POS menu sync SAM workflow
│   │   ├── auto-updater.ts       # Self-update SAM workflow
│   │   └── hydration.ts          # Dehydrate/rehydrate SAM ↔ SQLite
│   │
│   ├── pos/
│   │   ├── adapter.ts            # POSAdapter interface
│   │   ├── registry.ts           # Adapter registry
│   │   ├── adapters/
│   │   │   ├── manual.ts         # Manual confirmation (no POS)
│   │   │   ├── webhook.ts        # Generic webhook-based POS
│   │   │   ├── square.ts         # Square POS adapter
│   │   │   └── toast.ts          # Toast POS adapter
│   │   └── types.ts              # Shared POS types
│   │
│   ├── db/
│   │   ├── connection.ts         # SQLite connection (WAL mode)
│   │   ├── schema.ts             # CREATE TABLE statements
│   │   ├── migrate.ts            # Schema versioning + auto-migrate
│   │   ├── merchants.ts          # Merchant queries
│   │   ├── menu.ts               # Menu queries
│   │   ├── orders.ts             # Order queries
│   │   └── users.ts              # User/auth queries
│   │
│   ├── archive/
│   │   ├── rollover.ts           # Nightly: move old orders to JSONL
│   │   ├── purge.ts              # Delete archives older than 60 days
│   │   ├── search.ts             # Stream + filter JSONL files
│   │   └── writer.ts             # Append orders to JSONL files
│   │
│   ├── scheduler/
│   │   └── cron.ts               # In-process cron (rollover, sync, update)
│   │
│   └── shared/
│       ├── types.ts              # Shared TypeScript types
│       ├── money.ts              # Price utilities (cents-based)
│       ├── jwt.ts                # JWT sign/verify (Bun crypto)
│       └── config.ts             # Appliance configuration
│
├── test/
│   ├── sam/
│   │   ├── order-relay.test.ts   # SAM workflow tests
│   │   └── pos-sync.test.ts
│   ├── pos/
│   │   ├── manual.test.ts
│   │   └── square.test.ts
│   ├── db/
│   │   └── orders.test.ts
│   ├── archive/
│   │   ├── rollover.test.ts
│   │   └── search.test.ts
│   └── routes/
│       ├── public.test.ts
│       └── merchant.test.ts
│
├── data/                         # Runtime data (gitignored)
│   ├── merchant.db               # SQLite database
│   ├── archive/                  # JSONL order archives
│   └── config/
│       └── appliance.json        # Appliance config
│
├── docs/
│   └── architecture/
│       ├── appliance-architecture.md  # This document
│       └── ADRs/
│           └── ADR-004-bun-sqlite-appliance.md
│
├── package.json
├── tsconfig.json
├── bunfig.toml                   # Bun configuration
└── README.md
```


## 8. Auto-Update Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                    Update Server (cloud)                     │
│                                                             │
│  GET /manifest.json                                         │
│  {                                                          │
│    "version": "1.2.3",                                      │
│    "released": "2026-02-16T00:00:00Z",                      │
│    "binaries": {                                            │
│      "linux-arm64": {                                       │
│        "url": "https://releases.baanbaan.dev/1.2.3/arm64",  │
│        "sha256": "abc123..."                                │
│      }                                                      │
│    },                                                       │
│    "migrations": ["1.2.0-to-1.2.3.sql"],                    │
│    "minVersion": "1.0.0"                                    │
│  }                                                          │
└─────────────────────────────────────────────────────────────┘
                          │
              Check hourly │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                 Appliance Update Flow                        │
│                                                             │
│  1. Fetch manifest                                          │
│  2. Compare versions                                        │
│  3. Download binary to temp                                 │
│  4. Verify SHA-256 checksum                                 │
│  5. Dehydrate all active SAM workflows to DB                │
│  6. Run migration SQL (if any)                              │
│  7. Replace binary (atomic rename)                          │
│  8. Restart process                                         │
│  9. On startup: verify health check                         │
│ 10. Rehydrate SAM workflows from DB                         │
│ 11. Nap triggers resume all in-flight work                  │
│                                                             │
│  Rollback: if health check fails after restart,             │
│  restore previous binary and restart again.                 │
└─────────────────────────────────────────────────────────────┘
```

The key insight: **SAM's dehydration makes updates seamless**. All in-flight
orders are serialized to the database before the update. After restart, they
rehydrate and the next-action-predicate automatically resumes each workflow
exactly where it left off. No orders are lost during updates.


## 9. SAM Hydration/Dehydration Protocol

The sam-pattern library does not include built-in serialization. We implement
hydration/dehydration ourselves by persisting the model state (which includes
the FSM's `pc` variable, renamed to `status`) after every SAM step via a
reactor.

### Server-Side (SQLite)

```typescript
import { Database } from 'bun:sqlite'

const db = new Database('data/merchant.db', { create: true })
db.exec('PRAGMA journal_mode = WAL')

/**
 * Dehydrate: persist SAM model state to SQLite.
 * Called as a reactor after every SAM step.
 */
function dehydrateOrder(model: OrderModel): void {
  db.run(
    `UPDATE orders
     SET status = ?, sam_state = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [model.status, JSON.stringify(model), model.orderId]
  )
}

/**
 * Rehydrate: restore active SAM instances from SQLite on startup.
 * Each row becomes a new SAM+FSM instance with the persisted state
 * passed as initialState. The FSM's pc variable ('status') is restored
 * from the model, and NAPs fire automatically to resume the workflow.
 */
function rehydrateActiveOrders(): void {
  const rows = db.query(
    `SELECT id, sam_state, order_data FROM orders
     WHERE status NOT IN ('completed', 'cancelled')
     AND sam_state IS NOT NULL`
  ).all()

  for (const row of rows) {
    const persistedModel = JSON.parse(row.sam_state as string)
    const orderData = JSON.parse(row.order_data as string)

    // Recreate a full SAM+FSM instance with the restored model.
    // addInitialState() sets the model, which includes 'status' (the pc).
    // The FSM's stateMachine reactor validates the restored control state.
    // NAPs evaluate immediately and trigger the appropriate next action.
    createOrderWorkflow(row.id as string, orderData, persistedModel)
  }
}

// Called once at process startup
rehydrateActiveOrders()
```

The `createOrderWorkflow` function (defined in Section 3) accepts an
optional third argument for restored state, which is spread into
`initialState` alongside the FSM defaults.

### Client-Side (localStorage)

```typescript
/**
 * Dehydrate: persist SAM model state to localStorage.
 * Called as a reactor after every SAM step on the client.
 */
function dehydrateClientState(key: string, model: object): void {
  localStorage.setItem(`sam:${key}`, JSON.stringify({
    model,
    timestamp: Date.now(),
  }))
}

/**
 * Rehydrate: restore SAM state from localStorage.
 * Returns the persisted model if found and within TTL, or null.
 * The returned object is spread into the SAM initialState, which
 * restores both application state and the FSM's pc variable.
 */
function rehydrateClientState(key: string, maxAgeMs: number): object | null {
  const raw = localStorage.getItem(`sam:${key}`)
  if (!raw) return null

  const { model, timestamp } = JSON.parse(raw)
  if (Date.now() - timestamp > maxAgeMs) {
    localStorage.removeItem(`sam:${key}`)
    return null
  }

  return model
}
```

### Why This Works

1. **FSM state is just a model property.** By setting `pc: 'status'` in the
   FSM definition, the control state is stored as `model.status`. Serializing
   the model automatically includes the FSM state.

2. **NAPs are declarative.** They evaluate conditions against the model on
   every step — including the initial step after rehydration. So a rehydrated
   order in `pos_error` state with `retryCount < 3` will automatically trigger
   a retry, exactly as if it had just entered that state.

3. **Reactors run on every step.** The dehydration reactor fires after every
   state change, so the database always has the latest model. Crash recovery
   loses at most the in-flight step.

4. **`ignoreOutdatedProposals`** prevents stale async responses (e.g., a POS
   call that returns after a restart) from corrupting state.


## 10. Technology Choices Summary

| Layer | Choice | Rationale |
|---|---|---|
| **Runtime** | Bun | Built-in HTTP, SQLite, TS, test runner. ~30MB RAM. |
| **HTTP framework** | Hono | 14KB, Bun-native, fast routing, middleware. |
| **Database** | bun:sqlite (WAL) | In-process, zero config, handles 467K rows trivially. |
| **State management** | sam-pattern + sam-fsm | Formal state, testable workflows, hydration/dehydration. |
| **Cold storage** | JSONL files | Append-only, streamable, human-readable, no schema deps. |
| **Auth** | JWT (HS256) | Bun built-in crypto, no external deps. |
| **POS integration** | Adapter pattern | Pluggable per POS type, registry-based. |
| **API style** | REST (typed) | ~15 endpoints, lighter than GraphQL for this surface. |
| **Frontend** | TanStack/Vite SPA | Client-heavy, SAM state, localStorage hydration. |
| **Updates** | Self-update via manifest | SAM dehydration enables zero-downtime updates. |
| **Testing** | bun:test | Built-in, no Jest dependency. |

### What We Explicitly Don't Use

| Dropped | Why |
|---|---|
| NestJS | DI/reflection overhead unnecessary at this scale |
| Apollo Server | Too heavy for ~15 endpoints |
| TypeORM | Reflection overhead, SQLite has simpler needs |
| PostgreSQL | Overkill — SQLite handles the load in-process |
| Redis | No cache needed at 4 req/s |
| NATS | No message broker needed — single process |
| MinIO | No object storage needed |
| Docker | Appliance runs as native process |
| GraphQL Federation | Single service, no federation needed |
