// Data-driven presentation model for the Blueprint "Selected Component" inspector.
//
// This module owns the *information architecture* of the inspector: which facts a
// component shows, in what order, and under which heading. It renders no markup :
// partInspectorUi.js turns the model into DOM : so the whole hierarchy stays
// unit-testable without a browser.
//
// Two rules are enforced centrally rather than per component:
//
//   1. Every fact carries a canonical stat id. A StatLedger records which ids have
//      already been emitted, so the same statistic can never appear twice (for
//      example DPS in both Primary capability and Weapon details).
//   2. Meaningless values : zero bonuses, 100% "modifiers", None/Not applicable,
//      empty strings : are dropped at construction time instead of being rendered
//      as noise.
//
// All numbers come from the authoritative component catalogue (PART_STATS, itself
// built from component-balance.json) and the shared rules modules. No balance
// constant is restated here.

import { formatMass, formatHull, formatShield, formatThrust, formatEnergy, formatRepair, formatDistance, formatSpeed, formatDamage, formatPercent } from "./statFormatting.js";
import { GENERATED_BALANCE } from "../generatedBalance.js";
import { sortComponentCallouts } from "./statusCalloutOrder.js";
import { formatHeatEffect, getHeatEffectsForComponent } from "../shared/heatEffects.js";
import { getShieldImpactHeatPerDamage } from "../shared/shieldRules.js";
import { getRepairStackingMultiplier, stackingProgression, isLocalRepairSource } from "../shared/repairRules.js";
import "../shared/weaponPresentationRules.js";
import "../shared/backupCoreRules.js";

const WeaponPresentationRules = globalThis.WeaponPresentationRules;
const BackupCoreRules = globalThis.BackupCoreRules;
const BACKUP_EFFECTIVENESS_TEXT = `${Math.round(BackupCoreRules.ACTIVE_SYSTEM_EFFECTIVENESS * 100)}%`;
const ACCURACY_HINT = "Accuracy controls angular shot spread; it is not a hit chance.";

// ---------------------------------------------------------------------------
// Value hygiene
// ---------------------------------------------------------------------------

const EMPTY_VALUES = new Set(["", "none", "n/a", "na", "not applicable", "unavailable", "-", String.fromCharCode(0x2014)]);

/** A value is worth rendering when it is non-empty and not an "absent" placeholder. */
export function isMeaningfulValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  return !EMPTY_VALUES.has(String(value).trim().toLowerCase());
}

/**
 * Build a row, or return null when the row carries no information.
 *
 * kind:
 *   "modifier" : a ×multiplier; hidden when it equals the 100% no-op.
 *   "bonus"    : an additive bonus; hidden when it is zero.
 *   "value"    : shown whenever the formatted text is meaningful (default).
 */
export function statRow(id, label, value, { kind = "value", raw = null, tone = null, hint = null } = {}) {
  if (kind === "modifier" && (raw === null || Math.abs(Number(raw) - 1) < 1e-9)) return null;
  if (kind === "bonus" && (raw === null || Math.abs(Number(raw)) < 1e-9)) return null;
  if (!isMeaningfulValue(value)) return null;
  return { id, label, value: String(value), tone, hint };
}

/**
 * Records which canonical stat ids have already been rendered so no statistic is
 * duplicated across the core row, primary capability and the advanced sections.
 */
