// Load component definitions, lookup parts by id, and validate known component types.

const fs = require("fs");
const { COMPONENT_BALANCE_PATH } = require("./config");

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function calculateDps(weapon) {
  return (weapon.damage * weapon.fireRate);
}

function calculateReload(weapon) {
  return 1000 / weapon.fireRate;
}

function makeWeapon(type, stats) {
  const fireRate = Number(stats.fireRate) || 1;
  const damage = Number(stats.damage) || 0;
  
  let tracking = stats.tracking || 0;
  let aimSpeed = stats.aimSpeed;
  if (type === "beam") {
    if (stats.tracking && !stats.aimSpeed) {
      aimSpeed = 1.65;
    }
    tracking = 0; // beam weapons do not have tracking
  }

  return {
    type,
    damage,
    fireRate,
    reload: calculateReload({ fireRate }),
    range: stats.range,
    radius: Number(stats.radius) || 0,
    projectileSpeed: stats.projectileSpeed,
    accuracy: stats.accuracy,
    tracking: tracking,
    trackTime: Number(stats.trackTime) || 0,
    trackingDelay: Number(stats.trackingDelay) || 0,
    aimSpeed: aimSpeed !== undefined ? Number(aimSpeed) : undefined,
    arc: Number(stats.arc) || 360,
    dps: calculateDps({ damage, fireRate }),
    missileHp: Number(stats.missileHp) || 0,
    antiMissile: Boolean(stats.antiMissile),
    shipDamageMultiplier: Number(stats.shipDamageMultiplier) || 1,
    targetPriority: stats.targetPriority || [],
    shieldDamageMultiplier: Number(stats.shieldDamageMultiplier ?? 1),
    hullDamageMultiplier: Number(stats.hullDamageMultiplier ?? 1)
  };
}

