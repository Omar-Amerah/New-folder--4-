import { computeStats } from "../design/componentStats.js";
import { shipHeatPercent, formatHeatPercent } from "../shared/heatDisplay.js";

const STYLE_LABELS = { charge: "Charge", hold: "Hold", sentry: "Sentry", circle: "Circle" };
export const STYLE_DESCRIPTIONS = {
  charge: "Move aggressively toward the current command or target.",
  hold: "Hold the ordered position while weapons engage in range.",
  sentry: "Guard the current area and engage nearby threats.",
  circle: "Orbit a selected target when possible while firing."
};

const COMPARE_STATS = [
  ["unitCost", "Unit cost", "$"], ["mass", "Mass", "t"], ["maxHp", "Hull", "HP"],
  ["frontDamageReduction", "Armour / DR", "%"], ["maxShield", "Shield", "SP"], ["shieldRegen", "Shield regen", "SP/s"],
  ["powerGeneration", "Power generated", "MW"], ["powerUse", "Power required", "MW"], ["energyStorage", "Energy storage", "MJ"],
  ["effectiveThrust", "Thrust", "kN"], ["maxSpeed", "Est. max speed", "u/s"], ["turnRate", "Est. turning", "°/s"],
  ["repairRate", "Repair rate", "HP/s"], ["coolingBonus", "Cooling", ""], ["weaponDps", "Weapon DPS", "DPS"],
  ["blasterDps", "Blaster DPS", "DPS"], ["missileDps", "Missile DPS", "DPS"], ["railgunDps", "Railgun DPS", "DPS"], ["beamDps", "Beam DPS", "DPS"],
  ["maxWeaponRange", "Weapon range", "m"]
];

function enrich(stats) {
  const weapons = stats?.weapons || {};
  const ranges = [stats?.blasterRange, stats?.missileRange, stats?.railgunRange, stats?.beamRange].map(Number).filter(Number.isFinite);
  return {
    ...stats,
    blasterDps: weapons.blaster?.dps,
    missileDps: weapons.missile?.dps,
    railgunDps: weapons.railgun?.dps,
    beamDps: weapons.beam?.dps,
    maxWeaponRange: ranges.length ? Math.max(...ranges) : 0
  };
}

export function blueprintComparisonRows(currentBlueprint, savedBlueprint, currentWiring = null, savedWiring = null) {
  const current = enrich(computeStats(Array.isArray(currentBlueprint) ? currentBlueprint : [], { wiring: currentWiring }));
  const saved = enrich(computeStats(Array.isArray(savedBlueprint) ? savedBlueprint : [], { wiring: savedWiring }));
  return COMPARE_STATS.map(([key, label, unit]) => {
    const c = Number(current[key]);
    const s = Number(saved[key]);
    if (!Number.isFinite(c) || !Number.isFinite(s)) return null;
    const delta = Number((c - s).toFixed(2));
    return { key, label, unit, current: c, saved: s, delta };
  }).filter(Boolean);
}

