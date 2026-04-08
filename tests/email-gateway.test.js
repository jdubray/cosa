'use strict';

// ---------------------------------------------------------------------------
// Mocks — `mock` prefix exempts from Jest's hoisting TDZ rule.
// ---------------------------------------------------------------------------

// ── nodemailer ──────────────────────────────────────────────────────────────
const mockSendMail        = jest.fn();
const mockCreateTransport = jest.fn(() => ({ sendMail: (...a) => mockSendMail(...a) }));

jest.mock('nodemailer', () => ({
  createTransport: (...a) => mockCreateTransport(...a),
}));

// ── imapflow ─────────────────────────────────────────────────────────────────
const mockImapConnect         = jest.fn();
const mockImapGetMailboxLock  = jest.fn();
const mockImapSearch          = jest.fn();
const mockImapFetchOne        = jest.fn();
const mockImapMessageFlagsAdd = jest.fn();
const mockImapLogout          = jest.fn();
const mockLockRelease         = jest.fn();

jest.mock('imapflow', () => ({
  ImapFlow: jest.fn(() => ({
    connect:         (...a) => mockImapConnect(...a),
    getMailboxLock:  (...a) => mockImapGetMailboxLock(...a),
    search:          (...a) => mockImapSearch(...a),
    fetchOne:        (...a) => mockImapFetchOne(...a),
    messageFlagsAdd: (...a) => mockImapMessageFlagsAdd(...a),
    logout:          (...a) => mockImapLogout(...a),
  })),
}));

// ── config ───────────────────────────────────────────────────────────────────
const mockGetConfig = jest.fn();

jest.mock('../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

// ── approval-engine ───────────────────────────────────────────────────────────
const mockProcessInboundReply = jest.fn();

jest.mock('../src/approval-engine', () => ({
  processInboundReply: (...a) => mockProcessInboundReply(...a),
}));

// ── session-store (dead-letter) ──────────────────────────────────────────────
// Avoids pulling in better-sqlite3 (compiled for Linux — not loadable in
// the Windows Jest environment).
jest.mock('../src/session-store', () => ({
  saveDeadLetter: jest.fn(),
}));

// ── logger ───────────────────────────────────────────────────────────────────
// Expose warn/error so tests can assert on them without spying on console.*
// (email-gateway.js calls log.warn / log.error, not console.warn / console.error).
const mockLogWarn  = jest.fn();
const mockLogError = jest.fn();

jest.mock('../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  mockLogWarn,
    error: mockLogError,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flush pending Promise microtasks without advancing fake timers.
 * `jest.useFakeTimers()` mocks macro-tasks (setTimeout, setInterval, nextTick)
 * but NOT Promise microtasks, so repeated `await Promise.resolve()` drains
 * any depth of settled `.then` / `await` chains.
 */
const flushPromises = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const {
  sendEmail,
  startPolling,
  stopPolling,
  setNewSessionHandler,
  _runPoll,
  _resetSmtpTransport,
} = require('../src/email-gateway');

// We also need the ImapFlow constructor mock to inspect call args.
const { ImapFlow } = require('imapflow');

// ---------------------------------------------------------------------------
// Config fixture
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  env: {
    email: {
      address:     'cosa@gmail.com',
      imapHost:    'imap.gmail.com',
      imapPort:    993,
      smtpHost:    'smtp.gmail.com',
      smtpPort:    587,
      username:    'cosa@gmail.com',
      appPassword: 'secret-app-pass',
    },
  },
  appliance: {
    operator: { email: 'owner@restaurant.com' },
    // Disable DKIM for all tests in this file except the dedicated DKIM suite
    // (AC-DKIM below).  The mock `makeFetched` does not provide a raw email
    // source with Authentication-Results headers, so all messages would be
    // dropped if this check were enabled in the baseline config.
    security: { dkim_check: false },
  },
};

// Reusable message envelope builder
function makeEnvelope({ from = 'owner@restaurant.com', subject = 'Hello', messageId = '<msg-1@gmail.com>' } = {}) {
  return {
    from:      [{ address: from }],
    subject,
    messageId,
  };
}

/**
 * Build a minimal ImapFlow fetched-message object whose `.source` field is a
 * proper RFC 2822 email buffer.  email-gateway.js passes `fetched.source` to
 * `simpleParser`, so the body and headers must live there — not in `bodyParts`.
 *
 * @param {{ from?, subject?, body?, messageId?, dkimDomain? }} opts
 *   dkimDomain — when set, injects a valid Authentication-Results header so the
 *                DKIM check passes for that domain (e.g. 'gmail.com').
 */
function makeFetched({ from = 'owner@restaurant.com', subject = 'Hello', body = '', messageId = '<msg-1@gmail.com>', dkimDomain = null } = {}) {
  const headerLines = [
    `From: ${from}`,
    `To: cosa@gmail.com`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
  ];
  if (dkimDomain) {
    headerLines.push(
      `Authentication-Results: mx.google.com;\r\n dkim=pass header.d=${dkimDomain}`
    );
  }
  // RFC 2822: blank line separates headers from body
  const source = Buffer.from([...headerLines, '', body].join('\r\n'));

  return {
    envelope:    makeEnvelope({ from, subject, messageId }),
    source,
    // No internalDate → passes the pre-boot skip check (undefined is falsy)
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CONFIG);
  mockImapConnect.mockResolvedValue(undefined);
  mockImapGetMailboxLock.mockResolvedValue({ release: mockLockRelease });
  mockImapSearch.mockResolvedValue([]);
  mockImapFetchOne.mockResolvedValue(makeFetched());
  mockImapMessageFlagsAdd.mockResolvedValue(undefined);
  mockImapLogout.mockResolvedValue(undefined);
  mockSendMail.mockResolvedValue({ messageId: '<sent-123@gmail.com>' });
  mockProcessInboundReply.mockResolvedValue({ action: 'approved', approvalId: 'a1' });
  setNewSessionHandler(null);
  // Reset SMTP singleton so each test that calls sendEmail() gets a fresh
  // createTransport() invocation (AC9).
  _resetSmtpTransport();
});

