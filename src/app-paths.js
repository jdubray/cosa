'use strict';

/**
 * Resolve paths on the remote appliance under the BaanBaan POS app directory.
 *
 * Centralizes the `/home/baanbaan/baan-baan-merchant/v2` base path that used
 * to be duplicated across at least five tool files (credential-audit,
 * backup-run, backup-verify, webhook-hmac-verify, access-log-scan,
 * compliance-verify, pci-assessment). Operators can rebase the entire app
 * tree by setting a single `appliance.app_base_path` in appliance.yaml.
 * 2026-05-18 review §C Larger #8.
 *
 * These are *remote* (Linux) paths consumed by SSH commands — do not use
 * path.join() because the COSA host may be running on Windows.
 */

const { getConfig } = require('../config/cosa.config');

const DEFAULT_APP_BASE_PATH = '/home/baanbaan/baan-baan-merchant/v2';

/**
 * Return the configured appliance base path (or the default).
 *
 * @returns {string}
 */
function appBasePath() {
  const { appliance } = getConfig();
  return appliance.app_base_path || DEFAULT_APP_BASE_PATH;
}

/**
 * Join a relative subpath under the appliance base. Strips leading slashes
 * on `rel` so callers can pass either `data/merchant.db` or `/data/...`.
 *
 * @param {string} [rel='']
 * @returns {string}
 */
function appPath(rel = '') {
  const base = appBasePath();
  if (!rel) return base;
  return `${base}/${String(rel).replace(/^\/+/, '')}`;
}

module.exports = { appBasePath, appPath, DEFAULT_APP_BASE_PATH };
