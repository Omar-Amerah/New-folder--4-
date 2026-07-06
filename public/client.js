"use strict";

const PART_DEFS = {
  core: { name: "Core", color: "#f3f7ff", glyph: "radial-gradient(circle, #ffffff 0 28%, #86ddff 31% 58%, #2b5d92 60%)" },
  frame: { name: "Frame", color: "#8393aa", glyph: "linear-gradient(135deg, #5f6e83 0 35%, #b6c1d2 36% 48%, #5f6e83 49%)" },
  armor: { name: "Armor", color: "#ff9a62", glyph: "linear-gradient(160deg, #ffbd79, #bb4d36)" },
  engine: { name: "Engine", color: "#54d7ff", glyph: "linear-gradient(180deg, #68efff, #225ed8 52%, #111827)" },
  reactor: { name: "Reactor", color: "#ffdc5e", glyph: "radial-gradient(circle, #fff7b3 0 20%, #f4c145 26% 55%, #6b4b12 60%)" },
  battery: { name: "Battery", color: "#7ee0ff", glyph: "linear-gradient(180deg, #d5fbff 0 20%, #47caee 22% 50%, #14536f 52%)" },
  shield: { name: "Shield", color: "#7cffa0", glyph: "radial-gradient(circle, #b9ffd0 0 18%, #39cc75 28% 54%, #114027 58%)" },
  blaster: { name: "Blaster", color: "#ff5f7e", glyph: "linear-gradient(90deg, #31131d 0 18%, #ff5f7e 20% 72%, #ffd1dc 73%)" },
  missile: { name: "Missile", color: "#b995ff", glyph: "linear-gradient(90deg, #27183b 0 25%, #b995ff 26% 68%, #f0dcff 69%)" },
  railgun: { name: "Railgun", color: "#f4f7ff", glyph: "linear-gradient(90deg, #1b2230 0 16%, #f4f7ff 18% 72%, #7aa4ff 74%)" },
  repair: { name: "Repair", color: "#67e08a", glyph: "linear-gradient(45deg, #10381f 0 30%, #67e08a 31% 48%, #d7ffe2 49% 58%, #67e08a 59%)" },
  lightFrame: { name: "Light Frame", color: "#9fb2c9", glyph: "linear-gradient(135deg, #334155, #cbd5e1)" },
  heavyFrame: { name: "Heavy Frame", color: "#64748b", glyph: "linear-gradient(135deg, #1f2937, #94a3b8)" },
  compositeArmor: { name: "Composite Armor", color: "#d7a56a", glyph: "linear-gradient(160deg, #ffe1a3, #8f5b32)" },
  bulkhead: { name: "Bulkhead", color: "#b7c0cc", glyph: "linear-gradient(90deg, #475569, #e2e8f0, #475569)" },
  lightMount: { name: "Light Mount", color: "#93c5fd", glyph: "radial-gradient(circle, #dbeafe 0 25%, #3b82f6 35% 58%, #172554 62%)" },
  heavyMount: { name: "Heavy Mount", color: "#818cf8", glyph: "radial-gradient(circle, #e0e7ff 0 22%, #6366f1 34% 60%, #1e1b4b 64%)" },
  smallReactor: { name: "Small Reactor", color: "#fde68a", glyph: "radial-gradient(circle, #fff7b3 0 18%, #f59e0b 28% 55%, #451a03 60%)" },
  heavyReactor: { name: "Heavy Reactor", color: "#fbbf24", glyph: "radial-gradient(circle, #fef3c7 0 16%, #f59e0b 27% 58%, #78350f 63%)" },
  capacitor: { name: "Capacitor", color: "#93c5fd", glyph: "linear-gradient(180deg, #dbeafe, #2563eb 52%, #172554)" },
  auxGenerator: { name: "Aux Generator", color: "#fef08a", glyph: "linear-gradient(45deg, #422006, #eab308, #fef9c3)" },
  microThruster: { name: "Micro Thruster", color: "#67e8f9", glyph: "linear-gradient(180deg, #cffafe, #0891b2 55%, #164e63)" },
  heavyEngine: { name: "Heavy Engine", color: "#22d3ee", glyph: "linear-gradient(180deg, #a5f3fc, #0284c7 50%, #082f49)" },
  maneuverThruster: { name: "Maneuver Thruster", color: "#7dd3fc", glyph: "linear-gradient(135deg, #e0f2fe, #0369a1)" },
  gyroscope: { name: "Gyroscope", color: "#c4b5fd", glyph: "conic-gradient(#ede9fe, #7c3aed, #ede9fe)" },
  lightShield: { name: "Light Shield", color: "#86efac", glyph: "radial-gradient(circle, #dcfce7 0 18%, #22c55e 30% 55%, #14532d 62%)" },
  heavyShield: { name: "Heavy Shield", color: "#4ade80", glyph: "radial-gradient(circle, #bbf7d0 0 18%, #16a34a 32% 60%, #052e16 66%)" },
  regenShield: { name: "Regen Shield", color: "#5eead4", glyph: "radial-gradient(circle, #ccfbf1 0 16%, #14b8a6 28% 58%, #134e4a 64%)" },
  pointDefense: { name: "Point Defence", color: "#fda4af", glyph: "radial-gradient(circle, #fff1f2 0 18%, #fb7185 30% 56%, #881337 62%)" },
  lightBlaster: { name: "Light Blaster", color: "#fb7185", glyph: "linear-gradient(90deg, #3f0d1b 0 18%, #fb7185 20% 72%, #ffe4e6 73%)" },
  heavyBlaster: { name: "Heavy Blaster", color: "#f43f5e", glyph: "linear-gradient(90deg, #3f0d1b 0 16%, #e11d48 18% 70%, #ffe4e6 72%)" },
  autocannon: { name: "Autocannon", color: "#f97316", glyph: "linear-gradient(90deg, #431407 0 18%, #fb923c 20% 70%, #ffedd5 72%)" },
  lightMissile: { name: "Light Missile", color: "#c084fc", glyph: "linear-gradient(90deg, #2e1065 0 25%, #c084fc 26% 68%, #f3e8ff 69%)" },
  torpedo: { name: "Torpedo", color: "#a78bfa", glyph: "linear-gradient(90deg, #1e1b4b 0 22%, #8b5cf6 24% 70%, #ede9fe 72%)" },
  swarmMissile: { name: "Swarm Pod", color: "#d8b4fe", glyph: "radial-gradient(circle, #faf5ff 0 12%, #a855f7 18% 30%, #581c87 42%)" },
  lightRailgun: { name: "Light Railgun", color: "#e2e8f0", glyph: "linear-gradient(90deg, #0f172a 0 16%, #e2e8f0 18% 72%, #60a5fa 74%)" },
  heavyRailgun: { name: "Heavy Railgun", color: "#f8fafc", glyph: "linear-gradient(90deg, #020617 0 14%, #f8fafc 16% 70%, #3b82f6 74%)" },
  beamEmitter: { name: "Beam Emitter", color: "#bae6fd", glyph: "linear-gradient(90deg, #082f49 0 18%, #7dd3fc 20% 76%, #eff6ff 78%)" },
  sensorArray: { name: "Sensor Array", color: "#a7f3d0", glyph: "radial-gradient(circle, #ecfdf5 0 15%, #10b981 25% 45%, #064e3b 55%)" },
  targetingComputer: { name: "Targeting Computer", color: "#f0abfc", glyph: "linear-gradient(135deg, #701a75, #f0abfc)" },
  fireControl: { name: "Fire Control", color: "#fdba74", glyph: "linear-gradient(135deg, #7c2d12, #fed7aa)" },
  heatSink: { name: "Heat Sink", color: "#bfdbfe", glyph: "linear-gradient(180deg, #eff6ff 0 15%, #3b82f6 18% 32%, #eff6ff 35% 50%, #1d4ed8 54%)" },
  captureModule: { name: "Capture Module", color: "#f9a8d4", glyph: "radial-gradient(circle, #fdf2f8 0 20%, #ec4899 30% 55%, #831843 62%)" },
  repairBeam: { name: "Repair Beam", color: "#86efac", glyph: "linear-gradient(90deg, #052e16 0 18%, #22c55e 20% 70%, #dcfce7 72%)" }
};

const SHIP_ECONOMY = Object.freeze({
  baseShipCost: 48,
  partCostMultiplier: 1.32,
  massCostMultiplier: 0.9,
  hullCostMultiplier: 0.012,
  shieldCostMultiplier: 0.05,
  repairCostMultiplier: 0.8,
  largeShipThreshold: 400,
  largeShipCostTax: 0.15,
  hugeShipThreshold: 700,
  hugeShipCostTax: 0.25,
  weaponPremiums: Object.freeze({
    blaster: 18,
    missile: 32,
    railgun: 48
  })
});

const PARTS_STATS = {
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
      arc: 120
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
      tracking: 0.78,
      arc: 220
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
      arc: 45
    })
  },

  repair: {
    category: "Support",
    cost: 26, mass: 5, hp: 48,
    powerGeneration: 0, powerUse: 2.4,
    shield: 16, shieldRegen: 0.35,
    thrust: 0, turn: -0.015,
    energyStorage: 0, repairRate: 8,
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
    shield: 82, shieldRegen: 4.8,
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
    blaster: 1,
    weapon: makeWeapon("blaster", {
      damage: 4,
      fireRate: 4.0,
      range: 280,
      projectileSpeed: 820,
      accuracy: 0.78,
      tracking: 0,
      arc: 360
    }),
    rotationRequired: true
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
      arc: 120
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
      arc: 100
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
      arc: 130
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
      accuracy: 0.72,
      tracking: 0.7,
      arc: 220
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
      tracking: 0.3,
      arc: 150
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
      arc: 240
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
      arc: 45
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
      arc: 35
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
    railgun: 1,
    weapon: makeWeapon("railgun", {
      damage: 34,
      fireRate: 0.7,
      range: 720,
      projectileSpeed: 1500,
      accuracy: 0.98,
      tracking: 0,
      arc: 70
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

  repairBeam: {
    category: "Support",
    cost: 58, mass: 8, hp: 48,
    powerGeneration: 0, powerUse: 6.2,
    shield: 22, shieldRegen: 0.4,
    thrust: 0, turn: -0.035,
    energyStorage: 0, repairRate: 17,
    repair: 1,
    weapon: null,
    utilityEffect: "repair"
  }
};

const LOCAL_DESIGN_KEY = "modular-fleet-design-v2";
const LOCAL_NAME_KEY = "modular-fleet-name-v1";
const LOCAL_TEAM_KEY = "modular-fleet-team-v1";
const LOCAL_FORMATION_KEY = "modular-fleet-formation-v1";
const LOCAL_SERVER_KEY = "modular-fleet-server-url-v1";
const LOCAL_SAVED_DESIGNS_KEY = "modular-fleet-saved-designs-v1";
const LOCAL_ACTIVE_ROOM_KEY = "modular-fleet-active-room-v1";
const WORLD_FALLBACK = { width: 3200, height: 1900 };
const PURCHASE_PENDING_MS = 2500;
const PART_CATEGORIES = ["Structure", "Power", "Engines", "Defence", "Weapons", "Support", "Utility"];

const dom = {
  canvas: document.getElementById("arenaCanvas"),
  status: document.getElementById("connectionStatus"),
  roomState: document.getElementById("roomStateText"),
  mainMenuNotice: document.getElementById("mainMenuNotice"),
  pilotName: document.getElementById("pilotName"),
  teamSelect: document.getElementById("teamSelect"),
  roomCode: document.getElementById("roomCode"),
  createButton: document.getElementById("createButton"),
  currentRoomCard: document.getElementById("currentRoomCard"),
  currentRoomCode: document.getElementById("currentRoomCode"),
  phaseDetail: document.getElementById("phaseDetail"),
  stepLobby: document.getElementById("stepLobby"),
  stepDesign: document.getElementById("stepDesign"),
  stepBattle: document.getElementById("stepBattle"),
  stepEnd: document.getElementById("stepEnd"),
  joinButton: document.getElementById("joinButton"),
  copyButton: document.getElementById("copyButton"),
  botButton: document.getElementById("botButton"),
  leaveLobbyButton: document.getElementById("leaveLobbyButton"),
  rulesStatus: document.getElementById("rulesStatus"),
  gameModeSelect: document.getElementById("gameModeSelect"),
  startingMoneyInput: document.getElementById("startingMoneyInput"),
  maxPlayersInput: document.getElementById("maxPlayersInput"),
  mapSizeSelect: document.getElementById("mapSizeSelect"),
  teamChoiceCard: document.getElementById("teamChoiceCard"),
  teamChoiceStatus: document.getElementById("teamChoiceStatus"),
  adminControls: document.getElementById("adminControls"),
  startDesignButton: document.getElementById("startDesignButton"),
  closeLobbyButton: document.getElementById("closeLobbyButton"),
  playerList: document.getElementById("playerList"),
  deployButton: document.getElementById("deployButton"),
  resetButton: document.getElementById("resetButton"),
  formationSelect: document.getElementById("formationSelect"),
  palette: document.getElementById("partPalette"),
  partInspector: document.getElementById("partInspector"),
  grid: document.getElementById("buildGrid"),
  buildStatus: document.getElementById("buildStatus"),
  shipIssuesPanel: document.getElementById("shipIssuesPanel"),
  stats: document.getElementById("statsGrid"),
  saveDesignButton: document.getElementById("saveDesignButton"),
  savedDesignList: document.getElementById("savedDesignList"),
  blueprintCostLabel: document.getElementById("blueprintCostLabel"),
  blueprintCostStatus: document.getElementById("blueprintCostStatus"),
  roomLabel: document.getElementById("roomLabel"),
  fleetLabel: document.getElementById("fleetLabel"),
  relayLabel: document.getElementById("relayLabel"),
  moneyHud: document.getElementById("moneyHudLabel"),
  incomeHud: document.getElementById("incomeHudLabel"),
  selectionLabel: document.getElementById("selectionLabel"),
  objectiveLabel: document.getElementById("objectiveLabel"),
  purchaseBar: document.getElementById("purchaseBar"),
  purchaseQuantityOne: document.getElementById("purchaseQuantityOne"),
  purchaseQuantityFive: document.getElementById("purchaseQuantityFive"),
  purchaseOptions: document.getElementById("purchaseOptions"),
  purchaseTooltip: document.getElementById("purchaseTooltip"),
  scoreList: document.getElementById("scoreList"),
  eventLog: document.getElementById("eventLog"),
  toastStack: document.getElementById("toastStack"),
  matchProgressFill: document.getElementById("matchProgressFill"),
  matchSummary: document.getElementById("matchSummary"),
  latency: document.getElementById("latencyText"),
  marker: document.getElementById("commandMarker"),
  winner: document.getElementById("winnerBanner"),
  endGameScreen: document.getElementById("endGameScreen"),
  endGameTitle: document.getElementById("endGameTitle"),
  endGameSummary: document.getElementById("endGameSummary"),
  endGameActions: document.getElementById("endGameActions"),
  restartButton: document.getElementById("restartButton"),
  endCloseButton: document.getElementById("endCloseButton"),
  endLeaveButton: document.getElementById("endLeaveButton"),
  mainMenuScreen: document.getElementById("mainMenuScreen"),
  lobbyManagementScreen: document.getElementById("lobbyManagementScreen"),
  settingsScreen: document.getElementById("settingsScreen"),
  mainMenuButton: document.getElementById("mainMenuButton"),
  lobbyManagementButton: document.getElementById("lobbyManagementButton"),
  settingsButton: document.getElementById("settingsButton"),
  mainMenuCloseButton: document.getElementById("mainMenuCloseButton"),
  lobbyCloseButton: document.getElementById("lobbyCloseButton"),
  settingsCloseButton: document.getElementById("settingsCloseButton"),
  serverUrlInput: document.getElementById("serverUrlInput"),
  saveServerButton: document.getElementById("saveServerButton"),
  clearServerButton: document.getElementById("clearServerButton"),
  confirmModal: document.getElementById("confirmModal"),
  confirmModalTitle: document.getElementById("confirmModalTitle"),
  confirmModalMessage: document.getElementById("confirmModalMessage"),
  confirmCancelButton: document.getElementById("confirmCancelButton"),
  confirmAcceptButton: document.getElementById("confirmAcceptButton")
};

const ctx = dom.canvas.getContext("2d", { alpha: false });

const state = {
  socket: null,
  myId: null,
  room: "",
  world: { ...WORLD_FALLBACK },
  parts: {},
  design: loadDesign(),
  savedDesigns: loadSavedDesigns(),
  loadedEditorBlueprintId: null,
  purchaseQuantity: 1,
  selectedPart: "frame",
  selectedPartCategory: "Structure",
  hoveredCell: null,
  selectedCell: null,
  selectedShipIds: new Set(),
  snapshot: null,
  map: null,
  phase: "offline",
  adminId: null,
  camera: { x: WORLD_FALLBACK.width / 2, y: WORLD_FALLBACK.height / 2, zoom: 0.58, follow: true, manualZoom: null },
  pointer: { x: 0, y: 0 },
  drag: null,
  keys: new Set(),
  stars: makeStars(260),
  rules: { startingMoney: 700, shipCap: 20, maxPlayers: 12, mapSize: "auto", gameMode: "teams" },
  minimap: null,
  shipHud: new Map(),
  pendingPurchases: new Map(),
  purchaseErrors: new Map(),
  purchasePointer: null,
  savedDesignPointer: null,
  pendingDeleteDesignId: null,
  pendingKickTargetId: null,
  kickPointer: null,
  notices: [],
  lastPingAt: 0,
  lastPongAt: 0,
  latency: null,
  command: null,
  lastFrameAt: performance.now()
};

dom.pilotName.value = localStorage.getItem(LOCAL_NAME_KEY) || `Pilot-${Math.floor(100 + Math.random() * 900)}`;
dom.teamSelect.value = localStorage.getItem(LOCAL_TEAM_KEY) === "red" ? "red" : "blue";
dom.formationSelect.value = localStorage.getItem(LOCAL_FORMATION_KEY) || "line";

renderPalette();
renderPartInspector();
renderBuildGrid();
renderLocalStats();
renderSavedDesigns();
renderPurchaseBar();
updateLobbyState();
openMainMenu();
resizeCanvas();
requestAnimationFrame(frame);

window.addEventListener("resize", resizeCanvas);
window.addEventListener("keydown", handleKeyDown);
window.addEventListener("keyup", (event) => state.keys.delete(event.key.toLowerCase()));

dom.createButton.addEventListener("click", createGame);
dom.joinButton.addEventListener("click", joinExistingGame);
dom.deployButton.addEventListener("click", deployDesign);
dom.saveDesignButton.addEventListener("click", () => saveCurrentDesign());
dom.resetButton.addEventListener("click", resetDesign);
dom.copyButton.addEventListener("click", copyInvite);
dom.botButton.addEventListener("click", addBot);
dom.leaveLobbyButton?.addEventListener("click", leaveLobby);
dom.startDesignButton.addEventListener("click", startDesign);
dom.closeLobbyButton.addEventListener("click", closeLobby);
dom.restartButton.addEventListener("click", restartMatch);
dom.endCloseButton.addEventListener("click", closeLobby);
dom.endLeaveButton?.addEventListener("click", leaveLobby);
dom.mainMenuButton?.addEventListener("click", openMainMenu);
dom.lobbyManagementButton?.addEventListener("click", openLobbyManagement);
dom.settingsButton?.addEventListener("click", openSettings);
dom.mainMenuCloseButton?.addEventListener("click", hideMenuScreens);
dom.lobbyCloseButton?.addEventListener("click", hideMenuScreens);
dom.settingsCloseButton?.addEventListener("click", hideMenuScreens);
dom.saveServerButton?.addEventListener("click", saveServerSetting);
dom.clearServerButton?.addEventListener("click", clearServerSetting);
dom.confirmCancelButton?.addEventListener("click", closeConfirmModal);
dom.confirmAcceptButton?.addEventListener("click", confirmModalAction);
dom.confirmModal?.addEventListener("pointerdown", (event) => {
  if (event.target === dom.confirmModal) closeConfirmModal();
});
dom.formationSelect.addEventListener("change", () => {
  localStorage.setItem(LOCAL_FORMATION_KEY, dom.formationSelect.value);
});
dom.teamSelect.addEventListener("change", () => {
  localStorage.setItem(LOCAL_TEAM_KEY, dom.teamSelect.value);
  send({ type: "setTeam", team: teamValue() });
});
dom.pilotName.addEventListener("change", () => {
  localStorage.setItem(LOCAL_NAME_KEY, dom.pilotName.value.trim());
  send({ type: "setName", name: dom.pilotName.value });
});
dom.roomCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinExistingGame();
});
dom.startingMoneyInput?.addEventListener("change", sendRulesUpdate);
dom.maxPlayersInput?.addEventListener("change", sendRulesUpdate);
dom.mapSizeSelect?.addEventListener("change", sendRulesUpdate);
dom.gameModeSelect?.addEventListener("change", sendRulesUpdate);
dom.purchaseQuantityOne?.addEventListener("click", () => setPurchaseQuantity(1));
dom.purchaseQuantityFive?.addEventListener("click", () => setPurchaseQuantity(5));
dom.purchaseOptions?.addEventListener("pointerdown", handlePurchasePointerDown);
dom.purchaseOptions?.addEventListener("pointerup", handlePurchasePointerUp);
dom.purchaseOptions?.addEventListener("pointercancel", clearPurchasePointer);
dom.purchaseOptions?.addEventListener("lostpointercapture", clearPurchasePointer);
dom.purchaseOptions?.addEventListener("click", handlePurchaseKeyboardClick);
dom.savedDesignList?.addEventListener("pointerdown", handleSavedDesignPointerDown);
dom.savedDesignList?.addEventListener("pointerup", handleSavedDesignPointerUp);
dom.savedDesignList?.addEventListener("pointercancel", clearSavedDesignPointer);
dom.savedDesignList?.addEventListener("lostpointercapture", clearSavedDesignPointer);
dom.savedDesignList?.addEventListener("click", handleSavedDesignKeyboardClick);
bindKickButtonContainer(dom.playerList);
bindKickButtonContainer(dom.scoreList);

