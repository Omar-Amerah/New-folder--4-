"use strict";

// The AI blueprint export is deliberately kept as data.  This module is the
// authoritative adapter that turns those saved designs into deployable,
// validated ship profiles and gives every profile a tactical role.

const exportedBlueprints = require("../../aiblueprints.json");
const { DEFAULT_DESIGN } = require("./config");
const { validateDesign } = require("./shipDesign");
const { computeStats } = require("./shipStats");
const { sanitizeCombatStyle } = require("./validation");

const AI_DESIGN_MODES = Object.freeze({
  STANDARD: "standard",
  BETTER: "better"
});

const ROLE_META_BY_ID = Object.freeze({
  dms0x5dfot5hsu: { name: "Railgun Artillery", role: "artillery", combatStyle: "hold" },
  dms0yze63t9yzs: { name: "Drone Defence Carrier", role: "defence", combatStyle: "hold" },
  dms2co00cpdgsp: { name: "Autocannon Interceptor", role: "assault", combatStyle: "charge" },
  dms2d7g548t5il: { name: "Armoured Repair Command", role: "support", combatStyle: "hold" },
  dms2drzktchxp7: { name: "Demolition Runner", role: "demolition", combatStyle: "charge" },
  dms3eem00xz0j0: { name: "Breach Support", role: "capture", combatStyle: "charge" },
  dms3ei90my19r9: { name: "Missile Battleship", role: "siege", combatStyle: "hold" },
  dms3es5y63f4zq: { name: "Beam Siege Cruiser", role: "siege", combatStyle: "hold" },
  dms3fsrermqxja: { name: "Repair Guardian", role: "support", combatStyle: "hold" },
  dms3gana896u9n: { name: "Repair Tender", role: "support", combatStyle: "hold" },
  dms3gq1mxqj05q: { name: "Rapid Repair Scout", role: "support", combatStyle: "kite" },
  dms3j56f1v739t: { name: "Beam Missile Fortress", role: "siege", combatStyle: "hold" },
  dms3q10e10and1: { name: "Heavy Beam Assault", role: "assault", combatStyle: "charge" },
  dms3qcfyztkzz8: { name: "Torpedo Striker", role: "assault", combatStyle: "hold" },
  dms3tox20utsqh: { name: "Drone Artillery", role: "artillery", combatStyle: "hold" },
  dms56pga48xs1l: { name: "Heavy Beam Assault Reserve", role: "assault", combatStyle: "charge" },
  dms6kk26dqc6zl: { name: "Sensor Command Cruiser", role: "recon", combatStyle: "kite" },
  dms6kookujaawe: { name: "Blaster Interceptor", role: "assault", combatStyle: "charge" },
  dms7vzy091zes1: { name: "Sensor Scout", role: "recon", combatStyle: "kite" },
  dmsg8ze9xfxdr5: { name: "Sensor Siege Battleship", role: "recon", combatStyle: "hold" }
});

const ROLE_LABELS = Object.freeze({
  assault: "Assault",
  artillery: "Artillery",
  capture: "Capture",
  defence: "Defence",
  demolition: "Demolition",
  recon: "Recon",
  siege: "Siege",
  support: "Support"
});

function cloneDesign(design) {
  return (Array.isArray(design) ? design : []).map((part) => ({ ...part }));
}

function designSignature(design) {
  return JSON.stringify((Array.isArray(design) ? design : []).map((part) => ({
    x: Number(part?.x),
    y: Number(part?.y),
    type: String(part?.type || ""),
    rotation: Number(part?.rotation) || 0,
    ...(part?.flipped === true ? { flipped: true } : {}),
    ...(part?.droneType ? { droneType: String(part.droneType) } : {})
  })));
}

function freezeBlueprint(blueprint) {
  return Object.freeze({
    ...blueprint,
    design: Object.freeze(cloneDesign(blueprint.design).map((part) => Object.freeze(part))),
    dataLinks: Object.freeze([]),
    stats: Object.freeze({ ...blueprint.stats })
  });
}

