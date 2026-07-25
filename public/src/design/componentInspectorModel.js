// Data-driven presentation model for the Blueprint "Selected Component" inspector.
//
// This module owns the *information architecture* of the inspector: which facts a
// component shows, in what order, and under which heading. It renders no markup —
// partInspectorUi.js turns the model into DOM — so the whole hierarchy stays
// unit-testable without a browser.
//
// Two rules are enforced centrally rather than per component:
//
//   1. Every fact carries a canonical stat id. A StatLedger records which ids have
//      already been emitted, so the same statistic can never appear twice (for
//      example DPS in both Primary capability and Weapon details).
//   2. Meaningless values — zero bonuses, 100% "modifiers", None/Not applicable,
//      empty strings — are dropped at construction time instead of being rendered
//      as noise.
//
// All numbers come from the authoritative component catalogue (PART_STATS, itself
// built from component-balance.json) and the shared rules modules. No balance
// constant is restated here.

import { formatMass, formatHull, formatShield, formatThrust, formatEnergy, formatRepair, formatDistance, formatSpeed, formatDamage, formatPercent } from "./statFormatting.js";

// ---------------------------------------------------------------------------
// Value hygiene
// ---------------------------------------------------------------------------

const EMPTY_VALUES = new Set(["", "none", "n/a", "na", "not applicable", "unavailable", "-", "—"]);

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
 *   "modifier" — a ×multiplier; hidden when it equals the 100% no-op.
 *   "bonus"    — an additive bonus; hidden when it is zero.
 *   "value"    — shown whenever the formatted text is meaningful (default).
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
  Support: "SUPPORT",
  "Power Infrastructure": "POWER INFRA"
};

/** `WEAPON · 1×1` — category and footprint in one compact badge. */
export function categoryBadge(category, footprint = { width: 1, height: 1 }) {
  const label = CATEGORY_BADGES[category] || String(category || "COMPONENT").toUpperCase();
  return `${label} · ${footprint.width || 1}×${footprint.height || 1}`;
}

// ---------------------------------------------------------------------------
// Shared formatting helpers
// ---------------------------------------------------------------------------

const heatRules = () => globalThis.HeatRules;
const turretRules = () => globalThis.TurretRules;

function heatRate(value) { return `${Number(value).toFixed(1)} Heat/s`; }
function degrees(value) { return `${Math.round(value)}°`; }

function aimSpeedText(value) {
  if (value === undefined || value === null) return "Instant";
  return `${Math.round(value * (180 / Math.PI))}°/s`;
}

/**
 * Sustained heat output for a component, using the same shared HeatRules activity
 * model the thermal simulation uses. Generators, thrusters and rechargers have
 * activity-specific curves; everything else falls back to the catalogue value.
 */
export function heatProfileFor(type, stat) {
  const rules = heatRules();
  const profile = rules.profile(type, stat);
  let generation = rules.activityHeat(type, stat);
  let cadence = "while active";
  if (stat.weapon) {
    cadence = stat.weapon.type === "beam" ? "while firing" : "at sustained fire";
  } else if ((stat.powerGeneration || 0) > 0) {
    generation = 2 + stat.powerGeneration * 0.42;
    cadence = "at power load";
  } else if ((stat.thrust || 0) > 0) {
    generation = 2 + stat.thrust * 0.018;
    cadence = "while thrusting";
  } else if ((stat.shieldRegen || 0) > 0) {
    generation = stat.shieldRegen * 0.7;
    cadence = "while recharging";
  }
  return { generation, cadence, capacity: profile.capacity, cooling: profile.cooling };
}

const THERMAL_ROLE_TYPES = new Set(["radiator", "heatSink", "heatPipe"]);

/**
 * Whether a component has heat behaviour worth its own panel. Passive structure
 * (a bare Frame) deliberately reports false so it stays compact instead of
 * showing an empty accordion.
 */