dom.canvas.addEventListener("pointerdown", handlePointerDown);
dom.canvas.addEventListener("pointermove", handlePointerMove);
dom.canvas.addEventListener("pointerup", handlePointerUp);
dom.canvas.addEventListener("pointercancel", () => {
  state.drag = null;
});
dom.canvas.addEventListener("wheel", handleWheel, { passive: false });
dom.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

setInterval(() => {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.lastPingAt = performance.now();
  send({ type: "ping", at: state.lastPingAt });
}, 2000);

function createGame() {
  dom.roomCode.value = "";
  clearMenuNotice();
  joinRoom("");
}

function joinExistingGame() {
  const code = dom.roomCode.value.trim().toUpperCase();
  clearMenuNotice();
  if (!code) {
    showMenuNotice("Enter a game code or click Create", "warning");
    dom.roomCode.focus();
    return;
  }
  joinRoom(code);
}

function joinRoom(roomCode = "") {
  clearMenuNotice();
  if (state.socket) state.socket.close();
  state.room = "";
  state.snapshot = null;
  state.map = null;
  state.phase = "offline";
  state.adminId = null;
  state.selectedShipIds.clear();
  dom.roomLabel.textContent = "----";
  dom.roomCode.value = "";
  dom.currentRoomCode.textContent = "----";
  dom.currentRoomCard.hidden = true;

  const socket = new WebSocket(getSocketUrl());
  state.socket = socket;
  setConnectionStatus("connecting", "Connecting");
  updateLobbyState();

  socket.addEventListener("open", () => {
    if (socket !== state.socket) return;
    const name = dom.pilotName.value.trim();
    localStorage.setItem(LOCAL_NAME_KEY, name);
    send({ type: "join", name, team: teamValue(), room: roomCode });
    setConnectionStatus("online", "Dock linked");
    updateLobbyState();
  });

  socket.addEventListener("message", (event) => {
    if (socket !== state.socket) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(message);
  });

  socket.addEventListener("close", () => {
    if (socket !== state.socket) return;
    returnToMainMenu(state.room ? "Disconnected from lobby" : "", "warning");
  });

  socket.addEventListener("error", () => {
    if (socket !== state.socket) return;
    setConnectionStatus("error", "Link error");
    updateLobbyState();
  });
}

function deployDesign() {
  if (!state.room || !state.socket || state.socket.readyState !== WebSocket.OPEN) {
    addNotice("Create or join a game first", "warning");
    return;
  }
  if (state.phase !== "design" && state.phase !== "active") {
    addNotice("Wait for ship design or match start", "warning");
    return;
  }
  send({ type: "deploy", design: state.design });
}

function startDesign() {
  send({ type: "startDesign" });
}

function restartMatch() {
  send({ type: "restart" });
}

function closeLobby() {
  setEndGameActionState(true);
  send({ type: "closeLobby" });
  forgetActiveRoom();
  returnToMainMenu("Closing lobby", "warning");
}

function leaveLobby() {
  if (!state.room) {
    openMainMenu();
    return;
  }
  send({ type: "leaveLobby" });
  forgetActiveRoom();
  returnToMainMenu("Left lobby", "warning");
}

function setEndGameActionState(disabled) {
  if (dom.restartButton) dom.restartButton.disabled = disabled;
  if (dom.endCloseButton) dom.endCloseButton.disabled = disabled;
  if (dom.endLeaveButton) dom.endLeaveButton.disabled = disabled;
}

function returnToMainMenu(message = "", tone = "warning") {
  clearRoomState();
  setConnectionStatus(state.socket?.readyState === WebSocket.OPEN ? "online" : "offline", state.socket?.readyState === WebSocket.OPEN ? "Dock linked" : "Offline dock");
  updateLobbyState();
  updateEconomyUi();
  renderSavedDesigns();
  renderPurchaseBar();
  clearMatchPanels();
  openMainMenu();
  if (message) showMenuNotice(message, tone);
}

function clearRoomState() {
  for (const pending of state.pendingPurchases.values()) clearTimeout(pending.timeoutId);
  for (const error of state.purchaseErrors.values()) {
    if (error?.timeoutId) clearTimeout(error.timeoutId);
  }
  state.room = "";
  state.snapshot = null;
  state.map = null;
  state.phase = "offline";
  state.adminId = null;
  state.selectedShipIds.clear();
  state.pendingPurchases.clear();
  state.purchaseErrors.clear();
  state.command = null;
  dom.roomLabel.textContent = "----";
  dom.currentRoomCode.textContent = "----";
  dom.currentRoomCard.hidden = true;
  dom.fleetLabel.textContent = "0";
  dom.moneyHud.textContent = "$0";
  if (dom.incomeHud) dom.incomeHud.textContent = "+$0/s";
  dom.relayLabel.textContent = "0";
  dom.selectionLabel.textContent = "0";
  dom.objectiveLabel.textContent = "None";
  dom.winner.hidden = true;
  dom.endGameScreen.hidden = true;
  if (dom.roomCode) dom.roomCode.value = "";
  setEndGameActionState(false);
}

function clearMatchPanels() {
  dom.scoreList.textContent = "";
  dom.matchProgressFill.style.width = "0%";
  dom.matchSummary.textContent = "No active match";
}

function showMenuScreen(screen) {
  for (const element of [dom.mainMenuScreen, dom.lobbyManagementScreen, dom.settingsScreen]) {
    if (element) element.hidden = element !== screen;
  }
}

function hideMenuScreens() {
  if (dom.mainMenuScreen) dom.mainMenuScreen.hidden = true;
  if (dom.lobbyManagementScreen) dom.lobbyManagementScreen.hidden = true;
  if (dom.settingsScreen) dom.settingsScreen.hidden = true;
}

function openMainMenu() {
  showMenuScreen(dom.mainMenuScreen);
}

function showMenuNotice(message, tone = "warning") {
  if (!dom.mainMenuNotice) return;
  const text = String(message || "").trim();
  if (!text) {
    clearMenuNotice();
    return;
  }
  dom.mainMenuNotice.textContent = text;
  dom.mainMenuNotice.className = `menu-notice ${tone || ""}`.trim();
  dom.mainMenuNotice.hidden = false;
}

function clearMenuNotice() {
  if (!dom.mainMenuNotice) return;
  dom.mainMenuNotice.textContent = "";
  dom.mainMenuNotice.hidden = true;
  dom.mainMenuNotice.className = "menu-notice";
}

function openLobbyManagement() {
  if (!state.room) {
    addNotice("Create or join a game before opening lobby management", "warning");
    openMainMenu();
    return;
  }
  showMenuScreen(dom.lobbyManagementScreen);
}

function openSettings() {
  if (dom.serverUrlInput) dom.serverUrlInput.value = getConfiguredServerUrl();
  showMenuScreen(dom.settingsScreen);
}

function saveServerSetting() {
  const value = dom.serverUrlInput?.value?.trim() || "";
  if (value) localStorage.setItem(LOCAL_SERVER_KEY, value);
  else localStorage.removeItem(LOCAL_SERVER_KEY);
  addNotice(state.socket ? "Server setting saved. Reconnect to use it." : "Server setting saved", "good");
  hideMenuScreens();
}

function clearServerSetting() {
  localStorage.removeItem(LOCAL_SERVER_KEY);
  if (dom.serverUrlInput) dom.serverUrlInput.value = "";
  addNotice(state.socket ? "Using current host after reconnect" : "Using current host", "good");
}

function sendRulesUpdate() {
  if (!isAdmin() || state.phase !== "lobby") return;
  const rules = {
    gameMode: dom.gameModeSelect?.value || "teams",
    startingMoney: Number(dom.startingMoneyInput?.value),
    maxPlayers: Number(dom.maxPlayersInput?.value),
    mapSize: dom.mapSizeSelect?.value || "auto"
  };
  send({ type: "setRules", rules });
}

function kickPlayer(targetId) {
  if (!targetId) {
    addNotice("Cannot kick: missing player id", "error");
    return;
  }
  if (!state.room || state.socket?.readyState !== WebSocket.OPEN) {
    addNotice("Cannot kick: you are not connected to a lobby", "warning");
    return;
  }
  if (!isAdmin()) {
    addNotice("Only the room admin can kick players", "warning");
    return;
  }
  const player = state.snapshot?.players?.find((candidate) => candidate.id === targetId);
  openKickConfirmModal(player || { id: targetId, name: "this player" });
}

function openKickConfirmModal(player) {
  state.pendingKickTargetId = player.id;
  state.pendingDeleteDesignId = null;
  if (dom.confirmModalTitle) dom.confirmModalTitle.textContent = "Kick player?";
  if (dom.confirmModalMessage) dom.confirmModalMessage.textContent = `Remove ${player.name || "this player"} from this lobby?`;
  if (dom.confirmAcceptButton) dom.confirmAcceptButton.textContent = "Kick";
  if (dom.confirmModal) dom.confirmModal.hidden = false;
  dom.confirmCancelButton?.focus?.();
}

function bindKickButtonContainer(container) {
  if (!container) return;
  container.addEventListener("pointerdown", handleKickPointerDown);
  container.addEventListener("pointerup", handleKickPointerUp);
  container.addEventListener("pointercancel", clearKickPointer);
  container.addEventListener("lostpointercapture", clearKickPointer);
  container.addEventListener("click", handleKickKeyboardClick);
}

function handleKickPointerDown(event) {
  if (event.button !== undefined && event.button !== 0) return;
  const container = event.currentTarget;
  const button = event.target?.closest?.("[data-kick]");
  if (!button || !container?.contains(button) || button.disabled) return;
  event.preventDefault();
  clearKickPressedButtons();
  button.classList.add("pressed");
  state.kickPointer = {
    targetId: button.dataset.kick || "",
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    container
  };
  try {
    container.setPointerCapture?.(event.pointerId);
  } catch {
    // Pointer capture is best-effort; keyboard activation still uses the click fallback.
  }
}

function handleKickPointerUp(event) {
  const pointer = state.kickPointer;
  if (!pointer || pointer.pointerId !== event.pointerId) return;
  const container = pointer.container;
  clearKickPointer();
  try {
    container?.releasePointerCapture?.(event.pointerId);
  } catch {
    // The browser may already have released capture while the panel rerenders.
  }
  const moved = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
  const bounds = container.getBoundingClientRect();
  const releasedInside = event.clientX >= bounds.left
    && event.clientX <= bounds.right
    && event.clientY >= bounds.top
    && event.clientY <= bounds.bottom;
  if (moved > 12 || !releasedInside) return;
  event.preventDefault();
  kickPlayer(pointer.targetId);
}

function clearKickPointer() {
  clearKickPressedButtons();
  state.kickPointer = null;
}

function clearKickPressedButtons() {
  for (const container of [dom.playerList, dom.scoreList]) {
    container?.querySelectorAll?.("[data-kick].pressed")?.forEach((button) => {
      button.classList.remove("pressed");
    });
  }
}

function handleKickKeyboardClick(event) {
  if (event.detail !== 0) return;
  const container = event.currentTarget;
  const button = event.target?.closest?.("[data-kick]");
  if (!button || !container?.contains(button) || button.disabled) return;
  event.preventDefault();
  kickPlayer(button.dataset.kick || "");
}

function addBot() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    joinRoom();
    setTimeout(addBot, 260);
    return;
  }
  send({ type: "addBot" });
}

function handlePurchasePointerDown(event) {
  if (event.button !== undefined && event.button !== 0) return;
  const card = event.target?.closest?.(".purchase-option");
  if (!card || !dom.purchaseOptions?.contains(card)) return;
  if (isUnaffordablePurchaseOption(card.dataset?.optionId || "")) return;
  clearPressedPurchaseCards();
  setPurchaseCardFeedback(card, "pressed", "Checking...");
  state.purchasePointer = {
    optionId: card.dataset?.optionId || "",
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    startedAt: performance.now()
  };
  try {
    dom.purchaseOptions.setPointerCapture?.(event.pointerId);
  } catch {
    // Pointer capture is best-effort; the click fallback below still handles keyboard activation.
  }
}

function handlePurchasePointerUp(event) {
  const pointer = state.purchasePointer;
  if (!pointer || pointer.pointerId !== event.pointerId) return;
  clearPurchasePointer();
  try {
    dom.purchaseOptions.releasePointerCapture?.(event.pointerId);
  } catch {
    // It is safe if the browser already released capture during a rerender.
  }
  const moved = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
  const bounds = dom.purchaseOptions.getBoundingClientRect();
  const releasedInside = event.clientX >= bounds.left
    && event.clientX <= bounds.right
    && event.clientY >= bounds.top
    && event.clientY <= bounds.bottom;
  if (!pointer.optionId || moved > 12 || !releasedInside) {
    clearPressedPurchaseCards();
    return;
  }
  event.preventDefault();
  buyPurchaseOption(pointer.optionId);
}

function clearPurchasePointer() {
  clearPressedPurchaseCards();
  state.purchasePointer = null;
}

function clearPressedPurchaseCards() {
  dom.purchaseOptions?.querySelectorAll?.(".purchase-option.pressed")?.forEach((card) => {
    card.classList.remove("pressed");
    const previousStatus = card.dataset?.statusText;
    if (previousStatus) {
      const status = card.querySelector("em");
      if (status) status.textContent = previousStatus;
      delete card.dataset.statusText;
    }
  });
}

function setPurchaseCardFeedback(card, className, text) {
  if (!card) return;
  const status = card.querySelector("em");
  if (status && card.dataset && !card.dataset.statusText) card.dataset.statusText = status.textContent;
  card.classList.add(className);
  if (status) status.textContent = text;
}

function setPurchaseOptionFeedback(optionId, className, text) {
  const card = [...(dom.purchaseOptions?.querySelectorAll?.(".purchase-option") || [])]
    .find((candidate) => candidate.dataset?.optionId === optionId);
  if (card) setPurchaseCardFeedback(card, className, text);
}

function handlePurchaseKeyboardClick(event) {
  if (event.detail !== 0) return;
  const card = event.target?.closest?.(".purchase-option");
  if (!card || !dom.purchaseOptions?.contains(card)) return;
  if (isUnaffordablePurchaseOption(card.dataset?.optionId || "")) return;
  event.preventDefault();
  buyPurchaseOption(card.dataset?.optionId || "");
}

function buyPurchaseOption(optionId) {
  const option = getPurchaseOptions().find((candidate) => candidate.id === optionId);
  const quantity = state.purchaseQuantity;
  const connectionOpen = state.socket?.readyState === WebSocket.OPEN;

  if (!option) {
    showToast("Purchase option no longer exists", "error");
    return;
  }

  const purchase = getPurchaseOptionState(option, quantity);

  if (!state.room || !connectionOpen) {
    const reason = "Create or join a game first";
    setPurchaseOptionFeedback(optionId, "error", reason);
    setPurchaseError(optionId, reason);
    addNotice(reason, "warning");
    return;
  }

  if (purchase.pending) {
    const reason = "Already building this ship";
    setPurchaseOptionFeedback(optionId, "pending", "Building...");
    showToast(reason, "warning");
    return;
  }

  if (!purchase.canBuy) {
    const reason = purchase.reason || "Cannot buy this ship right now";
    if (isMoneyPurchaseBlocker(reason)) return;
    setPurchaseOptionFeedback(optionId, "error", reason);
    setPurchaseError(optionId, reason);
    addNotice(reason, "warning");
    return;
  }

  const requestId = makePurchaseRequestId();
  const timeoutId = setTimeout(() => {
    const pending = clearPendingPurchase(requestId);
    if (!pending) return;
    const reason = "No server response after purchase request";
    setPurchaseError(pending.optionId, "No response, try again");
  }, PURCHASE_PENDING_MS);

  state.pendingPurchases.set(requestId, {
    optionId,
    count: quantity,
    moneyBefore: purchase.money,
    activeShipsBefore: purchase.activeShips,
    totalCost: purchase.totalCost,
    startedAt: performance.now(),
    timeoutId
  });
  setPurchaseOptionFeedback(optionId, "pending", "Building...");
  send({ type: "buyShip", count: quantity, design: option.blueprint, requestId });
}

