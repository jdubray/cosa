'use strict';

/**
 * Data-driven observation monitors (self-extending monitoring, Phase 1).
 *
 * Each entry is a MONITOR expressed as data — a probe + params + numeric
 * thresholds + a report template. The observation-monitor evaluator runs the
 * enabled ones on a schedule and emails the operator (templated) on
 * medium/high, deduped per monitor. Adding a monitor is a data edit, not code:
 * this is the substrate COSA will later write to itself (Phase 2,
 * approval-gated).
 *
 * Rollout note: the entries below are shipped `enabled: false`. They are the
 * proof that the primitive covers the two signals we previously hand-coded
 * (Pi under-voltage in resource-threshold-monitor; Finix timeouts in the
 * bespoke finix_latency_monitor tool). Flip them on once validated — and then
 * the hand-written equivalents can be retired so each signal has one owner.
 */

module.exports = [
  {
    id:          'pi_undervoltage',
    enabled:     false,
    description: 'Raspberry Pi under-voltage via vcgencmd get_throttled (now=2, occurred=1, clean=0).',
    probe:       'vcgencmd_throttled',
    params:      {},
    threshold:   { comparator: 'gte', medium: 1, high: 2 },
    report_template:
      'Raspberry Pi under-voltage on the cafe appliance.\n\n' +
      'Severity:          {{severity}}\n' +
      'Under-voltage now: {{undervoltage_now}}\n' +
      'Since boot:        {{undervoltage_occurred}}\n' +
      'Conditions:        {{conditions}}\n' +
      'Raw flag:          {{raw}}\n\n' +
      'Under-voltage can corrupt the SD card and crash the POS. The usual cause is ' +
      'the power supply or cable — check that the official PSU is in use and the ' +
      'cable is sound. Detected at {{checked_at}}.',
  },
  {
    id:          'finix_transfer_timeouts',
    enabled:     false,
    description: 'Finix card-transfer 30s timeouts in baanbaan.service logs over the window.',
    probe:       'log_pattern_count',
    params:      {
      unit:           'baanbaan.service',
      window_minutes: 60,
      // AND of fixed strings — only count timeout lines that are transfer POSTs.
      patterns:       ['"path":"/transfers"', 'The operation timed out.'],
    },
    threshold:   { comparator: 'gte', medium: 4, high: 10 },
    report_template:
      'Finix transfer timeouts elevated on the cafe POS.\n\n' +
      'Severity:                {{severity}}\n' +
      'Timeouts in last {{window_minutes}}m: {{value}}\n\n' +
      'Timed-out transfers usually still settle via the idempotency retry, so this ' +
      'is a payment-latency signal rather than lost revenue — but a sustained spike ' +
      'is worth raising with Finix or checking the appliance network path. ' +
      'Detected at {{checked_at}}.',
  },
  {
    id:          'printer_179_unreachable',
    enabled:     true,
    description: 'Sony POS receipt printer (192.168.1.179, wired) LAN reachability via ping.',
    probe:       'ping_reachability',
    params:      { host: '192.168.1.179', count: 3 },
    threshold:   { comparator: 'gte', medium: 34, high: 100 },
    report_template:
      'Receipt printer at {{host}} is not responding on the LAN.\n\n' +
      'Severity:     {{severity}}\n' +
      'Packet loss:  {{packet_loss_pct}}% ({{count}} pings)\n\n' +
      'A bad link usually means the Ethernet cable or switch port to this printer ' +
      'has failed, or the printer has lost power. Check the physical link light on ' +
      'the printer and the switch before assuming a software issue. ' +
      'Detected at {{checked_at}}.',
  },
  {
    id:          'printer_217_unreachable',
    enabled:     true,
    description: 'Sony POS receipt printer (192.168.1.217, wired) LAN reachability via ping.',
    probe:       'ping_reachability',
    params:      { host: '192.168.1.217', count: 3 },
    threshold:   { comparator: 'gte', medium: 34, high: 100 },
    report_template:
      'Receipt printer at {{host}} is not responding on the LAN.\n\n' +
      'Severity:     {{severity}}\n' +
      'Packet loss:  {{packet_loss_pct}}% ({{count}} pings)\n\n' +
      'A bad link usually means the Ethernet cable or switch port to this printer ' +
      'has failed, or the printer has lost power. Check the physical link light on ' +
      'the printer and the switch before assuming a software issue. ' +
      'Detected at {{checked_at}}.',
  },
  {
    id:          'payments_missing_processor_fee',
    enabled:     true,
    description: 'Card payments with a Finix transfer that still have no processor fee 48h on.',
    probe:       'sqlite_scalar',
    params:      {
      // 48h: the sweep itself only considers payments older than 24h, and Finix
      // populates fee records during settlement (~24h after SUCCEEDED), so
      // anything past 48h that is still NULL means the backfill is not working.
      sql:
        "SELECT COUNT(*) FROM payments " +
        "WHERE processor_fee_cents IS NULL " +
        "AND finix_transfer_id IS NOT NULL AND finix_transfer_id != '' " +
        "AND created_at < datetime('now', '-48 hours')",
    },
    // A healthy day settles every card payment, so the steady state is single
    // digits (only the most recent, not-yet-settled rows). 25 means a couple of
    // days have gone unfilled; 100 means it has been broken for a week+.
    threshold:   { comparator: 'gte', medium: 25, high: 100 },
    report_template:
      'Processor fees are not being recorded for card payments on the POS.\n\n' +
      'Severity:                {{severity}}\n' +
      'Payments missing a fee:  {{value}} (older than 48h, Finix transfer present)\n\n' +
      'The nightly [processor-fees] sweep fills payments.processor_fee_cents from ' +
      'Finix. When this number climbs, the sweep is running but getting nothing ' +
      'back — the sweep logs no error in that case, so this monitor is the only ' +
      'signal. Effective-rate and net-revenue figures in the dashboard and reports ' +
      'are understated for every payment counted here. ' +
      'See docs/baanbaan_processor_fee_backfill_stall_spec.md. ' +
      'Detected at {{checked_at}}.',
  },
];
