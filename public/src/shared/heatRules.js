(function initHeatRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.HeatRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeHeatRules() {
  "use strict";

  const TICK_SECONDS = 0.2;
  const STATE = Object.freeze({ NORMAL: 0, WARM: 1, HOT: 2, CRITICAL: 3, OVERHEATED: 4 });
  const STATE_LABELS = Object.freeze(["Cool", "Warm", "Hot", "Critical", "Overheated"]);
  const THRESHOLDS = Object.freeze({ warm: 0.42, hot: 0.68, critical: 0.86, overheated: 1, recover: 0.62 });
  // Wrecks retain heat and can exchange it with immediately adjacent material,
  // but this deliberately small coefficient cannot bridge a routed network.
  const CONDUCTIVITY = Object.freeze({ frame: 2.1, system: 0.72, armor: 0.48, compositeArmor: 0.28, heatSink: 1.4, radiator: 1.12, heatPipe: 3.0, destroyed: 0.12 });
  const BASE_TRANSFER = 18;
  const NETWORK_FRAME_BOOST = 1.7;
  const NETWORK_ATTACHMENT_BOOST = 1.25;
  // A power generator pinned at the overheat failure state for this long melts
  // down and explodes (server: componentHealth.detonateComponent). Shared so
  // the designer's thermal prediction and part inspector stay in sync.
  const REACTOR_MELTDOWN_SECONDS = 3;
  const REACTOR_EXPLOSION_RADIUS = 1.9; // tiles
  const REACTOR_EXPLOSION_DAMAGE = 60;

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function profile(type, part) {
    // Heat sinks are dedicated thermal-mass buffers (large capacity for their
    // cost). Normal system components hold less heat than before so hotspots form
    // and must be conducted away through frames to sinks/radiators.
    const capacity = type === "heatSink" ? 340 : type === "radiator" ? 115 : type === "heatPipe" ? 35
      : type === "armor" ? 125 : type === "compositeArmor" ? 140 : 85;
    const cooling = type === "radiator" ? 14 : type === "heatSink" ? 1.5 : type === "heatPipe" ? 0
      : type === "armor" ? 0.7 : type === "compositeArmor" ? 0.6 : 1.25;
    const conductivity = CONDUCTIVITY[type] ?? (type.includes("Frame") || type === "frame" ? CONDUCTIVITY.frame : CONDUCTIVITY.system);
    return { capacity, cooling, conductivity, retention: type === "armor" ? 0.9 : type === "compositeArmor" ? 0.82 : 1 };
  }

  function activityHeat(type, part) {
    // Per-family heat rates mirror the per-shot heat combat.js actually adds
    // when a weapon fires, so designer predictions and the network-overload
    // flag agree with in-combat heating.
    if (part.weapon) {
      const damage = part.weapon.damage || 1;
      const fireRate = part.weapon.fireRate || 1;
      if (part.weapon.type === "beam") return Math.max(3, Math.sqrt(damage));
      if (part.weapon.type === "railgun") return Math.max(8, Math.sqrt(damage) * 1.8) * fireRate;
      if (part.weapon.type === "pointDefense") return 4 * fireRate;
      return Math.max(5, Math.sqrt(damage) * 1.5) * fireRate;
    }
    if (type === "battery" || type === "capacitor") return 0;
    if ((part.powerGeneration || 0) > 0) return 2 + part.powerGeneration * 0.42;
    if ((part.thrust || 0) > 0) return 2 + part.thrust * 0.018;
    if ((part.shieldRegen || 0) > 0) return part.shieldRegen * 0.7;
    if ((part.repairRate || 0) > 0) return 1.5 + part.repairRate * 0.35;
    return 0;
  }

  function stateFor(ratio, previous) {
    if (previous === STATE.OVERHEATED && ratio >= THRESHOLDS.recover) return STATE.OVERHEATED;
    if (ratio >= THRESHOLDS.overheated) return STATE.OVERHEATED;
    if (ratio >= THRESHOLDS.critical) return STATE.CRITICAL;
    if (ratio >= THRESHOLDS.hot) return STATE.HOT;
    if (ratio >= THRESHOLDS.warm) return STATE.WARM;
    return STATE.NORMAL;
  }

  const ACTIVE_OUTPUT = Object.freeze([1, 1, 0.70, 0.40, 0]);
  const PASSIVE_PROTECTION = Object.freeze([1, 1, 0.85, 0.65, 0.40]);
  const ACTIVE_COOLING = Object.freeze([1, 1, 0.75, 0.50, 0]);

  function multiplierFromTable(table, state) {
    return table[clamp(Number(state) || 0, STATE.NORMAL, STATE.OVERHEATED)] ?? 1;
  }

  function activeOutputForState(state) { return multiplierFromTable(ACTIVE_OUTPUT, state); }
  function passiveProtectionForState(state) { return multiplierFromTable(PASSIVE_PROTECTION, state); }
  function activeCoolingForState(state) { return multiplierFromTable(ACTIVE_COOLING, state); }

  function structuralDamageMultiplierForState(state) {
    return 1 + (1 - passiveProtectionForState(state));
  }

  // Balance metadata is the single classification authority for every armour,
  // frame, bulkhead and mount variant; active systems use other categories.
  function isPassiveStructure(type, part) { return part?.category === "Structure"; }

  // Compatibility alias while older call sites migrate to effect-specific rules.
  function performanceForState(state) { return activeOutputForState(state); }

  function edgeTransfer(aHeat, aCapacity, bHeat, bCapacity, conductivity, sharedEdges, dt) {
    const aRatio = aHeat / Math.max(1, aCapacity);
    const bRatio = bHeat / Math.max(1, bCapacity);
    const raw = (aRatio - bRatio) * BASE_TRANSFER * conductivity * sharedEdges * dt;
    if (raw > 0) return Math.min(raw, aHeat);
    return -Math.min(-raw, bHeat);
  }

  function edgeConductivity(a, b, aAlive = true, bAlive = true) {
    if (!aAlive || !bAlive) return CONDUCTIVITY.destroyed;
    return Math.sqrt(a.conductivity * b.conductivity);
  }

  return Object.freeze({ TICK_SECONDS, STATE, STATE_LABELS, THRESHOLDS, CONDUCTIVITY, NETWORK_FRAME_BOOST, NETWORK_ATTACHMENT_BOOST, REACTOR_MELTDOWN_SECONDS, REACTOR_EXPLOSION_RADIUS, REACTOR_EXPLOSION_DAMAGE, clamp, profile, activityHeat, stateFor, activeOutputForState, passiveProtectionForState, activeCoolingForState, structuralDamageMultiplierForState, isPassiveStructure, performanceForState, edgeTransfer, edgeConductivity });
}));
