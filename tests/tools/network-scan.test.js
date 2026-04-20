'use strict';

/**
 * Unit tests for src/tools/network-scan.js
 *
 * Acceptance Criteria covered:
 *   AC1 — executes `ip neigh` via SSH on Baanbaan Pi
 *   AC2 — compares each device MAC against knownMacAddresses from appliance config
 *   AC3 — returns devices array with known flag and name for matched devices
 *   AC4 — returns unknownDevices array
 *   AC5 — unknown MAC on network returns severity 'medium'
 *   AC6 — unknown device connecting to appliance port (orchestrator escalation path)
 *   AC7 — multiple unknown MACs appearing simultaneously returns severity 'high'
 *   AC8 — risk level is 'read'
 */

// ---------------------------------------------------------------------------
// Mocks — hoisted before any require()
// ---------------------------------------------------------------------------

const mockIsConnected = jest.fn();
const mockExec        = jest.fn();
const mockGetConfig   = jest.fn();

jest.mock('../../src/ssh-backend', () => ({
  isConnected: (...a) => mockIsConnected(...a),
  exec:        (...a) => mockExec(...a),
}));

jest.mock('../../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

jest.mock('../../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { handler, riskLevel, name } = require('../../src/tools/network-scan');

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const KNOWN_MAC_1 = 'b8:27:eb:00:00:01';
const KNOWN_MAC_2 = 'dc:a6:32:00:00:02';
const UNKNOWN_MAC   = '00:11:22:33:44:55';
const UNKNOWN_MAC_2 = 'aa:bb:cc:dd:ee:ff';

const BASE_CONFIG = {
  appliance: {
    network: {
      known_mac_addresses: [
        { mac: KNOWN_MAC_1, name: 'Baanbaan Pi' },
        { mac: KNOWN_MAC_2, name: 'Router' },
      ],
    },
    tools: {
      network_scan: { enabled: true },
    },
  },
};

/**
 * Build a single `ip neigh` output line in the standard iproute2 format:
 *   <ip> dev <iface> lladdr <mac> <STATE>
 *
 * @param {string} ip
 * @param {string} mac
 * @param {string} [iface='wlan0']
 * @param {string} [state='REACHABLE']
 */
function neighLine(ip, mac, iface = 'wlan0', state = 'REACHABLE') {
  return `${ip} dev ${iface} lladdr ${mac} ${state}`;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockIsConnected.mockReturnValue(true);
  mockExec.mockReset();
  mockExec.mockResolvedValue({ stdout: '', exitCode: 0 });
  mockGetConfig.mockReturnValue(BASE_CONFIG);
});

// ---------------------------------------------------------------------------
// AC8 — Risk level and module identity
// ---------------------------------------------------------------------------

describe('AC8 — risk level is "read"', () => {
  it('exports name "network_scan"', () => {
    expect(name).toBe('network_scan');
  });

  it('exports riskLevel "read"', () => {
    expect(riskLevel).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// AC1 — Executes ip neigh via SSH
// ---------------------------------------------------------------------------

describe('AC1 — executes ip neigh via SSH', () => {
  it('calls sshBackend.exec with the exact command "ip neigh"', async () => {
    await handler();
    expect(mockExec).toHaveBeenCalledWith('ip neigh');
  });

  it('checks SSH connection before executing', async () => {
    mockIsConnected.mockReturnValue(false);
    await expect(handler()).rejects.toThrow('SSH not connected');
  });

  it('throws if exec returns non-zero exitCode with no stdout', async () => {
    mockExec.mockResolvedValue({ stdout: '', exitCode: 1, stderr: 'permission denied' });
    await expect(handler()).rejects.toThrow('ip neigh failed');
  });

  it('succeeds when exec returns non-zero exitCode but stdout is present', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.1', KNOWN_MAC_1),
      exitCode: 1,
    });
    const result = await handler();
    expect(result.devices).toHaveLength(1);
  });

  it('returns checked_at ISO timestamp', async () => {
    const result = await handler();
    expect(result.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// AC2 — Compares each device MAC against knownMacAddresses
// ---------------------------------------------------------------------------

describe('AC2 — MAC comparison against config', () => {
  it('reads known_mac_addresses from appliance.network config', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.1', KNOWN_MAC_1),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.devices[0].known).toBe(true);
  });

  it('normalises MAC to lowercase before comparison (handles uppercase)', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.1', KNOWN_MAC_1.toUpperCase()),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.devices[0].known).toBe(true);
  });

  it('normalises dashes to colons before comparison', async () => {
    const dashedMac = KNOWN_MAC_1.replace(/:/g, '-');
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.1', dashedMac),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.devices[0].known).toBe(true);
  });

  it('skips FAILED/INCOMPLETE entries (no lladdr in the line)', async () => {
    mockExec.mockResolvedValue({
      stdout:   '192.168.1.99 dev wlan0  FAILED',
      exitCode: 0,
    });
    const result = await handler();
    expect(result.devices).toHaveLength(0);
    expect(result.totalDeviceCount).toBe(0);
  });

  it('handles empty known_mac_addresses config gracefully', async () => {
    mockGetConfig.mockReturnValue({
      appliance: { network: { known_mac_addresses: [] } },
    });
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.1', KNOWN_MAC_1),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.devices[0].known).toBe(false);
  });

  it('handles missing network config section gracefully', async () => {
    mockGetConfig.mockReturnValue({ appliance: {} });
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.1', KNOWN_MAC_1),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.devices[0].known).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Returns devices array with known flag and name
// ---------------------------------------------------------------------------

describe('AC3 — devices array with known flag and name', () => {
  it('sets known=true and name for a matched device', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.1', KNOWN_MAC_1),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0]).toMatchObject({
      mac:   KNOWN_MAC_1,
      known: true,
      name:  'Baanbaan Pi',
    });
  });

  it('sets known=false and name=null for an unrecognised device', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.99', UNKNOWN_MAC),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.devices[0]).toMatchObject({
      mac:   UNKNOWN_MAC,
      known: false,
      name:  null,
    });
  });

  it('includes ip, hostname (= ip), and iface fields on each device', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('10.0.0.1', KNOWN_MAC_2, 'wlan0'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.devices[0]).toMatchObject({
      hostname: '10.0.0.1',
      ip:       '10.0.0.1',
      mac:      KNOWN_MAC_2,
      iface:    'wlan0',
    });
  });

  it('handles multiple devices — all fields present on each', async () => {
    mockExec.mockResolvedValue({
      stdout: [
        neighLine('192.168.1.1', KNOWN_MAC_1),
        neighLine('192.168.1.2', KNOWN_MAC_2),
      ].join('\n'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.devices).toHaveLength(2);
    expect(result.totalDeviceCount).toBe(2);
  });

  it('parses IPv6 entries with router flag between lladdr and state', async () => {
    mockExec.mockResolvedValue({
      stdout:   `fe80::1 dev wlan0 lladdr ${KNOWN_MAC_2} router STALE`,
      exitCode: 0,
    });
    const result = await handler();
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0].mac).toBe(KNOWN_MAC_2);
  });

  it('returns summary string when all devices are known', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.1', KNOWN_MAC_1),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.summary).toMatch(/known/i);
  });
});

// ---------------------------------------------------------------------------
// AC4 — Returns unknownDevices array
// ---------------------------------------------------------------------------

describe('AC4 — unknownDevices array', () => {
  it('returns empty unknownDevices when all MACs are known', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.1', KNOWN_MAC_1),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.unknownDevices).toHaveLength(0);
  });

  it('populates unknownDevices with unrecognised MAC entries', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.99', UNKNOWN_MAC),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.unknownDevices).toHaveLength(1);
    expect(result.unknownDevices[0].mac).toBe(UNKNOWN_MAC);
  });

  it('unknown device appears in both devices and unknownDevices', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.99', UNKNOWN_MAC),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.devices.some((d) => d.mac === UNKNOWN_MAC)).toBe(true);
    expect(result.unknownDevices).toHaveLength(1);
  });

  it('unknownDevices entries do NOT include known or name fields', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.99', UNKNOWN_MAC),
      exitCode: 0,
    });
    const result = await handler();
    const entry = result.unknownDevices[0];
    expect(entry).not.toHaveProperty('known');
    expect(entry).not.toHaveProperty('name');
  });

  it('unknownDevices entries include ip, mac, hostname, iface', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('10.0.0.99', UNKNOWN_MAC, 'eth1'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.unknownDevices[0]).toMatchObject({
      ip:       '10.0.0.99',
      mac:      UNKNOWN_MAC,
      hostname: '10.0.0.99',
      iface:    'eth1',
    });
  });
});

