'use strict';

const { shEscape } = require('../src/shell-utils');

describe('shEscape()', () => {
  it('returns a string with no single quotes unchanged', () => {
    expect(shEscape('hello')).toBe('hello');
    expect(shEscape('/var/log/cosa')).toBe('/var/log/cosa');
    expect(shEscape('192.168.1.248')).toBe('192.168.1.248');
  });

  it('escapes a single embedded apostrophe via close-escape-reopen', () => {
    // The classic "Joe's bar" case — the only way to embed a literal single
    // quote inside a single-quoted shell string is to close, escape, reopen.
    expect(shEscape("Joe's bar")).toBe("Joe'\\''s bar");
  });

  it('escapes every apostrophe (not just the first)', () => {
    expect(shEscape("a'b'c")).toBe("a'\\''b'\\''c");
  });

  it('coerces non-string arguments to strings before escaping', () => {
    expect(shEscape(42)).toBe('42');
    expect(shEscape(null)).toBe('null');
    expect(shEscape(undefined)).toBe('undefined');
    expect(shEscape(true)).toBe('true');
  });

  it('produces output that, when wrapped in single quotes, is shell-safe', () => {
    // Round-trip property check: 'PREFIX' + shEscape(s) + 'SUFFIX' wrapped in
    // outer single quotes must not allow `s` to break out of the quoting.
    const adversarial = "x'; rm -rf /tmp; echo '";
    const escaped     = shEscape(adversarial);
    const wrapped     = `'${escaped}'`;
    // The wrapped string must contain no UN-escaped single quote inside the
    // outer pair — a quick scan: every internal `'` must be immediately
    // followed by `\''` (close, escaped quote, reopen).
    const inner = wrapped.slice(1, -1);
    let i = 0;
    while ((i = inner.indexOf("'", i)) !== -1) {
      expect(inner.slice(i, i + 4)).toBe("'\\''");
      i += 4;
    }
  });

  it('preserves backslashes, dollar signs, and other shell metacharacters', () => {
    // Inside a single-quoted bash string these are LITERAL — shEscape's job
    // is only the apostrophe. Other chars must pass through verbatim.
    expect(shEscape('$HOME')).toBe('$HOME');
    expect(shEscape('a\\b')).toBe('a\\b');
    expect(shEscape('a;b|c&d')).toBe('a;b|c&d');
  });

  it('handles the empty string', () => {
    expect(shEscape('')).toBe('');
  });
});
