// Fleet Ledger content module: owns the article catalogue, categories, manual
// prose, and data-driven article generation from authoritative balance sources.
// Pure data + pure functions : no DOM, no side effects, unit-testable.

import { PART_STATS, PART_DEFS, partCategory, partDescription } from "../design/parts.js";
import { GENERATED_BALANCE } from "../generatedBalance.js";
import { formatMass, formatHull, formatShield, formatThrust, formatEnergy, formatRepair, formatDistance, formatSpeed, formatDamage, formatPercent } from "../design/statFormatting.js";
import { BRAKE_ACCEL_RATIO, MOVEMENT_CONFIG, formatMassClassRange } from "../shared/movementStats.js";
import "../shared/heatRules.js";
import { formatHeatEffect, formatHeatEffectValue, getHeatEffectsForComponent } from "../shared/heatEffects.js";
import "../shared/weaponPresentationRules.js";
import "../shared/backupCoreRules.js";
import "../shared/shieldRules.js";
import "../shared/repairRules.js";
import { getMechanics, getMechanicsSearchText, SPECIAL_MECHANICS_COMPONENTS, LEDGER_RULE_CONTRACTS, droneProjectileEvasionDetail } from "./componentMechanics.js";

const HeatRules = globalThis.HeatRules;
const WeaponPresentationRules = globalThis.WeaponPresentationRules;
const BackupCoreRules = globalThis.BackupCoreRules;
const ShieldRules = globalThis.ShieldRules;
const RepairRules = globalThis.RepairRules;
const BACKUP_EFFECTIVENESS_TEXT = formatPercent(BackupCoreRules.ACTIVE_SYSTEM_EFFECTIVENESS);
const SHIELD_IMPACT_HEAT_TEXT = `${ShieldRules.getShieldImpactHeatPerDamage().toFixed(2)} H / damage blocked`;
const SHIELD_RESTART_DELAY_SECONDS = (Number(ShieldRules.SHIELD_RESTART_DELAY_MS) || 0) / 1000;
const SHIELD_RESTART_DELAY_TEXT = `${SHIELD_RESTART_DELAY_SECONDS.toFixed(1)} seconds`;
const SHIELD_COMMAND_RELAY_AURA = PART_STATS.shieldCommandRelay?.aura || {};

function signedAuraPercent(multiplier) {
  const delta = Number(multiplier) - 1;
  return `${delta >= 0 ? "+" : ""}${formatPercent(delta)}`;
}

function shorterAuraPercent(multiplier) {
  return `${formatPercent(1 - Number(multiplier))} shorter`;
}

const SHIELD_COMMAND_RELAY_REGEN_TEXT = signedAuraPercent(SHIELD_COMMAND_RELAY_AURA.shieldRegenMultiplier);
const SHIELD_COMMAND_RELAY_DELAY_TEXT = shorterAuraPercent(SHIELD_COMMAND_RELAY_AURA.shieldRestartDelayMultiplier);
const SHIELD_COMMAND_RELAY_EFFECTIVE_DELAY_TEXT = `${(ShieldRules.getShieldRestartDelayMs(SHIELD_COMMAND_RELAY_AURA.shieldRestartDelayMultiplier) / 1000).toFixed(1)} seconds`;
const SHIELD_DEPLETION_TEXT = `Shield Depletion: Damaged Shields regenerate normally while any Shield remains. If a Shield is completely depleted to 0, regeneration shuts down for ${SHIELD_RESTART_DELAY_TEXT} before restarting.`;
const SHIELD_RESTART_TEXT = "Shield Restart: The restart delay only occurs after complete Shield depletion. Taking Shield damage without reaching 0 does not trigger the delay.";
const SHIELD_COMMAND_RELAY_TEXT = `Shield Command Relay: Reduces the Shield restart delay of affected allied ships as well as improving Shield regeneration. Configured effects: Shield regeneration ${SHIELD_COMMAND_RELAY_REGEN_TEXT}; restart delay ${SHIELD_COMMAND_RELAY_DELAY_TEXT}. Fully effective restart delay: ${SHIELD_COMMAND_RELAY_EFFECTIVE_DELAY_TEXT}.`;
const REPAIR_STACKING_TEXT = formatPercent(RepairRules.getRepairStackingMultiplier(GENERATED_BALANCE));
const REPAIR_PROGRESSION_TEXT = RepairRules.stackingProgression(5, GENERATED_BALANCE).join(", ");

function heatThresholdPercent(key) {
  return `${Math.round(HeatRules.THRESHOLDS[key] * 100)}%`;
}

function heatOutputPercent(stateKey) {
  return `${Math.round(HeatRules.activeOutputForState(HeatRules.STATE[stateKey]) * 100)}%`;
}

function heatEffectValue(key, stateKey, candidates = []) {
  const types = [...new Set([...candidates, ...Object.keys(PART_STATS)])];
  for (const type of types) {
    const presentation = getHeatEffectsForComponent(type, PART_STATS[type] || {}, HeatRules.STATE[stateKey], HeatRules);
    const effect = presentation.effects.find((candidate) => candidate.key === key);
    if (effect) return formatHeatEffectValue(effect);
  }
  return "Not applicable";
}

const HEAT_WARM_START = heatThresholdPercent("warm");
const HEAT_HOT_START = heatThresholdPercent("hot");
const HEAT_CRITICAL_START = heatThresholdPercent("critical");
const HEAT_OVERHEATED_START = heatThresholdPercent("overheated");
const HEAT_OVERHEATED_RECOVERY = `${Math.round((HeatRules.THRESHOLDS.overheated - HeatRules.HYSTERESIS.overheated) * 100)}%`;
const HEAT_COOL_OUTPUT = heatOutputPercent("NORMAL");
const HEAT_WARM_OUTPUT = heatOutputPercent("WARM");
const HEAT_HOT_OUTPUT = heatOutputPercent("HOT");
const HEAT_CRITICAL_OUTPUT = heatOutputPercent("CRITICAL");
const HEAT_OVERHEATED_OUTPUT = heatOutputPercent("OVERHEATED");
const HEAT_COOL_WARM_OUTPUT = HEAT_COOL_OUTPUT === HEAT_WARM_OUTPUT
  ? `${HEAT_COOL_OUTPUT} active output`
  : `Cool: ${HEAT_COOL_OUTPUT} active output; Warm: ${HEAT_WARM_OUTPUT} active output`;
const HEAT_HOT_COOLING = heatEffectValue("activeCooling", "HOT", ["radiator", "closedCycleCooler"]);
const HEAT_CRITICAL_COOLING = heatEffectValue("activeCooling", "CRITICAL", ["radiator", "closedCycleCooler"]);
const HEAT_OVERHEATED_COOLING = heatEffectValue("activeCooling", "OVERHEATED", ["radiator", "closedCycleCooler"]);
const HEAT_HOT_STRUCTURE = heatEffectValue("structuralDamageTaken", "HOT", ["frame"]);
const HEAT_CRITICAL_STRUCTURE = heatEffectValue("structuralDamageTaken", "CRITICAL", ["frame"]);
const HEAT_OVERHEATED_STRUCTURE = heatEffectValue("structuralDamageTaken", "OVERHEATED", ["frame"]);
const HEAT_HOT_ARMOR = heatEffectValue("armorDamageReduction", "HOT", ["armor"]);
const HEAT_CRITICAL_ARMOR = heatEffectValue("armorDamageReduction", "CRITICAL", ["armor"]);
const HEAT_OVERHEATED_ARMOR = heatEffectValue("armorDamageReduction", "OVERHEATED", ["armor"]);
const HEAT_HOT_ARMOR_EFFECTIVENESS = heatEffectValue("armorProtection", "HOT", ["armor"]);
const HEAT_CRITICAL_ARMOR_EFFECTIVENESS = heatEffectValue("armorProtection", "CRITICAL", ["armor"]);
const HEAT_OVERHEATED_ARMOR_EFFECTIVENESS = heatEffectValue("armorProtection", "OVERHEATED", ["armor"]);
const HEAT_ARMOR_BASE = Number(PART_STATS.armor?.armorFlatReduction) || 0;
const HEAT_RADIATOR_ENCLOSED = `${Math.round((Number(HeatRules.RADIATOR_ENCLOSED_MULTIPLIER) || 0) * 100)}%`;
const HEAT_VENT_ENCLOSED = `${Math.round((Number(HeatRules.HEAT_VENT_ENCLOSED_MULTIPLIER) || 0) * 100)}%`;
const HEAT_MELTDOWN_SECONDS = `${HeatRules.REACTOR_MELTDOWN_SECONDS}s`;
const HEAT_ACTIVE_SYSTEMS_TEXT = `Active systems: engines show Thrust output, weapons show Weapon output, reactors show Power output, and repair, sensor, shield, and Data support components show their own output category. Hot: ${HEAT_HOT_OUTPUT}; Critical: ${HEAT_CRITICAL_OUTPUT}; Overheated: ${HEAT_OVERHEATED_OUTPUT}.`;
const HEAT_COOLING_TEXT = `Powered cooling: Radiators and closed-cycle Coolers show Cooling output. Hot: ${HEAT_HOT_COOLING}; Critical: ${HEAT_CRITICAL_COOLING}; Overheated: ${HEAT_OVERHEATED_COOLING}.`;
const HEAT_STRUCTURE_TEXT = `Structure: damage taken multiplier is Hot ${HEAT_HOT_STRUCTURE}, Critical ${HEAT_CRITICAL_STRUCTURE}, Overheated ${HEAT_OVERHEATED_STRUCTURE}. Armour effective flat reduction follows its listed base: Hot ${HEAT_HOT_ARMOR} at ${HEAT_HOT_ARMOR_EFFECTIVENESS}, Critical ${HEAT_CRITICAL_ARMOR} at ${HEAT_CRITICAL_ARMOR_EFFECTIVENESS}, and Overheated ${HEAT_OVERHEATED_ARMOR} at ${HEAT_OVERHEATED_ARMOR_EFFECTIVENESS}.`;
const HEAT_OUTPUTS_TEXT = `${HEAT_ACTIVE_SYSTEMS_TEXT} ${HEAT_COOLING_TEXT} ${HEAT_STRUCTURE_TEXT} Components with no direct Heat-state effect do not receive an invented penalty.`;
const HEAT_LOCKOUT_TEXT = `Overheated lockout: Heat-affected active systems, powered cooling, Drone Bays, and Decoy Launchers shut down at ${HEAT_OVERHEATED_START} Heat. They restart only below ${HEAT_OVERHEATED_RECOVERY} Heat, derived from the shared Overheated threshold and hysteresis.`;
const HEAT_WARNING_TEXT = `Reaching ${HEAT_OVERHEATED_START} Heat is much more severe than entering Critical. Avoid crossing the Overheat threshold unless you can tolerate a full shutdown while the component cools.`;

const HEAT_MANUAL_CONTENT = Object.freeze({
  summary: "Per-component Heat states, output penalties, lockout recovery, transfer, cooling, and meltdown.",
  keywords: ["heat", "thermal", "radiator", "heat sink", "heat pipe", "cooling", "overheat", "lockout", "shutdown", "meltdown"],
  howItWorks: `Heat is stored per component and moves across side-adjacent component edges according to conductivity and shared contact. The five states begin at 0%, ${HEAT_WARM_START}, ${HEAT_HOT_START}, ${HEAT_CRITICAL_START}, and ${HEAT_OVERHEATED_START} of capacity: Cool, Warm, Hot, Critical, and Overheated. ${HEAT_OUTPUTS_TEXT} ${HEAT_LOCKOUT_TEXT} ${HEAT_WARNING_TEXT} Fully enclosed Radiators operate at ${HEAT_RADIATOR_ENCLOSED} of rated cooling, while enclosed Heat Vents operate at ${HEAT_VENT_ENCLOSED}. Heat Pipes transport Heat through a coolant network but do not remove it. A reactor held Overheated for ${HEAT_MELTDOWN_SECONDS} melts down for area damage.`,
  importantStats: [
    { label: "Warm", value: HEAT_WARM_START },
    { label: "Hot", value: HEAT_HOT_START },
    { label: "Critical", value: HEAT_CRITICAL_START },
    { label: "Overheated", value: HEAT_OVERHEATED_START },
    { label: "Cool / Warm output", value: HEAT_COOL_WARM_OUTPUT },
    { label: "Active systems", value: `Hot ${HEAT_HOT_OUTPUT}; Critical ${HEAT_CRITICAL_OUTPUT}; Overheated ${HEAT_OVERHEATED_OUTPUT}` },
    { label: "Active cooling", value: `Hot ${HEAT_HOT_COOLING}; Critical ${HEAT_CRITICAL_COOLING}; Overheated ${HEAT_OVERHEATED_COOLING}` },
    { label: "Structure damage", value: `Hot ${HEAT_HOT_STRUCTURE}; Critical ${HEAT_CRITICAL_STRUCTURE}; Overheated ${HEAT_OVERHEATED_STRUCTURE}` },
    { label: "Armour reduction", value: `Base ${HEAT_ARMOR_BASE}: Hot ${HEAT_HOT_ARMOR}; Critical ${HEAT_CRITICAL_ARMOR}; Overheated ${HEAT_OVERHEATED_ARMOR}` },
    { label: "Overheated: Entering", value: `At ${HEAT_OVERHEATED_START} Heat: shutdown` },
    { label: "Overheated: Recovery", value: `Below ${HEAT_OVERHEATED_RECOVERY} Heat: restart allowed` },
    { label: "Overheat Lockout", value: `${HEAT_OVERHEATED_START} to shut down; below ${HEAT_OVERHEATED_RECOVERY} to restart` },
    { label: "Enclosed Radiator", value: `${HEAT_RADIATOR_ENCLOSED} Cooling` },
    { label: "Enclosed Heat Vent", value: `${HEAT_VENT_ENCLOSED} Cooling` },
    { label: "Reactor Meltdown", value: `${HEAT_MELTDOWN_SECONDS} Continuously Overheated` }
  ],
  practicalUse: `Place cooling on exposed edges, use Heat Sinks as burst buffers, and use Heat Pipes only when adjacency cannot move Heat to cooling quickly enough. Inspect local hot spots under Idle, Typical Combat, and Max Load: a safe total can hide one weapon or reactor that fails first. ${HEAT_WARNING_TEXT}`,
  commonProblems: [
    "Weapons stop during sustained fire? Their local Heat reached Overheated.",
    `Component falls below ${HEAT_OVERHEATED_START} Heat but stays offline? It remains locked out until below ${HEAT_OVERHEATED_RECOVERY} Heat.`,
    "Radiator underperforms? Expose at least one exterior edge and keep it below Critical.",
    "Heat Pipe network stays hot? It transports Heat but still needs a real cooling destination."
  ]
});

function componentHeatInspection(partId, stats) {
  const stateIndexes = [HeatRules.STATE.HOT, HeatRules.STATE.CRITICAL, HeatRules.STATE.OVERHEATED];
  const details = [];
  for (const stateIndex of stateIndexes) {
    const presentation = getHeatEffectsForComponent(partId, stats, stateIndex, HeatRules);
    const effects = presentation.effects.filter((effect) => effect.isPenalty);
    if (effects.length) details.push(`${presentation.state}: ${effects.map(formatHeatEffect).join("; ")}`);
  }
  return details.length ? details.join(" | ") : "No direct Heat-state penalty";
}

// Re-export for test access
export { SPECIAL_MECHANICS_COMPONENTS, LEDGER_RULE_CONTRACTS };

export const CATEGORIES = [
  { id: "start-here", label: "Start Here" },
  { id: "building-ships", label: "Building Ships" },
  { id: "combat", label: "Combat" },
  { id: "heat", label: "Heat" },
  { id: "movement", label: "Movement" },
  { id: "sensors-detection", label: "Sensors & Detection" },
  { id: "data-links", label: "Data Links" },
  { id: "weapons", label: "Weapons" },
  { id: "shields-armour", label: "Shields & Armour" },
  { id: "drones", label: "Drones" },
  { id: "command", label: "Command" },
  { id: "economy-objectives", label: "Economy & Objectives" },
  { id: "advanced-mechanics", label: "Advanced Mechanics" },
  { id: "component-reference", label: "Component Reference" }
];

const CATEGORY_LANDING_ARTICLES = Object.freeze({
  "start-here": "overview",
  "building-ships": "blueprint-designer",
  combat: "combat",
  heat: "heat",
  movement: "movement",
  "sensors-detection": "sensors-detection",
  "data-links": "support",
  weapons: "weapons",
  "shields-armour": "defence",
  drones: "drones",
  command: "command",
  "economy-objectives": "economy",
  "advanced-mechanics": "advanced-mechanics",
  "component-reference": "component-reference"
});

const ECON = GENERATED_BALANCE.economy || {};
const CAPTURE = GENERATED_BALANCE.capture || {};
const DRONES = GENERATED_BALANCE.drones || {};
const MOVEMENT = MOVEMENT_CONFIG;

function droneTypeSummary(field, suffix = "") {
  const types = DRONES.types || {};
  const entries = Object.values(types)
    .filter((type) => type && type.label && Number.isFinite(Number(type[field])))
    .map((type) => `${type.label} ${type[field]}${suffix}`);
  return entries.join(", ") || `${DRONES[field] ?? 0}${suffix}`;
}

// ---------------------------------------------------------------------------
// Manual articles (part 1: overview, construction, power, heat, movement)
// ---------------------------------------------------------------------------

