// Renders part palette metadata, categories, description, and client-side definitions.

import { escapeHtml } from "../shared/formatting.js";

export const PART_DEFS = {
  core: { name: "Core", color: "#f3f7ff", glyph: "radial-gradient(circle, #ffffff 0 28%, #86ddff 31% 58%, #2b5d92 60%)" },
  frame: { name: "Frame", color: "#8393aa", glyph: "linear-gradient(135deg, #5f6e83 0 35%, #b6c1d2 36% 48%, #5f6e83 49%)" },
  armor: { name: "Armor", color: "#ff9a62", glyph: "linear-gradient(160deg, #ffbd79, #bb4d36)" },
  compositeArmor: { name: "Composite Armor", color: "#d7a56a", glyph: "linear-gradient(160deg, #ffe1a3, #8f5b32)" },
  halfFrameDiagonal: { name: "Half Frame", color: "#8393aa", glyph: "linear-gradient(135deg, #5f6e83 0 35%, #b6c1d2 36% 48%, #5f6e83 49%)" },
  halfArmorDiagonal: { name: "Half Armor", color: "#ff9a62", glyph: "linear-gradient(160deg, #ffbd79, #bb4d36)" },
  halfCompositeArmorDiagonal: { name: "Half Composite Armor", color: "#d7a56a", glyph: "linear-gradient(160deg, #ffe1a3, #8f5b32)" },
  wingFrame: { name: "Wing Frame", color: "#8393aa", glyph: "linear-gradient(135deg, #5f6e83 0 35%, #b6c1d2 36% 48%, #5f6e83 49%)" },
  wingArmor: { name: "Wing Armor", color: "#ff9a62", glyph: "linear-gradient(160deg, #ffbd79, #bb4d36)" },
  wingCompositeArmor: { name: "Wing Composite Armor", color: "#d7a56a", glyph: "linear-gradient(160deg, #ffe1a3, #8f5b32)" },
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

  flakCannon: { name: "Flak Cannon", color: "#fda4af", glyph: "radial-gradient(circle, #fecdd3 0 25%, #f43f5e 35% 56%, #881337 62%)" },
  interceptorPod: { name: "Interceptor Pod", color: "#c084fc", glyph: "radial-gradient(circle, #f3e8ff 0 22%, #a855f7 30% 60%, #3b0764 65%)" },
  lightBlaster: { name: "Light Blaster", color: "#fb7185", glyph: "linear-gradient(90deg, #3f0d1b 0 18%, #fb7185 20% 72%, #ffe4e6 73%)" },
  heavyBlaster: { name: "Heavy Blaster", color: "#f43f5e", glyph: "linear-gradient(90deg, #3f0d1b 0 16%, #e11d48 18% 70%, #ffe4e6 72%)" },
  autocannon: { name: "Autocannon", color: "#f97316", glyph: "linear-gradient(90deg, #431407 0 18%, #fb923c 20% 70%, #ffedd5 72%)" },
  lightMissile: { name: "Light Missile", color: "#c084fc", glyph: "linear-gradient(90deg, #2e1065 0 25%, #c084fc 26% 68%, #f3e8ff 69%)" },
  torpedo: { name: "Torpedo", color: "#a78bfa", glyph: "linear-gradient(90deg, #1e1b4b 0 22%, #8b5cf6 24% 70%, #ede9fe 72%)" },
  swarmMissile: { name: "Swarm Pod", color: "#d8b4fe", glyph: "radial-gradient(circle, #faf5ff 0 12%, #a855f7 18% 30%, #581c87 42%)" },
  lightRailgun: { name: "Light Railgun", color: "#e2e8f0", glyph: "linear-gradient(90deg, #0f172a 0 16%, #e2e8f0 18% 72%, #60a5fa 74%)" },
  heavyRailgun: { name: "Heavy Railgun", color: "#f8fafc", glyph: "linear-gradient(90deg, #020617 0 14%, #f8fafc 16% 70%, #3b82f6 74%)" },
  beamEmitter: { name: "Beam Emitter", color: "#bae6fd", glyph: "linear-gradient(90deg, #082f49 0 18%, #7dd3fc 20% 76%, #eff6ff 78%)" },
  aegisProjector: { name: "Aegis Projector", color: "#6ee7b7", glyph: "radial-gradient(circle, #ecfdf5 0 18%, #34d399 30% 56%, #064e3b 64%)" },
  sensorArray: { name: "Sensor Array", color: "#a7f3d0", glyph: "radial-gradient(circle, #ecfdf5 0 15%, #10b981 25% 45%, #064e3b 55%)" },
  targetingComputer: { name: "Targeting Computer", color: "#f0abfc", glyph: "linear-gradient(135deg, #701a75, #f0abfc)" },
  fireControl: { name: "Fire Control", color: "#fdba74", glyph: "linear-gradient(135deg, #7c2d12, #fed7aa)" },
  heatSink: { name: "Heat Sink", color: "#bfdbfe", glyph: "linear-gradient(180deg, #eff6ff 0 15%, #3b82f6 18% 32%, #eff6ff 35% 50%, #1d4ed8 54%)" },
  captureModule: { name: "Capture Module", color: "#f9a8d4", glyph: "radial-gradient(circle, #fdf2f8 0 20%, #ec4899 30% 55%, #831843 62%)" },
  signalAmplifier: { name: "Signal Amplifier", color: "#5eead4", glyph: "radial-gradient(circle, #ccfbf1 0 12%, #14b8a6 24% 42%, #134e4a 58%)" },
  stabilizerNode: { name: "Stabilizer Node", color: "#ddd6fe", glyph: "conic-gradient(from 45deg, #4c1d95, #ddd6fe, #7c3aed, #4c1d95)" },
  repairBeam: { name: "Repair Beam", color: "#86efac", glyph: "linear-gradient(90deg, #052e16 0 18%, #22c55e 20% 70%, #dcfce7 72%)" }
};

