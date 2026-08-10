// Data-driven presentation model for the Blueprint Designer "Ship summary".
//
// This module owns the information architecture of the summary: which nine
// headline values answer "what have I built?", which conditions deserve a status
// message, and which engineering calculations belong in a collapsed section.
// It renders no markup : designerUi.js turns the model into DOM.
//
// Every number is read from values already computed by computeStats() and the
// authoritative Power analysis. No balance constant or gameplay formula is
// recreated here; the only arithmetic performed is presentation unit conversion
// (radians per second to degrees per second) and percentage differences between
// two already-authoritative numbers.
//
// Canonical stat ids are shared with the component inspector's StatLedger, so a
// value shown in the overview can never be repeated inside a detail section.

import { statRow, StatLedger, isMeaningfulValue } from "./componentInspectorModel.js";
import { formatMass, formatHull, formatShield, formatThrust, formatRepair, formatSpeed, formatPercent, round2 } from "./statFormatting.js";
import { PART_STATS } from "./parts.js";
import { sortStatusCallouts } from "./statusCalloutOrder.js";
import { BRAKE_ACCEL_RATIO, calculateBrakingAcceleration, calculateBrakingDistanceFromDeceleration } from "../shared/movementStats.js";

export { statRow, StatLedger, isMeaningfulValue };

const RAD_TO_DEG = 180 / Math.PI;

/** Presentation-only conversion: turn rates are authored in rad/s, read in °/s. */
export function degreesPerSecond(radiansPerSecond) {
  return Math.round((Number(radiansPerSecond) || 0) * RAD_TO_DEG);
}

/** Turn rates differing by more than this read as genuinely asymmetric. */
const ASYMMETRY_THRESHOLD = 0.05;

/**
 * Turn presentation. Both sides always carry their unit; a single figure is used
 * when the ship turns evenly.
 */
export function turnText(stats) {
  const left = Number(stats.turnRateLeft ?? stats.turnRate ?? 0);
  const right = Number(stats.turnRateRight ?? stats.turnRate ?? 0);
  if (Math.abs(left - right) < 0.01) return `${degreesPerSecond(left)}°/s`;
  return `Left ${degreesPerSecond(left)}°/s · Right ${degreesPerSecond(right)}°/s`;
}

/** Describe asymmetric turning as a percentage difference, or null when even. */
export function turnAsymmetry(stats) {
  const left = Number(stats.turnRateLeft ?? stats.turnRate ?? 0);
  const right = Number(stats.turnRateRight ?? stats.turnRate ?? 0);
  const slower = Math.min(left, right);
  const faster = Math.max(left, right);
  if (faster <= 0) return null;
  const fasterSide = right > left ? "right" : "left";
  const slowerSide = fasterSide === "right" ? "left" : "right";
  // One side unable to turn at all is the extreme case of asymmetry.
  if (slower <= 0) return { side: fasterSide, slowerSide, percent: null, oneSided: true };
  const ratio = faster / slower - 1;
  if (ratio < ASYMMETRY_THRESHOLD) return null;
  return { side: fasterSide, slowerSide, percent: Math.round(ratio * 100), oneSided: false };
}

/**
 * Single authoritative Power view for the whole designer.
 *
 * Prefers the solved Blueprint Power summary and falls back to the ship-stat
 * totals with the same expressions the Power analysis panel already used, so the
 * overview, the status area and Power details can never disagree.
 */
