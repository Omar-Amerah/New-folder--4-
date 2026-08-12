// Renders part palette metadata, categories, description, and client-side definitions.

import { componentIconDataUrl, rotatedFootprint, clearComponentIconCache } from "../ui/componentIcon.js";
import { GENERATED_BALANCE } from "../generatedBalance.js";
import "../shared/componentTransform.js";
import "../shared/weaponPresentationRules.js";

const ComponentTransform = globalThis.ComponentTransform;
const WeaponPresentationRules = globalThis.WeaponPresentationRules;

export const PART_DEFS = {
  core: { name: "Core", color: "#f3f7ff", glyph: "radial-gradient(circle, #ffffff 0 28%, #86ddff 31% 58%, #2b5d92 60%)" },
  frame: { name: "Frame", color: "#8393aa", glyph: "linear-gradient(135deg, #5f6e83 0 35%, #b6c1d2 36% 48%, #5f6e83 49%)" },
  halfFrameDiagonal: { name: "Half Frame", color: "#8393aa", glyph: "linear-gradient(135deg, #5f6e83 0 35%, #b6c1d2 36% 48%, #5f6e83 49%)" },
  wingFrame: { name: "Wing Frame", color: "#8393aa", glyph: "linear-gradient(135deg, #5f6e83 0 35%, #b6c1d2 36% 48%, #5f6e83 49%)" },
  bevelFrame: { name: "Bevel Frame", color: "#8393aa", glyph: "linear-gradient(135deg, #5f6e83 0 35%, #b6c1d2 36% 48%, #5f6e83 49%)" },
  roundedFrame: { name: "Rounded Frame", color: "#8393aa", glyph: "linear-gradient(135deg, #5f6e83 0 35%, #b6c1d2 36% 48%, #5f6e83 49%)" },
  longWedgeFrame: { name: "Long Wedge Frame", color: "#8393aa", glyph: "linear-gradient(135deg, #5f6e83 0 35%, #b6c1d2 36% 48%, #5f6e83 49%)" },
  armor: { name: "Armor", color: "#ff9a62", glyph: "linear-gradient(160deg, #ffbd79, #bb4d36)" },
  halfArmorDiagonal: { name: "Half Armor", color: "#ff9a62", glyph: "linear-gradient(160deg, #ffbd79, #bb4d36)" },
  wingArmor: { name: "Wing Armor", color: "#ff9a62", glyph: "linear-gradient(160deg, #ffbd79, #bb4d36)" },
  bevelArmor: { name: "Bevel Armour", color: "#ff9a62", glyph: "linear-gradient(160deg, #ffbd79, #bb4d36)" },
  roundedArmor: { name: "Rounded Armour", color: "#ff9a62", glyph: "linear-gradient(160deg, #ffbd79, #bb4d36)" },
  longWedgeArmor: { name: "Long Wedge Armour", color: "#ff9a62", glyph: "linear-gradient(160deg, #ffbd79, #bb4d36)" },
  compositeArmor: { name: "Composite Armor", color: "#d7a56a", glyph: "linear-gradient(160deg, #ffe1a3, #8f5b32)" },
  halfCompositeArmorDiagonal: { name: "Half Composite Armor", color: "#d7a56a", glyph: "linear-gradient(160deg, #ffe1a3, #8f5b32)" },
  wingCompositeArmor: { name: "Wing Composite Armor", color: "#d7a56a", glyph: "linear-gradient(160deg, #ffe1a3, #8f5b32)" },
  bevelCompositeArmor: { name: "Bevel Composite Armour", color: "#d7a56a", glyph: "linear-gradient(160deg, #ffe1a3, #8f5b32)" },
  roundedCompositeArmor: { name: "Rounded Composite Armour", color: "#d7a56a", glyph: "linear-gradient(160deg, #ffe1a3, #8f5b32)" },
  longWedgeCompositeArmor: { name: "Long Wedge Composite Armour", color: "#d7a56a", glyph: "linear-gradient(160deg, #ffe1a3, #8f5b32)" },
  // Scorched crimson, deliberately away from Armor's orange and Composite's tan:
  // ablative plating is a different material with a different failure mode and
  // must not read as "another armour block" in the palette. The whole family sits
  // last in the Structure palette so the crimson block does not split the orange
  // armour / tan composite / steel frame columns above it.
  ablativeArmor: { name: "Ablative Plating", color: "#cf4436", glyph: "linear-gradient(160deg, #ff9b7a, #7f1d1d)" },
  halfAblativeArmorDiagonal: { name: "Half Ablative Plating", color: "#cf4436", glyph: "linear-gradient(160deg, #ff9b7a, #7f1d1d)" },
  wingAblativeArmor: { name: "Wing Ablative Plating", color: "#cf4436", glyph: "linear-gradient(160deg, #ff9b7a, #7f1d1d)" },
  bevelAblativeArmor: { name: "Bevel Ablative Plating", color: "#cf4436", glyph: "linear-gradient(160deg, #ff9b7a, #7f1d1d)" },
  roundedAblativeArmor: { name: "Rounded Ablative Plating", color: "#cf4436", glyph: "linear-gradient(160deg, #ff9b7a, #7f1d1d)" },
  longWedgeAblativeArmor: { name: "Long Wedge Ablative Plating", color: "#cf4436", glyph: "linear-gradient(160deg, #ff9b7a, #7f1d1d)" },
  // Cool ceramic blue-white, deliberately outside the orange armour / tan
  // composite / crimson ablative range: Refractory Armour is a thermal material
  // and must not read as "another hull plate" in the Structure palette. The
  // whole family sits last in Structure : after the crimson ablative block : so
  // the ceramic column does not split the existing material groups above it.
  refractoryArmor: { name: "Refractory Armour", color: "#9dd7e8", glyph: "linear-gradient(160deg, #e0f7ff, #3f6b7d)" },
  halfRefractoryArmorDiagonal: { name: "Half Refractory Armour", color: "#9dd7e8", glyph: "linear-gradient(160deg, #e0f7ff, #3f6b7d)" },
  wingRefractoryArmor: { name: "Wing Refractory Armour", color: "#9dd7e8", glyph: "linear-gradient(160deg, #e0f7ff, #3f6b7d)" },
  bevelRefractoryArmor: { name: "Bevel Refractory Armour", color: "#9dd7e8", glyph: "linear-gradient(160deg, #e0f7ff, #3f6b7d)" },
  roundedRefractoryArmor: { name: "Rounded Refractory Armour", color: "#9dd7e8", glyph: "linear-gradient(160deg, #e0f7ff, #3f6b7d)" },
  longWedgeRefractoryArmor: { name: "Long Wedge Refractory Armour", color: "#9dd7e8", glyph: "linear-gradient(160deg, #e0f7ff, #3f6b7d)" },
  engine:{ name: "Engine", color: "#54d7ff", glyph: "linear-gradient(180deg, #68efff, #225ed8 52%, #111827)" },
  compactEngine: { name: "Compact Engine", color: "#38bdf8", glyph: "linear-gradient(180deg, #a5f3fc, #0ea5e9 52%, #082f49)" },
  reactor: { name: "Reactor", color: "#ffdc5e", glyph: "radial-gradient(circle, #fff7b3 0 20%, #f4c145 26% 55%, #6b4b12 60%)" },
  nuclearReactor: { name: "Nuclear Reactor", color: "#facc15", glyph: "radial-gradient(circle, #fffde7 0 12%, #fde047 14% 30%, #f97316 34% 48%, #7c2d12 54%)" },
  auxGenerator: { name: "Aux Generator", color: "#fef08a", glyph: "linear-gradient(45deg, #422006, #eab308, #fef9c3)" },
  backupCore: { name: "Backup Command Core", color: "#c4b5fd", glyph: "radial-gradient(circle, #f5f3ff 0 18%, #8b5cf6 22% 48%, #312e81 54%)" },
  battery: { name: "Battery", color: "#7ee0ff", glyph: "linear-gradient(180deg, #d5fbff 0 20%, #47caee 22% 50%, #14536f 52%)" },
  shield: { name: "Shield", color: "#7cffa0", glyph: "radial-gradient(circle, #b9ffd0 0 18%, #39cc75 28% 54%, #114027 58%)" },
  blaster: { name: "Blaster", color: "#ff5f7e", glyph: "linear-gradient(90deg, #31131d 0 18%, #ff5f7e 20% 72%, #ffd1dc 73%)" },
  missile: { name: "Missile", color: "#fbbf24", glyph: "linear-gradient(90deg, #451a03 0 25%, #f59e0b 26% 68%, #fef3c7 69%)" },
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
  microThruster: { name: "Micro Thruster", color: "#67e8f9", glyph: "linear-gradient(180deg, #cffafe, #0891b2 55%, #164e63)" },
  heavyEngine: { name: "Heavy Engine", color: "#22d3ee", glyph: "linear-gradient(180deg, #a5f3fc, #0284c7 50%, #082f49)" },
  maneuverThruster: { name: "Maneuver Thruster", color: "#7dd3fc", glyph: "linear-gradient(135deg, #e0f2fe, #0369a1)" },
  // Blue rather than cyan: it belongs to the Engines family, but it is control
  // hardware, not thrust. The violet it used to wear put it outside the family
  // entirely and made it the same colour as the Backup Command Core.
  gyroscope: { name: "Gyroscope", color: "#60a5fa", glyph: "conic-gradient(#dbeafe, #1d4ed8, #dbeafe)" },
  lightShield: { name: "Light Shield", color: "#86efac", glyph: "radial-gradient(circle, #dcfce7 0 18%, #22c55e 30% 55%, #14532d 62%)" },
  heavyShield: { name: "Heavy Shield", color: "#4ade80", glyph: "radial-gradient(circle, #bbf7d0 0 18%, #16a34a 32% 60%, #052e16 66%)" },
  regenShield: { name: "Regen Shield", color: "#5eead4", glyph: "radial-gradient(circle, #ccfbf1 0 16%, #14b8a6 28% 58%, #134e4a 64%)" },
  pointDefense: { name: "Laser Point Defence", color: "#fda4af", glyph: "radial-gradient(circle, #fff1f2 0 18%, #fb7185 30% 56%, #881337 62%)" },
  decoyLauncher: { name: "Decoy Launcher", color: "#93c5fd", glyph: "radial-gradient(circle, #eff6ff 0 12%, #60a5fa 16% 28%, #7c3aed 32% 45%, #172554 50%)" },

  flakCannon: { name: "Flak Cannon", color: "#a3e635", glyph: "radial-gradient(circle, #ecfccb 0 25%, #84cc16 35% 56%, #365314 62%)" },
  interceptorPod: { name: "Interceptor Pod", color: "#c084fc", glyph: "radial-gradient(circle, #f3e8ff 0 22%, #a855f7 30% 60%, #3b0764 65%)" },
  lightBlaster: { name: "Light Blaster", color: "#fb7185", glyph: "linear-gradient(90deg, #3f0d1b 0 18%, #fb7185 20% 72%, #ffe4e6 73%)" },
  heavyBlaster: { name: "Heavy Blaster", color: "#f43f5e", glyph: "linear-gradient(90deg, #3f0d1b 0 16%, #e11d48 18% 70%, #ffe4e6 72%)" },
  autocannon: { name: "Autocannon", color: "#f97316", glyph: "linear-gradient(90deg, #431407 0 18%, #fb923c 20% 70%, #ffedd5 72%)" },
  lightMissile: { name: "Light Missile", color: "#c084fc", glyph: "linear-gradient(90deg, #2e1065 0 25%, #c084fc 26% 68%, #f3e8ff 69%)" },
  torpedo: { name: "Torpedo", color: "#a78bfa", glyph: "linear-gradient(90deg, #1e1b4b 0 22%, #8b5cf6 24% 70%, #ede9fe 72%)" },
  swarmMissile: { name: "Swarm Pod", color: "#2dd4bf", glyph: "radial-gradient(circle, #ccfbf1 0 12%, #14b8a6 18% 30%, #134e4a 42%)" },
  lightRailgun: { name: "Light Railgun", color: "#e2e8f0", glyph: "linear-gradient(90deg, #0f172a 0 16%, #e2e8f0 18% 72%, #60a5fa 74%)" },
  heavyRailgun: { name: "Heavy Railgun", color: "#f8fafc", glyph: "linear-gradient(90deg, #020617 0 14%, #f8fafc 16% 70%, #3b82f6 74%)" },
  beamEmitter: { name: "Beam Emitter", color: "#bae6fd", glyph: "linear-gradient(90deg, #082f49 0 18%, #7dd3fc 20% 76%, #eff6ff 78%)" },
  thermalInductionLance: { name: "Thermal Induction Lance", color: "#d8b4fe", glyph: "linear-gradient(90deg, #2e1065 0 18%, #a855f7 20% 58%, #f3e8ff 60% 78%, #7c3aed 80%)" },
  scatterCannon: { name: "Scatter Cannon", color: "#fbbf77", glyph: "radial-gradient(circle at 30% 50%, #431407 0 16%, #fb923c 20% 62%, #ffedd5 66%)" },
  plasmaCannon: { name: "Plasma Cannon", color: "#5eead4", glyph: "linear-gradient(90deg, #042f2e 0 20%, #14b8a6 22% 56%, #ccfbf1 60% 78%, #0f766e 80%)" },
  fragmentationCannon: { name: "Fragmentation Cannon", color: "#facc15", glyph: "linear-gradient(90deg, #422006 0 20%, #eab308 22% 62%, #fef9c3 66%)" },
  // Electric fuchsia, not the cyan it used to wear: that cyan was the exact
  // colour of the Micro Thruster, Small Sensor, Drone Bay and Propulsion Command
  // Relay, so the one weapon in the catalogue that ignores hull and eats Shield
  // read as another piece of cyan support hardware. Magenta is unused anywhere
  // else in the palette (the nearest thing is the pale pink Targeting Computer),
  // so the anti-Shield mount is identifiable on a hull at a glance.
  // The mid fuchsia rather than the lighter #e879f9: weaponMetals() derives the
  // barrel/housing ramp from this colour, and off a near-pastel base the lit
  // hardware landed within a few percent of the hull face and the whole tile
  // washed into one pink block. #e879f9 stays as the weapon's emissive arc.
  empCannon: { name: "EMP Cannon", color: "#d946ef", glyph: "radial-gradient(circle at 72% 50%, #fdf4ff 0 12%, #e879f9 15% 32%, #a21caf 34% 54%, #3b0764 58%)" },
  spinalAccelerator: { name: "Spinal Accelerator", color: "#93c5fd", glyph: "linear-gradient(90deg, #020617 0 12%, #1d4ed8 14% 34%, #93c5fd 36% 74%, #ffffff 78%)" },
  aegisProjector: { name: "Aegis Projector", color: "#6ee7b7", glyph: "radial-gradient(circle, #ecfdf5 0 18%, #34d399 30% 56%, #064e3b 64%)" },
  targetingComputer: { name: "Targeting Computer", color: "#f0abfc", glyph: "linear-gradient(135deg, #701a75, #f0abfc)" },
  fireControl: { name: "Fire Control", color: "#fdba74", glyph: "linear-gradient(135deg, #7c2d12, #fed7aa)" },
  heatPipe: { name: "Heat Pipe", color: "#38bdf8", glyph: "linear-gradient(90deg, #082f49 0 18%, #38bdf8 20% 36%, #e0f2fe 38% 50%, #38bdf8 52% 68%, #082f49 70%)" },
  heatSink: { name: "Heat Sink", color: "#bfdbfe", glyph: "linear-gradient(180deg, #eff6ff 0 15%, #3b82f6 18% 32%, #eff6ff 35% 50%, #1d4ed8 54%)" },
  heatVent: { name: "Heat Vent", color: "#5fc9d8", glyph: "repeating-linear-gradient(0deg, #06323f 0 14%, #7fe3f0 15% 26%)" },
  radiator: { name: "Radiator", color: "#7dd3fc", glyph: "repeating-linear-gradient(90deg, #0c4a6e 0 12%, #bae6fd 13% 22%)" },
  closedCycleCooler: { name: "Closed-Cycle Cooler", color: "#22d3ee", glyph: "radial-gradient(circle, #cffafe 0 20%, #22d3ee 25% 55%, #0c4a6e 60%)" },
  burstCooler: { name: "Burst Cooler", color: "#a5f3fc", glyph: "radial-gradient(circle at 50% 62%, #ffffff 0 14%, #a5f3fc 18% 42%, #0e7490 48% 66%, #052e3a 72%)" },
  signalAmplifier: { name: "Signal Amplifier", color: "#5eead4", glyph: "radial-gradient(circle, #ccfbf1 0 12%, #14b8a6 24% 42%, #134e4a 58%)" },
  stabilizerNode: { name: "Stabilizer Node", color: "#ddd6fe", glyph: "conic-gradient(from 45deg, #4c1d95, #ddd6fe, #7c3aed, #4c1d95)" },
  repairBeam: { name: "Repair Beam", color: "#86efac", glyph: "linear-gradient(90deg, #052e16 0 18%, #22c55e 20% 70%, #dcfce7 72%)" },
  overclockedRepair: { name: "Overclocked Repair Unit", color: "#4ade80", glyph: "linear-gradient(45deg, #052e16 0 24%, #4ade80 26% 44%, #fdba74 46% 56%, #4ade80 58%)" },
  smallSensor: { name: "Small Sensor", color: "#67e8f9", glyph: "radial-gradient(circle, #ecfeff 0 14%, #22d3ee 22% 42%, #164e63 52%)" },
  largeSensor: { name: "Large Sensor", color: "#38bdf8", glyph: "radial-gradient(circle, #e0f2fe 0 12%, #38bdf8 18% 34%, #0c4a6e 42% 60%)" },
  smallDirectedSensor: { name: "Small Directed Sensor", color: "#7dd3fc", glyph: "linear-gradient(90deg, #082f49 0 22%, #38bdf8 24% 60%, #e0f2fe 62% 78%, transparent 80%)" },
  largeDirectedSensor: { name: "Large Directed Sensor", color: "#38bdf8", glyph: "linear-gradient(90deg, #020617 0 18%, #0284c7 20% 58%, #bae6fd 60% 80%, transparent 82%)" },
  droneBay: { name: "Drone Bay", color: "#67e8f9", glyph: "radial-gradient(circle at 50% 50%, #e0f2fe 0 13%, #22d3ee 15% 28%, #0e7490 30% 43%, #082f49 45%)" },
  fireControlCommandCentre: { name: "Fire-Control Command Centre", color: "#fdba74", glyph: "radial-gradient(circle, #fff7ed 0 18%, #f97316 28% 55%, #7c2d12 60%)" },
  fleetDefenceCoordinator: { name: "Fleet Defence Coordinator", color: "#fca5a5", glyph: "radial-gradient(circle, #fef2f2 0 18%, #ef4444 28% 55%, #7f1d1d 60%)" },
  shieldCommandRelay: { name: "Shield Command Relay", color: "#86efac", glyph: "radial-gradient(circle, #dcfce7 0 18%, #22c55e 28% 55%, #14532d 60%)" },
  engineeringCommandCentre: { name: "Engineering Command Centre", color: "#93c5fd", glyph: "radial-gradient(circle, #eff6ff 0 18%, #3b82f6 28% 55%, #172554 60%)" },
  propulsionCommandRelay: { name: "Propulsion Command Relay", color: "#67e8f9", glyph: "radial-gradient(circle, #ecfeff 0 18%, #06b6d4 28% 55%, #164e63 60%)" },
  electronicWarfareCommandCentre: { name: "Electronic Warfare Command Centre", color: "#d8b4fe", glyph: "radial-gradient(circle, #faf5ff 0 18%, #a855f7 28% 55%, #3b0764 60%)" },
  proximityDemolitionCharge: { name: "Proximity Demolition Charge", color: "#fb7185", glyph: "repeating-linear-gradient(45deg, #facc15 0 8%, #1a1a1a 8% 16%)" },
  demolitionCharge: { name: "Demolition Charge", color: "#fb7185", glyph: "repeating-linear-gradient(45deg, #facc15 0 8%, #1a1a1a 8% 16%)" },
};

