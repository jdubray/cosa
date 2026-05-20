'use strict';

// ---------------------------------------------------------------------------
// Mocks — isolate context-builder from the tool registry and the ASM.
// ---------------------------------------------------------------------------

const mockGetSchemas = jest.fn();
const mockGetSummary = jest.fn();

jest.mock('../src/tool-registry', () => ({
  getSchemas: (...args) => mockGetSchemas(...args),
}));

jest.mock('../src/appliance-state-machine', () => ({
  getSummary: (...args) => mockGetSummary(...args),
}));

const { build, identityForRole, ROLE_PERSONA } = require('../src/context-builder');

beforeEach(() => {
  mockGetSchemas.mockReturnValue([]);
  mockGetSummary.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// identityForRole — Layer 0 persona selection
// ---------------------------------------------------------------------------

describe('identityForRole()', () => {
  it('returns the bare COSA identity when no role is given (backward compatible)', () => {
    const base = identityForRole();
    expect(base).toContain('You are COSA');
    expect(base).not.toContain('Your role this session');
  });

  it.each(['probe', 'query', 'action', 'audit'])(
    'appends a distinct persona for the %s role',
    (role) => {
      const text = identityForRole(role);
      expect(text).toContain('You are COSA');               // shared base retained
      expect(text).toContain('Your role this session');     // persona section present
      expect(text).toContain(ROLE_PERSONA[role]);
    }
  );

  it('produces a different Layer-0 string for each role (AC G1)', () => {
    const identities = ['probe', 'query', 'action', 'audit'].map(identityForRole);
    expect(new Set(identities).size).toBe(4);
  });

  it('falls back to the bare identity for an unknown role', () => {
    expect(identityForRole('bogus')).toBe(identityForRole());
  });
});

// ---------------------------------------------------------------------------
// build() — role threads through Layer 0 and Layer 6
// ---------------------------------------------------------------------------

describe('build({ role })', () => {
  it('uses the role persona in the cached Layer-0 block', () => {
    const blocks = build({ role: 'query', timestamp: '2026-05-19T00:00:00Z' });
    expect(blocks[0].text).toContain(ROLE_PERSONA.query);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('passes the role to getSchemas so Layer 6 is role-filtered', () => {
    build({ role: 'probe', timestamp: '2026-05-19T00:00:00Z' });
    expect(mockGetSchemas).toHaveBeenCalledWith('probe');
  });

  it('omitting role keeps backward-compatible behaviour (no role to getSchemas)', () => {
    build({ timestamp: '2026-05-19T00:00:00Z' });
    expect(mockGetSchemas).toHaveBeenCalledWith(undefined);
    expect(build({ timestamp: '2026-05-19T00:00:00Z' })[0].text).toContain('You are COSA');
  });

  it('renders the role-filtered tools into the Layer-6 block', () => {
    mockGetSchemas.mockReturnValue([
      { name: 'health_check', description: 'check', input_schema: { type: 'object' } },
    ]);
    const blocks = build({ role: 'probe', timestamp: '2026-05-19T00:00:00Z' });
    const toolsBlock = blocks.find(b => b.text.startsWith('Available tools'));
    expect(toolsBlock.text).toContain('health_check');
  });
});