afterEach(() => {
  stopPolling();
  jest.clearAllMocks();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// AC1 — IMAP polling every 60 seconds
// ---------------------------------------------------------------------------

describe('AC1 — IMAP polling interval', () => {
  it('does not connect before 60 seconds have elapsed', () => {
    jest.useFakeTimers();
    startPolling();

    jest.advanceTimersByTime(60_000 - 1);
    expect(mockImapConnect).not.toHaveBeenCalled();
  });

  it('connects exactly once after 60 seconds', async () => {
    jest.useFakeTimers();
    mockImapSearch.mockResolvedValue([]);

    startPolling();
    jest.advanceTimersByTime(60_000);
    await flushPromises();

    expect(mockImapConnect).toHaveBeenCalledTimes(1);
  });

  it('polls twice after 120 seconds', async () => {
    jest.useFakeTimers();
    mockImapSearch.mockResolvedValue([]);

    startPolling();
    jest.advanceTimersByTime(60_000);
    await flushPromises();
    jest.advanceTimersByTime(60_000);
    await flushPromises();

    expect(mockImapConnect).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when called a second time while already polling', () => {
    jest.useFakeTimers();
    startPolling();
    startPolling(); // second call should be ignored

    jest.advanceTimersByTime(60_000);
    // Only one interval should have been registered; one connect call
    expect(mockImapConnect.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('accepts a custom interval override (for testing)', async () => {
    jest.useFakeTimers();
    mockImapSearch.mockResolvedValue([]);

    startPolling(5_000); // 5-second interval
    jest.advanceTimersByTime(5_000);
    await flushPromises();

    expect(mockImapConnect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC2 — Only process messages from the configured operator email
// ---------------------------------------------------------------------------

describe('AC2 — operator-only filter', () => {
  it('ignores messages from unknown senders', async () => {
    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'hacker@evil.com', subject: 'Hi', body: 'some text' })
    );

    await _runPoll();

    expect(mockProcessInboundReply).not.toHaveBeenCalled();
  });

  it('logs a warning when ignoring a non-operator message', async () => {
    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'stranger@example.com', subject: 'Hi', body: 'hi' })
    );

    await _runPoll();

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('stranger@example.com')
    );
  });

  it('still marks non-operator messages as read', async () => {
    mockImapSearch.mockResolvedValue([7]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'random@other.com', subject: 'Hi', body: 'hi' })
    );

    await _runPoll();

    expect(mockImapMessageFlagsAdd).toHaveBeenCalledWith('7', ['\\Seen']);
  });

  it('processes messages from the operator', async () => {
    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'owner@restaurant.com', subject: 'Hello', body: 'general message' })
    );

    const mockHandler = jest.fn().mockResolvedValue(undefined);
    setNewSessionHandler(mockHandler);
    await _runPoll();

    expect(mockHandler).toHaveBeenCalledTimes(1);
  });

  it('operator email comparison is case-insensitive', async () => {
    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'OWNER@RESTAURANT.COM', subject: 'Test', body: 'hello' })
    );

    const mockHandler = jest.fn().mockResolvedValue(undefined);
    setNewSessionHandler(mockHandler);
    await _runPoll();

    expect(mockHandler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Approval replies routed to approvalEngine.processInboundReply
// ---------------------------------------------------------------------------

describe('AC3 — approval reply routing', () => {
  it('routes a message containing APPROVE-TOKEN to processInboundReply', async () => {
    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'owner@restaurant.com', subject: '', body: 'APPROVE-1A2B3C4D' })
    );

    await _runPoll();

    expect(mockProcessInboundReply).toHaveBeenCalledTimes(1);
    const [msg] = mockProcessInboundReply.mock.calls[0];
    expect(msg.body).toContain('APPROVE-1A2B3C4D');
  });

  it('routes a message containing DENY to processInboundReply', async () => {
    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'owner@restaurant.com', subject: '', body: 'DENY APPROVE-AABBCCDD' })
    );

    await _runPoll();

    expect(mockProcessInboundReply).toHaveBeenCalledTimes(1);
  });

  it('routes approval token found in subject to processInboundReply', async () => {
    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'owner@restaurant.com', subject: 'APPROVE-12345678', body: '' })
    );

    await _runPoll();

    expect(mockProcessInboundReply).toHaveBeenCalledTimes(1);
  });

  it('passes msg with from, subject, body, messageId to processInboundReply', async () => {
    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({
        from:      'owner@restaurant.com',
        subject:   'Re: approval',
        body:      'APPROVE-CAFEBABE',
        messageId: '<msg-reply@gmail.com>',
      })
    );

    await _runPoll();

    expect(mockProcessInboundReply).toHaveBeenCalledWith(
      expect.objectContaining({
        from:      'owner@restaurant.com',
        subject:   'Re: approval',
        body:      'APPROVE-CAFEBABE',
        messageId: '<msg-reply@gmail.com>',
      })
    );
  });
});