const MANUAL_ARTICLES_PART_1 = [
  {
    id: "overview",
    category: "start-here",
    title: "Start Here",
    summary: "Build a valid ship, deploy it, issue orders, and understand what wins a match.",
    keywords: ["start", "new player", "guide", "help", "first ship", "deploy", "win"],
    howItWorks: "The basic loop is simple: build a connected ship around one Core, give it clear engine exhaust and at least one weapon, deploy it, then use selection and right-click orders to contest relays and attack enemy forces. Ships continue fighting according to their chosen combat style after you issue an order. You win by completing the map objective or destroying the enemy home station. The Fleet Ledger stays available from the main menu and Blueprint Designer; search finds both learning articles and exact component entries.",
    practicalUse: "Read Building Ships first, then Combat and Movement. Add Heat, Sensors & Detection, and Data Links once your first design works. Use Component Reference when you need exact stats rather than a system explanation.",
    commonProblems: [],
    related: ["blueprint-designer", "combat", "movement", "economy", "component-reference"]
  },
  {
    id: "blueprint-designer",
    category: "building-ships",
    title: "Blueprint Designer Interface",
    summary: "The Designer Interface, Component Palette, Build Grid, Placement, Removal, Undo, And Reset.",
    keywords: ["blueprint", "designer", "interface", "palette", "grid", "place", "remove", "undo", "reset", "clear"],
    howItWorks: "Open the Blueprint Designer from the side panel or main menu. Select components from the palette, place them on the build grid, right-click to remove them, and press R to rotate when supported. Undo reverses the last physical edit; Reset Design restores the starter ship; Clear All removes everything except the core. The Ship Summary updates live as you build. Use explicit Data Links to associate support components with weapons.",
    importantStats: [
      { label: "Grid Size", value: "15×15" },
      { label: "Grid Coordinate Range", value: "0–14" },
      { label: "Undo Support", value: "Full Edit History" },
      { label: "Core Removal", value: "Not Allowed" },
      { label: "Reset Design", value: "Restores Starter Ship" },
      { label: "Clear All", value: "Removes All Except Core" }
    ],
    practicalUse: "Start with the default design and modify it. Use Clear All for a blank slate, keep the Ship Summary visible to catch issues early, and add explicit Data Links after placing support components and weapons.",
    commonProblems: [
      "Can't Place A Part? Check For Overlap Or Out-Of-Bounds Footprint Cells.",
      "Can't Remove The Core? The Core Is Permanent : Use Clear All To Reset To A Bare Core.",
      "Changes Not Saving? Use The Save Button To Persist The Blueprint."
    ],
    related: ["placement-rules", "structural-connectivity", "ship-validation", "ship-cost-formula", "ship-summary", "power", "heat"]
  },
  {
    id: "placement-rules",
    category: "building-ships",
    title: "Component Placement & Rotation",
    summary: "How Footprints Work, Rotation Rules, And Which Components Can Be Rotated.",
    keywords: ["placement", "footprint", "rotation", "rotate", "maneuver thruster", "orientation", "anchor", "multi-cell"],
    howItWorks: "Every Component Has A Footprint (Width × Height In Grid Cells). Multi-Cell Footprints Expand From The Anchor Cell (Part.X, Part.Y). Rotation Pivots Around The Anchor Cell: 0° = Default, 90° = Clockwise, 180° = Flipped, 270° = Counter-Clockwise. Rotatable Components Include Weapons, Defence Components With Weapons, And Any Part With Rotatable Set To True Or Allowed Rotations Defined. Non-Rotatable Components Include Engines, Maneuver Thrusters, And Drone Bays. Maneuver Thrusters Auto-Rotate Based On Position: Left Of Centre → 90°, Right Of Centre → 270°. Components With A Two-Rotation Limit (90°/270°) Auto-Pick Side-Facing Based On X Position Relative To Grid Centre (7). Placement Is Blocked If Any Footprint Cell Is Out Of Bounds (0–14), Overlaps Another Part, Or Would Be Disconnected From The Core.",
    importantStats: [
      { label: "Grid Bounds", value: "0–14 (15×15)" },
      { label: "Rotation Steps", value: "0°, 90°, 180°, 270°" },
      { label: "Maneuver Thruster Auto-Rotation", value: "Based On X vs Centre (7)" },
      { label: "Default Rotation", value: "0°" },
      { label: "Non-Rotatable Types", value: "Engine, Maneuver Thruster, Drone Bay" }
    ],
    practicalUse: "Weapons On The Ship's Edges Can Be Rotated To Face Forward, Sideways, Or Backward. Maneuver Thrusters Auto-Face Outward : Place Them On The Correct Side. Drone Bays Cannot Be Rotated : Their Launch Edge Depends On Placement.",
    commonProblems: [
      "Part Facing The Wrong Way? Press R To Cycle Rotations.",
      "Maneuver Thruster Won't Rotate? It Auto-Rotates Based On Position.",
      "Footprint Hanging Off The Grid? Move The Anchor Cell So All Footprint Cells Fit Within 0–14."
    ],
    related: ["blueprint-designer", "structural-connectivity", "engine-exhaust", "ship-validation"]
  },
  {
    id: "structural-connectivity",
    category: "building-ships",
    title: "Structural Connectivity",
    summary: "All Parts Must Connect To The Core Through Side-Adjacent Cells.",
    keywords: ["connectivity", "connected", "disconnected", "adjacent", "core", "heat pipe", "structure", "BFS"],
    howItWorks: "A Blueprint Is Valid Only If Every Part Is Structurally Connected To The Core. Connectivity Is Checked Via Breadth-First Search From The Core Through Side-Adjacent (4-Neighbour) Cells. Two Passes Are Performed: Physical Connectivity (All Parts Reachable) And Structural Connectivity (Non-Heat-Pipe Parts Must Not Rely On Heat Pipe Chains As Their Only Path). Heat Pipes Can Be Reached Through Other Heat Pipes, But A Non-Heat-Pipe Part Cannot Use A Heat-Pipe Chain As Its Only Path Back To The Core. Diagonal Adjacency Does NOT Count : Only Up, Down, Left, And Right. Overlapping Parts Are Filtered Before The Connectivity Check.",
    importantStats: [
      { label: "Adjacency Type", value: "4-Neighbour (Orthogonal)" },
      { label: "Heat Pipe Rule", value: "Non-Heat-Pipe Parts Cannot Depend On Heat Pipe Chains" },
      { label: "Core Required", value: "Exactly 1" },
      { label: "Diagonal Counts", value: "No" }
    ],
    practicalUse: "Build Outward From The Core In A Connected Shape. Avoid Diagonal Gaps : Parts Touching Only At Corners Are Disconnected. Heat Pipes Can Bridge To Radiators But Cannot Be The Structural Spine Of The Ship.",
    commonProblems: [
      "Disconnected Parts Error? Check For Diagonal-Only Connections Or Gaps.",
      "Heat Pipe Causing Issues? A Non-Heat-Pipe Part Behind A Heat Pipe Chain Is Structurally Invalid : Add A Frame Or Armor Path."
    ],
    related: ["blueprint-designer", "placement-rules", "ship-validation", "heat"]
  },
  {
    id: "engine-exhaust",
    category: "building-ships",
    title: "Engine Exhaust Clearance",
    summary: "Engines Need Clear Exhaust Channels Behind Them Or They Provide No Thrust.",
    keywords: ["engine", "exhaust", "blocked", "thrust", "nozzle", "channel", "clearance", "maneuver thruster"],
    howItWorks: "Every Engine And Maneuver Thruster Has An Exhaust Direction Opposite To Its Thrust Direction. The Exhaust Channel Extends From The Nozzle Cells Outward In The Exhaust Direction To The Grid Edge. If Any Other Component Blocks The Exhaust Channel, The Engine Is Blocked And Contributes Zero Thrust. Blocked Engines Still Consume Mass And Cost But Provide No Movement. The Ship Summary Shows A Warning For Blocked Engines. Exhaust Direction Depends On Rotation: 0° = Downward, 90° = Left, 180° = Upward, 270° = Right.",
    importantStats: [
      { label: "Exhaust Grid Size", value: "15" },
      { label: "Blocked Engine Effect", value: "Zero Thrust (Mass And Cost Still Count)" },
      { label: "Exhaust Check Range", value: "Full Channel To Grid Edge" },
      { label: "0° Exhaust Direction", value: "Downward" },
      { label: "90° Exhaust Direction", value: "Left" },
      { label: "180° Exhaust Direction", value: "Upward" },
      { label: "270° Exhaust Direction", value: "Right" }
    ],
    practicalUse: "Place Engines On The Ship's Rear Edge (Bottom Row) Facing Backward (0° Rotation). Ensure No Components Are Behind The Engine Within Its Exhaust Channel. Maneuver Thrusters On The Side Edges Auto-Rotate Outward.",
    commonProblems: [
      "Engine Not Providing Thrust? Check If Another Part Blocks The Exhaust Channel.",
      "Ship Slow Despite Many Engines? Some Engines May Be Blocked : Check The Ship Summary For Blocked Engine Count.",
      "Maneuver Thruster Blocked? Ensure The Outward-Facing Channel Is Clear."
    ],
    related: ["placement-rules", "movement", "ship-validation", "ship-summary"]
  },
  {
    id: "ship-validation",
    category: "building-ships",
    title: "Ship Validation Rules",
    summary: "All Rules A Blueprint Must Pass Before It Can Be Deployed.",
    keywords: ["validation", "rules", "core", "backup core", "overlap", "bounds", "drone bay", "max per ship", "engine requirement"],
    howItWorks: "Exactly One Core Is Required (Zero = Invalid, Two = Invalid). Maximum One Backup Command Core Is Allowed. All Parts Must Be Within The 15×15 Grid (Coordinates 0–14). No Overlapping Parts. All Parts Must Be Structurally Connected To The Core. Each Component Type Has A Max-Per-Ship Limit. Drone Bays Require A Configured Drone Type (Fighter, Defence, Or Repair) And An Exposed Two-Cell Launch Edge. Maximum Drone Bays Per Ship Is 4. At Least One Engine With Effective Thrust Is Required To Build (Validated At Build Time, Not Design Time). Ship Cost Is The Sum Of Direct Component Costs. The Player Must Have Enough Money To Build The Ship.",
    importantStats: [
      { label: "Core Count Required", value: "Exactly 1" },
      { label: "Backup Core Max", value: "1" },
      { label: "Grid Bounds", value: "0–14" },
      { label: "Max Drone Bays", value: `${GENERATED_BALANCE.drones?.maxBaysPerShip ?? 4}` },
      { label: "Engine Requirement", value: "At Least 1 With Effective Thrust (Build Time)" }
    ],
    practicalUse: "The Designer Warns About Most Issues Live. Drone Bay Configuration (Drone Type) Must Be Set Before Deployment. The Thrust Requirement Is Only Enforced When Building : You Can Save A Design Without Engines But Cannot Deploy It.",
    commonProblems: [
      "Missing Core Error? Every Ship Needs Exactly One Core.",
      "Disconnected Parts Error? See The Structural Connectivity Article.",
      "Drone Bay Error? Set A Drone Type And Ensure An Exposed Two-Cell Edge.",
      "Add At Least One Engine Error? Place An Engine With Clear Exhaust."
    ],
    related: ["blueprint-designer", "structural-connectivity", "engine-exhaust", "ship-cost-formula", "ship-pricing"]
  },
  {
    id: "ship-cost-formula",
    category: "building-ships",
    title: "Ship Cost Formula",
    summary: "Ship Cost Is The Sum Of The Direct Costs On Its Components.",
    keywords: ["cost", "price", "formula", "component cost"],
    howItWorks: "Ship Cost = Sum Of Each Component's Direct Cost. Component costs are defined on the component itself; no base cost, multiplier, weapon premium, or infrastructure surcharge is added.",
    importantStats: [
      { label: "Component Cost", value: "Direct value on each component" }
    ],
    practicalUse: "Balance a ship by changing the direct cost on the components it uses. A Missile that should cost $75 should have cost 75 in the component balance.",
    commonProblems: [
      "Ship Too Expensive? Inspect the direct costs of its components.",
      "Need More Ships? Check available money and the fleet cap."
    ],
    related: ["ship-pricing", "economy", "blueprint-designer", "ship-validation"]
  },
  {
    id: "ship-summary",
    category: "building-ships",
    title: "Ship Summary Panel",
    summary: "The Live Overview Of Build Cost, Mass, Hull, Shield, Weapons, Speed, Turn, Power, And Status Warnings.",
    keywords: ["ship summary", "overview", "stats", "status", "warnings", "mobility", "power details", "combat details", "support details"],
    howItWorks: "The Ship Summary Shows 9 Headline Values: Build Cost, Class, Mass, Hull, Shield, Weapon DPS, Max Speed, Turn Rate, And Power. Below The Overview, Status Messages Appear In A Consistent Healthy, Caution, Then Critical Order Based On Real Conditions: Power Shortfall, Disconnected Components, No Effective Thrust, Mass Drag Limiting Speed, Asymmetric Turning, No Shield Coverage, No Weapons, Backup Command Available, Insufficient Cooling, And Overheating Components. Four Collapsible Detail Sections Provide Engineering Numbers: Mobility Details (Acceleration, Thrust-To-Mass, Engine Efficiency, Turn Rates, Blocked Engines), Power Details (Generation, Demand, Delivered, Spare, Efficiency, And Energy Storage), Combat Details (Per-Weapon-Family DPS, Range, Point Defence, Beam Radius, Shield Recharge), And Support Details (Repair Rate, Drone Capacity, Drone Squads, Capture Pressure, Cooling Bonus).",
    importantStats: [
      { label: "Overview Fields", value: "9 (Cost, Class, Mass, Hull, Shield, DPS, Speed, Turn, Power)" },
      { label: "Detail Sections", value: "4 (Mobility, Power, Combat, Support)" },
      { label: "Status Levels", value: "Good, Warning, Bad, Neutral" },
      { label: "Live Updates", value: "Yes : Updates As You Build" }
    ],
    practicalUse: "Watch The Power Field : Spare Means Healthy, Short Means Problems. Check Status Messages For Specific Issues. Expand Detail Sections For Engineering Numbers. The Summary Updates Live As You Build.",
    commonProblems: [
      "Power Showing Short? Add Reactors Or Reduce Power-Hungry Components.",
      "No Effective Thrust? Add Engines With Clear Exhaust Or Restore Power.",
      "Asymmetric Turning? Add Maneuver Thrusters Or Gyroscopes On The Weak Side.",
      "Insufficient Cooling? Add Radiators With Exposed Edges Or Heat Sinks."
    ],
    related: ["blueprint-designer", "power", "heat", "movement", "ship-cost-formula", "engine-exhaust"]
  },
  {
    id: "power",
    category: "building-ships",
    title: "Power Systems",
    summary: "One shared Power pool, proportional shortages, and automatic energy storage.",
    keywords: ["power", "reactor", "generator", "battery", "capacitor", "energy", "availability"],
    howItWorks: "Live, enabled generators contribute their current Heat-adjusted output to one ship-wide pool. Active consumers contribute demand. If generation is short, charged storage shares the deficit proportionally according to each unit's available discharge rate. Any remaining shortage gives every live consumer the same proportional Power ratio; there is no component priority. Spare generator output charges storage proportionally according to each unit's available charge rate after demand is met, and storage never charges and discharges in the same solve. Overheated active components produce no useful output even when Power is available.",
    importantStats: [
      { label: "Distribution", value: "One Ship-Wide Pool" },
      { label: "Shortage Allocation", value: "Same Proportional Ratio For All Consumers" },
      { label: "Movement Shortage", value: `Linear Power ratio, ${Math.round(MOVEMENT.power.minimumMultiplier * 100)}% to ${Math.round(MOVEMENT.power.maximumMultiplier * 100)}%` },
      { label: "Other Active Systems", value: `Linear Power ratio, ${Math.round(MOVEMENT.power.minimumMultiplier * 100)}% to ${Math.round(MOVEMENT.power.maximumMultiplier * 100)}%` },
      { label: "Storage", value: "Automatic Discharge On Deficit, Charge On Surplus" }
    ],
    practicalUse: "Size generation for sustained demand and use storage for bursts, not permanent supply. A small deficit slows propulsion, weapons, support, and other active systems together. Watch reactor Heat because generation can fall before the demand panel changes.",
    commonProblems: [
      "Everything is partly weak at once? The shared Power ratio is below one.",
      "Storage empties immediately? Demand exceeds generation by more than the reserve can sustain.",
      "Rated generation looks sufficient but output is short? Inspect generator health and Heat state."
    ],
    related: ["blueprint-designer", "heat", "support"]
  },
  {
    id: "heat",
    category: "heat",
    title: "Heat Management",
    ...HEAT_MANUAL_CONTENT,
    related: ["power", "blueprint-designer"]
  },
  {
    id: "movement",
    category: "movement",
    title: "Movement & Orders",
    summary: "Engines, thrust, turn rate, mass classes, and issuing commands.",
    keywords: ["movement", "engine", "thrust", "turn", "speed", "mass", "orders", "command", "right-click", "rally"],
    howItWorks: `Ships move using engine thrust. Live engines and directional actuators stack linearly: each contributes its full authored value after explicit Power, Heat, exhaust, and geometry conditions. Generic positive and negative turn modifiers from non-actuator components adjust the ship's symmetric turn rate. Maneuver thrusters provide directional torque based on their distance from the ship's centre of mass, with a lever from ${MOVEMENT.maneuverThrusterLever.minimumLever} up to ${MOVEMENT.maneuverThrusterLever.maximumLever}. Mass applies a continuous speed drag and a hard class-based turn limit. Functioning generators and available battery discharge supply one ship-wide Power pool. Each powered movement consumer receives a linear share of available Power, and surplus supply does not increase movement. Issue orders by selecting ships and right-clicking the arena. Right-click an enemy to focus fire. Set a rally point to direct newly built ships. Ships without engines cannot move. Under Backup Command, turn rate follows ${BACKUP_EFFECTIVENESS_TEXT} effectiveness.`,
    importantStats: [
      { label: "Engine And Actuator Stacking", value: "Linear per live component" },
      { label: "Maneuver Min Lever", value: `${MOVEMENT.maneuverThrusterLever.minimumLever}` },
      { label: "Maneuver Lever Per Cell", value: `${MOVEMENT.maneuverThrusterLever.leverPerCell}` },
      { label: "Maneuver Max Lever", value: `${MOVEMENT.maneuverThrusterLever.maximumLever}` },
      { label: "Maximum Speed", value: "Calculated continuously from thrust and mass" },
      { label: "Braking", value: `${BRAKE_ACCEL_RATIO}x current acceleration` },
      { label: "Mass Turn Scaling", value: "Continuous mass penalty with hard class turn limits" },
      { label: "Movement Power Scaling", value: `Linear per consumer, capped at ${Math.round(MOVEMENT.power.maximumMultiplier * 100)}%` },
      { label: "Surplus Power", value: "Charges storage; no movement bonus" },
      ...((MOVEMENT.massClasses || []).map((c) => ({
        label: `${c.name} (${formatMassClassRange(c)})`,
        value: `Turn limit ${c.turnCap} rad/s`
      })))
    ],
    practicalUse: "Light ships are fast and agile : ideal for capture runs and flanking. Capital ships are slow but tanky and pack heavy weapons. Use maneuver thrusters for better turning without adding much straight-line speed. Position maneuver thrusters far from the centre of mass for maximum lever effect. Gyroscopes are simpler but less powerful than a well-placed pair of maneuver thrusters.",
    commonProblems: [
      "Ship not moving? Check for engines and sufficient power.",
      "Turning too slowly? Add gyroscopes or maneuver thrusters.",
      "Ship slow despite engines? High mass reduces speed : check the Ship Summary for your mass class."
    ],
    related: ["combat-styles", "blueprint-designer", "power", "economy"]
  }
];

