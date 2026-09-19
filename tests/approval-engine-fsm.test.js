'use strict';

// ---------------------------------------------------------------------------
// Regression: the per-approval SAM FSM must actually be constructible and drive
// a request to approved / denied / expired. Every other suite mocks
// requestApproval(), which is why sam-fsm's fsm() throwing on construction
// ("Cannot read properties of undefined (reading 'from')") shipped unnoticed:
// in production every approval email was sent and then orphaned, and the
// orchestrator's re-dispatch of the same tool_use hit the resend rate limit.
//
// session-store, email-gateway and config are stubbed with jest.fn() so the
// suite runs without better-sqlite3 or SMTP.
// ---------------------------------------------------------------------------

const mockSendEmail = jest.fn().mockResolvedValue(undefined);
const mockCreateApproval = jest.fn();
const mockConfig = {
  appliance: {
    appliance: { timezone: 'UTC' },
    operator:  {
      email:                              'owner@example.com',
      approval_timeout_minutes:           30,
      quiet_hours_start:                  0,
      non_urgent_resend_interval_minutes: 60,
      urgent_resend_interval_minutes:     15,
    },
  },
};

jest.mock('../config/cosa.config', () => ({ getConfig: () => mockConfig }));
jest.mock('../src/email-gateway', () => ({ sendEmail: (...a) => mockSendEmail(...a) }));
jest.mock('../src/session-store', () => ({
  createApproval:         (...a) => mockCreateApproval(...a),
  findApprovalByToken:    jest.fn(),
  updateApprovalStatus:   jest.fn(),
  findExpiredApprovals:   jest.fn().mockReturnValue([]),
}));
jest.mock('../src/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const approvalEngine = require('../src/approval-engine');

describe('_buildApprovalMachine (sam-fsm construction)', () => {
  it('constructs without throwing and reaches "approved" via the approve intent', async () => {
    const terminal = [];
    const { approve } = approvalEngine._buildApprovalMachine('appr-1', (state, model) => {
      terminal.push({ state, note: model.note ?? null });
    });
    await approve();
    expect(terminal).toEqual([{ state: 'approved', note: null }]);
  });

  it('reaches "denied" with the operator note preserved', async () => {
    const terminal = [];
    const { deny } = approvalEngine._buildApprovalMachine('appr-2', (state, model) => {
      terminal.push({ state, note: model.note ?? null });
    });
    await deny({ note: 'not today' });
    expect(terminal).toEqual([{ state: 'denied', note: 'not today' }]);
  });

  it('reaches "expired" via the expire intent', async () => {
    const terminal = [];
    const { expire } = approvalEngine._buildApprovalMachine('appr-3', (state) => {
      terminal.push(state);
    });
    await expire();
    expect(terminal).toEqual(['expired']);
  });
});

describe('requestApproval', () => {
  beforeEach(() => {
    mockSendEmail.mockClear();
    mockCreateApproval.mockClear();
    approvalEngine._clearPending();
  });

  const toolCall = (extra = {}) => ({
    tool_name:      'appliance_api_call',
    input:          { endpoint_name: 'pause_store', body: { paused: true, reason: 'closed' } },
    riskLevel:      'high',
    action_summary: 'appliance_api_call → pause_store',
    ...extra,
  });

  it('sends exactly one email and returns a pending Promise that resolves on approval', async () => {
    const pending = approvalEngine.requestApproval('sess-1', toolCall({ triggerType: 'email' }), 'once');

    // Let the async email send + FSM construction settle.
    await new Promise(r => setImmediate(r));
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockCreateApproval).toHaveBeenCalledTimes(1);

    // Drive the approval through the FSM the way processInboundReply does.
    const approvalId = mockCreateApproval.mock.calls[0][0].approval_id;
    const intents = approvalEngine._pendingFor(approvalId);
    expect(intents).toBeDefined();
    await intents.approve();

    await expect(pending).resolves.toEqual({ approved: true, note: null, approvalId });
  });

  it('does NOT rate-limit a second operator-initiated (email-triggered) request within the hour', async () => {
    const p1 = approvalEngine.requestApproval('sess-1', toolCall({ triggerType: 'email' }), 'once');
    await new Promise(r => setImmediate(r));
    const p2 = approvalEngine.requestApproval('sess-2', toolCall({ triggerType: 'email' }), 'once');
    await new Promise(r => setImmediate(r));

    expect(mockSendEmail).toHaveBeenCalledTimes(2);

    for (const call of mockCreateApproval.mock.calls) {
      await approvalEngine._pendingFor(call[0].approval_id).approve();
    }
    await expect(p1).resolves.toMatchObject({ approved: true });
    await expect(p2).resolves.toMatchObject({ approved: true });
  });

  it('still rate-limits back-to-back unattended (cron) requests', async () => {
    const p1 = approvalEngine.requestApproval('sess-1', toolCall({ triggerType: 'cron' }), 'once');
    await new Promise(r => setImmediate(r));
    const r2 = await approvalEngine.requestApproval('sess-2', toolCall({ triggerType: 'cron' }), 'once');

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(r2.approved).toBe(false);
    expect(r2.note).toMatch(/rate limited/);

    const approvalId = mockCreateApproval.mock.calls[0][0].approval_id;
    await approvalEngine._pendingFor(approvalId).approve();
    await expect(p1).resolves.toMatchObject({ approved: true });
  });
});
