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
  const CONDUCTIVITY = Object.freeze({ frame: 2.1, system: 0.72, armor: 0.48, compositeArmor: 0.28, heatSink: 1.4, radiator: 1.12, heatVent: 1.0, heatPipe: 3.0, destroyed: 0.12 });
  const BASE_TRANSFER = 18;
  // Soft cap on shared-edge count so a large multi-cell component does not get
  // an unreasonable multiplier from many shared edges.
  const MAX_SHARED_EDGE_MULTIPLIER = 3;

  // Structural shapes are separate catalogue components, but they are still
  // made from one of these five canonical materials. Keep this mapping exact:
  // shape names are data identifiers, not material classification heuristics.
  const STRUCTURAL_THERMAL_MATERIAL_BY_TYPE = Object.freeze({
    frame: "frame",
    halfFrameDiagonal: "frame",
    wingFrame: "frame",
    bevelFrame: "frame",
    roundedFrame: "frame",
    longWedgeFrame: "frame",
    armor: "armor",
    halfArmorDiagonal: "armor",
    wingArmor: "armor",
    bevelArmor: "armor",
    roundedArmor: "armor",
    longWedgeArmor: "armor",
    compositeArmor: "compositeArmor",
    halfCompositeArmorDiagonal: "compositeArmor",
    wingCompositeArmor: "compositeArmor",
    bevelCompositeArmor: "compositeArmor",
    roundedCompositeArmor: "compositeArmor",
    longWedgeCompositeArmor: "compositeArmor",
    ablativeArmor: "ablativeArmor",
    halfAblativeArmorDiagonal: "ablativeArmor",
    wingAblativeArmor: "ablativeArmor",
    bevelAblativeArmor: "ablativeArmor",
    roundedAblativeArmor: "ablativeArmor",
    longWedgeAblativeArmor: "ablativeArmor",
    refractoryArmor: "refractoryArmor",
    halfRefractoryArmorDiagonal: "refractoryArmor",
    wingRefractoryArmor: "refractoryArmor",
    bevelRefractoryArmor: "refractoryArmor",
    roundedRefractoryArmor: "refractoryArmor",
    longWedgeRefractoryArmor: "refractoryArmor"
  });

  // These are the existing base-material results of profile(). Quantities of
  // material scale with statScale; conductivity and retention describe the
  // material itself and therefore do not scale with a shape's size.
  const STRUCTURAL_THERMAL_PROFILES = Object.freeze({
    frame: Object.freeze({ capacity: 85, cooling: 1.25, passiveCooling: 0, conductivity: CONDUCTIVITY.frame, retention: 1 }),
    armor: Object.freeze({ capacity: 125, cooling: 0.7, passiveCooling: 0, conductivity: CONDUCTIVITY.armor, retention: 0.9 }),
    compositeArmor: Object.freeze({ capacity: 140, cooling: 0.6, passiveCooling: 0, conductivity: CONDUCTIVITY.compositeArmor, retention: 0.82 }),
    // Ablative Plating currently uses the ordinary-system thermal baseline;
    // naming it explicitly here makes its variants scale that baseline instead
    // of accidentally treating each shape as a standalone generic component.
    ablativeArmor: Object.freeze({ capacity: 85, cooling: 1.25, passiveCooling: 0, conductivity: CONDUCTIVITY.system, retention: 1 }),
    refractoryArmor: Object.freeze({ capacity: 460, cooling: 2.4, passiveCooling: 0, conductivity: 0.9, retention: 1.2 })
  });

  // Legacy frame-like identifiers are retained as exact entries for the
  // non-catalogue fallback path. This replaces the old case-sensitive
  // substring test without changing those components' conductivity.
  const FRAME_CONDUCTIVITY_TYPES = new Set(["frame", "lightFrame", "heavyFrame"]);

  // --- Coolant transport network ---------------------------------------------
  //
  // Every connected group of living Heat Pipes is one coolant network. Pipes are
  // transport only: they remove no heat and store almost none. Attachment is
  // automatic : any living component sharing an orthogonal tile edge with a pipe
  // in the network exchanges heat with that network's coolant. There is no
  // rotation, port or direction to configure; flow direction falls out of the
  // participants' relative heat ratios.
  //
  // The network deliberately does NOT behave as one averaged body holding every
  // attached component's heat capacity. Each participant : every attachment plus
  // the pipe tiles themselves as a single node : is coupled to the coolant by a
  // conductance derived from how many tile edges it shares with the network. The
  // coolant settles at the conductance-weighted mean of the participants' heat
  // ratios and each participant moves toward it, so the flows sum to zero and
  // the network conserves heat exactly.
  //
  // Three independent limits keep transport finite:
  //   COOLANT_CONDUCTANCE          heat/second moved per unit of ratio gap
  //   COOLANT_ATTACHMENT_BANDWIDTH hard per-shared-edge throughput ceiling
  //   COOLANT_MAX_APPROACH         a participant may close at most this fraction
  //                                of its gap in one step, which keeps the solve
  //                                stable at any heat capacity and rules out
  //                                ping-pong oscillation between two attachments
  const COOLANT_CONDUCTANCE = 90;
  const COOLANT_ATTACHMENT_BANDWIDTH = 40;
  const COOLANT_MAX_APPROACH = 0.5;
  // A power generator pinned at the overheat failure state for this long melts
  // down and explodes (server: componentHealth.detonateComponent). Shared so
  // the designer's thermal prediction and part inspector stay in sync.
  const REACTOR_MELTDOWN_SECONDS = 3;
  const REACTOR_EXPLOSION_RADIUS = 1.9; // tiles
  const REACTOR_EXPLOSION_DAMAGE = 60;

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function structuralThermalMaterial(type) {
    return Object.prototype.hasOwnProperty.call(STRUCTURAL_THERMAL_MATERIAL_BY_TYPE, type)
      ? STRUCTURAL_THERMAL_MATERIAL_BY_TYPE[type]
      : null;
  }

  function structuralThermalProfile(type, part) {
    const material = structuralThermalMaterial(type);
    const base = material ? STRUCTURAL_THERMAL_PROFILES[material] : null;
    if (!base) return null;
    const statScale = Number.isFinite(Number(part?.statScale)) ? Number(part.statScale) : 1;
    return {
      capacity: base.capacity * statScale,
      cooling: base.cooling * statScale,
      passiveCooling: base.passiveCooling * statScale,
      conductivity: base.conductivity,
      retention: base.retention
    };
  }

  function profile(type, part) {
    const structural = structuralThermalProfile(type, part);
    if (structural) return structural;

    // Heat sinks are dedicated thermal-mass buffers (large capacity for their
    // cost). Normal system components hold less heat than before so hotspots form
    // and must be conducted away through frames to sinks/radiators.
    const capacity = Number.isFinite(part?.heatCapacity) ? part.heatCapacity
      : type === "heatSink" ? 340 : type === "radiator" ? 115 : type === "heatPipe" ? 10
      : type === "heatVent" ? 45
      : type === "armor" ? 125 : type === "compositeArmor" ? 140 : 85;
    const cooling = Number.isFinite(part?.heatCooling) ? part.heatCooling
      : type === "radiator" ? 14 : type === "heatSink" ? 1.5 : type === "heatPipe" ? 0
      : type === "heatVent" ? 4
      : type === "armor" ? 0.7 : type === "compositeArmor" ? 0.6 : 1.25;
    const passiveCooling = Number.isFinite(part?.heatPassiveCooling) ? part.heatPassiveCooling : 0;
    const conductivity = Number.isFinite(part?.heatConductivity) ? part.heatConductivity
      : (CONDUCTIVITY[type] ?? (FRAME_CONDUCTIVITY_TYPES.has(type) ? CONDUCTIVITY.frame : CONDUCTIVITY.system));
    const retention = Number.isFinite(part?.heatRetention) ? part.heatRetention
      : type === "armor" ? 0.9 : type === "compositeArmor" ? 0.82 : 1;
    return { capacity, cooling, passiveCooling, conductivity, retention };
  }

  function activityHeat(type, part) {
    const value = Number(part?.activityHeat);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function heatPerShot(type, part) {
    const value = Number(part?.heatPerShot);
    return Number.isFinite(value) && value > 0 ? value : 0;
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

  // Radiator-specific exposure rules. These are the single authoritative source
  // for both the server runtime (heat.js) and the Fleet Ledger article generation.
  // Do not duplicate these literals elsewhere.
  const RADIATOR_EXPOSED_MULTIPLIER = 1;
  const RADIATOR_ENCLOSED_MULTIPLIER = 0.25;
  // Heat Vent exposure. A Vent is a bare hull grille: with no opening to space
  // it has nowhere to reject heat, so an enclosed Vent is very nearly inert.
  // Exposure is binary on purpose : extra exposed edges add nothing, so there is
  // no reward for carving a checkerboard hull.
  const HEAT_VENT_EXPOSED_MULTIPLIER = 1;
  const HEAT_VENT_ENCLOSED_MULTIPLIER = 0.05;
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

  // Only Heat Pipes form a coolant transport network. Frames still conduct heat
  // to their immediate neighbours through the physical edge model below, but a
  // chain of frames is no longer a substitute for a dedicated coolant run.
  function isCoolantTransportType(type) {
    return String(type || "") === "heatPipe";
  }

  function coolantEdgeConductance(sharedEdges) {
    return COOLANT_CONDUCTANCE * effectiveSharedEdges(Math.max(1, Number(sharedEdges) || 1));
  }

  function coolantEdgeBandwidth(sharedEdges) {
    return COOLANT_ATTACHMENT_BANDWIDTH * effectiveSharedEdges(Math.max(1, Number(sharedEdges) || 1));
  }

  /**
   * Solve one timestep of coolant transport for a single Heat Pipe network.
   * @param {Array<{heat:number,capacity:number,conductance:number,bandwidth:number}>} participants
   *   Every attachment plus the pipe tiles as one node, in a deterministic order.
   * @param {number} dt Timestep in seconds.
   * @returns {number[]} Signed heat deltas per participant. They sum to exactly
   *   zero: the network transports heat, it never creates or removes any.
   */
  function solveCoolantNetwork(participants, dt) {
    const count = Array.isArray(participants) ? participants.length : 0;
    const deltas = new Array(count).fill(0);
    if (count < 2 || !(dt > 0)) return deltas;

    let totalConductance = 0;
    let weightedRatio = 0;
    const ratios = new Array(count);
    for (let i = 0; i < count; i += 1) {
      const capacity = Math.max(1, Number(participants[i].capacity) || 0);
      const conductance = Math.max(0, Number(participants[i].conductance) || 0);
      ratios[i] = Math.max(0, Number(participants[i].heat) || 0) / capacity;
      totalConductance += conductance;
      weightedRatio += conductance * ratios[i];
    }
    if (!(totalConductance > 0)) return deltas;
    const coolantRatio = weightedRatio / totalConductance;

    const sources = [];
    const sinks = [];
    let supply = 0;
    let demand = 0;
    for (let i = 0; i < count; i += 1) {
      const gap = ratios[i] - coolantRatio;
      if (gap === 0) continue;
      const capacity = Math.max(1, Number(participants[i].capacity) || 0);
      const conductance = Math.max(0, Number(participants[i].conductance) || 0);
      const bandwidth = Math.max(0, Number(participants[i].bandwidth) || 0);
      const magnitude = Math.min(
        Math.abs(gap) * conductance * dt,
        bandwidth * dt,
        Math.abs(gap) * capacity * COOLANT_MAX_APPROACH
      );
      if (!(magnitude > 0)) continue;
      if (gap > 0) {
        const give = Math.min(magnitude, Math.max(0, Number(participants[i].heat) || 0));
        if (give > 0) { sources.push({ index: i, amount: give }); supply += give; }
      } else {
        sinks.push({ index: i, amount: magnitude });
        demand += magnitude;
      }
    }

    // Pipes bank almost nothing, so the network cannot hold a surplus: whichever
    // side has more to move is scaled down to what the other side can take.
    const moved = Math.min(supply, demand);
    if (!(moved > 0)) return deltas;
    let assigned = 0;
    for (let k = 0; k < sources.length; k += 1) {
      const share = k === sources.length - 1 ? moved - assigned : moved * (sources[k].amount / supply);
      assigned += share;
      deltas[sources[k].index] = -share;
    }
    assigned = 0;
    for (let k = 0; k < sinks.length; k += 1) {
      const share = k === sinks.length - 1 ? moved - assigned : moved * (sinks[k].amount / demand);
      assigned += share;
      deltas[sinks[k].index] = share;
    }
    return deltas;
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

  return Object.freeze({ TICK_SECONDS, STATE, STATE_LABELS, THRESHOLDS, HYSTERESIS, CONDUCTIVITY, MAX_SHARED_EDGE_MULTIPLIER, STRUCTURAL_THERMAL_MATERIAL_BY_TYPE, STRUCTURAL_THERMAL_PROFILES, COOLANT_CONDUCTANCE, COOLANT_ATTACHMENT_BANDWIDTH, COOLANT_MAX_APPROACH, REACTOR_MELTDOWN_SECONDS, REACTOR_EXPLOSION_RADIUS, REACTOR_EXPLOSION_DAMAGE, RADIATOR_EXPOSED_MULTIPLIER, RADIATOR_ENCLOSED_MULTIPLIER, RADIATOR_ACTIVE_COOLING_BY_STATE, HEAT_VENT_EXPOSED_MULTIPLIER, HEAT_VENT_ENCLOSED_MULTIPLIER, clamp, structuralThermalMaterial, structuralThermalProfile, profile, activityHeat, heatPerShot, stateFor, activeOutputForState, passiveProtectionForState, activeCoolingForState, structuralDamageMultiplierForState, isPassiveStructure, performanceForState, edgeTransfer, edgeConductivity, effectiveSharedEdges, isCoolantTransportType, coolantEdgeConductance, coolantEdgeBandwidth, solveCoolantNetwork });
}));
