(function initHeatRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.HeatRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeHeatRules() {
  "use strict";

  const TICK_SECONDS = 0.2;
  const STATE = Object.freeze({ NORMAL: 0, WARM: 1, HOT: 2, CRITICAL: 3, OVERHEATED: 4 });
  const STATE_LABELS = Object.freeze(["Cool", "Warm", "Hot", "Critical", "Overheated"]);
  const THRESHOLDS = Object.freeze({ warm: 0.42, hot: 0.68, critical: 0.86, overheated: 1 });
  // Downward hysteresis keeps tiny cooling/heating oscillations at boundaries
  // from flipping operational state every thermal tick. Upward thresholds above
  // remain the authoritative balance contract.
  const HYSTERESIS = Object.freeze({ warm: 0.03, hot: 0.03, critical: 0.03, overheated: 0.38 });
  // Wrecks retain heat and can exchange it with immediately adjacent material,
  // but this deliberately small coefficient cannot bridge a routed network.
  const CONDUCTIVITY = Object.freeze({ frame: 2.1, system: 0.72, armor: 0.48, compositeArmor: 0.28, heatSink: 1.4, radiator: 1.12, heatPipe: 3.0, destroyed: 0.12 });
  const BASE_TRANSFER = 18;
  const NETWORK_FRAME_BOOST = 1.7;
  const NETWORK_ATTACHMENT_BOOST = 1.25;
  // Edge-type transfer multipliers: replace the old two-tier frame/attachment
  // boost with granular per-edge-type factors. Heat Pipe edges transfer heat
  // significantly faster than Frame edges, but the product is never compounded
  // more than once — routeTypeMultiplier returns a single value for the edge.
  const HEAT_PIPE_TRANSFER = Object.freeze({
    frameToFrame: 1.7,
    frameToComponent: 1.25,
    frameToHeatPipe: 1.7,
    heatPipeToComponent: 2.0,
    heatPipeToHeatPipe: 2.5,
    heatPipeToHeatSink: 2.25,
    heatPipeToRadiator: 2.5,
    heatPipeToClosedCycleCooler: 2.25
  });
  // Soft cap on shared-edge count so a large multi-cell component does not get
  // an unreasonable multiplier from many shared edges.
  const MAX_SHARED_EDGE_MULTIPLIER = 3;
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
    const capacity = Number.isFinite(part?.heatCapacity) ? part.heatCapacity
      : type === "heatSink" ? 340 : type === "radiator" ? 115 : type === "heatPipe" ? 35
      : type === "armor" ? 125 : type === "compositeArmor" ? 140 : 85;
    const cooling = Number.isFinite(part?.heatCooling) ? part.heatCooling
      : type === "radiator" ? 14 : type === "heatSink" ? 1.5 : type === "heatPipe" ? 0
      : type === "armor" ? 0.7 : type === "compositeArmor" ? 0.6 : 1.25;
    const passiveCooling = Number.isFinite(part?.heatPassiveCooling) ? part.heatPassiveCooling : 0;
    const conductivity = Number.isFinite(part?.heatConductivity) ? part.heatConductivity
      : (CONDUCTIVITY[type] ?? (type.includes("Frame") || type === "frame" ? CONDUCTIVITY.frame : CONDUCTIVITY.system));
    const retention = Number.isFinite(part?.heatRetention) ? part.heatRetention
      : type === "armor" ? 0.9 : type === "compositeArmor" ? 0.82 : 1;
    return { capacity, cooling, passiveCooling, conductivity, retention };
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
    if (Number.isFinite(Number(part.activityHeat)) && Number(part.activityHeat) > 0) return Number(part.activityHeat);
    if (type === "battery" || type === "capacitor") return 0;
    if ((part.powerGeneration || 0) > 0) return 2 + part.powerGeneration * 0.42;
    if ((part.thrust || 0) > 0) return 2 + part.thrust * 0.018;
    if ((part.lateralThrust || 0) > 0) return 2 + part.lateralThrust * 0.018;
    if ((part.turn || 0) > 0) return 2 + part.turn * 1.5;
    if ((part.shieldRegen || 0) > 0) return part.shieldRegen * 0.7;
    if ((part.repairRate || 0) > 0) return 1.5 + part.repairRate * 0.35;
    return 0;
  }

  function stateFor(ratio, previous) {
    const value = Number.isFinite(ratio) ? ratio : (ratio === Infinity ? Infinity : 0);
    const prior = Number.isInteger(previous) ? previous : STATE.NORMAL;
    if (prior >= STATE.OVERHEATED && value >= THRESHOLDS.overheated - HYSTERESIS.overheated) return STATE.OVERHEATED;
    if (value >= THRESHOLDS.overheated) return STATE.OVERHEATED;
    if (prior >= STATE.CRITICAL && value >= THRESHOLDS.critical - HYSTERESIS.critical) return STATE.CRITICAL;
    if (value >= THRESHOLDS.critical) return STATE.CRITICAL;
    if (prior >= STATE.HOT && value >= THRESHOLDS.hot - HYSTERESIS.hot) return STATE.HOT;
    if (value >= THRESHOLDS.hot) return STATE.HOT;
    if (prior >= STATE.WARM && value >= THRESHOLDS.warm - HYSTERESIS.warm) return STATE.WARM;
    if (value >= THRESHOLDS.warm) return STATE.WARM;
    return STATE.NORMAL;
  }

  const ACTIVE_OUTPUT = Object.freeze([1, 1, 0.70, 0.40, 0]);
  const PASSIVE_PROTECTION = Object.freeze([1, 1, 0.85, 0.65, 0.40]);
  const ACTIVE_COOLING = Object.freeze([1, 1, 0.75, 0.50, 0]);

  // Radiator-specific exposure and passive-floor rules.  These are the single
  // authoritative source for both the server runtime (heat.js) and the Fleet
  // Ledger article generation.  Do not duplicate these literals elsewhere.
  const RADIATOR_EXPOSED_MULTIPLIER = 1;
  const RADIATOR_ENCLOSED_MULTIPLIER = 0.25;
  const RADIATOR_PASSIVE_COOLING_FRACTION = 0.12;
  const RADIATOR_ACTIVE_COOLING_BY_STATE = Object.freeze({
    normal: ACTIVE_COOLING[0],
    warm: ACTIVE_COOLING[1],
    hot: ACTIVE_COOLING[2],
    critical: ACTIVE_COOLING[3],
    overheated: ACTIVE_COOLING[4]
  });

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

  function effectiveSharedEdges(sharedEdges) {
    return Math.min(sharedEdges, MAX_SHARED_EDGE_MULTIPLIER);
  }

  // Returns the edge-type transfer multiplier for a pair of component types.
  // Only one multiplier is applied per edge — never compounded.
  function routeTypeMultiplier(typeA, typeB) {
    const aIsPipe = String(typeA || "") === "heatPipe";
    const bIsPipe = String(typeB || "") === "heatPipe";
    const aIsFrame = /frame/i.test(String(typeA || ""));
    const bIsFrame = /frame/i.test(String(typeB || ""));
    if (aIsPipe && bIsPipe) return HEAT_PIPE_TRANSFER.heatPipeToHeatPipe;
    if (aIsPipe || bIsPipe) {
      const other = aIsPipe ? typeB : typeA;
      if (String(other || "") === "heatSink") return HEAT_PIPE_TRANSFER.heatPipeToHeatSink;
      if (String(other || "") === "radiator") return HEAT_PIPE_TRANSFER.heatPipeToRadiator;
      if (String(other || "") === "closedCycleCooler") return HEAT_PIPE_TRANSFER.heatPipeToClosedCycleCooler;
      if (/frame/i.test(String(other || ""))) return HEAT_PIPE_TRANSFER.frameToHeatPipe;
      return HEAT_PIPE_TRANSFER.heatPipeToComponent;
    }
    if (aIsFrame && bIsFrame) return HEAT_PIPE_TRANSFER.frameToFrame;
    if (aIsFrame || bIsFrame) return HEAT_PIPE_TRANSFER.frameToComponent;
    return 1.0;
  }

  function edgeTransfer(aHeat, aCapacity, bHeat, bCapacity, conductivity, sharedEdges, dt) {
    const aRatio = aHeat / Math.max(1, aCapacity);
    const bRatio = bHeat / Math.max(1, bCapacity);
    const edgeCount = effectiveSharedEdges(sharedEdges);
    const raw = (aRatio - bRatio) * BASE_TRANSFER * conductivity * edgeCount * dt;
    if (raw > 0) return Math.min(raw, aHeat);
    return -Math.min(-raw, bHeat);
  }

  function edgeConductivity(a, b, aAlive = true, bAlive = true) {
    if (!aAlive || !bAlive) return CONDUCTIVITY.destroyed;
    return Math.sqrt(a.conductivity * b.conductivity);
  }

  return Object.freeze({ TICK_SECONDS, STATE, STATE_LABELS, THRESHOLDS, HYSTERESIS, CONDUCTIVITY, NETWORK_FRAME_BOOST, NETWORK_ATTACHMENT_BOOST, HEAT_PIPE_TRANSFER, MAX_SHARED_EDGE_MULTIPLIER, REACTOR_MELTDOWN_SECONDS, REACTOR_EXPLOSION_RADIUS, REACTOR_EXPLOSION_DAMAGE, RADIATOR_EXPOSED_MULTIPLIER, RADIATOR_ENCLOSED_MULTIPLIER, RADIATOR_PASSIVE_COOLING_FRACTION, RADIATOR_ACTIVE_COOLING_BY_STATE, clamp, profile, activityHeat, stateFor, activeOutputForState, passiveProtectionForState, activeCoolingForState, structuralDamageMultiplierForState, isPassiveStructure, performanceForState, edgeTransfer, edgeConductivity, routeTypeMultiplier, effectiveSharedEdges });
}));
