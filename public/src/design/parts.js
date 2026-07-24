// Renders part palette metadata, categories, description, and client-side definitions.

import { componentIconDataUrl, rotatedFootprint, clearComponentIconCache } from "../ui/componentIcon.js";
import { GENERATED_BALANCE } from "../generatedBalance.js";

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
  pointDefense: { name: "Laser Point Defence", color: "#fda4af", glyph: "radial-gradient(circle, #fff1f2 0 18%, #fb7185 30% 56%, #881337 62%)" },

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
  heatPipe: { name: "Heat Pipe", color: "#38bdf8", glyph: "linear-gradient(90deg, #082f49 0 18%, #38bdf8 20% 36%, #e0f2fe 38% 50%, #38bdf8 52% 68%, #082f49 70%)" },
  heatSink: { name: "Heat Sink", color: "#bfdbfe", glyph: "linear-gradient(180deg, #eff6ff 0 15%, #3b82f6 18% 32%, #eff6ff 35% 50%, #1d4ed8 54%)" },
  radiator: { name: "Radiator", color: "#7dd3fc", glyph: "repeating-linear-gradient(90deg, #0c4a6e 0 12%, #bae6fd 13% 22%)" },
  captureModule: { name: "Capture Module", color: "#f9a8d4", glyph: "radial-gradient(circle, #fdf2f8 0 20%, #ec4899 30% 55%, #831843 62%)" },
  signalAmplifier: { name: "Signal Amplifier", color: "#5eead4", glyph: "radial-gradient(circle, #ccfbf1 0 12%, #14b8a6 24% 42%, #134e4a 58%)" },
  stabilizerNode: { name: "Stabilizer Node", color: "#ddd6fe", glyph: "conic-gradient(from 45deg, #4c1d95, #ddd6fe, #7c3aed, #4c1d95)" },
  repairBeam: { name: "Repair Beam", color: "#86efac", glyph: "linear-gradient(90deg, #052e16 0 18%, #22c55e 20% 70%, #dcfce7 72%)" },
  droneBay: { name: "Drone Bay", color: "#67e8f9", glyph: "radial-gradient(circle at 50% 50%, #e0f2fe 0 13%, #22d3ee 15% 28%, #0e7490 30% 43%, #082f49 45%)" },
  switchgear: { name: "Switchgear", color: "#facc15", glyph: "linear-gradient(90deg, #422006 0 22%, #facc15 24% 42%, #111827 44% 56%, #facc15 58% 76%, #422006 78%)" }
};

// These structural silhouettes show their direction through their geometry, so
// all material variants rotate without an extra arrow marker.
const MARKERLESS_ROTATABLE_PARTS = new Set([
  "halfFrameDiagonal",
  "halfArmorDiagonal",
  "halfCompositeArmorDiagonal",
  "wingFrame",
  "wingArmor",
  "wingCompositeArmor"
]);

const FIXED_ORIENTATION_PARTS = new Set(["engine", "maneuverThruster"]);

