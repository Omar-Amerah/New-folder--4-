(function initPowerProtectionRules(root, factory) {
  const onNode = typeof module !== "undefined" && module.exports;
  const rules = factory();
  if (onNode) module.exports = rules;
  root.PowerProtectionRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makePowerProtectionRules() {
  "use strict";

  // Section 7G — runtime Power overload protection rules.
  //
  // Pure, dependency-light rules that turn solved Power-section flow into
  // deterministic time-based overload stress, hysteretic recovery, and
  // protection states. The PowerFlowRules solver remains the sole allocation
  // authority; these rules only accumulate stress from its solved flows.
  // No server, DOM or UI dependencies. Data wiring is never involved.

  const EPSILON = 1e-9;

  const PROTECTION_STATES = Object.freeze([
    "normal", "near-sustained", "overloaded", "critical", "at-peak", "disabled"
  ]);

  const SHIP_PROTECTION_STATES = Object.freeze([
    "normal", "strained", "brownout", "load-shedding", "protection-trip"
  ]);

  // Conservative provisional defaults (Section 7H tunes these later). The
  // authoritative values live in component-balance.json.powerProtection; this
  // table only backs the normaliser so a missing block still yields a safe,
  // finite configuration.
  const DEFAULT_CONFIG = Object.freeze({
    overloadStartRatio: 1.0,
    recoveryStartRatio: 0.95,
    tripStressThreshold: 1.0,
    baseStressPerSecond: 0.12,
    additionalStressPerSecondAtPeak: 0.38,
    recoveryPerSecond: 0.25,
    criticalStressRatio: 0.75,
    tripCooldownSeconds: 4,
    retryIntervalSeconds: 2,
    safeRecloseSustainedRatio: 0.9,
    maxAutomaticRetrySubsets: 1024,
    maximumProtectionDeltaSeconds: 0.25
  });

  function finiteNonNegative(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  // Sanitise any outbound number: finite, never NaN/Infinity/-0.
  function sanitizeNumber(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Object.is(n, -0) ? 0 : n;
  }

  function clamp01(value) {
    const n = sanitizeNumber(value, 0);
    return n <= 0 ? 0 : (n >= 1 ? 1 : n);
  }

  // Central, validated protection configuration. Every value is normalised to
  // a finite, non-negative number; ordering constraints are enforced so the
  // hysteresis band can never invert and substep processing can never divide
  // by zero. Input is never mutated.
  function normalizeConfig(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const config = {};
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      config[key] = finiteNonNegative(source[key], DEFAULT_CONFIG[key]);
    }
    if (!(config.overloadStartRatio > 0)) config.overloadStartRatio = DEFAULT_CONFIG.overloadStartRatio;
    if (config.recoveryStartRatio > config.overloadStartRatio) config.recoveryStartRatio = config.overloadStartRatio;
    if (!(config.tripStressThreshold > 0)) config.tripStressThreshold = DEFAULT_CONFIG.tripStressThreshold;
    if (config.tripStressThreshold > 1) config.tripStressThreshold = 1;
    config.criticalStressRatio = clamp01(config.criticalStressRatio);
    config.safeRecloseSustainedRatio = clamp01(config.safeRecloseSustainedRatio);
    config.maxAutomaticRetrySubsets = Math.max(1, Math.trunc(finiteNonNegative(config.maxAutomaticRetrySubsets, DEFAULT_CONFIG.maxAutomaticRetrySubsets)));
    if (!(config.maximumProtectionDeltaSeconds > 0)) config.maximumProtectionDeltaSeconds = DEFAULT_CONFIG.maximumProtectionDeltaSeconds;
    return config;
  }

  // Normalised overload position between sustained and peak: 0 at sustained,
  // 1 at (or beyond) peak. Degenerate capacities collapse safely to 1.
  function normalisedOverload(absoluteFlowMw, sustainedCapacityMw, peakCapacityMw) {
    const flow = Math.max(0, sanitizeNumber(absoluteFlowMw, 0));
    const sustained = Math.max(0, sanitizeNumber(sustainedCapacityMw, 0));
    const peak = Math.max(sustained, sanitizeNumber(peakCapacityMw, 0));
    if (flow <= sustained) return 0;
    return clamp01((flow - sustained) / Math.max(peak - sustained, EPSILON));
  }

  // Stress-per-second while above sustained. Quadratic in the normalised
  // overload so a section at exactly peak reaches the trip threshold
  // substantially faster than one only slightly above sustained.
  function stressRatePerSecond(absoluteFlowMw, sustainedCapacityMw, peakCapacityMw, config) {
    const overload = normalisedOverload(absoluteFlowMw, sustainedCapacityMw, peakCapacityMw);
    return config.baseStressPerSecond + config.additionalStressPerSecondAtPeak * overload * overload;
  }

  // One deterministic protection step for a single edge at constant solved
  // flow. Large deltas are processed through bounded substeps of at most
  // maximumProtectionDeltaSeconds so a paused server or an unusually large
  // frame can never create several seconds of overload in a hidden single
  // step. Simulation-delta only — never wall-clock time. Returns the new
  // { stress, secondsAboveSustained }; inputs are never mutated.
  function advanceStress(previous, edge, deltaSeconds, rawConfig) {
    const config = rawConfig && typeof rawConfig.maximumProtectionDeltaSeconds === "number" ? rawConfig : normalizeConfig(rawConfig);
    let stress = clamp01(previous && previous.stress);
    let secondsAboveSustained = Math.max(0, sanitizeNumber(previous && previous.secondsAboveSustained, 0));
    const total = sanitizeNumber(deltaSeconds, 0);
    if (!(total > 0)) return { stress, secondsAboveSustained };

    const flow = Math.max(0, sanitizeNumber(edge && edge.absoluteFlowMw, 0));
    const sustained = Math.max(0, sanitizeNumber(edge && edge.sustainedCapacityMw, 0));
    const peak = Math.max(sustained, sanitizeNumber(edge && edge.peakCapacityMw, 0));
    const overloadStart = sustained * config.overloadStartRatio;
    const recoveryStart = sustained * config.recoveryStartRatio;

    const substeps = Math.max(1, Math.ceil(total / config.maximumProtectionDeltaSeconds));
    const step = total / substeps;
    for (let i = 0; i < substeps; i += 1) {
      if (sustained > 0 && flow > overloadStart) {
        stress = clamp01(stress + step * stressRatePerSecond(flow, sustained, peak, config));
        secondsAboveSustained += step;
      } else if (sustained <= 0 || flow <= recoveryStart) {
        stress = clamp01(stress - step * config.recoveryPerSecond);
        secondsAboveSustained = Math.max(0, secondsAboveSustained - step);
        if (stress <= 0) secondsAboveSustained = 0;
      }
      // Between recoveryStart and overloadStart: hold stress steady
      // (hysteresis band prevents rapid threshold chatter).
    }
    return { stress, secondsAboveSustained: sanitizeNumber(secondsAboveSustained, 0) };
  }

  // Protection state for one edge, most severe first. "at-peak" describes
  // flow saturating peak capacity; "critical" describes accumulated stress.
  function protectionStateFor(edge, rawConfig) {
    const config = rawConfig && typeof rawConfig.criticalStressRatio === "number" ? rawConfig : normalizeConfig(rawConfig);
    if (edge && edge.operational === false) return "disabled";
    const flow = Math.max(0, sanitizeNumber(edge && edge.absoluteFlowMw, 0));
    const sustained = Math.max(0, sanitizeNumber(edge && edge.sustainedCapacityMw, 0));
    const peak = Math.max(sustained, sanitizeNumber(edge && edge.peakCapacityMw, 0));
    const stress = clamp01(edge && edge.stress);
    if (peak > 0 && flow >= peak - EPSILON) return "at-peak";
    if (config.criticalStressRatio > 0 && stress >= config.criticalStressRatio) return "critical";
    if (sustained > 0 && flow > sustained * config.overloadStartRatio) return "overloaded";
    if (sustained > 0 && flow > sustained * config.recoveryStartRatio) return "near-sustained";
    return "normal";
  }

  // Ship-level derived protection state (diagnostics only — allocation
  // semantics stay entirely inside PowerFlowRules).
  function shipProtectionState({ trippedSwitchgearCount, shedConsumerCount, partialConsumerCount, overloadedSectionCount }) {
    if (sanitizeNumber(trippedSwitchgearCount, 0) > 0) return "protection-trip";
    if (sanitizeNumber(shedConsumerCount, 0) > 0) return "load-shedding";
    if (sanitizeNumber(partialConsumerCount, 0) > 0) return "brownout";
    if (sanitizeNumber(overloadedSectionCount, 0) > 0) return "strained";
    return "normal";
  }

  return {
    PROTECTION_STATES,
    SHIP_PROTECTION_STATES,
    DEFAULT_CONFIG,
    normalizeConfig,
    sanitizeNumber,
    clamp01,
    normalisedOverload,
    stressRatePerSecond,
    advanceStress,
    protectionStateFor,
    shipProtectionState
  };
}));