const MARKERLESS_ROTATABLE_PARTS = new Set(["halfFrameDiagonal", "wingFrame"]);

export const PART_DESCRIPTIONS = Object.freeze({
  core: "Command heart of the ship. Provides basic hull, power, shielding, and the required connection point.",
  frame: "Cheap structure used to expand the ship shape and connect other modules.",
  armor: "Heavy passive protection. Adds strong hull but increases mass and slows turning.",
  engine: "Main propulsion module. Adds thrust for speed and acceleration.",
  reactor: "Primary power source for weapons, shields, engines, and support systems.",
  battery: "Energy reserve with a small shield buffer. Helps survivability without generating power.",
  shield: "Active defensive barrier. Adds shield capacity and recharge at a power cost.",
  blaster: "General-purpose gun with medium range, steady damage, and a forward firing arc.",
  missile: "Tracking burst weapon with long reach, high impact, and slow reload.",
  railgun: "Long-range precision weapon with heavy damage, narrow arc, and high power draw.",
  repair: "Support module that slowly repairs hull damage during battle.",
  compositeArmor: "Lighter armor plate that gives efficient hull without as much mass as standard armor.",
  capacitor: "Large energy bank with extra shield capacity but no power generation.",
  auxGenerator: "Small backup generator for light power deficits and compact ship builds.",
  maneuverThruster: "Side-control engine that improves turning more than straight-line speed.",
  gyroscope: "Stabilization module that improves turn rate without adding thrust.",
  pointDefense: "Protects nearby ships from missiles and torpedoes. Very weak against normal ships.",

  flakCannon: "Short-range anti-missile and anti-swarm defence. Poor range and weak direct damage.",
  interceptorPod: "Longer-range missile interception. Expensive and weak against ships.",
  autocannon: "Rapid-fire weapon with high spread. Best against nearby light targets.",
  torpedo: "Slow heavy missile with major burst damage against large ships.",
  swarmMissile: "Missile pod that fires frequent tracking shots for pressure and pursuit.",
  beamEmitter: "Medium-short sustained beam weapon with a focused burn path and high power use.",
  aegisProjector: "Defence module that projects a fast-recharging shield field at a high power cost.",
  sensorArray: "Support electronics that extend weapon range for long-distance ships.",
  targetingComputer: "Support computer that improves weapon accuracy.",
  fireControl: "Weapon coordinator that improves rate of fire but uses significant power.",
  heatSink: "Cooling support that is durable and low-power for weapon-heavy designs.",
  captureModule: "Objective module that helps dedicated capture ships contest relays.",
  signalAmplifier: "Utility transmitter that extends weapon range for command and skirmish ships.",
  stabilizerNode: "Utility stabilizer that improves weapon accuracy and slightly helps turning.",
  repairBeam: "Heavy support repair system with stronger hull recovery and high power draw."
});