export function hasThermalRelevance(type, stat) {
  if (THERMAL_ROLE_TYPES.has(type)) return true;
  if (heatProfileFor(type, stat).generation > 0.05) return true;
  return Boolean(stat.weapon) || (stat.powerGeneration || 0) > 0;
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
  // once — the ledger stops it reappearing in any later grid.
  const generation = stat.powerGeneration || 0;
  const use = stat.powerUse || 0;
  if (generation > 0) rows.push(statRow("power", "Power output", `${generation} MW`, { tone: "supply" }));
  else if (use > 0) rows.push(statRow("power", "Power draw", `${use} MW`, { tone: "demand" }));
  return ledger.take(rows);
}

// ---------------------------------------------------------------------------
// Primary capability — per family
// ---------------------------------------------------------------------------

function weaponCapability(stat) {
  const weapon = stat.weapon;
  const rows = [statRow("weapon.dps", "DPS", weapon.dps.toFixed(1))];
  rows.push(statRow("weapon.range", "Range", formatDistance(weapon.range)));
  // A "cannot miss" weapon states its guarantee instead of a redundant 100%.
  if ((weapon.accuracy ?? 1) >= 1) rows.push(statRow("weapon.accuracy", "Accuracy", "Cannot miss"));
  else rows.push(statRow("weapon.accuracy", "Accuracy", formatPercent(weapon.accuracy)));
  rows.push(statRow("weapon.arc", "Firing arc", degrees(weapon.arc || 360)));
  return rows;
}

function capabilityRows(type, stat, family) {
  switch (family) {
    case "weapon":
      return weaponCapability(stat);

    case "defence": {
      if (stat.weapon) return weaponCapability(stat);
      const rows = [
        statRow("shield.capacity", "Shield capacity", (stat.shield || 0) > 0 ? formatShield(stat.shield) : null),
        statRow("shield.regen", "Regeneration", (stat.shieldRegen || 0) > 0 ? `${stat.shieldRegen} SP/s` : null)
      ];
      if ((stat.frontDamageReduction || 0) > 0) {
        rows.push(statRow("defence.frontReduction", "Frontal reduction", formatPercent(stat.frontDamageReduction)));
        rows.push(statRow("defence.frontArc", "Covered arc", degrees(stat.frontArc || 0)));
      }
      return rows;
    }

    case "power": {
      const rows = [];
      // Power output already appears in the core row; the ledger drops the repeat
      // and leaves storage as the meaningful capability for batteries/capacitors.
      if ((stat.powerGeneration || 0) > 0) rows.push(statRow("power", "Power output", `${stat.powerGeneration} MW`));
      const capacity = stat.energyCapacity || stat.energyStorage || 0;
      if (capacity > 0) rows.push(statRow("power.storage", "Energy capacity", formatEnergy(capacity)));
      if ((stat.maxChargeRate || 0) > 0) rows.push(statRow("power.chargeRate", "Max charge rate", `${stat.maxChargeRate} MW`));
      if ((stat.maxDischargeRate || 0) > 0) rows.push(statRow("power.dischargeRate", "Max discharge rate", `${stat.maxDischargeRate} MW`));
      if ((stat.chargeEfficiency || 0) > 0 && stat.chargeEfficiency < 1) rows.push(statRow("power.chargeEff", "Charge efficiency", formatPercent(stat.chargeEfficiency)));
      if ((stat.dischargeEfficiency || 0) > 0 && stat.dischargeEfficiency < 1) rows.push(statRow("power.dischargeEff", "Discharge efficiency", formatPercent(stat.dischargeEfficiency)));
      if ((stat.dischargeHeatAtMax || 0) > 0) rows.push(statRow("power.dischargeHeat", "Max discharge heat", heatRate(stat.dischargeHeatAtMax)));
      if ((stat.shield || 0) > 0) rows.push(statRow("shield.capacity", "Shield capacity", formatShield(stat.shield)));
      return rows;
    }

    case "propulsion": {
      const rows = [];
      if ((stat.thrust || 0) > 0) rows.push(statRow("thrust", "Thrust", formatThrust(stat.thrust)));
      if ((stat.lateralThrust || 0) > 0) rows.push(statRow("thrust.lateral", "Lateral thrust", formatThrust(stat.lateralThrust)));
      if ((stat.turn || 0) > 0) rows.push(statRow("turn", "Turn rate", `${stat.turn}`));
      return rows;
    }

    case "command": {
      const rows = [];
      if ((stat.powerGeneration || 0) > 0) rows.push(statRow("power", "Power output", `${stat.powerGeneration} MW`));
      if ((stat.energyStorage || 0) > 0) rows.push(statRow("power.storage", "Energy storage", formatEnergy(stat.energyStorage)));
      return rows;
    }

    case "structure": {
      // A plain Frame has no capability beyond its core specification row, and
      // deliberately renders no capability group at all.
      const rows = [];
      if ((stat.armorFlatReduction || 0) > 0) {
        rows.push(statRow("armor.reduction", "Damage reduction", `${stat.armorFlatReduction} per hit`));
      }
      return rows;
    }

    default: {
      const rows = [];
      if (type === "droneBay" && stat.droneConfig) {
        const config = stat.droneConfig;
        rows.push(statRow("drone.squad", "Active drones", `${config.squadSize} per bay`));
        rows.push(statRow("drone.maxActive", "Ship limit", `${config.maxActivePerShip} drones`));
      }
      if ((stat.repairRate || 0) > 0) rows.push(statRow("repair.rate", "Repair rate", formatRepair(stat.repairRate)));
      rows.push(statRow("bonus.range", "Weapon range bonus", (stat.rangeBonus || 0) ? `+${formatDistance(stat.rangeBonus)}` : null, { kind: "bonus", raw: stat.rangeBonus }));
      rows.push(statRow("bonus.accuracy", "Accuracy bonus", `+${formatPercent(stat.accuracyBonus)}`, { kind: "bonus", raw: stat.accuracyBonus }));
      rows.push(statRow("bonus.fireRate", "Fire rate bonus", `+${formatPercent(stat.fireRateBonus)}`, { kind: "bonus", raw: stat.fireRateBonus }));
      rows.push(statRow("bonus.capture", "Capture pressure", `+${formatPercent(stat.captureBonus)}`, { kind: "bonus", raw: stat.captureBonus }));
      rows.push(statRow("bonus.ecm", "Missile tracking penalty", `-${formatPercent(stat.ecmStrength)}`, { kind: "bonus", raw: stat.ecmStrength }));
      // Heat storage / cooling / transfer are stated once, by the compact thermal
      // summary built ahead of this grid.
      return rows;
    }
  }
}

