// Data-driven presentation model for the Blueprint Designer "Ship summary".
//
// This module owns the information architecture of the summary: which nine
// headline values answer "what have I built?", which conditions deserve a status
// message, and which engineering calculations belong in a collapsed section.
// It renders no markup — designerUi.js turns the model into DOM.
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
export function resolvePowerSummary(stats, powerSummary = null) {
  const summary = powerSummary || {};
  const generation = Number(summary.totalGenerationMw ?? stats.powerGeneration) || 0;
  const requested = Number(summary.requestedDemandMw ?? stats.powerUse) || 0;
  const delivered = Number(summary.deliveredDemandMw ?? Math.min(generation, requested)) || 0;
  const spare = Number(summary.spareGenerationMw ?? Math.max(0, generation - requested)) || 0;
  const unmet = Number(summary.unmetDemandMw ?? Math.max(0, requested - delivered)) || 0;
  return {
    generation,
    requested,
    delivered,
    spare,
    unmet,
    shortfall: unmet > 0.05,
    efficiency: Number(stats.powerEfficiency) || 0,
    penalty: Number(stats.powerDebuff) || 0,
    loadShedCategories: [...(summary.loadShedCategories || [])],
    overloadedSections: (summary.aboveSustainedSectionCount || 0) + (summary.atPeakSectionCount || 0),
    preset: summary.preset ?? null
  };
}

const mw = (value) => `${Number(value || 0).toFixed(1)} MW`;

/** Human list of the systems a Power shortfall is currently degrading. */
function affectedSystems(stats, power) {
  const affected = [];
  if (Number(stats.effectiveThrust || 0) > 0 || power.penalty > 0) affected.push("engines");
  if (Number(stats.maxShield || 0) > 0) affected.push("shields");
  if (Number(stats.weaponDps || 0) > 0) affected.push("weapons");
  if (Number(stats.repairRate || 0) > 0) affected.push("repair");
  return affected;
}

