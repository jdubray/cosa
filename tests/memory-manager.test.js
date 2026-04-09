'use strict';

/**
 * Unit tests for memory-manager.js.
 *
 * These tests exercise the truncation logic (Passes 1-4) and the _applyPatch
 * helper without hitting the filesystem or the database.  `fs` and `getConfig`
 * are mocked so the test runs in the Windows Jest environment without
 * better-sqlite3 or real disk I/O.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockFsContent = '';
let mockWrittenContent = null;

jest.mock('fs', () => ({
  existsSync:    jest.fn(() => true),
  readFileSync:  jest.fn(() => mockFsContent),
  writeFileSync: jest.fn((p, data) => { mockWrittenContent = data; }),
  mkdirSync:     jest.fn(),
}));

jest.mock('../config/cosa.config', () => ({
  getConfig: () => ({ env: { dataDir: '/tmp/cosa-test' } }),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const memoryManager = require('../src/memory-manager');

// Approximate MAX_CHARS from the module source
const MAX_CHARS = 2200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid MEMORY.md with one large notes section. */
function buildLargeDoc(notesContent) {
  return [
    '<!-- COSA MEMORY — last updated: 2026-01-01T00:00:00.000Z -->',
    '',
    '## Appliance Health',
    'healthy',
    '',
    '## Recent Incidents',
    '(none)',
    '',
    '## Active Anomalies',
    'None.',
    '',
    '## Operator Preferences',
    'None recorded.',
    '',
    '## Last Backup',
    '2026-01-01',
    '',
    '## Notes',
    notesContent,
    '',
    '<!-- END MEMORY -->',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFsContent    = '';
  mockWrittenContent = null;
  jest.clearAllMocks();
});

describe('updateMemory — truncation passes', () => {
  it('does not truncate when the document is within MAX_CHARS', () => {
    mockFsContent = buildLargeDoc('short note');
    memoryManager.updateMemory({ notes: 'still short' });

    expect(mockWrittenContent).not.toBeNull();
    expect(mockWrittenContent.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(mockWrittenContent).toContain('<!-- END MEMORY -->');
  });

  it('Pass 4 — appends <!-- END MEMORY --> after hard-slice when doc exceeds MAX_CHARS', () => {
    // Create a document that will be too large even after Passes 1-3.
    // Notes alone cannot be cleared (Pass 3 clears Notes but other sections stay).
    // We make ALL sections huge by setting Appliance Health to a huge string.
    const hugeLine = 'x'.repeat(3000);
    mockFsContent = buildLargeDoc('some notes');

    // Patch with a value that ensures the rendered doc exceeds MAX_CHARS
    // even after Pass 3 (which clears Notes).  We bloat every section.
    memoryManager.updateMemory({
      applianceHealth:    hugeLine,
      activeAnomalies:    hugeLine,
      operatorPreference: hugeLine,
      lastBackup:         hugeLine,
    });

    expect(mockWrittenContent).not.toBeNull();
    // slice(0, MAX_CHARS) + '\n<!-- END MEMORY -->' = MAX_CHARS + 20 chars
    expect(mockWrittenContent.length).toBeLessThanOrEqual(MAX_CHARS + '\n<!-- END MEMORY -->'.length);
    expect(mockWrittenContent).toContain('<!-- END MEMORY -->');
  });

  it('Pass 4 — written content length does not exceed MAX_CHARS + END marker', () => {
    const hugeLine = 'y'.repeat(5000);
    mockFsContent = buildLargeDoc('initial notes');

    memoryManager.updateMemory({
      applianceHealth:    hugeLine,
      activeAnomalies:    hugeLine,
      operatorPreference: hugeLine,
      lastBackup:         hugeLine,
      notes:              hugeLine,
    });

    // Hard-slice = doc.slice(0, MAX_CHARS) + '\n<!-- END MEMORY -->' (20 chars)
    const END_MARKER = '\n<!-- END MEMORY -->';
    expect(mockWrittenContent.length).toBeLessThanOrEqual(MAX_CHARS + END_MARKER.length);
  });
});

describe('updateMemory — _applyPatch (L8 refactor)', () => {
  it('replaces simple fields correctly', () => {
    mockFsContent = buildLargeDoc('old notes');
    memoryManager.updateMemory({ notes: 'new notes value' });

    expect(mockWrittenContent).toContain('new notes value');
  });

  it('prepends a new recentIncident bullet', () => {
    mockFsContent = buildLargeDoc('');
    memoryManager.updateMemory({
      recentIncident: { date: '2026-04-01', event: 'disk full', resolution: 'cleaned logs' },
    });

    expect(mockWrittenContent).toContain('- 2026-04-01: disk full — cleaned logs');
  });

  it('prepends to existing incidents rather than replacing them', () => {
    mockFsContent = buildLargeDoc('').replace(
      '(none)',
      '- 2026-03-01: old incident — resolved'
    );
    memoryManager.updateMemory({
      recentIncident: { date: '2026-04-01', event: 'new event', resolution: 'fixed' },
    });

    expect(mockWrittenContent).toContain('- 2026-04-01: new event — fixed');
    expect(mockWrittenContent).toContain('- 2026-03-01: old incident — resolved');
    // New bullet appears before old one
    const newIdx = mockWrittenContent.indexOf('2026-04-01');
    const oldIdx = mockWrittenContent.indexOf('2026-03-01');
    expect(newIdx).toBeLessThan(oldIdx);
  });
});

describe('loadMemory', () => {
  it('returns the empty template when the file does not exist', () => {
    require('fs').existsSync.mockReturnValueOnce(false);
    const content = memoryManager.loadMemory();
    expect(content).toContain('## Appliance Health');
    expect(content).toContain('<!-- COSA MEMORY');
  });

  it('returns file contents when the file exists', () => {
    const stored = buildLargeDoc('persisted notes');
    mockFsContent = stored;
    const content = memoryManager.loadMemory();
    expect(content).toContain('persisted notes');
  });
});
