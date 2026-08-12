// Fleet Ledger content module: owns the article catalogue, categories, manual
// prose, and data-driven article generation from authoritative balance sources.
// Pure data + pure functions : no DOM, no side effects, unit-testable.

import { PART_STATS } from "../../design/parts.js";
import { GENERATED_BALANCE } from "../../generatedBalance.js";
import { formatMass, formatHull, formatShield, formatThrust, formatEnergy, formatRepair, formatDistance, formatSpeed, formatDamage, formatPercent } from "../../design/statFormatting.js";
import { BRAKE_ACCEL_RATIO, MOVEMENT_CONFIG } from "../../shared/movementStats.js";
import "../../shared/heatRules.js";
import { formatHeatEffect, formatHeatEffectValue, getHeatEffectsForComponent } from "../../shared/heatEffects.js";
import "../../shared/weaponPresentationRules.js";
import "../../shared/backupCoreRules.js";
import "../../shared/shieldRules.js";
import "../../shared/repairRules.js";
import { droneProjectileEvasionDetail } from "../componentMechanics.js";

const HeatRules = globalThis.HeatRules;
const WeaponPresentationRules = globalThis.WeaponPresentationRules;
const BackupCoreRules = globalThis.BackupCoreRules;
const ShieldRules = globalThis.ShieldRules;
const RepairRules = globalThis.RepairRules;
const BACKUP_EFFECTIVENESS_TEXT = formatPercent(BackupCoreRules.ACTIVE_SYSTEM_EFFECTIVENESS);
const SHIELD_IMPACT_HEAT_TEXT = `${ShieldRules.getShieldImpactHeatPerDamage().toFixed(2)} H / damage blocked`;
const SHIELD_RESTART_DELAY_SECONDS = (Number(ShieldRules.SHIELD_RESTART_DELAY_MS) || 0) / 1000;
const SHIELD_RESTART_DELAY_TEXT = `${SHIELD_RESTART_DELAY_SECONDS.toFixed(1)} seconds`;
const SHIELD_ABSORPTION_TEXT = formatPercent(ShieldRules.SHIELD_ABSORPTION_FRACTION);
const SHIELD_LEAK_TEXT = formatPercent(ShieldRules.SHIELD_LEAK_FRACTION);
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

const AUTOMATIC_COMPONENT_TARGETING_TEXT = "Most weapons automatically choose which component of an enemy ship to aim at. Selection is weighted rather than completely random. Completely random selection would give every valid component equal odds; weighted random selection still rolls between valid components, but some components have better odds than others. Exposed and important active systems are more likely to be targeted, while protected Core components are less likely to be selected while other components remain. This is a preference, not a guarantee: ordinary weapons can still target Structure, weapons, engines, support systems, and other living components. Weapons usually avoid immediately selecting the same component again when they choose a new component. Once a weapon has selected a component, it may continue aiming at that component for a period before choosing again. When it retargets, another weighted selection is made. Specialist weapons may have explicit targeting priorities. The Thermal Induction Lance prioritises functioning Power generators when available, then other active systems, because it is designed to overload critical powered systems rather than choose targets like an ordinary weapon. Point Defence uses separate threat priorities to decide which incoming entity to engage, such as missiles, torpedoes, drones, projectiles, or ships; component targeting rules apply when weapons aim at components inside a ship.";

export {
  AUTOMATIC_COMPONENT_TARGETING_TEXT,
  BACKUP_EFFECTIVENESS_TEXT,
  BRAKE_ACCEL_RATIO,
  CAPTURE,
  DRONES,
  ECON,
  GENERATED_BALANCE,
  HEAT_MANUAL_CONTENT,
  MOVEMENT,
  PART_STATS,
  REPAIR_PROGRESSION_TEXT,
  REPAIR_STACKING_TEXT,
  SHIELD_ABSORPTION_TEXT,
  SHIELD_COMMAND_RELAY_DELAY_TEXT,
  SHIELD_COMMAND_RELAY_REGEN_TEXT,
  SHIELD_COMMAND_RELAY_TEXT,
  SHIELD_DEPLETION_TEXT,
  SHIELD_IMPACT_HEAT_TEXT,
  SHIELD_LEAK_TEXT,
  SHIELD_RESTART_DELAY_TEXT,
  SHIELD_RESTART_TEXT,
  componentHeatInspection,
  droneProjectileEvasionDetail,
  droneTypeSummary,
  shorterAuraPercent,
  signedAuraPercent
};