// ---------------------------------------------------------------------------
// Manual articles (part 2: combat-styles, defence, drones, support, command)
// ---------------------------------------------------------------------------

const MANUAL_ARTICLES_PART_2 = [
  {
    id: "combat",
    category: "combat",
    title: "Combat Basics",
    summary: "How ships acquire targets, bring weapons to bear, and keep fighting after an order.",
    keywords: ["combat", "attack", "target", "focus fire", "range", "firing arc", "line of sight"],
    howItWorks: "Right-clicking an enemy gives the selected ships a focus-fire target. A ship can fire only when it has a valid, detected target inside a weapon's range and firing arc, with a clear firing solution. Its combat style decides how it moves around that target. Destroying the main Core destroys the ship unless a functioning Backup Command Core takes over. Damage lands on shields and components, so losing propulsion, cooling, sensors, support, or weapons can change what a surviving ship is able to do.",
    practicalUse: "Match the hull to its intended range and facing. Put narrow-arc weapons where the chosen combat style can keep them on target, layer defences around critical systems, and concentrate fire when you need to remove one enemy quickly.",
    commonProblems: [
      "Ship sees an enemy but does not fire? Check weapon range, firing arc, line of sight, Power, and Heat.",
      "Ship moves in an unexpected way? Its combat style still governs movement after target acquisition.",
      "Focus fire stopped? The target may be destroyed, hidden from Sensors, or no longer valid."
    ],
    related: ["combat-styles", "weapons", "defence", "sensors-detection", "movement"]
  },
  {
    id: "weapons",
    category: "weapons",
    title: "Weapons",
    summary: "Overview of all weapon types and their roles in combat.",
    keywords: ["weapon", "missile", "rail", "laser", "cannon", "beam", "torpedo", "flak", "point defence", "damage", "dps"],
    howItWorks: "Weapons are the primary damage-dealing components. Each weapon type has distinct trade-offs: missiles track targets but can be intercepted, rails have long range and high alpha damage but slow fire rates, lasers provide continuous beam damage, cannons offer rapid fire with moderate damage, and beams melt shields. Weapon stats are auto-generated from the authoritative component balance data. Select a specific weapon from the category list to see exact damage, fire rate, range, and tracking values.",
    practicalUse: "Mix weapon types for flexibility: missiles for burst, rails for range, point defense for anti-missile. Check the component articles for exact stats and trade-offs.",
    commonProblems: [
      "Weapons not firing? Check the weapon's power state and whether it is alive and enabled.",
      "Missiles intercepted? Consider overwhelming enemy point defense with swarm missiles.",
      "Rails missing? They have narrow arcs : position ships carefully."
    ],
    related: ["combat-styles", "defence", "power", "heat", "blueprint-designer"]
  },
  {
    id: "combat-styles",
    category: "combat",
    title: "Combat Styles",
    summary: "Charge, Hold, Orbit, Kite, and Static define how ships move around their current combat target.",
    keywords: ["combat", "style", "hold", "charge", "orbit", "kite", "static", "behavior", "ai", "stance"],
    howItWorks: "Each ship follows one of five combat movement styles. Charge pursues continuously, leads a moving target, and drives through weapon range to contact without braking. Hold approaches when outside preferred weapon range, then fires from an established position without retreating from closer targets. Orbit flies a ring at its intended radius with a stable direction and continuous radial correction. Kite holds its target near the far edge of its main battery: it runs when the range collapses or a fast attacker is about to collapse it, eases back in when it drifts too far out, and closes only when the target leaves that battery's reach. There is no reverse thrust, so a kiting ship picks a hull heading that both opens the range and keeps guns bearing -- a rear-mounted railgun keeps firing while the ship accelerates away, while a nose gun loses coverage during the turn and gets it back once the range is safe. It routes around asteroids and stations and turns away from the map edge instead of grinding along it. Static never repositions for combat at all: it holds the ground it is standing on and turns to face whatever it is shooting. Ships acquire another nearby enemy when their current target becomes invalid. A move order you issue by hand overrides all of this until you give the ship another command.",
    importantStats: [
      { label: "Hold Range Ratio", value: "90% Of Max Weapon Range" },
      { label: "Charge Stop", value: "Contact Distance" },
      { label: "Orbit Range Ratio", value: "75% Of Max Weapon Range" },
      { label: "Kite Preferred Range", value: "90% Of Main Battery Reach" },
      { label: "Kite Retreat Below", value: "78% Of Main Battery Reach" },
      { label: "Kite Closes Above", value: "96% Of Main Battery Reach" },
      { label: "Static Movement", value: "None" }
    ],
    practicalUse: "Hold is the general ranged default. Charge suits ships that must force close contact. Orbit rewards agile ships that can sustain a curved course. Kite suits fast, long-range ships, and it is at its best with the main gun mounted to the rear so the ship can shoot down its own wake. Static suits ships you want anchored exactly where you put them.",
    commonProblems: [
      "Ship not engaging? It may have no weapons with range, or the target is out of range.",
      "Hold ship moving closer? Its target has moved outside preferred weapon range.",
      "Kite ship moving away? Its target is inside the retreat threshold, or is closing fast enough to be about to cross it.",
      "Kite ship not shooting while it runs? Its guns are mounted forward. Rotate the main weapon to the rear and it will fire down its own wake.",
      "Ship ignoring its stance? You gave it a move or stop order by hand -- those hold until you command it again.",
      "Want to change style mid-match? Select ships and use the combat style buttons in the match panel."
    ],
    related: ["movement", "weapons", "defence"]
  },
  {
    id: "defence",
    category: "shields-armour",
    title: "Shields & Armour",
    summary: "How shield fields, armour, hull structure, and active defences keep ships alive.",
    keywords: ["defence", "defense", "shield", "armor", "composite armor", "point defense", "flak", "interceptor", "aegis", "decoy"],
    howItWorks: `Defence components protect ships from incoming damage. Shields absorb damage and regenerate over time (consuming power). Every ${SHIELD_IMPACT_HEAT_TEXT} of blocked Shield damage becomes Heat in the Shield system; 100 blocked damage creates 12 H total, distributed across active Shield generators rather than added independently to each generator. Armor plates add hull HP and can reduce incoming damage. Point defense lasers destroy incoming missiles and drones. Flak cannons provide short-range anti-missile and anti-swarm defence. Interceptor pods offer longer-range missile interception. Aegis projectors project a fast-recharging shield field at high power cost. Decoy launchers deploy false targets that can pull guided missiles away.`,
    practicalUse: "Layer shields over armor for maximum survivability. Point defense is essential against missile-heavy opponents. Use armor on the forward facing for charge-style ships. Decoy launchers counter guided missile spam.",
    commonProblems: [
      "Shields not regenerating? Check power supply : shields need power to regenerate.",
      "Missiles getting through? Add point defense or flak cannons.",
      "Armor not helping enough? Composite armor is lighter but gives less protection per cell than standard armor."
    ],
    related: ["weapons", "blueprint-designer", "power", "heat"]
  },
  {
    id: "drones",
    category: "drones",
    title: "Drones",
    summary: "Drone bays, fighter/defence/repair drones, and squadron mechanics.",
    keywords: ["drone", "drone bay", "fighter", "defence drone", "repair drone", "squadron", "launch"],
    howItWorks: `Drone Bays launch and rebuild configurable squads. Squad sizes, fuel durations and rebuild times depend on the selected drone type: ${droneTypeSummary("squadSize", " drones")}; ${droneTypeSummary("fuelSeconds", "s")} of fuel. Fighter drones attack the parent ship's target, Defence drones guard the parent ship, and Repair drones restore friendly hulls. ${droneProjectileEvasionDetail()} Drones must return to refuel, and a bay needs one complete two-cell edge exposed for launch. A bay uses its authored Activity Heat rate only while producing or operating active drones; a merely idle bay generates no Heat.`,
    importantStats: [
      { label: "Squad Size", value: droneTypeSummary("squadSize", " drones") },
      { label: "Max Bays Per Ship", value: `${DRONES.maxBaysPerShip ?? 4}` },
      { label: "Max Active Per Ship", value: `${DRONES.maxActivePerShip ?? 12}` },
      { label: "Max Active Per Player", value: `${DRONES.maxActivePerPlayer ?? 48}` },
      { label: "Fuel Duration", value: droneTypeSummary("fuelSeconds", "s") },
      { label: "Refuel Time", value: `${DRONES.refuelSeconds ?? 2}s` },
      { label: "Launch Interval", value: `${DRONES.launchIntervalSeconds ?? 0.65}s` },
      { label: "Launch Duration", value: `${DRONES.launchDurationSeconds ?? 0.8}s` },
      { label: "Orphan Lifetime", value: `${DRONES.orphanLifetimeSeconds ?? 3}s` },
      { label: "Standby Power", value: `${DRONES.standbyPowerMw ?? 3} MW` },
      { label: "Active Power", value: `${DRONES.activePowerMw ?? 7} MW` },
      { label: "Production Power", value: `${DRONES.productionPowerMw ?? 11} MW` },
      { label: "Activity Heat", value: `${PART_STATS.droneBay?.activityHeat ?? 0} H/s while producing or operating active drones` }
    ],
    practicalUse: "Fighter drones add DPS to any build. Defence drones protect against enemy drone swarms. Repair drones extend ship longevity. Mix types based on your strategy.",
    commonProblems: [
      "Drones not launching? Ensure the bay has an exposed two-cell edge.",
      "Drones disappearing? They run out of fuel and must return to refuel.",
      "Too many drones? The 12-active-per-ship limit prevents excessive swarms."
    ],
    related: ["weapons", "defence", "support", "blueprint-designer"]
  },
  {
    id: "support",
    category: "data-links",
    title: "Data Links",
    summary: "Connect support sources directly to weapons and decide how each fixed support budget is shared.",
    keywords: ["data links", "support", "targeting computer", "signal amplifier", "stabilizer node", "fire control", "accuracy", "range", "fire rate", "link all"],
    howItWorks: "Data Links are explicit logical connections from a support source to a weapon. Fire Control contributes fire rate, Signal Amplifiers contribute range, and Targeting Computers or Stabilizer Nodes contribute accuracy. Each source owns one fixed budget. Linking that source to one eligible weapon gives the weapon the full effective budget; linking it to several weapons divides the budget evenly between them. Multiple sources can feed the same weapon and their contributions add. A source contributes nothing while destroyed, unpowered, or overheated.",
    importantStats: [
      { label: "Valid Sources", value: "Fire Control, Signal Amplifier, Targeting Computer, Stabilizer Node" },
      { label: "Valid Targets", value: "Weapon Components" },
      { label: "Allocation", value: "Fixed Source Budget Divided Evenly Across Linked Weapons" },
      { label: "Link Geometry", value: "Direct Source-To-Weapon Pair" },
      { label: "Link All", value: "Maximum Coverage, Smaller Per-Weapon Shares" }
    ],
    practicalUse: "Open Data Links in the Blueprint Designer, click a source, then click weapons to link or unlink them; you can also drag from a source to a weapon. Concentrate a source on a key weapon for the largest bonus, or spread it across several weapons for broader coverage. The Data analysis shows the exact budget and per-weapon result.",
    commonProblems: [
      "Source fitted but no bonus delivered? Link it to at least one weapon.",
      "Bonus smaller than expected? The source is sharing its budget across every linked eligible weapon.",
      "Linked source showing offline or reduced? Check its component health, Power, and Heat state."
    ],
    related: ["blueprint-designer", "weapons", "power", "heat", "component-reference"]
  },
  {
    id: "sensors-detection",
    category: "sensors-detection",
    title: "Sensors & Detection",
    summary: "How allied sensor coverage reveals enemies and how omnidirectional and directed sensors stack.",
    keywords: ["sensor", "detection", "visibility", "fog", "full dark", "omnidirectional", "directed", "cone", "remembered contact"],
     howItWorks: "In Sensor Fog and Full Dark matches, enemy ships and drones are live targets only while they fall inside allied sensor coverage. Every hull has the same base omnidirectional range. Each live general Sensor adds its full authored range bonus linearly. Directed Sensors form a separate coverage family and project longer forward cones based on component rotation; aligned cones combine their full bonuses where they overlap. A live sensor contributes its full authored range bonus when operational, while a destroyed or unpowered sensor contributes zero. Allied ships, owned relays, and home stations share coverage with the team. A lost enemy ship leaves a last-known contact for a short time, but remembered contacts cannot be targeted as if they were still visible.",
     importantStats: [
       { label: "Universal Hull Base Range", value: `${GENERATED_BALANCE.visibility?.baseSensorRange ?? 460} m` },
      { label: "Sensor Stacking", value: "Linear full authored bonus per live sensor" },
      { label: "Remembered Contact", value: `${GENERATED_BALANCE.visibility?.rememberedContactSeconds ?? 12}s` }
    ],
    practicalUse: "Use omnidirectional sensors for dependable local awareness and directed sensors for long-range scouting along an expected approach. Rotate directed sensors toward the battlefield and keep sensor ships alive; a fleet can lose both targeting options and information when its coverage collapses.",
    commonProblems: [
      "Enemy marker remains but cannot be attacked? It is a remembered contact, not a live detection.",
      "Directed sensor misses targets beside the ship? Its range applies only inside the facing cone.",
      "Extra sensors add less than expected? Check their Power, health, role, and Directed cone geometry."
    ],
    related: ["combat", "movement", "command", "component:smallSensor", "component:largeDirectedSensor"]
  },
  {
    id: "command",
    category: "command",
    title: "Command Systems",
    summary: "Command cores, backup cores, and command auras.",
    keywords: ["command", "core", "backup core", "aura", "command range", "accuracy", "tracking"],
    howItWorks: `Every ship requires a Core component : it is the command centre. If the Core is destroyed, the ship is lost. A Backup Command Core can be installed to keep the ship operational if the main Core is destroyed; while active, weapon accuracy, turn rate and drone command range operate at ${BACKUP_EFFECTIVENESS_TEXT}. Command components project authored effects for friendly ships within range, including weapon accuracy, tracking, and turret response where configured. All command auras share the same range so players can judge coverage at a glance.`,
    importantStats: [
      { label: "Command Aura Range", value: `${GENERATED_BALANCE.commandAura?.range ?? 800} m` },
      { label: "Aura Affects Self", value: `${GENERATED_BALANCE.commandAura?.selfAura ? "Yes" : "No"}` }
    ],
    practicalUse: "Place the Core in a well-protected position : usually the ship's interior. Backup Cores are essential for expensive capital ships. Overlapping command auras from multiple ships stack benefits for fleet engagements.",
    commonProblems: [
      "Ship destroyed when Core killed? Install a Backup Command Core.",
      "Aura not helping? Check that friendly ships are within the aura range.",
      "Core too exposed? Surround it with armor and keep it away from the ship edges."
    ],
    related: ["blueprint-designer", "defence", "support", "economy"]
  }
];

// ---------------------------------------------------------------------------
// Manual articles (part 3: economy, multiplayer, controls)
// ---------------------------------------------------------------------------