export const PART_DESCRIPTIONS = Object.freeze({
  core: "Command heart of the ship. Provides basic hull, power, shielding, and the required connection point.",
  frame: "Cheap structure used to expand the ship shape and connect other modules.",
  armor: "Heavy passive protection. Adds strong hull but increases mass and slows turning.",
  engine: "Main propulsion module. Adds thrust for speed and acceleration.",
  reactor: "Primary power source for weapons, shields, engines, and support systems. Generates heat with load and melts down (explodes) if kept overheated.",
  battery: "Energy reserve with a small shield buffer. Helps survivability without generating power.",
  shield: "Active defensive barrier. Adds shield capacity and recharge at a power cost.",
  blaster: "General-purpose gun with medium range, steady damage, and a forward firing arc.",
  missile: "Tracking burst weapon with long reach, high impact, and slow reload.",
  railgun: "Long-range precision weapon with heavy damage, narrow arc, and high power draw.",
  repair: "Support module that slowly repairs hull damage during battle.",
  compositeArmor: "Lighter armor plate that gives efficient hull without as much mass as standard armor.",
  capacitor: "Large energy bank with extra shield capacity but no power generation.",
  auxGenerator: "Small backup generator for light power deficits and compact ship builds. Like all generators, it melts down if kept overheated.",
  maneuverThruster: "Side-control engine that improves turning more than straight-line speed.",
  gyroscope: "Stabilization module that improves turn rate without adding thrust.",
  pointDefense: "High-Power defensive laser designed to destroy hostile drones and light incoming ordnance. Its hitscan beam cannot miss once aligned, but it deals negligible damage to ships.",

  flakCannon: "Short-range anti-missile and anti-swarm defence. Poor range and weak direct damage.",
  interceptorPod: "Longer-range missile interception. Expensive and weak against ships.",
  autocannon: "Rapid-fire weapon with high spread. Best against nearby light targets.",
  torpedo: "Slow heavy missile with major burst damage against large ships.",
  swarmMissile: "Missile pod that fires frequent tracking shots for pressure and pursuit.",
  beamEmitter: "Sustained shield-breaking beam that aims towards the enemy Core. It strikes the first obstruction and can carry part of its excess damage into one component directly behind a destroyed module.",
  aegisProjector: "Defence module that projects a fast-recharging shield field at a high power cost.",
  sensorArray: "Support electronics that extend weapon range for long-distance ships.",
  targetingComputer: "Support computer that improves weapon accuracy.",
  fireControl: "Weapon coordinator that improves rate of fire but uses significant power.",
  heatPipe: "Specialised high-conductivity thermal conduit that transfers heat to a connected heat sink or radiator route. It does not remove heat, stores very little heat, and is structurally weak, so it cannot replace frames for hull support.",
  heatSink: "High-capacity thermal buffer that soaks heat from connected frames and boosts adjacent components' heat capacity. Pair with radiators to shed the stored heat.",
  radiator: "Continuous heat removal that works best with an exposed exterior edge; only 25% effective when fully enclosed.",
  captureModule: "Objective module that helps dedicated capture ships contest relays.",
  signalAmplifier: "Support transmitter that extends weapon range for command and skirmish ships.",
  stabilizerNode: "Support stabilizer that improves weapon accuracy and slightly helps turning.",
  repairBeam: "Heavy support repair system with stronger hull recovery and high power draw.",
  droneBay: "Launches and rebuilds a squad of three configurable Fighter, Defence, or Repair drones. One complete two-cell edge must remain exposed.",
  switchgear: "Two-cell Power switchgear with opposite A/B terminals. Saved modes: Open isolates, Closed conducts up to rating, Automatic conducts only deterministic spare power. Never carries Data."
});

export const FALLBACK_PART_STATS = {};

export let PART_STATS = buildPartStatsFromBalance(GENERATED_BALANCE, FALLBACK_PART_STATS);
let componentCatalogueAuthority = "generated";

export function componentCatalogueSource() {
  return componentCatalogueAuthority;
}

export function applyComponentBalance(balance) {
  // HTTP balance data is useful for menu/offline rendering, but once a hello
  // message supplies the server-normalized catalogue it must not be allowed to
  // race in late and overwrite authoritative gameplay preview data.
  if (componentCatalogueAuthority === "server") return false;
  PART_STATS = buildPartStatsFromBalance(balance, FALLBACK_PART_STATS);
  componentCatalogueAuthority = "http";
  clearComponentIconCache(); // footprints may have changed, rebake icons
  return true;
}

export function applyServerParts(parts) {
  const normalized = normalizeRuntimeParts(parts);
  PART_STATS = normalized;
  componentCatalogueAuthority = "server";
  clearComponentIconCache();
  return true;
}

export function isRotatablePart(type) {
  if (FIXED_ORIENTATION_PARTS.has(type)) return false;
  const stat = PART_STATS[type] || {};
  const allowed = Array.isArray(stat.allowedRotations)
    ? stat.allowedRotations.map(Number).filter(Number.isFinite)
    : [];
  if (allowed.length > 1) return true;
  return stat.category === "Weapons"
    || (stat.category === "Defence" && Boolean(stat.weapon))
    || stat.rotatable === true
    || stat.rotationRequired === true
    || MARKERLESS_ROTATABLE_PARTS.has(type);
}


import { HIDDEN_PARTS } from "../constants.js";

export function isPalettePart(type) {
  return type !== "core" && !HIDDEN_PARTS.has(type) && Boolean(PART_STATS[type]);
}


export function partCategory(type) {
  const stat = PART_STATS[type] || {};
  if (stat.category) return stat.category === "Utility" ? "Support" : stat.category;
  if (type === "frame" || type === "armor") return "Structure";
  if (type === "reactor" || type === "battery") return "Power";
  if (type === "engine") return "Engines";
  if (type === "shield") return "Defence";
  if (stat.weapon) return "Weapons";
  if (type === "repair") return "Support";
  return "Support";
}

export function partDescription(type, stat) {
  return stat.description || PART_DESCRIPTIONS[type] || "General-purpose ship component.";
}