export function resolvePowerSummary(stats, powerSummary = null, options = {}) {
  const summary = (powerSummary && powerSummary.summary) ? powerSummary.summary : (powerSummary || {});
  const generation = Number(summary.availableGenerationMw ?? summary.totalGenerationMw ?? stats.powerGeneration) || 0;
  const requested = Number(summary.demandMw ?? summary.requestedDemandMw ?? stats.powerUse) || 0;
  const delivered = Number(summary.allocatedMw ?? summary.deliveredDemandMw ?? Math.min(generation, requested)) || 0;
  const unmet = Number(summary.unmetMw ?? summary.unmetDemandMw ?? Math.max(0, requested - delivered)) || 0;
  const spare = unmet > 0.0005 ? 0 : (Number(summary.spareGenerationMw ?? summary.reachableSpareMw ?? Math.max(0, generation - requested)) || 0);
  const efficiency = Math.max(0, Math.min(1, Number(summary.powerRatio ?? stats.powerRatio ?? stats.efficiency ?? stats.powerEfficiency) || 0));
  const hasShortfall = unmet > 0.0005;
  const fullyPowered = !hasShortfall && requested > 0.0005;
  const generationDeficit = hasShortfall && generation + 0.0005 < requested;

  const mw = (v) => `${(Math.round(Number(v || 0) * 10) / 10).toFixed(1)} MW`;
  const overviewText = hasShortfall
    ? (generationDeficit ? `${mw(unmet)} generation deficit` : `${mw(unmet)} short`)
    : (requested > 0 ? `${mw(spare)} spare` : "0.0 MW");

  return {
    authoritative: Boolean(powerSummary && (summary.availableGenerationMw !== undefined || summary.totalGenerationMw !== undefined || powerSummary.availableGenerationMw !== undefined)),
    availableGenerationMw: generation,
    activeDemandMw: requested,
    allocatedMw: delivered,
    unmetMw: unmet,
    reachableSpareMw: spare,
    generation,
    requested,
    delivered,
    spare,
    unmet,
    overviewText,
    statusMessageText: overviewText,
    shortfall: hasShortfall,
    hasShortfall,
    fullyPowered,
    efficiency,
    generationDeficit,
    diagnosis: {
      hasShortfall,
      generationDeficit,
      unmetMw: unmet,
      statusMessage: overviewText
    }
  };
}

const mw = (value) => `${Number(value || 0).toFixed(1)} MW`;

/** Human list of the systems a Power shortfall is currently degrading. */
function affectedSystems(stats, power) {
  const affected = [];
  if (Number(stats.effectiveThrust || 0) > 0) affected.push("engines");
  if (Number(stats.maxShield || 0) > 0) affected.push("shields");
  if (Number(stats.weaponDps || 0) > 0) affected.push("weapons");
  if (Number(stats.repairRate || 0) > 0) affected.push("repair");
  return affected;
}

function joinList(items) {
  if (items.length <= 1) return items[0] || "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function turnAuthorityText(value) {
  const amount = Number(value) || 0;
  return amount > 0 ? amount.toFixed(2) : null;
}

