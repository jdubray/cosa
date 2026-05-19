'use strict';

const mockGetConfig = jest.fn();
jest.mock('../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

const { appBasePath, appPath, DEFAULT_APP_BASE_PATH } = require('../src/app-paths');

beforeEach(() => {
  mockGetConfig.mockReset();
  mockGetConfig.mockReturnValue({ appliance: {} });
});

describe('appBasePath()', () => {
  it('returns the default when appliance.app_base_path is unset', () => {
    expect(appBasePath()).toBe(DEFAULT_APP_BASE_PATH);
    expect(appBasePath()).toBe('/home/baanbaan/baan-baan-merchant/v2');
  });

  it('returns the configured override when set', () => {
    mockGetConfig.mockReturnValue({ appliance: { app_base_path: '/opt/baanbaan' } });
    expect(appBasePath()).toBe('/opt/baanbaan');
  });

  it('falls back to default when the configured value is empty', () => {
    mockGetConfig.mockReturnValue({ appliance: { app_base_path: '' } });
    expect(appBasePath()).toBe(DEFAULT_APP_BASE_PATH);
  });

  it('falls back to default when appliance is missing entirely', () => {
    mockGetConfig.mockReturnValue({});
    expect(appBasePath()).toBe(DEFAULT_APP_BASE_PATH);
  });
});

describe('appPath(rel)', () => {
  it('returns the base path when called with no argument', () => {
    expect(appPath()).toBe(DEFAULT_APP_BASE_PATH);
  });

  it('joins a relative subpath with a single slash', () => {
    expect(appPath('data/merchant.db')).toBe('/home/baanbaan/baan-baan-merchant/v2/data/merchant.db');
    expect(appPath('.env')).toBe('/home/baanbaan/baan-baan-merchant/v2/.env');
  });

  it('strips leading slashes on rel so callers can pass either form', () => {
    expect(appPath('/data/merchant.db')).toBe(appPath('data/merchant.db'));
    expect(appPath('///data/merchant.db')).toBe(appPath('data/merchant.db'));
  });

  it('honors the config override consistently with appBasePath()', () => {
    mockGetConfig.mockReturnValue({ appliance: { app_base_path: '/opt/x' } });
    expect(appPath()).toBe('/opt/x');
    expect(appPath('data/y.db')).toBe('/opt/x/data/y.db');
  });

  it('does not use path.join (so a Windows host produces forward-slash remote paths)', () => {
    // Even on a Windows COSA host the remote target is Linux; the joined
    // path must use forward slashes regardless of the host's path.sep.
    expect(appPath('a/b/c')).toMatch(/^[^\\]+$/);
  });

  it('coerces non-string rel values to strings', () => {
    expect(appPath(42)).toBe('/home/baanbaan/baan-baan-merchant/v2/42');
  });
});