export function partIconMarkup(type, extraClass = "", rotationDeg = 0) {
  const safeType = String(type || "frame").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  const classes = ["part-glyph", `part-${safeType}`, extraClass].filter(Boolean).join(" ");
  const url = componentIconDataUrl(type, rotationDeg);
  // The baked PNG carries the footprint aspect ratio as its intrinsic size, so an
  // <img> scales correctly in the palette, grid, and inspector with plain CSS.
  const src = url ? `src="${url}" ` : "";
  return `<img class="${classes}" ${src}alt="" draggable="false" aria-hidden="true">`;
}

export function makeWeapon(type, stats) {
  const fireRate = Number(stats.fireRate) || 1;
  const damage = Number(stats.damage) || 0;
  
  let tracking = stats.tracking || 0;
  // aimSpeed is an optional override of the shared TurretRules traverse rate.
  // MessagePack serializes an absent aimSpeed as null on the live hello path;
  // Number(null) is 0, which would freeze every turret sprite (turnRateFor
  // treats any finite aimSpeed as authoritative). Only a real finite value may
  // survive normalization.
  let aimSpeed = stats.aimSpeed === null || stats.aimSpeed === undefined ? undefined : Number(stats.aimSpeed);
  if (!Number.isFinite(aimSpeed)) aimSpeed = undefined;
  if (type === "beam") {
    if (stats.tracking && aimSpeed === undefined) {
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
    parts[component.id] = normalizeBalanceComponent(component, balance);
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
    category: part.category === "Utility" || !part.category ? "Support" : part.category,
    powerCategory: typeof part.powerCategory === "string" ? part.powerCategory : null,
    cost: numberOr(part.cost, 0),
    mass: numberOr(part.mass, 0),
    hp: numberOr(part.hp ?? part.hull, 0),
    powerGeneration: numberOr(part.powerGeneration, 0),
    powerUse: numberOr(part.powerUse, 0),
    shield: numberOr(part.shield, 0),
    shieldRegen: numberOr(part.shieldRegen, 0),
    thrust: numberOr(part.thrust, 0),
    lateralThrust: numberOr(part.lateralThrust, 0),
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
    // Server-normalized parts expose rotationRequired even when they omit the
    // source balance file's rotatable field. Preserve that capability when a
    // hello/state message replaces the locally loaded component definition.
    rotatable: Boolean(part.rotatable || part.rotationRequired),
    rotationRequired: Boolean(part.rotationRequired || part.rotatable),
    allowedRotations: Array.isArray(part.allowedRotations) ? part.allowedRotations.map(Number).filter(Number.isFinite) : undefined,
    ecmStrength: numberOr(part.ecmStrength, 0),
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

export function normalizeBalanceComponent(component, balance = GENERATED_BALANCE) {
  const weapon = component.weapon
    ? makeWeapon(component.weapon.family || component.weapon.type || "blaster", component.weapon)
    : null;
  const repairRate = numberOr(component.repairRate ?? component.repair, 0);
  const part = {
    category: component.category === "Utility" || !component.category ? "Support" : component.category,
    powerCategory: typeof component.powerCategory === "string" ? component.powerCategory : null,
    cost: numberOr(component.cost, 0),
    mass: numberOr(component.mass, 0),
    hp: numberOr(component.hp ?? component.hull, 0),
    powerGeneration: numberOr(component.powerGeneration, 0),
    powerUse: numberOr(component.powerUse, 0),
    shield: numberOr(component.shield, 0),
    shieldRegen: numberOr(component.shieldRegen, 0),
    thrust: numberOr(component.thrust, 0),
    lateralThrust: numberOr(component.lateralThrust, 0),
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
    rotatable: Boolean(component.rotatable),
    rotationRequired: Boolean(component.rotationRequired || component.rotatable),
    allowedRotations: Array.isArray(component.allowedRotations) ? component.allowedRotations.map(Number).filter(Number.isFinite) : undefined,
    ecmStrength: numberOr(component.ecmStrength, 0),
    frontDamageReduction: numberOr(component.frontDamageReduction, 0),
    frontArc: numberOr(component.frontArc, 0),
    footprint: component.footprint ? { width: numberOr(component.footprint.width, 1), height: numberOr(component.footprint.height, 1) } : { width: 1, height: 1 }
  };
  if (component.id === "droneBay" && balance?.drones) {
    part.activityHeat = numberOr(balance.drones.activeHeatPerSecond, 0);
    part.droneConfig = JSON.parse(JSON.stringify(balance.drones));
  }
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