// ---------------------------------------------------------------------------
// AC5 — Single unknown MAC returns severity 'medium'
// ---------------------------------------------------------------------------

describe('AC5 — single unknown MAC returns severity "medium"', () => {
  it('returns severity=medium for exactly one unknown device', async () => {
    mockExec.mockResolvedValue({
      stdout: [
        neighLine('192.168.1.1',  KNOWN_MAC_1),
        neighLine('192.168.1.99', UNKNOWN_MAC),
      ].join('\n'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.severity).toBe('medium');
  });

  it('individual unknown device entry gets severity=medium for single unknown', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.99', UNKNOWN_MAC),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.unknownDevices[0].severity).toBe('medium');
  });

  it('returns severity=null and empty unknownDevices when all devices are known', async () => {
    mockExec.mockResolvedValue({
      stdout: [
        neighLine('192.168.1.1', KNOWN_MAC_1),
        neighLine('192.168.1.2', KNOWN_MAC_2),
      ].join('\n'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.severity).toBeNull();
    expect(result.unknownDevices).toHaveLength(0);
  });

  it('returns severity=null and empty unknownDevices when neighbour table is empty', async () => {
    mockExec.mockResolvedValue({ stdout: '', exitCode: 0 });
    const result = await handler();
    expect(result.severity).toBeNull();
    expect(result.unknownDevices).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC6 — Unknown device connecting to appliance port
//
// Port-level escalation (whether the device is actively connecting to an
// appliance port) is evaluated by the orchestrator layer using the ip field
// from this tool's result, not inside this tool.  These tests verify that the
// tool exposes the ip and mac fields needed for orchestrator correlation.
// ---------------------------------------------------------------------------

describe('AC6 — unknown device on appliance port (orchestrator escalation)', () => {
  it('unknownDevices entry contains ip for orchestrator port correlation', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('10.0.0.99', UNKNOWN_MAC),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.unknownDevices[0]).toMatchObject({
      ip:  '10.0.0.99',
      mac: UNKNOWN_MAC,
    });
  });

  it('summary string mentions unknown device count for operator visibility', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('10.0.0.99', UNKNOWN_MAC),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.summary).toMatch(/1 unknown/i);
  });

  it('unknownDevices entry has severity label for orchestrator triage', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('10.0.0.99', UNKNOWN_MAC),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.unknownDevices[0]).toHaveProperty('severity');
    expect(['medium', 'high']).toContain(result.unknownDevices[0].severity);
  });
});

// ---------------------------------------------------------------------------
// AC7 — Multiple unknown MACs simultaneously returns severity 'high'
// ---------------------------------------------------------------------------

describe('AC7 — multiple simultaneous unknown MACs returns severity "high"', () => {
  it('returns severity=high when two unknown devices are detected', async () => {
    mockExec.mockResolvedValue({
      stdout: [
        neighLine('192.168.1.10', UNKNOWN_MAC),
        neighLine('192.168.1.11', UNKNOWN_MAC_2),
      ].join('\n'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.severity).toBe('high');
  });

  it('each unknown device entry gets severity=high when multiple unknowns', async () => {
    mockExec.mockResolvedValue({
      stdout: [
        neighLine('192.168.1.10', UNKNOWN_MAC),
        neighLine('192.168.1.11', UNKNOWN_MAC_2),
      ].join('\n'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.unknownDevices).toHaveLength(2);
    for (const d of result.unknownDevices) {
      expect(d.severity).toBe('high');
    }
  });

  it('known + multiple unknown still triggers high severity', async () => {
    mockExec.mockResolvedValue({
      stdout: [
        neighLine('192.168.1.1',  KNOWN_MAC_1),
        neighLine('192.168.1.10', UNKNOWN_MAC),
        neighLine('192.168.1.11', UNKNOWN_MAC_2),
      ].join('\n'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.severity).toBe('high');
    expect(result.unknownDevices).toHaveLength(2);
    expect(result.totalDeviceCount).toBe(3);
  });

  it('exactly one unknown does NOT trigger high severity', async () => {
    mockExec.mockResolvedValue({
      stdout:   neighLine('192.168.1.10', UNKNOWN_MAC),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.severity).not.toBe('high');
    expect(result.severity).toBe('medium');
  });

  it('summary string mentions severity when unknowns are present', async () => {
    mockExec.mockResolvedValue({
      stdout: [
        neighLine('192.168.1.10', UNKNOWN_MAC),
        neighLine('192.168.1.11', UNKNOWN_MAC_2),
      ].join('\n'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.summary).toMatch(/high/i);
  });
});