function maneuverTurnAuthorityText(stats) {
  const directional = stats.directionalTurn || {};
  const left = Number(directional.anticlockwiseManeuverTurn) || 0;
  const right = Number(directional.clockwiseManeuverTurn) || 0;
  if (left <= 0 && right <= 0) return null;
  return `Left ${left.toFixed(2)} · Right ${right.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Overview : approximately nine headline values
// ---------------------------------------------------------------------------

function overviewRows(stats, power, ledger, includePower = true) {
  const rows = [
    statRow("cost", "Build cost", `$${Number(stats.unitCost || 0).toLocaleString()}`),
    statRow("class", "Class", stats.massClass),
    statRow("mass", "Mass", formatMass(stats.mass)),
    statRow("hull", "Hull", formatHull(stats.maxHp)),
    // A real zero keeps the nine-cell grid stable between designs; "None" would
    // be filtered out and leave a hole. The status area explains the consequence.
    statRow("shield", "Shield", formatShield(stats.maxShield)),
    statRow("weapons", stats.weaponDpsLabel || "Weapon DPS", `${Number(stats.weaponDps || 0)}`),
    statRow("speed", "Max speed", formatSpeed(Math.round(Number(stats.maxSpeed) || 0))),
    statRow("turn", "Turn rate", turnText(stats))
  ];

  // Power is one consolidated item: generation, demand, spare/shortfall and the
  // resulting state, never separate generation / efficiency / penalty cards.
  const powerRow = power.shortfall
    ? statRow("power", "Power", `${mw(power.unmet)} short`, { tone: "bad" })
    : statRow("power", "Power", `${mw(power.spare)} spare`, { tone: power.requested > 0 ? "good" : "neutral" });
  if (includePower && powerRow) {
    rows.push(powerRow);
  }

  return ledger.take(rows.filter(Boolean));
}

// ---------------------------------------------------------------------------
// Status messages : actual conditions, consistent colour, never bare numbers
// ---------------------------------------------------------------------------

const LEVELS = { good: "good", warning: "warning", bad: "bad", neutral: "neutral" };

function statusMessages(stats, power, context) {
  const messages = [];
  const design = Array.isArray(context.design) ? context.design : [];
  const includePower = context.includePower !== false;
  const add = (id, level, text) => { if (isMeaningfulValue(text)) messages.push({ id, level: LEVELS[level] || "neutral", text }); };

  if (Number(context.disconnectedComponentCount || 0) > 0) {
    const count = Number(context.disconnectedComponentCount);
    add("disconnected-components", "bad", `Unconnected components \u00b7 ${count} component${count === 1 ? "" : "s"} disconnected from the ship`);
  }

  // Power
  if (includePower && power.shortfall) {
    const affected = affectedSystems(stats, power);
    add("power-short", "bad", affected.length ? `${mw(power.unmet)} short · ${joinList(affected)} reduced` : `${mw(power.unmet)} short of demand`);
  } else if (includePower && power.requested > 0) {
    add("power-ok", "good", "Fully powered");
  }

  // Mobility
  if (Number(stats.effectiveThrust || 0) <= 0) {
    add("no-thrust", "bad", includePower ? "No effective thrust · add engines or restore Power" : "No effective thrust · add engines");
  }
  const asymmetry = turnAsymmetry(stats);
  if (Math.max(Number(stats.turnRateLeft ?? stats.turnRate ?? 0), Number(stats.turnRateRight ?? stats.turnRate ?? 0)) <= 0) {
    add("no-turn-authority", "warning", "No turn authority · add an Engine, Gyroscope, or Maneuver Thruster");
  }
  if (asymmetry) {
    add("asymmetric-turn", "warning", asymmetry.oneSided
      ? `Asymmetric turning: this ship cannot turn ${asymmetry.slowerSide}`
      : `Asymmetric turning: ${asymmetry.side} turn is ${asymmetry.percent}% faster`);
  }

  // Survivability
  if (Number(stats.maxShield || 0) <= 0) add("no-shield", "warning", "No shield coverage");
  if (Number(stats.weaponDps || 0) <= 0 && Number(stats.pointDefense || 0) <= 0) {
    add("no-weapons", "bad", "No weapons installed · this ship cannot attack");
  }

  // Command
  if (design.some((module) => module?.type === "backupCore")) {
    add("backup-command", "good", "Backup command available");
  }

  // Thermal : reported by the authoritative thermal analysis, not recomputed.
  if (context.overheatingCount > 0) {
    add("cooling", "warning", `Insufficient cooling for sustained combat · ${context.overheatingCount} component${context.overheatingCount === 1 ? "" : "s"} overheat`);
  }

  return sortStatusCallouts(messages);
}

// ---------------------------------------------------------------------------
// Collapsed detail sections
// ---------------------------------------------------------------------------

function mobilitySection(stats, ledger) {
  const hasThrust = Number(stats.effectiveThrust || 0) > 0;
  const left = Number(stats.turnRateLeft ?? stats.turnRate ?? 0);
  const right = Number(stats.turnRateRight ?? stats.turnRate ?? 0);
  const reportedBrakingAcceleration = Number(stats.brakingAcceleration);
  const brakingAcceleration = Number.isFinite(reportedBrakingAcceleration)
    ? reportedBrakingAcceleration
    : calculateBrakingAcceleration(stats.accel);
  const turns = Math.max(left, right) > 0;
  const accelText = (value) => {
    const v = Number(value || 0);
    if (v <= 0) return null;
    return v >= 1 ? `${Math.round(v)} m/s²` : `${v.toFixed(1)} m/s²`;
  };
  const rows = [
    statRow("accel", "Acceleration", hasThrust ? accelText(stats.accel) : null),
    statRow(
      "brakingAcceleration",
      "Braking",
      hasThrust && brakingAcceleration > 0
        ? `${accelText(brakingAcceleration)} (${BRAKE_ACCEL_RATIO}x acceleration)`
        : null
    ),
    statRow("thrust", "Effective Thrust", hasThrust ? formatThrust(stats.effectiveThrust) : null),
    statRow("thrustRatio", "Thrust-to-Mass", hasThrust ? `${round2(stats.thrustRatio)} kN/T` : null),
    statRow("engineEfficiency", "Engine Efficiency", hasThrust ? formatPercent(stats.engineEfficiency) : null),
    statRow("turn.engineVectoring", "Engine vectoring", turnAuthorityText(stats.directionalTurn?.mainEngineVectorTurn)),
    statRow("turn.gyroscopes", "Gyroscopes", turnAuthorityText(stats.directionalTurn?.gyroscopeTurn)),
    statRow("turn.maneuverThrusters", "Maneuver Thrusters", maneuverTurnAuthorityText(stats)),
    statRow("turnLeft", "Left Turn", turns ? `${degreesPerSecond(left)}°/s` : null),
    statRow("turnRight", "Right Turn", turns ? `${degreesPerSecond(right)}°/s` : null),
    statRow("turnCap", "Turn Limit", Number(stats.turnCap || 0) > 0 ? `${degreesPerSecond(stats.turnCap)}°/s` : null),
    statRow("blockedEngines", "Blocked Engines", Number(stats.blockedEngines || 0) > 0 ? `${stats.blockedEngines}` : null, { tone: "warning" })
  ];

  if (hasThrust && Number(stats.accel || 0) > 0 && Number(stats.maxSpeed || 0) > 0) {
    const t50 = ((stats.maxSpeed * 0.5) / stats.accel).toFixed(1);
    const t90 = ((stats.maxSpeed * 0.9) / stats.accel).toFixed(1);
    rows.push(statRow("timeTo50", "Time to 50% speed", `${t50} s`));
    rows.push(statRow("timeTo90", "Time to 90% speed", `${t90} s`));
  }

  if (hasThrust && Number(stats.maxSpeed || 0) > 0) {
    const brakingDist = calculateBrakingDistanceFromDeceleration(stats.maxSpeed, brakingAcceleration);
    if (brakingDist > 0) {
      rows.push(statRow("brakingDistance", "Braking distance", `${Math.round(brakingDist)} m`));
    }
  }

  const speed = Math.round(Number(stats.maxSpeed) || 0);
  const note = hasThrust
    ? `Top speed is set by available thrust (${formatSpeed(speed)}) and the continuous mass-drag curve.`
    : null;

  const kept = ledger.take(rows);
  return kept.length ? { id: "mobility", title: "Mobility Details", rows: kept, note } : null;
}

function powerSection(stats, power, ledger) {
  const rows = [
    statRow("power.basis", "Analysis Basis", !power.authoritative ? "Nominal component totals" : null),
    statRow("power.generation", "Generation", mw(power.generation)),
    statRow("power.demand", "Demand", mw(power.requested)),
    statRow("power.delivered", "Delivered", mw(power.delivered)),
    statRow("power.spare", "Spare", power.spare > 0 ? mw(power.spare) : null, { tone: "good" }),
    statRow("power.unmet", "Unmet", power.unmet > 0 ? mw(power.unmet) : null, { tone: "bad" }),
    statRow("power.efficiency", "Efficiency", formatPercent(power.efficiency)),
    statRow("power.storage", "Energy Storage", Number(stats.energyStorage || 0) > 0 ? `${round2(stats.energyStorage)} MJ` : null)
  ];
  const kept = ledger.take(rows);
  return kept.length ? { id: "power", title: "Power Details", rows: kept } : null;
}

const WEAPON_FAMILY_LABELS = { blaster: "Blaster", missile: "Missile", railgun: "Railgun", beam: "Beam" };

function combatSection(stats, ledger, context = {}) {
  const rows = [];
  const weapons = stats.weapons || {};
  const proximityChargeCount = (context?.design || []).filter((m) => PART_STATS[m.type]?.proximityCharge).length;
  if (proximityChargeCount > 0) {
    rows.push(statRow("weapons.proximityCharge", "Proximity Charges", `${proximityChargeCount}×`));
  }
  // Per-family output and reach come straight from the computed weapon totals.
  for (const [family, label] of Object.entries(WEAPON_FAMILY_LABELS)) {
    const total = weapons[family];
    if (!total || !total.count) continue;
    rows.push(statRow(`weapons.${family}`, label,
      `${total.count}× · ${total.dps} ${total.dpsLabel || "DPS"} · ${Math.round(total.range)} m`));
  }
  const pointDefense = Number(stats.pointDefense || 0);
  rows.push(statRow("weapons.pointDefense", "Point Defence",
    pointDefense > 0 ? `${pointDefense} mount${pointDefense === 1 ? "" : "s"}` : null));
  rows.push(statRow("weapons.beamRadius", "Beam Radius",
    Number(stats.beamRadius || 0) > 0 ? `${round2(stats.beamRadius)} m` : null));
  rows.push(statRow("shieldRegen", "Shield Recharge",
    Number(stats.shieldRegen || 0) > 0 ? `${round2(stats.shieldRegen)} SP/s` : null));

  const kept = ledger.take(rows);
  return kept.length ? { id: "combat", title: "Combat Details", rows: kept } : null;
}

function supportSection(stats, ledger) {
  const repairSourceCount = Number(stats.repairRateSourceCount || 0);
  const multipleRepairSources = repairSourceCount > 1;
  const installedRepair = Number(stats.repairRateInstalled ?? stats.repairRate ?? 0) || 0;
  const effectiveRepair = Number(stats.repairRate || 0) || 0;
  const rows = [
    // Zero-value capabilities are omitted entirely : never "Repair: 0 HP/s".
    statRow("repair", multipleRepairSources ? "Installed/Base Repair" : "Repair Rate", installedRepair > 0 ? formatRepair(installedRepair) : null),
    statRow("repair.effective", "Effective Repair", multipleRepairSources ? formatRepair(effectiveRepair) : null),
    statRow("repair.stacking", "Repair Stacking", multipleRepairSources ? "Diminishing returns" : null),
    statRow("drones", "Drone Capacity", Number(stats.droneCapacity || 0) > 0 ? `${stats.droneCapacity}` : null),
    statRow("dronesByType", "Drone Squads", droneSquadText(stats)),
    statRow("capture", "Capture Pressure", Number(stats.captureBonus || 0) > 0 ? `+${formatPercent(stats.captureBonus)}` : null),
    statRow("cooling", "Cooling Bonus", Number(stats.coolingBonus || 0) > 0 ? `+${formatPercent(stats.coolingBonus)}` : null),
    statRow("sensors.omni", "Omnidirectional Sensors", Number(stats.sensorComponentCount || 0) > 0 ? `${Math.round(stats.sensorRange || 0)} m` : null),
    statRow(
      "sensors.directed",
      "Directed Sensors",
      Number(stats.directedSensorCount || 0) > 0
        ? `${Math.round(stats.directedSensorRange || 0)} m · ${Math.round((stats.directedSensorArc || 0) * 180 / Math.PI)}° cone`
        : null
    )
  ];
  const kept = ledger.take(rows);
  return kept.length ? { id: "support", title: "Support details", rows: kept } : null;
}

function droneSquadText(stats) {
  const byType = stats.dronesByType || {};
  const parts = Object.entries(byType)
    .filter(([, count]) => Number(count) > 0)
    .map(([type, count]) => `${type.replace(/^./, (letter) => letter.toUpperCase())} ${count}`);
  return parts.length ? parts.join(" · ") : null;
}

// ---------------------------------------------------------------------------
// Model assembly
// ---------------------------------------------------------------------------

/**
 * Build the Ship summary model.
 *
 * @param {object} stats computeStats() output (authoritative)
 * @param {object} context { design, powerSummary, overheatingCount }
 */
export function buildShipSummaryModel(stats, context = {}) {
  const ledger = new StatLedger();
  const power = resolvePowerSummary(stats, context.powerSummary, context);
  const includePower = context.includePower !== false;

  const overview = overviewRows(stats, power, ledger, includePower);
  const status = statusMessages(stats, power, context);

  const sections = [];
  for (const section of [
    mobilitySection(stats, ledger),
    includePower ? powerSection(stats, power, ledger) : null,
    combatSection(stats, ledger, context),
    supportSection(stats, ledger)
  ]) {
    if (section) sections.push(section);
  }

  return { overview, status, sections, power, ledger };
}