export const FALLBACK_PART_STATS = {
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
      tracking: 0.7,
      trackTime: 1.5,
      trackingDelay: 0.25,
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
    shield: 16, shieldRegen: 0.25,
    thrust: 0, turn: -0.015,
    energyStorage: 0, repairRate: 5,
    repair: 1,
    weapon: null
  },
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
      accuracy: 0.68,
      tracking: 0.82,
      trackTime: 1.7,
      trackingDelay: 0.15,
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
      tracking: 0.25,
      trackTime: 1.1,
      trackingDelay: 0.45,
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
      trackTime: 1.7,
      trackingDelay: 0.15,
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
    beam: 1,
    weapon: makeWeapon("beam", {
      damage: 34,
      fireRate: 1,
      range: 520,
      radius: 16,
      projectileSpeed: 0,
      accuracy: 0.99,
      aimSpeed: 1.65,
      arc: 110
    }),
    rotationRequired: true
  },
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
};

export let PART_STATS = buildPartStatsFromBalance(null, FALLBACK_PART_STATS);

export function applyComponentBalance(balance) {
  PART_STATS = { ...normalizeRuntimeParts(FALLBACK_PART_STATS), ...buildPartStatsFromBalance(balance, FALLBACK_PART_STATS) };
}

export function applyServerParts(parts) {
  const normalized = normalizeRuntimeParts(parts);
  PART_STATS = { ...PART_STATS, ...normalized };
}

export function isRotatablePart(type) {
  const stat = PART_STATS[type] || {};
  return stat.category === "Weapons" || stat.rotatable === true || MARKERLESS_ROTATABLE_PARTS.has(type);
}

export function shouldShowRotationMarker(type) {
  return isRotatablePart(type) && !MARKERLESS_ROTATABLE_PARTS.has(type);
}

export function shouldRotateDesignerGlyph(type) {
  return MARKERLESS_ROTATABLE_PARTS.has(type);
}


import { HIDDEN_PARTS } from "../constants.js";

export function isPalettePart(type) {
  return type !== "core" && !HIDDEN_PARTS.has(type) && Boolean(PART_STATS[type]);
}


export function partCategory(type) {
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

export function partDescription(type, stat) {
  return stat.description || PART_DESCRIPTIONS[type] || "General-purpose ship component.";
}

export function partIconMarkup(type, extraClass = "") {
  const safeType = String(type || "frame").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  const classes = ["part-glyph", `part-${safeType}`, extraClass].filter(Boolean).join(" ");
  const color = PART_DEFS[type]?.color || "#8393aa";
  const style = ` style="--part-accent:${escapeHtml(color)}"`;
  return `<span class="${classes}"${style} aria-hidden="true"><span></span></span>`;
}

export function makeWeapon(type, stats) {
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
    reload: Number((1 / fireRate).toFixed(2)),
    range: stats.range,
    radius: Number(stats.radius) || 0,
    projectileSpeed: stats.projectileSpeed,
    accuracy: stats.accuracy,
    tracking: tracking,
    trackTime: Number(stats.trackTime) || 0,
    trackingDelay: Number(stats.trackingDelay) || 0,
    aimSpeed: aimSpeed !== undefined ? Number(aimSpeed) : undefined,
    arc: Number(stats.arc) || 360,
    dps: Number((damage * fireRate).toFixed(1)),
    missileHp: Number(stats.missileHp) || 0,
    antiMissile: Boolean(stats.antiMissile),
    shipDamageMultiplier: Number(stats.shipDamageMultiplier) || 1,
    targetPriority: stats.targetPriority || [],
    shieldDamageMultiplier: Number(stats.shieldDamageMultiplier ?? 1),
    hullDamageMultiplier: Number(stats.hullDamageMultiplier ?? 1)
  };
}

export function buildPartStatsFromBalance(balance, fallbackParts) {
  const components = Array.isArray(balance?.components) ? balance.components : [];
  if (!components.length) return normalizeRuntimeParts(fallbackParts);

  const parts = {};
  for (const component of components) {
    if (!component || typeof component.id !== "string") continue;
    parts[component.id] = normalizeBalanceComponent(component);
  }
  if (!parts.core && fallbackParts.core) parts.core = normalizeRuntimePart(fallbackParts.core);
  return parts;
}

export function normalizeRuntimeParts(parts = {}) {
  const normalized = {};
  for (const [type, part] of Object.entries(parts || {})) {
    normalized[type] = normalizeRuntimePart(part);
  }
  return normalized;
}