// These structural silhouettes show their direction through their geometry, so
// all material variants rotate without an extra arrow marker.
const MARKERLESS_ROTATABLE_PARTS = new Set([
  "halfFrameDiagonal",
  "halfArmorDiagonal",
  "halfCompositeArmorDiagonal",
  "wingFrame",
  "wingArmor",
  "wingCompositeArmor",
  "bevelArmor",
  "bevelCompositeArmor",
  "bevelFrame",
  "roundedArmor",
  "roundedCompositeArmor",
  "roundedFrame",
  "longWedgeArmor",
  "longWedgeCompositeArmor",
  "longWedgeFrame",
  "halfAblativeArmorDiagonal",
  "wingAblativeArmor",
  "bevelAblativeArmor",
  "roundedAblativeArmor",
  "longWedgeAblativeArmor",
  "halfRefractoryArmorDiagonal",
  "wingRefractoryArmor",
  "bevelRefractoryArmor",
  "roundedRefractoryArmor",
  "longWedgeRefractoryArmor"
]);

const FIXED_ORIENTATION_PARTS = new Set(["engine", "compactEngine", "heavyEngine", "maneuverThruster", "droneBay"]);

export const PART_DESCRIPTIONS = Object.freeze({
  default: "General-purpose ship component."
});

export const FALLBACK_PART_STATS = {};

