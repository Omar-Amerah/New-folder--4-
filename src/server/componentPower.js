// Authoritative, spawn-time Power allocation for Wiring v2.
//
// The topology is intentionally an intact-blueprint snapshot. Component death
// immediately makes that component inoperable, but source/transit destruction,
// demand removal and redundant-route rebuilding are Phase 5D work. In
// particular, never call initializeComponentPower from the simulation loop.

const { PARTS } = require("./components");
const { analyzeShipPower } = require("./shipDesign");
const { clampNumber } = require("./utils");

const SOURCE_TYPES = new Set(["core", "reactor", "auxiliaryGenerator"]);

function initializeComponentPower(ship) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  let analysis;
  try {
    analysis = analyzeShipPower(design, ship.wiring);
  } catch (_) {
    analysis = { networks: [] };
  }
  const networks = Array.isArray(analysis?.networks) ? analysis.networks : [];
  const membership = new Map();
  for (const network of networks) {
    const generation = Math.max(0, Number(network.generationMw) || 0);
    const demand = Math.max(0, Number(network.demandMw) || 0);
    const efficiency = demand <= 0 ? 1 : clampNumber(generation / demand, 0, 1);
    for (const index of network.consumerIndices || []) {
      if (!membership.has(index)) membership.set(index, { network, generation, efficiency });
    }
    for (const index of network.sourceIndices || []) {
      if (!membership.has(index)) membership.set(index, { network, generation, efficiency });
    }
  }

  const byComponentIndex = design.map((module, index) => {
    const part = PARTS[module.type] || {};
    const live = (ship.componentHp?.[index] ?? 1) > 0;
    const source = SOURCE_TYPES.has(module.type) || (Number(part.powerGeneration) || 0) > 0;
    const consumer = !source && (Number(part.powerUse) || 0) > 0;
    const member = membership.get(index);
    let state = "passive";
    let multiplier = 1;
    if (!live) { state = "destroyed"; multiplier = 0; }
    else if (source) state = "source";
    else if (consumer && (!member || member.generation <= 0)) { state = "disconnected"; multiplier = 0; }
    else if (consumer && member.efficiency < 1) { state = "underpowered"; multiplier = member.efficiency; }
    else if (consumer) state = "powered";
    return {
      state,
      intactState: state,
      networkId: member?.network?.id ?? null,
      availableEfficiency: clampNumber(member?.efficiency ?? (consumer ? 0 : 1), 0, 1),
      operationalMultiplier: clampNumber(multiplier, 0, 1)
    };
  });
  ship.powerAnalysis = analysis;
  ship.componentPower = { byComponentIndex };
  ship.powerStatus = summarizePower(byComponentIndex);
  return ship.componentPower;
}

function getComponentPowerMultiplier(ship, componentIndex) {
  if ((ship?.componentHp?.[componentIndex] ?? 1) <= 0) return 0;
  const value = ship?.componentPower?.byComponentIndex?.[componentIndex]?.operationalMultiplier;
  // Legacy/unit-test ships without wiring state retain their former behaviour;
  // every real spawn initializes componentPower before dependent runtime state.
  return clampNumber(Number.isFinite(value) ? value : 1, 0, 1);
}

function setComponentPowerDestroyed(ship, componentIndex, destroyed) {
  const entry = ship?.componentPower?.byComponentIndex?.[componentIndex];
  if (!entry) return;
  entry.state = destroyed ? "destroyed" : entry.intactState;
  entry.operationalMultiplier = destroyed ? 0 : clampNumber(entry.availableEfficiency, 0, 1);
  if (entry.state === "source" || entry.state === "passive" || entry.state === "powered") entry.operationalMultiplier = 1;
  ship.powerStatus = summarizePower(ship.componentPower.byComponentIndex);
}

function summarizePower(entries) {
  if (entries.some((entry) => entry.state === "disconnected")) return "disconnected";
  if (entries.some((entry) => entry.state === "underpowered")) return "underpowered";
  return "powered";
}

function effectiveShieldStats(ship) {
  let capacity = 0;
  let recharge = 0;
  for (let i = 0; i < (ship.design || []).length; i += 1) {
    if ((ship.componentHp?.[i] ?? 1) <= 0) continue;
    const part = PARTS[ship.design[i].type] || {};
    const power = getComponentPowerMultiplier(ship, i);
    capacity += Math.max(0, Number(part.shield) || 0) * power;
    recharge += Math.max(0, Number(part.shieldRegen) || 0) * power;
  }
  return { capacity: Number.isFinite(capacity) ? capacity : 0, recharge: Number.isFinite(recharge) ? recharge : 0 };
}

module.exports = { initializeComponentPower, getComponentPowerMultiplier, setComponentPowerDestroyed, effectiveShieldStats };
