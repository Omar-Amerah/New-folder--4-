// Combat Power-wiring snapshot builders for the selected-ship Power tab.
//
// Two complementary blocks, both derived from ALREADY-authoritative runtime
// state — never a second topology analyser and never a re-derived Power/Heat/
// overload formula:
//
//  * layout  (static, keyed by wiring revision) — enough geometry to draw
//    every installed Power section and Switchgear synthetic edge once.
//  * runtime (dynamic, keyed by power/protection revision) — live flow,
//    utilisation, overload stress, protection state and operational state per
//    section, read straight from the Section 7C solver flows and the Section 7G
//    protection records.
//
// Every emitted number is finite and never NaN, Infinity, undefined or -0.

const PowerProtectionRules = require("../../public/src/shared/powerProtectionRules");
const SwitchgearRules = require("../../public/src/shared/switchgearRules");

const sanitize = PowerProtectionRules.sanitizeNumber;
function round2(value) { return sanitize(Math.round(sanitize(value) * 100) / 100); }
function round3(value) { return sanitize(Math.round(sanitize(value) * 1000) / 1000); }

function powerSectionId(id) { return String(id).startsWith("power:") || String(id).startsWith("switchgear:") ? String(id) : `power:${id}`; }
function sectionNetworkMap(ship) {
  const map = new Map();
  for (const network of (ship.powerFlow && ship.powerFlow.networks) || []) {
    for (const id of network.sectionIds || []) { map.set(String(id), network.id); map.set(powerSectionId(id), network.id); }
  }
  return map;
}

// Static layout: every installed physical Power section (from the immutable
// Blueprint wiring) plus every Switchgear synthetic internal edge (geometry is
// design-static). Disabled identity comes from the runtime topology. Host
// component indices come from the cached hosted-cell authority. Changes only
// when the wiring revision changes.
function buildPowerWiringLayout(ship) {
  const design = Array.isArray(ship.design) ? ship.design : [];
  const disabled = ship.runtimeWiring && ship.runtimeWiring.power && ship.runtimeWiring.power.disabledSectionIds instanceof Set
    ? ship.runtimeWiring.power.disabledSectionIds
    : new Set();
  const hostBySectionId = ship._infrastructureHostMaps && ship._infrastructureHostMaps.power && ship._infrastructureHostMaps.power.bySectionId instanceof Map
    ? ship._infrastructureHostMaps.power.bySectionId
    : new Map();

  const sections = [];
  for (const section of (ship.wiring && ship.wiring.power && ship.wiring.power.sections) || []) {
    const id = String(section.id);
    const hostEntry = hostBySectionId.get(id);
    const hosts = hostEntry
      ? [...new Set((hostEntry.hostCells || []).map((cell) => cell.componentIndex).filter((i) => Number.isInteger(i)))].sort((a, b) => a - b)
      : [];
    sections.push({
      id: powerSectionId(id),
      rawSectionId: id,
      networkType: "power",
      kind: "power-section",
      x1: Math.trunc(sanitize(section.x1)),
      y1: Math.trunc(sanitize(section.y1)),
      x2: Math.trunc(sanitize(section.x2)),
      y2: Math.trunc(sanitize(section.y2)),
      tier: section.tier || "standard",
      hosts,
      operational: !disabled.has(id)
    });
  }

  // Switchgear synthetic internal edges: terminal geometry is design-static, so
  // it belongs in the layout; live conduction is reported in the runtime block.
  for (const record of Array.isArray(ship.runtimeSwitchgear) ? ship.runtimeSwitchgear : []) {
    const module = design[record.componentIndex];
    if (!module) continue;
    const terminals = SwitchgearRules.terminalCells(module);
    sections.push({
      id: String(record.internalEdgeId),
      rawSectionId: String(record.internalEdgeId),
      networkType: "power",
      kind: "switchgear",
      x1: Math.trunc(sanitize(terminals.A.x)),
      y1: Math.trunc(sanitize(terminals.A.y)),
      x2: Math.trunc(sanitize(terminals.B.x)),
      y2: Math.trunc(sanitize(terminals.B.y)),
      tier: record.ratingTier || "standard",
      hosts: [record.componentIndex],
      switchgearIndex: record.componentIndex,
      operational: record.state !== "destroyed"
    });
  }

  sections.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { revision: sanitize(ship.wiringRevision, 0), sections };
}

// Dynamic runtime: live per-section values straight from the authoritative
// Section 7G protection records (which are themselves populated from the
// Section 7C solved section flows). Only operational sections carry a record;
// disabled/non-conducting sections are absent and the client draws them from
// the layout as disabled/broken.
function buildPowerWiringRuntime(ship) {
  const netById = sectionNetworkMap(ship);
  const records = ship._powerProtection && ship._powerProtection.sections instanceof Map
    ? [...ship._powerProtection.sections.values()]
    : [];
  let mostStressedSectionId = null;
  let mostStressedStress = 0;
  const sections = records.map((record) => {
    const stress = PowerProtectionRules.clamp01(record.stress);
    if (stress > mostStressedStress) { mostStressedStress = stress; mostStressedSectionId = powerSectionId(record.sectionId); }
    return {
      id: powerSectionId(record.sectionId),
      rawSectionId: String(record.sectionId),
      networkType: "power",
      signedFlowMw: round2(record.signedFlowMw),
      absoluteFlowMw: round2(record.absoluteFlowMw),
      sustainedCapacityMw: round2(record.sustainedCapacityMw),
      peakCapacityMw: round2(record.peakCapacityMw),
      sustainedUtilisation: round3(record.sustainedUtilisation),
      peakUtilisation: round3(record.peakUtilisation),
      stress: round3(stress),
      secondsAboveSustained: round2(record.secondsAboveSustained),
      state: record.state || "normal",
      operational: record.operational !== false,
      networkId: netById.get(powerSectionId(record.sectionId)) || netById.get(String(record.sectionId)) || null
    };
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { sections, mostStressedSectionId, mostStressedStress: round3(mostStressedStress) };
}

module.exports = { buildPowerWiringLayout, buildPowerWiringRuntime };