const MANUAL_ARTICLES_PART_3 = [
  {
    id: "economy",
    category: "economy-objectives",
    title: "Economy & Objectives",
    summary: "Money, income, ship purchases, relays, and victory conditions.",
    keywords: ["economy", "money", "income", "ship cap", "relay", "capture", "bounty", "victory", "win", "objective"],
    howItWorks: "Players earn money passively through base income and relay control. Relays are capturable points on the map : controlling them provides additional income. Ships cost money to build, up to a fleet cap. Destroying enemy ships awards kill bounties (28% of the destroyed ship's cost, minimum £24). Capturing a relay awards a £70 bonus. Victory is achieved by holding every relay for the victory countdown or by destroying the enemy home station. Each home station's hull and shields scale with the number of players attacking it.",
    importantStats: [
      { label: "Starting Money", value: `\u00a3${ECON.startingMoney ?? 1000}` },
      { label: "Maximum Money", value: `\u00a3${ECON.maxMoney ?? 99999}` },
      { label: "Base Income", value: `+\u00a3${ECON.baseIncome ?? 20}/s` },
      { label: "Relay Income", value: `+\u00a3${ECON.relayIncome ?? 5}/s Per Relay` },
      { label: "Kill Bounty", value: `${Math.round((ECON.killBountyRatio ?? 0.28) * 100)}% Of Ship Cost (Min \u00a3${ECON.killBountyMin ?? 24})` },
      { label: "Capture Bonus", value: `\u00a3${ECON.captureBonus ?? 70}` },
      { label: "Ship Cap", value: `${ECON.shipCap ?? 30} Ships` }
    ],
    practicalUse: "Balance economy and military: capturing relays early provides income advantage. Don't float money : spend it on ships to project force. Cheap ships are cost-effective for relay capture; expensive ships win fleet engagements.",
    commonProblems: [
      "Can't buy ships? Check your money and fleet cap.",
      "Losing income? Enemy may control more relays : recapture them.",
      "Fleet cap reached? Destroyed ships free up cap space."
    ],
    related: ["movement", "combat-styles", "multiplayer", "blueprint-designer", "ship-pricing", "capture-mechanics"]
  },
  {
    id: "ship-pricing",
    category: "economy-objectives",
    title: "Ship Pricing Formula",
    summary: "How Ship Costs Are Summed Directly From Component Prices.",
    keywords: ["ship pricing", "cost", "formula", "component cost"],
    howItWorks: "The server and client both calculate ship cost by summing component.cost for every component in the design. The component balance is the only place to change a component's price. Fleet capacity and hangar availability are separate rules and do not alter ship cost.",
    importantStats: [
      { label: "Component Cost", value: "Direct value on each component" }
    ],
    practicalUse: "Set direct component prices to control ship cost. Lower-cost ships leave more money for additional purchases, up to the fleet cap.",
    commonProblems: [
      "Ship too expensive? Inspect the direct costs of its components.",
      "Not enough ships? Check your available money and the fleet cap."
    ],
    related: ["economy", "ship-cost-formula"]
  },
  {
    id: "capture-mechanics",
    category: "economy-objectives",
    title: "Relay Capture Mechanics",
    summary: "How relay capture works: progress rates, decay, and multipliers.",
    keywords: ["capture", "relay", "progress", "decay", "rate", "neutral", "control", "victory"],
    howItWorks: "Relays are neutral capturable points. Ships near a relay increase their owner's capture progress. The base capture rate is augmented per ship present. When a relay changes ownership, the new owner gets a progress multiplier to consolidate control faster. If no ships are near a neutral relay, progress decays back toward neutral.",
    importantStats: [
      { label: "Neutral Decay", value: `${GENERATED_BALANCE.capture?.neutralDecayPerSecond ?? 0.08}/s` },
      { label: "Base Capture Rate", value: `${GENERATED_BALANCE.capture?.baseCaptureRate ?? 0.1}/s` },
      { label: "Capture Rate Per Ship", value: `+${GENERATED_BALANCE.capture?.captureRatePerShip ?? 0.045}/s` },
      { label: "New Owner Multiplier", value: `${GENERATED_BALANCE.capture?.newOwnerProgressMultiplier ?? 3}×` }
    ],
    practicalUse: "Send multiple ships to a relay to capture it faster. The new-owner multiplier means freshly captured relays consolidate quickly : push hard right after capture. Hold majority control for 20 seconds to win.",
    commonProblems: [
      "Relay not capturing? Ensure your ships are close enough to the relay.",
      "Relay losing progress? Enemy ships may be contesting or no ships are present to hold it."
    ],
    related: ["economy", "movement", "combat-styles", "multiplayer"]
  },
  {
    id: "multiplayer",
    category: "start-here",
    title: "Multiplayer & Lobby",
    summary: "Creating rooms, joining games, teams, bots, and match flow.",
    keywords: ["multiplayer", "lobby", "room", "code", "join", "create", "team", "bot", "host", "spectator"],
    howItWorks: "Create a private room from the main menu to get a room code. Share the code with friends so they can join. The host can configure game rules (mode, starting money, max players, map size, asteroid density) and add bots. Players choose a team (Blue Wing or Red Wing). The match flows through four phases: Lobby, Design, Battle, and End. During Design, all players build their ships simultaneously. During Battle, ships fight automatically based on their combat styles and player-issued commands.",
    importantStats: [
      { label: "Max Players Per Room", value: `${GENERATED_BALANCE.fleetLimits?.shipCap ? 8 : 8}` },
      { label: "Room Code Length", value: "6 Characters" },
      { label: "Game Modes", value: "Teams Or Solo" }
    ],
    practicalUse: "For 1v1 practice, create a room with 2 max players and add a bot. For team games, coordinate with teammates on fleet composition. The host can restart the lobby for rematches without creating a new room.",
    commonProblems: [
      "Can't join? Check the room code is correct and the host is online.",
      "Disconnected? The game saves your room code for recovery : use the Resume button on the main menu.",
      "Can't start? Only the host can start the design phase."
    ],
    related: ["economy", "blueprint-designer", "controls"]
  },
  {
    id: "controls",
    category: "start-here",
    title: "Controls",
    summary: "Keyboard shortcuts, mouse commands, and camera controls.",
    keywords: ["controls", "keyboard", "shortcut", "keybind", "mouse", "camera", "hotkey"],
    howItWorks: "Ships are selected with left-click or drag-box. Right-click issues move or attack commands. The camera pans with WASD or edge-scroll, zooms with the mouse wheel, and follows selected ships with F. Press Q to select all own ships, C to center on selected ships, 0 to reset zoom. Press V to toggle component damage view. In the designer, R rotates the focused part and Ctrl+Z undoes the last edit.",
    importantStats: [
      { label: "Select All", value: "Q" },
      { label: "Stop Ships", value: "B" },
      { label: "Follow Camera", value: "F" },
      { label: "Center On Selection", value: "C" },
      { label: "Reset Zoom", value: "0" },
      { label: "Damage View Toggle", value: "V" },
      { label: "Rotate Part (Designer)", value: "R" },
      { label: "Undo (Designer)", value: "Ctrl+Z" },
      { label: "Self-Destruct", value: "Del / Backspace" }
    ],
    practicalUse: "Master Q (select all) and right-click commands first. Use F to follow your fleet in battle. Press V to check damage on selected ships mid-fight.",
    commonProblems: [
      "Keys not working? Make sure no input field is focused.",
      "Can't pan camera? Use WASD or hold Space + drag.",
      "Rotate not working? R only works in the designer when a part is focused."
    ],
    related: ["movement", "combat-styles", "blueprint-designer"]
  },
  {
    id: "projectile-mechanics",
    category: "advanced-mechanics",
    title: "Projectile Mechanics",
    summary: "How projectiles travel, collide, and interact with shields and hull.",
    keywords: ["projectile", "collision", "shield", "hull", "hit radius", "intercept", "missile", "rail", "impact"],
    howItWorks: "Projectiles travel at their weapon's projectile speed toward the target. Each projectile type has a hit radius for collision detection. Missiles have a larger hit radius than rails. When a projectile hits a shield, it deals damage modified by the weapon's shield damage multiplier. Shields absorb 95% of blocked damage; 5% leaks to hull. When a projectile hits hull, it deals damage modified by the hull damage multiplier. Point defence and flak can intercept missiles within the intercept radius.",
    importantStats: [
      { label: "Shield Hit Minimum", value: `${GENERATED_BALANCE.projectiles?.shieldHitMinimum ?? 10}` },
      { label: "Shield Collision Min Radius", value: `${GENERATED_BALANCE.projectiles?.shieldCollision?.minimumRadius ?? 30} m` },
      { label: "Shield Collision Flat Padding", value: `${GENERATED_BALANCE.projectiles?.shieldCollision?.flatPadding ?? 8} m` },
      { label: "Shield Collision Radius Mult", value: `${GENERATED_BALANCE.projectiles?.shieldCollision?.radiusMultiplier ?? 0.18}×` },
      { label: "Missile Hit Radius", value: `${GENERATED_BALANCE.projectiles?.hitRadius?.missile ?? 14} m` },
      { label: "Rail Hit Radius", value: `${GENERATED_BALANCE.projectiles?.hitRadius?.rail ?? 9} m` },
      { label: "Default Hit Radius", value: `${GENERATED_BALANCE.projectiles?.hitRadius?.default ?? 6} m` },
      { label: "Intercept Radius", value: `${GENERATED_BALANCE.projectiles?.interceptRadius ?? 20} m` },
      { label: "World Padding", value: `${GENERATED_BALANCE.projectiles?.worldPadding ?? 80} m` },
      { label: "Effect Lifetime", value: `${GENERATED_BALANCE.projectiles?.effectLifetime ?? 1.2}s` },
      { label: "Missile Map Impact Margin", value: `${GENERATED_BALANCE.projectiles?.mapImpactMargins?.missile ?? 8} m` },
      { label: "Rail Map Impact Margin", value: `${GENERATED_BALANCE.projectiles?.mapImpactMargins?.rail ?? 3} m` },
      { label: "Default Map Impact Margin", value: `${GENERATED_BALANCE.projectiles?.mapImpactMargins?.default ?? 5} m` }
    ],
    practicalUse: "Missiles are easier to intercept due to larger hit radius and slower speed. Rails are harder to intercept : small hit radius and very high speed. Shields provide a collision radius that can catch near-misses.",
    commonProblems: [
      "Shots passing through shields? The shield collision radius may not be large enough for the projectile.",
      "Missiles shot down? Enemy point defence intercepts within 20 m."
    ],
    related: ["weapons", "defence", "missile-guidance"]
  },
  {
    id: "missile-guidance",
    category: "advanced-mechanics",
    title: "Missile Guidance",
    summary: "How missiles track targets, turn, and get countered by ECM.",
     keywords: ["missile", "guidance", "tracking", "turn rate", "ecm", "lead", "arming"],
     howItWorks: "Missiles travel at their listed Projectile Speed throughout flight. They arm with a reduced turn rate, then switch to full tracking after the arming phase. Turn rate scales with the weapon's tracking stat squared. Missiles lead their targets based on lead strength, while ECM from electronic warfare command centres can reduce missile tracking effectiveness.",
    importantStats: [
      { label: "Arming Turn Rate", value: `${GENERATED_BALANCE.missileGuidance?.armingTurnRate ?? 0.1}` },
      { label: "Default Tracking", value: `${GENERATED_BALANCE.missileGuidance?.defaultTracking ?? 0.5}` },
      { label: "Base Turn Rate", value: `${GENERATED_BALANCE.missileGuidance?.baseTurnRate ?? 0.7}` },
      { label: "Turn Rate Base", value: `${GENERATED_BALANCE.missileGuidance?.turnRateBase ?? 0.45}` },
      { label: "Tracking² Multiplier", value: `${GENERATED_BALANCE.missileGuidance?.turnRateTrackingSquaredMultiplier ?? 4.2}×` },
      { label: "Lead Strength Multiplier", value: `${GENERATED_BALANCE.missileGuidance?.leadStrengthMultiplier ?? 0.35}×` },
       { label: "ECM Cap", value: formatPercent(GENERATED_BALANCE.missileGuidance?.ecmCap ?? 0.55) }
    ],
    practicalUse: "Higher tracking weapons turn harder : swarm missiles track better than torpedoes. ECM from Electronic Warfare Command Centres can reduce tracking by up to 55%, making missiles miss agile targets.",
    commonProblems: [
      "Missiles missing? Target may be too agile or ECM is reducing tracking.",
      "Torpedoes not hitting? They have low tracking (0.2) : use against slow or stationary targets."
    ],
    related: ["weapons", "projectile-mechanics", "defence", "command"]
  },
  {
    id: "repair-mechanics",
    category: "advanced-mechanics",
    title: "Repair Mechanics",
    summary: "How hull repair works, diminishing returns, range, and repair beams.",
    keywords: ["repair", "hull", "heal", "diminishing returns", "repair beam", "repair range"],
    howItWorks: `Repair modules restore hull HP over time. The strongest local Repair source contributes 100%, then each additional source contributes ${REPAIR_STACKING_TEXT} as much as the previous one. The progression is ${REPAIR_PROGRESSION_TEXT}. Power, Heat, component state, target need, and command auras determine delivered work. Repair beams project repair at range toward friendly ships and do not use the local Repair stacking warning. The repair range determines how far the beam can reach. Drones can also repair their parent ship and nearby allies.`,
    importantStats: [
      { label: "Repair Range", value: formatDistance(GENERATED_BALANCE.repair?.repairRange ?? 410) },
      { label: "Stacking", value: `Diminishing returns (${REPAIR_STACKING_TEXT} per additional local source)` },
      { label: "Progression", value: REPAIR_PROGRESSION_TEXT }
    ],
    practicalUse: "Use multiple local Repair modules when the added output justifies their Power and Heat cost; each added source contributes less than the previous one. Repair beams are directional; aim them at the ship you want to heal. Repair drones automatically target the parent ship first, then nearby allies.",
    commonProblems: [
      "Repair output lower than the nominal sum? Check Power, Heat, component damage, target need, and aura coverage.",
      "Repair beam not hitting? It's directional; ensure the emitter faces the target."
    ],
    related: ["support", "defence", "drones", "blueprint-designer"]
  },
  {
    id: "advanced-mechanics",
    category: "advanced-mechanics",
    title: "Advanced Mechanics",
    summary: "Detailed interactions that matter after the core build-and-fight loop is familiar.",
    keywords: ["advanced", "projectile", "missile", "repair", "stacking", "formula", "interaction"],
    howItWorks: "This section collects mechanics that are useful for optimisation but are not required to build a first working ship. Use it for projectile collision, missile guidance and countermeasures, diminishing-return Repair output, and other exact interaction rules. Component-specific exceptions and live balance values remain in Component Reference.",
    practicalUse: "Start here when a design works but its real combat result differs from the headline stats. Follow the related articles for the delivery, tracking, stacking, or conditional rule that changes the outcome.",
    commonProblems: [],
    related: ["projectile-mechanics", "missile-guidance", "repair-mechanics", "component-reference"]
  },
  {
    id: "component-reference",
    category: "component-reference",
    title: "Component Reference",
    summary: "Exact, balance-backed stats and special mechanics for every component in the live catalogue.",
    keywords: ["component", "part", "reference", "stats", "cost", "mass", "hull", "catalogue"],
    howItWorks: "Every component article in this section is generated from the same balance catalogue used by the game. Entries include cost, mass, durability, Power, Heat, weapon values, limits, and any documented conditional mechanics. Search by component name when you know the part; use the learning sections when you need to understand the surrounding system.",
    practicalUse: "Compare exact component entries after deciding what job the ship needs to perform. Recheck conditional-performance and limitation rows before assuming a headline value applies in every state.",
    commonProblems: [],
    related: ["blueprint-designer", "heat", "weapons", "defence", "sensors-detection"]
  }
];