function joinList(items) {
  if (items.length <= 1) return items[0] || "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Overview — approximately nine headline values
// ---------------------------------------------------------------------------

function overviewRows(stats, power, ledger) {
  const rows = [
    statRow("cost", "Build cost", `$${Number(stats.unitCost || 0).toLocaleString()}`),
    statRow("class", "Class", stats.massClass),
    statRow("mass", "Mass", formatMass(stats.mass)),
    statRow("hull", "Hull", formatHull(stats.maxHp)),
    // A real zero keeps the nine-cell grid stable between designs; "None" would
    // be filtered out and leave a hole. The status area explains the consequence.
    statRow("shield", "Shield", formatShield(stats.maxShield)),
    statRow("weapons", "Weapon DPS", `${Number(stats.weaponDps || 0)}`),
    statRow("speed", "Max speed", formatSpeed(Math.round(Number(stats.maxSpeed) || 0))),
    statRow("turn", "Turn rate", turnText(stats))
  ];

  // Power is one consolidated item: generation, demand, spare/shortfall and the
  // resulting state, never separate generation / efficiency / penalty cards.
  const powerRow = power.shortfall
    ? statRow("power", "Power", `${mw(power.unmet)} short`, { tone: "bad" })
    : statRow("power", "Power", `${mw(power.spare)} spare`, { tone: power.requested > 0 ? "good" : "neutral" });
  if (powerRow) {
    rows.push(powerRow);
  }

  return ledger.take(rows.filter(Boolean));
}

// ---------------------------------------------------------------------------
// Status messages — actual conditions, consistent colour, never bare numbers
// ---------------------------------------------------------------------------

const LEVELS = { good: "good", warning: "warning", bad: "bad", neutral: "neutral" };

function statusMessages(stats, power, context) {
  const messages = [];
  const design = Array.isArray(context.design) ? context.design : [];
  const add = (id, level, text) => { if (isMeaningfulValue(text)) messages.push({ id, level: LEVELS[level] || "neutral", text }); };

  // Power
  if (power.shortfall) {
    const affected = affectedSystems(stats, power);
    add("power-short", "bad", affected.length
      ? `${mw(power.unmet)} short · ${joinList(affected)} reduced`
      : `${mw(power.unmet)} short of demand`);
  } else if (power.requested > 0) {
    add("power-ok", "good", "Fully powered");
  }

  // Mobility
  if (Number(stats.effectiveThrust || 0) <= 0) {
    add("no-thrust", "bad", "No effective thrust · add engines or restore Power");
  } else if (stats.speedCapped === true) {
    add("mass-drag", "warning", "Mass is limiting maximum speed");
  }
  const asymmetry = turnAsymmetry(stats);
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

  // Thermal — reported by the authoritative thermal analysis, not recomputed.
  if (context.overheatingCount > 0) {
    add("cooling", "warning", `Insufficient cooling for sustained combat · ${context.overheatingCount} component${context.overheatingCount === 1 ? "" : "s"} overheat`);
  }

  // Infrastructure
  if (power.overloadedSections > 0) {
    add("cable-overload", "warning", `${power.overloadedSections} Power cable section${power.overloadedSections === 1 ? "" : "s"} over its sustained rating`);
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Collapsed detail sections
// ---------------------------------------------------------------------------

function mobilitySection(stats, ledger) {
  // Propulsion figures are meaningless on a ship with no working engines; the
  // status area already reports that outright.
  const hasThrust = Number(stats.effectiveThrust || 0) > 0;
  const left = Number(stats.turnRateLeft ?? stats.turnRate ?? 0);
  const right = Number(stats.turnRateRight ?? stats.turnRate ?? 0);
  const turns = Math.max(left, right) > 0;
  const rows = [
    statRow("accel", "Acceleration", Number(stats.accel || 0) > 0 ? `${Math.round(stats.accel)} m/s²` : null),
    statRow("thrust", "Effective thrust", hasThrust ? formatThrust(stats.effectiveThrust) : null),
    statRow("thrustRatio", "Thrust-to-mass", hasThrust ? `${round2(stats.thrustRatio)} kN/T` : null),
    statRow("engineEfficiency", "Engine efficiency", hasThrust ? formatPercent(stats.engineEfficiency) : null),
    statRow("speedCap", "Mass drag limit", formatSpeed(stats.speedCap)),
    statRow("turnLeft", "Left turn", turns ? `${degreesPerSecond(left)}°/s` : null),
    statRow("turnRight", "Right turn", turns ? `${degreesPerSecond(right)}°/s` : null),
    statRow("turnCap", "Turn limit", Number(stats.turnCap || 0) > 0 ? `${degreesPerSecond(stats.turnCap)}°/s` : null),
    statRow("blockedEngines", "Blocked engines", Number(stats.blockedEngines || 0) > 0 ? `${stats.blockedEngines}` : null, { tone: "warning" })
  ];

  // Explain the relationship between top speed and the drag limit so the two
  // numbers never look contradictory.
  const speed = Math.round(Number(stats.maxSpeed) || 0);
  const cap = Math.round(Number(stats.speedCap) || 0);
  let note = null;
  if (stats.speedCapped === true) {
    // The movement solver applies a soft cap, so thrust beyond the limit still
    // yields a little extra speed. Say so rather than leaving two numbers that
    // look contradictory.
    note = speed >= cap
      ? `Thrust would drive this ship past the ${formatSpeed(stats.speedCap)} mass drag limit; the limit is applied as a soft cap, so top speed settles just above it at ${formatSpeed(speed)}.`
      : `Mass drag caps this ship at ${formatSpeed(stats.speedCap)}; thrust alone would drive it faster.`;
  } else if (hasThrust && cap > 0 && speed < cap) {
    note = `Top speed is set by available thrust (${formatSpeed(speed)}), which is below the ${formatSpeed(stats.speedCap)} mass drag limit.`;
  }

  const kept = ledger.take(rows);
  return kept.length ? { id: "mobility", title: "Mobility details", rows: kept, note } : null;
}

function powerSection(stats, power, ledger) {
  const rows = [
    statRow("power.generation", "Generation", mw(power.generation)),
    statRow("power.demand", "Demand", mw(power.requested)),
    statRow("power.delivered", "Delivered", mw(power.delivered)),
    statRow("power.spare", "Spare", power.spare > 0 ? mw(power.spare) : null, { tone: "good" }),
    statRow("power.unmet", "Unmet", power.unmet > 0 ? mw(power.unmet) : null, { tone: "bad" }),
    statRow("power.efficiency", "Efficiency", formatPercent(power.efficiency)),
    // A zero penalty is not rendered at all — no "Power Penalty: None".
    statRow("power.penalty", "Power penalty", power.penalty > 0 ? `-${formatPercent(power.penalty)}` : null, { tone: "bad" }),
    statRow("power.shed", "Load shed", power.loadShedCategories.length ? power.loadShedCategories.join(", ") : null, { tone: "warning" }),
    statRow("power.overloaded", "Overloaded sections", power.overloadedSections > 0 ? `${power.overloadedSections}` : null, { tone: "warning" }),
    statRow("power.storage", "Energy storage", Number(stats.energyStorage || 0) > 0 ? `${round2(stats.energyStorage)} MJ` : null)
  ];
  const kept = ledger.take(rows);
  return kept.length ? { id: "power", title: "Power details", rows: kept } : null;
}

const WEAPON_FAMILY_LABELS = { blaster: "Blaster", missile: "Missile", railgun: "Railgun", beam: "Beam" };

function combatSection(stats, ledger) {
  const rows = [];
  const weapons = stats.weapons || {};
  // Per-family output and reach come straight from the computed weapon totals.
  for (const [family, label] of Object.entries(WEAPON_FAMILY_LABELS)) {
    const total = weapons[family];
    if (!total || !total.count) continue;
    rows.push(statRow(`weapons.${family}`, label,
      `${total.count}× · ${total.dps} DPS · ${Math.round(total.range)} m`));
  }
  const pointDefense = Number(stats.pointDefense || 0);
  rows.push(statRow("weapons.pointDefense", "Point defence",
    pointDefense > 0 ? `${pointDefense} mount${pointDefense === 1 ? "" : "s"}` : null));
  rows.push(statRow("weapons.beamRadius", "Beam radius",
    Number(stats.beamRadius || 0) > 0 ? `${round2(stats.beamRadius)} m` : null));
  rows.push(statRow("shieldRegen", "Shield recharge",
    Number(stats.shieldRegen || 0) > 0 ? `${round2(stats.shieldRegen)} SP/s` : null));

  const kept = ledger.take(rows);
  return kept.length ? { id: "combat", title: "Combat details", rows: kept } : null;
}

function supportSection(stats, ledger) {
  const rows = [
    // Zero-value capabilities are omitted entirely — never "Repair: 0 HP/s".
    statRow("repair", "Repair rate", Number(stats.repairRate || 0) > 0 ? formatRepair(stats.repairRate) : null),
    statRow("drones", "Drone capacity", Number(stats.droneCapacity || 0) > 0 ? `${stats.droneCapacity}` : null),
    statRow("dronesByType", "Drone squads", droneSquadText(stats)),
    statRow("capture", "Capture pressure", Number(stats.captureBonus || 0) > 0 ? `+${formatPercent(stats.captureBonus)}` : null),
    statRow("cooling", "Cooling bonus", Number(stats.coolingBonus || 0) > 0 ? `+${formatPercent(stats.coolingBonus)}` : null)
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
 * @param {object} context { design, powerSummary, overheatingCount, fleetCount }
 */
export function buildShipSummaryModel(stats, context = {}) {
  const ledger = new StatLedger();
  const power = resolvePowerSummary(stats, context.powerSummary);

  const overview = overviewRows(stats, power, ledger);
  const status = statusMessages(stats, power, context);

  const sections = [];
  for (const section of [
    mobilitySection(stats, ledger),
    powerSection(stats, power, ledger),
    combatSection(stats, ledger),
    supportSection(stats, ledger)
  ]) {
    if (section) sections.push(section);
  }

  return { overview, status, sections, power, ledger };
}