export let PART_STATS = buildPartStatsFromBalance(GENERATED_BALANCE, FALLBACK_PART_STATS);
if (typeof globalThis !== "undefined") {
  globalThis.PART_STATS = PART_STATS;
  globalThis.PART_DEFS = PART_DEFS;
}
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
  if (typeof globalThis !== "undefined") globalThis.PART_STATS = PART_STATS;
  componentCatalogueAuthority = "http";
  clearComponentIconCache(); // footprints may have changed, rebake icons
  return true;
}

export function applyServerParts(parts) {
  const normalized = normalizeRuntimeParts(parts);
  PART_STATS = normalized;
  if (typeof globalThis !== "undefined") globalThis.PART_STATS = PART_STATS;
  componentCatalogueAuthority = "server";
  clearComponentIconCache();
  return true;
}

// Mirroring is opt-in per catalogue entry (component-balance.json `flippable`).
// Symmetric blocks, weapons, reactors and engines deliberately do not offer it:
// pressing F on them is a no-op rather than an error.
export function isFlippablePart(type) {
  return ComponentTransform.isFlippableStat(PART_STATS[type]);
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
  if (stat.category === "Engines") return "Engines";
  if (type === "shield") return "Defence";
  if (stat.weapon) return "Weapons";
  if (type === "repair") return "Support";
  return "Support";
}