function thermalRoleText(type) {
  if (type === "radiator") return "Removes heat from the ship";
  if (type === "heatSink") return "Stores heat for adjacent components";
  if (type === "heatPipe") return "Transfers heat to sinks and radiators";
  return "Thermal support";
}

// ---------------------------------------------------------------------------
// Compact thermal summary (overview)
// ---------------------------------------------------------------------------

function thermalSummaryRows(type, stat, ledger) {
  if (!hasThermalRelevance(type, stat)) return [];
  const profile = heatProfileFor(type, stat);
  const rows = [];
  if (profile.generation > 0.05) {
    rows.push(statRow("heat.production", "Heat", `Produces ${heatRate(profile.generation)} ${profile.cadence}`, { tone: "hot" }));
  }
  if (type === "heatSink") rows.push(statRow("heat.storage", "Heat", `Stores ${profile.capacity} Heat`));
  if (type === "radiator") rows.push(statRow("heat.cooling", "Cooling", `Removes ${heatRate(profile.cooling)}`, { tone: "cool" }));
  if (type === "heatPipe") rows.push(statRow("heat.role", "Thermal role", thermalRoleText(type)));
  return ledger.take(rows);
}

// ---------------------------------------------------------------------------
// Warnings — risks and restrictions never live in ordinary stat cards
// ---------------------------------------------------------------------------