// Accuracy-focused replacements for the original launch copy. Keeping these
// keyed by article id makes the player manual easy to audit against each live
// rules owner while preserving stable article ids and history links.
const MANUAL_CONTENT_UPDATES = Object.freeze({
  overview: {
    summary: "The shortest path from an empty blueprint to a useful fleet.",
    howItWorks: "Build or load a blueprint, Ready Up, then buy ships after the match becomes active. A purchase-valid ship has one Core, effective thrust, a connected non-overlapping layout, and enough Power and cooling for its intended job. Select ships and right-click to move or attack. Use combat styles for continuing behaviour, Sensors to maintain live targets, and relays for income. Classic matches end after one side controls every relay through the victory countdown. Station matches end only when an enemy home station is destroyed.",
    practicalUse: "For a first ship, keep the starter hull, confirm its exhaust remains clear, and add one weapon at a time while watching Power and Heat. Read Building Ships, Controls, Combat, and Economy & Objectives in that order. Use Component Reference only when you need exact part values.",
    commonProblems: [
      "Ready but no ship appeared? Ready Up starts the match; ships are bought from the purchase bar after it starts.",
      "Ship cannot be purchased? Open Ship Validation and resolve the exact purchase error.",
      "Enemy vanished? In sensor-limited modes, a remembered contact is not a live target."
    ]
  },
  "blueprint-designer": {
    summary: "Place, rotate, flip, remove, analyse, save, and validate ship designs.",
    howItWorks: "Select a component from the palette and click the 15 by 15 grid to place it. Right-click a component to remove it, press R to rotate the focused component, and press F to flip components that support mirroring. Ctrl+Z undoes the last physical edit. Reset Design restores the starter ship; Clear All keeps only the Core. Incomplete and disconnected layouts remain editable and saveable, so the grid never forces a construction order. Purchase performs the full validity check. The Ship Summary, Heat analysis, and Data analysis update from the current design.",
    practicalUse: "Use warnings as design feedback, not edit restrictions. Save useful intermediate layouts, inspect weapon arcs and exposed edges, then resolve every critical warning before purchase.",
    commonProblems: [
      "Part will not place? Its transformed footprint overlaps another component or leaves the grid.",
      "Design saves but will not deploy? Saving permits incomplete work; purchase requires a valid ship.",
      "Change missing after reload? Save the blueprint after the physical edit and Data Link changes."
    ]
  },
  "placement-rules": {
    summary: "Footprints, anchors, rotations, flips, and the limits enforced while editing.",
    howItWorks: "Every component occupies one or more grid cells. Its x and y identify the footprint anchor; rotation and optional flipping transform the complete footprint around that anchor. Placement is rejected only when the transformed footprint leaves the grid or overlaps another component. Connectivity may be temporarily invalid while editing and is checked at purchase. Weapons and other explicitly rotatable components cycle through their allowed facings. Maneuver Thrusters choose their outward side automatically. Drone Bays keep their authored orientation because their exposed launch edge is part of the design rule.",
    practicalUse: "Rotate weapons to match the intended fighting direction, not merely to make them fit. Use the placement preview for the complete footprint. Finish by checking connectivity, exhaust channels, Drone Bay launch edges, and weapon arcs.",
    commonProblems: [
      "Part faces the wrong way? Focus it and press R; only authored rotations are available.",
      "Maneuver Thruster will not rotate? Its side-facing orientation is selected from placement.",
      "Part appears connected only at a corner? Diagonal contact does not satisfy deployment connectivity."
    ]
  },
  "structural-connectivity": {
    summary: "Every deployed component needs a side-adjacent structural route to the Core.",
    howItWorks: "Connectivity expands complete component footprints and traverses only up, down, left, and right contacts. Every component must first be physically reachable from the Core. A second traversal prevents ordinary components from using a chain of Heat Pipes as their only structural path; Heat Pipes are mounted thermal transport, not hull structure. The designer may hold a disconnected work in progress, but purchase rejects it.",
    practicalUse: "Give systems a real frame, armour, or component path back to the Core. Heat Pipes may branch from that structure and attach to hot components or cooling, but should never be the bridge supporting the far side of the ship.",
    commonProblems: [
      "Disconnected warning? Look for a gap or corner-only contact.",
      "A component beyond a Heat Pipe is invalid? Add a non-pipe structural route to it.",
      "Connectivity changed after rotation? Multi-cell footprint contacts rotate with the component."
    ]
  },
  "ship-validation": {
    summary: "The complete difference between a saveable design and a purchasable ship.",
    howItWorks: "A purchased ship needs exactly one Core, no more than one Backup Command Core, no overlap or out-of-bounds footprint, and a valid side-adjacent structural path from every component to the Core. Per-component limits apply. Each Drone Bay needs a selected Fighter, Defence, or Repair loadout and one complete exposed two-cell launch edge. Purchase also requires effective engine thrust, sufficient money, Ready status, an active match, and space below the fleet cap. Saving and Ready Up deliberately do not require a purchase-valid blueprint.",
    importantStats: [
      { label: "Main Core", value: "Exactly 1" },
      { label: "Backup Command Core", value: "Maximum 1" },
      { label: "Grid", value: "15 By 15, No Overlap" },
      { label: "Connectivity", value: "Side-Adjacent Structural Route To Core" },
      { label: "Drone Bays", value: `${GENERATED_BALANCE.drones?.maxBaysPerShip ?? 4} Maximum, Configured Type, Exposed Launch Edge` },
      { label: "Purchase Thrust", value: "At Least One Effective Engine" }
    ],
    practicalUse: "Save unfinished ideas freely, then treat the purchase result as authoritative. Check thrust after exhaust blocking, not merely whether an Engine exists. A request can buy between one and five copies, but each copy still consumes money and fleet capacity.",
    commonProblems: [
      "Engine fitted but thrust is still invalid? Clear the complete exhaust channel.",
      "Drone Bay invalid? Select a drone type and expose one whole two-cell launch edge.",
      "Ready Up succeeded but purchase failed? Readiness is intentionally independent of blueprint validity and money."
    ]
  },
  "ship-cost-formula": {
    title: "Ship Cost",
    summary: "The authoritative purchase price is the sum of placed component catalogue costs.",
    keywords: ["cost", "price", "component cost", "catalogue", "purchase", "money", "quantity"],
    howItWorks: "The server computes unit cost by adding the catalogue cost of every placed component in the saved design. There is no separate base-ship charge, mass surcharge, hull surcharge, weapon-family premium, rounding layer, or minimum and maximum clamp in the authoritative purchase path. Buying several copies multiplies that unit cost by the requested quantity. Component Reference and the Designer palette expose the individual values used by the sum.",
    importantStats: [
      { label: "Unit Cost", value: "Sum Of Every Placed Component Cost" },
      { label: "Quantity Cost", value: "Unit Cost Times Requested Count" },
      { label: "Separate Mass Or Hull Charge", value: "None" },
      { label: "Separate Weapon Premium", value: "None" },
      { label: "Purchase Clamp", value: "None" }
    ],
    practicalUse: "To lower price, remove or replace the components whose catalogue costs matter most. Armour, weapons, support, and structure affect price only through their own component values. Multiply unit price before requesting a batch so the full purchase remains affordable.",
    commonProblems: [
      "Expected a weapon premium? Weapon price is already represented by that component's catalogue cost.",
      "Batch purchase costs more than expected? The unit cost is multiplied by every requested copy.",
      "Displayed estimate and purchase result disagree? The server-computed saved-design price is authoritative."
    ]
  },
  power: {
    summary: "One shared Power pool, proportional shortages, and automatic energy storage.",
    howItWorks: "Live, enabled generators contribute their current Heat-adjusted output to one ship-wide pool. Active consumers contribute demand. If generation is short, charged storage shares the deficit proportionally according to each unit's available discharge rate. Any remaining shortage gives every live consumer the same proportional Power ratio; there is no component priority. Spare generator output charges storage proportionally according to each unit's available charge rate after demand is met, and storage never charges and discharges in the same solve. Overheated active components produce no useful output even when Power is available.",
    importantStats: [
      { label: "Distribution", value: "One Ship-Wide Pool" },
      { label: "Shortage Allocation", value: "Same Proportional Ratio For All Consumers" },
      { label: "Movement Shortage", value: `Linear Power ratio, ${Math.round(MOVEMENT.power.minimumMultiplier * 100)}% to ${Math.round(MOVEMENT.power.maximumMultiplier * 100)}%` },
      { label: "Other Active Systems", value: `Linear Power ratio, ${Math.round(MOVEMENT.power.minimumMultiplier * 100)}% to ${Math.round(MOVEMENT.power.maximumMultiplier * 100)}%` },
      { label: "Storage", value: "Automatic Discharge On Deficit, Charge On Surplus" }
    ],
    practicalUse: "Size generation for sustained demand and use storage for bursts, not permanent supply. A small deficit slows propulsion, weapons, support, and other active systems together. Watch reactor Heat because generation can fall before the demand panel changes.",
    commonProblems: [
      "Everything is partly weak at once? The shared Power ratio is below one.",
      "Storage empties immediately? Demand exceeds generation by more than the reserve can sustain.",
      "Rated generation looks sufficient but output is short? Inspect generator health and Heat state."
    ]
  },
  heat: {
    ...HEAT_MANUAL_CONTENT
  },
  movement: {
    summary: "Momentum, forward thrust, turning authority, waypoints, and continuous orders.",
     howItWorks: `Ships retain momentum and accelerate only along their forward thrust direction; there is no reverse or lateral engine thrust. Braking decelerates at ${BRAKE_ACCEL_RATIO}x normal forward acceleration. Turning creates an arc instead of snapping velocity onto a new heading. Ships have no built-in hull turn: Engines, Gyroscopes, and Maneuver Thrusters provide turn authority, and multiple live turn contributions stack directly. Ship mass reduces the resulting turn rate. Generic authored turn modifiers adjust the symmetric rate when a ship has real turn authority. Maneuver torque depends on vertical distance from centre of mass and which side the thruster faces, so left and right turn authority can differ. Each movement consumer receives a linear share of available Power; surplus Power charges storage but does not boost movement. Right-click empty space for a move order, Shift-right-click to append waypoints for one selected ship, right-click an enemy to focus it, and use a rally point for new purchases.`,
    importantStats: [
       { label: "Engine And Actuator Stacking", value: "Linear per live component" },
       { label: "Braking", value: `${BRAKE_ACCEL_RATIO}x forward acceleration` },
       { label: "Turn Authority", value: "No built-in hull turn; Engines, Gyroscopes, and Maneuver Thrusters" },
       { label: "Maneuver Lever", value: `${MOVEMENT.maneuverThrusterLever.minimumLever} Minimum, +${MOVEMENT.maneuverThrusterLever.leverPerCell} Per Cell, ${MOVEMENT.maneuverThrusterLever.maximumLever} Maximum` },
       { label: "Mass Classes", value: MOVEMENT.massClasses.map((entry) => `${entry.name} ${formatMassClassRange(entry)}`).join(", ") },
       { label: "Turn Limits", value: MOVEMENT.massClasses.map((entry) => `${entry.name} ${entry.turnCap} rad/s`).join(", ") },
       { label: "Movement Power Scaling", value: `Linear per consumer, capped at ${Math.round(MOVEMENT.power.maximumMultiplier * 100)}%` }
    ],
    practicalUse: `Plan braking distance and facing before contact. Ships brake at ${BRAKE_ACCEL_RATIO}x their forward acceleration, so stopping distance is much shorter than an acceleration-only estimate. Put Maneuver Thrusters above or below centre of mass and fit both turning directions unless asymmetry is deliberate. Use queued waypoints for a precise route around obstacles; use combat styles for continuing behaviour around a target.`,
    commonProblems: [
      "Ship curves past its destination? It must turn its forward thrust into a braking solution.",
      "One turn direction is weak? Check Maneuver Thruster side, vertical lever, health, exhaust, and Power.",
      "Shift-right-click replaced the route? Waypoint appending works only with one selected ship and empty ground."
    ]
  }
});

const MANUAL_CONTENT_UPDATES_2 = Object.freeze({
  combat: {
    summary: "Detection, target validity, firing solutions, damage, and loss of systems.",
    keywords: ["combat", "attack", "target", "focus fire", "range", "firing arc", "line of sight", "spawn protection", "safe zone", "spawn zone", "hostile heat"],
    howItWorks: "Right-clicking a visible enemy assigns it as the selected ships' explicit target. A weapon fires only when its target is alive, currently targetable by the team, inside range and firing arc, and accepted by its firing-solution checks. Turrets rotate toward their solution rather than firing through an invalid bearing. Shields, armour, and component placement determine where damage goes. Destroyed components immediately lose their function. Spawn Protection: While a ship remains inside its own/team spawn zone, it cannot fire and cannot take combat damage or hostile Heat. This covers normal damage, direct component damage, induction Heat, and impact Heat. Normal combat begins after it leaves the zone. Destroying the main Core destroys the ship unless an operational Backup Command Core takes control.",
    practicalUse: "Concentrate fire to remove a dangerous system or hull before repairs recover it. Leave your own/team spawn zone before expecting weapons to fire or incoming damage and hostile Heat to resolve. Match weapon arcs to the combat style, protect the Core and propulsion, and keep a sensor source near long-range ships in restricted visibility modes.",
    commonProblems: [
      "Target is visible but a weapon does not fire? Check that weapon's range, arc, aim, Power, Heat, and line of fire.",
      "Fleet stopped focus firing? The explicit target died or ceased to be a valid live target.",
      "Ship survives but performs poorly? Inspect component damage; intact hull does not mean intact systems.",
      "Turrets track but do not fire? The ship may still be inside its own/team spawn zone; leave the zone to begin normal combat.",
      "Enemy damage or Heat has no effect? The target may still be inside its own/team spawn zone."
    ],
    related: ["targeting-and-arcs", "combat-styles", "damage-and-destruction", "defence", "sensors-detection"]
  },
  weapons: {
    summary: "Choose weapons by target, delivery method, range, arc, and counterplay.",
    howItWorks: "Every weapon combines damage or Heat effect, fire rate, range, firing arc, tracking, Power demand, Heat, and delivery rules. Blasters are direct general-purpose guns. Autocannons trade reach for rapid anti-hull fire. Beams apply sustained pressure and are strong against shields. Rail weapons deliver precise long-range hits through narrow arcs. Missiles, swarms, and torpedoes guide toward targets but can be intercepted or diverted. Fragmentation and scatter weapons distribute damage across an area or pellets. Thermal Induction Lances inject Heat rather than ordinary damage. Proximity and demolition charges demand very close delivery. Exact live values and component-specific exceptions are in Component Reference.",
    importantStats: [
      { label: "Direct Fire", value: "Blasters, Autocannons, Beams, Rails, Plasma, Scatter" },
      { label: "Guided", value: "Missiles, Swarms, Torpedoes" },
      { label: "Area And Multi-Hit", value: "Fragmentation, Scatter, Flak" },
      { label: "Thermal Attack", value: "Thermal Induction Lance" },
      { label: "Close Delivery", value: "Proximity And Demolition Charges" }
    ],
    practicalUse: "Start with one coherent main battery whose ranges and arcs overlap. Add a second family only to solve a real weakness, such as interception, shields, armour, or close attackers. Use Data Links to concentrate accuracy, range, or fire-rate support on the weapons that define the ship.",
    commonProblems: [
      "Headline DPS never appears? The weapon may spend time aiming, cooling, reloading, travelling, or being intercepted.",
      "Mixed battery fires in fragments? Its ranges or arcs do not create one shared firing envelope.",
      "Thermal Lance appears to deal no damage? Its purpose is Heat injection, with shield reduction and Refractory protection applying."
    ],
    related: ["targeting-and-arcs", "combat", "projectile-mechanics", "missile-guidance", "support", "component-reference"]
  },
  "combat-styles": {
    summary: "Charge, Hold, Orbit, Kite, and Static control movement around the current target.",
    howItWorks: "Charge drives to contact and is the natural style for proximity-charge ramming ships. Hold approaches until it has a usable firing solution near 92% of battery reach, then maintains position without backing away from close targets. Orbit continuously flies a ring near 85% of reach and can reverse orbit direction. Kite prefers 90% of main-battery reach, retreats below 78%, and closes above 96%; because ships cannot thrust backward, rear-facing guns keep firing most reliably during retreat. Static never repositions for combat, though it can turn to aim. Auto Engage controls automatic target acquisition. Pursue controls whether a non-explicit target may pull a ship back into range; an explicit attack order remains authoritative.",
    importantStats: [
      { label: "Hold Enter", value: "92% Of Usable Battery Reach" },
      { label: "Hold Resume", value: "105%" },
      { label: "Orbit", value: "85%" },
      { label: "Kite", value: "90% Preferred, 78% Retreat, 96% Close" },
      { label: "Static", value: "No Automatic Repositioning" }
    ],
    practicalUse: "Use Hold as the dependable ranged stance, Orbit for agile ships that can keep arcs aligned, Kite for fast long-range hulls with rear coverage, Charge for contact weapons, and Static when exact ground matters. Change the stance and movement toggles on selected ships during battle.",
    commonProblems: [
      "Hold moves closer than expected? It is seeking the first usable solution, not just numeric range.",
      "Kite turns away and stops firing? Its main weapons lack rear coverage.",
      "Ship does not acquire nearby enemies? Check Auto Engage, detection, and whether any weapon can use the target."
    ]
  },
  defence: {
    summary: "Shield absorption and regeneration, armour behaviours, active interception, and decoys.",
    howItWorks: `Shield capacity sources add together; Power affects regeneration, not maximum Shield Capacity. Regeneration sources add their full authored rates linearly, then delivered Power scales regeneration proportionally before Heat and aura modifiers apply. ${SHIELD_DEPLETION_TEXT} ${SHIELD_RESTART_TEXT} ${SHIELD_COMMAND_RELAY_TEXT} A shield hit blocks 95% of the shield-eligible damage it can absorb; 5% of that blocked hull damage leaks through, and shield overflow also reaches hull. Each ${SHIELD_IMPACT_HEAT_TEXT} of blocked Shield damage generates Heat in the Shield system; 100 blocked damage creates 12 H total, distributed across active Shield generators rather than added independently to each generator. Armour then contributes component durability and family-specific protection: each discrete projectile hit applies flat reduction once, while a continuous beam applies that reduction per second while it remains on the plate. Hot, Critical, and Overheated armour reduce that protection multiplier. Ablative structure offers high raw durability without flat reduction, and Refractory protection resists Heat and blocks Thermal Induction Lance transfer while intact. Point defence, flak, interceptors, and decoys act before guided threats land.`,
    importantStats: [
      { label: "Shield Absorption", value: "95% Of Blocked Damage" },
      { label: "Shield Leakage", value: "5% Of Blocked Hull Damage" },
      { label: "Shield Impact Heat", value: SHIELD_IMPACT_HEAT_TEXT },
      { label: "Impact Heat Distribution", value: "Across active Shield generators; 100 blocked damage = 12 H total" },
      { label: "Shield Regen Stacking", value: "Linear full authored rate per live source" },
      { label: "Shield Restart Delay", value: SHIELD_RESTART_DELAY_TEXT },
      { label: "Shield Restart Rule", value: "Only after complete depletion to 0" },
      { label: "Shield Command Relay", value: `Regen ${SHIELD_COMMAND_RELAY_REGEN_TEXT}; restart delay ${SHIELD_COMMAND_RELAY_DELAY_TEXT}` },
      { label: "Minimum Active Shield", value: "10" },
      { label: "Armour Principle", value: "Flat Reduction Favours Many Small Hits" }
    ],
    practicalUse: "Layer defences around the threats you expect. Shields buy renewable protection but need Power, cooling, and restart time. Remember that only complete depletion pauses regeneration. Flat-reduction armour punishes rapid low-damage fire; raw-durability armour is better against heavy hits. Use more than one interception family when missiles are a strategic threat.",
    commonProblems: [
      "Hull takes damage with shield remaining? Five percent leakage is intentional.",
      "More regeneration adds less than expected? Check live shield health, Power, Heat, and aura state.",
      "Scatter fire performs poorly into armour? Each pellet encounters flat reduction separately.",
      "Shield regeneration paused? The restart delay begins only when Shield reaches exactly 0."
    ],
    related: ["damage-and-destruction", "weapons", "projectile-mechanics", "power", "heat"]
  },
  drones: {
    summary: "Bay configuration, launch state, roles, fuel, recall, refuelling, and replacement production.",
    howItWorks: `A Drone Bay controls one selected squad type and needs one complete exposed two-cell launch edge. Deployed bays launch ready slots after the ship leaves its spawn area; Recall orders active drones home. Fighter squads attack hostile drones, the parent's visible focus target, and other visible enemy ships. Defence squads guard close to the parent, intercept hostile guided projectiles first, then engage hostile drones and ships. Repair squads repair their parent first before scoring damaged allies in command range. Fuel forces surviving drones to return, dock, refuel, and launch again. Destroyed slots enter replacement production. Bay Power changes launch and production pace linearly; any positive Power keeps a living, non-Overheated bay operational and commanding its drones, while 0 Power stops launching and may trigger fallback. Losing the parent leaves drones only ${DRONES.orphanLifetimeSeconds ?? 3}s before removal.`,
    importantStats: [
      { label: "Squad Size", value: droneTypeSummary("squadSize", " drones") },
      { label: "Fuel", value: droneTypeSummary("fuelSeconds", "s") },
      { label: "Replacement Time", value: droneTypeSummary("productionSeconds", "s") },
      { label: "Maximum Bays", value: `${DRONES.maxBaysPerShip ?? 4} Per Ship` },
      { label: "Active Limits", value: `${DRONES.maxActivePerShip ?? 12} Per Ship, ${DRONES.maxActivePerPlayer ?? 48} Per Player` },
      { label: "Refuel", value: `${DRONES.refuelSeconds ?? 2}s` }
    ],
    practicalUse: "Expose the bay edge and leave clearance outside it. Recall before a dangerous retreat so drones refuel instead of becoming stranded. Fighters need allied detection to keep targets valid; Repair drones are most reliable when their parent stays inside the fight but survives long enough to recover.",
    commonProblems: [
      "Ready drones do not launch? Leave the spawn area and check bay Power and launch-edge exposure.",
      "Drones repeatedly return? Fuel, recall state, lost command range, or low bay Power can force fallback.",
      "Destroyed squad does not immediately reappear? Each slot must complete powered replacement production."
    ]
  },
  support: {
    summary: "Direct source-to-weapon bonuses with explicit targets and divided source budgets.",
    howItWorks: "A Data Link is a logical pair between an eligible support source and a weapon. Fire Control supplies fire rate, Signal Amplifiers supply range, and Targeting Computers or Stabilizer Nodes supply accuracy. Each source owns one fixed nominal budget. It is divided evenly across that source's currently valid linked weapons, then scaled by source health, Power, and Heat. Multiple sources feeding one weapon add their contributions. Fire rate multiplies base rate, range is additive, and accuracy is capped below perfect unless the base weapon is already perfect. Links are identified by component index and invalid ones are pruned when a design changes.",
    importantStats: [
      { label: "Source Budget", value: "Divided Evenly Across Its Valid Linked Weapons" },
      { label: "Multiple Sources", value: "Add On The Same Weapon" },
      { label: "Fire Rate", value: "Multiplicative Bonus" },
      { label: "Range", value: "Additive Bonus" },
      { label: "Accuracy", value: "Additive, Normally Capped At 99%" }
    ],
    practicalUse: "In Data Links, click a source and then toggle weapon targets, or drag directly from source to weapon. Concentrate links on a defining battery for maximum per-weapon effect. Auto-link maximises coverage by linking every eligible source to every weapon; it does not choose an optimal allocation. Clear removes all links.",
    commonProblems: [
      "Support is installed but gives no bonus? It needs at least one valid weapon link.",
      "Each weapon receives less after Auto-link? The same fixed source budget is now split across more targets.",
      "A link vanished after editing? Its saved source or target index no longer identifies an eligible component."
    ]
  },
  "sensors-detection": {
    summary: "Visibility modes, shared coverage, sensor stacking, directed cones, and remembered contacts.",
     howItWorks: "Full visibility reveals all entities. Sensor Fog and Full Dark require an enemy ship or drone to be inside allied live coverage before it can be targeted. Every hull supplies the same omnidirectional base. Each live general Sensor adds its full authored bonus linearly. Directed Sensors form a separate coverage family and project forward cones from their component rotation. Cones aimed along the same bearing combine their full bonuses where they overlap, while differently aimed cones cover their own sectors. Allied ships, owned relays, and home stations share coverage. Detection lingers briefly to prevent boundary flicker; after that, an enemy ship becomes a 12-second last-known contact that cannot be targeted.",
     importantStats: [
       { label: "Hull Base", value: `${GENERATED_BALANCE.visibility?.baseSensorRange ?? 460} m for every hull` },
      { label: "Sensor Stacking", value: "Linear full authored bonus per live sensor" },
      { label: "Detection Linger", value: `${GENERATED_BALANCE.visibility?.detectionLingerSeconds ?? 0.25}s` },
      { label: "Remembered Ship Contact", value: `${GENERATED_BALANCE.visibility?.rememberedContactSeconds ?? 12}s` },
      { label: "Station Coverage", value: `Home ${GENERATED_BALANCE.visibility?.homeStationSensorRange ?? 1400} m, Relay ${GENERATED_BALANCE.visibility?.relayStationSensorRange ?? 950} m` }
    ],
    practicalUse: "Use omnidirectional coverage for local certainty and rotated directed cones for long approaches. Spread sensor responsibility so one destroyed scout does not blind every long-range battery. A relay can be an information objective as well as an income objective.",
    commonProblems: [
      "Enemy outline remains but attack is unavailable? It is a remembered contact.",
      "Large directed range misses a nearby flank? The target is outside the cone bearing.",
      "Extra sensor adds less than its card value? Check live component state, Power, and Directed cone overlap."
    ]
  },
  command: {
    summary: "Core succession and allied aura types, range, effectiveness, and stacking rules.",
    howItWorks: `Every ship requires one main Core. If it is destroyed, a live and powered Backup Command Core takes control; an unpowered backup has only a two-second emergency reserve. Under Backup Command, weapon accuracy, turn rate and drone command range all operate at ${BACKUP_EFFECTIVENESS_TEXT}. Command components project allied effects inside the shared 800 m radius and do not affect their source ship. Aura strength scales with component Power and Heat. Among overlapping sources of the same aura type, only the strongest applies, with distance and stable source order breaking ties. Different aura types multiply together because they improve different fleet functions.`,
    importantStats: [
      { label: "Aura Radius", value: `${GENERATED_BALANCE.commandAura?.range ?? 800} m` },
      { label: "Affects Source Ship", value: GENERATED_BALANCE.commandAura?.selfAura ? "Yes" : "No" },
      { label: "Same Aura Type", value: "Strongest Source Only" },
      { label: "Different Aura Types", value: "Multipliers Combine" },
      { label: "Backup Effectiveness", value: `${BACKUP_EFFECTIVENESS_TEXT} for weapon accuracy, turn rate and drone command range` },
      { label: "Unpowered Backup Reserve", value: "2s" }
    ],
    practicalUse: "Build command ships as fleet assets and keep intended recipients inside their circles. Avoid duplicating the same aura type unless redundancy is worth the cost; mix complementary aura types for a combined fleet package. A Backup Core protects an expensive hull but is not full performance.",
    commonProblems: [
      "Two identical auras give no extra bonus? Same-type sources suppress all but the strongest.",
      "Aura does not improve its carrier? Self aura is disabled.",
      "Backup exists but the ship still dies? It was destroyed, unpowered beyond its reserve, or not present when the main Core failed."
    ]
  }
});

