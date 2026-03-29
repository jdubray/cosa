'use strict';

// ---------------------------------------------------------------------------
// Mocks — `mock` prefix exempts them from Jest's hoisting TDZ rule.
// ---------------------------------------------------------------------------

const mockGetConfig          = jest.fn();
const mockCreateApproval     = jest.fn();
const mockFindApprovalByToken = jest.fn();
const mockUpdateApprovalStatus = jest.fn();
const mockFindExpiredApprovals = jest.fn();
const mockSendEmail          = jest.fn();

jest.mock('../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

jest.mock('../src/session-store', () => ({
  createApproval:       (...a) => mockCreateApproval(...a),
  findApprovalByToken:  (...a) => mockFindApprovalByToken(...a),
  updateApprovalStatus: (...a) => mockUpdateApprovalStatus(...a),
  findExpiredApprovals: (...a) => mockFindExpiredApprovals(...a),
}));

jest.mock('../src/email-gateway', () => ({
  sendEmail: (...a) => mockSendEmail(...a),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const {
  requiresApproval,
  requestApproval,
  processInboundReply,
  startExpiryCheck,
  stopExpiryCheck,
  _runExpiryCheck,
  _clearPending,
} = require('../src/approval-engine');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  appliance: {
    operator: {
      email:                           'owner@restaurant.com',
      approval_timeout_minutes:        30,
      urgent_approval_timeout_minutes: 5,
    },
  },
};

const SESSION_ID = 'sess-test-001';

const READ_TOOL_CALL = {
  tool_name:      'db_query',
  input:          { query: 'SELECT 1' },
  riskLevel:      'read',
  action_summary: 'Run a read-only SELECT query',
};

const MEDIUM_TOOL_CALL = {
  tool_name:      'restart_service',
  input:          { service: 'baanbaan' },
  riskLevel:      'medium',
  action_summary: 'Restart the Baanbaan service',
};

const HIGH_TOOL_CALL = {
  tool_name:      'run_migration',
  input:          {},
  riskLevel:      'high',
  action_summary: 'Run a database migration',
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CONFIG);
  mockSendEmail.mockResolvedValue(undefined);
  mockCreateApproval.mockReturnValue(undefined);
  mockFindExpiredApprovals.mockReturnValue([]);
  _clearPending();
});

afterEach(() => {
  stopExpiryCheck();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call requestApproval and capture the approval_id + token via the
 * createApproval mock before the Promise settles.
 *
 * @param {object} [toolCall]
 * @param {string} [policy]
 * @returns {{ promise: Promise, approvalId: string, token: string }}
 */
function startApproval(toolCall = MEDIUM_TOOL_CALL, policy = 'once') {
  let approvalId;
  let token;
  mockCreateApproval.mockImplementationOnce((data) => {
    approvalId = data.approval_id;
    token      = data.token;
  });

  const promise = requestApproval(SESSION_ID, toolCall, policy);
  return { promise, get approvalId() { return approvalId; }, get token() { return token; } };
}

// ---------------------------------------------------------------------------
// AC1 — requiresApproval policy
// ---------------------------------------------------------------------------

describe('AC1 — requiresApproval policy', () => {
  it("returns 'auto' for a read-risk tool", () => {
    expect(requiresApproval({ riskLevel: 'read' })).toBe('auto');
  });

  it("returns 'once' for a medium-risk tool", () => {
    expect(requiresApproval({ riskLevel: 'medium' })).toBe('once');
  });

  it("returns 'once' for a high-risk tool", () => {
    expect(requiresApproval({ riskLevel: 'high' })).toBe('once');
  });

  it("returns 'once' for a critical-risk tool", () => {
    expect(requiresApproval({ riskLevel: 'critical' })).toBe('once');
  });
});

// ---------------------------------------------------------------------------
// AC2 — requestApproval creates record and sends email
// ---------------------------------------------------------------------------

describe('AC2 — requestApproval creates DB record and sends email', () => {
  it('calls createApproval with the correct fields', async () => {
    const handle = startApproval();
    await Promise.resolve(); // let async work settle

    expect(mockCreateApproval).toHaveBeenCalledTimes(1);
    const [data] = mockCreateApproval.mock.calls[0];
    expect(data.session_id).toBe(SESSION_ID);
    expect(data.tool_name).toBe(MEDIUM_TOOL_CALL.tool_name);
    expect(data.action_summary).toBe(MEDIUM_TOOL_CALL.action_summary);
    expect(data.risk_level).toBe(MEDIUM_TOOL_CALL.riskLevel);
    expect(data.scope).toBe('once');
    expect(data.approval_id).toBeTruthy();
    expect(data.token).toMatch(/^APPROVE-[0-9A-F]{8}$/);
    expect(data.expires_at).toBeTruthy();

    // Prevent unhandled Promise rejection
    handle.promise.catch(() => {});
  });

  it('calls sendEmail with the operator address', async () => {
    const handle = startApproval();
    await Promise.resolve();

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [opts] = mockSendEmail.mock.calls[0];
    expect(opts.to).toBe(BASE_CONFIG.appliance.operator.email);
    expect(opts.subject).toContain(MEDIUM_TOOL_CALL.tool_name);

    handle.promise.catch(() => {});
  });

  it('includes the tool name in the request email subject', async () => {
    const handle = startApproval();
    await Promise.resolve();

    const [opts] = mockSendEmail.mock.calls[0];
    expect(opts.subject).toContain('restart_service');

    handle.promise.catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// AC3 — token format
// ---------------------------------------------------------------------------

describe('AC3 — token format', () => {
  it('token matches APPROVE-{8 uppercase hex chars}', async () => {
    const handle = startApproval();
    await Promise.resolve();

    expect(handle.token).toMatch(/^APPROVE-[0-9A-F]{8}$/);
    handle.promise.catch(() => {});
  });

  it('token is included in the request email body', async () => {
    const handle = startApproval();
    await Promise.resolve();

    const [opts] = mockSendEmail.mock.calls[0];
    expect(opts.text).toContain(handle.token);

    handle.promise.catch(() => {});
  });

  it('generates a different token for each approval', async () => {
    const h1 = startApproval();
    await Promise.resolve();
    jest.clearAllMocks();
    mockSendEmail.mockResolvedValue(undefined);

    const h2 = startApproval();
    await Promise.resolve();

    expect(h1.token).not.toBe(h2.token);

    h1.promise.catch(() => {});
    h2.promise.catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// AC4 — single-use tokens
// ---------------------------------------------------------------------------

describe('AC4 — tokens are single-use', () => {
  it('returns ambiguous when the same token is processed a second time', async () => {
    const handle = startApproval();
    await Promise.resolve();

    const { approvalId, token } = handle;

    // First: approval is pending
    mockFindApprovalByToken.mockReturnValueOnce({
      approval_id: approvalId,
      token,
      tool_name:   MEDIUM_TOOL_CALL.tool_name,
      status:      'pending',
    });

    await processInboundReply({ subject: '', body: token, from: 'operator@test.com' });

    // Second: approval is now 'approved' — should return ambiguous
    mockFindApprovalByToken.mockReturnValueOnce({
      approval_id: approvalId,
      token,
      tool_name:   MEDIUM_TOOL_CALL.tool_name,
      status:      'approved',
    });

    const result = await processInboundReply({ subject: '', body: token, from: 'operator@test.com' });
    expect(result.action).toBe('ambiguous');
  });
});

// ---------------------------------------------------------------------------
// AC5 — approval timeouts
// ---------------------------------------------------------------------------

describe('AC5 — approval timeouts', () => {
  it('sets expires_at ~30 minutes from now for policy="once"', async () => {
    const before = Date.now();
    const handle = startApproval(MEDIUM_TOOL_CALL, 'once');
    await Promise.resolve();

    const [data] = mockCreateApproval.mock.calls[0];
    const expiresAt = new Date(data.expires_at).getTime();
    const expectedMs = 30 * 60 * 1000;

    expect(expiresAt).toBeGreaterThanOrEqual(before + expectedMs);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + expectedMs + 1000);

    handle.promise.catch(() => {});
  });

  it('sets expires_at ~5 minutes from now for policy="urgent"', async () => {
    const before = Date.now();
    const handle = startApproval(MEDIUM_TOOL_CALL, 'urgent');
    await Promise.resolve();

    const [data] = mockCreateApproval.mock.calls[0];
    const expiresAt = new Date(data.expires_at).getTime();
    const expectedMs = 5 * 60 * 1000;

    expect(expiresAt).toBeGreaterThanOrEqual(before + expectedMs);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + expectedMs + 1000);

    handle.promise.catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// AC6 — processInboundReply parsing
// ---------------------------------------------------------------------------

describe('AC6 — processInboundReply handles APPROVE, DENY, ambiguous', () => {
  const FAKE_APPROVAL = {
    approval_id: 'appr-001',
    token:       'APPROVE-AABBCCDD',
    tool_name:   'restart_service',
    status:      'pending',
  };

  it("returns action:'approved' for a message containing only the token", async () => {
    mockFindApprovalByToken.mockReturnValueOnce(FAKE_APPROVAL);

    const result = await processInboundReply({
      subject: '',
      body:    'APPROVE-AABBCCDD',
      from:    'operator@test.com',
    });

    expect(result.action).toBe('approved');
    expect(result.approvalId).toBe(FAKE_APPROVAL.approval_id);
  });

  it("returns action:'denied' for a message containing DENY + token", async () => {
    mockFindApprovalByToken.mockReturnValueOnce(FAKE_APPROVAL);

    const result = await processInboundReply({
      subject: '',
      body:    'DENY APPROVE-AABBCCDD',
      from:    'operator@test.com',
    });

    expect(result.action).toBe('denied');
    expect(result.approvalId).toBe(FAKE_APPROVAL.approval_id);
  });

  it("returns action:'ambiguous' for a message with no token", async () => {
    const result = await processInboundReply({
      subject: 'Re: something',
      body:    'No I do not want this',
      from:    'operator@test.com',
    });

    expect(result.action).toBe('ambiguous');
    expect(result.approvalId).toBeNull();
  });

  it("returns action:'ambiguous' when token is not found in DB", async () => {
    mockFindApprovalByToken.mockReturnValueOnce(undefined);

    const result = await processInboundReply({
      subject: '',
      body:    'APPROVE-AABBCCDD',
      from:    'operator@test.com',
    });

    expect(result.action).toBe('ambiguous');
  });

  it("returns action:'ambiguous' for DENY without a token", async () => {
    const result = await processInboundReply({
      subject: '',
      body:    'DENY',
      from:    'operator@test.com',
    });

    expect(result.action).toBe('ambiguous');
  });

  it('is case-insensitive for the token in the message body', async () => {
    mockFindApprovalByToken.mockReturnValueOnce(FAKE_APPROVAL);

    const result = await processInboundReply({
      subject: '',
      body:    'approve-aabbccdd',
      from:    'operator@test.com',
    });

    expect(result.action).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// AC7 — approved token resolves the pending action
// ---------------------------------------------------------------------------

describe('AC7 — approved token executes the waiting action', () => {
  it('resolves the pending Promise with { approved: true, note: null }', async () => {
    const handle = startApproval();
    await Promise.resolve();

    const { approvalId, token } = handle;

    mockFindApprovalByToken.mockReturnValueOnce({
      approval_id: approvalId,
      token,
      tool_name:   MEDIUM_TOOL_CALL.tool_name,
      status:      'pending',
    });

    await processInboundReply({ subject: '', body: token, from: 'op@example.com' });

    const result = await handle.promise;
    expect(result.approved).toBe(true);
    expect(result.note).toBeNull();
  });

  it('sends a confirmation email after approval', async () => {
    const handle = startApproval();
    await Promise.resolve();

    const { approvalId, token } = handle;
    jest.clearAllMocks();
    mockSendEmail.mockResolvedValue(undefined);
    mockGetConfig.mockReturnValue(BASE_CONFIG);

    mockFindApprovalByToken.mockReturnValueOnce({
      approval_id: approvalId,
      token,
      tool_name:   MEDIUM_TOOL_CALL.tool_name,
      status:      'pending',
    });

    await processInboundReply({ subject: '', body: token, from: 'op@example.com' });
    await handle.promise;

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [opts] = mockSendEmail.mock.calls[0];
    expect(opts.subject).toContain('Approved');
    expect(opts.to).toBe(BASE_CONFIG.appliance.operator.email);
  });

  it('calls updateApprovalStatus with status "approved"', async () => {
    const handle = startApproval();
    await Promise.resolve();

    const { approvalId, token } = handle;

    mockFindApprovalByToken.mockReturnValueOnce({
      approval_id: approvalId,
      token,
      tool_name:   MEDIUM_TOOL_CALL.tool_name,
      status:      'pending',
    });

    await processInboundReply({ subject: '', body: token, from: 'op@example.com' });

    expect(mockUpdateApprovalStatus).toHaveBeenCalledWith(
      approvalId, 'approved', 'op@example.com', null
    );

    handle.promise.catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// AC8 — denied approval
// ---------------------------------------------------------------------------

describe('AC8 — denied approval', () => {
  it('resolves the pending Promise with { approved: false }', async () => {
    const handle = startApproval();
    await Promise.resolve();

    const { approvalId, token } = handle;

    mockFindApprovalByToken.mockReturnValueOnce({
      approval_id: approvalId,
      token,
      tool_name:   MEDIUM_TOOL_CALL.tool_name,
      status:      'pending',
    });

    await processInboundReply({
      subject: '',
      body:    `DENY ${token}`,
      from:    'op@example.com',
    });

    const result = await handle.promise;
    expect(result.approved).toBe(false);
  });

  it('stores the operator note when provided', async () => {
    const handle = startApproval();
    await Promise.resolve();

    const { approvalId, token } = handle;

    mockFindApprovalByToken.mockReturnValueOnce({
      approval_id: approvalId,
      token,
      tool_name:   MEDIUM_TOOL_CALL.tool_name,
      status:      'pending',
    });

    await processInboundReply({
      subject: '',
      body:    `DENY ${token} too risky right now`,
      from:    'op@example.com',
    });

    expect(mockUpdateApprovalStatus).toHaveBeenCalledWith(
      approvalId, 'denied', 'op@example.com', 'too risky right now'
    );

    handle.promise.catch(() => {});
  });

  it('includes the note in the resolved Promise', async () => {
    const handle = startApproval();
    await Promise.resolve();

    const { approvalId, token } = handle;

    mockFindApprovalByToken.mockReturnValueOnce({
      approval_id: approvalId,
      token,
      tool_name:   MEDIUM_TOOL_CALL.tool_name,
      status:      'pending',
    });

    await processInboundReply({
      subject: '',
      body:    `DENY ${token} too risky right now`,
      from:    'op@example.com',
    });

    const result = await handle.promise;
    expect(result.note).toBe('too risky right now');
  });

  it('sends a cancellation email after denial', async () => {
    const handle = startApproval();
    await Promise.resolve();

    const { approvalId, token } = handle;
    jest.clearAllMocks();
    mockSendEmail.mockResolvedValue(undefined);
    mockGetConfig.mockReturnValue(BASE_CONFIG);

    mockFindApprovalByToken.mockReturnValueOnce({
      approval_id: approvalId,
      token,
      tool_name:   MEDIUM_TOOL_CALL.tool_name,
      status:      'pending',
    });

    await processInboundReply({ subject: '', body: `DENY ${token}`, from: 'op@example.com' });
    await handle.promise;

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [opts] = mockSendEmail.mock.calls[0];
    expect(opts.subject).toContain('Denied');
  });
});

// ---------------------------------------------------------------------------
// AC9 — background expiry check
// ---------------------------------------------------------------------------

describe('AC9 — background expiry check', () => {
  it('triggers _runExpiryCheck after exactly 5 minutes', () => {
    jest.useFakeTimers();
    mockFindExpiredApprovals.mockReturnValue([]);

    startExpiryCheck();

    jest.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(mockFindExpiredApprovals).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(mockFindExpiredApprovals).toHaveBeenCalledTimes(1);

    stopExpiryCheck();
    jest.useRealTimers();
  });

  it('does not start a second interval when called twice', () => {
    jest.useFakeTimers();
    mockFindExpiredApprovals.mockReturnValue([]);

    startExpiryCheck();
    startExpiryCheck(); // second call is no-op

    jest.advanceTimersByTime(5 * 60 * 1000);
    expect(mockFindExpiredApprovals).toHaveBeenCalledTimes(1);

    stopExpiryCheck();
    jest.useRealTimers();
  });

  it('transitions expired approvals to status "expired"', async () => {
    const EXPIRED = {
      approval_id: 'appr-expired-001',
      token:       'APPROVE-DEADBEEF',
      tool_name:   'restart_service',
      status:      'pending',
    };
    mockFindExpiredApprovals.mockReturnValueOnce([EXPIRED]);

    await _runExpiryCheck();

    expect(mockUpdateApprovalStatus).toHaveBeenCalledWith(
      EXPIRED.approval_id, 'expired', 'system', null
    );
  });

  it('sends a notification email for each expired approval', async () => {
    const EXPIRED = {
      approval_id: 'appr-expired-002',
      token:       'APPROVE-DEADBEEF',
      tool_name:   'run_migration',
      status:      'pending',
    };
    mockFindExpiredApprovals.mockReturnValueOnce([EXPIRED]);

    await _runExpiryCheck();

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [opts] = mockSendEmail.mock.calls[0];
    expect(opts.subject).toContain('Expired');
    expect(opts.subject).toContain(EXPIRED.tool_name);
  });

  it('resolves the pending callback with { approved: false, note: "expired" }', async () => {
    const handle = startApproval();
    await Promise.resolve();

    const { approvalId } = handle;

    const EXPIRED = {
      approval_id: approvalId,
      token:       handle.token,
      tool_name:   MEDIUM_TOOL_CALL.tool_name,
      status:      'pending',
    };
    mockFindExpiredApprovals.mockReturnValueOnce([EXPIRED]);

    await _runExpiryCheck();

    const result = await handle.promise;
    expect(result.approved).toBe(false);
    expect(result.note).toBe('expired');
  });

  it('processes multiple expired approvals in one sweep', async () => {
    mockFindExpiredApprovals.mockReturnValueOnce([
      { approval_id: 'a1', token: 'APPROVE-11111111', tool_name: 'tool_a', status: 'pending' },
      { approval_id: 'a2', token: 'APPROVE-22222222', tool_name: 'tool_b', status: 'pending' },
    ]);

    await _runExpiryCheck();

    expect(mockUpdateApprovalStatus).toHaveBeenCalledTimes(2);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// AC10 — all FSM transitions logged to session.db
// ---------------------------------------------------------------------------

describe('AC10 — FSM state transitions logged to session.db', () => {
  const FAKE_APPROVAL = {
    approval_id: 'appr-fsm-001',
    token:       'APPROVE-CAFEBABE',
    tool_name:   'restart_service',
    status:      'pending',
  };

  it('logs transition pending → approved', async () => {
    mockFindApprovalByToken.mockReturnValueOnce(FAKE_APPROVAL);

    await processInboundReply({
      body: FAKE_APPROVAL.token,
      from: 'op@example.com',
    });

    expect(mockUpdateApprovalStatus).toHaveBeenCalledWith(
      FAKE_APPROVAL.approval_id, 'approved', expect.any(String), null
    );
  });

  it('logs transition pending → denied', async () => {
    mockFindApprovalByToken.mockReturnValueOnce(FAKE_APPROVAL);

    await processInboundReply({
      body: `DENY ${FAKE_APPROVAL.token}`,
      from: 'op@example.com',
    });

    expect(mockUpdateApprovalStatus).toHaveBeenCalledWith(
      FAKE_APPROVAL.approval_id, 'denied', expect.any(String), null
    );
  });

  it('logs transition pending → expired', async () => {
    mockFindExpiredApprovals.mockReturnValueOnce([FAKE_APPROVAL]);

    await _runExpiryCheck();

    expect(mockUpdateApprovalStatus).toHaveBeenCalledWith(
      FAKE_APPROVAL.approval_id, 'expired', 'system', null
    );
  });
});

// ---------------------------------------------------------------------------
// AC11 — module exports
// ---------------------------------------------------------------------------

describe('AC11 — module exports', () => {
  it('exports requiresApproval', () => {
    expect(typeof requiresApproval).toBe('function');
  });

  it('exports requestApproval', () => {
    expect(typeof requestApproval).toBe('function');
  });

  it('exports processInboundReply', () => {
    expect(typeof processInboundReply).toBe('function');
  });

  it('exports startExpiryCheck', () => {
    expect(typeof startExpiryCheck).toBe('function');
  });

  it('exports stopExpiryCheck', () => {
    expect(typeof stopExpiryCheck).toBe('function');
  });
});