export function formatDelta(value, unit = "") {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value)}${unit ? ` ${unit}` : ""}`;
}
export function formatNumber(value) { return Number.isInteger(value) ? String(value) : Number(value).toFixed(1).replace(/\.0$/, ""); }
export function formatPowerState(generated, required, efficiency) {
  const gen = Number(generated || 0), req = Number(required || 0);
  const eff = Number.isFinite(Number(efficiency)) ? Number(efficiency) : (req > 0 ? Math.min(1.08, gen / Math.max(req, 1)) : 1.08);
  const state = req > gen ? (eff < 0.5 ? "Severely power-starved" : "Reduced efficiency") : "Normal";
  return `${formatNumber(gen)} / ${formatNumber(req)} MW · ${state} (${Math.round(eff * 100)}%)`;
}
export function formatFleet(current, cap) { return Number.isFinite(Number(cap)) ? `${current} / ${cap}` : `${current}`; }
export function formatTeamHud(team) { return team ? `Team ${team}` : "Solo"; }

export function selectedShipSummary(ships) {
  const list = Array.isArray(ships) ? ships.filter(Boolean) : [];
  if (list.length === 0) return { text: "No ships selected", style: "" };
  if (list.length === 1) return oneShipSummary(list[0]);
  const hull = sumPair(list, "hp", "maxHp");
  const shield = sumPair(list, "shield", "maxShield");
  const hot = Math.max(...list.map(shipHeatPercent));
  const overheatedShips = list.filter((s) => Number(s.overheated || 0) > 0).length;
  const powerStarved = list.filter((s) => isPowerStarved(s)).length;
  const styles = distribution(list.map((s) => normalizeStyle(s.combatStyle)));
  const order = commonText(list.map((s) => s.order || s.currentOrder));
  const target = commonText(list.map((s) => s.targetName || s.target));
  return { text: `${list.length} ships · Hull ${formatNumber(hull.current)}/${formatNumber(hull.max)} (${pct(hull.current, hull.max)}) · Shield ${formatNumber(shield.current)}/${formatNumber(shield.max)} (${pct(shield.current, shield.max)}) · Hottest ${formatHeatPercent(hot)} · ${overheatedShips} overheated · ${powerStarved} power-starved · Styles ${styles} · ${order || "No orders"} · ${target || "No target"}`, style: commonStyle(list) || "Mixed" };
}
function oneShipSummary(ship) {
  const style = normalizeStyle(ship.combatStyle);
  const livePower = ship.powerThermal || {};
  const generated = livePower.powerGenerationMw ?? ship.powerGeneration ?? ship.stats?.powerGeneration;
  const required = livePower.requestedDemandMw ?? ship.powerUse ?? ship.stats?.powerUse;
  const delivered = Number(livePower.deliveredDemandMw);
  const liveEfficiency = Number(required) > 0 && Number.isFinite(delivered)
    ? delivered / Number(required)
    : ship.powerEfficiency ?? ship.efficiency ?? ship.stats?.efficiency;
  const power = formatPowerState(generated, required, liveEfficiency);
  const ranges = [ship.blasterRange, ship.missileRange, ship.railgunRange, ship.beamRange].map(Number).filter(Number.isFinite);
  const range = ranges.length ? Math.max(...ranges) : 0;
  return { text: `Hull ${formatNumber(ship.hp)}/${formatNumber(ship.maxHp)} · Shield ${formatNumber(ship.shield || 0)}/${formatNumber(ship.maxShield || 0)} · Heat ${formatHeatPercent(shipHeatPercent(ship))} · ${Number(ship.overheated || 0)} overheated · Speed ${formatNumber(ship.speed || 0)} · Power ${power} · Range ${formatNumber(range)} · Style ${STYLE_LABELS[style] || style} · ${ship.order || ship.currentOrder || "No order"}${ship.targetName ? ` · Target ${ship.targetName}` : ""}`, style };
}
function sumPair(list, cur, max) { return list.reduce((a, s) => ({ current: a.current + Number(s[cur] || 0), max: a.max + Number(s[max] || 0) }), { current: 0, max: 0 }); }
function pct(c, m) { return m > 0 ? `${Math.round((c / m) * 100)}%` : "0%"; }
function isPowerStarved(s) {
  const power = s.powerThermal || {};
  const requested = Number(power.requestedDemandMw ?? s.powerUse ?? s.stats?.powerUse);
  const delivered = Number(power.deliveredDemandMw);
  if (Number.isFinite(requested) && Number.isFinite(delivered)) return requested > delivered;
  const generated = Number(power.powerGenerationMw ?? s.powerGeneration ?? s.stats?.powerGeneration);
  return Number.isFinite(generated) && Number.isFinite(requested) && requested > generated;
}
function distribution(values) { const counts = new Map(); values.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1)); return [...counts].map(([k, v]) => `${STYLE_LABELS[k] || k} ${v}`).join(", "); }
function commonText(values) { const clean = values.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()); if (!clean.length) return ""; return clean.every((v) => v === clean[0]) ? clean[0] : clean[0]?.includes("target") ? "Mixed targets" : "Mixed orders"; }
export function normalizeStyle(style) { return STYLE_LABELS[style] ? style : "charge"; }
export function commonStyle(ships) { if (!ships.length) return null; const first = normalizeStyle(ships[0].combatStyle); return ships.every((s) => normalizeStyle(s.combatStyle) === first) ? first : null; }