const MANUAL_CONTENT_UPDATES_3 = Object.freeze({
  economy: {
    summary: "Active-match income, purchases, relays, bounties, fleet limits, and both victory systems.",
    howItWorks: "Ready players earn base income during an active match, plus income for every relay their team owns. Destroying an enemy ship pays a kill bounty based on its purchase cost, and taking a relay pays a capture bonus to the capturing team. Purchases spend current money and count living ships against the 30-ship cap. Classic mode is won by holding every relay fully controlled and uncontested for 20 seconds. Station mode never awards relay victory: relays remain income, sensor, repair, and strategic objectives, while destroying an enemy home station is the only match win condition.",
    importantStats: [
      { label: "Starting Money", value: `\u00a3${ECON.startingMoney ?? 1000}` },
      { label: "Base Income", value: `\u00a3${ECON.baseIncome ?? 20}/s` },
      { label: "Relay Income", value: `\u00a3${ECON.relayIncome ?? 5}/s Each` },
      { label: "Kill Bounty", value: `${Math.round((ECON.killBountyRatio ?? 0.28) * 100)}% Of Cost, Minimum \u00a3${ECON.killBountyMin ?? 24}` },
      { label: "Capture Bonus", value: `\u00a3${ECON.captureBonus ?? 70}` },
      { label: "Living Ship Cap", value: `${ECON.shipCap ?? 30}` },
      { label: "Classic Victory Hold", value: "20s" }
    ],
    practicalUse: "Treat relay pressure as both economy denial and battlefield positioning. Cheap ships project capture pressure efficiently, while durable fleets protect the income lead. In station mode, use relays to sustain the assault but keep the enemy home station as the strategic end state.",
    commonProblems: [
      "Money is not increasing? Income runs only for Ready players during an active match.",
      "All relays owned but no victory? They must be fully controlled and uncontested for the full Classic countdown.",
      "Relays do not end a station match? Only home-station destruction wins that mode."
    ],
    related: ["ship-pricing", "capture-mechanics", "stations-infrastructure", "movement"]
  },
  "ship-pricing": {
    title: "Purchasing Ships",
    summary: "When purchases are allowed, how quantity works, and what consumes fleet capacity.",
    keywords: ["buy", "purchase", "deploy", "quantity", "money", "fleet cap", "active match", "ready"],
    howItWorks: "Ships are purchased only during an active match by a player who has Readied Up and has a saved blueprint. The server validates the current design, effective thrust, money, and living-ship cap at the moment of purchase. A single request may buy one to five copies. Each copy costs the same authoritative design price and occupies one fleet slot while alive. Destroyed ships free fleet capacity. In station mode, purchases enter the home station's hangar queue and launch as soon as their assigned bay is available rather than appearing instantly.",
    importantStats: [
      { label: "Quantity Per Request", value: "1 To 5" },
      { label: "Living Ship Cap", value: `${ECON.shipCap ?? 30}` },
      { label: "Unit Price", value: "Sum Of Placed Component Costs" },
      { label: "Required Phase", value: "Active" },
      { label: "Required Player State", value: "Ready" }
    ],
    practicalUse: "Buy small batches when hangars are busy. Keep enough money for replacements and check the purchase error before changing a blueprint: phase, readiness, money, cap, and design validity are separate blockers.",
    commonProblems: [
      "Buy button is disabled? Confirm active phase, Ready state, saved blueprint, money, and fleet space.",
      "Station purchase is paid but not visible yet? Its assigned hangar may still be busy.",
      "Need the numeric formula? Open Ship Cost Formula in Building Ships."
    ],
    related: ["ship-cost-formula", "ship-validation", "economy", "stations-infrastructure"]
  },
  "capture-mechanics": {
    summary: "Classic pressure capture and station-mode neutral capture, destruction transfer, and recovery.",
    howItWorks: "In Classic mode, every nearby ship contributes pressure equal to one plus its effective capture bonus. The team or solo player with strictly highest pressure advances the relay; a tie contests it and freezes progress. Empty progress decays. Capture speed is the base rate plus leader pressure times the per-ship rate. After a relay changes ownership, its first progress step is tripled to establish the new owner's foothold. When all relays are fully owned and uncontested, the 20-second victory countdown begins. Station-mode relays use structural state instead: a neutral relay takes 10 uncontested seconds to claim, while reducing an enemy relay to zero hull transfers it immediately to the attacker at 35% hull. A transferred relay recovers without shields and becomes operational after reaching 25% hull. Station relays never trigger victory.",
    importantStats: [
      { label: "Classic Base Rate", value: `${GENERATED_BALANCE.capture?.baseCaptureRate ?? 0.1}/s` },
      { label: "Classic Per Pressure", value: `+${GENERATED_BALANCE.capture?.captureRatePerShip ?? 0.045}/s` },
      { label: "Classic Empty Decay", value: `${GENERATED_BALANCE.capture?.neutralDecayPerSecond ?? 0.08}/s` },
      { label: "Station Neutral Capture", value: `${GENERATED_BALANCE.infrastructure?.relayStation?.captureDurationSeconds ?? 10}s` },
      { label: "Station Transfer Hull", value: `${Math.round((GENERATED_BALANCE.infrastructure?.relayStation?.captureRestoreHpRatio ?? 0.35) * 100)}%` },
      { label: "Station Operational At", value: `${Math.round((GENERATED_BALANCE.infrastructure?.relayStation?.recoveryOperationalHpRatio ?? 0.25) * 100)}% Hull` }
    ],
    practicalUse: "In Classic, bring enough pressure to beat the enemy rather than merely matching it, and protect every relay during the victory hold. In station mode, defend damaged owned relays before they hit zero and escort newly transferred relays through recovery.",
    commonProblems: [
      "Classic progress is frozen? Opposing pressure is tied.",
      "Empty Classic relay loses progress? Unheld partial progress decays.",
      "Station relay changed owner immediately at zero hull? Hostile destruction transfers it; neutral relays use timed capture."
    ],
    related: ["economy", "stations-infrastructure", "movement", "command"]
  },
  multiplayer: {
    summary: "Room setup, four real phases, readiness, reconnects, bots, and rematches.",
    howItWorks: "A room moves through Lobby, Ship Design, Battle, and Ended. In Lobby, the host can edit mode, economy, capacity, map size, asteroid density, infrastructure, and visibility, assign bots, and begin Ship Design. During Ship Design, players may save blueprints and Ready Up independently of blueprint cost or validity. The server starts Battle as soon as every current player is ready; ships are then bought from the purchase bar. Designs may still be saved during Battle. Ended offers rematch and return-to-lobby routes. A disconnected player's identity is temporarily reserved, and Resume uses the saved room and resume credentials to reattach when possible.",
    importantStats: [
      { label: "Phases", value: "Lobby, Ship Design, Battle, Ended" },
      { label: "Battle Start", value: "Every Current Player Ready" },
      { label: "Purchases", value: "After Battle Starts" },
      { label: "Design Saving", value: "Ship Design And Battle" }
    ],
    practicalUse: "Agree on teams and visibility before the host starts design. Ready only when you are comfortable starting the economy clock, but remember you can keep editing and buy a corrected design after Battle begins. Use Resume before creating a replacement identity after a network interruption.",
    commonProblems: [
      "Host cannot change rules? Rule editing is Lobby-only.",
      "Battle does not start? At least one current player is not ready.",
      "Ready player has no ship? Deployment is a separate active-match purchase."
    ]
  },
  controls: {
    summary: "Complete mouse, camera, selection, command, battle, and Designer shortcuts.",
    howItWorks: "Left-click selects; drag creates a selection box and Shift adds to selection. Right-click empty ground moves, Shift-right-click appends a waypoint when exactly one ship is selected, and right-clicking an enemy attacks. Pan with WASD or arrow keys, middle-drag, or Space plus left-drag. The wheel zooms; minimap click centres the camera. Q selects all owned ships, C centres the selection or fleet, F follows, and 0 resets zoom. B stops selected ships, O and I rotate them while held, V toggles component-damage view, and Delete or Backspace requests self-destruction. Escape clears transient selection or closes the active overlay. In the Designer, R rotates, F flips, and Ctrl or Cmd plus Z undoes.",
    importantStats: [
      { label: "Move / Attack", value: "Right-Click Ground / Enemy" },
      { label: "Append Waypoint", value: "Shift + Right-Click, One Ship" },
      { label: "Pan", value: "WASD, Arrows, Middle-Drag, Space + Left-Drag" },
      { label: "Fleet", value: "Q Select All, B Stop, O/I Rotate" },
      { label: "Camera", value: "F Follow, C Centre, 0 Reset Zoom" },
      { label: "Designer", value: "R Rotate, F Flip, Ctrl/Cmd + Z Undo" },
      { label: "Self-Destruct", value: "Delete / Backspace" }
    ],
    practicalUse: "Learn right-click, Q, B, F, and camera drag first. Use one-ship waypoint queues for deliberate obstacle routes and formation leaders. Check focus if a shortcut appears inactive; text and numeric inputs consume typing.",
    commonProblems: [
      "Space-drag does not pan? Hold Space before starting the left drag, or use middle-drag.",
      "Waypoint was not appended? Select exactly one ship and Shift-right-click empty ground.",
      "F flips instead of following? The Designer is open and owns that shortcut."
    ]
  },
  "projectile-mechanics": {
    summary: "Projectile travel, swept collision, shield interaction, overflow, splash, and interception.",
    howItWorks: "Projectile weapons create authoritative moving shots that use swept collision between simulation steps. A shield interaction requires a live shield above its minimum and applies the weapon's shield multiplier. The shield absorbs up to available capacity; 95% of the blocked portion is prevented, 5% of corresponding hull damage leaks through, and any overflow continues to hull. Hull damage then applies its own weapon multiplier and local protection. Splash and pellet weapons can create several protection interactions. Interceptable guided projectiles may be destroyed by point defence, flak, interceptor systems, or Defence drones before impact.",
    practicalUse: "Judge a delivery system by time to impact and counterplay, not card damage alone. Saturate interception with multiple threats, use fast direct shots against agile targets, and remember that shields reduce rather than guarantee zero hull damage.",
    commonProblems: [
      "Hull is damaged through a healthy shield? Five percent leakage is part of shield absorption.",
      "Projectile vanished before impact? An active defence intercepted it or its lifetime ended.",
      "Multi-pellet shot is weak into armour? Each pellet can meet flat reduction separately."
    ]
  },
  "missile-guidance": {
     summary: "Arming, constant projectile speed, lead, tracking, ECM resistance, loss of target, and interception.",
     howItWorks: "Guided weapons travel at their listed Projectile Speed, arm with limited turning, and steer toward a predicted intercept. Effective turning rises strongly with tracking. Electronic-warfare command effects reduce missile tracking up to the configured cap, and agile targets can outrun a weak solution. Guidance still requires a valid target relationship; decoys may redirect suitable missiles, while point defence and other interceptors can destroy them. Torpedoes trade tracking for heavy payload and are most reliable against slow, large, or stationary targets.",
    practicalUse: "Launch from a geometry that gives the missile room to arm and turn. Use higher-tracking families against agile hulls, torpedoes against stations and capitals, and saturation when the target has layered interception.",
    commonProblems: [
      "Missile spirals or misses close targets? It lacked turn room during arming.",
      "Torpedo misses a light ship? Its low tracking is an intentional target tradeoff.",
      "Guided salvo changes target? Decoy and target-validity rules can redirect it."
    ]
  },
  "repair-mechanics": {
    summary: "Repair need, component restoration, range, Power, Heat, and diminishing stacking.",
    howItWorks: `Repair sources restore repairable hull and component damage rather than reviving a destroyed ship. Local Repair modules use diminishing returns: the strongest source contributes 100%, then each additional source contributes ${REPAIR_STACKING_TEXT} as much as the previous one, following ${REPAIR_PROGRESSION_TEXT}. Local modules repair their own ship. Repair beams require a valid allied target in their directional range and are documented separately from the local Repair stack. Repair drones prioritise damage on their parent, then choose damaged allies in command range. Source health, Power, and Heat scale or stop output, and station repair begins only after its combat delay.`,
    practicalUse: "Repair works best on a hull that can survive burst damage and disengage long enough for recovery. Protect repair sources and Power generation, and do not assume headline healing applies while the source is hot or underpowered.",
    commonProblems: [
      "Repair source is active but output is low? Check Power, Heat, component state, aura coverage, and actual repair need.",
      "Repair beam does nothing? Confirm allied target, range, facing, and source state.",
      "Destroyed ship is not restored? Repair fixes surviving ships; it does not resurrect them."
    ]
  },
  "advanced-mechanics": {
    summary: "Exact delivery, guidance, repair, targeting, and damage interactions for optimisation.",
    howItWorks: "Advanced Mechanics explains rules that sit between the headline component stats and the observed result: projectile travel and collision, missile guidance and countermeasures, target validity and firing arcs, component destruction, shield leakage, armour interaction, and delivered repair output. These articles explain stable system behaviour; Component Reference supplies the current numeric part values.",
    practicalUse: "Open this section when a working design behaves differently from its paper DPS, defence, or repair total. Identify whether the gap comes from acquisition, delivery, protection, component state, or recovery, then follow the relevant article.",
    commonProblems: [
      "Paper DPS is higher than combat DPS? Check time on target, arcs, Heat, Power, accuracy, and interception.",
      "Defence total looks healthy but a ship collapses? Inspect leakage, local component loss, and damage-family matchups."
    ],
    related: ["projectile-mechanics", "missile-guidance", "repair-mechanics", "targeting-and-arcs", "damage-and-destruction", "component-reference"]
  },
  "component-reference": {
    summary: "Balance-backed stats, mechanics, limitations, and interactions for every live component.",
    howItWorks: "Component entries are generated from the live part catalogue and the Ledger's explicit mechanics map. They include current cost, mass, durability, footprint, Power, Heat, weapon or support values, per-ship limits, conditional behaviour, and documented interactions. The learning guides explain system-wide rules that should not be repeated inconsistently on every component card.",
    practicalUse: "Choose a system guide first, then compare exact components that perform the job. Check conditional-performance and limitations rows before treating a headline number as continuously available. Use the inspector link to jump straight from a selected Designer component.",
    commonProblems: [
      "A value differs from an old build? Component entries follow the current loaded balance catalogue.",
      "A card lists a strong value but runtime is lower? Check its Power, Heat, health, stack rank, arc, and target conditions."
    ]
  }
});

