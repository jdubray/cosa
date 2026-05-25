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
];