function warningsFor(type, stat, family) {
  const rules = heatRules();
  const warnings = [];

  if (family === "power" && (stat.powerGeneration || 0) > 0) {
    warnings.push({
      id: "meltdown",
      title: "Meltdown risk",
      body: `Explodes after ${rules.REACTOR_MELTDOWN_SECONDS} seconds continuously overheated, dealing ${rules.REACTOR_EXPLOSION_DAMAGE} damage within ${rules.REACTOR_EXPLOSION_RADIUS} tiles.`
    });
  }

  if (type === "core") {
    warnings.push({
      id: "command-loss",
      title: "Command loss",
      body: "Destroying this component destroys the ship unless a Backup Command Core is installed and powered."
    });
  }

  if (type === "backupCore") {
    warnings.push({
      id: "backup-command",
      title: "Backup command",
      body: "Takes over when the main Core is destroyed, at reduced weapon accuracy. It must stay powered or the ship is lost shortly after."
    });
  }

  if (Number(stat.maxPerShip) === 1) {
    warnings.push({ id: "one-per-ship", title: "One per ship", body: "Only one of this component may be installed on a ship." });
  }

  if (type === "radiator") {
    warnings.push({
      id: "exposure",
      title: "Needs an exposed edge",
      body: "Cooling drops to a fraction of its rated output when the radiator is fully enclosed by other components."
    });
  }

  if (type === "droneBay") {
    warnings.push({
      id: "launch-edge",
      title: "Needs a launch edge",
      body: "One complete two-cell edge must face open space or the bay cannot launch."
    });
  }

  // Power and Data dependencies are not warnings. They are ordinary, extremely
  // common requirements, so they render as a compact requirements row instead of
  // full-width callouts (see requirementsFor). Only exceptional behaviour —
  // meltdown, command loss, placement restrictions — earns a warning panel.

  return warnings;
}