const AUTOMATIC_COMPONENT_TARGETING_TEXT = "Most weapons automatically choose which component of an enemy ship to aim at. Selection is weighted rather than completely random. Completely random selection would give every valid component equal odds; weighted random selection still rolls between valid components, but some components have better odds than others. Exposed and important active systems are more likely to be targeted, while protected Core components are less likely to be selected while other components remain. This is a preference, not a guarantee: ordinary weapons can still target Structure, weapons, engines, support systems, and other living components. Weapons usually avoid immediately selecting the same component again when they choose a new component. Once a weapon has selected a component, it may continue aiming at that component for a period before choosing again. When it retargets, another weighted selection is made. Specialist weapons may have explicit targeting priorities. The Thermal Induction Lance prioritises functioning Power generators when available, then other active systems, because it is designed to overload critical powered systems rather than choose targets like an ordinary weapon. Point Defence uses separate threat priorities to decide which incoming entity to engage, such as missiles, torpedoes, drones, projectiles, or ships; component targeting rules apply when weapons aim at components inside a ship.";

const EXTRA_MANUAL_ARTICLES = Object.freeze([
  {
    id: "targeting-and-arcs",
    category: "weapons",
    title: "Targeting, Arcs & Firing Solutions",
    summary: "Why a valid enemy may still not be a valid shot.",
    keywords: ["targeting", "arc", "turret", "aim", "line of sight", "range", "detected", "focus fire", "component", "weighted random", "point defence"],
    howItWorks: `Target selection and weapon permission are separate. A ship may hold an explicit or automatic target, but each weapon independently checks team visibility, target type, range, authored firing arc, turret aim, operational state, and any weapon-specific solution. Narrow fixed arcs reward hull facing; wide turrets trade less hull dependence for their own tracking and aim time. Losing live detection invalidates hostile targeting even while a remembered contact remains visible on the map. ${AUTOMATIC_COMPONENT_TARGETING_TEXT} Retained component aims and Heat mechanics remain otherwise unchanged.`,
    practicalUse: "Design one overlapping battery envelope and choose a combat style that keeps it on target. Test front, side, and retreat bearings. Use directed sensors and Data Links only after the geometry already works.",
    commonProblems: [
      "Some guns fire and others do not? Their arcs, ranges, or aim states differ.",
      "Remembered marker cannot be focused? Last-known information is not live targeting permission.",
      "Kiting ship loses its main battery? Rotate the defining weapons toward the retreat bearing."
    ],
    related: ["weapons", "combat", "combat-styles", "sensors-detection", "support", "automatic-component-targeting"]
  },
  {
    id: "automatic-component-targeting",
    category: "weapons",
    title: "Automatic Component Targeting",
    summary: "How ordinary weapons choose components inside an enemy ship.",
    keywords: ["automatic", "component", "targeting", "weighted", "random", "retarget", "point defence", "specialist"],
    howItWorks: AUTOMATIC_COMPONENT_TARGETING_TEXT,
    practicalUse: "Expose important systems when you want them to be attractive targets, but do not rely on an ordinary weapon to select one exact subsystem every time. Use a specialist weapon when its documented priority matches the system you need to pressure.",
    commonProblems: [
      "The weapon chose Structure or another system instead? Ordinary component targeting is weighted, not guaranteed.",
      "The same component stayed under fire? Weapons can retain a component aim for a period before selecting again.",
      "Point Defence ignored a ship component? Point Defence chooses incoming threats, not components inside a ship."
    ],
    related: ["targeting-and-arcs", "weapons", "combat", "defence", "component-reference"]
  },
  {
    id: "damage-and-destruction",
    category: "combat",
    title: "Damage, Components & Ship Destruction",
    summary: "How local component loss degrades a ship before the hull is finally lost.",
    keywords: ["damage", "component damage", "core", "destroyed", "backup core", "hull", "self destruct"],
    howItWorks: "Hits resolve against shields and the impacted ship structure. Component health is authoritative: a destroyed Engine removes thrust, a destroyed weapon stops firing, lost sensors remove their coverage, damaged cooling changes Heat survival, and lost generation changes the shared Power ratio. The ship can remain alive while these systems fail. Destroying the main Core is terminal unless a valid Backup Command Core assumes control. Delete or Backspace sends an explicit self-destruction request for selected owned ships.",
    practicalUse: "Use V and the selected-ship damage panel to distinguish hull survival from functional survival. Protect the Core, generation, propulsion, and cooling with geometry and defence appropriate to the likely incoming direction.",
    commonProblems: [
      "Ship has hull but cannot move or shoot? The required components may be destroyed or offline.",
      "Backup ship is weaker after Core loss? Backup command intentionally applies accuracy, turn, and drone-range penalties.",
      "Self-destruct did not affect an enemy? It applies only to selected owned ships."
    ],
    related: ["combat", "defence", "power", "heat", "command"]
  },
  {
    id: "stations-infrastructure",
    category: "economy-objectives",
    title: "Stations & Infrastructure",
    summary: "Home-station launch queues and repair, relay transfer, recovery, and station-mode victory.",
    keywords: ["station", "home station", "relay station", "hangar", "launch queue", "repair", "recovery", "victory"],
    howItWorks: "With station infrastructure enabled, bought ships enter their team's home-station hangar queue and launch as soon as their assigned bay is available. Home stations repair allied ships in their repair radius after a combat delay and are the sole station-mode victory objective. Relay stations add economy, detection, repair, and forward pressure. Neutral relays use timed capture. Hostile relays transfer when their hull reaches zero, return at partial hull without shields, and remain recovering until the operational threshold. Home-station durability scales with the active opposing roster so team size is reflected in the objective.",
    importantStats: [
      { label: "Home Repair Radius", value: `${GENERATED_BALANCE.infrastructure?.homeStation?.repairRadius ?? 520} m` },
      { label: "Home Repair Delay", value: `${GENERATED_BALANCE.infrastructure?.homeStation?.repairDelaySeconds ?? 6}s` },
      { label: "Relay Capture Radius", value: `${GENERATED_BALANCE.infrastructure?.relayStation?.captureRadius ?? 280} m` },
      { label: "Neutral Relay Capture", value: `${GENERATED_BALANCE.infrastructure?.relayStation?.captureDurationSeconds ?? 10}s` },
      { label: "Transferred Relay Hull", value: `${Math.round((GENERATED_BALANCE.infrastructure?.relayStation?.captureRestoreHpRatio ?? 0.35) * 100)}%` },
      { label: "Recovery Threshold", value: `${Math.round((GENERATED_BALANCE.infrastructure?.relayStation?.recoveryOperationalHpRatio ?? 0.25) * 100)}%` }
    ],
    practicalUse: "Keep home-station launch approaches clear, retreat damaged ships into its repair area, and deny attackers sustained time on the objective. Treat a transferred relay as vulnerable until recovery completes.",
    commonProblems: [
      "Purchased ship waits at the station? Its assigned hangar is still occupied by another launch.",
      "Home station does not repair immediately? Recent combat enforces the repair delay.",
      "Relay has no shield after transfer? Recovery deliberately starts at partial hull without shields."
    ],
    related: ["economy", "capture-mechanics", "ship-pricing", "repair-mechanics", "sensors-detection"]
  }
]);

const MANUAL_ARTICLE_UPDATES = Object.freeze({
  ...MANUAL_CONTENT_UPDATES,
  ...MANUAL_CONTENT_UPDATES_2,
  ...MANUAL_CONTENT_UPDATES_3
});

function currentManualArticle(article) {
  const update = MANUAL_ARTICLE_UPDATES[article.id];
  return update ? { ...article, ...update } : article;
}

// ---------------------------------------------------------------------------
// Data-driven component article generation
// ---------------------------------------------------------------------------

function categoryForPart() {
  return "component-reference";
}

function titleCase(str) {
  return str.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()).trim();
}

function statLabel(key) {
  const labels = {
    cost: "Cost",
    mass: "Mass",
    hull: "Hull HP",
    shield: "Shield HP",
    shieldRegen: "Shield Regen",
    thrust: "Thrust",
    turn: "Turn Rate",
    powerGeneration: "Power Generation",
    powerUse: "Power Use",
    energy: "Energy",
    repair: "Repair",
    damage: "Damage",
    fireRate: "Fire Rate",
    range: "Range",
    projectileSpeed: "Projectile Speed",
    tracking: "Tracking",
    splashRadius: "Splash Radius",
    maxPerShip: "Max Per Ship"
  };
  return labels[key] || titleCase(key);
}

function formatStat(key, value) {
  if (value == null || value === 0) return null;
  switch (key) {
    case "mass": return formatMass(value);
    case "hull": return formatHull(value);
    case "shield": return formatShield(value);
    case "thrust": return formatThrust(value);
    case "energy": return formatEnergy(value);
    case "repair": return formatRepair(value);
    case "range": return formatDistance(value);
    case "projectileSpeed": return formatSpeed(value);
    case "damage": return formatDamage(value);
    case "powerGeneration": return `+${value} MW`;
    case "powerUse": return `${value} MW`;
    case "cost": return `\u00a3${value}`;
    case "fireRate": return `${value}/s`;
    case "tracking": return formatPercent(value);
    default: return String(value);
  }
}

function relatedForPart(partId) {
  const stats = PART_STATS[partId] || {};
  const raw = partCategory(partId);
  const related = ["component-reference"];
  if (partId === "droneBay") related.push("drones", "weapons", "defence", "repair-mechanics");
  else if ((Number(stats.sensorRangeBonus) || 0) > 0) related.push("sensors-detection", "combat", "command");
  else if (["fireControl", "signalAmplifier", "targetingComputer", "stabilizerNode"].includes(partId)) related.push("support", "weapons", "heat");
  else if (raw === "Weapons") related.push("weapons", "combat", "heat", "projectile-mechanics", "missile-guidance");
  else if (raw === "Defence") related.push("defence", "weapons", "projectile-mechanics");
  else if (raw === "Support") related.push("support", "defence", "command", "repair-mechanics");
  else if (raw === "Command") related.push("command", "combat", "defence");
  else if (raw === "Engines") related.push("movement", "combat-styles", "power");
  else if (raw === "Power") related.push("power", "heat", "blueprint-designer");
  else if (raw === "Heat Components") related.push("heat", "power");
  else related.push("blueprint-designer", "power", "heat");
  return [...new Set(related.filter((r) => r !== partId))];
}