const FALLBACK_PARTS = Object.freeze({
  // Existing basics
  core: {
    cost: 0, mass: 8, hp: 150,
    powerGeneration: 4, powerUse: 0,
    shield: 25, shieldRegen: 0.4,
    thrust: 0, turn: 0,
    energyStorage: 80, repairRate: 0,
    weapon: null
  },

  frame: {
    cost: 3, mass: 2, hp: 42,
    powerGeneration: 0, powerUse: 0,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: 0.005,
    energyStorage: 0, repairRate: 0,
    weapon: null
  },

  armor: {
    cost: 11, mass: 8, hp: 125,
    powerGeneration: 0, powerUse: 0,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.045,
    energyStorage: 0, repairRate: 0,
    armorFlatReduction: 5,
    weapon: null
  },

  engine: {
    cost: 16, mass: 4, hp: 48,
    powerGeneration: 0, powerUse: 1.2,
    shield: 0, shieldRegen: 0,
    thrust: 130, turn: 0.22,
    energyStorage: 0, repairRate: 0,
    weapon: null
  },

  reactor: {
    cost: 22, mass: 6, hp: 58,
    powerGeneration: 9, powerUse: 0,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: 0,
    energyStorage: 30, repairRate: 0,
    weapon: null
  },

  battery: {
    cost: 14, mass: 3, hp: 42,
    powerGeneration: 0, powerUse: 0,
    shield: 36, shieldRegen: 0.55,
    thrust: 0, turn: 0,
    energyStorage: 165, repairRate: 0,
    weapon: null
  },

  shield: {
    cost: 20, mass: 5, hp: 46,
    powerGeneration: 0, powerUse: 3.2,
    shield: 105, shieldRegen: 2.1,
    thrust: 0, turn: -0.015,
    energyStorage: 0, repairRate: 0,
    weapon: null
  },

  blaster: {
    cost: 27, mass: 5, hp: 46,
    powerGeneration: 0, powerUse: 2.2,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.025,
    energyStorage: 0, repairRate: 0,
    blaster: 1,
    weapon: makeWeapon("blaster", {
      damage: 13,
      fireRate: 1.5,
      range: 500,
      projectileSpeed: 650,
      accuracy: 0.87,
      tracking: 0,
      arc: 120,
      shieldDamageMultiplier: 1.0,
      hullDamageMultiplier: 1.0
    })
  },

  missile: {
    cost: 38, mass: 7, hp: 50,
    powerGeneration: 0, powerUse: 3.4,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.035,
    energyStorage: 0, repairRate: 0,
    missile: 1,
    weapon: makeWeapon("missile", {
      damage: 60,
      fireRate: 0.28,
      range: 790,
      projectileSpeed: 320,
      accuracy: 0.7,
      tracking: 0.7,
      trackTime: 1.5,
      trackingDelay: 0.25,
      arc: 220,
      shieldDamageMultiplier: 1.0,
      hullDamageMultiplier: 1.0
    })
  },

  railgun: {
    cost: 50, mass: 9, hp: 54,
    powerGeneration: 0, powerUse: 6.5,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.06,
    energyStorage: 0, repairRate: 0,
    railgun: 1,
    weapon: makeWeapon("railgun", {
      damage: 100,
      fireRate: 0.18,
      range: 1060,
      projectileSpeed: 1080,
      accuracy: 0.95,
      tracking: 0,
      arc: 45,
      shieldDamageMultiplier: 0.65,
      hullDamageMultiplier: 1.35
    })
  },

  repair: {
    category: "Support",
    cost: 26, mass: 5, hp: 48,
    powerGeneration: 0, powerUse: 2.4,
    shield: 16, shieldRegen: 0.25,
    thrust: 0, turn: -0.015,
    energyStorage: 0, repairRate: 5,
    repair: 1,
    weapon: null
  },

  // Structure
  lightFrame: {
    category: "Structure",
    cost: 2, mass: 1, hp: 22,
    powerGeneration: 0, powerUse: 0,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: 0.015,
    energyStorage: 0, repairRate: 0,
    weapon: null
  },

  heavyFrame: {
    category: "Structure",
    cost: 7, mass: 5, hp: 82,
    powerGeneration: 0, powerUse: 0,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.025,
    energyStorage: 0, repairRate: 0,
    weapon: null
  },

  compositeArmor: {
    category: "Structure",
    cost: 18, mass: 5, hp: 95,
    powerGeneration: 0, powerUse: 0,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.025,
    energyStorage: 0, repairRate: 0,
    armorFlatReduction: 3.5,
    weapon: null
  },

  bulkhead: {
    category: "Structure",
    cost: 32, mass: 15, hp: 185,
    powerGeneration: 0, powerUse: 0,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.11,
    energyStorage: 0, repairRate: 0,
    weapon: null
  },

  lightMount: {
    category: "Structure",
    cost: 5, mass: 2, hp: 32,
    powerGeneration: 0, powerUse: 0,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: 0.005,
    energyStorage: 0, repairRate: 0,
    weapon: null
  },

  heavyMount: {
    category: "Structure",
    cost: 14, mass: 6, hp: 78,
    powerGeneration: 0, powerUse: 0,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.035,
    energyStorage: 0, repairRate: 0,
    weapon: null
  },

  // Power
  smallReactor: {
    category: "Power",
    cost: 14, mass: 3, hp: 34,
    powerGeneration: 5, powerUse: 0,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: 0,
    energyStorage: 12, repairRate: 0,
    weapon: null
  },

  heavyReactor: {
    category: "Power",
    cost: 48, mass: 13, hp: 88,
    powerGeneration: 18, powerUse: 0,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.04,
    energyStorage: 50, repairRate: 0,
    weapon: null
  },

  capacitor: {
    category: "Power",
    cost: 34, mass: 9, hp: 62,
    powerGeneration: 0, powerUse: 0,
    shield: 48, shieldRegen: 0.2,
    thrust: 0, turn: -0.025,
    energyStorage: 360, repairRate: 0,
    weapon: null
  },

  auxGenerator: {
    category: "Power",
    cost: 11, mass: 2, hp: 24,
    powerGeneration: 3, powerUse: 0,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: 0,
    energyStorage: 6, repairRate: 0,
    weapon: null
  },

  // Engines
  microThruster: {
    category: "Engines",
    cost: 8, mass: 1, hp: 20,
    powerGeneration: 0, powerUse: 0.5,
    shield: 0, shieldRegen: 0,
    thrust: 42, turn: 0.1,
    energyStorage: 0, repairRate: 0,
    weapon: null,
    rotationRequired: true
  },

  heavyEngine: {
    category: "Engines",
    cost: 38, mass: 11, hp: 78,
    powerGeneration: 0, powerUse: 4.4,
    shield: 0, shieldRegen: 0,
    thrust: 310, turn: 0.06,
    energyStorage: 0, repairRate: 0,
    weapon: null,
    rotationRequired: true
  },

  maneuverThruster: {
    category: "Engines",
    cost: 20, mass: 3, hp: 38,
    powerGeneration: 0, powerUse: 1.7,
    shield: 0, shieldRegen: 0,
    thrust: 60, turn: 0.38,
    energyStorage: 0, repairRate: 0,
    weapon: null,
    rotationRequired: true
  },

  gyroscope: {
    category: "Engines",
    cost: 28, mass: 5, hp: 42,
    powerGeneration: 0, powerUse: 2.8,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: 0.5,
    energyStorage: 0, repairRate: 0,
    weapon: null
  },

  // Defence
  lightShield: {
    category: "Defence",
    cost: 12, mass: 2, hp: 28,
    powerGeneration: 0, powerUse: 1.4,
    shield: 42, shieldRegen: 0.9,
    thrust: 0, turn: 0,
    energyStorage: 0, repairRate: 0,
    weapon: null
  },

  heavyShield: {
    category: "Defence",
    cost: 46, mass: 11, hp: 70,
    powerGeneration: 0, powerUse: 6.8,
    shield: 205, shieldRegen: 1.8,
    thrust: 0, turn: -0.055,
    energyStorage: 0, repairRate: 0,
    weapon: null
  },

  regenShield: {
    category: "Defence",
    cost: 36, mass: 6, hp: 50,
    powerGeneration: 0, powerUse: 5.8,
    shield: 82, shieldRegen: 2.0,
    thrust: 0, turn: -0.03,
    energyStorage: 0, repairRate: 0,
    weapon: null
  },

  pointDefense: {
    category: "Defence",
    cost: 36, mass: 4, hp: 40,
    powerGeneration: 0, powerUse: 3.2,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: 0,
    energyStorage: 0, repairRate: 0,
    pointDefense: 1,
    weapon: makeWeapon("pointDefense", {
      damage: 4,
      fireRate: 4.0,
      range: 280,
      projectileSpeed: 820,
      accuracy: 0.78,
      tracking: 0,
      arc: 360,
      antiMissile: true,
      targetPriority: ["missile", "torpedo", "projectile", "ship"],
      shipDamageMultiplier: 0.1
    }),
    rotationRequired: true
  },

  flakCannon: {
    category: "Defence",
    cost: 38, mass: 5, hp: 42,
    powerGeneration: 0, powerUse: 3.0,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.01,
    energyStorage: 0, repairRate: 0,
    pointDefense: 1,
    weapon: makeWeapon("pointDefense", {
      damage: 8,
      fireRate: 2.5,
      range: 220,
      projectileSpeed: 800,
      accuracy: 0.7,
      tracking: 0,
      arc: 360,
      antiMissile: true,
      targetPriority: ["missile", "torpedo", "projectile", "ship"],
      shipDamageMultiplier: 0.15
    }),
    rotationRequired: true
  },

  interceptorPod: {
    category: "Defence",
    cost: 55, mass: 6, hp: 48,
    powerGeneration: 0, powerUse: 4.2,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.02,
    energyStorage: 0, repairRate: 0,
    pointDefense: 1,
    weapon: makeWeapon("pointDefense", {
      damage: 40,
      fireRate: 1.2,
      range: 450,
      projectileSpeed: 1600,
      accuracy: 0.9,
      tracking: 0,
      arc: 360,
      antiMissile: true,
      targetPriority: ["torpedo", "missile", "projectile", "ship"],
      shipDamageMultiplier: 0.1
    }),
    rotationRequired: true
  },



  aegisProjector: {
    category: "Defence",
    cost: 47, mass: 7, hp: 47,
    powerGeneration: 0, powerUse: 5.4,
    shield: 165, shieldRegen: 6.8,
    thrust: 0, turn: -0.025,
    energyStorage: 0, repairRate: 0,
    weapon: null
  },

  // Weapons
  lightBlaster: {
    category: "Weapons",
    cost: 17, mass: 3, hp: 32,
    powerGeneration: 0, powerUse: 1.4,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.015,
    energyStorage: 0, repairRate: 0,
    blaster: 1,
    weapon: makeWeapon("blaster", {
      damage: 7,
      fireRate: 2.1,
      range: 420,
      projectileSpeed: 680,
      accuracy: 0.83,
      tracking: 0,
      arc: 120,
      shieldDamageMultiplier: 1.0,
      hullDamageMultiplier: 0.95
    }),
    rotationRequired: true
  },

  heavyBlaster: {
    category: "Weapons",
    cost: 46, mass: 8, hp: 58,
    powerGeneration: 0, powerUse: 4.4,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.05,
    energyStorage: 0, repairRate: 0,
    blaster: 1,
    weapon: makeWeapon("blaster", {
      damage: 26,
      fireRate: 0.82,
      range: 580,
      projectileSpeed: 610,
      accuracy: 0.84,
      tracking: 0,
      arc: 100,
      shieldDamageMultiplier: 1.05,
      hullDamageMultiplier: 1.05
    }),
    rotationRequired: true
  },

  autocannon: {
    category: "Weapons",
    cost: 34, mass: 6,
    hp: 44,
    powerGeneration: 0, powerUse: 1.8,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.03,
    energyStorage: 0, repairRate: 0,
    blaster: 1,
    weapon: makeWeapon("blaster", {
      damage: 4,
      fireRate: 5.2,
      range: 470,
      projectileSpeed: 700,
      accuracy: 0.64,
      tracking: 0,
      arc: 130,
      shieldDamageMultiplier: 0.75,
      hullDamageMultiplier: 1.15
    }),
    rotationRequired: true
  },

  lightMissile: {
    category: "Weapons",
    cost: 27, mass: 4, hp: 36,
    powerGeneration: 0, powerUse: 1.8,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.02,
    energyStorage: 0, repairRate: 0,
    missile: 1,
    weapon: makeWeapon("missile", {
      damage: 34,
      fireRate: 0.45,
      range: 700,
      projectileSpeed: 350,
      accuracy: 0.68,
      tracking: 0.82,
      trackTime: 1.7,
      trackingDelay: 0.15,
      arc: 220,
      shieldDamageMultiplier: 0.95,
      hullDamageMultiplier: 1.0
    }),
    rotationRequired: true
  },

  torpedo: {
    category: "Weapons",
    cost: 66, mass: 12, hp: 58,
    powerGeneration: 0, powerUse: 5.2,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.065,
    energyStorage: 0, repairRate: 0,
    missile: 1,
    weapon: makeWeapon("missile", {
      damage: 115,
      fireRate: 0.14,
      range: 940,
      projectileSpeed: 240,
      accuracy: 0.58,
      tracking: 0.25,
      trackTime: 1.1,
      trackingDelay: 0.45,
      arc: 150,
      shieldDamageMultiplier: 0.8,
      hullDamageMultiplier: 1.5
    }),
    rotationRequired: true
  },

  swarmMissile: {
    category: "Weapons",
    cost: 72, mass: 10, hp: 50,
    powerGeneration: 0, powerUse: 5.8,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.055,
    energyStorage: 0, repairRate: 0,
    missile: 1,
    weapon: makeWeapon("missile", {
      damage: 20,
      fireRate: 0.85,
      range: 730,
      projectileSpeed: 370,
      accuracy: 0.68,
      tracking: 0.82,
      trackTime: 1.7,
      trackingDelay: 0.15,
      arc: 240,
      shieldDamageMultiplier: 0.85,
      hullDamageMultiplier: 0.9
    }),
    rotationRequired: true
  },

  lightRailgun: {
    category: "Weapons",
    cost: 42, mass: 6, hp: 42,
    powerGeneration: 0, powerUse: 4.6,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.045,
    energyStorage: 0, repairRate: 0,
    railgun: 1,
    weapon: makeWeapon("railgun", {
      damage: 66,
      fireRate: 0.24,
      range: 900,
      projectileSpeed: 1100,
      accuracy: 0.93,
      tracking: 0,
      arc: 45,
      shieldDamageMultiplier: 0.7,
      hullDamageMultiplier: 1.25
    }),
    rotationRequired: true
  },

  heavyRailgun: {
    category: "Weapons",
    cost: 94, mass: 16, hp: 68,
    powerGeneration: 0, powerUse: 11,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.1,
    energyStorage: 0, repairRate: 0,
    railgun: 1,
    weapon: makeWeapon("railgun", {
      damage: 160,
      fireRate: 0.105,
      range: 1280,
      projectileSpeed: 1260,
      accuracy: 0.96,
      tracking: 0,
      arc: 35,
      shieldDamageMultiplier: 0.6,
      hullDamageMultiplier: 1.5
    }),
    rotationRequired: true
  },

  beamEmitter: {
    category: "Weapons",
    cost: 74, mass: 10, hp: 54,
    powerGeneration: 0, powerUse: 9.5,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.065,
    energyStorage: 0, repairRate: 0,
    beam: 1,
    weapon: makeWeapon("beam", {
      damage: 34,
      fireRate: 1,
      range: 520,
      radius: 16,
      projectileSpeed: 0,
      accuracy: 0.99,
      aimSpeed: 1.65,
      arc: 110,
      shieldDamageMultiplier: 1.4,
      hullDamageMultiplier: 0.75
    }),
    rotationRequired: true
  },

  // Support / utility
  sensorArray: {
    category: "Support",
    cost: 22, mass: 2, hp: 24,
    powerGeneration: 0, powerUse: 1.3,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: 0,
    energyStorage: 0, repairRate: 0,
    weapon: null,
    rangeBonus: 35,
    utilityEffect: "range"
  },

  targetingComputer: {
    category: "Support",
    cost: 32, mass: 3, hp: 28,
    powerGeneration: 0, powerUse: 2.4,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: 0,
    energyStorage: 0, repairRate: 0,
    weapon: null,
    accuracyBonus: 0.035,
    utilityEffect: "accuracy"
  },

  fireControl: {
    category: "Support",
    cost: 44, mass: 5, hp: 34,
    powerGeneration: 0, powerUse: 3.8,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.02,
    energyStorage: 0, repairRate: 0,
    weapon: null,
    fireRateBonus: 0.05,
    utilityEffect: "fireRate"
  },

  heatSink: {
    category: "Support",
    cost: 24, mass: 5, hp: 44,
    powerGeneration: 0, powerUse: 0.7,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: -0.015,
    energyStorage: 0, repairRate: 0,
    weapon: null,
    heat: -6,
    utilityEffect: "cooling"
  },

  captureModule: {
    category: "Utility",
    cost: 28, mass: 4, hp: 40,
    powerGeneration: 0, powerUse: 1.8,
    shield: 8, shieldRegen: 0.15,
    thrust: 0, turn: -0.005,
    energyStorage: 0, repairRate: 0,
    weapon: null,
    captureBonus: 0.16,
    utilityEffect: "capture"
  },

  signalAmplifier: {
    category: "Utility",
    cost: 34, mass: 3, hp: 30,
    powerGeneration: 0, powerUse: 2.2,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: 0,
    energyStorage: 0, repairRate: 0,
    weapon: null,
    rangeBonus: 60,
    utilityEffect: "range"
  },

  stabilizerNode: {
    category: "Utility",
    cost: 30, mass: 3, hp: 34,
    powerGeneration: 0, powerUse: 2,
    shield: 0, shieldRegen: 0,
    thrust: 0, turn: 0.04,
    energyStorage: 0, repairRate: 0,
    weapon: null,
    accuracyBonus: 0.05,
    utilityEffect: "accuracy"
  },

  repairBeam: {
    category: "Support",
    cost: 58, mass: 8, hp: 48,
    powerGeneration: 0, powerUse: 6.2,
    shield: 22, shieldRegen: 0.3,
    thrust: 0, turn: -0.035,
    energyStorage: 0, repairRate: 11,
    repair: 1,
    weapon: null,
    utilityEffect: "repair"
  }
});