export class StatLedger {
  constructor() { this.seen = new Set(); }
  /** Keep only rows whose id has not been emitted yet. */
  take(rows) {
    const kept = [];
    for (const row of rows) {
      if (!row) continue;
      if (row.id && this.seen.has(row.id)) continue;
      if (row.id) this.seen.add(row.id);
      kept.push(row);
    }
    return kept;
  }
  has(id) { return this.seen.has(id); }
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

export const FAMILIES = ["structure", "power", "propulsion", "weapon", "defence", "command", "utility"];

/** Map a component onto the presentation family whose rules describe it best. */
export function componentFamily(type, stat = {}) {
  if (type === "core" || type === "backupCore" || stat.category === "Command") return "command";
  if (stat.category === "Weapons") return "weapon";
  if (stat.category === "Defence") return "defence";
  if (stat.category === "Power" || (stat.powerGeneration || 0) > 0) return "power";
  if (stat.category === "Engines") return "propulsion";
  if (stat.category === "Structure") return "structure";
  return "utility";
}

const CATEGORY_BADGES = {
  Weapons: "WEAPON",
  Engines: "ENGINE",
  Defence: "DEFENCE",
  Structure: "STRUCTURE",
  Power: "POWER",
  Command: "COMMAND",
  "Heat Components": "HEAT",
  Support: "SUPPORT"
};

/** `WEAPON · 1×1` : category and footprint in one compact badge. */
export function categoryBadge(category, footprint = { width: 1, height: 1 }) {
  const label = CATEGORY_BADGES[category] || String(category || "COMPONENT").toUpperCase();
  return `${label} · ${footprint.width || 1}×${footprint.height || 1}`;
}

// ---------------------------------------------------------------------------
// Shared formatting helpers
// ---------------------------------------------------------------------------

const heatRules = () => globalThis.HeatRules;
const turretRules = () => globalThis.TurretRules;

function heatRate(value) { return `${Number(value).toFixed(1)} H/s`; }
function heatAmount(value) { return `${Number(value).toFixed(1)} H`; }
function degrees(value) { return `${Math.round(value)}°`; }

function shieldImpactHeatRows(stat) {
  if (!((stat.shield || 0) > 0)) return [];
  const rate = getShieldImpactHeatPerDamage();
  const total = 100 * rate;
  const totalText = Number.isInteger(total) ? String(total) : total.toFixed(2);
  return [
    statRow("shield.impactHeat", "Impact Heat", `${rate.toFixed(2)} H / damage blocked`),
    statRow("shield.impactHeatSource", "Heat source", "Damage absorbed by Shields generates Heat in the Shield system."),
    statRow("shield.impactHeatDistribution", "Distribution", "Impact Heat is distributed across the ship's active Shield generators."),
    statRow("shield.impactHeatExample", "Example", `100 Shield damage blocked = ${totalText} H total`)
  ];
}

function repairStackRows(type, stat) {
  if (!isLocalRepairSource(type, stat)) return [];
  const multiplier = getRepairStackingMultiplier(GENERATED_BALANCE);
  return [
    statRow("repair.stacking", "Repair stacking", "Diminishing returns"),
    statRow("repair.stackRule", "Stacking rule", `Additional Repair modules contribute ${Math.round(multiplier * 100)}% as much as the previous one.`),
    statRow("repair.stackProgression", "Stacking progression", stackingProgression(5, GENERATED_BALANCE).join(", "))
  ];
}

function repairCapabilityRows(type, stat) {
  if (!((stat.repairRate || 0) > 0)) return [];
  return [
    statRow("repair.rate", "Repair Rate", formatRepair(stat.repairRate)),
    ...repairStackRows(type, stat)
  ];
}

function aimSpeedText(value) {
  if (value === undefined || value === null) return "Instant";
  return `${Math.round(value * (180 / Math.PI))}°/s`;
}

/**
 * Authored Heat output for a component, using the same shared HeatRules fields
 * the thermal simulation uses. Activity Heat is a rate; shot Heat is a discrete
 * firing event.
 */
export function heatProfileFor(type, stat) {
  const rules = heatRules();
  const profile = rules.profile(type, stat);
  const generation = rules.activityHeat(type, stat);
  const heatPerShot = rules.heatPerShot(type, stat);
  let cadence = "while active";
  if (stat.weapon) {
    cadence = stat.weapon.spinalCharge
      ? "while charging or holding"
      : stat.weapon.type === "beam" ? "while firing" : "per shot";
  } else if (type === "droneBay") {
    cadence = "while producing or operating active drones";
  } else if ((stat.powerGeneration || 0) > 0) {
    cadence = "at power load";
  } else if ((stat.thrust || 0) > 0) {
    cadence = "while thrusting";
  } else if ((stat.shieldRegen || 0) > 0) {
    cadence = "while recharging";
  } else if ((stat.repairRate || stat.repair || 0) > 0) {
    cadence = "while repairing";
  }
  return { generation, heatPerShot, cadence, capacity: profile.capacity, cooling: profile.cooling, passiveCooling: profile.passiveCooling };
}

const THERMAL_ROLE_TYPES = new Set(["radiator", "heatVent", "closedCycleCooler", "heatSink", "heatPipe"]);

const CONCISE_INSPECTOR_DESCRIPTIONS = Object.freeze({
  reactor: "Primary Power source for weapons, shields, engines and support systems.",
  nuclearReactor: "Capital-scale Power source for high-demand ships.",
  backupCore: "Secondary command centre for resilient ship designs.",
  heatPipe: "Coolant-network conduit.",
  heatSink: "High-capacity Heat storage component.",
  heatVent: "Compact passive exterior cooling component.",
  radiator: "Exterior cooling component for connected Heat networks.",
  closedCycleCooler: "Powered cooling component that operates inside the hull.",
  burstCooler: "Automatic thermal buffer with a recovery cycle.",
  droneBay: "Launches and rebuilds configurable Fighter, Defence or Repair drone squads."
});

export function inspectorDescription(type, fallback = "") {
  return CONCISE_INSPECTOR_DESCRIPTIONS[type] || fallback;
}

/**
 * All components now show heat details, so the thermal section is always
 * considered relevant even when the part itself produces no heat.
 */
export function hasThermalRelevance(type, stat) {
  // Heat details are now shown for every component.
  return true;
}

// ---------------------------------------------------------------------------
// Header + core specification row
// ---------------------------------------------------------------------------

function buildCore(type, stat, ledger, effectiveCost) {
  const rows = [
    statRow("cost", "Build cost", effectiveCost),
    statRow("mass", "Mass", formatMass(stat.mass)),
    statRow("durability", "Durability", formatHull(stat.hp))
  ];
  // Power is stated by direction rather than by an ambiguous +/- sign, and only
  // once : the ledger stops it reappearing in any later grid.
  const generation = stat.powerGeneration || 0;
  const use = stat.powerUse || 0;
  if (generation > 0) rows.push(statRow("power", "Power output", `${generation} MW`, { tone: "supply" }));
  else if (use > 0) rows.push(statRow("power", "Power draw", `${use} MW`, { tone: "demand" }));
  return ledger.take(rows);
}

// ---------------------------------------------------------------------------
// Primary capability : per family
// ---------------------------------------------------------------------------

function weaponCapability(stat) {
  const weapon = stat.weapon;
  if (!weapon) return [];
  const presentation = WeaponPresentationRules.weaponCyclePresentation(weapon);
  const rows = [statRow("weapon.dps", presentation.dpsLabel, presentation.dps.toFixed(1))];
  rows.push(statRow("weapon.range", "Range", formatDistance(weapon.range)));
  // A "cannot miss" weapon states its guarantee instead of a redundant 100%.
  if ((weapon.accuracy ?? 1) >= 1) rows.push(statRow("weapon.accuracy", "Accuracy", "Cannot miss", { hint: ACCURACY_HINT }));
  else rows.push(statRow("weapon.accuracy", "Accuracy", formatPercent(weapon.accuracy), { hint: ACCURACY_HINT }));
  rows.push(statRow("weapon.arc", "Firing arc", degrees(weapon.arc || 360)));
  if (weapon.type === "flak") {
    rows.push(statRow("weapon.blastDamage", "Blast damage", formatDamage(weapon.blastDamage ?? 0)));
    rows.push(statRow("weapon.blastRadius", "Blast radius", formatDistance(weapon.blastRadius ?? 0)));
    rows.push(statRow("weapon.fuseRadius", "Fuse radius", formatDistance(weapon.proximityFuseRadius ?? 0)));
    rows.push(statRow("weapon.falloff", "Falloff", `${formatDistance(weapon.innerFullDamageRadius ?? 0)} full · exp ${Number(weapon.falloffExponent ?? 1).toFixed(1)}`));
    rows.push(statRow("weapon.targets", "Preferred targets", "Missiles, drones, light ships"));
    if ((weapon.directDamage ?? 1) > 0) rows.push(statRow("weapon.directDamage", "Direct hit", formatDamage(weapon.directDamage)));
  }
  return rows;
}

function capabilityRows(type, stat, family, context = {}) {
  if (stat.proximityCharge) {
    const cfg = stat.proximityCharge;
    return [
      statRow("proximityCharge.trigger", "Trigger", `Enemy within ${formatDistance(cfg.triggerRadius)}`),
      statRow("proximityCharge.directDamage", "Direct contact damage", formatDamage(cfg.directContactHullDamage)),
      statRow("proximityCharge.splashDamage", "Splash centre damage", formatDamage(cfg.splashCentreDamage)),
      statRow("proximityCharge.blastRadius", "Blast radius", formatDistance(cfg.blastRadius)),
      statRow("proximityCharge.shieldBypass", "Shield interaction", "Bypasses shields"),
      statRow("proximityCharge.carrierEffect", "Carrier effect", "Destroys entire ship"),
      statRow("proximityCharge.componentCap", "Affected components", cfg.maxAffectedComponents === null ? "Unlimited" : `Up to ${cfg.maxAffectedComponents}`),
      statRow("proximityCharge.friendlyFire", "Friendly ship damage", cfg.damagesFriendlyShips === false ? "No" : "Yes"),
      statRow("proximityCharge.multiCharge", "Multiple charges", "100% / +50% / +25% / +10%")
    ];
  }

  if (type === "droneBay" && stat.droneConfig) {
    const config = stat.droneConfig;
    const selected = context.droneType && config.types?.[context.droneType];
    const squadSize = selected?.squadSize ?? config.squadSize;
    const fuelSeconds = selected?.fuelSeconds ?? config.fuelSeconds;
    return [
      statRow("drone.squad", "Squad Capacity", `${squadSize} drones`),
      statRow("drone.fuel", "Fuel Duration", `${fuelSeconds}s`),
      statRow("drone.refuel", "Dock / Refuel", `${config.refuelSeconds}s`),
      statRow("drone.maxActive", "Ship Limit", `${config.maxActivePerShip} active`),
      statRow("drone.bays", "Bay Limit", `${config.maxBaysPerShip} per ship`)
    ];
  }

  if ((stat.sensorRangeBonus || 0) > 0) {
    const directed = stat.sensorRole === "directed";
    return [
      statRow("sensor.role", "Coverage", directed ? "Forward cone" : "Omnidirectional"),
      statRow("sensor.rangeBonus", "Range bonus", `+${formatDistance(stat.sensorRangeBonus)}`),
      statRow("sensor.arc", "Cone width", directed ? degrees(stat.sensorArc) : null),
      statRow(
        "sensor.stacking",
        "Linear stack",
        directed ? "Full authored bonus; Directed only" : "Full authored bonus per sensor"
      )
    ];
  }

  switch (family) {
    case "weapon":
      return weaponCapability(stat);

    case "defence": {
      if (stat.weapon) return [...weaponCapability(stat), ...shieldImpactHeatRows(stat), ...repairCapabilityRows(type, stat)];
      const rows = [
        statRow("shield.capacity", "Shield Capacity", (stat.shield || 0) > 0 ? formatShield(stat.shield) : null),
        statRow("shield.regen", "Regeneration", (stat.shieldRegen || 0) > 0 ? `${stat.shieldRegen} SP/s` : null),
        ...shieldImpactHeatRows(stat),
        ...repairCapabilityRows(type, stat)
      ];
      if (stat.decoyConfig) {
        rows.push(statRow("decoy.capacity", "Decoy Capacity", `${stat.decoyConfig.capacity}`));
        rows.push(statRow("decoy.chance", "Attraction Chance", formatPercent(stat.decoyConfig.attractionChance)));
      }
      if ((stat.frontDamageReduction || 0) > 0) {
        rows.push(statRow("defence.frontReduction", "Frontal Reduction", formatPercent(stat.frontDamageReduction)));
        rows.push(statRow("defence.frontArc", "Covered Arc", degrees(stat.frontArc || 0)));
      }
      return rows;
    }

    case "power": {
      const rows = [];
      // Power output already appears in the core row; the ledger drops the repeat
      // and leaves storage as the meaningful capability for batteries/capacitors.
      if ((stat.powerGeneration || 0) > 0) rows.push(statRow("power", "Power Output", `${stat.powerGeneration} MW`));
      // Only explicit storage components expose an Energy Capacity row;
      // generators are Power sources rather than stored-energy modules.
      const capacity = (stat.powerGeneration || 0) <= 0
        ? (stat.energyCapacity || stat.energyStorage || 0)
        : 0;
      if (capacity > 0) rows.push(statRow("power.storage", "Energy Capacity", formatEnergy(capacity)));
      if ((stat.maxChargeRate || 0) > 0) rows.push(statRow("power.chargeRate", "Max Charge Rate", `${stat.maxChargeRate} MW`));
      if ((stat.maxDischargeRate || 0) > 0) rows.push(statRow("power.dischargeRate", "Max Discharge Rate", `${stat.maxDischargeRate} MW`));
      if ((stat.chargeEfficiency || 0) > 0 && stat.chargeEfficiency < 1) rows.push(statRow("power.chargeEff", "Charge Efficiency", formatPercent(stat.chargeEfficiency)));
      if ((stat.dischargeEfficiency || 0) > 0 && stat.dischargeEfficiency < 1) rows.push(statRow("power.dischargeEff", "Discharge Efficiency", formatPercent(stat.dischargeEfficiency)));
      if ((stat.dischargeHeatAtMax || 0) > 0) rows.push(statRow("power.dischargeHeat", "Max Discharge Heat", heatRate(stat.dischargeHeatAtMax)));
      if ((stat.shield || 0) > 0) rows.push(statRow("shield.capacity", "Shield Capacity", formatShield(stat.shield)));
      rows.push(...shieldImpactHeatRows(stat));
      return rows;
    }

    case "propulsion": {
      const rows = [];
      if ((stat.thrust || 0) > 0) rows.push(statRow("thrust", "Thrust", formatThrust(stat.thrust)));
      if ((stat.turn || 0) > 0) rows.push(statRow("turn", "Turn Rate", `${stat.turn}`));
      return rows;
    }

    case "command": {
      const rows = [];
      if ((stat.powerGeneration || 0) > 0) rows.push(statRow("power", "Power Output", `${stat.powerGeneration} MW`));
      if ((stat.powerGeneration || 0) <= 0 && (stat.energyStorage || 0) > 0) {
        rows.push(statRow("power.storage", "Energy Storage", formatEnergy(stat.energyStorage)));
      }
      return rows;
    }

    case "structure": {
      // A plain Frame has no capability beyond its core specification row, and
      // deliberately renders no capability group at all.
      const rows = [];
      if ((stat.armorFlatReduction || 0) > 0) {
        rows.push(statRow("armor.reduction", "Damage Reduction", `${stat.armorFlatReduction} per hit`));
      }
      return rows;
    }

    default: {
      const rows = [];
      rows.push(...repairCapabilityRows(type, stat));
      rows.push(statRow("bonus.range", "Weapon Range Bonus", (stat.rangeBonus || 0) ? `+${formatDistance(stat.rangeBonus)}` : null, { kind: "bonus", raw: stat.rangeBonus }));
      rows.push(statRow("bonus.accuracy", "Accuracy Bonus", `+${formatPercent(stat.accuracyBonus)}`, { kind: "bonus", raw: stat.accuracyBonus, hint: ACCURACY_HINT }));
      rows.push(statRow("bonus.fireRate", "Fire Rate Bonus", `+${formatPercent(stat.fireRateBonus)}`, { kind: "bonus", raw: stat.fireRateBonus }));
      rows.push(statRow("bonus.capture", "Capture Pressure", `+${formatPercent(stat.captureBonus)}`, { kind: "bonus", raw: stat.captureBonus }));
      rows.push(statRow("bonus.ecm", "Missile Tracking Penalty", `-${formatPercent(stat.ecmStrength)}`, { kind: "bonus", raw: stat.ecmStrength }));
      // Heat storage / cooling / transfer are stated once, by the compact thermal
      // summary built ahead of this grid.
      return rows;
    }
  }
}

function thermalRoleText(type) {
  if (type === "radiator") return "Strong sustained external heat rejection.";
  if (type === "heatVent") return "Cheap low-output external cooling for compact ships.";
  if (type === "closedCycleCooler") return "Sustained internal cooling where hull exposure is unavailable.";
  if (type === "heatSink") return "Buffers temporary Heat spikes; it does not remove Heat.";
  if (type === "heatPipe") return "Routes Heat between separated systems; it provides no storage or cooling.";
  return "Thermal support";
}

function exteriorCoolingCondition(type, rules) {
  if (type === "radiator") {
    const enclosedPercent = Math.round((Number(rules.RADIATOR_ENCLOSED_MULTIPLIER) || 0) * 100);
    return {
      ...statRow("heat.exposure", "Needs an exposed edge", `Fully enclosed radiators operate at ${enclosedPercent}% of rated cooling output.`, { tone: "condition" }),
      calloutCategory: "condition"
    };
  }
  if (type === "heatVent") {
    return {
      ...statRow("heat.exposure", "Needs an exposed edge", "Fully enclosed vents provide very little cooling.", { tone: "condition" }),
      calloutCategory: "condition"
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Compact thermal summary (overview)
// ---------------------------------------------------------------------------

function thermalSummaryRows(type, stat, ledger) {
  if (!hasThermalRelevance(type, stat)) return [];
  const profile = heatProfileFor(type, stat);
  const rows = [];
  if (type === "heatSink") {
    rows.push({ ...statRow("heat.storage", "Heat storage", `Stores ${profile.capacity} H`, { tone: "cool" }), calloutCategory: "capability" });
    rows.push({
      ...statRow("heat.coolantPath", "Needs a coolant path", "Heat must reach the sink directly or through Heat Pipes; adjacent components do not share its capacity.", { tone: "condition" }),
      calloutCategory: "condition"
    });
  }
  if (type === "radiator") {
    rows.push({ ...statRow("heat.cooling", "Cooling", `Removes ${heatRate(profile.cooling)}`, { tone: "cool" }), calloutCategory: "capability" });
    rows.push(exteriorCoolingCondition(type, heatRules()));
  }
  if (type === "heatVent") {
    rows.push({ ...statRow("heat.cooling", "Cooling", `Removes ${heatRate(profile.cooling)} while exposed`, { tone: "cool" }), calloutCategory: "capability" });
    rows.push(exteriorCoolingCondition(type, heatRules()));
  }
  if (type === "closedCycleCooler") {
    rows.push({ ...statRow("heat.cooling", "Active cooling", `Removes ${heatRate(profile.cooling)}`, { tone: "cool" }), calloutCategory: "capability" });
    rows.push({ ...statRow("heat.passiveCooling", "Passive emergency cooling", `Removes at least ${heatRate(profile.passiveCooling)} without Power`, { tone: "cool" }), calloutCategory: "capability" });
    rows.push({ ...statRow("heat.capacity", "Heat storage", `Stores ${profile.capacity} H`, { tone: "cool" }), calloutCategory: "capability" });
  }
  // Burst cooling is not a rate, so quoting only "Removes N H/s" would
  // describe the wrong component entirely. The store, the trigger and the dead
  // window are the three numbers a player actually plans around.
  const burst = stat.burstCooler;
  if (burst) {
    rows.push({ ...statRow("heat.burstVent", "Burst vent", `Dumps ${Math.round(Number(burst.burstHeat) || 0)} H at once`, { tone: "cool" }), calloutCategory: "capability" });
    rows.push({ ...statRow("heat.capacity", "Heat storage", `Stores ${profile.capacity} H`, { tone: "cool" }), calloutCategory: "capability" });
    rows.push({ ...statRow("heat.burstTrigger", "Vents at", `${Math.round((Number(burst.triggerHeatRatio) || 0) * 100)}% of its own capacity`, { tone: "condition" }), calloutCategory: "condition" });
    rows.push({ ...statRow("heat.burstRecharge", "Recharge", `${Number(burst.rechargeSeconds) || 0}s at ${Math.round((Number(burst.rechargeCoolingFraction) || 0) * 100)}% cooling`, { tone: "condition" }), calloutCategory: "condition" });
  }
  if (stat.heatBeamShield) {
    rows.push({ ...statRow("heat.beamShield", "Heat beams", "Blocks induction Heat beams passing through it", { tone: "cool" }), calloutCategory: "capability" });
  }
  if (profile.generation > 0.05) {
    rows.push({ ...statRow("heat.production", "Heat", `Produces ${heatRate(profile.generation)} ${profile.cadence}`, { tone: "hot" }), calloutCategory: "cost" });
  }
  if (profile.heatPerShot > 0.05) {
    rows.push({ ...statRow("heat.perShot", "Heat per shot", `Adds ${heatAmount(profile.heatPerShot)} per firing event`, { tone: "hot" }), calloutCategory: "cost" });
  }
  if (THERMAL_ROLE_TYPES.has(type)) {
    rows.push({ ...statRow("heat.role", "Thermal role", thermalRoleText(type), { tone: "role" }), calloutCategory: "role" });
  }
  return ledger.take(rows);
}

// ---------------------------------------------------------------------------
// Warnings : risks and restrictions never live in ordinary stat cards
// ---------------------------------------------------------------------------

function warningsFor(type, stat, family, context = {}) {
  const rules = heatRules();
  const warnings = [];

  if (family === "power" && (stat.powerGeneration || 0) > 0) {
    const meltdownDamage = stat.meltdownDamage ?? rules.REACTOR_EXPLOSION_DAMAGE;
    const meltdownRadius = stat.meltdownRadius ?? rules.REACTOR_EXPLOSION_RADIUS;
    warnings.push({
      id: "meltdown",
      title: "Meltdown risk",
      body: `Explodes after ${rules.REACTOR_MELTDOWN_SECONDS} seconds continuously overheated, dealing ${meltdownDamage} damage within ${meltdownRadius} tiles.`,
      tone: "bad",
      calloutCategory: "severe"
    });
  }

  if (type === "core") {
    warnings.push({
      id: "command-loss",
      title: "Command loss",
      body: "Destroying this component destroys the ship unless a Backup Command Core is installed and powered.",
      tone: "bad",
      calloutCategory: "severe"
    });
  }

  if (type === "backupCore") {
    warnings.push({
      id: "backup-command",
      title: "Backup command",
      body: `Takes over when the main Core is destroyed. Weapon accuracy, turn rate and drone command range operate at ${BACKUP_EFFECTIVENESS_TEXT}.`,
      tone: "ok",
      calloutCategory: "capability"
    });
    warnings.push({
      id: "backup-power-loss",
      title: "Command power loss",
      body: "If this component loses Power after the main Core is destroyed, the ship is lost shortly after.",
      tone: "bad",
      calloutCategory: "severe"
    });
  }

  if (Number(stat.maxPerShip) === 1) {
    warnings.push({ id: "one-per-ship", title: "One per ship", body: "Only one of this component may be installed on a ship.", tone: "warning", calloutCategory: "condition" });
  }

  if (type === "droneBay") {
    const launch = context.launchEdge || null;
    const preferred = context.preferredLaunchEdge || null;
    const direction = launch?.side || (preferred?.openCellCount > 0 ? preferred.side : null);
    const directionLabel = direction ? direction.charAt(0).toUpperCase() + direction.slice(1) : null;
    const launchLabel = launch
      ? `Launch edge: ${directionLabel} \u00b7 Clear`
      : directionLabel
        ? `Launch edge: ${directionLabel} \u00b7 Blocked`
        : "Needs an exposed launch edge";
    const launchBody = launch
      ? `Launching from the ${directionLabel} edge. One complete two-cell edge must face open space.`
      : directionLabel
        ? `${directionLabel} edge is blocked. One complete two-cell edge must face open space.`
        : "One complete two-cell edge must face open space to launch and recover drones.";

    warnings.push({
      id: "launch-edge",
      title: launchLabel,
      body: launchBody,
      tone: launch ? "ok" : "warning",
      calloutCategory: launch ? "capability" : "condition"
    });
  }

  // Power and Data dependencies are not warnings. They are ordinary, extremely
  // common requirements, so they render as a compact requirements row instead of
  // full-width callouts (see requirementsFor). Only exceptional behaviour :
  // meltdown, command loss, placement restrictions : earns a warning panel.

  return warnings;
}

export function componentCallouts({ thermalSummary = [], requirements = [], warnings = [] } = {}) {
  const callouts = thermalSummary.map((row) => ({
    id: row.id,
    category: row.calloutCategory || (row.tone === "hot" ? "cost" : row.tone === "cool" ? "capability" : "role"),
    renderType: "thermal",
    row
  }));
  if (requirements.length) {
    callouts.push({ id: "requirements", category: "condition", renderType: "requirements", requirements });
  }
  for (const warning of warnings) {
    callouts.push({
      id: warning.id,
      category: warning.calloutCategory || (warning.tone === "bad" ? "severe" : warning.tone === "ok" ? "capability" : "condition"),
      renderType: "warning",
      warning
    });
  }
  return sortComponentCallouts(callouts);
}

// ---------------------------------------------------------------------------
// Requirements : compact, always-grouped resource dependencies
// ---------------------------------------------------------------------------

/** Requirement is unmet for the currently selected placed component. */
const FAILED_POWER_STATES = new Set(["unpowered", "disconnected", "underpowered"]);
const FAILED_DATA_STATES = new Set(["disconnected", "unpowered", "overheated"]);

/**
 * Resource dependencies for a component, kept together in one consistent area
 * rather than attached to individual stat values.
 *
 * `status` is "met" / "unmet" / "unplaced". Only a genuine current failure on the
 * selected placed component is "unmet"; an unplaced catalogue component reports
 * "unplaced" and renders as an ordinary (amber) dependency.
 */
export function requirementsFor(type, stat, context = {}) {
  const includePower = context.includePowerRequirements ?? true;
  const includeData = context.includeDataRequirements ?? true;
  const status = context.requirementStatus || {};
  const requirements = [];

  if (includePower && (stat.powerUse || 0) > 0) {
    requirements.push({
      id: "power",
      label: "Power",
      icon: "⚡",
      summary: `${stat.powerUse} MW`,
      detail: `Draws ${stat.powerUse} MW from the ship-wide Power pool. It operates proportionally when that draw is not fully available.`,
      status: status.power?.state || "unplaced",
      failureText: status.power?.reason || null
    });
  }

  if (includeData && (stat.rangeBonus || stat.accuracyBonus || stat.fireRateBonus)) {
    const automatic = context.automaticDataLinks === true;
    requirements.push({
      id: "data",
      label: "Data",
      icon: "◇",
      summary: automatic ? "Automatic links" : "Explicit links",
      detail: automatic
        ? "Automatically links to compatible weapons. Its fixed bonus is split evenly between them, so each additional linked weapon receives a smaller share."
        : "Supports only weapons joined to it by explicit Data Links. Its bonus is split evenly between every linked weapon.",
      status: status.data?.state || "unplaced",
      failureText: status.data?.reason || null
    });
  }

  return requirements;
}

/** Classify a solved Blueprint power entry for the requirements row. */
export function powerRequirementState(entry) {
  if (!entry) return { state: "unplaced", reason: null };
  if (!FAILED_POWER_STATES.has(entry.state)) return { state: "met", reason: null };
  const reason = entry.state === "disconnected"
    ? "Not connected to the ship-wide Power pool."
    : entry.state === "unpowered"
      ? "Receiving no Power from the ship-wide pool."
      : `Receiving ${Number(entry.allocatedMw || 0).toFixed(1)} MW of ${Number(entry.requestedMw || 0).toFixed(1)} MW.`;
  return { state: "unmet", reason };
}

/** Classify a Blueprint Data-source allocation for the requirements row. */
export function dataRequirementState(source) {
  if (!source) return { state: "unplaced", reason: null };
  if (FAILED_DATA_STATES.has(source.status)) {
    return { state: "unmet", reason: source.statusReason || "This Data source is not delivering support." };
  }
  if (!source.recipientCount) {
    return { state: "unmet", reason: "No weapon is connected to this Data network." };
  }
  return { state: "met", reason: null };
}

// ---------------------------------------------------------------------------
// Advanced sections : context-specific headings, collapsed by default
// ---------------------------------------------------------------------------

const TARGET_PRIORITY_LABELS = {
  droneFighter: "Fighter Drones",
  droneOther: "Support Drones",
  drone: "Drones",
  missile: "Missiles",
  torpedo: "Torpedoes",
  swarmMissile: "Swarm Missiles",
  projectile: "Projectiles",
  ship: "Ships"
};

export function formatTargetPriority(priority) {
  if (TARGET_PRIORITY_LABELS[priority]) return TARGET_PRIORITY_LABELS[priority];
  return priority
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .trim();
}

function weaponDetailRows(type, stat) {
  const weapon = stat.weapon;
  const presentation = WeaponPresentationRules.weaponCyclePresentation(weapon);
  const rows = [];
  if (weapon.type === "beam") {
    rows.push(statRow("weapon.damage", "Damage", `${formatDamage(weapon.damage)}/s`));
    rows.push(statRow("weapon.radius", "Beam Radius", formatDistance(weapon.radius || 0)));
  } else {
    const pellets = Number(weapon.pelletCount) || 0;
    if (pellets >= 2) {
      // A multi-pellet weapon's headline number is per pellet, and quoting only
      // the volley total would hide the reason armour counters it so hard.
      rows.push(statRow("weapon.damage", "Damage per Pellet", formatDamage(weapon.damage)));
      rows.push(statRow("weapon.pelletCount", "Pellets per Shot", `${pellets}`));
      rows.push(statRow("weapon.pelletDamage", "Damage per Shot", `${formatDamage(weapon.damage * pellets)} across ${pellets} separate impacts`));
      rows.push(statRow("weapon.pelletSpread", "Pellet Spread", `±${Number(weapon.pelletSpreadDegrees) || 0}°`));
    } else {
      rows.push(statRow("weapon.damage", "Damage per Shot", formatDamage(weapon.damage)));
    }
    if (presentation.isChargeWeapon) {
      rows.push(statRow("weapon.spinalCharge", "Charge", `${presentation.chargeSeconds.toFixed(1)} s holding a firing solution`));
      rows.push(statRow("weapon.reload", "Reload", `${presentation.reloadSeconds.toFixed(1)} s`));
      rows.push(statRow("weapon.spinalCycle", "Ideal Cycle", `${presentation.cycleSeconds.toFixed(1)} s`));
    } else {
      // Fire rate and reload are the same fact twice : only fire rate is shown.
      rows.push(statRow("weapon.fireRate", "Fire Rate", `${weapon.fireRate} shots/s`));
    }
    rows.push(statRow("weapon.projectileSpeed", "Projectile Speed", (Number(weapon.projectileSpeed) || 0) > 0 ? formatSpeed(weapon.projectileSpeed) : "Hitscan"));
  }
  rows.push(statRow("weapon.traverse", "Turret Traverse", aimSpeedText(turretRules().turnRateFor(weapon))));
  rows.push(statRow("weapon.vsShields", "Vs Shields", formatMultiplierPercent(weapon.shieldDamageMultiplier), { kind: "value", raw: weapon.shieldDamageMultiplier }));
  rows.push(statRow("weapon.vsHull", "Vs Hull", formatMultiplierPercent(weapon.hullDamageMultiplier), { kind: "value", raw: weapon.hullDamageMultiplier }));

  if (weapon.type === "missile") {
    rows.push(statRow("weapon.tracking", "Tracking", formatPercent(weapon.tracking)));
    rows.push(statRow("weapon.trackTime", "Track Time", `${weapon.trackTime}s`));
    rows.push(statRow("weapon.lockDelay", "Lock Delay", `${weapon.trackingDelay}s`));
    rows.push(statRow("weapon.missileHp", "Missile HP", `${weapon.missileHp}`));
  }
  if (weapon.burnThroughCarryMultiplier || type === "beamEmitter") {
    rows.push(statRow("weapon.targeting", "Targeting", "Core-directed"));
    rows.push(statRow("weapon.burnThrough", "Burn-Through", `${Math.round((weapon.burnThroughCarryMultiplier || 0.4) * 100)}% of excess damage`));
    rows.push(statRow("weapon.penetration", "Maximum Penetration", "1 additional component"));
    rows.push(statRow("weapon.charge", "Sustained Charge", `+${Math.round((weapon.maxChargeDamageBonus || 0) * 100)}% damage after ${weapon.chargeRampSeconds || 0}s`));
    rows.push(statRow("weapon.impactHeat", "Impact Heating", `${Number(weapon.impactHeatPerDamage || 0).toFixed(2)} Heat per damage`));
  }
  if (Number.isFinite(weapon.inductionHeatBasePerSecond) && Number.isFinite(weapon.inductionHeatMaxPerSecond)) {
    rows.push(statRow("weapon.componentSelection", "Targeting Priority", "Prioritises functioning Power generators when available, then other active systems"));
    rows.push(statRow("weapon.damage", "Direct damage", "0"));
    rows.push(statRow("weapon.vsShields", "Shield damage", "0"));
    rows.push(statRow("weapon.vsHull", "Hull damage", "0"));
    rows.push(statRow("weapon.inductionRange", "Range", formatDistance(weapon.range || 0)));
    rows.push(statRow("weapon.inductionArc", "Arc", `${weapon.arc || 0}°`));
    rows.push(statRow("weapon.aimSpeed", "Aim speed", `${weapon.aimSpeed || 0} rad/s`));
    rows.push(statRow("weapon.inductionBase", "Base induction", `${weapon.inductionHeatBasePerSecond} H/s`));
    rows.push(statRow("weapon.inductionMax", "Maximum induction", `${weapon.inductionHeatMaxPerSecond} H/s`));
    rows.push(statRow("weapon.inductionRamp", "Ramp time", `${weapon.inductionRampSeconds || 0}s`));
    rows.push(statRow("weapon.inductionShielded", "Shielded efficiency", `${Math.round((weapon.inductionShieldMultiplier || 0.4) * 100)}%`));
    rows.push(statRow("weapon.inductionDirect", "Direct subsystem", `${Math.round((weapon.inductionDirectFraction || 0.6) * 100)}%`));
    rows.push(statRow("weapon.inductionAdjacent", "Immediate neighbours", `${Math.round((weapon.inductionAdjacentFraction || 0.3) * 100)}%`));
    rows.push(statRow("weapon.inductionSecond", "Second-hop neighbours", `${Math.round((weapon.inductionSecondHopFraction || 0.1) * 100)}%`));
    rows.push(statRow("weapon.inductionGrace", "Contact grace", `${weapon.inductionContactGraceSeconds || 0.25}s`));
    rows.push(statRow("weapon.burnThrough", "Burn-Through", "None"));
    rows.push(statRow("weapon.charge", "Conventional beam charge", "None"));
    rows.push(statRow("weapon.inductionDescription", "Effect", "Deals no structural damage. Sustained contact couples increasing Heat into the selected subsystem, its first-hop neighbours and second-hop neighbours. Active shields reduce coupling to 40%."));
  }
  // Offensive impact burst. Anti-missile mounts already report their blast
  // through the defensive rows above, so this only covers ship-killing shells.
  if (!weapon.antiMissile && (Number(weapon.blastRadius) || 0) > 0 && (Number(weapon.blastDamage) || 0) > 0) {
    rows.push(statRow("weapon.blastDamage", "Blast Damage", formatDamage(weapon.blastDamage)));
    rows.push(statRow("weapon.blastRadius", "Blast Radius", formatDistance(weapon.blastRadius)));
    if ((Number(weapon.innerFullDamageRadius) || 0) > 0) {
      rows.push(statRow("weapon.blastInner", "Full-Damage Radius", formatDistance(weapon.innerFullDamageRadius)));
    }
    if ((Number(weapon.maximumExplosionTargets) || 0) > 0) {
      rows.push(statRow("weapon.blastTargets", "Blast Target Cap", `${weapon.maximumExplosionTargets} entities`));
    }
  }
  // Impact Heat on a projectile weapon (the beam families report it above).
  if (!weapon.burnThroughCarryMultiplier && type !== "beamEmitter" && (Number(weapon.impactHeatPerDamage) || 0) > 0) {
    rows.push(statRow("weapon.impactHeat", "Impact Heating", `${Number(weapon.impactHeatPerDamage).toFixed(2)} Heat per damage`));
  }
  if (weapon.spinalCharge) {
    const charge = weapon.spinalCharge;
    rows.push(statRow("weapon.spinalHold", "Charge Retention", `${Number(charge.chargeHoldSeconds) || 0}s after losing the target, then bleeds away`));
    rows.push(statRow("weapon.spinalCommit", "Committed Aim", `Traverse falls to ${Math.round((Number(charge.committedAimTraverseFloor) || 0) * 100)}% past ${Math.round((Number(charge.committedAimStartProgress) || 0) * 100)}% charge`));
    rows.push(statRow("weapon.spinalHull", "Hull Commitment", `Ship turns at ${Math.round((Number(charge.hullTurnPenaltyMultiplier) || 1) * 100)}% past ${Math.round((Number(charge.hullTurnPenaltyStartProgress) || 0) * 100)}% charge`));
    if (Array.isArray(charge.penetrationProfile) && charge.penetrationProfile.length) {
      rows.push(statRow("weapon.spinalPenetration", "Penetration", charge.penetrationProfile.map((share) => `${Math.round(share * 100)}%`).join(" → ")));
    }
    rows.push(statRow("weapon.spinalTelegraph", "Telegraph", "The charge is visible on the hull for the whole cycle"));
  }
  if (weapon.antiMissile) {
    rows.push(statRow("weapon.antiMissile", "Anti-Missile", "Yes"));
    if (type === "pointDefense" || (Number(weapon.projectileSpeed) || 0) === 0) {
      rows.push(statRow("weapon.firingMode", "Firing Mode", "Hitscan: cannot miss once aligned"));
    }
    if (weapon.targetPriority?.length) {
      const formattedPriority = weapon.targetPriority.map(formatTargetPriority).join(", ");
      rows.push(statRow("weapon.targetPriority", "Target Priority", formattedPriority));
    }
    rows.push(statRow("weapon.vsShips", "Ship Damage", `${Math.round((weapon.shipDamageMultiplier ?? 0.04) * 100)}%`));
  }
  return rows;
}

function formatMultiplierPercent(value) {
  return `${Math.round((value ?? 1) * 100)}%`;
}

/**
 * Advanced sections for a component, keyed by family with per-type overrides.
 * Only sections that survive the ledger and the value filters are returned.
 */
function advancedSections(type, stat, family, ledger, context) {
  const sections = [];
  const push = (id, title, rows) => {
    const kept = ledger.take(rows);
    if (kept.length) sections.push({ id, title, rows: kept });
  };

  if (stat.weapon) push("weapon", "Weapon Details", weaponDetailRows(type, stat));

  if (family === "power" || family === "command") {
    push("power", "Power Details", [
      statRow("power.category", "Power Category", powerCategoryLabel(stat.powerCategory)),
      statRow(
        "power.storage",
        "Energy Storage",
        (stat.powerGeneration || 0) <= 0 && (stat.energyStorage || 0) > 0 ? formatEnergy(stat.energyStorage) : null
      )
    ]);
  }

  if (family === "defence" && !stat.weapon && type !== "decoyLauncher") {
    push("shield", "Shield Details", [
      statRow("shield.capacity", "Shield Capacity", (stat.shield || 0) > 0 ? formatShield(stat.shield) : null),
      statRow("shield.regen", "Regeneration", (stat.shieldRegen || 0) > 0 ? `${stat.shieldRegen} SP/s` : null),
      statRow("shield.stacking", "Stacking", "Capacity from every Shield on the ship pools into one bubble."),
      ...shieldImpactHeatRows(stat)
    ]);
  }

  if (type === "decoyLauncher" && stat.decoyConfig) {
    const config = stat.decoyConfig;
    push("decoy", "Decoy Details", [
      statRow("decoy.capacity", "Stored Decoys", `${config.capacity}`),
      statRow("decoy.initial", "Initial Stock", `${config.initialStock}`),
      statRow("decoy.production", "Production Time", `${config.productionSeconds}s per decoy`),
      statRow("decoy.trigger", "Threat Detection", formatDistance(config.triggerRange)),
      statRow("decoy.range", "Attraction Range", formatDistance(config.attractionRange)),
      statRow("decoy.chance", "Attraction Chance", formatPercent(config.attractionChance)),
      statRow("decoy.lifetime", "False-Target Lifetime", `${config.lifetimeSeconds}s`),
      statRow("decoy.guidance", "Affects", "Guided missiles only")
    ]);
  }

  if (type === "droneBay" && stat.droneConfig) {
    const config = stat.droneConfig;
    const selected = context.droneType && config.types?.[context.droneType];
    push("drone", "Drone Details", [
      statRow("drone.role", "Drone Role", selected ? selected.label : "Not selected"),
      statRow("drone.rebuild", "Rebuild Time", selected ? `${selected.productionSeconds}s` : null),
      statRow("drone.commandRange", "Command Range", selected ? formatDistance(selected.commandRange) : null),
      statRow("drone.launchInterval", "Launch Interval", `${config.launchIntervalSeconds}s`),
      statRow("drone.bays", "Bays per Ship", `${config.maxBaysPerShip}`),
      statRow("drone.power", "Power by State", `${config.standbyPowerMw} / ${config.activePowerMw} / ${config.productionPowerMw} MW standby · active · building`)
    ]);
  }

  if ((stat.repairRate || 0) > 0) {
    push("repair", "Repair Details", [
      statRow("repair.rate", "Repair Rate", formatRepair(stat.repairRate)),
      ...repairStackRows(type, stat),
      statRow("repair.target", "Targeting", type === "repairBeam" ? "Projects onto a damaged allied ship in range." : "Repairs this ship's damaged components.")
    ]);
  }

  if (stat.rangeBonus || stat.accuracyBonus || stat.fireRateBonus) {
    const detailsTitle = type === "targetingComputer" ? "Targeting Details" : "Sensor Details";
    push("sensor", detailsTitle, [
      statRow("bonus.range", "Weapon Range Bonus", (stat.rangeBonus || 0) ? `+${formatDistance(stat.rangeBonus)}` : null, { kind: "bonus", raw: stat.rangeBonus }),
      statRow("bonus.accuracy", "Accuracy Bonus", `+${formatPercent(stat.accuracyBonus)}`, { kind: "bonus", raw: stat.accuracyBonus, hint: ACCURACY_HINT }),
      statRow("bonus.fireRate", "Fire Rate Bonus", `+${formatPercent(stat.fireRateBonus)}`, { kind: "bonus", raw: stat.fireRateBonus }),
      statRow("bonus.sharing", "Allocation", "Split evenly between every weapon on the same Data network.")
    ]);
  }

  if (family === "command") {
    push("command", "Command Details", [
      statRow("command.role", "Role", type === "backupCore" ? "Secondary command" : "Primary command"),
      statRow("command.effectiveness", "Backup Effectiveness", type === "backupCore" ? `${BACKUP_EFFECTIVENESS_TEXT} weapon accuracy, turn rate and drone command range while active` : null)
    ]);
  }

  if (family === "propulsion") {
    push("propulsion", "Propulsion Details", [
      statRow("thrust.speed", "Speed Contribution", "Total thrust divided by total ship mass."),
      statRow("thrust.placement", type === "maneuverThruster" ? "Placement" : "Facing",
        type === "maneuverThruster" ? "Turning strength scales with distance from the centre of mass." : null)
    ]);
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Command Aura / Fleet Buffs section
// ---------------------------------------------------------------------------

/**
 * Central mapping from aura stat key to human-readable label and formatting.
 * Each entry describes how to render one multiplier:
 *   - label: display name for the stat
 *   - format: function(raw) → display string, or null to hide
 *   - reduction: true when a value below 1 is a beneficial reduction
 *     (e.g. 0.9 = "10% shorter delay") rather than a penalty.
 */
const AURA_STAT_META = {
  weaponAccuracyMultiplier:        { label: "Weapon Accuracy",        reduction: false },
  weaponTrackingMultiplier:        { label: "Weapon Tracking",        reduction: false },
  turretAimSpeedMultiplier:        { label: "Turret Traverse Speed",  reduction: false },
  pointDefenceTrackingMultiplier:  { label: "Point-Defence Tracking", reduction: false },
  flakTrackingMultiplier:          { label: "Flak Tracking",          reduction: false },
  shieldRegenMultiplier:           { label: "Shield Regeneration",    reduction: false },
  shieldRestartDelayMultiplier:    { label: "Shield Restart Delay",   reduction: true  },
  repairRateMultiplier:            { label: "Repair Rate",            reduction: false },
  heatDissipationMultiplier:       { label: "Heat Dissipation",       reduction: false },
  overheatRecoveryMultiplier:      { label: "Overheat Recovery",      reduction: false },
  accelerationMultiplier:          { label: "Acceleration",          reduction: false },
  turnRateMultiplier:              { label: "Turn Rate",              reduction: false },
  sensorRangeMultiplier:           { label: "Sensor Range",           reduction: false },
  missileTrackingResistanceMultiplier: { label: "Missile Tracking Resistance", reduction: false },
  componentAimRetentionMultiplier:  { label: "Component-Aim Retention", reduction: false }
};

/**
 * Format an aura multiplier for display.
 * - Multipliers > 1 are shown as positive percentages (e.g. 1.08 → "+8%").
 * - Reduction multipliers < 1 with reduction:true are shown as meaningful
 *   reductions (e.g. 0.9 → "10% shorter").
 * - Neutral values (1.0) are hidden (return null).
 */
export function formatAuraModifier(key, raw) {
  const meta = AURA_STAT_META[key];
  if (!meta) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || Math.abs(value - 1) < 1e-9) return null;
  if (value > 1) {
    const pct = Math.round((value - 1) * 100);
    return `+${pct}%`;
  }
  if (meta.reduction) {
    const pct = Math.round((1 - value) * 100);
    return `${pct}% shorter`;
  }
  // Non-reduction multipliers below 1 are penalties; show as reduction
  const pct = Math.round((1 - value) * 100);
  return `-${pct}%`;
}

const AURA_TYPE_LABELS = {
  command: "Command",
  fireControl: "Fire Control",
  fleetDefence: "Fleet Defence",
  shield: "Shield",
  engineering: "Engineering",
  propulsion: "Propulsion",
  ewar: "Electronic Warfare"
};

/**
 * Context rows for the aura section: aura range, read from the authoritative
 * balance data.
 */
export function commandAuraContextRows() {
  const cfg = GENERATED_BALANCE?.commandAura || {};
  const range = Number(cfg.range) || 800;
  return [
    statRow("aura.range", "Aura Range", formatDistance(range))
  ];
}

/**
 * Buff rows for the aura section: one row per meaningful multiplier emitted
 * by this component's aura. Neutral (1.0) values are hidden.
 */
export function commandAuraBuffRows(stat) {
  const aura = stat?.aura;
  if (!aura) return [];
  const rows = [];
  for (const [key, raw] of Object.entries(aura)) {
    if (key === "type") continue;
    const meta = AURA_STAT_META[key];
    if (!meta) continue;
    const formatted = formatAuraModifier(key, raw);
    if (!formatted) continue;
    rows.push(statRow(`aura.${key}`, meta.label, formatted, { kind: "modifier", raw }));
  }
  return rows;
}

/**
 * Build the complete Command Aura / Fleet Buffs section for the inspector.
 * Returns null when the component has no aura.
 */
export function commandAuraSection(stat, ledger, context = {}) {
  const aura = stat?.aura;
  if (!aura) return null;
  const typeLabel = AURA_TYPE_LABELS[aura.type] || aura.type;
  const contextRows = commandAuraContextRows();
  const buffRows = commandAuraBuffRows(stat);
  const allRows = [...contextRows, ...buffRows];
  const kept = ledger.take(allRows);
  if (!kept.length) return null;
  const inactive = context.auraInactive === true;
  return {
    id: "commandAura",
    title: `${typeLabel} Aura`,
    rows: kept,
    inactive,
    note: inactive ? "Aura is inactive: component is unpowered, disconnected, or overheated." : null
  };
}

function powerCategoryLabel(powerCategory) {
  const labels = {
    propulsion: "Propulsion",
    shields: "Shields",
    pointDefence: "Point Defence",
    command: "Command",
    weapons: "Weapons",
    coolingSupport: "Cooling & Support"
  };
  return labels[powerCategory] || null;
}

// ---------------------------------------------------------------------------
// Thermal details section
// ---------------------------------------------------------------------------

function thermalSection(type, stat, ledger, context) {
  if (!hasThermalRelevance(type, stat)) return null;
  const rules = heatRules();
  const profile = heatProfileFor(type, stat);
  const productionText = profile.generation > 0.05
    ? `${heatRate(profile.generation)} ${profile.cadence}`
    : profile.heatPerShot > 0.05
      ? `${heatAmount(profile.heatPerShot)} per firing event`
      : null;
  const rows = [
    statRow("heat.production", "Heat Production", productionText, { tone: "hot" }),
    statRow("heat.capacity", "Heat Capacity", `${profile.capacity} H`),
    statRow("heat.naturalCooling", "Natural Cooling", heatRate(profile.cooling), { tone: "cool" })
  ];

  if (type === "heatVent") {
    rows.push(statRow("heat.role", "Thermal role", thermalRoleText(type)));
  }

  const prediction = context.prediction;
  if (prediction) {
    rows.push(statRow("heat.predictedPeak", "Predicted Peak", `${Math.max(0, Math.round(prediction.ratio * 100))}% of capacity`));
    if (prediction.meltdownTime != null) {
      rows.push(statRow("heat.timeToOverheat", "Time to Overheat", `${prediction.meltdownTime.toFixed(1)}s at sustained load`, { tone: "hot" }));
    }
  }

  const inspectedState = context.heatState !== undefined && context.heatState !== null
    ? context.heatState
    : prediction?.state;
  if (Number.isFinite(Number(inspectedState))) {
    const presentation = getHeatEffectsForComponent(type, stat, inspectedState, rules);
    rows.push(statRow("heat.state", "Heat", presentation.state, { tone: presentation.hasPenalty ? "hot" : "condition" }));
    const penaltyEffects = presentation.effects.filter((effect) => effect.isPenalty);
    const detail = penaltyEffects.length
      ? penaltyEffects.map(formatHeatEffect).join("; ")
      : "Direct Heat penalty: None";
    rows.push(statRow("heat.effect", "State effect", detail, { tone: presentation.hasPenalty ? "hot" : "condition" }));
  } else {
    for (const state of [rules.STATE.HOT, rules.STATE.CRITICAL, rules.STATE.OVERHEATED]) {
      const presentation = getHeatEffectsForComponent(type, stat, state, rules);
      const detail = presentation.effects.length
        ? presentation.effects.map(formatHeatEffect).join("; ")
        : "Direct Heat penalty: None";
      rows.push(statRow(`heat.preview.${state}`, `When ${presentation.state}`, detail, {
        tone: presentation.hasPenalty ? "hot" : "condition"
      }));
    }
  }

  const kept = ledger.take(rows);
  return kept.length ? { id: "thermal", title: "Thermal Details", rows: kept, note: context.thermalNote || null } : null;
}

// ---------------------------------------------------------------------------
// Model assembly
// ---------------------------------------------------------------------------

/**
 * Build the full inspector model for a component.
 *
 * @param {string} type component id
 * @param {object} stat authoritative catalogue entry (PART_STATS[type])
 * @param {object} context { name, description, category, effectiveCost, prediction, droneType, thermalNote }
 */
export function buildComponentInspectorModel(type, stat, context = {}) {
  const family = componentFamily(type, stat);
  const footprint = stat.footprint || { width: 1, height: 1 };
  const ledger = new StatLedger();

  const core = buildCore(type, stat, ledger, context.effectiveCost);
  // The compact thermal summary is claimed before the capability grid so a
  // thermal component states its heat role once, in the summary.
  const thermalSummary = thermalSummaryRows(type, stat, ledger);
  const capability = ledger.take(capabilityRows(type, stat, family, context));
  const commandAura = commandAuraSection(stat, ledger, context);
  const warnings = warningsFor(type, stat, family, context);
  const requirements = requirementsFor(type, stat, context);
  const sections = advancedSections(type, stat, family, ledger, context);
  const thermal = thermalSection(type, stat, ledger, context);
  if (thermal) sections.push(thermal);

  return {
    type,
    family,
    header: {
      name: context.name || type,
      description: inspectorDescription(type, context.description || ""),
      badge: categoryBadge(context.category, footprint),
      category: context.category,
      footprint
    },
    core,
    capability,
    commandAura,
    requirements,
    thermalSummary,
    warnings,
    callouts: componentCallouts({ thermalSummary, requirements, warnings }),
    sections,
    ledger
  };
}
