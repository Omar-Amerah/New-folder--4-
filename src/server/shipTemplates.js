"use strict";

// Immutable ship template system for multi-ship purchases.
// Precomputes design-derived data once per purchase or cached blueprint revision.
// Each spawned ship receives independent mutable runtime arrays and objects.

const { computeStats } = require("./shipStats");
const { createShipBlueprintSnapshot } = require("./shipDesign");
const { PARTS } = require("./components");
const { getOccupiedCells } = require("./footprint");
const { compareIdStrings } = require("./utils");
const EngineExhaustRules = require("../../public/src/shared/engineExhaust.js");
const HeatRules = require("../../public/src/shared/heatRules.js");
const { calculateCenterOfMass } = require("../../public/src/shared/movementStats.js");
const WiringInfrastructureRules = require("../../public/src/shared/wiringInfrastructureRules.js");
const { BALANCE } = require("./balanceConfig");
const { initializeComponentPower, effectiveShieldStats } = require("./componentPower");
const { initShipHeat } = require("./heat");
const { WIRING_ENABLED } = require("../../public/src/shared/featureFlags");

// Template cache keyed by player ID and design revision
const templateCache = new Map();

// Deterministic canonical serialization: recursively sort object keys so that
// reordering keys in the wire payload cannot change the signature, while any
// meaningful value change does. Arrays keep their order (wiring section/
// connection arrays are explicitly sorted below before canonicalization).
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function canonicalBlueprintSignature(design, wiring) {
  const blueprint = createShipBlueprintSnapshot(design, wiring);
  const canonicalKind = (kind) => ({
    sections: kind.sections.map((section) => canonicalize(section)).sort((a, b) => compareIdStrings(a.id, b.id)),
    connections: kind.connections.map((connection) => canonicalize({ ...connection, sectionIds: [...connection.sectionIds] }))
      .sort((a, b) => compareIdStrings(
        `${a.sourceIndex}>${a.targetIndex}:${a.sectionIds.join(";")}`,
        `${b.sourceIndex}>${b.targetIndex}:${b.sectionIds.join(";")}`
      ))
  });
  return canonicalize({
    // Full normalized design parts — every field the normalizer preserves,
    // including droneType, switchgearMode, switchgearRatingTier, and any
    // future component-specific configuration.
    design: blueprint.design.map((part) => canonicalize(part)),
    wiring: {
      version: blueprint.wiring.version,
      power: canonicalKind(blueprint.wiring.power),
      data: canonicalKind(blueprint.wiring.data),
      // Power priority preset + custom priority order (and any future policy).
      powerPolicy: blueprint.wiring.powerPolicy || null
    }
  });
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  // Node.js rejects Object.freeze() for populated typed-array views. Runtime
  // ships clone these buffers, so retaining the template view is safe and
  // avoids sharing mutable per-ship state.
  if (ArrayBuffer.isView(obj)) return obj;
  if (Object.isFrozen(obj)) return obj;
  
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  
  return Object.freeze(obj);
}

function getTemplateKey(playerId, design, wiring, blueprintSignature) {
  // Create a stable key from the complete canonical normalized design and wiring.
  const signature = blueprintSignature || canonicalBlueprintSignature(design, wiring);
  return `${playerId}:${JSON.stringify(signature)}`;
}

function invalidatePlayerTemplates(playerId) {
  for (const key of templateCache.keys()) {
    if (key.startsWith(`${playerId}:`)) {
      templateCache.delete(key);
    }
  }
}

