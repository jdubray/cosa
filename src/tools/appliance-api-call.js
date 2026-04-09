'use strict';

const Ajv                    = require('ajv');
const { getConfig }          = require('../../config/cosa.config');
const { withApplianceAuth }  = require('../appliance-auth');
const credentialStore        = require('../credential-store');
const { createLogger }       = require('../logger');

const log = createLogger('appliance-api-call');

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

const NAME       = 'appliance_api_call';

/**
 * The tool registry stores a static risk level at registration time.
 * `appliance_api_call` uses `'dynamic'` as a sentinel so the orchestrator
 * can resolve the actual level from the endpoint allowlist entry at dispatch
 * time — before the approval gate runs.
 */
const RISK_LEVEL = 'dynamic';

const SCHEMA = {
  description:
    'Make an authenticated call to a pre-approved appliance API endpoint. ' +
    'The endpoint must be listed in appliance_api.api_endpoints in appliance.yaml. ' +
    'Provide the endpoint name, any dynamic path parameters, and the request body.',
  inputSchema: {
    type: 'object',
    properties: {
      endpoint_name: {
        type: 'string',
        description:
          'The name of the endpoint as listed in appliance.yaml api_endpoints ' +
          '(e.g. "update_order_status", "pause_store").',
      },
      path_params: {
        type: 'object',
        description:
          'Dynamic path parameter values (only params marked "caller" in the config). ' +
          'Static params (e.g. merchantId) are resolved automatically from the credential store.',
        additionalProperties: { type: 'string' },
      },
      body: {
        type: 'object',
        description: 'Request body. Must conform to the endpoint body_schema in appliance.yaml.',
        additionalProperties: true,
      },
      reason: {
        type: 'string',
        maxLength: 500,
        description: 'Required for high-risk endpoints. Included in the operator approval email.',
      },
    },
    required: ['endpoint_name', 'body'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const _ajv = new Ajv({ allErrors: true });

/**
 * AJV validator cache keyed by endpoint name.
 * Note: validators are compiled once and never invalidated.  If appliance.yaml
 * body_schema entries are changed, COSA must be restarted for the new schemas
 * to take effect.
 * @type {Map<string, import('ajv').ValidateFunction>}
 */
const _validatorCache = new Map();

/**
 * Return a compiled AJV validator for an endpoint's body schema.
 * Results are cached by endpoint name.
 *
 * @param {string} name
 * @param {object} bodySchema
 * @returns {import('ajv').ValidateFunction}
 */
function getBodyValidator(name, bodySchema) {
  if (!_validatorCache.has(name)) {
    _validatorCache.set(name, _ajv.compile(bodySchema));
  }
  return _validatorCache.get(name);
}

/**
 * Resolve a URL path template, substituting each `:param` with its value.
 *
 * Static params come from `${credential:KEY}` entries in the allowlist config
 * and are resolved from the credential store.  Dynamic params are marked as
 * `"caller"` in the config and must be provided by the caller via
 * `input.path_params`.
 *
 * @param {string}            pathTemplate - e.g. `/api/merchants/:merchantId/orders/:orderId/status`
 * @param {Record<string,string>} paramConfig  - allowlist `path_params` map
 * @param {Record<string,string>} callerParams - `input.path_params` (may be undefined)
 * @returns {{ resolvedPath: string } | { error: string, code: string }}
 */
function resolvePathParams(pathTemplate, paramConfig, callerParams) {
  const provided = callerParams ?? {};

  // Guard: caller must not supply a param that is NOT marked "caller" in config.
  for (const key of Object.keys(provided)) {
    const configValue = paramConfig?.[key];
    if (configValue !== 'caller') {
      return {
        error: `Path parameter "${key}" is statically configured and cannot be overridden`,
        code:  'APPLIANCE_PARAM_INJECTION',
      };
    }
  }

  // Resolve the template.
  let resolved = pathTemplate;
  const paramNames = (pathTemplate.match(/:([A-Za-z_][A-Za-z0-9_]*)/g) ?? [])
    .map(p => p.slice(1));

  for (const param of paramNames) {
    const configValue = paramConfig?.[param];

    if (!configValue) {
      return {
        error: `Path parameter "${param}" has no configuration in allowlist`,
        code:  'APPLIANCE_PARAM_INJECTION',
      };
    }

    let value;
    const credMatch = configValue.match(/^\$\{credential:([^}]+)\}$/);
    if (credMatch) {
      // Static — read from credential store
      value = credentialStore.get(credMatch[1]);
    } else if (configValue === 'caller') {
      // Dynamic — must be supplied by caller
      value = provided[param];
      if (value == null) {
        return {
          error: `Required dynamic path parameter "${param}" not provided in path_params`,
          code:  'APPLIANCE_PARAM_MISSING',
        };
      }
    } else {
      // Literal static value in config
      value = configValue;
    }

    resolved = resolved.replace(`:${param}`, encodeURIComponent(String(value)));
  }

  return { resolvedPath: resolved };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   endpoint_name: string,
 *   path_params?: Record<string,string>,
 *   body: object,
 *   reason?: string
 * }} input
 * @returns {Promise<object>}
 */
async function handler(input) {
  const actionedAt = new Date().toISOString();
  const { appliance } = getConfig();
  const apiCfg    = appliance.appliance_api ?? {};
  const baseUrl   = apiCfg.base_url          ?? '';
  const timeout   = apiCfg.request_timeout_ms ?? 10000;
  const endpoints = apiCfg.api_endpoints      ?? [];

  // ── 1. Allowlist lookup ────────────────────────────────────────────────────
  const entry = endpoints.find(e => e.name === input.endpoint_name);
  if (!entry) {
    return {
      success:     false,
      error:       `Endpoint '${input.endpoint_name}' is not in the appliance.yaml allowlist`,
      code:        'APPLIANCE_ENDPOINT_NOT_ALLOWED',
      actioned_at: actionedAt,
    };
  }

  // ── 1a. Enforce reason for high/critical risk endpoints ───────────────────
  if ((entry.risk === 'high' || entry.risk === 'critical') && !input.reason?.trim()) {
    return {
      success:     false,
      error:       `"reason" is required for high-risk endpoint "${entry.name}" — describe why this action is needed`,
      code:        'APPLIANCE_REASON_REQUIRED',
      actioned_at: actionedAt,
    };
  }

  // ── 2. Resolve path parameters ────────────────────────────────────────────
  const pathResult = resolvePathParams(
    entry.path,
    entry.path_params ?? {},
    input.path_params
  );
  if (pathResult.error) {
    return {
      success:     false,
      error:       pathResult.error,
      code:        pathResult.code,
      actioned_at: actionedAt,
    };
  }

  // ── 3. Validate request body ──────────────────────────────────────────────
  if (entry.body_schema) {
    const validate = getBodyValidator(entry.name, entry.body_schema);
    const valid    = validate(input.body);
    if (!valid) {
      const validationErrors = (validate.errors ?? []).map(e => {
        const field = e.instancePath || '/';
        return `${field} ${e.message}`;
      });
      return {
        success:           false,
        error:             'Request body is invalid',
        code:              'APPLIANCE_BODY_INVALID',
        validation_errors: validationErrors,
        actioned_at:       actionedAt,
      };
    }
  }

  // ── 4. Execute ────────────────────────────────────────────────────────────
  // Append static query params from the allowlist config (if any).
  // These are fixed values from appliance.yaml — not caller-supplied — so no
  // injection risk.  Caller-supplied query params are not supported.
  let resolvedPath = pathResult.resolvedPath;
  if (entry.query_params && Object.keys(entry.query_params).length > 0) {
    const qs = new URLSearchParams(entry.query_params).toString();
    resolvedPath = `${resolvedPath}?${qs}`;
  }

  const url = `${baseUrl}${resolvedPath}`;
  log.info(`${entry.method} ${url} (endpoint: ${entry.name})`);

  let httpResult;
  try {
    httpResult = await withApplianceAuth(async (authHeaders) => {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), timeout);
      try {
        const res  = await fetch(url, {
          method:  entry.method,
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body:   JSON.stringify(input.body),
          signal: controller.signal,
        });
        let body = null;
        try { body = await res.json(); } catch { /* non-JSON response */ }
        return { status: res.status, body };
      } finally {
        clearTimeout(timer);
      }
    });
  } catch (err) {
    return {
      success:       false,
      endpoint_name: entry.name,
      error:         err.message,
      code:          err.code ?? 'APPLIANCE_NETWORK_ERROR',
      actioned_at:   actionedAt,
    };
  }

  // ── 5. Return result ──────────────────────────────────────────────────────
  const ok = httpResult.status >= 200 && httpResult.status < 300;

  if (!ok) {
    return {
      success:       false,
      endpoint_name: entry.name,
      method:        entry.method,
      status_code:   httpResult.status,
      error:         `Appliance returned ${httpResult.status}`,
      body:          httpResult.body,
      actioned_at:   actionedAt,
    };
  }

  return {
    success:       true,
    endpoint_name: entry.name,
    method:        entry.method,
    status_code:   httpResult.status,
    body:          httpResult.body,
    actioned_at:   actionedAt,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = {
  name:      NAME,
  schema:    SCHEMA,
  handler,
  riskLevel: RISK_LEVEL,
};