export function normalizeRuntimePart(part = {}) {
  const weapon = part.weapon
    ? makeWeapon(part.weapon.family || part.weapon.type || "blaster", part.weapon)
    : null;
  const repairRate = numberOr(part.repairRate ?? part.repair, 0);
  const normalized = {
    ...part,
    category: part.category || "Utility",
    cost: numberOr(part.cost, 0),
    mass: numberOr(part.mass, 0),
    hp: numberOr(part.hp ?? part.hull, 0),
    powerGeneration: numberOr(part.powerGeneration, 0),
    powerUse: numberOr(part.powerUse, 0),
    shield: numberOr(part.shield, 0),
    shieldRegen: numberOr(part.shieldRegen, 0),
    thrust: numberOr(part.thrust, 0),
    turn: numberOr(part.turn, 0),
    energyStorage: numberOr(part.energyStorage ?? part.energy, 0),
    repairRate,
    repair: repairRate > 0 ? 1 : numberOr(part.repairCount ?? part.repair, 0),
    weapon,
    description: part.description || "",
    utilityEffect: part.utilityEffect || part.utility || "",
    rangeBonus: numberOr(part.rangeBonus, 0),
    accuracyBonus: numberOr(part.accuracyBonus, 0),
    fireRateBonus: numberOr(part.fireRateBonus, 0),
    captureBonus: numberOr(part.captureBonus, 0),
    heat: numberOr(part.heat, 0),
    rotationRequired: Boolean(part.rotationRequired || part.rotatable),
    ecmStrength: numberOr(part.ecmStrength, 0),
    decoyRange: numberOr(part.decoyRange, 0),
    decoyCooldown: numberOr(part.decoyCooldown, 0),
    decoyConfuseDuration: numberOr(part.decoyConfuseDuration, 0),
    decoyChance: numberOr(part.decoyChance, 0),
    frontDamageReduction: numberOr(part.frontDamageReduction, 0),
    frontArc: numberOr(part.frontArc, 0),
    footprint: part.footprint ? { width: numberOr(part.footprint.width, 1), height: numberOr(part.footprint.height, 1) } : { width: 1, height: 1 }
  };
  if (weapon) normalized[weapon.type] = 1;
  for (const family of ["blaster", "missile", "railgun", "beam", "pointDefense"]) {
    if (part[family]) normalized[family] = numberOr(part[family], normalized[family] || 0);
  }
  return normalized;
}

export function normalizeBalanceComponent(component) {
  const weapon = component.weapon
    ? makeWeapon(component.weapon.family || component.weapon.type || "blaster", component.weapon)
    : null;
  const repairRate = numberOr(component.repairRate ?? component.repair, 0);
  const part = {
    category: component.category || "Utility",
    cost: numberOr(component.cost, 0),
    mass: numberOr(component.mass, 0),
    hp: numberOr(component.hp ?? component.hull, 0),
    powerGeneration: numberOr(component.powerGeneration, 0),
    powerUse: numberOr(component.powerUse, 0),
    shield: numberOr(component.shield, 0),
    shieldRegen: numberOr(component.shieldRegen, 0),
    thrust: numberOr(component.thrust, 0),
    turn: numberOr(component.turn, 0),
    energyStorage: numberOr(component.energyStorage ?? component.energy, 0),
    repairRate,
    repair: repairRate > 0 ? 1 : numberOr(component.repairCount, 0),
    weapon,
    description: component.description || "",
    utilityEffect: component.utilityEffect || component.utility || "",
    rangeBonus: numberOr(component.rangeBonus, 0),
    accuracyBonus: numberOr(component.accuracyBonus, 0),
    fireRateBonus: numberOr(component.fireRateBonus, 0),
    captureBonus: numberOr(component.captureBonus, 0),
    heat: numberOr(component.heat, 0),
    rotationRequired: Boolean(component.rotationRequired || component.rotatable),
    ecmStrength: numberOr(component.ecmStrength, 0),
    decoyRange: numberOr(component.decoyRange, 0),
    decoyCooldown: numberOr(component.decoyCooldown, 0),
    decoyConfuseDuration: numberOr(component.decoyConfuseDuration, 0),
    decoyChance: numberOr(component.decoyChance, 0),
    frontDamageReduction: numberOr(component.frontDamageReduction, 0),
    frontArc: numberOr(component.frontArc, 0),
    footprint: component.footprint ? { width: numberOr(component.footprint.width, 1), height: numberOr(component.footprint.height, 1) } : { width: 1, height: 1 }
  };
  if (weapon) part[weapon.type] = 1;
  for (const family of ["blaster", "missile", "railgun", "beam", "pointDefense"]) {
    if (component[family]) part[family] = numberOr(component[family], part[family] || 0);
  }
  return part;
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