// ---------------------------------------------------------------------------
// AC4 — Non-approval messages trigger new session handler
// ---------------------------------------------------------------------------

describe('AC4 — non-approval messages trigger new session', () => {
  it('calls the new-session handler for a plain text message', async () => {
    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'owner@restaurant.com', subject: 'POS is down', body: 'Please check it' })
    );

    const mockNewSession = jest.fn().mockResolvedValue(undefined);
    setNewSessionHandler(mockNewSession);
    await _runPoll();

    expect(mockNewSession).toHaveBeenCalledTimes(1);
    expect(mockProcessInboundReply).not.toHaveBeenCalled();
  });

  it('does nothing when no new-session handler is registered', async () => {
    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'owner@restaurant.com', subject: 'General query', body: 'text' })
    );

    setNewSessionHandler(null);
    // Should not throw
    await expect(_runPoll()).resolves.toBeUndefined();
    expect(mockProcessInboundReply).not.toHaveBeenCalled();
  });

  it('passes msg object to the new-session handler', async () => {
    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'owner@restaurant.com', subject: 'Check sales', body: 'how are sales?' })
    );

    const mockNewSession = jest.fn().mockResolvedValue(undefined);
    setNewSessionHandler(mockNewSession);
    await _runPoll();

    expect(mockNewSession).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Check sales', body: 'how are sales?' })
    );
  });
});

// ---------------------------------------------------------------------------
// AC5 — sendEmail field support
// ---------------------------------------------------------------------------