// ---------------------------------------------------------------------------
// Requirements — compact, always-grouped resource dependencies
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
  const status = context.requirementStatus || {};
  const requirements = [];

  if ((stat.powerUse || 0) > 0) {
    requirements.push({
      id: "power",
      label: "Power",
      icon: "⚡",
      summary: `${stat.powerUse} MW`,
      detail: `Draws ${stat.powerUse} MW from a connected Power network. It stops working when that draw is not met.`,
      status: status.power?.state || "unplaced",
      failureText: status.power?.reason || null
    });
  }

  if (stat.rangeBonus || stat.accuracyBonus || stat.fireRateBonus) {
    requirements.push({
      id: "data",
      label: "Data",
      icon: "◇",
      summary: "Cable link",
      detail: "Supports only weapons joined to it by Data cable. Its bonus is split evenly between every weapon on that network.",
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
    ? "Not connected to any Power network."
    : entry.state === "unpowered"
      ? "Connected, but receiving no Power."
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
// Advanced sections — context-specific headings, collapsed by default
// ---------------------------------------------------------------------------

function weaponDetailRows(type, stat) {
  const weapon = stat.weapon;
  const rows = [];
  if (weapon.type === "beam") {
    rows.push(statRow("weapon.damage", "Damage", `${formatDamage(weapon.damage)}/s`));
    rows.push(statRow("weapon.radius", "Beam radius", formatDistance(weapon.radius || 0)));
  } else {
    rows.push(statRow("weapon.damage", "Damage per shot", formatDamage(weapon.damage)));
    // Fire rate and reload are the same fact twice — only fire rate is shown.
    rows.push(statRow("weapon.fireRate", "Fire rate", `${weapon.fireRate} shots/s`));
    rows.push(statRow("weapon.projectileSpeed", "Projectile speed", (Number(weapon.projectileSpeed) || 0) > 0 ? formatSpeed(weapon.projectileSpeed) : "Hitscan"));
  }
  rows.push(statRow("weapon.traverse", "Turret traverse", aimSpeedText(turretRules().turnRateFor(weapon))));
  rows.push(statRow("weapon.vsShields", "Vs shields", formatMultiplierPercent(weapon.shieldDamageMultiplier), { kind: "modifier", raw: weapon.shieldDamageMultiplier ?? 1 }));
  rows.push(statRow("weapon.vsHull", "Vs hull", formatMultiplierPercent(weapon.hullDamageMultiplier), { kind: "modifier", raw: weapon.hullDamageMultiplier ?? 1 }));

  if (weapon.type === "missile") {
    rows.push(statRow("weapon.tracking", "Tracking", formatPercent(weapon.tracking)));
    rows.push(statRow("weapon.trackTime", "Track time", `${weapon.trackTime}s`));
    rows.push(statRow("weapon.lockDelay", "Lock delay", `${weapon.trackingDelay}s`));
    rows.push(statRow("weapon.missileHp", "Missile HP", `${weapon.missileHp}`));
  }
  if (weapon.burnThroughCarryMultiplier || type === "beamEmitter") {
    rows.push(statRow("weapon.targeting", "Targeting", "Core-directed"));
    rows.push(statRow("weapon.burnThrough", "Burn-through", `${Math.round((weapon.burnThroughCarryMultiplier || 0.4) * 100)}% of excess damage`));
    rows.push(statRow("weapon.penetration", "Maximum penetration", "1 additional component"));
  }
  if (weapon.antiMissile) {
    rows.push(statRow("weapon.antiMissile", "Anti-missile", "Yes"));
    if (type === "pointDefense" || (Number(weapon.projectileSpeed) || 0) === 0) {
      rows.push(statRow("weapon.firingMode", "Firing mode", "Hitscan — cannot miss once aligned"));
    }
    if (weapon.targetPriority?.length) {
      rows.push(statRow("weapon.targetPriority", "Target priority", weapon.targetPriority.join(", ")));
    }
    rows.push(statRow("weapon.vsShips", "Ship damage", `${Math.round((weapon.shipDamageMultiplier ?? 0.04) * 100)}% — negligible against ships`));
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

  if (stat.weapon) push("weapon", "Weapon details", weaponDetailRows(type, stat));

  if (family === "power" || family === "command") {
    push("power", "Power details", [
      statRow("power.category", "Priority band", powerBandLabel(stat.powerCategory)),
      statRow("power.storage", "Energy storage", (stat.energyStorage || 0) > 0 ? formatEnergy(stat.energyStorage) : null)
    ]);
  }

  if (family === "defence" && !stat.weapon) {
    push("shield", "Shield details", [
      statRow("shield.capacity", "Shield capacity", (stat.shield || 0) > 0 ? formatShield(stat.shield) : null),
      statRow("shield.regen", "Regeneration", (stat.shieldRegen || 0) > 0 ? `${stat.shieldRegen} SP/s` : null),
      statRow("shield.stacking", "Stacking", "Capacity from every Shield on the ship pools into one bubble.")
    ]);
  }

  if (type === "droneBay" && stat.droneConfig) {
    const config = stat.droneConfig;
    const selected = context.droneType && config.types?.[context.droneType];
    push("drone", "Drone details", [
      statRow("drone.role", "Drone role", selected ? selected.label : "Not selected"),
      statRow("drone.rebuild", "Rebuild time", selected ? `${selected.productionSeconds}s` : null),
      statRow("drone.commandRange", "Command range", selected ? formatDistance(selected.commandRange) : null),
      statRow("drone.launchInterval", "Launch interval", `${config.launchIntervalSeconds}s`),
      statRow("drone.bays", "Bays per ship", `${config.maxBaysPerShip}`),
      statRow("drone.power", "Power by state", `${config.standbyPowerMw} / ${config.activePowerMw} / ${config.productionPowerMw} MW standby · active · building`)
    ]);
  }

  if ((stat.repairRate || 0) > 0) {
    push("repair", "Repair details", [
      statRow("repair.rate", "Repair rate", formatRepair(stat.repairRate)),
      statRow("repair.target", "Targeting", type === "repairBeam" ? "Projects onto a damaged allied ship in range." : "Repairs this ship's damaged components.")
    ]);
  }

  if (stat.rangeBonus || stat.accuracyBonus || stat.fireRateBonus) {
    push("sensor", "Sensor details", [
      statRow("bonus.range", "Weapon range bonus", (stat.rangeBonus || 0) ? `+${formatDistance(stat.rangeBonus)}` : null, { kind: "bonus", raw: stat.rangeBonus }),
      statRow("bonus.accuracy", "Accuracy bonus", `+${formatPercent(stat.accuracyBonus)}`, { kind: "bonus", raw: stat.accuracyBonus }),
      statRow("bonus.fireRate", "Fire rate bonus", `+${formatPercent(stat.fireRateBonus)}`, { kind: "bonus", raw: stat.fireRateBonus }),
      statRow("bonus.sharing", "Allocation", "Split evenly between every weapon on the same Data network.")
    ]);
  }

  if (family === "command") {
    push("command", "Command details", [
      statRow("command.role", "Role", type === "backupCore" ? "Secondary command" : "Primary command"),
      statRow("command.accuracy", "Backup accuracy", type === "backupCore" ? "85% of normal weapon accuracy while active" : null)
    ]);
  }

  if (family === "propulsion") {
    push("propulsion", "Propulsion details", [
      statRow("thrust.speed", "Speed contribution", "Total thrust divided by total ship mass."),
      statRow("thrust.placement", type === "maneuverThruster" ? "Placement" : "Facing",
        type === "maneuverThruster" ? "Turning strength scales with distance from the centre of mass." : null)
    ]);
  }

  return sections;
}

function powerBandLabel(powerCategory) {
  const labels = {
    propulsion: "Propulsion",
    shields: "Shields",
    pointDefence: "Point defence",
    command: "Command",
    weapons: "Weapons",
    coolingSupport: "Cooling & support"
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
  const rows = [
    statRow("heat.production", "Heat production", profile.generation > 0.05 ? `${heatRate(profile.generation)} ${profile.cadence}` : null, { tone: "hot" }),
    statRow("heat.capacity", "Heat capacity", `${profile.capacity} Heat`),
    statRow("heat.naturalCooling", "Natural cooling", heatRate(profile.cooling), { tone: "cool" })
  ];

  const prediction = context.prediction;
  if (prediction) {
    rows.push(statRow("heat.predictedPeak", "Predicted peak", `${Math.min(100, Math.round(prediction.ratio * 100))}% of capacity`));
    rows.push(statRow("heat.state", "Expected state", rules.STATE_LABELS[prediction.state]));
    if (prediction.meltdownTime != null) {
      rows.push(statRow("heat.timeToOverheat", "Time to overheat", `${prediction.meltdownTime.toFixed(1)}s at sustained load`, { tone: "hot" }));
    }
  }

  const activeLabel = activeOutputLabel(stat);
  if (activeLabel) {
    const pct = (value) => `${Math.round(value * 100)}%`;
    const active = rules.activeOutputForState || rules.performanceForState;
    rows.push(statRow("heat.hot", "When Hot", `${pct(active(rules.STATE.HOT))} ${activeLabel}`));
    rows.push(statRow("heat.critical", "When Critical", `${pct(active(rules.STATE.CRITICAL))} ${activeLabel}`));
    rows.push(statRow("heat.overheated", "When Overheated", `${activeLabel} offline`));
  }
  rows.push(statRow("heat.recovery", "Recovery", `Below ${Math.round((rules.THRESHOLDS.overheated - rules.HYSTERESIS.overheated) * 100)}% heat`));

  const kept = ledger.take(rows);
  return kept.length ? { id: "thermal", title: "Thermal details", rows: kept, note: context.thermalNote || null } : null;
}

function activeOutputLabel(stat) {
  if (stat.weapon) return stat.weapon.type === "beam" ? "beam output" : "fire rate";
  if ((stat.thrust || 0) > 0 || (stat.lateralThrust || 0) > 0) return "thrust";
  if ((stat.shieldRegen || 0) > 0) return "recharge rate";
  if ((stat.repairRate || 0) > 0) return "repair output";
  if ((stat.powerGeneration || 0) > 0) return "power output";
  if (stat.rangeBonus || stat.accuracyBonus || stat.fireRateBonus || stat.captureBonus || stat.ecmStrength) return "bonus effectiveness";
  return null;
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
  const capability = ledger.take(capabilityRows(type, stat, family));
  const warnings = warningsFor(type, stat, family);
  const requirements = requirementsFor(type, stat, context);
  const sections = advancedSections(type, stat, family, ledger, context);
  const thermal = thermalSection(type, stat, ledger, context);
  if (thermal) sections.push(thermal);

  return {
    type,
    family,
    header: {
      name: context.name || type,
      description: context.description || "",
      badge: categoryBadge(context.category, footprint),
      category: context.category,
      footprint
    },
    core,
    capability,
    requirements,
    thermalSummary,
    warnings,
    sections,
    ledger
  };
}