function generateComponentArticle(partId) {
  const stats = PART_STATS[partId];
  const def = PART_DEFS[partId];
  if (!stats || !def) return null;

  const cat = categoryForPart(partId);
  const name = def.name || partId;
  const desc = partDescription(partId, stats) || stats.description || "";

  const importantStats = [];
  for (const key of ["cost", "mass", "hull", "shield", "shieldRegen", "thrust", "turn", "powerGeneration", "powerUse", "energy", "repair", "damage", "fireRate", "range", "projectileSpeed", "tracking", "splashRadius", "maxPerShip"]) {
    const formatted = formatStat(key, stats[key]);
    if (formatted) importantStats.push({ label: statLabel(key), value: formatted });
  }

  importantStats.push({ label: "Heat effects", value: componentHeatInspection(partId, stats) });

  // Footprint
  if (stats.footprint) {
    importantStats.push({ label: "Footprint", value: `${stats.footprint.width}×${stats.footprint.height}` });
  }

  // Armor reduction
  if (stats.armorFlatReduction) {
    importantStats.push({ label: "Armor Reduction", value: `${stats.armorFlatReduction} Flat` });
  }

  // Rotatable
  if (stats.rotatable) {
    importantStats.push({ label: "Rotatable", value: "Yes" });
  }

  // Shape type
  if (stats.shapeType) {
    importantStats.push({ label: "Shape", value: titleCase(stats.shapeType) });
  }

  // Stat scale
  if (stats.statScale) {
    importantStats.push({ label: "Stat Scale", value: formatPercent(stats.statScale) });
  }

  // Weapon details
  const w = stats.weapon;
  if (w) {
    const presentation = WeaponPresentationRules.weaponCyclePresentation(w);
    if (w.family) importantStats.push({ label: "Weapon Family", value: titleCase(w.family) });
    if (w.damage) importantStats.push({ label: "Damage", value: formatDamage(w.damage) });
    if (presentation.isChargeWeapon) {
      importantStats.push({ label: "Charge", value: `${presentation.chargeSeconds.toFixed(1)} s` });
      importantStats.push({ label: "Reload", value: `${presentation.reloadSeconds.toFixed(1)} s` });
      importantStats.push({ label: "Ideal Cycle DPS", value: presentation.dps.toFixed(1) });
    } else if (w.fireRate) {
      importantStats.push({ label: "Fire Rate", value: `${w.fireRate}/s` });
    }
    if (w.range) importantStats.push({ label: "Range", value: formatDistance(w.range) });
    if (w.projectileSpeed != null) importantStats.push({ label: "Projectile Speed", value: w.projectileSpeed === 0 ? "Hitscan / Beam" : formatSpeed(w.projectileSpeed) });
    if (w.accuracy != null) importantStats.push({ label: "Accuracy", value: formatPercent(w.accuracy) });
    if (w.tracking != null && w.tracking !== 0) importantStats.push({ label: "Tracking", value: formatPercent(w.tracking) });
    if (w.arc) importantStats.push({ label: "Firing Arc", value: `${w.arc}°` });
    if (w.shieldDamageMultiplier != null) importantStats.push({ label: "Shield Damage Multiplier", value: `${w.shieldDamageMultiplier}×` });
    if (w.hullDamageMultiplier != null) importantStats.push({ label: "Hull Damage Multiplier", value: `${w.hullDamageMultiplier}×` });
    if (w.aimSpeed) importantStats.push({ label: "Aim Speed", value: `${w.aimSpeed} rad/s` });
    if (w.radius) importantStats.push({ label: "Beam Radius", value: formatDistance(w.radius) });
    if (w.chargeRampSeconds) importantStats.push({ label: "Charge Ramp", value: `${w.chargeRampSeconds}s` });
    if (w.maxChargeDamageBonus) importantStats.push({ label: "Max Charge Bonus", value: formatPercent(w.maxChargeDamageBonus) });
    if (w.burnThroughCarryMultiplier) importantStats.push({ label: "Burn-Through Carry", value: `${w.burnThroughCarryMultiplier}×` });
    if (w.impactHeatPerDamage) importantStats.push({ label: "Impact Heat Per Damage", value: `${w.impactHeatPerDamage}` });
    if (w.missileHp) importantStats.push({ label: "Missile HP", value: `${w.missileHp}` });
    if (w.trackTime) importantStats.push({ label: "Track Duration", value: `${w.trackTime}s` });
    if (w.trackingDelay) importantStats.push({ label: "Tracking Delay", value: `${w.trackingDelay}s` });
    if (w.antiMissile) importantStats.push({ label: "Anti-Missile", value: "Yes" });
    if (w.shipDamageMultiplier != null) importantStats.push({ label: "Ship Damage Multiplier", value: `${w.shipDamageMultiplier}×` });
    if (w.blastDamage) importantStats.push({ label: "Blast Damage", value: formatDamage(w.blastDamage) });
    if (w.blastRadius) importantStats.push({ label: "Blast Radius", value: formatDistance(w.blastRadius) });
    if (w.proximityFuseRadius) importantStats.push({ label: "Proximity Fuse Radius", value: formatDistance(w.proximityFuseRadius) });
    if (w.innerFullDamageRadius) importantStats.push({ label: "Full Damage Radius", value: formatDistance(w.innerFullDamageRadius) });
    if (w.falloffExponent) importantStats.push({ label: "Blast Falloff Exponent", value: `${w.falloffExponent}` });
    if (w.directImpactBonus != null) importantStats.push({ label: "Direct Impact Bonus", value: `${w.directImpactBonus}` });
    if (w.targetPriority && w.targetPriority.length) {
      importantStats.push({ label: "Target Priority", value: w.targetPriority.map((t) => titleCase(t)).join(" → ") });
    }
    if (presentation.isChargeWeapon && w.spinalCharge?.chargeHoldSeconds != null) {
      importantStats.push({ label: "Charge Retention", value: `${Number(w.spinalCharge.chargeHoldSeconds).toFixed(1)} s` });
    }
    if (presentation.isChargeWeapon && Array.isArray(w.spinalCharge?.penetrationProfile)) {
      importantStats.push({ label: "Penetration", value: w.spinalCharge.penetrationProfile.map((share) => `${Math.round(Number(share) * 100)}%`).join(" → ") });
    }
  }

  // Aura details
  const aura = stats.aura;
  if (aura) {
    if (aura.type) importantStats.push({ label: "Aura Type", value: titleCase(aura.type) });
    if (aura.weaponAccuracyMultiplier) importantStats.push({ label: "Accuracy Aura", value: `${aura.weaponAccuracyMultiplier}×` });
    if (aura.weaponTrackingMultiplier) importantStats.push({ label: "Tracking Aura", value: `${aura.weaponTrackingMultiplier}×` });
    if (aura.turretAimSpeedMultiplier) importantStats.push({ label: "Aim Speed Aura", value: `${aura.turretAimSpeedMultiplier}×` });
    if (aura.pointDefenceTrackingMultiplier) importantStats.push({ label: "Point Defence Tracking Aura", value: `${aura.pointDefenceTrackingMultiplier}×` });
    if (aura.flakTrackingMultiplier) importantStats.push({ label: "Flak Tracking Aura", value: `${aura.flakTrackingMultiplier}×` });
    if (aura.shieldRegenMultiplier) importantStats.push({ label: "Shield Regeneration", value: signedAuraPercent(aura.shieldRegenMultiplier) });
    if (aura.shieldRestartDelayMultiplier) {
      importantStats.push({ label: "Shield Restart Delay", value: shorterAuraPercent(aura.shieldRestartDelayMultiplier) });
      importantStats.push({ label: "Fully Effective Restart Delay", value: `${(ShieldRules.getShieldRestartDelayMs(aura.shieldRestartDelayMultiplier) / 1000).toFixed(1)} seconds` });
    }
    if (aura.repairRateMultiplier) importantStats.push({ label: "Repair Aura", value: `${aura.repairRateMultiplier}×` });
    if (aura.heatDissipationMultiplier) importantStats.push({ label: "Heat Dissipation Aura", value: `${aura.heatDissipationMultiplier}×` });
    if (aura.overheatRecoveryMultiplier) importantStats.push({ label: "Overheat Recovery Aura", value: `${aura.overheatRecoveryMultiplier}×` });
    if (aura.accelerationMultiplier) importantStats.push({ label: "Acceleration Aura", value: `${aura.accelerationMultiplier}×` });
    if (aura.turnRateMultiplier) importantStats.push({ label: "Turn Rate Aura", value: `${aura.turnRateMultiplier}×` });
    if (aura.sensorRangeMultiplier) importantStats.push({ label: "Sensor Range Aura", value: `${aura.sensorRangeMultiplier}×` });
    if (aura.missileTrackingResistanceMultiplier) importantStats.push({ label: "Missile Tracking Resistance Aura", value: `${aura.missileTrackingResistanceMultiplier}×` });
    if (aura.componentAimRetentionMultiplier) importantStats.push({ label: "Aim Retention Aura", value: `${aura.componentAimRetentionMultiplier}×` });
  }

  // Battery / Capacitor details
  if (stats.energyCapacity) importantStats.push({ label: "Energy Capacity", value: formatEnergy(stats.energyCapacity) });
  if (stats.maxChargeRate) importantStats.push({ label: "Max Charge Rate", value: `${stats.maxChargeRate} MW` });
  if (stats.maxDischargeRate) importantStats.push({ label: "Max Discharge Rate", value: `${stats.maxDischargeRate} MW` });
  if (stats.chargeEfficiency) importantStats.push({ label: "Charge Efficiency", value: formatPercent(stats.chargeEfficiency) });
  if (stats.dischargeEfficiency) importantStats.push({ label: "Discharge Efficiency", value: formatPercent(stats.dischargeEfficiency) });
  if (stats.dischargeHeatAtMax) importantStats.push({ label: "Discharge Heat At Max", value: `${stats.dischargeHeatAtMax}` });

  // Reactor meltdown
  if (stats.meltdownDamage) importantStats.push({ label: "Meltdown Damage", value: formatDamage(stats.meltdownDamage) });
  if (stats.meltdownRadius) importantStats.push({ label: "Meltdown Radius", value: formatDistance(stats.meltdownRadius) });

  // Decoy details
  const decoy = stats.decoy;
  if (decoy) {
    if (decoy.capacity) importantStats.push({ label: "Decoy Capacity", value: `${decoy.capacity}` });
    if (decoy.initialStock != null) importantStats.push({ label: "Initial Stock", value: `${decoy.initialStock}` });
    if (decoy.productionSeconds) importantStats.push({ label: "Production Time", value: `${decoy.productionSeconds}s` });
    if (decoy.launchCooldownSeconds) importantStats.push({ label: "Launch Cooldown", value: `${decoy.launchCooldownSeconds}s` });
    if (decoy.lifetimeSeconds) importantStats.push({ label: "Decoy Lifetime", value: `${decoy.lifetimeSeconds}s` });
    if (decoy.triggerRange) importantStats.push({ label: "Trigger Range", value: formatDistance(decoy.triggerRange) });
    if (decoy.attractionRange) importantStats.push({ label: "Attraction Range", value: formatDistance(decoy.attractionRange) });
    if (decoy.attractionChance) importantStats.push({ label: "Attraction Chance", value: formatPercent(decoy.attractionChance) });
    if (decoy.driftSpeed) importantStats.push({ label: "Drift Speed", value: formatSpeed(decoy.driftSpeed) });
    if (decoy.collisionRadius) importantStats.push({ label: "Collision Radius", value: formatDistance(decoy.collisionRadius) });
  }

  // Proximity charge details
  const prox = stats.proximityCharge;
  if (prox) {
    if (prox.triggerRadius) importantStats.push({ label: "Trigger Radius", value: formatDistance(prox.triggerRadius) });
    if (prox.triggerConfirmationSeconds) importantStats.push({ label: "Trigger Confirmation", value: `${prox.triggerConfirmationSeconds}s` });
    if (prox.blastRadius) importantStats.push({ label: "Blast Radius", value: formatDistance(prox.blastRadius) });
    if (prox.centreDamage) importantStats.push({ label: "Centre Damage", value: formatDamage(prox.centreDamage) });
    if (prox.falloffExponent) importantStats.push({ label: "Blast Falloff", value: `${prox.falloffExponent}` });
    if (prox.maxAffectedComponents === null) importantStats.push({ label: "Max Affected Components", value: "Unlimited" });
    else if (prox.maxAffectedComponents) importantStats.push({ label: "Max Affected Components", value: `${prox.maxAffectedComponents}` });
    importantStats.push({ label: "Damages Friendly Ships", value: prox.damagesFriendlyShips === false ? "No" : "Yes" });
    if (prox.internalDamageReduction) importantStats.push({ label: "Internal Damage Reduction", value: formatPercent(prox.internalDamageReduction) });
  }

  // Maneuver thruster
  if (stats.allowedRotations) importantStats.push({ label: "Allowed Rotations", value: `${stats.allowedRotations.join("°, ")}°` });

  // Utility type
  if (stats.utility) importantStats.push({ label: "Utility Type", value: titleCase(stats.utility) });
  if (stats.fireRateBonus) importantStats.push({ label: "Fire Rate Bonus", value: formatPercent(stats.fireRateBonus) });
  if (stats.accuracyBonus) importantStats.push({ label: "Accuracy Bonus", value: formatPercent(stats.accuracyBonus) });
  if (stats.rangeBonus) importantStats.push({ label: "Range Bonus", value: formatDistance(stats.rangeBonus) });

  // Drone bay drone config reference
  if (partId === "droneBay") {
    const droneConfig = stats.droneConfig || DRONES;
    if (droneConfig.squadSize) importantStats.push({ label: "Squad Size", value: `${droneConfig.squadSize}` });
    if (droneConfig.maxBaysPerShip) importantStats.push({ label: "Max Bays Per Ship", value: `${droneConfig.maxBaysPerShip}` });
    if (droneConfig.maxActivePerShip) importantStats.push({ label: "Max Active Per Ship", value: `${droneConfig.maxActivePerShip}` });
    if (droneConfig.fuelSeconds) importantStats.push({ label: "Fuel Duration", value: `${droneConfig.fuelSeconds}s` });
    if (droneConfig.refuelSeconds) importantStats.push({ label: "Refuel Time", value: `${droneConfig.refuelSeconds}s` });
    if (droneConfig.launchIntervalSeconds) importantStats.push({ label: "Launch Interval", value: `${droneConfig.launchIntervalSeconds}s` });
    if (droneConfig.launchDurationSeconds) importantStats.push({ label: "Launch Duration", value: `${droneConfig.launchDurationSeconds}s` });
    if (droneConfig.standbyPowerMw) importantStats.push({ label: "Standby Power", value: `${droneConfig.standbyPowerMw} MW` });
    if (droneConfig.activePowerMw) importantStats.push({ label: "Active Power", value: `${droneConfig.activePowerMw} MW` });
    if (droneConfig.productionPowerMw) importantStats.push({ label: "Production Power", value: `${droneConfig.productionPowerMw} MW` });

    // Drone type details
    const types = droneConfig.types || {};
    for (const [typeId, typeData] of Object.entries(types)) {
      importantStats.push({ label: `${typeData.label || typeId} : Hull`, value: `${typeData.hull} HP` });
      importantStats.push({ label: `${typeData.label || typeId} : Speed`, value: formatSpeed(typeData.speed) });
      if (typeData.damage) importantStats.push({ label: `${typeData.label || typeId} : Damage`, value: formatDamage(typeData.damage) });
      if (typeData.fireRate) importantStats.push({ label: `${typeData.label || typeId} : Fire Rate`, value: `${typeData.fireRate}/s` });
      if (typeData.repairPerSecond) importantStats.push({ label: `${typeData.label || typeId} : Repair`, value: `${typeData.repairPerSecond} HP/s` });
      if (typeData.commandRange) importantStats.push({ label: `${typeData.label || typeId} : Command Range`, value: formatDistance(typeData.commandRange) });
      if (typeData.squadSize) importantStats.push({ label: `${typeData.label || typeId} : Squad Size`, value: `${typeData.squadSize}` });
      if (typeData.fuelSeconds) importantStats.push({ label: `${typeData.label || typeId} : Fuel`, value: `${typeData.fuelSeconds}s` });
      if (typeData.productionSeconds) importantStats.push({ label: `${typeData.label || typeId} : Rebuild Time`, value: `${typeData.productionSeconds}s` });
    }
  }

  // Power category
  if (stats.powerCategory) importantStats.push({ label: "Power Category", value: titleCase(stats.powerCategory) });

  const keywords = [name.toLowerCase(), partId.toLowerCase(), cat];
  if (def.category) keywords.push(def.category.toLowerCase());
  if (w) keywords.push(w.family, "weapon");
  if (aura) keywords.push("aura", aura.type);
  if (stats.utility) keywords.push(stats.utility);

  // Build practical use and common problems based on category
  let practicalUse = "";
  let commonProblems = [];

  if (w) {
    const presentation = WeaponPresentationRules.weaponCyclePresentation(w);
    practicalUse = presentation.isChargeWeapon
      ? `Damage per shot: ${formatDamage(presentation.damagePerShot)}. Charge: ${presentation.chargeSeconds.toFixed(1)} s. Reload: ${presentation.reloadSeconds.toFixed(1)} s. Ideal cycle DPS: ${presentation.dps.toFixed(1)}. `
      : `Theoretical DPS: ${presentation.dps.toFixed(1)}. `;
    if (w.family === "missile") practicalUse += "Vulnerable to point defence : overwhelm with numbers or mix with other weapons. ";
    if (w.family === "railgun") practicalUse += "Best at long range against slow or stationary targets. Narrow arc requires careful positioning. ";
    if (w.family === "beam") practicalUse += "Sustained shield-breaking : ramps up damage over 15s. Keep the beam on target. ";
    if (w.family === "blaster") practicalUse += "General-purpose weapon with good accuracy and moderate range. ";
    if (w.family === "pointDefense" || w.family === "flak") practicalUse += "Anti-missile and anti-drone defence; low base damage makes it weak against ships. ";
    commonProblems.push("Not firing? Check the weapon's power state and whether it is alive and enabled.");
    if (w.arc < 90) commonProblems.push("Narrow firing arc : position the ship to face the target.");
    if (w.tracking > 0) commonProblems.push("Missiles can be intercepted by enemy point defence.");
  }

  if (aura) {
    practicalUse += `Projects a ${aura.type} command aura affecting friendly ships within ${GENERATED_BALANCE.commandAura?.range ?? 800} m. `;
    commonProblems.push("Aura does not affect the ship itself : coordinate with fleet members.");
  }

  if (stats.armorFlatReduction) {
    practicalUse += `Reduces incoming damage by ${stats.armorFlatReduction} flat per hit. `;
  }

  if (stats.meltdownDamage) {
    commonProblems.push("Reactor will melt down if overheated : ensure adequate cooling.");
  }

  // Merge structured mechanics from the registry
  const mechanics = getMechanics(partId);
  const conditionalPerformance = mechanics?.conditionalPerformance || null;
  const requirementsLimitations = mechanics?.requirements || null;
  const specialMechanics = mechanics?.specialMechanics || null;
  const interactions = mechanics?.interactions || null;

  // Add mechanics text to keywords for search
  if (mechanics) {
    const mechText = getMechanicsSearchText(partId);
    if (mechText) keywords.push(mechText);
  }

  return {
    id: `component:${partId}`,
    category: cat,
    title: name,
    summary: desc,
    keywords,
    howItWorks: desc,
    importantStats,
    conditionalPerformance,
    requirementsLimitations,
    specialMechanics,
    interactions,
    practicalUse: practicalUse || "See the category overview article for general guidance.",
    commonProblems: commonProblems.length ? commonProblems : ["See the category overview article for common issues."],
    related: relatedForPart(partId),
    isComponent: true,
    partId
  };
}

function generateAllComponentArticles() {
  const articles = [];
  for (const partId of Object.keys(PART_STATS)) {
    const article = generateComponentArticle(partId);
    if (article) articles.push(article);
  }
  return articles;
}

// ---------------------------------------------------------------------------
// Combined article catalogue
// ---------------------------------------------------------------------------

export function getAllArticles() {
  return [
    ...MANUAL_ARTICLES_PART_1.map(currentManualArticle),
    ...MANUAL_ARTICLES_PART_2.map(currentManualArticle),
    ...MANUAL_ARTICLES_PART_3.map(currentManualArticle),
    ...EXTRA_MANUAL_ARTICLES,
    ...generateAllComponentArticles()
  ];
}

export function getArticleById(id) {
  return getAllArticles().find((a) => a.id === id) || null;
}

export function getArticlesByCategory(categoryId) {
  const landingId = CATEGORY_LANDING_ARTICLES[categoryId];
  const articles = getAllArticles().filter((a) => a.category === categoryId);
  if (!landingId) return articles;
  return articles.sort((a, b) => {
    if (a.id === landingId) return -1;
    if (b.id === landingId) return 1;
    if (categoryId === "component-reference") return a.title.localeCompare(b.title);
    return 0;
  });
}

export function getRelatedArticles(article) {
  if (!article || !article.related) return [];
  return article.related
    .map((id) => getArticleById(id))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Search index
// ---------------------------------------------------------------------------

export function searchArticles(query) {
  if (!query || !query.trim()) return [];
  const q = query.toLowerCase().trim();
  const terms = q.split(/\s+/);
  const articles = getAllArticles();
  const scored = [];

  for (const article of articles) {
    const haystack = [
      article.title,
      article.summary,
      article.category,
      ...(article.keywords || []),
      article.howItWorks,
      article.practicalUse,
      ...(article.commonProblems || []),
      ...((article.importantStats || []).flatMap((stat) => [stat.label, stat.value].filter(Boolean))),
      // Index mechanics sections for search
      ...((article.specialMechanics || []).flatMap((m) => [m.label, m.value, m.detail, m.condition].filter(Boolean))),
      ...((article.requirementsLimitations || []).flatMap((m) => [m.label, m.value, m.detail].filter(Boolean))),
      ...((article.interactions || []).flatMap((m) => [m.label, m.value, m.detail].filter(Boolean))),
      ...((article.conditionalPerformance || []).flatMap((m) => [m.label, m.value, m.detail].filter(Boolean)))
    ].join(" ").toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (article.title.toLowerCase().includes(term)) score += 10;
      if (haystack.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ article, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.article);
}

// ---------------------------------------------------------------------------
// Validation helpers (used by tests)
// ---------------------------------------------------------------------------

export function validateArticles() {
  const errors = [];
  const articles = getAllArticles();
  const ids = new Set();
  const categoryIds = new Set(CATEGORIES.map((c) => c.id));

  for (const article of articles) {
    if (!article.id) errors.push(`Article missing id: ${article.title}`);
    if (ids.has(article.id)) errors.push(`Duplicate article id: ${article.id}`);
    ids.add(article.id);
    if (!article.title) errors.push(`Article missing title: ${article.id}`);
    if (!article.category) errors.push(`Article missing category: ${article.id}`);
    if (!categoryIds.has(article.category)) errors.push(`Article ${article.id} has unknown category: ${article.category}`);
    if (article.related) {
      for (const ref of article.related) {
        if (!ids.has(ref) && !getAllArticles().some((a) => a.id === ref)) {
          errors.push(`Article ${article.id} references unknown article: ${ref}`);
        }
      }
    }
  }

  return errors;
}