function isUnaffordablePurchaseOption(optionId) {
  const option = getPurchaseOptions().find((candidate) => candidate.id === optionId);
  if (!option) return false;
  const purchase = getPurchaseOptionState(option, state.purchaseQuantity);
  return !purchase.canBuy && isMoneyPurchaseBlocker(purchase.reason);
}

function isMoneyPurchaseBlocker(reason = "") {
  return /need \$|not enough money|cannot afford/i.test(String(reason));
}

function setPurchaseQuantity(quantity) {
  state.purchaseQuantity = quantity === 5 ? 5 : 1;
  renderPurchaseBar();
}

function makePurchaseRequestId() {
  return `buy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clearPendingPurchase(requestId) {
  const pending = state.pendingPurchases.get(requestId);
  if (!pending) return null;
  clearTimeout(pending.timeoutId);
  state.pendingPurchases.delete(requestId);
  renderPurchaseBar();
  return pending;
}

function reconcilePendingPurchasesWithSnapshot() {
  if (!state.pendingPurchases.size) return;
  const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
  if (!mine) return;
  const money = currentMatchMoney(mine);
  const activeShips = mine.activeShips ?? 0;
  for (const [requestId, pending] of [...state.pendingPurchases]) {
    const age = performance.now() - pending.startedAt;
    const shipCountChanged = activeShips >= pending.activeShipsBefore + 1;
    const moneySpent = money <= pending.moneyBefore - Math.max(1, Math.floor((pending.totalCost || 0) * 0.5));
    if (age > 120 && (shipCountChanged || moneySpent)) {
      clearPendingPurchase(requestId);
      showToast(`Built ${pending.count} ship${pending.count === 1 ? "" : "s"}`, "good");
    }
  }
}

function setPurchaseError(optionId, message) {
  const previous = state.purchaseErrors.get(optionId);
  if (previous?.timeoutId) clearTimeout(previous.timeoutId);
  const timeoutId = setTimeout(() => {
    state.purchaseErrors.delete(optionId);
    renderPurchaseBar();
  }, 1600);
  state.purchaseErrors.set(optionId, { message, timeoutId });
  renderPurchaseBar();
}

function send(message) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify(message));
}

function setConnectionStatus(status, text) {
  if (!dom.status) return;
  dom.status.textContent = text;
  dom.status.className = `connection-status ${status}`;
}

function updateLobbyState() {
  const connected = state.socket?.readyState === WebSocket.OPEN && Boolean(state.room);
  const connecting = state.socket?.readyState === WebSocket.CONNECTING;
  const playerCount = state.snapshot?.players?.length || 0;
  const phase = state.snapshot?.phase || state.phase;
  const admin = isAdmin();
  dom.roomState.textContent = connected ? `${phaseLabel(phase)} | ${playerCount} in room` : connecting ? "Connecting" : "Not joined";
  dom.createButton.disabled = connecting;
  dom.joinButton.disabled = connecting;
  if (dom.mainMenuCloseButton) dom.mainMenuCloseButton.disabled = !connected;
  dom.copyButton.disabled = !state.room;
  dom.botButton.disabled = !connected || !admin || phase !== "lobby";
  if (dom.leaveLobbyButton) {
    dom.leaveLobbyButton.hidden = !connected || admin;
    dom.leaveLobbyButton.disabled = !connected || admin;
  }
  updateTeamChoiceControls(connected, phase);
  dom.adminControls.hidden = !connected || !admin || phase === "active";
  dom.startDesignButton.disabled = !connected || !admin || phase !== "lobby" || playerCount === 0;
  dom.closeLobbyButton.disabled = !connected || !admin || phase === "active";
  dom.currentRoomCard.hidden = !state.room;
  dom.currentRoomCode.textContent = state.room || "----";
  updateRulesControls(connected, admin, phase, playerCount);
  updatePhaseSteps(phase);
  updatePhaseDetail(phase);
  renderPlayerList();
}

function updateRulesControls(connected, admin, phase, playerCount) {
  const editable = connected && admin && phase === "lobby";
  const rules = state.snapshot?.rules || state.rules || {};
  state.rules = { ...state.rules, ...rules };
  if (dom.rulesStatus) {
    dom.rulesStatus.textContent = editable
      ? "Host controls"
      : admin && connected ? "Locked after lobby" : "Host only";
  }
  setRuleControlValue(dom.gameModeSelect, rules.gameMode || state.rules.gameMode || "teams");
  setRuleControlValue(dom.startingMoneyInput, rules.startingMoney ?? state.rules.startingMoney);
  setRuleControlValue(dom.maxPlayersInput, rules.maxPlayers ?? state.rules.maxPlayers);
  setRuleControlValue(dom.mapSizeSelect, rules.mapSize || state.rules.mapSize || "auto");
  for (const element of [dom.gameModeSelect, dom.startingMoneyInput, dom.maxPlayersInput, dom.mapSizeSelect]) {
    if (element) element.disabled = !editable;
  }
  if (dom.maxPlayersInput) {
    dom.maxPlayersInput.min = String(Math.max(2, playerCount || 1));
  }
}

function updateTeamChoiceControls(connected, phase) {
  const mode = state.rules?.gameMode || "teams";
  const inLobby = connected && phase === "lobby";
  const canChoose = inLobby && mode === "teams";
  const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
  if (dom.teamChoiceCard) {
    dom.teamChoiceCard.hidden = !connected || mode === "solo";
    dom.teamChoiceCard.classList?.toggle?.("solo", mode === "solo");
  }
  if (dom.teamSelect) {
    if (mine?.team === "blue" || mine?.team === "red") dom.teamSelect.value = mine.team;
    dom.teamSelect.disabled = !canChoose;
  }
  if (dom.teamChoiceStatus) {
    dom.teamChoiceStatus.textContent = mode === "solo"
      ? "Solo mode: every player is an opponent"
      : canChoose ? "Choose before ship design" : "Locked after ship design starts";
  }
}

function setRuleControlValue(element, value) {
  if (!element || document.activeElement === element) return;
  element.value = String(value);
}

function phaseLabel(phase) {
  if (phase === "lobby") return "Lobby";
  if (phase === "design") return "Ship design";
  if (phase === "active") return "Battle";
  if (phase === "ended") return "Ended";
  return "Offline";
}

function updatePhaseSteps(phase) {
  const order = ["lobby", "design", "active", "ended"];
  const current = Math.max(0, order.indexOf(phase));
  const entries = [
    [dom.stepLobby, "lobby"],
    [dom.stepDesign, "design"],
    [dom.stepBattle, "active"],
    [dom.stepEnd, "ended"]
  ];
  for (const [element, key] of entries) {
    const index = order.indexOf(key);
    element.className = index === current ? "active" : index < current ? "done" : "";
  }
}

function updatePhaseDetail(phase) {
  const players = state.snapshot?.players || [];
  const ready = players.filter((player) => player.ready).length;
  const mapName = state.snapshot?.map?.name;
  const size = state.snapshot?.mapSizeLabel;
  if (!state.room) {
    dom.phaseDetail.textContent = "Create or join a room to begin.";
  } else if (phase === "lobby") {
    const mapRule = (state.rules?.mapSize && state.rules.mapSize !== "auto")
      ? state.rules.mapSize
      : `${players.length || 1} player${players.length === 1 ? "" : "s"}`;
    const modeText = state.rules?.gameMode === "solo" ? "Solo mode" : "Teams mode";
    dom.phaseDetail.textContent = isAdmin()
      ? `Waiting room. ${modeText}. Add bots, share the code, then start ship design. Map size will use ${mapRule}.`
      : "Waiting for the room admin to start ship design.";
  } else if (phase === "design") {
    dom.phaseDetail.textContent = `${ready}/${players.length} ready. Edit your ship, then press Ready. ${size || "Map"}: ${mapName || "generated map"}.`;
  } else if (phase === "active") {
    dom.phaseDetail.textContent = `${size || "Map"}: ${mapName || "generated map"}. Capture relays, build ships, and fight.`;
  } else if (phase === "ended") {
    dom.phaseDetail.textContent = isAdmin() ? "Match ended. Choose Restart or Close lobby." : "Match ended. Waiting for the admin.";
  }
}

function handleServerMessage(message) {
  if (message.type === "hello") {
    state.myId = message.id;
    state.parts = message.parts || {};
    state.world = message.world || { ...WORLD_FALLBACK };
    state.rules = { ...state.rules, ...(message.economy || {}) };
    if (!localStorage.getItem(LOCAL_DESIGN_KEY)) {
      state.design = normalizeDesign(message.defaultDesign || state.design);
      renderBuildGrid();
      renderLocalStats();
    }
    return;
  }

  if (message.type === "joined") {
    state.myId = message.id;
    state.room = message.room;
    state.world = message.world || state.world;
    state.map = message.map || state.map;
    state.phase = message.phase || "lobby";
    state.adminId = message.adminId || null;
    state.rules = { ...state.rules, ...(message.rules || {}) };
    state.selectedShipIds.clear();
    dom.roomCode.value = message.room;
    dom.currentRoomCode.textContent = message.room;
    dom.currentRoomCard.hidden = false;
    dom.roomLabel.textContent = message.room;
    clearMenuNotice();
    rememberActiveRoom(message.room);
    setConnectionStatus("online", "Room linked");
    updateLobbyState();
    openLobbyManagement();
    return;
  }

  if (message.type === "state") {
    const previousPhase = state.phase;
    state.snapshot = message;
    state.room = message.room;
    state.world = message.world || state.world;
    state.map = message.map || state.map;
    state.phase = message.phase || state.phase;
    state.adminId = message.adminId || state.adminId;
    state.rules = { ...state.rules, ...(message.rules || {}) };
    dom.roomLabel.textContent = message.room;
    reconcilePendingPurchasesWithSnapshot();
    pruneSelection();
    updateHud();
    renderScoreboard();
    updateEconomyUi();
    renderSavedDesigns();
    updateLobbyState();
    updateWinnerBanner();
    if (previousPhase !== state.phase && (state.phase === "design" || state.phase === "active")) hideMenuScreens();
    return;
  }

  if (message.type === "purchaseResult") {
    const pending = message.requestId ? clearPendingPurchase(message.requestId) : null;
    if (message.ok) {
      const count = Number(message.count) || pending?.count || 1;
      const totalCost = Number(message.totalCost) || 0;
      showToast(`Built ${count} ship${count === 1 ? "" : "s"}${totalCost ? ` for $${totalCost}` : ""}`, "good");
    } else {
      const reason = message.message || "Purchase failed";
      if (pending?.optionId) setPurchaseError(pending.optionId, reason);
      showToast(reason, "error");
    }
    renderPurchaseBar();
    return;
  }

  if (message.type === "pong") {
    if (message.at) {
      state.latency = performance.now() - message.at;
      state.lastPongAt = performance.now();
    }
    return;
  }

  if (message.type === "notice") {
    if (message.requestId) clearPendingPurchase(message.requestId);
    addNotice(message.message, "good");
    return;
  }

  if (message.type === "error") {
    if (message.requestId) clearPendingPurchase(message.requestId);
    if (/closed|kicked/i.test(message.message || "")) forgetActiveRoom();
    if (!state.room || !dom.mainMenuScreen?.hidden) {
      showMenuNotice(message.message || "Server error", "error");
      setConnectionStatus("error", "Join failed");
      updateLobbyState();
      return;
    }
    addNotice(message.message || "Server error", "error");
    return;
  }

  if (message.type === "kicked" || message.type === "closed" || message.type === "leftLobby") {
    const tone = message.type === "kicked" ? "error" : "warning";
    forgetActiveRoom();
    returnToMainMenu(message.message || "Left lobby", tone);
  }
}

function rememberActiveRoom(roomCode) {
  if (roomCode) localStorage.setItem(LOCAL_ACTIVE_ROOM_KEY, String(roomCode).toUpperCase());
}

function forgetActiveRoom() {
  localStorage.removeItem(LOCAL_ACTIVE_ROOM_KEY);
}

function renderPalette() {
  dom.palette.textContent = "";
  const tabs = document.createElement("div");
  tabs.className = "part-category-tabs";
  for (const category of PART_CATEGORIES) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = category === state.selectedPartCategory ? "active" : "";
    tab.textContent = category;
    tab.addEventListener("click", () => {
      state.selectedPartCategory = category;
      const first = Object.keys(PART_DEFS).find((type) => type !== "core" && partCategory(type) === category);
      if (first) state.selectedPart = first;
      renderPalette();
      renderPartInspector();
    });
    tabs.appendChild(tab);
  }
  dom.palette.appendChild(tabs);

  const list = document.createElement("div");
  list.className = "part-category-list";
  for (const type of Object.keys(PART_DEFS)) {
    if (type === "core") continue;
    if (partCategory(type) !== state.selectedPartCategory) continue;
    const stat = PART_STATS[type];
    const button = document.createElement("button");
    button.type = "button";
    button.className = `part-button${state.selectedPart === type ? " active" : ""}`;
    button.title = `${PART_DEFS[type].name} | ${partCategory(type)} | cost ${stat.cost} | mass ${stat.mass}`;
    button.innerHTML = `${partIconMarkup(type)}<span class="part-name">${PART_DEFS[type].name}</span>`;
    button.addEventListener("click", () => {
      state.selectedPart = type;
      state.selectedPartCategory = partCategory(type);
      renderPalette();
      renderPartInspector();
    });
    list.appendChild(button);
  }
  dom.palette.appendChild(list);
}

function partCategory(type) {
  const stat = PART_STATS[type] || {};
  if (stat.category) return stat.category;
  if (type === "frame" || type === "armor") return "Structure";
  if (type === "reactor" || type === "battery") return "Power";
  if (type === "engine") return "Engines";
  if (type === "shield") return "Defence";
  if (stat.weapon) return "Weapons";
  if (type === "repair") return "Support";
  return "Utility";
}

function renderPartInspector() {
  const type = state.selectedPart;
  const def = PART_DEFS[type] || PART_DEFS.frame;
  const stat = PART_STATS[type] || PART_STATS.frame;
  const effectiveCost = effectivePartCostLabel(type);
  const details = partInspectorDetails(type, stat, effectiveCost);
  dom.partInspector.innerHTML = `
    <div class="part-inspector-title">
      ${partIconMarkup(type, "inspector-glyph")}
      <strong>${escapeHtml(def.name)}</strong>
    </div>
    <div class="part-category-label">${escapeHtml(partCategory(type))}</div>
    <p class="part-description">${escapeHtml(stat.description || "")}</p>
    <div class="part-inspector-grid">
      ${inspectorStat("Cost", effectiveCost)}
      ${inspectorStat("Mass", formatMass(stat.mass))}
      ${inspectorStat("Hull", formatHull(stat.hp))}
      ${inspectorStat("Power", partPowerText(stat))}
      ${inspectorStat("Shield", formatShield(stat.shield))}
      ${inspectorStat("Thrust", formatThrust(stat.thrust))}
      ${inspectorStat("Storage", formatEnergy(stat.energyStorage))}
      ${inspectorStat("Repair", formatRepair(stat.repairRate))}
    </div>
    <div class="part-detail-list">
      ${details.map(([label, value]) => inspectorDetail(label, value)).join("")}
    </div>
    <div class="part-best-use"><span>Best use</span>${escapeHtml(stat.bestUse || "Flexible ship system.")}</div>
    ${stat.drawback ? `<div class="part-best-use drawback"><span>Drawback</span>${escapeHtml(stat.drawback)}</div>` : ""}
  `;
}

function inspectorStat(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function inspectorDetail(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function partPowerText(stat) {
  const generation = stat.powerGeneration || 0;
  const use = stat.powerUse || 0;
  if (generation && use) return `+${generation} MW / -${use} MW`;
  if (generation) return `+${generation} MW`;
  if (use) return `-${use} MW`;
  return "0 MW";
}

function partInspectorDetails(type, stat, effectiveCost) {
  if (stat.weapon) {
    const weapon = stat.weapon;
    return [
      ["Damage", formatDamage(weapon.damage)],
      ["Range", formatDistance(weapon.range)],
      ["Fire rate", `${weapon.fireRate} shots/s`],
      ["Reload", `${weapon.reload}s`],
      ["DPS", weapon.dps.toFixed(1)],
      ["Projectile speed", formatSpeed(weapon.projectileSpeed)],
      ["Accuracy", `${Math.round(weapon.accuracy * 100)}%`],
      ["Tracking", weapon.tracking ? `${Math.round(weapon.tracking * 100)}%` : "None"],
      ["Arc", `${weapon.arc || 360} deg`],
      ["Default facing", "Forward / editor up"],
      ["Power use", formatPowerUse(stat.powerUse)]
    ];
  }

  if (type === "engine") {
    return [
      ["Thrust", formatThrust(stat.thrust)],
      ["Mass", formatMass(stat.mass)],
      ["Speed contribution", "Total thrust / total mass"],
      ["Power use", formatPowerUse(stat.powerUse)]
    ];
  }

  if (type === "reactor") {
    return [
      ["Power generation", formatPowerGeneration(stat.powerGeneration)],
      ["Energy storage", formatEnergy(stat.energyStorage)],
      ["Explosion risk", stat.explosionRisk || "Not implemented"],
      ["Mass", formatMass(stat.mass)]
    ];
  }

  if (type === "battery") {
    return [
      ["Energy storage", formatEnergy(stat.energyStorage)],
      ["Shield", formatShield(stat.shield)],
      ["Recharge", `${stat.shieldRegen}/s`],
      ["Power generation", formatPowerGeneration(stat.powerGeneration)]
    ];
  }

  if (type === "shield") {
    return [
      ["Shield amount", formatShield(stat.shield)],
      ["Recharge rate", `${stat.shieldRegen}/s`],
      ["Power draw", formatPowerUse(stat.powerUse)],
      ["Mass", formatMass(stat.mass)]
    ];
  }

  if (type === "repair") {
    return [
      ["Repair rate", formatRepair(stat.repairRate)],
      ["Power use", formatPowerUse(stat.powerUse)],
      ["Shield", formatShield(stat.shield)],
      ["Mass", formatMass(stat.mass)]
    ];
  }

  return [
    ["Hull", formatHull(stat.hp)],
    ["Mass", formatMass(stat.mass)],
    ["Cost", effectiveCost],
    ["Power", partPowerText(stat)]
  ];
}

function formatMass(value) {
  return `${Number(value) || 0} T`;
}

function formatHull(value) {
  return `${Number(value) || 0} HP`;
}

function formatShield(value) {
  return `${Number(value) || 0} SP`;
}

function formatThrust(value) {
  return `${Number(value) || 0} kN`;
}

function formatEnergy(value) {
  return `${Number(value) || 0} MJ`;
}

function formatRepair(value) {
  return `${Number(value) || 0} HP/s`;
}

function formatPowerUse(value) {
  return `${Number(value) || 0} MW`;
}

function formatPowerGeneration(value) {
  return `+${Number(value) || 0} MW`;
}

function formatDistance(value) {
  return `${Number(value) || 0} m`;
}

function formatSpeed(value) {
  return `${Number(value) || 0} m/s`;
}

function formatDamage(value) {
  return `${Number(value) || 0} dmg`;
}

function effectivePartCostLabel(type) {
  return `$${estimatePartEffectiveCost(type)}`;
}

function estimatePartEffectiveCost(type) {
  const current = computeStats(state.design);
  const occupied = new Set(state.design.map((part) => `${part.x},${part.y}`));
  for (const part of state.design) {
    const candidates = [
      { x: part.x + 1, y: part.y },
      { x: part.x - 1, y: part.y },
      { x: part.x, y: part.y + 1 },
      { x: part.x, y: part.y - 1 }
    ];
    for (const cell of candidates) {
      const key = `${cell.x},${cell.y}`;
      if (cell.x < 0 || cell.x > 6 || cell.y < 0 || cell.y > 6 || occupied.has(key)) continue;
      const next = [...state.design, { x: cell.x, y: cell.y, type }];
      if (!isConnected(next)) continue;
      const updated = computeStats(next);
      return Math.max(0, updated.unitCost - current.unitCost);
    }
  }
  return estimateFormulaPartCost(type);
}

function estimateFormulaPartCost(type) {
  const stat = PART_STATS[type] || PART_STATS.frame;
  const weaponPremium =
    (stat.blaster || 0) * SHIP_ECONOMY.weaponPremiums.blaster +
    (stat.missile || 0) * SHIP_ECONOMY.weaponPremiums.missile +
    (stat.railgun || 0) * SHIP_ECONOMY.weaponPremiums.railgun;
  return Math.max(1, Math.round(
    stat.cost * SHIP_ECONOMY.partCostMultiplier +
    stat.mass * SHIP_ECONOMY.massCostMultiplier +
    stat.hp * SHIP_ECONOMY.hullCostMultiplier +
    stat.shield * SHIP_ECONOMY.shieldCostMultiplier +
    (stat.repairRate || 0) * SHIP_ECONOMY.repairCostMultiplier +
    weaponPremium
  ));
}

function partIconMarkup(type, extraClass = "") {
  const safeType = String(type || "frame").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  const classes = ["part-glyph", `part-${safeType}`, extraClass].filter(Boolean).join(" ");
  const glyph = PART_DEFS[type]?.glyph;
  const style = glyph ? ` style="background:${escapeHtml(glyph)}"` : "";
  return `<span class="${classes}"${style} aria-hidden="true"><span></span></span>`;
}

function makeWeapon(type, stats) {
  const fireRate = Number(stats.fireRate) || 1;
  const damage = Number(stats.damage) || 0;
  return {
    type,
    damage,
    fireRate,
    reload: Number((1 / fireRate).toFixed(2)),
    range: stats.range,
    projectileSpeed: stats.projectileSpeed,
    accuracy: stats.accuracy,
    tracking: stats.tracking || 0,
    arc: Number(stats.arc) || 360,
    dps: Number((damage * fireRate).toFixed(1))
  };
}

function renderBuildGrid() {
  dom.grid.textContent = "";
  const byCell = new Map(state.design.map((part) => [`${part.x},${part.y}`, part]));

  for (let y = 0; y < 7; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      const part = byCell.get(`${x},${y}`);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = `build-cell${part ? ` occupied ${part.type}` : ""}`;
      cell.title = part ? `${PART_DEFS[part.type].name}${isRotatablePart(part.type) ? ` | ${normalizeRotation(part.rotation)} deg` : ""}` : "Empty";
      if (part) {
        cell.innerHTML = `${partIconMarkup(part.type, "build-glyph")}${isRotatablePart(part.type) ? `<span class="rotation-marker rot-${normalizeRotation(part.rotation)}">▲</span>` : ""}`;
      }
      cell.addEventListener("mouseenter", () => {
        state.hoveredCell = { x, y };
      });
      cell.addEventListener("mouseleave", () => {
        if (state.hoveredCell?.x === x && state.hoveredCell?.y === y) state.hoveredCell = null;
      });
      cell.addEventListener("click", () => editCell(x, y));
      cell.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        removeCell(x, y);
      });
      dom.grid.appendChild(cell);
    }
  }
}

function editCell(x, y) {
  const existing = state.design.find((part) => part.x === x && part.y === y);
  if (existing?.type === "core") return;
  state.selectedCell = { x, y };

  if (existing) {
    const next = state.design.map((part) => part.x === x && part.y === y ? makeDesignPart(x, y, state.selectedPart, part.rotation) : part);
    if (isConnected(next)) {
      state.design = next;
    } else {
      const message = explainConnectionProblem(next, x, y, true);
      setBuildStatus(message, "warning");
      showToast(message, "warning");
      return;
    }
  } else {
    const next = [...state.design, makeDesignPart(x, y, state.selectedPart)];
    if (isConnected(next)) {
      state.design = next;
    } else {
      const message = explainConnectionProblem(next, x, y, false);
      setBuildStatus(message, "warning");
      showToast(message, "warning");
      return;
    }
  }

  persistDesign();
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
}

function makeDesignPart(x, y, type, previousRotation = 0) {
  const rotation = isRotatablePart(type) ? normalizeRotation(previousRotation) : 0;
  return { x, y, type, rotation };
}

function isRotatablePart(type) {
  const stat = PART_STATS[type] || {};
  return Boolean(stat.rotationRequired || stat.weapon);
}

function normalizeRotation(value) {
  const rotation = Number(value);
  return [0, 90, 180, 270].includes(rotation) ? rotation : 0;
}

function rotateFocusedPart() {
  const cell = state.hoveredCell || state.selectedCell;
  if (!cell) return;
  const part = state.design.find((candidate) => candidate.x === cell.x && candidate.y === cell.y);
  if (!part || !isRotatablePart(part.type)) return;
  state.design = state.design.map((candidate) => candidate === part
    ? { ...candidate, rotation: (normalizeRotation(candidate.rotation) + 90) % 360 }
    : candidate);
  persistDesign();
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
}

function removeCell(x, y) {
  const existing = state.design.find((part) => part.x === x && part.y === y);
  if (!existing || existing.type === "core") return;
  const next = state.design.filter((part) => part.x !== x || part.y !== y);
  if (isConnected(next)) {
    state.design = next;
    persistDesign();
    renderBuildGrid();
    renderLocalStats();
    renderSavedDesigns();
  } else {
    const message = "Removing that part would disconnect modules from the core";
    setBuildStatus(message, "warning");
    showToast(message, "warning");
  }
}

function resetDesign() {
  state.design = defaultDesign();
  state.loadedEditorBlueprintId = null;
  persistDesign();
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
}

function saveCurrentDesign(name = "") {
  const stats = computeStats(state.design);
  const now = Date.now();
  const existingIndex = state.savedDesigns.findIndex((design) => design.id === state.loadedEditorBlueprintId);
  const existing = existingIndex >= 0 ? state.savedDesigns[existingIndex] : null;
  const cleanName = String(name || "").trim() || existing?.name || nextDesignName();
  const design = {
    id: existing?.id || makeDesignId(),
    name: cleanName.slice(0, 28),
    blueprint: state.design.map((part) => ({ ...part })),
    cost: stats.unitCost,
    weapons: `${stats.blaster}/${stats.missile}/${stats.railgun}`,
    speed: Math.round(stats.maxSpeed),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  state.savedDesigns = existing
    ? state.savedDesigns.map((saved) => saved.id === design.id ? design : saved)
    : [design, ...state.savedDesigns];
  state.loadedEditorBlueprintId = design.id;
  persistSavedDesigns();
  renderSavedDesigns();
  updateEconomyUi();
  showToast(`${existing ? "Updated" : "Saved"} ${design.name}`, "good");
}

function saveBlueprintButtonText() {
  const existing = state.savedDesigns.find((design) => design.id === state.loadedEditorBlueprintId);
  return existing ? `Update "${existing.name}"` : "Save Blueprint";
}

function loadSavedDesign(id) {
  const saved = state.savedDesigns.find((design) => design.id === id);
  if (!saved) return;
  const valid = normalizeDesign(saved.blueprint);
  state.design = valid;
  state.loadedEditorBlueprintId = saved.id;
  persistDesign();
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
  updateEconomyUi();
  showToast(`Editing ${saved.name}`, "good");
}

function syncBlueprintToServer(blueprint) {
  if (state.socket?.readyState !== WebSocket.OPEN) return;
  if (state.phase !== "active" && state.phase !== "design") return;
  send({ type: "deploy", design: blueprint });
}

function handleSavedDesignPointerDown(event) {
  if (event.button !== undefined && event.button !== 0) return;
  const button = event.target?.closest?.("[data-saved-action]");
  if (!button || !dom.savedDesignList?.contains(button)) return;
  event.preventDefault();
  clearSavedDesignPressedButtons();
  button.classList.add("pressed");
  state.savedDesignPointer = {
    action: button.dataset.savedAction || "",
    id: button.dataset.savedId || "",
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY
  };
  try {
    dom.savedDesignList.setPointerCapture?.(event.pointerId);
  } catch {
    // Pointer capture is best-effort; keyboard activation still uses the click fallback.
  }
}

function handleSavedDesignPointerUp(event) {
  const pointer = state.savedDesignPointer;
  if (!pointer || pointer.pointerId !== event.pointerId) return;
  clearSavedDesignPointer();
  try {
    dom.savedDesignList.releasePointerCapture?.(event.pointerId);
  } catch {
    // The browser may already have released capture while the list updates.
  }
  const moved = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
  const bounds = dom.savedDesignList.getBoundingClientRect();
  const releasedInside = event.clientX >= bounds.left
    && event.clientX <= bounds.right
    && event.clientY >= bounds.top
    && event.clientY <= bounds.bottom;
  if (moved > 12 || !releasedInside) return;
  event.preventDefault();
  runSavedDesignAction(pointer.action, pointer.id);
}

function clearSavedDesignPointer() {
  clearSavedDesignPressedButtons();
  state.savedDesignPointer = null;
}

function clearSavedDesignPressedButtons() {
  dom.savedDesignList?.querySelectorAll?.("[data-saved-action].pressed")?.forEach((button) => {
    button.classList.remove("pressed");
  });
}

function handleSavedDesignKeyboardClick(event) {
  if (event.detail !== 0) return;
  const button = event.target?.closest?.("[data-saved-action]");
  if (!button || !dom.savedDesignList?.contains(button)) return;
  event.preventDefault();
  runSavedDesignAction(button.dataset.savedAction || "", button.dataset.savedId || "");
}

function runSavedDesignAction(action, id) {
  if (action === "load") loadSavedDesign(id);
  else if (action === "delete") deleteSavedDesign(id);
}

function isSavedDesignNameFocused() {
  return Boolean(document.activeElement?.classList?.contains("saved-design-name"));
}

function renameSavedDesign(id, name) {
  const saved = state.savedDesigns.find((design) => design.id === id);
  if (!saved) return;
  const cleanName = String(name || "").trim().slice(0, 28);
  if (!cleanName || cleanName === saved.name) return;
  state.savedDesigns = state.savedDesigns.map((design) => design.id === id
    ? { ...design, name: cleanName, updatedAt: Date.now() }
    : design);
  persistSavedDesigns();
  renderPurchaseBar();
  if (state.loadedEditorBlueprintId === id && dom.saveDesignButton) {
    dom.saveDesignButton.textContent = saveBlueprintButtonText();
  }
}

function deleteSavedDesign(id) {
  const saved = state.savedDesigns.find((design) => design.id === id);
  if (!saved) return;
  openDeleteDesignModal(saved);
}

function openDeleteDesignModal(saved) {
  state.pendingDeleteDesignId = saved.id;
  state.pendingKickTargetId = null;
  if (dom.confirmModalTitle) dom.confirmModalTitle.textContent = "Delete blueprint?";
  if (dom.confirmModalMessage) dom.confirmModalMessage.textContent = `Delete ${saved.name}? This cannot be undone.`;
  if (dom.confirmAcceptButton) dom.confirmAcceptButton.textContent = "Delete";
  if (dom.confirmModal) dom.confirmModal.hidden = false;
  dom.confirmCancelButton?.focus?.();
}

function closeConfirmModal() {
  state.pendingDeleteDesignId = null;
  state.pendingKickTargetId = null;
  if (dom.confirmModal) dom.confirmModal.hidden = true;
}

function confirmModalAction() {
  if (state.pendingKickTargetId) {
    const targetId = state.pendingKickTargetId;
    closeConfirmModal();
    send({ type: "kick", targetId });
    return;
  }
  const id = state.pendingDeleteDesignId;
  const saved = state.savedDesigns.find((design) => design.id === id);
  if (!saved) {
    closeConfirmModal();
    return;
  }
  state.savedDesigns = state.savedDesigns.filter((design) => design.id !== id);
  if (state.loadedEditorBlueprintId === id) state.loadedEditorBlueprintId = null;
  persistSavedDesigns();
  closeConfirmModal();
  renderSavedDesigns();
  updateEconomyUi();
  showToast(`Deleted ${saved.name}`, "warning");
}

function renderSavedDesigns() {
  if (!dom.savedDesignList) return;
  if (isSavedDesignNameFocused()) return;
  dom.savedDesignList.textContent = "";
  if (!state.savedDesigns.length) {
    const empty = document.createElement("div");
    empty.className = "saved-design-empty";
    empty.textContent = "No saved blueprints yet";
    dom.savedDesignList.appendChild(empty);
    renderPurchaseBar();
    return;
  }

  for (const saved of state.savedDesigns) {
    const stats = computeStats(saved.blueprint);
    const row = document.createElement("div");
    row.className = "saved-design-card";
    row.innerHTML = `
      <div class="saved-design-head">
        <input class="saved-design-name" value="${escapeHtml(saved.name)}" maxlength="28" aria-label="Blueprint name">
      </div>
      <div class="saved-design-summary">Cost $${stats.unitCost} · Weapons (${weaponAbbrevText(stats)}) · Speed ${formatSpeed(Math.round(stats.maxSpeed))}</div>
      <div class="saved-design-actions">
        <button type="button" data-saved-action="load" data-saved-id="${escapeHtml(saved.id)}">Use/Edit</button>
        <button type="button" data-saved-action="delete" data-saved-id="${escapeHtml(saved.id)}">Delete</button>
      </div>
    `;
    const nameInput = row.querySelector(".saved-design-name");
    nameInput?.addEventListener("pointerdown", (event) => event.stopPropagation());
    nameInput?.addEventListener("click", (event) => event.stopPropagation());
    nameInput?.addEventListener("change", () => renameSavedDesign(saved.id, nameInput.value));
    nameInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") nameInput.blur();
      event.stopPropagation();
    });
    dom.savedDesignList.appendChild(row);
  }
  renderPurchaseBar();
}

function makeDesignId() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function nextDesignName() {
  const used = new Set(state.savedDesigns.map((design) => design.name.toLowerCase()));
  for (let index = 1; index < 999; index += 1) {
    const name = `Design ${index}`;
    if (!used.has(name.toLowerCase())) return name;
  }
  return `Design ${state.savedDesigns.length + 1}`;
}

function renderLocalStats() {
  const stats = computeStats(state.design);
  const status = getShipStatus(stats);
  const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
  const money = currentMatchMoney(mine);
  const canAfford = money >= stats.unitCost;
  if (dom.saveDesignButton) dom.saveDesignButton.textContent = saveBlueprintButtonText();
  if (dom.blueprintCostLabel) dom.blueprintCostLabel.textContent = `$${stats.unitCost}`;
  if (dom.blueprintCostStatus) {
    dom.blueprintCostStatus.textContent = canAfford
      ? `Remaining after first ship $${Math.floor(money - stats.unitCost)}`
      : `Need $${Math.ceil(stats.unitCost - money)} before first ship`;
    dom.blueprintCostStatus.className = canAfford ? "affordable" : "expensive";
  }
  dom.stats.innerHTML = [
    statMarkup("Fleet", stats.fleetCount),
    statMarkup("Hull", formatHull(stats.maxHp)),
    statMarkup("Shield", formatShield(stats.maxShield)),
    statMarkup("Speed", formatSpeed(Math.round(stats.maxSpeed))),
    statMarkup("Power", `${stats.powerGeneration}/${stats.powerUse} MW`),
    statMarkup("Thrust/Mass", `${stats.thrustRatio} kN/T`),
    statMarkup("Weapons", weaponAbbrevText(stats)),
    statMarkup("Repair", formatRepair(stats.repairRate)),
    statMarkup("Mass", formatMass(stats.mass)),
    costBreakdownMarkup(stats.costBreakdown)
  ].join("");

  renderShipIssues(status);
  setBuildStatus(status.blockers.length ? status.blockers[0] : stats.warnings.length ? stats.warnings[0] : "Blueprint ready", status.blockers.length ? "error" : stats.warnings.length ? "warning" : "good");
  updateEconomyUi();
}

function getShipStatus(stats) {
  const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
  const blockers = [];
  const money = currentMatchMoney(mine);
  const isActiveBuild = state.phase === "active";
  const hasCore = state.design.filter((part) => part.type === "core").length === 1;

  if (!state.design.length) blockers.push("Invalid design: blueprint is empty.");
  if (!hasCore) blockers.push("Invalid design: missing core.");
  if (!isConnected(state.design)) blockers.push("Invalid design: disconnected parts.");
  if (money < stats.unitCost) blockers.push(`${isActiveBuild ? "Cannot afford ship" : "Cannot ready design"}. Need $${Math.ceil(stats.unitCost - money)} more.`);

  const warnings = [...stats.warnings];
  if (money > 0 && stats.unitCost > money * 0.75) warnings.push("High cost for current money.");
  if (stats.maxShield < 35 && stats.maxHp < 210) warnings.push("Weak defence: low combined hull and shield.");

  return { blockers, warnings };
}

function renderShipIssues(status) {
  if (!dom.shipIssuesPanel) return;
  const isDesignStage = state.phase === "design";
  const stateText = status.blockers.length
    ? isDesignStage ? "Cannot Ready" : "Cannot Build"
    : status.warnings.length
      ? isDesignStage ? "Ready, with warnings" : "Ready to Build, with warnings"
      : isDesignStage ? "Ready" : "Ready to Build";
  dom.shipIssuesPanel.className = `ship-issues-panel ${status.blockers.length ? "blocked" : status.warnings.length ? "warning" : "ready"}`;
  dom.shipIssuesPanel.innerHTML = `
    <div class="ship-issues-title"><span>Ship Status</span><strong>${stateText}</strong></div>
    ${issueListMarkup("Blocking Issues", status.blockers)}
    ${issueListMarkup("Warnings", status.warnings)}
  `;
}

function currentMatchMoney(mine) {
  return mine ? Number(mine.money) || 0 : state.rules.startingMoney;
}

function issueListMarkup(title, issues) {
  if (!issues.length) return `<div class="issue-group empty"><span>${title}</span><p>None</p></div>`;
  return `
    <div class="issue-group">
      <span>${title}</span>
      <ul>${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>
    </div>
  `;
}

function setBuildStatus(text, className) {
  dom.buildStatus.textContent = text;
  dom.buildStatus.className = `build-status ${className || ""}`.trim();
}

function statMarkup(label, value) {
  return `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
}

function costBreakdownMarkup(breakdown) {
  if (!breakdown) return "";
  const rows = [
    ["Base", breakdown.base],
    ["Parts", breakdown.parts],
    ["Mass", breakdown.mass],
    ["Hull", breakdown.hull],
    ["Shield", breakdown.shield],
    ["Repair", breakdown.repair],
    ["Weapons", breakdown.weaponPremium],
    ["Size tax", breakdown.sizeTax]
  ];
  return `
    <details class="stat cost-breakdown">
      <summary>
        <span>Cost Breakdown</span>
        <strong>$${breakdown.total}</strong>
      </summary>
      <div class="cost-breakdown-grid">
        ${rows.map(([label, value]) => `
          <div>
            <span>${label}</span>
            <strong>$${value}</strong>
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

function updateHud() {
  if (!state.snapshot) return;
  const mine = state.snapshot.players.find((player) => player.id === state.myId);
  const myShips = state.snapshot.ships.filter((ship) => ship.ownerId === state.myId && ship.alive);
  const myTeam = mine?.team;
  const relays = state.snapshot.points.filter((point) => point.ownerTeam === myTeam && point.progress > 0.98).length;
  const income = mine?.income ?? 0;
  const target = currentTarget();
  dom.fleetLabel.textContent = `${myShips.length}`;
  dom.moneyHud.textContent = `$${mine?.money ?? 0}`;
  if (dom.incomeHud) {
    dom.incomeHud.textContent = `+$${Math.round(income)}/s`;
    dom.incomeHud.title = mine?.ready
      ? `Base income plus ${relays} captured relay${relays === 1 ? "" : "s"}. Money rises every second.`
      : "Ready with an affordable starting design to begin earning money.";
  }
  dom.relayLabel.textContent = String(relays);
  dom.selectionLabel.textContent = `${state.selectedShipIds.size}`;
  dom.objectiveLabel.textContent = target ? target.label : "None";
  dom.latency.textContent = state.latency == null ? "-- ms" : `${Math.round(state.latency)} ms`;
}

function updateEconomyUi() {
  const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
  const localStats = computeStats(state.design);
  const localStatus = getShipStatus(localStats);
  const money = currentMatchMoney(mine);
  const income = mine?.income ?? 0;
  const myTeam = mine?.team;
  const relays = state.snapshot?.points?.filter((point) => point.ownerTeam === myTeam && point.progress > 0.98).length || 0;
  const unitCost = localStats.unitCost;
  const canAfford = money >= unitCost;
  const canReady = state.phase === "design" && !mine?.ready && localStatus.blockers.length === 0;
  const canSaveActiveDesign = state.phase === "active" && Boolean(mine?.ready);

  if (dom.incomeHud) {
    dom.incomeHud.textContent = `+$${Math.round(income)}/s`;
    dom.incomeHud.title = mine?.ready
      ? `Base income plus ${relays} captured relay${relays === 1 ? "" : "s"}. Money rises every second.`
      : "Ready with an affordable starting design to begin earning money.";
  }
  dom.deployButton.hidden = state.phase === "active";
  dom.deployButton.disabled = !(canReady || canSaveActiveDesign);
  dom.deployButton.textContent = mine?.ready && state.phase === "design"
    ? "Ready"
    : state.phase === "design"
      ? localStatus.blockers.length ? readyBlockerButtonText(localStatus.blockers[0]) : `Ready with this design - $${unitCost}`
      : state.phase === "active"
        ? saveBlueprintButtonText()
        : saveBlueprintButtonText();

  if (mine) {
    const status = state.phase === "design"
      ? mine.ready ? "Ready. Waiting for the rest of the room." : "Design your starting ship, then ready with this design."
      : mine.ready
        ? economyStatusText({ income, relays, canAfford, unitCost, money })
        : "Waiting for ship design";
    if (!dom.buildStatus.className.includes("warning")) setBuildStatus(status, "good");
  }
  renderPurchaseBar();
}

function readyBlockerButtonText(reason) {
  if (/Need \$(\d+)/.test(reason)) return `Cannot Ready - Need $${reason.match(/Need \$(\d+)/)[1]}`;
  if (reason.includes("missing core")) return "Cannot Ready - Missing Core";
  if (reason.includes("disconnected")) return "Cannot Ready - Disconnected";
  if (reason.includes("blueprint is empty")) return "Cannot Ready - Empty Design";
  return "Cannot Ready";
}

function economyStatusText({ income, relays, canAfford, unitCost, money }) {
  if (!canAfford) return `Current editor design needs $${Math.ceil(unitCost - money)} more. Buy affordable ships from the bottom bar.`;
  return `Buy ships from the bottom bar. Earning +$${Math.round(income)}/s: base income${relays ? ` + ${relays} relay bonus` : ""}`;
}

function getPurchaseOptions() {
  return [
    {
      id: "current",
      name: "Current Design",
      source: "editor",
      blueprint: state.design.map((part) => ({ ...part })),
      stats: computeStats(state.design)
    },
    ...state.savedDesigns.map((saved) => ({
      id: saved.id,
      name: saved.name,
      source: "saved",
      blueprint: normalizeDesign(saved.blueprint).map((part) => ({ ...part })),
      stats: computeStats(saved.blueprint)
    }))
  ];
}

function getPurchaseOptionState(option, quantity = state.purchaseQuantity) {
  const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
  const money = currentMatchMoney(mine);
  const activeShips = mine?.activeShips ?? 0;
  const shipCap = mine?.shipCap ?? state.rules.shipCap ?? 20;
  const remainingSlots = Math.max(0, shipCap - activeShips);
  const totalCost = option.stats.unitCost * quantity;
  const validity = validateBlueprintForPurchase(option.blueprint);
  const pending = getPendingPurchaseForOption(option.id);
  const error = state.purchaseErrors.get(option.id);
  let reason = "";

  if (pending) reason = "Building...";
  else if (error) reason = error.message || "Purchase failed";
  else if (state.phase !== "active") reason = "Match not active";
  else if (!mine?.ready) reason = "Not ready";
  else if (!validity.ok) reason = validity.reason;
  else if (activeShips + quantity > shipCap) reason = quantity === 1 ? "Fleet full" : `Need ${quantity} slots`;
  else if (money < totalCost) reason = `Need $${Math.ceil(totalCost - money)}`;

  return {
    money,
    activeShips,
    shipCap,
    remainingSlots,
    totalCost,
    pending,
    error,
    canBuy: reason === "",
    reason
  };
}

function getPendingPurchaseForOption(optionId) {
  for (const pending of state.pendingPurchases.values()) {
    if (pending.optionId === optionId) return pending;
  }
  return null;
}

function validateBlueprintForPurchase(blueprint) {
  if (!Array.isArray(blueprint) || blueprint.length === 0) return { ok: false, reason: "Invalid design" };
  if (blueprint.filter((part) => part.type === "core").length !== 1) return { ok: false, reason: "Invalid core" };
  if (!isConnected(blueprint)) return { ok: false, reason: "Disconnected" };
  return { ok: true, reason: "" };
}

function renderPurchaseBar() {
  if (!dom.purchaseBar || !dom.purchaseOptions) return;
  dom.purchaseQuantityOne?.classList?.toggle("active", state.purchaseQuantity === 1);
  dom.purchaseQuantityFive?.classList?.toggle("active", state.purchaseQuantity === 5);
  dom.purchaseQuantityOne?.setAttribute?.("aria-pressed", String(state.purchaseQuantity === 1));
  dom.purchaseQuantityFive?.setAttribute?.("aria-pressed", String(state.purchaseQuantity === 5));
  dom.purchaseOptions.textContent = "";

  for (const option of getPurchaseOptions()) {
    const optionState = getPurchaseOptionState(option, state.purchaseQuantity);
    const card = document.createElement("button");
    card.type = "button";
    card.className = `purchase-option ${optionState.pending ? "pending" : optionState.error ? "error" : optionState.canBuy ? "ready" : "disabled"}`;
    card.setAttribute?.("aria-disabled", String(!optionState.canBuy));
    if (card.dataset) card.dataset.optionId = option.id;
    card.innerHTML = `
      <strong>${escapeHtml(option.name)}</strong>
      <span>${purchaseCostText(option, optionState)}</span>
      <small>${weaponSummaryText(option.stats)}</small>
      <em>${optionState.pending ? "Building..." : optionState.canBuy ? "Ready" : escapeHtml(optionState.reason)}</em>
    `;
    card.addEventListener?.("mouseenter", (event) => showPurchaseTooltip(option.id, event));
    card.addEventListener?.("mousemove", (event) => positionPurchaseTooltip(event));
    card.addEventListener?.("mouseleave", hidePurchaseTooltip);
    card.addEventListener?.("focus", (event) => showPurchaseTooltip(option.id, event));
    card.addEventListener?.("blur", hidePurchaseTooltip);
    dom.purchaseOptions.appendChild(card);
  }
}

function purchaseCostText(option, optionState) {
  if (state.purchaseQuantity === 1) return `$${option.stats.unitCost}`;
  return `$${option.stats.unitCost} each | $${optionState.totalCost} total`;
}

function weaponAbbrevText(stats) {
  return `${Number(stats.blaster) || 0}b/${Number(stats.missile) || 0}m/${Number(stats.railgun) || 0}r`;
}

function weaponSummaryText(stats) {
  return `(${weaponAbbrevText(stats)})`;
}

function showPurchaseTooltip(optionId, event) {
  const option = getPurchaseOptions().find((candidate) => candidate.id === optionId);
  if (!option || !dom.purchaseTooltip) return;
  const optionState = getPurchaseOptionState(option, state.purchaseQuantity);
  const stats = option.stats;
  dom.purchaseTooltip.innerHTML = `
    <div class="purchase-tooltip-head">
      <strong>${escapeHtml(option.name)}</strong>
      <span>${escapeHtml(inferShipRole(stats))}</span>
    </div>
    <div class="purchase-tooltip-status ${optionState.canBuy ? "ready" : "blocked"}">
      <span>${optionState.canBuy ? "Can buy" : "Cannot buy"}</span>
      <strong>${optionState.canBuy ? `$${optionState.totalCost}` : escapeHtml(optionState.reason)}</strong>
    </div>
    <div class="purchase-tooltip-grid">
      ${tooltipStat("Cost", `$${stats.unitCost}`)}
      ${state.purchaseQuantity > 1 ? tooltipStat("Total", `$${optionState.totalCost}`) : ""}
      ${tooltipStat("Hull", formatHull(stats.maxHp))}
      ${tooltipStat("Shield", `${formatShield(stats.maxShield)} (+${stats.shieldRegen}/s)`)}
      ${tooltipStat("Speed", formatSpeed(Math.round(stats.maxSpeed)))}
      ${tooltipStat("Turn", stats.turnRate.toFixed(2))}
      ${tooltipStat("Mass", formatMass(stats.mass))}
      ${tooltipStat("Power", `${stats.powerGeneration}/${stats.powerUse} MW`)}
      ${tooltipStat("Energy", formatEnergy(stats.energyStorage))}
      ${tooltipStat("Repair", formatRepair(stats.repairRate))}
      ${tooltipStat("Weapons", weaponSummaryText(stats))}
      ${tooltipStat("DPS", stats.weaponDps)}
    </div>
  `;
  dom.purchaseTooltip.hidden = false;
  positionPurchaseTooltip(event);
}

function tooltipStat(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function positionPurchaseTooltip(event) {
  if (!dom.purchaseTooltip || dom.purchaseTooltip.hidden) return;
  const margin = 14;
  const rect = dom.purchaseTooltip.getBoundingClientRect();
  const sourceRect = event.currentTarget?.getBoundingClientRect?.();
  const pointerX = event.clientX || sourceRect?.left || window.innerWidth / 2;
  const pointerY = event.clientY || sourceRect?.top || window.innerHeight / 2;
  const left = clamp(pointerX + 14, margin, window.innerWidth - rect.width - margin);
  const top = clamp(pointerY - rect.height - 12, margin, window.innerHeight - rect.height - margin);
  dom.purchaseTooltip.style.left = `${left}px`;
  dom.purchaseTooltip.style.top = `${top}px`;
}

function hidePurchaseTooltip() {
  if (dom.purchaseTooltip) dom.purchaseTooltip.hidden = true;
}

function inferShipRole(stats) {
  const weapons = stats.blaster + stats.missile + stats.railgun;
  if (stats.repair > 0 && stats.weaponDps < 30) return "Support";
  if (stats.railgun >= Math.max(stats.blaster, stats.missile) && stats.railgun > 0) return "Rail Platform";
  if (stats.missile >= Math.max(stats.blaster, stats.railgun) && stats.missile > 0) return "Missile Boat";
  if (stats.maxHp + stats.maxShield > 700 && stats.maxSpeed < 190) return "Heavy Tank";
  if (stats.maxSpeed > 250 && stats.unitCost < 420) return "Fast Scout";
  if (weapons > 0) return "Brawler";
  return "Utility";
}

function currentTarget() {
  if (!state.command) return null;
  if (state.command.targetName) return { label: state.command.targetName };
  return { label: `${Math.round(state.command.x)},${Math.round(state.command.y)}` };
}

function renderScoreboard() {
  if (!state.snapshot) return;
  const players = [...state.snapshot.players].sort((a, b) => b.score - a.score);
  dom.scoreList.textContent = "";
  updateMatchMeter(players);
  renderObjectiveSummary();
  renderTeamPanel(players);
}

function renderObjectiveSummary() {
  const players = playerMap();
  const lines = state.snapshot.points.map((point) => {
    const owner = point.ownerId ? players.get(point.ownerId) : null;
    const ownerName = point.contested ? "Contested" : owner ? owner.teamName || owner.name : "Neutral";
    return `${point.id}: ${ownerName} ${Math.round(point.progress * 100)}%`;
  });
  if (lines.length) {
    const row = document.createElement("div");
    row.className = "objective-summary";
    row.textContent = lines.join(" | ");
    dom.scoreList.appendChild(row);
  }
}

function renderTeamPanel(players) {
  const soloMode = state.rules?.gameMode === "solo";
  const teams = soloMode ? players.map((player) => player.team) : ["blue", "red"];
  for (const team of teams) {
    const teamPlayers = players.filter((player) => player.team === team);
    const score = Math.max(0, ...teamPlayers.map((player) => player.score || 0));
    const objectives = state.snapshot.points.filter((point) => point.ownerTeam === team && point.progress > 0.98);
    const pointsPerSecond = objectives.length * 6;
    const title = soloMode
      ? (teamPlayers[0]?.name || "Solo")
      : `${team.toUpperCase()} TEAM`;
    const card = document.createElement("div");
    card.className = `team-card ${soloMode ? "solo" : team}`;
    card.innerHTML = `
      <div class="team-card-head">
        <strong>${escapeHtml(title)}</strong>
        <span>${score}/${state.snapshot.maxScore || 900} (+${pointsPerSecond}/s)</span>
      </div>
      <div class="team-objectives">Objectives: ${objectives.length ? objectives.map((point) => point.id).join(", ") : "None"}</div>
    `;

    if (!soloMode && !teamPlayers.length) {
      const empty = document.createElement("div");
      empty.className = "team-player empty";
      empty.textContent = "Empty slot";
      card.appendChild(empty);
    }

    for (const player of teamPlayers) {
      const row = document.createElement("div");
      row.className = `team-player${player.id === state.myId ? " mine" : ""}`;
      const status = player.ready ? "Ready" : state.phase === "design" ? "Building" : player.connected === false ? "Disconnected" : "In match";
      const canKick = isAdmin() && player.id !== state.myId && !player.isAdmin;
      const infoItems = [];
      if (player.money != null) infoItems.push(`$${player.money}`);
      infoItems.push(`${player.activeShips} ship${player.activeShips === 1 ? "" : "s"}`);
      infoItems.push(`${player.score}/${state.snapshot.maxScore || 900}`);
      row.innerHTML = `
        <span class="score-color" style="background:${player.color}"></span>
        <div class="team-player-body">
          <div class="team-player-main">
            <strong>${escapeHtml(player.name)}${player.isAdmin ? " [Host]" : ""}${player.isBot ? " CPU" : ""}</strong>
            <span class="team-player-status">${status}</span>
          </div>
          <div class="team-player-metrics">
            ${infoItems.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
            <span>K ${player.kills} / L ${player.losses}</span>
          </div>
        </div>
        ${canKick ? `<button type="button" data-kick="${escapeHtml(player.id)}">Kick</button>` : ""}
      `;
      card.appendChild(row);
    }
    dom.scoreList.appendChild(card);
  }
}

function renderPlayerList() {
  if (!dom.playerList) return;
  const players = state.snapshot?.players || [];
  dom.playerList.textContent = "";
  if (!players.length) return;

  for (const player of players) {
    const row = document.createElement("div");
    row.className = `player-row${player.id === state.myId ? " mine" : ""}`;
    const canKick = isAdmin() && player.id !== state.myId && state.phase !== "active";
    const status = player.isAdmin ? "Admin" : player.ready ? "Ready" : state.phase === "design" ? "Designing" : player.isBot ? "Bot" : "Waiting";
    row.innerHTML = `
      <span class="score-color" style="background:${player.color}"></span>
      <div>
        <strong>${escapeHtml(player.name)}${player.id === state.myId ? " (you)" : ""}</strong>
        <span>${escapeHtml(state.rules?.gameMode === "solo" ? "No wing" : player.teamName || "Blue wing")} | ${status}</span>
      </div>
      ${canKick ? `<button type="button" data-kick="${escapeHtml(player.id)}">Kick</button>` : ""}
    `;
    dom.playerList.appendChild(row);
  }
}

function updateMatchMeter(players) {
  if (!players.length) {
    dom.matchProgressFill.style.width = "0%";
    dom.matchSummary.textContent = "No active match";
    return;
  }

  const maxScore = state.snapshot.maxScore || 900;
  const leader = players[0];
  const progress = clamp(leader.score / maxScore * 100, 0, 100);
  const mapName = state.snapshot.map?.name ? `${state.snapshot.map.name} | ` : "";
  dom.matchProgressFill.style.width = `${progress}%`;
  dom.matchSummary.textContent = `${mapName}${leader.name} leads ${leader.score}/${maxScore}`;
}

function updateWinnerBanner() {
  const winner = state.snapshot?.winner;
  if (!winner || state.phase !== "ended") {
    dom.winner.hidden = true;
    dom.endGameScreen.hidden = true;
    return;
  }
  dom.winner.hidden = false;
  dom.winner.textContent = `${winner.name} won`;
  dom.endGameScreen.hidden = false;
  dom.endGameTitle.textContent = `${winner.name} won`;
  const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
  dom.endGameSummary.innerHTML = rewardSummaryMarkup(mine?.lastReward, mine?.money);
  const admin = isAdmin();
  dom.endGameActions.hidden = false;
  dom.restartButton.hidden = !admin;
  dom.endCloseButton.hidden = !admin;
  if (dom.endLeaveButton) dom.endLeaveButton.hidden = admin;
  setEndGameActionState(false);
}

function rewardSummaryMarkup(reward, money) {
  if (!reward) {
    return escapeHtml(isAdmin()
      ? "Restart sends everyone back to ship design with a new generated map."
      : "Waiting for the room admin to restart or close the lobby.");
  }
  const title = reward.didWin ? "Battle Result: Victory" : "Battle Result: Defeat";
  const lines = reward.didWin
    ? [
        ["Base reward", reward.base],
        ["Enemy destroyed", reward.destroyed],
        ["Victory bonus", reward.victory],
        ["Survival bonus", reward.survival],
        ["Efficiency bonus", reward.efficiency]
      ]
    : [
        ["Loss support", reward.lossSupport],
        ["Enemy destroyed", reward.destroyed]
      ];
  const penalty = reward.didWin && reward.overpowerMultiplier < 1
    ? `<li>Overpowered fleet penalty applied: ${Math.round(reward.overpowerMultiplier * 100)}% victory bonus</li>`
    : "";
  return `
    <span>${escapeHtml(title)}</span>
    <ul class="reward-list">
      ${lines.map(([label, value]) => `<li>${escapeHtml(label)}: $${Math.round(value || 0)}</li>`).join("")}
      ${penalty}
      <li><strong>Total earned: $${Math.round(reward.total || 0)}</strong></li>
      <li>New balance: $${Math.floor(money || 0)}</li>
    </ul>
  `;
}

function addNotice(text, tone = "") {
  const clean = String(text || "").slice(0, 90);
  state.notices.unshift({ text: clean, tone, at: performance.now() });
  state.notices = state.notices.slice(0, 7);
  dom.eventLog.textContent = "";
  for (const notice of state.notices) {
    const line = document.createElement("div");
    line.textContent = notice.text;
    dom.eventLog.appendChild(line);
  }
  showToast(clean, tone);
}

function showToast(text, tone = "") {
  if (!dom.toastStack) return;
  const toast = document.createElement("div");
  toast.className = `toast ${tone || ""}`.trim();
  toast.textContent = text;
  dom.toastStack.prepend(toast);

  while (dom.toastStack.children.length > 4) {
    dom.toastStack.lastElementChild.remove();
  }

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-6px)";
  }, 2600);
  setTimeout(() => toast.remove(), 3200);
}