describe('AC5 — sendEmail accepts all required fields', () => {
  it('passes to, subject, text to sendMail', async () => {
    await sendEmail({ to: 'owner@restaurant.com', subject: 'Test', text: 'Hello' });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to:      'owner@restaurant.com',
        subject: 'Test',
        text:    'Hello',
      })
    );
  });

  it('passes inReplyTo when provided', async () => {
    await sendEmail({
      to:         'owner@restaurant.com',
      subject:    'Re: test',
      text:       'reply',
      inReplyTo:  '<original@gmail.com>',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyTo: '<original@gmail.com>' })
    );
  });

  it('passes references when provided', async () => {
    await sendEmail({
      to:         'owner@restaurant.com',
      subject:    'Re: test',
      text:       'reply',
      references: '<original@gmail.com>',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ references: '<original@gmail.com>' })
    );
  });

  it('omits inReplyTo from mailOptions when not provided', async () => {
    await sendEmail({ to: 'op@x.com', subject: 'S', text: 'T' });

    const [opts] = mockSendMail.mock.calls[0];
    expect(opts).not.toHaveProperty('inReplyTo');
  });

  it('sets from address from config', async () => {
    await sendEmail({ to: 'owner@restaurant.com', subject: 'S', text: 'T' });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: BASE_CONFIG.env.email.address })
    );
  });
});

// ---------------------------------------------------------------------------
// AC6 — Plain text only (no HTML)
// ---------------------------------------------------------------------------

describe('AC6 — plain text only', () => {
  it('does not include html field in mailOptions', async () => {
    await sendEmail({ to: 'owner@restaurant.com', subject: 'S', text: 'T' });

    const [opts] = mockSendMail.mock.calls[0];
    expect(opts).not.toHaveProperty('html');
  });
});

// ---------------------------------------------------------------------------
// AC7 — Email threading headers
// ---------------------------------------------------------------------------

describe('AC7 — email threading headers', () => {
  it('sets both In-Reply-To and References on a reply', async () => {
    await sendEmail({
      to:         'owner@restaurant.com',
      subject:    'Re: [COSA] Approval Required',
      text:       'Approved.',
      inReplyTo:  '<req-001@gmail.com>',
      references: '<req-001@gmail.com>',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyTo:  '<req-001@gmail.com>',
        references: '<req-001@gmail.com>',
      })
    );
  });
});

// ---------------------------------------------------------------------------
// AC8 — Processed messages marked as READ
// ---------------------------------------------------------------------------

describe('AC8 — messages marked as READ', () => {
  it('calls messageFlagsAdd with \\Seen for an operator message', async () => {
    mockImapSearch.mockResolvedValue([3]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'owner@restaurant.com', subject: 'Hi', body: 'text' })
    );

    await _runPoll();

    expect(mockImapMessageFlagsAdd).toHaveBeenCalledWith('3', ['\\Seen']);
  });

  it('marks non-operator messages as READ too', async () => {
    mockImapSearch.mockResolvedValue([5]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'spam@example.com', subject: 'Spam', body: 'buy now' })
    );

    await _runPoll();

    expect(mockImapMessageFlagsAdd).toHaveBeenCalledWith('5', ['\\Seen']);
  });

  it('marks multiple messages in a single poll', async () => {
    mockImapSearch.mockResolvedValue([1, 2, 3]);
    mockImapFetchOne
      .mockResolvedValueOnce(makeFetched({ from: 'owner@restaurant.com', body: 'a' }))
      .mockResolvedValueOnce(makeFetched({ from: 'owner@restaurant.com', body: 'b' }))
      .mockResolvedValueOnce(makeFetched({ from: 'owner@restaurant.com', body: 'c' }));

    setNewSessionHandler(jest.fn().mockResolvedValue(undefined));
    await _runPoll();

    expect(mockImapMessageFlagsAdd).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// AC9 — Gmail App Password authentication (IMAP + SMTP config)
// ---------------------------------------------------------------------------

describe('AC9 — Gmail App Password authentication', () => {
  it('creates ImapFlow client with config from getConfig', async () => {
    await _runPoll();

    expect(ImapFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        host:   BASE_CONFIG.env.email.imapHost,
        port:   BASE_CONFIG.env.email.imapPort,
        secure: true,
        auth: {
          user: BASE_CONFIG.env.email.username,
          pass: BASE_CONFIG.env.email.appPassword,
        },
      })
    );
  });

  it('creates SMTP transport with config from getConfig', async () => {
    await sendEmail({ to: 'x@y.com', subject: 'S', text: 'T' });

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: BASE_CONFIG.env.email.smtpHost,
        port: BASE_CONFIG.env.email.smtpPort,
        auth: {
          user: BASE_CONFIG.env.email.username,
          pass: BASE_CONFIG.env.email.appPassword,
        },
      })
    );
  });

  it('uses secure:true for IMAP (port 993)', async () => {
    await _runPoll();

    expect(ImapFlow).toHaveBeenCalledWith(
      expect.objectContaining({ secure: true })
    );
  });

  it('uses secure:false (STARTTLS) for SMTP (port 587)', async () => {
    await sendEmail({ to: 'x@y.com', subject: 'S', text: 'T' });

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false })
    );
  });
});

