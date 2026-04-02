Push notifications alone are one-way (server → browser), but combined with a PWA they form a complete two-way channel. Here's how it breaks down:

---

## What push notifications actually give you

```
COSA server
    │
    │  Web Push (VAPID encrypted)
    ▼
Browser Push Service (FCM / APNs)
    │
    ▼
Service Worker (runs even when PWA is closed)
    │
    ├─▶ Show notification with action buttons (Approve / Deny)
    │
    └─▶ On button tap → HTTP POST back to COSA API
                              ▲
                              │ This is the return channel
```

The service worker intercepts `notificationclick` events. It can silently POST back to COSA without the user ever opening the app. That covers the entire approval flow — one tap on the phone, COSA gets the response.

For free-form messages (operator asking "what were today's sales?"), the user needs to open the PWA, where you use SSE or WebSocket for the real-time channel.

---

## The full architecture

```
COSA Pi
├── web-push sender (VAPID keys, sends to operator's subscription)
├── REST API  (receives service worker POSTs — approve/deny/query)
└── SSE endpoint  (streams COSA responses when PWA is open)

Operator's phone / browser
├── Service Worker
│   ├── Receives push → shows notification with buttons
│   └── notificationclick → POST /api/approval/{token}
└── PWA Chat UI (when open)
    ├── Text input → POST /api/message
    └── EventSource → streams COSA replies via SSE
```

COSA only needs **one inbound HTTPS endpoint** — a Cloudflare Tunnel on the COSA Pi handles this, same pattern as the appliance itself.

---

## Comparison with Telegram

| | Telegram Bot | PWA + Push |
|---|---|---|
| Implementation effort | Low (API already exists) | Medium (build the UI + service worker) |
| Approval buttons | Built-in `InlineKeyboardMarkup` | Notification `actions` in service worker |
| Works when app closed | Yes | Yes (service worker handles it) |
| Third-party dependency | Telegram servers | FCM/APNs for delivery only; payload is E2E encrypted (VAPID) |
| Same stack as Baanbaan | No | Yes — Bun + Hono + Vite SPA |
| Custom approval UX | Limited | Full control |
| Notification delivery reliability | Excellent | Excellent (same underlying infra) |

---

## Recommendation for COSA

The PWA path is the stronger long-term architecture because:

1. **Same stack** — Bun + Hono + Vite. No new runtime, no new language, the Baanbaan team already knows it.
2. **Purpose-built approval UX** — you can design exactly the right confirmation UI (show the diff, the risk level, the rollback option) rather than cramming it into a Telegram message.
3. **No third-party account dependency** — the COSA Pi owns the push subscription directly.
4. **Reuses Cloudflare Tunnel** — the same tunnel pattern the appliance already uses gives COSA its inbound HTTPS endpoint.

The only reason to prefer Telegram is speed to Phase 2 — the Bot API is trivial to wire up. If you want to defer PWA build effort, use Telegram for Phase 2 and migrate to PWA in Phase 3 or 4. The interface layer in the architecture is already abstracted so swapping it out is a configuration change, not a redesign.

The document should be updated to reflect this option — want me to add it to §11 and §16?