function makeBlueprint(entry, sourceIndex, fallbackMeta = {}) {
  const validation = validateDesign(entry?.blueprint);
  if (!validation.ok) return null;

  const design = validation.modules.map((part) => ({ ...part }));
  const stats = computeStats(design);
  const id = String(entry.id || `ai-blueprint-${sourceIndex}`);
  const meta = ROLE_META_BY_ID[id] || fallbackMeta;
  const role = ROLE_LABELS[meta.role] ? meta.role : "assault";
  return freezeBlueprint({
    id,
    sourceIndex,
    name: String(meta.name || entry.name || `AI Blueprint ${sourceIndex + 1}`),
    sourceName: String(entry.name || ""),
    role,
    roleLabel: ROLE_LABELS[role],
    combatStyle: sanitizeCombatStyle(meta.combatStyle || entry.combatStyle, "hold"),
    design,
    stats
  });
}

const standardValidation = validateDesign(DEFAULT_DESIGN);
const STANDARD_BLUEPRINT = freezeBlueprint({
  id: "standard-default",
  sourceIndex: -1,
  name: "Standard Patrol",
  sourceName: "Default design",
  role: "assault",
  roleLabel: ROLE_LABELS.assault,
  combatStyle: "hold",
  // Preserve the legacy stock representation on the player record. Ship
  // creation still normalizes it at the purchase boundary, just as it does
  // for human designs.
  design: cloneDesign(DEFAULT_DESIGN),
  stats: standardValidation.ok ? standardValidation.stats : computeStats(DEFAULT_DESIGN)
});

const AI_BLUEPRINTS = Object.freeze(
  (exportedBlueprints?.payload?.designs || [])
    .map((entry, index) => makeBlueprint(entry, index))
    .filter(Boolean)
);

const BLUEPRINT_BY_SIGNATURE = new Map([
  [designSignature(STANDARD_BLUEPRINT.design), STANDARD_BLUEPRINT],
  ...AI_BLUEPRINTS.map((blueprint) => [designSignature(blueprint.design), blueprint])
]);

function normalizeAiDesignMode(value) {
  return String(value || "").trim().toLowerCase() === AI_DESIGN_MODES.BETTER
    ? AI_DESIGN_MODES.BETTER
    : AI_DESIGN_MODES.STANDARD;
}

function getAiBlueprintPool(mode = AI_DESIGN_MODES.STANDARD) {
  return normalizeAiDesignMode(mode) === AI_DESIGN_MODES.BETTER
    ? AI_BLUEPRINTS
    : [STANDARD_BLUEPRINT];
}

function cloneAiBlueprint(blueprint) {
  if (!blueprint) return null;
  return {
    ...blueprint,
    design: cloneDesign(blueprint.design),
    dataLinks: []
  };
}

function chooseInitialAiBlueprint(mode, sequence = 0, startingMoney = 1000) {
  const pool = getAiBlueprintPool(mode);
  if (pool.length === 1) return cloneAiBlueprint(pool[0]);
  const affordable = pool
    .filter((blueprint) => blueprint.stats.unitCost <= Math.max(0, Number(startingMoney) || 0))
    .sort((a, b) => a.stats.unitCost - b.stats.unitCost || a.sourceIndex - b.sourceIndex);
  const candidates = affordable.length ? affordable : pool;
  return cloneAiBlueprint(candidates[Math.abs(Number(sequence) || 0) % candidates.length]);
}

function blueprintForDesign(design) {
  return BLUEPRINT_BY_SIGNATURE.get(designSignature(design)) || null;
}

module.exports = {
  AI_DESIGN_MODES,
  AI_BLUEPRINTS,
  STANDARD_BLUEPRINT,
  ROLE_LABELS,
  normalizeAiDesignMode,
  getAiBlueprintPool,
  cloneAiBlueprint,
  chooseInitialAiBlueprint,
  blueprintForDesign,
  designSignature
};