// ---------------------------------------------------------------------------
// IMAP connection lifecycle
// ---------------------------------------------------------------------------

describe('IMAP connection lifecycle', () => {
  it('opens INBOX mailbox lock on each poll', async () => {
    await _runPoll();

    expect(mockImapGetMailboxLock).toHaveBeenCalledWith('INBOX');
  });

  it('releases the mailbox lock after processing', async () => {
    await _runPoll();

    expect(mockLockRelease).toHaveBeenCalledTimes(1);
  });

  it('calls logout after processing', async () => {
    await _runPoll();

    expect(mockImapLogout).toHaveBeenCalledTimes(1);
  });

  it('releases lock and logs out even when search returns empty', async () => {
    mockImapSearch.mockResolvedValue([]);

    await _runPoll();

    expect(mockLockRelease).toHaveBeenCalledTimes(1);
    expect(mockImapLogout).toHaveBeenCalledTimes(1);
  });

  it('suppresses polling errors and logs them to console.error', async () => {
    jest.useFakeTimers();
    mockImapConnect.mockRejectedValue(new Error('IMAP auth failed'));

    startPolling();
    jest.advanceTimersByTime(60_000);
    await flushPromises();

    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('IMAP auth failed')
    );
  });
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('exports sendEmail', () => {
    expect(typeof sendEmail).toBe('function');
  });

  it('exports startPolling', () => {
    expect(typeof startPolling).toBe('function');
  });

  it('exports stopPolling', () => {
    expect(typeof stopPolling).toBe('function');
  });

  it('exports setNewSessionHandler', () => {
    expect(typeof setNewSessionHandler).toBe('function');
  });

  it('exports _runPoll', () => {
    expect(typeof _runPoll).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// AC-DKIM — _dkimPasses behaviour with non-Gmail providers  (L12 / H3)
// ---------------------------------------------------------------------------

describe('AC-DKIM — DKIM check config and non-Gmail providers', () => {
  it('drops a message when dkim_check is enabled and Authentication-Results is absent', async () => {
    // Override config: Gmail-style operator but no DKIM header in source
    mockGetConfig.mockReturnValue({
      ...BASE_CONFIG,
      appliance: {
        operator: { email: 'owner@gmail.com' },
        security: { dkim_check: true },
      },
    });

    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'owner@gmail.com', subject: 'Hello', body: 'hi' })
    );

    const mockHandler = jest.fn().mockResolvedValue(undefined);
    setNewSessionHandler(mockHandler);
    await _runPoll();

    // Message must be silently dropped — no session spawned
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('processes a message when dkim_check is false, even without Authentication-Results', async () => {
    // Non-Gmail provider: no DKIM header injected — operator opts out of check
    mockGetConfig.mockReturnValue({
      ...BASE_CONFIG,
      appliance: {
        operator: { email: 'owner@example.com' },
        security: { dkim_check: false },
      },
    });

    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'owner@example.com', subject: 'Hello', body: 'run health check' })
    );

    const mockHandler = jest.fn().mockResolvedValue(undefined);
    setNewSessionHandler(mockHandler);
    await _runPoll();

    expect(mockHandler).toHaveBeenCalledTimes(1);
  });

  it('processes a message when dkim_check is absent from config (defaults to enabled)', async () => {
    // No security key at all — default is enabled, message with no DKIM should be dropped
    mockGetConfig.mockReturnValue({
      ...BASE_CONFIG,
      appliance: {
        operator: { email: 'owner@gmail.com' },
        // no security key
      },
    });

    mockImapSearch.mockResolvedValue([1]);
    mockImapFetchOne.mockResolvedValue(
      makeFetched({ from: 'owner@gmail.com', subject: 'Hello', body: 'hi' })
    );

    const mockHandler = jest.fn().mockResolvedValue(undefined);
    setNewSessionHandler(mockHandler);
    await _runPoll();

    // Default-on DKIM check + no auth header in source → message dropped
    expect(mockHandler).not.toHaveBeenCalled();
  });
});