function loadComponentBalance() {
  try {
    return JSON.parse(fs.readFileSync(COMPONENT_BALANCE_PATH, "utf8"));
  } catch (error) {
    console.error(`Failed to load component-balance.json: ${error.message}`);
    return { components: [] };
  }
}

function buildPartsFromBalance(balance, fallbackParts) {
  const components = Array.isArray(balance?.components) ? balance.components : [];
  if (!components.length) return fallbackParts;

  const parts = {};
  for (const component of components) {
    if (!component || typeof component.id !== "string") continue;
    parts[component.id] = normalizeBalanceComponent(component);
  }
  if (!parts.core && fallbackParts.core) parts.core = Object.freeze({ ...fallbackParts.core });
  return Object.freeze(parts);
}

function normalizeBalanceComponent(component) {
  const weapon = component.weapon
    ? makeWeapon(component.weapon.family || component.weapon.type || "blaster", component.weapon)
    : null;
  const repairRate = toNumber(component.repairRate ?? component.repair, 0);
  const part = {
    category: component.category || "Utility",
    cost: toNumber(component.cost, 0),
    mass: toNumber(component.mass, 0),
    hp: toNumber(component.hp ?? component.hull, 0),
    powerGeneration: toNumber(component.powerGeneration, 0),
    powerUse: toNumber(component.powerUse, 0),
    shield: toNumber(component.shield, 0),
    shieldRegen: toNumber(component.shieldRegen, 0),
    thrust: toNumber(component.thrust, 0),
    turn: toNumber(component.turn, 0),
    energyStorage: toNumber(component.energyStorage ?? component.energy, 0),
    repairRate,
    repair: repairRate > 0 ? 1 : toNumber(component.repairCount, 0),
    weapon,
    description: component.description || "",
    utilityEffect: component.utilityEffect || component.utility || "",
    rangeBonus: toNumber(component.rangeBonus, 0),
    accuracyBonus: toNumber(component.accuracyBonus, 0),
    fireRateBonus: toNumber(component.fireRateBonus, 0),
    captureBonus: toNumber(component.captureBonus, 0),
    heat: toNumber(component.heat, 0),
    rotationRequired: Boolean(component.rotationRequired || component.rotatable),
    ecmStrength: toNumber(component.ecmStrength, 0),
    decoyRange: toNumber(component.decoyRange, 0),
    decoyCooldown: toNumber(component.decoyCooldown, 0),
    decoyConfuseDuration: toNumber(component.decoyConfuseDuration, 0),
    decoyChance: toNumber(component.decoyChance, 0),
    frontDamageReduction: toNumber(component.frontDamageReduction, 0),
    frontArc: toNumber(component.frontArc, 0),
    // Directional armour: flat damage shaved off every hit this plate intercepts.
    armorFlatReduction: toNumber(component.armorFlatReduction, 0),
    footprint: component.footprint ? { width: toNumber(component.footprint.width, 1), height: toNumber(component.footprint.height, 1) } : { width: 1, height: 1 }
  };

  if (weapon) part[weapon.type] = 1;
  for (const family of ["blaster", "missile", "railgun", "beam", "pointDefense"]) {
    if (component[family]) part[family] = toNumber(component[family], part[family] || 0);
  }
  return Object.freeze(part);
}

const COMPONENT_BALANCE = loadComponentBalance();
const PARTS = buildPartsFromBalance(COMPONENT_BALANCE, FALLBACK_PARTS);

module.exports = {
  FALLBACK_PARTS,
  COMPONENT_BALANCE,
  PARTS
};