export function partDescription(type, stat) {
  return stat?.description || PART_DESCRIPTIONS.default;
}

export function partIconMarkup(type, extraClass = "", rotationDeg = 0, flipped = false, connectionMask = 0) {
  const safeType = String(type || "frame").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  const classes = ["part-glyph", `part-${safeType}`, extraClass].filter(Boolean).join(" ");
  // The mirror is baked into the PNG, not applied as a CSS transform, so the
  // icon, the placement ghost and the arena hull all come from one drawing pass.
  // connectionMask does the same for Heat Pipe plumbing shapes.
  const url = componentIconDataUrl(type, rotationDeg, flipped, connectionMask);
  // The baked PNG carries the footprint aspect ratio as its intrinsic size, so an
  // <img> scales correctly in the palette, grid, and inspector with plain CSS.
  const src = url ? `src="${url}" ` : "";
  return `<img class="${classes}" ${src}alt="" draggable="false" aria-hidden="true">`;
}

export function makeWeapon(type, stats) {
  const fireRate = Number(stats.fireRate) || 1;
  const damage = Number(stats.damage) || 0;
  const spinalCharge = stats.spinalCharge && typeof stats.spinalCharge === "object" && !Array.isArray(stats.spinalCharge)
    ? { ...stats.spinalCharge }
    : undefined;
  const presentation = WeaponPresentationRules.weaponCyclePresentation({ damage, fireRate, spinalCharge });
  
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
    reload: Number(presentation.reloadSeconds.toFixed(2)),
    range: stats.range,
    radius: Number(stats.radius) || 0,
    projectileRadius: Number(stats.projectileRadius ?? (type === "emp" ? stats.radius : 0)) || 0,
    projectileSpeed: stats.projectileSpeed,
    accuracy: stats.accuracy,
    tracking: tracking,
    trackTime: Number(stats.trackTime) || 0,
    trackingDelay: Number(stats.trackingDelay) || 0,
    aimSpeed: aimSpeed !== undefined ? Number(aimSpeed) : undefined,
    arc: Number(stats.arc) || 360,
    dps: Number(presentation.dps.toFixed(1)),
    missileHp: Number(stats.missileHp) || 0,
    antiMissile: Boolean(stats.antiMissile),
    shipDamageMultiplier: Number(stats.shipDamageMultiplier) || 1,
    targetPriority: stats.targetPriority || [],
    shieldDamageMultiplier: Number(stats.shieldDamageMultiplier ?? 1),
    hullDamageMultiplier: Number(stats.hullDamageMultiplier ?? 1),
    shieldDisruptionFraction: stats.shieldDisruptionFraction !== undefined ? Number(stats.shieldDisruptionFraction) : undefined,
    burnThroughCarryMultiplier: stats.burnThroughCarryMultiplier !== undefined ? Number(stats.burnThroughCarryMultiplier) : undefined,
    chargeRampSeconds: stats.chargeRampSeconds !== undefined ? Number(stats.chargeRampSeconds) : undefined,
    maxChargeDamageBonus: stats.maxChargeDamageBonus !== undefined ? Number(stats.maxChargeDamageBonus) : undefined,
    impactHeatPerDamage: stats.impactHeatPerDamage !== undefined ? Number(stats.impactHeatPerDamage) : undefined,
    inductionHeatBasePerSecond: stats.inductionHeatBasePerSecond !== undefined ? Number(stats.inductionHeatBasePerSecond) : undefined,
    inductionHeatMaxPerSecond: stats.inductionHeatMaxPerSecond !== undefined ? Number(stats.inductionHeatMaxPerSecond) : undefined,
    inductionRampSeconds: stats.inductionRampSeconds !== undefined ? Number(stats.inductionRampSeconds) : undefined,
    inductionShieldMultiplier: stats.inductionShieldMultiplier !== undefined ? Number(stats.inductionShieldMultiplier) : undefined,
    inductionDirectFraction: stats.inductionDirectFraction !== undefined ? Number(stats.inductionDirectFraction) : undefined,
    inductionAdjacentFraction: stats.inductionAdjacentFraction !== undefined ? Number(stats.inductionAdjacentFraction) : undefined,
    inductionSecondHopFraction: stats.inductionSecondHopFraction !== undefined ? Number(stats.inductionSecondHopFraction) : undefined,
    inductionContactGraceSeconds: stats.inductionContactGraceSeconds !== undefined ? Number(stats.inductionContactGraceSeconds) : undefined,
    beamStyle: typeof stats.beamStyle === "string" ? stats.beamStyle : undefined,
    // Multi-pellet fire and the spinal charge cycle are preview-only here: the
    // server owns the firing simulation, the inspector only reports them.
    pelletCount: Number.isFinite(Number(stats.pelletCount)) && Number(stats.pelletCount) >= 2 ? Math.round(Number(stats.pelletCount)) : undefined,
    pelletSpreadDegrees: stats.pelletSpreadDegrees !== undefined ? Number(stats.pelletSpreadDegrees) : undefined,
    blastDamage: stats.blastDamage !== undefined ? Number(stats.blastDamage) : undefined,
    blastRadius: stats.blastRadius !== undefined ? Number(stats.blastRadius) : undefined,
    innerFullDamageRadius: stats.innerFullDamageRadius !== undefined ? Number(stats.innerFullDamageRadius) : undefined,
    falloffExponent: stats.falloffExponent !== undefined ? Number(stats.falloffExponent) : undefined,
    directDamage: stats.directDamage !== undefined ? Number(stats.directDamage) : undefined,
    spinalCharge
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
    activityHeat: numberOr(part.activityHeat, 0),
    heatPerShot: numberOr(part.heatPerShot, 0),
    powerUse: numberOr(part.powerUse, 0),
    shield: numberOr(part.shield, 0),
    shieldRegen: numberOr(part.shieldRegen, 0),
    thrust: numberOr(part.thrust, 0),
    turn: numberOr(part.turn, 0),
    energyStorage: numberOr(part.energyStorage ?? part.energyCapacity, 0),
    energyCapacity: numberOr(part.energyCapacity ?? part.energyStorage, 0),
    maxChargeRate: numberOr(part.maxChargeRate, 0),
    maxDischargeRate: numberOr(part.maxDischargeRate, 0),
    chargeEfficiency: part.chargeEfficiency !== undefined ? numberOr(part.chargeEfficiency, 1) : 1,
    dischargeEfficiency: part.dischargeEfficiency !== undefined ? numberOr(part.dischargeEfficiency, 1) : 1,
    dischargeHeatAtMax: numberOr(part.dischargeHeatAtMax ?? part.dischargeHeat, 0),
    repairRate,
    repair: repairRate > 0 ? 1 : numberOr(part.repairCount ?? part.repair, 0),
    weapon,
    description: part.description || "",
    utilityEffect: part.utilityEffect || part.utility || "",
    rangeBonus: numberOr(part.rangeBonus, 0),
    accuracyBonus: numberOr(part.accuracyBonus, 0),
    fireRateBonus: numberOr(part.fireRateBonus, 0),
    captureBonus: numberOr(part.captureBonus, 0),
    sensorRangeBonus: numberOr(part.sensorRangeBonus, 0),
    sensorRole: typeof part.sensorRole === "string" ? part.sensorRole : null,
    sensorArc: numberOr(part.sensorArc, 0),
    // Server-normalized parts expose rotationRequired even when they omit the
    // source balance file's rotatable field. Preserve that capability when a
    // hello/state message replaces the locally loaded component definition.
    rotatable: Boolean(part.rotatable || part.rotationRequired),
    rotationRequired: Boolean(part.rotationRequired || part.rotatable),
    allowedRotations: Array.isArray(part.allowedRotations) ? part.allowedRotations.map(Number).filter(Number.isFinite) : undefined,
    flippable: Boolean(part.flippable),
    ecmStrength: numberOr(part.ecmStrength, 0),
    frontDamageReduction: numberOr(part.frontDamageReduction, 0),
    frontArc: numberOr(part.frontArc, 0),
    shapeType: typeof part.shapeType === "string" ? part.shapeType : null,
    statScale: numberOr(part.statScale, 1),
    footprint: part.footprint ? { width: numberOr(part.footprint.width, 1), height: numberOr(part.footprint.height, 1) } : { width: 1, height: 1 }
  };
  if (weapon) normalized[weapon.type] = 1;
  for (const family of ["blaster", "missile", "railgun", "beam", "pointDefense", "emp"]) {
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
    activityHeat: numberOr(component.activityHeat, 0),
    heatPerShot: numberOr(component.heatPerShot, 0),
    powerUse: numberOr(component.powerUse, 0),
    shield: numberOr(component.shield, 0),
    shieldRegen: numberOr(component.shieldRegen, 0),
    thrust: numberOr(component.thrust, 0),
    turn: numberOr(component.turn, 0),
    energyStorage: numberOr(component.energyStorage ?? component.energyCapacity, 0),
    energyCapacity: numberOr(component.energyCapacity ?? component.energyStorage, 0),
    maxChargeRate: numberOr(component.maxChargeRate, 0),
    maxDischargeRate: numberOr(component.maxDischargeRate, 0),
    chargeEfficiency: component.chargeEfficiency !== undefined ? numberOr(component.chargeEfficiency, 1) : 1,
    dischargeEfficiency: component.dischargeEfficiency !== undefined ? numberOr(component.dischargeEfficiency, 1) : 1,
    dischargeHeatAtMax: numberOr(component.dischargeHeatAtMax ?? component.dischargeHeat, 0),
    repairRate,
    repair: repairRate > 0 ? 1 : numberOr(component.repairCount, 0),
    weapon,
    aura: component.aura && typeof component.aura === "object" && !Array.isArray(component.aura)
      ? { ...component.aura }
      : null,
    description: component.description || "",
    utilityEffect: component.utilityEffect || component.utility || "",
    rangeBonus: numberOr(component.rangeBonus, 0),
    accuracyBonus: numberOr(component.accuracyBonus, 0),
    fireRateBonus: numberOr(component.fireRateBonus, 0),
    captureBonus: numberOr(component.captureBonus, 0),
    sensorRangeBonus: numberOr(component.sensorRangeBonus, 0),
    sensorRole: typeof component.sensorRole === "string" ? component.sensorRole : null,
    sensorArc: numberOr(component.sensorArc, 0),
    rotatable: Boolean(component.rotatable),
    rotationRequired: Boolean(component.rotationRequired || component.rotatable),
    allowedRotations: Array.isArray(component.allowedRotations) ? component.allowedRotations.map(Number).filter(Number.isFinite) : undefined,
    flippable: Boolean(component.flippable),
    ecmStrength: numberOr(component.ecmStrength, 0),
    frontDamageReduction: numberOr(component.frontDamageReduction, 0),
    frontArc: numberOr(component.frontArc, 0),
    // Presentation-only passthroughs: the inspector reports flat armour
    // mitigation and per-ship placement limits from the authoritative balance
    // file instead of restating those constants in UI code.
    armorFlatReduction: numberOr(component.armorFlatReduction, 0),
    heatCapacity: component.heatCapacity !== undefined ? numberOr(component.heatCapacity, 0) : undefined,
    heatCooling: component.heatCooling !== undefined ? numberOr(component.heatCooling, 0) : undefined,
    heatPassiveCooling: component.heatPassiveCooling !== undefined ? numberOr(component.heatPassiveCooling, 0) : undefined,
    heatConductivity: component.heatConductivity !== undefined ? numberOr(component.heatConductivity, 0) : undefined,
    heatRetention: component.heatRetention !== undefined ? numberOr(component.heatRetention, 0) : undefined,
    burstCooler: component.burstCooler && typeof component.burstCooler === "object" && !Array.isArray(component.burstCooler)
      ? { ...component.burstCooler }
      : null,
    heatBeamShield: Boolean(component.heatBeamShield),
    decoyConfig: component.decoy && typeof component.decoy === "object" ? { ...component.decoy } : null,
    proximityCharge: component.proximityCharge && typeof component.proximityCharge === "object" && !Array.isArray(component.proximityCharge)
      ? {
          triggerRadius: numberOr(component.proximityCharge.triggerRadius, 50),
          triggerConfirmationSeconds: numberOr(component.proximityCharge.triggerConfirmationSeconds, 0.2),
          blastRadius: numberOr(component.proximityCharge.blastRadius, 280),
          splashCentreDamage: numberOr(component.proximityCharge.centreDamage ?? component.proximityCharge.splashCentreDamage, 1000),
          falloffExponent: numberOr(component.proximityCharge.falloffExponent, 2),
          directContactMultiplier: numberOr(component.proximityCharge.directContactMultiplier, 1.5),
          directContactHullDamage: Number.isFinite(Number(component.proximityCharge.directContactHullDamage))
            ? Number(component.proximityCharge.directContactHullDamage)
            : numberOr(component.proximityCharge.centreDamage ?? component.proximityCharge.splashCentreDamage, 1000)
              * numberOr(component.proximityCharge.directContactMultiplier, 1.5),
          maxAffectedComponents: component.proximityCharge.maxAffectedComponents === null
            ? null
            : numberOr(component.proximityCharge.maxAffectedComponents, 6),
          damagesFriendlyShips: component.proximityCharge.damagesFriendlyShips !== false
        }
      : null,
    maxPerShip: Number.isFinite(Number(component.maxPerShip)) ? Number(component.maxPerShip) : null,
    meltdownDamage: Number.isFinite(Number(component.meltdownDamage)) ? Number(component.meltdownDamage) : null,
    meltdownRadius: Number.isFinite(Number(component.meltdownRadius)) ? Number(component.meltdownRadius) : null,
    shapeType: typeof component.shapeType === "string" ? component.shapeType : null,
    statScale: numberOr(component.statScale, 1),
    footprint: component.footprint ? { width: numberOr(component.footprint.width, 1), height: numberOr(component.footprint.height, 1) } : { width: 1, height: 1 }
  };
  if (component.id === "droneBay" && balance?.drones) {
    part.droneConfig = JSON.parse(JSON.stringify(balance.drones));
  }
  if (weapon) part[weapon.type] = 1;
  for (const family of ["blaster", "missile", "railgun", "beam", "pointDefense", "emp"]) {
    if (component[family]) part[family] = numberOr(component[family], part[family] || 0);
  }
  return part;
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