function createImmutableShipTemplate(design, wiring, stats) {
  const blueprint = createShipBlueprintSnapshot(design, wiring);
  const normalizedDesign = blueprint.design;
  const normalizedWiring = blueprint.wiring;
  
  // Precompute component indexes and groups
  const weaponIndices = [];
  const engineIndices = [];
  const droneBayIndices = [];
  const decoyLauncherIndices = [];
  const shieldIndices = [];
  const repairIndices = [];
  
  for (let i = 0; i < normalizedDesign.length; i++) {
    const module = normalizedDesign[i];
    const part = PARTS[module.type] || {};
    
    if (part.weapon) weaponIndices.push(i);
    if (part.category === "Engines" && part.thrust > 0) engineIndices.push(i);
    if (module.type === "droneBay") droneBayIndices.push(i);
    if (part.decoyConfig) decoyLauncherIndices.push(i);
    if (part.shieldRegen > 0) shieldIndices.push(i);
    if (part.repair > 0) repairIndices.push(i);
  }
  
  // Precompute component topology
  const componentCellIndex = new Map();
  for (let i = 0; i < normalizedDesign.length; i++) {
    const module = normalizedDesign[i];
    const part = PARTS[module.type] || PARTS.frame;
    const cells = getOccupiedCells(module.x, module.y, part.footprint || { width: 1, height: 1 }, module.rotation || 0);
    for (const cell of cells) {
      componentCellIndex.set(cell.x * 15 + cell.y, i);
    }
  }
  
  // Precompute engine exhaust analysis
  const alive = normalizedDesign.map(() => true);
  const exhaustAnalysis = EngineExhaustRules.analyze(normalizedDesign, PARTS, { alive });
  
  // Precompute wiring infrastructure accounting
  const infrastructure = BALANCE.wiringInfrastructure;
  const wiringAccounting = WIRING_ENABLED
    ? WiringInfrastructureRules.accountInfrastructure(
      normalizedDesign,
      normalizedWiring,
      PARTS,
      infrastructure
    )
    : { byComponentIndex: normalizedDesign.map(() => ({ powerDisplacement: 0, dataDisplacement: 0 })) };
  
  // Precompute component maximum HP
  const rawHp = normalizedDesign.map((module) => Math.max(1, (PARTS[module.type] || PARTS.frame).hp || 1));
  const rawSum = rawHp.reduce((sum, hp, i) => (normalizedDesign[i].type === "core" ? sum : sum + hp), 0) || 1;
  const scale = (stats?.maxHp || rawSum) / rawSum;
  const componentMaxHp = rawHp.map((hp, i) => (normalizedDesign[i].type === "core" ? (PARTS.core?.hp || 340) : hp * scale));
  
  // Precompute Power infrastructure host maps
  const emptyHostKind = () => ({ bySectionId: new Map(), byComponentIndex: new Map() });
  const infrastructureHostMaps = WIRING_ENABLED
    ? WiringInfrastructureRules.mapHostedCells(normalizedDesign, normalizedWiring, PARTS)
    : { power: emptyHostKind(), data: emptyHostKind() };
  
  // Precompute wiring minimum heat capacity
  const wiringMinimumHeatCapacity = WiringInfrastructureRules.minimumCapacity(infrastructure);
  const componentWiringDisplacement = wiringAccounting.byComponentIndex.map(
    entry => entry.powerDisplacement + entry.dataDisplacement
  );
  
  // Precompute base thermal profiles and capacities
  const componentBaseThermals = normalizedDesign.map((module) =>
    HeatRules.profile(module.type, PARTS[module.type] || {})
  );
  const componentBaseHeatCapacity = componentBaseThermals.map((thermal) => thermal.capacity);
  
  // Precompute component adjacency for thermal networks
  const edgeCounts = normalizedDesign.map(() => new Map());
  for (let i = 0; i < normalizedDesign.length; i++) {
    const module = normalizedDesign[i];
    const footprint = PARTS[module.type]?.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(module.x, module.y, footprint, module.rotation || 0);
    
    for (const cell of cells) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cell.x + dx;
        const ny = cell.y + dy;
        const neighborKey = nx * 15 + ny;
        const neighborIndex = componentCellIndex.get(neighborKey);
        if (neighborIndex !== undefined && neighborIndex !== i) {
          edgeCounts[i].set(neighborIndex, (edgeCounts[i].get(neighborIndex) || 0) + 1);
        }
      }
    }
  }
  
  const componentAdjacency = edgeCounts.map((edges, i) => 
    [...edges].map(([index, sharedEdges]) => ({
      index,
      sharedEdges,
      conductivity: HeatRules.edgeConductivity(
        componentBaseThermals[i],
        componentBaseThermals[index]
      )
    }))
  );

  // Precompute a full-health runtime ship state once per template.
  // spawnShip clones this instead of re-solving Power/Heat for every copy.
  const prebuilt = {
    design: normalizedDesign,
    wiring: normalizedWiring,
    componentMaxHp,
    componentHp: componentMaxHp.slice(),
    componentCellIndex,
    componentStorageCharge: normalizedDesign.map((module) => {
      const part = PARTS[module?.type] || {};
      return Number(part.energyCapacity ?? part.energyStorage ?? part.energy) || 0;
    }),
    _infrastructureHostMaps: {
      power: infrastructureHostMaps.power,
      data: infrastructureHostMaps.data
    },
    stats: { ...stats },
    hp: stats?.maxHp || 0,
    maxHp: stats?.maxHp || 0,
    coreDestroyed: false,
    componentAliveRevision: 1,
    dirtyComponents: new Set(),
    proximityChargeDetonated: normalizedDesign.map(() => 0),
    proximityChargeRevision: 1
  };
  initializeComponentPower(prebuilt);
  initShipHeat(prebuilt);
  const shield = effectiveShieldStats(prebuilt);
  prebuilt.maxShield = Math.max(0, shield.capacity);
  prebuilt.shield = prebuilt.maxShield;
  delete prebuilt.design;
  delete prebuilt.wiring;
  delete prebuilt.stats;
  
  // Create the immutable template
  const template = deepFreeze({
    design: normalizedDesign.map((part) => ({ ...part })),
    wiring: {
      version: normalizedWiring.version,
      power: {
        sections: normalizedWiring.power.sections.map((s) => ({ ...s })),
        connections: normalizedWiring.power.connections.map((c) => ({ ...c }))
      },
      data: {
        sections: normalizedWiring.data.sections.map((s) => ({ ...s })),
        connections: normalizedWiring.data.connections.map((c) => ({ ...c }))
      },
      powerPolicy: normalizedWiring.powerPolicy ? { ...normalizedWiring.powerPolicy } : null
    },
    stats: { ...stats },
    weaponIndices,
    engineIndices,
    droneBayIndices,
    decoyLauncherIndices,
    shieldIndices,
    repairIndices,
    componentCellIndex,
    exhaustAnalysis,
    componentMaxHp,
    infrastructureHostMaps: {
      power: infrastructureHostMaps.power,
      data: infrastructureHostMaps.data
    },
    wiringMinimumHeatCapacity,
    componentWiringDisplacement,
    componentBaseHeatCapacity,
    componentAdjacency,
    radius: stats?.radius || 0,
    unitCost: stats?.unitCost || 0,
    maxHp: stats?.maxHp || 0,
    prebuiltShipState: prebuilt
  });
  
  return template;
}

function getOrCreateTemplate(playerId, design, wiring, stats, blueprintSignature) {
  const key = getTemplateKey(playerId, design, wiring, blueprintSignature);
  let template = templateCache.get(key);

  if (!template) {
    template = createImmutableShipTemplate(design, wiring, stats);
    templateCache.set(key, template);
    
    // Limit cache size
    if (templateCache.size > 128) {
      const oldestKey = templateCache.keys().next().value;
      templateCache.delete(oldestKey);
    }
  }
  
  return template;
}

function clearTemplateCache() {
  templateCache.clear();
}

module.exports = {
  getOrCreateTemplate,
  invalidatePlayerTemplates,
  clearTemplateCache,
  createImmutableShipTemplate,
  canonicalBlueprintSignature,
  canonicalize
};