function copyInvite() {
  const url = new URL(location.href);
  if (state.room) url.searchParams.set("room", state.room);
  const configuredServer = getConfiguredServerUrl();
  if (configuredServer) url.searchParams.set("server", configuredServer);
  const text = state.room ? `${url.toString()}  Room: ${state.room}` : url.toString();
  if (!navigator.clipboard?.writeText) {
    addNotice("Clipboard unavailable", "warning");
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => addNotice("Invite copied", "good"),
    () => addNotice("Clipboard unavailable", "warning")
  );
}

function getSocketUrl() {
  const configured = getConfiguredServerUrl();
  if (configured) return normalizeSocketUrl(configured);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/socket`;
}

function getConfiguredServerUrl() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("server");
  if (fromUrl) {
    localStorage.setItem(LOCAL_SERVER_KEY, fromUrl);
    return fromUrl;
  }
  return localStorage.getItem(LOCAL_SERVER_KEY) || "";
}

function normalizeSocketUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    if (!url.pathname || url.pathname === "/") url.pathname = "/socket";
    return url.toString();
  } catch {
    return value;
  }
}

function handlePointerDown(event) {
  if (!state.snapshot) return;
  dom.canvas.setPointerCapture(event.pointerId);
  state.pointer = { x: event.clientX, y: event.clientY };

  if (event.button === 2) {
    event.preventDefault();
    issueCommand(event);
    return;
  }

  if (event.button !== 0) return;

  const mini = minimapWorldAt(event.clientX, event.clientY);
  if (mini) {
    state.camera.x = mini.x;
    state.camera.y = mini.y;
    state.camera.follow = false;
    return;
  }

  state.drag = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    currentClientX: event.clientX,
    currentClientY: event.clientY,
    startWorld: screenToWorld(event.clientX, event.clientY),
    currentWorld: screenToWorld(event.clientX, event.clientY),
    shift: event.shiftKey
  };
}

function handlePointerMove(event) {
  state.pointer = { x: event.clientX, y: event.clientY };
  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  state.drag.currentClientX = event.clientX;
  state.drag.currentClientY = event.clientY;
  state.drag.currentWorld = screenToWorld(event.clientX, event.clientY);
}

function handlePointerUp(event) {
  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  const drag = state.drag;
  state.drag = null;

  const distance = Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY);
  if (distance < 6) {
    selectAt(drag.currentWorld, drag.shift);
  } else {
    selectBox(drag.startWorld, drag.currentWorld, drag.shift);
  }
  updateHud();
}

function handleWheel(event) {
  event.preventDefault();
  const before = screenToWorld(event.clientX, event.clientY);
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  state.camera.manualZoom = clamp((state.camera.manualZoom || state.camera.zoom) * factor, 0.32, 1.45);
  state.camera.zoom = state.camera.manualZoom;
  const after = screenToWorld(event.clientX, event.clientY);
  state.camera.x += before.x - after.x;
  state.camera.y += before.y - after.y;
  state.camera.follow = false;
}

function handleKeyDown(event) {
  if (event.key === "Escape" && dom.confirmModal && !dom.confirmModal.hidden) {
    event.preventDefault();
    closeConfirmModal();
    return;
  }
  const key = event.key.toLowerCase();
  const tag = document.activeElement?.tagName;
  if (key === "r" && tag !== "INPUT" && tag !== "SELECT") {
    event.preventDefault();
    rotateFocusedPart();
    return;
  }
  if (tag === "INPUT" || tag === "SELECT" || tag === "BUTTON") return;
  state.keys.add(key);

  if (key === "q") {
    event.preventDefault();
    selectAllOwnShips();
  } else if (key === "f") {
    event.preventDefault();
    state.camera.follow = true;
  } else if (key === "escape") {
    state.selectedShipIds.clear();
    updateHud();
  }
}

function issueCommand(event) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (state.phase !== "active") return;
  const mini = minimapWorldAt(event.clientX, event.clientY);
  const world = mini || screenToWorld(event.clientX, event.clientY);
  const targetShip = findShipAt(world.x, world.y, (ship) => ship.ownerId !== state.myId && ship.alive);
  const targetPlayer = targetShip ? playerMap().get(targetShip.ownerId) : null;
  const shipIds = selectedShipIdsForCommand();

  state.command = {
    x: targetShip?.x || world.x,
    y: targetShip?.y || world.y,
    targetName: targetPlayer?.name || null,
    at: performance.now()
  };

  send({
    type: "command",
    x: targetShip?.x || world.x,
    y: targetShip?.y || world.y,
    targetId: targetShip?.id || null,
    shipIds,
    formation: dom.formationSelect.value
  });
  showCommandMarker(event.clientX, event.clientY);
}

function selectedShipIdsForCommand() {
  pruneSelection();
  if (state.selectedShipIds.size > 0) return [...state.selectedShipIds];
  return ownLiveShips().map((ship) => ship.id);
}

function selectAt(world, additive) {
  const ship = findShipAt(world.x, world.y, (candidate) => candidate.ownerId === state.myId && candidate.alive);
  if (!additive) state.selectedShipIds.clear();
  if (ship) {
    if (state.selectedShipIds.has(ship.id) && additive) state.selectedShipIds.delete(ship.id);
    else state.selectedShipIds.add(ship.id);
    state.camera.follow = true;
  }
}

function selectBox(a, b, additive) {
  if (!additive) state.selectedShipIds.clear();
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  for (const ship of ownLiveShips()) {
    if (ship.x >= minX && ship.x <= maxX && ship.y >= minY && ship.y <= maxY) {
      state.selectedShipIds.add(ship.id);
    }
  }
  if (state.selectedShipIds.size > 0) state.camera.follow = true;
}

function selectAllOwnShips() {
  state.selectedShipIds = new Set(ownLiveShips().map((ship) => ship.id));
  updateHud();
}

function pruneSelection() {
  const live = new Set(ownLiveShips().map((ship) => ship.id));
  for (const id of [...state.selectedShipIds]) {
    if (!live.has(id)) state.selectedShipIds.delete(id);
  }
}

function ownLiveShips() {
  return state.snapshot?.ships?.filter((ship) => ship.ownerId === state.myId && ship.alive) || [];
}

function findShipAt(x, y, predicate) {
  const ships = state.snapshot?.ships || [];
  let best = null;
  let bestDistance = Infinity;
  for (const ship of ships) {
    if (!predicate(ship)) continue;
    const distance = Math.hypot(ship.x - x, ship.y - y);
    if (distance <= ship.radius + 14 && distance < bestDistance) {
      best = ship;
      bestDistance = distance;
    }
  }
  return best;
}

function resizeCanvas() {
  const rect = dom.canvas.getBoundingClientRect();
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  dom.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  dom.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function frame(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - state.lastFrameAt) / 1000));
  state.lastFrameAt = now;
  updateCamera(dt);
  renderArena(now);
  requestAnimationFrame(frame);
}

function updateCamera(dt) {
  const rect = dom.canvas.getBoundingClientRect();
  const fitZoom = clamp(Math.min(rect.width / 1300, rect.height / 820), 0.42, 0.82);
  if (state.camera.manualZoom == null) state.camera.zoom = fitZoom;

  const panSpeed = 760 * dt / state.camera.zoom;
  let moved = false;
  if (state.keys.has("arrowleft") || state.keys.has("a")) {
    state.camera.x -= panSpeed;
    moved = true;
  }
  if (state.keys.has("arrowright") || state.keys.has("d")) {
    state.camera.x += panSpeed;
    moved = true;
  }
  if (state.keys.has("arrowup") || state.keys.has("w")) {
    state.camera.y -= panSpeed;
    moved = true;
  }
  if (state.keys.has("arrowdown") || state.keys.has("s")) {
    state.camera.y += panSpeed;
    moved = true;
  }
  if (moved) state.camera.follow = false;

  if (state.camera.follow) {
    const focusShips = [...state.selectedShipIds].length
      ? (state.snapshot?.ships || []).filter((ship) => state.selectedShipIds.has(ship.id) && ship.alive)
      : ownLiveShips();
    if (focusShips.length) {
      const targetX = focusShips.reduce((sum, ship) => sum + ship.x, 0) / focusShips.length;
      const targetY = focusShips.reduce((sum, ship) => sum + ship.y, 0) / focusShips.length;
      state.camera.x += (targetX - state.camera.x) * 0.055;
      state.camera.y += (targetY - state.camera.y) * 0.055;
    }
  }

  state.camera.x = clamp(state.camera.x, 0, state.world.width);
  state.camera.y = clamp(state.camera.y, 0, state.world.height);
}

function renderArena(now) {
  const rect = dom.canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  drawBackdrop(rect);

  ctx.save();
  applyCamera(rect);
  drawWorldGrid();
  drawMapFeatures(now);
  drawRelays();
  drawCommandTarget(now);
  drawBullets();
  drawShips();
  drawEffects();
  drawSelectionBox();
  ctx.restore();

  drawMinimap(rect);

  if (!state.snapshot) {
    ctx.fillStyle = "rgba(237,244,255,0.72)";
    ctx.font = "700 15px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Join a room to enter the arena", rect.width / 2, rect.height / 2);
  }
}

function drawBackdrop(rect) {
  const gradient = ctx.createLinearGradient(0, 0, rect.width, rect.height);
  gradient.addColorStop(0, "#040710");
  gradient.addColorStop(0.55, "#0a111d");
  gradient.addColorStop(1, "#05070c");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, rect.width, rect.height);

  ctx.save();
  ctx.globalAlpha = 0.88;
  for (const star of state.stars) {
    const x = (star.x * rect.width + state.camera.x * star.drift) % rect.width;
    const y = (star.y * rect.height + state.camera.y * star.drift) % rect.height;
    ctx.fillStyle = star.color;
    ctx.fillRect(x < 0 ? x + rect.width : x, y < 0 ? y + rect.height : y, star.size, star.size);
  }
  ctx.restore();
}

function drawWorldGrid() {
  ctx.save();
  ctx.lineWidth = 1 / state.camera.zoom;
  ctx.strokeStyle = "rgba(130,160,205,0.11)";
  for (let x = 0; x <= state.world.width; x += 160) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, state.world.height);
    ctx.stroke();
  }
  for (let y = 0; y <= state.world.height; y += 160) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(state.world.width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 3 / state.camera.zoom;
  ctx.strokeRect(0, 0, state.world.width, state.world.height);
  ctx.restore();
}

function drawMapFeatures(now) {
  const map = currentMap();
  if (!map) return;

  for (const cloud of map.clouds || []) drawNebula(cloud);
  for (const asteroid of map.asteroids || []) drawAsteroid(asteroid, now);
}

function drawNebula(cloud) {
  const rx = cloud.rx || 300;
  const ry = cloud.ry || 180;
  const color = cloud.color || "56,213,255";
  const alpha = cloud.alpha || 0.12;

  ctx.save();
  ctx.translate(cloud.x, cloud.y);
  ctx.rotate(cloud.rotation || 0);
  const gradient = ctx.createRadialGradient(0, 0, Math.min(rx, ry) * 0.1, 0, 0, rx);
  gradient.addColorStop(0, `rgba(${color}, ${alpha})`);
  gradient.addColorStop(0.52, `rgba(${color}, ${alpha * 0.42})`);
  gradient.addColorStop(1, `rgba(${color}, 0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawAsteroid(asteroid, now) {
  const radius = asteroid.radius || 60;
  const shape = asteroid.shape?.length ? asteroid.shape : [1, 0.92, 1.08, 0.9, 1.12, 0.96, 1.05, 0.88, 1.1, 0.95, 1.03, 0.9];
  const base = asteroid.shade === "warm" ? "#5a4939" : "#394657";
  const edge = asteroid.shade === "warm" ? "#ad8b64" : "#8495aa";

  ctx.save();
  ctx.translate(asteroid.x, asteroid.y);
  ctx.rotate((asteroid.rotation || 0) + (asteroid.spin || 0) * now * 0.001);
  ctx.shadowColor = "rgba(0,0,0,0.42)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;

  const gradient = ctx.createLinearGradient(-radius, -radius, radius, radius);
  gradient.addColorStop(0, edge);
  gradient.addColorStop(0.38, base);
  gradient.addColorStop(1, "#171d26");
  ctx.fillStyle = gradient;
  ctx.strokeStyle = "rgba(220,235,255,0.22)";
  ctx.lineWidth = Math.max(1.5, 2.5 / state.camera.zoom);
  ctx.beginPath();
  for (let i = 0; i < shape.length; i += 1) {
    const angle = i / shape.length * Math.PI * 2;
    const r = radius * shape[i];
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();

  ctx.fillStyle = "rgba(0,0,0,0.24)";
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  for (const crater of asteroid.craters || []) {
    const angle = crater.angle || 0;
    const distance = radius * (crater.distance || 0.3);
    const craterRadius = radius * (crater.radius || 0.12);
    ctx.beginPath();
    ctx.arc(Math.cos(angle) * distance, Math.sin(angle) * distance, craterRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

function drawRelays() {
  const snap = state.snapshot;
  if (!snap) return;
  const players = playerMap();

  for (const point of snap.points) {
    const owner = point.ownerId ? players.get(point.ownerId) : null;
    const color = owner?.color || "rgba(180,200,225,0.62)";

    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.12;
    ctx.beginPath();
    ctx.arc(0, 0, point.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.76;
    ctx.lineWidth = 3 / state.camera.zoom;
    ctx.beginPath();
    ctx.arc(0, 0, point.radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * point.progress);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = "#eaf3ff";
    ctx.font = `${Math.max(18, 24 / state.camera.zoom)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(point.id, 0, 0);
    ctx.font = `${Math.max(10, 13 / state.camera.zoom)}px system-ui, sans-serif`;
    const ownerText = point.contested ? "Contested" : owner ? owner.teamName || owner.name : "Neutral";
    ctx.fillText(ownerText, 0, point.radius + 18 / state.camera.zoom);
    ctx.restore();
  }
}

function drawCommandTarget(now) {
  if (!state.command) return;
  const age = now - state.command.at;
  if (age > 1600) {
    state.command = null;
    return;
  }
  const alpha = 1 - age / 1600;
  ctx.save();
  ctx.translate(state.command.x, state.command.y);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = state.command.targetName ? "#ff5f7e" : "#ffca57";
  ctx.lineWidth = 3 / state.camera.zoom;
  ctx.beginPath();
  ctx.arc(0, 0, 26 + age * 0.025, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-42, 0);
  ctx.lineTo(42, 0);
  ctx.moveTo(0, -42);
  ctx.lineTo(0, 42);
  ctx.stroke();
  ctx.restore();
}

function drawBullets() {
  const snap = state.snapshot;
  if (!snap) return;
  const players = playerMap();

  for (const bullet of snap.bullets) {
    const owner = players.get(bullet.ownerId);
    const color = owner?.color || "#ffffff";
    ctx.save();
    ctx.translate(bullet.x, bullet.y);
    ctx.rotate(Math.atan2(bullet.vy, bullet.vx));
    ctx.fillStyle = bullet.type === "missile" ? "#f7d37b" : bullet.type === "rail" ? "#f4f7ff" : color;
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = bullet.type === "rail" ? 22 : bullet.type === "missile" ? 18 : 12;
    if (bullet.type === "rail") {
      ctx.fillRect(-18, -2, 36, 4);
    } else {
      ctx.fillRect(bullet.type === "missile" ? -10 : -7, bullet.type === "missile" ? -3 : -2, bullet.type === "missile" ? 20 : 14, bullet.type === "missile" ? 6 : 4);
    }
    ctx.restore();
  }
}

function drawShips() {
  const snap = state.snapshot;
  if (!snap) return;
  const players = playerMap();
  const visibleShipIds = new Set();

  for (const ship of snap.ships) {
    visibleShipIds.add(ship.id);
    const player = players.get(ship.ownerId);
    if (!player) continue;
    drawShip(ship, player);
  }

  for (const id of state.shipHud.keys()) {
    if (!visibleShipIds.has(id)) state.shipHud.delete(id);
  }
}

function drawShip(ship, player) {
  const selected = state.selectedShipIds.has(ship.id);
  const alpha = ship.alive ? 1 : 0.32;
  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);
  ctx.globalAlpha = alpha;

  const design = ship.design || player.design || [];
  const scale = 13;
  drawShipStructure(design, scale, player.color);
  for (const part of design) {
    const def = PART_DEFS[part.type] || PART_DEFS.frame;
    const { x: px, y: py } = moduleLocalPosition(part, scale);
    ctx.save();
    ctx.translate(px, py);
    if (isRotatablePart(part.type)) ctx.rotate(moduleRotationToRadians(normalizeRotation(part.rotation)));
    drawModule(0, 0, scale - 1, def.color, part.type, player.color);
    ctx.restore();
  }

  ctx.strokeStyle = player.color;
  ctx.lineWidth = 2.5 / state.camera.zoom;
  ctx.beginPath();
  ctx.moveTo(ship.radius + 8, 0);
  ctx.lineTo(ship.radius - 8, -7);
  ctx.lineTo(ship.radius - 8, 7);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  if (selected) drawSelectionRing(ship);
  if (ship.focusTargetId) drawFocusLine(ship);
  drawHealthBars(ship, player);
  drawShipName(ship, player);
  if (!ship.alive) drawRespawn(ship);
}

function drawShipStructure(design, scale, color) {
  const keys = new Set(design.map((part) => `${part.x},${part.y}`));
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(3, scale * 0.26);
  ctx.strokeStyle = "rgba(0,0,0,0.42)";
  drawStructureLines(design, keys, scale);
  ctx.lineWidth = Math.max(1.2, scale * 0.12);
  ctx.strokeStyle = color;
  ctx.globalAlpha *= 0.48;
  drawStructureLines(design, keys, scale);
  ctx.restore();
}

function drawStructureLines(design, keys, scale) {
  ctx.beginPath();
  for (const part of design) {
    const { x, y } = moduleLocalPosition(part, scale);
    if (keys.has(`${part.x + 1},${part.y}`)) {
      const next = moduleLocalPosition({ x: part.x + 1, y: part.y }, scale);
      ctx.moveTo(x, y);
      ctx.lineTo(next.x, next.y);
    }
    if (keys.has(`${part.x},${part.y + 1}`)) {
      const next = moduleLocalPosition({ x: part.x, y: part.y + 1 }, scale);
      ctx.moveTo(x, y);
      ctx.lineTo(next.x, next.y);
    }
  }
  ctx.stroke();
}

function moduleLocalPosition(part, scale) {
  return {
    x: (3 - part.y) * scale,
    y: (part.x - 3) * scale
  };
}

function moduleRotationToRadians(rotation) {
  if (rotation === 90) return Math.PI / 2;
  if (rotation === 180) return Math.PI;
  if (rotation === 270) return -Math.PI / 2;
  return 0;
}

function drawModule(x, y, size, color, type, trim) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = Math.max(1.15, size * 0.12);
  ctx.strokeStyle = trim;
  ctx.shadowColor = color;
  ctx.shadowBlur = type === "core" || type === "reactor" || type === "shield" ? 8 : 3;

  const fill = ctx.createLinearGradient(-size * 0.55, -size * 0.55, size * 0.55, size * 0.55);
  fill.addColorStop(0, "rgba(255,255,255,0.42)");
  fill.addColorStop(0.24, color);
  fill.addColorStop(1, "rgba(8,12,20,0.92)");
  ctx.fillStyle = fill;

  if (type === "core") {
    roundRect(ctx, -size * 0.48, -size * 0.48, size * 0.96, size * 0.96, size * 0.18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f8fbff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6ee7ff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.36, 0, Math.PI * 2);
    ctx.stroke();
  } else if (type === "frame") {
    roundRect(ctx, -size * 0.46, -size * 0.46, size * 0.92, size * 0.92, size * 0.12);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.42)";
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.beginPath();
    ctx.moveTo(-size * 0.28, -size * 0.28);
    ctx.lineTo(size * 0.28, size * 0.28);
    ctx.moveTo(size * 0.28, -size * 0.28);
    ctx.lineTo(-size * 0.28, size * 0.28);
    ctx.stroke();
  } else if (type === "armor") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, -size * 0.24);
    ctx.lineTo(-size * 0.18, -size * 0.48);
    ctx.lineTo(size * 0.42, -size * 0.34);
    ctx.lineTo(size * 0.48, size * 0.2);
    ctx.lineTo(size * 0.18, size * 0.48);
    ctx.lineTo(-size * 0.48, size * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,244,220,0.38)";
    ctx.beginPath();
    ctx.moveTo(-size * 0.18, -size * 0.34);
    ctx.lineTo(size * 0.24, size * 0.28);
    ctx.stroke();
  } else if (type === "engine") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.48, -size * 0.38);
    ctx.lineTo(size * 0.4, -size * 0.24);
    ctx.lineTo(size * 0.48, size * 0.24);
    ctx.lineTo(-size * 0.48, size * 0.38);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffca57";
    ctx.beginPath();
    ctx.moveTo(-size * 0.58, -size * 0.18);
    ctx.lineTo(-size * 0.95, 0);
    ctx.lineTo(-size * 0.58, size * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#89f7ff";
    ctx.fillRect(-size * 0.35, -size * 0.16, size * 0.26, size * 0.32);
  } else if (type === "blaster") {
    drawWeaponBase(size, color);
    ctx.fillStyle = "#ffd1dc";
    roundRect(ctx, size * 0.02, -size * 0.13, size * 0.62, size * 0.26, size * 0.08);
    ctx.fill();
  } else if (type === "missile") {
    drawWeaponBase(size, color);
    ctx.fillStyle = "#f0dcff";
    ctx.beginPath();
    ctx.moveTo(size * 0.64, 0);
    ctx.lineTo(size * 0.08, -size * 0.2);
    ctx.lineTo(-size * 0.08, 0);
    ctx.lineTo(size * 0.08, size * 0.2);
    ctx.closePath();
    ctx.fill();
  } else if (type === "railgun") {
    drawWeaponBase(size, color);
    ctx.strokeStyle = "#f4f7ff";
    ctx.lineWidth = Math.max(1.2, size * 0.1);
    ctx.beginPath();
    ctx.moveTo(-size * 0.04, -size * 0.16);
    ctx.lineTo(size * 0.68, -size * 0.16);
    ctx.moveTo(-size * 0.04, size * 0.16);
    ctx.lineTo(size * 0.68, size * 0.16);
    ctx.stroke();
    ctx.fillStyle = "#7aa4ff";
    ctx.fillRect(size * 0.42, -size * 0.06, size * 0.16, size * 0.12);
  } else if (type === "reactor") {
    drawRoundSystem(size);
    ctx.fillStyle = "#fff7b3";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6b4b12";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.36, 0, Math.PI * 2);
    ctx.stroke();
  } else if (type === "battery") {
    roundRect(ctx, -size * 0.42, -size * 0.42, size * 0.84, size * 0.84, size * 0.12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#d5fbff";
    for (let i = 0; i < 3; i += 1) {
      ctx.fillRect(-size * 0.25, -size * 0.28 + i * size * 0.21, size * 0.5, size * 0.09);
    }
  } else if (type === "shield") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#b9ffd0";
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.34, Math.PI * 0.15, Math.PI * 1.85);
    ctx.stroke();
  } else if (type === "repair") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#d7ffe2";
    ctx.lineWidth = Math.max(1.4, size * 0.12);
    ctx.beginPath();
    ctx.moveTo(-size * 0.24, 0);
    ctx.lineTo(size * 0.24, 0);
    ctx.moveTo(0, -size * 0.24);
    ctx.lineTo(0, size * 0.24);
    ctx.stroke();
  } else {
    roundRect(ctx, -size * 0.44, -size * 0.44, size * 0.88, size * 0.88, size * 0.1);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

function drawWeaponBase(size) {
  roundRect(ctx, -size * 0.46, -size * 0.32, size * 0.68, size * 0.64, size * 0.12);
  ctx.fill();
  ctx.stroke();
}

function drawRoundSystem(size) {
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawSelectionRing(ship) {
  ctx.save();
  ctx.strokeStyle = "#ffca57";
  ctx.lineWidth = 2.5 / state.camera.zoom;
  ctx.setLineDash([10 / state.camera.zoom, 7 / state.camera.zoom]);
  ctx.beginPath();
  ctx.arc(ship.x, ship.y, ship.radius + 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawFocusLine(ship) {
  const target = state.snapshot?.ships?.find((candidate) => candidate.id === ship.focusTargetId);
  if (!target) return;
  ctx.save();
  ctx.globalAlpha = 0.36;
  ctx.strokeStyle = "#ff5f7e";
  ctx.lineWidth = 1.5 / state.camera.zoom;
  ctx.beginPath();
  ctx.moveTo(ship.x, ship.y);
  ctx.lineTo(target.x, target.y);
  ctx.stroke();
  ctx.restore();
}

function drawHealthBars(ship, player) {
  if (!ship.alive) return;
  const selected = state.selectedShipIds.has(ship.id);
  const damaged = ship.hp < ship.maxHp || ship.shield < ship.maxShield;
  const width = Math.max(selected ? 72 : 56, ship.radius * (selected ? 2.15 : 1.85));
  const x = ship.x - width / 2;
  const frameHeight = selected ? 34 : 25;
  const y = ship.y - ship.radius - (selected ? 46 : 35);
  const now = performance.now();
  const hud = updateShipHud(ship, now);
  const hullRatio = clamp(hud.hp / ship.maxHp, 0, 1);
  const hullLagRatio = clamp(hud.hpLag / ship.maxHp, 0, 1);
  const shieldRatio = ship.maxShield > 0 ? clamp(hud.shield / ship.maxShield, 0, 1) : 0;
  const shieldLagRatio = ship.maxShield > 0 ? clamp(hud.shieldLag / ship.maxShield, 0, 1) : 0;
  const lowHull = hullRatio <= 0.25;
  const alpha = selected || damaged ? 1 : 0.68;
  const pulse = clamp(1 - (now - hud.hitAt) / 280, 0, 1);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = pulse > 0 && hud.lastHitShield ? "rgba(81,226,255,0.85)" : player.color;
  ctx.shadowBlur = 4 + pulse * 11;
  drawHudFrame(x - 4, y - 4, width + 8, frameHeight, player.color, lowHull);
  ctx.shadowBlur = 0;

  const shieldY = y + 1;
  const hullY = y + (selected ? 9 : 8);
  const shieldHeight = selected ? 6 : 4;
  const hullHeight = selected ? 7 : 6;

  if (ship.maxShield > 0) {
    drawStatusBar({
      x,
      y: shieldY,
      width,
      height: shieldHeight,
      ratio: shieldRatio,
      lagRatio: shieldLagRatio,
      fillStart: "#b8f7ff",
      fillEnd: "#38d5ff",
      glow: "rgba(56,213,255,0.62)",
      segments: 6
    });
  } else {
    drawEmptyShieldLine(x, shieldY, width);
  }

  const hullColor = hullColorForRatio(hullRatio);
  drawStatusBar({
    x,
    y: hullY,
    width,
    height: hullHeight,
    ratio: hullRatio,
    lagRatio: hullLagRatio,
    fillStart: hullColor.start,
    fillEnd: hullColor.end,
    glow: lowHull ? "rgba(255,95,126,0.78)" : `${player.color}aa`,
    segments: selected ? 8 : 6
  });

  ctx.shadowColor = lowHull ? "rgba(255,95,126,0.9)" : player.color;
  ctx.shadowBlur = lowHull ? 9 : 4;
  ctx.fillStyle = lowHull ? "#ffd6df" : "rgba(237,244,255,0.86)";
  ctx.font = `${Math.max(9, (selected ? 10 : 9) / state.camera.zoom)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  if (selected) {
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(213,236,255,0.86)";
    ctx.font = `${Math.max(8, 8 / state.camera.zoom)}px system-ui, sans-serif`;
    ctx.fillText(`Shield ${Math.round(shieldRatio * 100)}%  Hull ${Math.round(hullRatio * 100)}%`, ship.x, y + 18);
  }

  ctx.shadowBlur = lowHull ? 8 : 3;
  ctx.fillStyle = "rgba(237,244,255,0.9)";
  ctx.font = `${Math.max(9, (selected ? 10 : 9) / state.camera.zoom)}px system-ui, sans-serif`;
  ctx.fillText(player.name, ship.x, y + frameHeight + 2);
  ctx.restore();
}

function updateShipHud(ship, now) {
  const previous = state.shipHud.get(ship.id) || {
    hp: ship.hp,
    shield: ship.shield,
    hpLag: ship.hp,
    shieldLag: ship.shield,
    actualHp: ship.hp,
    actualShield: ship.shield,
    hitAt: 0,
    lastHitShield: false,
    lastSeenAt: now
  };
  const dt = clamp((now - previous.lastSeenAt) / 1000, 0, 0.12);
  const shieldHit = ship.shield < previous.actualShield;
  const hullHit = ship.hp < previous.actualHp;
  const displayRate = 14 * dt;
  const lagRate = 4.4 * dt;
  const next = {
    hp: approach(previous.hp, ship.hp, displayRate),
    shield: approach(previous.shield, ship.shield, displayRate),
    hpLag: approach(previous.hpLag, ship.hp, lagRate),
    shieldLag: approach(previous.shieldLag, ship.shield, lagRate),
    actualHp: ship.hp,
    actualShield: ship.shield,
    hitAt: shieldHit || hullHit ? now : previous.hitAt,
    lastHitShield: shieldHit || (!hullHit && previous.lastHitShield),
    lastSeenAt: now
  };
  if (ship.hp > previous.actualHp) next.hpLag = Math.max(next.hpLag, ship.hp);
  if (ship.shield > previous.actualShield) next.shieldLag = Math.max(next.shieldLag, ship.shield);
  state.shipHud.set(ship.id, next);
  return next;
}

function drawHudFrame(x, y, width, height, color, warning) {
  ctx.save();
  ctx.fillStyle = "rgba(3,8,15,0.72)";
  ctx.strokeStyle = warning ? "rgba(255,95,126,0.9)" : color;
  ctx.lineWidth = 1.25 / state.camera.zoom;
  ctx.beginPath();
  ctx.moveTo(x + 7, y);
  ctx.lineTo(x + width - 7, y);
  ctx.lineTo(x + width, y + 7);
  ctx.lineTo(x + width - 5, y + height);
  ctx.lineTo(x + 5, y + height);
  ctx.lineTo(x, y + height - 7);
  ctx.lineTo(x + 7, y);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = warning ? 0.92 : 0.62;
  ctx.stroke();
  ctx.strokeStyle = "rgba(237,244,255,0.22)";
  ctx.beginPath();
  ctx.moveTo(x + 9, y + 3);
  ctx.lineTo(x + width - 15, y + 3);
  ctx.stroke();
  ctx.restore();
}

function drawStatusBar(options) {
  const { x, y, width, height, ratio, lagRatio, fillStart, fillEnd, glow, segments } = options;
  ctx.save();
  roundRect(ctx, x, y, width, height, Math.max(1, height * 0.35));
  ctx.fillStyle = "rgba(1,5,10,0.82)";
  ctx.fill();

  if (lagRatio > ratio) {
    roundRect(ctx, x, y, width * lagRatio, height, Math.max(1, height * 0.35));
    ctx.fillStyle = "rgba(255,245,194,0.48)";
    ctx.fill();
  }

  if (ratio > 0) {
    const fill = ctx.createLinearGradient(x, y, x + width, y);
    fill.addColorStop(0, fillStart);
    fill.addColorStop(1, fillEnd);
    ctx.shadowColor = glow;
    ctx.shadowBlur = 7;
    roundRect(ctx, x, y, width * ratio, height, Math.max(1, height * 0.35));
    ctx.fillStyle = fill;
    ctx.fill();
  }

  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(225,241,255,0.22)";
  ctx.lineWidth = 0.9 / state.camera.zoom;
  roundRect(ctx, x, y, width, height, Math.max(1, height * 0.35));
  ctx.stroke();

  ctx.strokeStyle = "rgba(2,8,16,0.72)";
  ctx.lineWidth = 0.8 / state.camera.zoom;
  const step = width / segments;
  for (let i = 1; i < segments; i += 1) {
    ctx.beginPath();
    ctx.moveTo(x + step * i, y + 1);
    ctx.lineTo(x + step * i, y + height - 1);
    ctx.stroke();
  }
  ctx.restore();
}

function drawEmptyShieldLine(x, y, width) {
  ctx.save();
  ctx.strokeStyle = "rgba(88,122,150,0.42)";
  ctx.lineWidth = 1 / state.camera.zoom;
  ctx.setLineDash([4 / state.camera.zoom, 4 / state.camera.zoom]);
  ctx.beginPath();
  ctx.moveTo(x, y + 2);
  ctx.lineTo(x + width, y + 2);
  ctx.stroke();
  ctx.restore();
}

function hullColorForRatio(ratio) {
  if (ratio <= 0.25) return { start: "#ffd0d9", end: "#ff5f7e" };
  if (ratio <= 0.55) return { start: "#fff1a6", end: "#ffca57" };
  return { start: "#d8ffe3", end: "#67e08a" };
}

function approach(current, target, rate) {
  const t = clamp(rate, 0, 1);
  return current + (target - current) * t;
}

function drawShipName(ship, player) {
  if (!ship.alive || state.camera.zoom < 0.48 || state.selectedShipIds.has(ship.id)) return;
  if (ship.hp < ship.maxHp || ship.shield < ship.maxShield) return;
  ctx.save();
  ctx.fillStyle = "rgba(237,244,255,0.5)";
  ctx.font = `${Math.max(10, 11 / state.camera.zoom)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(player.name, ship.x, ship.y + ship.radius + 18);
  ctx.restore();
}

function drawRespawn(ship) {
  ctx.save();
  ctx.fillStyle = "rgba(237,244,255,0.7)";
  ctx.font = `${Math.max(11, 13 / state.camera.zoom)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("lost", ship.x, ship.y - ship.radius - 12);
  ctx.restore();
}

function drawEffects() {
  const snap = state.snapshot;
  if (!snap) return;
  for (const effect of snap.effects) {
    const age = effect.age || 0;
    const t = clamp(age / 900, 0, 1);
    ctx.save();
    ctx.translate(effect.x, effect.y);
    ctx.globalAlpha = 1 - t;
    if (effect.type === "boom") {
      ctx.fillStyle = "#ffca57";
      ctx.beginPath();
      ctx.arc(0, 0, 18 + t * 64, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ff5f7e";
      ctx.lineWidth = 5 / state.camera.zoom;
      ctx.beginPath();
      ctx.arc(0, 0, 34 + t * 84, 0, Math.PI * 2);
      ctx.stroke();
    } else if (effect.type === "repair") {
      ctx.strokeStyle = "#67e08a";
      ctx.lineWidth = 3 / state.camera.zoom;
      ctx.beginPath();
      ctx.arc(0, 0, 16 + t * 28, 0, Math.PI * 2);
      ctx.stroke();
    } else if (effect.type === "railhit") {
      ctx.strokeStyle = "#f4f7ff";
      ctx.lineWidth = 3 / state.camera.zoom;
      ctx.beginPath();
      ctx.moveTo(-24 - t * 24, 0);
      ctx.lineTo(24 + t * 24, 0);
      ctx.moveTo(0, -24 - t * 24);
      ctx.lineTo(0, 24 + t * 24);
      ctx.stroke();
    } else if (effect.type === "rockhit") {
      ctx.fillStyle = "rgba(196,174,142,0.82)";
      ctx.beginPath();
      ctx.arc(0, 0, 5 + t * 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,226,175,0.72)";
      ctx.lineWidth = 2 / state.camera.zoom;
      ctx.beginPath();
      ctx.moveTo(-10 - t * 12, -4);
      ctx.lineTo(8 + t * 18, 5);
      ctx.stroke();
    } else {
      ctx.fillStyle = effect.type === "warp" ? "#38d5ff" : "#f3f7ff";
      ctx.beginPath();
      ctx.arc(0, 0, 8 + t * 32, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawSelectionBox() {
  if (!state.drag) return;
  const a = state.drag.startWorld;
  const b = state.drag.currentWorld;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const width = Math.abs(a.x - b.x);
  const height = Math.abs(a.y - b.y);
  if (width < 12 && height < 12) return;
  ctx.save();
  ctx.fillStyle = "rgba(56,213,255,0.08)";
  ctx.strokeStyle = "rgba(56,213,255,0.82)";
  ctx.lineWidth = 2 / state.camera.zoom;
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}

function drawMinimap(rect) {
  const w = Math.min(190, Math.max(142, rect.width * 0.19));
  const h = w * (state.world.height / state.world.width);
  const x = 14;
  const y = 88;
  state.minimap = { x, y, w, h };

  ctx.save();
  ctx.fillStyle = "rgba(7,12,20,0.78)";
  ctx.strokeStyle = "rgba(174,199,231,0.25)";
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  roundRect(ctx, x, y, w, h, 8);
  ctx.clip();

  const sx = w / state.world.width;
  const sy = h / state.world.height;
  const snap = state.snapshot;
  const map = currentMap();
  if (map) {
    for (const cloud of map.clouds || []) {
      ctx.fillStyle = `rgba(${cloud.color || "56,213,255"}, 0.12)`;
      ctx.beginPath();
      ctx.ellipse(x + cloud.x * sx, y + cloud.y * sy, Math.max(3, cloud.rx * sx), Math.max(2, cloud.ry * sy), cloud.rotation || 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const asteroid of map.asteroids || []) {
      ctx.fillStyle = "rgba(172,185,202,0.45)";
      ctx.strokeStyle = "rgba(22,28,37,0.82)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x + asteroid.x * sx, y + asteroid.y * sy, Math.max(2.5, asteroid.radius * sx), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  if (snap) {
    const players = playerMap();
    for (const point of snap.points) {
      const owner = players.get(point.ownerId);
      ctx.fillStyle = owner?.color || "rgba(220,230,245,0.42)";
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(x + point.x * sx, y + point.y * sy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const ship of snap.ships) {
      if (!ship.alive) continue;
      const player = players.get(ship.ownerId);
      ctx.fillStyle = player?.color || "#ffffff";
      ctx.fillRect(x + ship.x * sx - 2, y + ship.y * sy - 2, 4, 4);
    }
  }

  const viewW = rect.width / state.camera.zoom;
  const viewH = rect.height / state.camera.zoom;
  ctx.strokeStyle = "#ffca57";
  ctx.lineWidth = 1;
  ctx.strokeRect(
    x + (state.camera.x - viewW / 2) * sx,
    y + (state.camera.y - viewH / 2) * sy,
    viewW * sx,
    viewH * sy
  );
  ctx.restore();
}

function applyCamera(rect) {
  ctx.translate(rect.width / 2, rect.height / 2);
  ctx.scale(state.camera.zoom, state.camera.zoom);
  ctx.translate(-state.camera.x, -state.camera.y);
}

function screenToWorld(clientX, clientY) {
  const rect = dom.canvas.getBoundingClientRect();
  return {
    x: state.camera.x + (clientX - rect.left - rect.width / 2) / state.camera.zoom,
    y: state.camera.y + (clientY - rect.top - rect.height / 2) / state.camera.zoom
  };
}

function minimapWorldAt(clientX, clientY) {
  if (!state.minimap) return null;
  const rect = dom.canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const mini = state.minimap;
  if (x < mini.x || x > mini.x + mini.w || y < mini.y || y > mini.y + mini.h) return null;
  return {
    x: clamp((x - mini.x) / mini.w * state.world.width, 0, state.world.width),
    y: clamp((y - mini.y) / mini.h * state.world.height, 0, state.world.height)
  };
}

function showCommandMarker(clientX, clientY) {
  const rect = dom.canvas.getBoundingClientRect();
  dom.marker.hidden = false;
  dom.marker.style.left = `${clientX - rect.left}px`;
  dom.marker.style.top = `${clientY - rect.top}px`;
  dom.marker.style.animation = "none";
  dom.marker.offsetHeight;
  dom.marker.style.animation = "";
}

function playerMap() {
  return new Map((state.snapshot?.players || []).map((player) => [player.id, player]));
}

function isAdmin() {
  return state.adminId === state.myId || Boolean(state.snapshot?.players?.find((player) => player.id === state.myId && player.isAdmin));
}

function currentMap() {
  return state.snapshot?.map || state.map;
}

function teamValue() {
  return dom.teamSelect?.value === "red" ? "red" : "blue";
}

function loadDesign() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_DESIGN_KEY) || "null");
    return normalizeDesign(saved);
  } catch {
    return normalizeDesign(null);
  }
}

function persistDesign() {
  localStorage.setItem(LOCAL_DESIGN_KEY, JSON.stringify(state.design));
}

function loadSavedDesigns() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_SAVED_DESIGNS_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.map((design, index) => ({
      id: String(design.id || `saved-${index}`),
      name: String(design.name || `Design ${index + 1}`).slice(0, 28),
      blueprint: normalizeDesign(design.blueprint),
      cost: Number(design.cost) || 0,
      weapons: String(design.weapons || "0/0/0"),
      speed: Number(design.speed) || 0,
      createdAt: Number(design.createdAt) || Date.now(),
      updatedAt: Number(design.updatedAt) || Date.now()
    })).slice(0, 12);
  } catch {
    return [];
  }
}

function persistSavedDesigns() {
  localStorage.setItem(LOCAL_SAVED_DESIGNS_KEY, JSON.stringify(state.savedDesigns.slice(0, 12)));
}

function defaultDesign() {
  return [
    { x: 3, y: 3, type: "core" },
    { x: 3, y: 4, type: "reactor" },
    { x: 2, y: 4, type: "engine" },
    { x: 4, y: 4, type: "engine" },
    { x: 2, y: 3, type: "blaster" },
    { x: 4, y: 3, type: "blaster" },
    { x: 3, y: 2, type: "shield" },
    { x: 2, y: 2, type: "armor" },
    { x: 4, y: 2, type: "armor" },
    { x: 3, y: 5, type: "battery" }
  ];
}

function normalizeDesign(input) {
  const fallback = defaultDesign();
  const source = Array.isArray(input) ? input : fallback;
  const seen = new Set();
  const clean = [];

  for (const raw of source) {
    const x = Math.trunc(Number(raw?.x));
    const y = Math.trunc(Number(raw?.y));
    const type = String(raw?.type || "");
    const key = `${x},${y}`;
    if (x < 0 || x > 6 || y < 0 || y > 6 || !PART_DEFS[type] || seen.has(key)) continue;
    seen.add(key);
    clean.push(makeDesignPart(x, y, type, raw?.rotation));
  }

  if (clean.filter((part) => part.type === "core").length !== 1 || !isConnected(clean)) return fallback;
  return clean;
}

function isConnected(parts) {
  const core = parts.find((part) => part.type === "core");
  if (!core) return false;
  const keys = new Set(parts.map((part) => `${part.x},${part.y}`));
  const seen = new Set([`${core.x},${core.y}`]);
  const queue = [core];

  for (let i = 0; i < queue.length; i += 1) {
    const part = queue[i];
    for (const [x, y] of [[part.x + 1, part.y], [part.x - 1, part.y], [part.x, part.y + 1], [part.x, part.y - 1]]) {
      const key = `${x},${y}`;
      if (keys.has(key) && !seen.has(key)) {
        seen.add(key);
        queue.push({ x, y });
      }
    }
  }

  return seen.size === parts.length;
}

function explainConnectionProblem(parts, x, y, replacing) {
  if (!parts.some((part) => part.type === "core")) {
    return "Blueprint must keep exactly one core module";
  }

  const target = parts.find((part) => part.x === x && part.y === y);
  if (target) {
    const sideNeighbor = parts.some((part) => part !== target && Math.abs(part.x - x) + Math.abs(part.y - y) === 1);
    const cornerNeighbor = parts.some((part) => part !== target && Math.abs(part.x - x) === 1 && Math.abs(part.y - y) === 1);

    if (!sideNeighbor && cornerNeighbor) {
      return "Not connected: modules must touch by a full side; corner contact does not count";
    }

    if (!sideNeighbor) {
      return "Not connected: place it so one side touches an existing module";
    }
  }

  if (replacing) {
    return "That change would break the side-connected path back to the core";
  }

  return "Not connected to the core: every module needs a side-connected path to the core";
}

function computeStats(modules) {
  let cost = 0;
  let mass = 0;
  let maxHp = 0;
  let maxShield = 0;
  let shieldRegen = 0;
  let powerGeneration = 0;
  let powerUse = 0;
  let thrust = 0;
  let turnBonus = 0;
  let energyStorage = 0;
  let blaster = 0;
  let missile = 0;
  let railgun = 0;
  let repair = 0;
  let repairRate = 0;
  const weaponTotals = {
    blaster: weaponAccumulator(),
    missile: weaponAccumulator(),
    railgun: weaponAccumulator()
  };

  for (const module of modules) {
    const part = PART_STATS[module.type] || PART_STATS.frame;
    cost += part.cost;
    mass += part.mass;
    maxHp += part.hp;
    maxShield += part.shield;
    shieldRegen += part.shieldRegen || 0;
    powerGeneration += part.powerGeneration || 0;
    powerUse += part.powerUse || 0;
    thrust += part.thrust;
    turnBonus += part.turn;
    energyStorage += part.energyStorage || 0;
    blaster += part.blaster || 0;
    missile += part.missile || 0;
    railgun += part.railgun || 0;
    repair += part.repair || 0;
    repairRate += part.repairRate || 0;
    if (part.weapon) addWeaponStats(weaponTotals[part.weapon.type], part.weapon);
  }

  const power = powerGeneration - powerUse;
  const powerRatio = powerUse > 0 ? powerGeneration / powerUse : 1.2;
  const efficiency = clamp(powerUse > 0 ? 0.58 + powerRatio * 0.42 : 1.08, 0.48, 1.15);
  const thrustRatio = thrust / Math.max(1, mass);
  // Mobility balance: armor and large weapons add mass, while engines add thrust.
  // Speed and acceleration scale from total thrust divided by total mass so heavy ships need more engines.
  // Ships with no engine thrust cannot move; their command target can change, but acceleration stays zero.
  const hasEngineThrust = thrust > 0;
  const maxSpeed = hasEngineThrust ? clamp(82 + thrustRatio * 21 * clamp(efficiency, 0.62, 1.08), 72, 360) : 0;
  const accel = hasEngineThrust ? clamp(46 + thrustRatio * 46 * clamp(efficiency, 0.55, 1.08), 38, 420) : 0;
  const costBreakdown = calculateCostBreakdown({ cost, mass, maxHp, maxShield, repairRate, blaster, missile, railgun });
  const unitCost = costBreakdown.total;
  const fleetCount = clamp(Math.floor(260 / Math.max(58, unitCost * 0.72 + mass * 0.45)), 1, 5);
  const warnings = shipWarnings({ powerGeneration, powerUse, thrustRatio, blaster, missile, railgun, mass, turnRate: clamp(1.05 + turnBonus + thrustRatio * 0.035, 0.55, 2.85), repair, shield: maxShield, modules });

  return {
    cost,
    unitCost,
    mass: Math.round(mass),
    maxHp: Math.max(140, Math.round(maxHp * 0.82)),
    maxShield: Math.round(maxShield * efficiency),
    shieldRegen: Number((shieldRegen * clamp(efficiency, 0.4, 1.12)).toFixed(2)),
    powerGeneration,
    powerUse,
    power,
    efficiency: Number(efficiency.toFixed(2)),
    thrust,
    thrustRatio: Number(thrustRatio.toFixed(2)),
    energyStorage,
    accel: Math.round(accel),
    maxSpeed,
    turnRate: clamp(1.05 + turnBonus + thrustRatio * 0.035, 0.55, 2.85),
    blaster,
    missile,
    railgun,
    repair,
    repairRate,
    blasterRange: weaponRange(weaponTotals.blaster),
    missileRange: weaponRange(weaponTotals.missile),
    railgunRange: weaponRange(weaponTotals.railgun),
    weaponDps: Number((weaponTotals.blaster.dps + weaponTotals.missile.dps + weaponTotals.railgun.dps).toFixed(1)),
    weapons: summarizeWeaponTotals(weaponTotals),
    warnings,
    costBreakdown,
    fleetCount
  };
}

function calculateCostBreakdown(stats) {
  const base = SHIP_ECONOMY.baseShipCost;
  const parts = stats.cost * SHIP_ECONOMY.partCostMultiplier;
  const mass = stats.mass * SHIP_ECONOMY.massCostMultiplier;
  const hull = stats.maxHp * SHIP_ECONOMY.hullCostMultiplier;
  const shield = stats.maxShield * SHIP_ECONOMY.shieldCostMultiplier;
  const repair = stats.repairRate * SHIP_ECONOMY.repairCostMultiplier;
  const weaponPremium =
    stats.blaster * SHIP_ECONOMY.weaponPremiums.blaster +
    stats.missile * SHIP_ECONOMY.weaponPremiums.missile +
    stats.railgun * SHIP_ECONOMY.weaponPremiums.railgun;
  const preTaxTotal = base + parts + mass + hull + shield + repair + weaponPremium;
  const largeTax = Math.max(0, preTaxTotal - SHIP_ECONOMY.largeShipThreshold) * SHIP_ECONOMY.largeShipCostTax;
  const hugeTax = Math.max(0, preTaxTotal - SHIP_ECONOMY.hugeShipThreshold) * SHIP_ECONOMY.hugeShipCostTax;
  const sizeTax = largeTax + hugeTax;
  return {
    base: Math.round(base),
    parts: Math.round(parts),
    mass: Math.round(mass),
    hull: Math.round(hull),
    shield: Math.round(shield),
    repair: Math.round(repair),
    weaponPremium: Math.round(weaponPremium),
    sizeTax: Math.round(sizeTax),
    total: clamp(Math.round(preTaxTotal + sizeTax), 300, 2000)
  };
}

function weaponAccumulator() {
  return { count: 0, damage: 0, range: 0, fireRate: 0, reload: 0, projectileSpeed: 0, accuracy: 0, tracking: 0, dps: 0 };
}

function addWeaponStats(total, weapon) {
  total.count += 1;
  total.damage += weapon.damage;
  total.range = Math.max(total.range, weapon.range);
  total.fireRate += weapon.fireRate;
  total.reload += calculateReload(weapon);
  total.projectileSpeed += weapon.projectileSpeed;
  total.accuracy += weapon.accuracy;
  total.tracking += weapon.tracking || 0;
  total.dps += calculateDps(weapon);
}

function calculateDps(weapon) {
  return Number(((weapon.damage || 0) * (weapon.fireRate || 0)).toFixed(1));
}

function calculateReload(weapon) {
  return Number((1 / Math.max(0.01, weapon.fireRate || 1)).toFixed(2));
}

function weaponRange(total) {
  return total.count > 0 ? total.range : 0;
}

function summarizeWeaponTotals(totals) {
  const result = {};
  for (const [type, total] of Object.entries(totals)) {
    result[type] = {
      count: total.count,
      damage: total.damage,
      range: total.range,
      fireRate: Number(total.fireRate.toFixed(2)),
      reload: total.count ? Number((total.reload / total.count).toFixed(2)) : 0,
      projectileSpeed: total.count ? Math.round(total.projectileSpeed / total.count) : 0,
      accuracy: total.count ? Number((total.accuracy / total.count).toFixed(2)) : 0,
      tracking: total.count ? Number((total.tracking / total.count).toFixed(2)) : 0,
      dps: Number(total.dps.toFixed(1))
    };
  }
  return result;
}

function shipWarnings(stats) {
  const warnings = [];
  const weaponCount = stats.blaster + stats.missile + stats.railgun;
  const hasReactor = stats.modules.some((module) => module.type === "reactor");
  if (stats.powerGeneration < stats.powerUse) warnings.push(`Power deficit: uses ${stats.powerUse} but generates ${stats.powerGeneration}`);
  if (!hasReactor && stats.powerUse > PART_STATS.core.powerGeneration) warnings.push("No reactor: high-power systems need stronger generation");
  if (stats.thrust <= 0) warnings.push("No engines: this ship cannot move");
  if (stats.thrustRatio < 3.2 && stats.mass > 18) warnings.push("Low mobility: heavy for its engine power");
  if (stats.mass > 85 || stats.turnRate < 0.85) warnings.push("Heavy ship: turning will be slow");
  if (stats.repair > 0 && stats.powerGeneration < stats.powerUse) warnings.push("Repair installed but power is insufficient");
  if (stats.shield > 0 && stats.powerGeneration < stats.powerUse) warnings.push("Shields installed but power is insufficient");
  if (weaponCount === 0) warnings.push("No weapons: this ship cannot attack");
  return warnings;
}

function makeStars(count) {
  const stars = [];
  for (let i = 0; i < count; i += 1) {
    const bright = Math.random() > 0.78;
    stars.push({
      x: Math.random(),
      y: Math.random(),
      size: bright ? 2 : 1,
      drift: -0.006 - Math.random() * 0.018,
      color: bright ? "rgba(220,242,255,0.86)" : "rgba(170,194,220,0.42)"
    });
  }
  return stars;
}

function roundRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

const roomFromUrl = new URLSearchParams(location.search).get("room");
if (roomFromUrl) {
  dom.roomCode.value = roomFromUrl.toUpperCase().slice(0, 8);
} else {
  const activeRoom = (localStorage.getItem(LOCAL_ACTIVE_ROOM_KEY) || "").toUpperCase().slice(0, 8);
  if (activeRoom) {
    dom.roomCode.value = activeRoom;
    joinRoom(activeRoom);
  }
}
