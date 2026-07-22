(function initSwitchgearRules(root, factory) {
  const onNode = typeof module !== "undefined" && module.exports;
  const wiring = onNode ? require("./wiringRules") : root.WiringRules;
  const rules = factory(wiring);
  if (onNode) module.exports = rules;
  root.SwitchgearRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeSwitchgearRules(WiringRules) {
  "use strict";
  const MODES = Object.freeze(["open", "closed", "automatic"]);
  const RATINGS = Object.freeze(["light", "standard", "heavy"]);
  function normRot(v) { const n = Math.trunc(Number(v) || 0); return ((n % 360) + 360) % 360; }
  function normalizeMode(v) { return MODES.includes(v) ? v : "closed"; }
  function normalizeRatingTier(v) { return RATINGS.includes(v) ? v : "standard"; }
  function normalizeDesignPart(part) {
    if (!part || part.type !== "switchgear") return part;
    return { ...part, switchgearMode: normalizeMode(part.switchgearMode), switchgearRatingTier: normalizeRatingTier(part.switchgearRatingTier) };
  }
  function terminalCells(part) {
    const x = Math.trunc(Number(part?.x) || 0); const y = Math.trunc(Number(part?.y) || 0); const r = normRot(part?.rotation);
    if (r === 90) return { A: { x, y }, B: { x, y: y + 1 }, orientation: "vertical" };
    if (r === 270) return { A: { x, y }, B: { x, y: y - 1 }, orientation: "vertical" };
    if (r === 180) return { A: { x, y }, B: { x: x - 1, y }, orientation: "horizontal" };
    return { A: { x, y }, B: { x: x + 1, y }, orientation: "horizontal" };
  }
  function internalSectionId(index) { return `switchgear:${index}:A-B`; }
  function internalSection(index, part) { const t = terminalCells(part); return { id: internalSectionId(index), x1: t.A.x, y1: t.A.y, x2: t.B.x, y2: t.B.y, tier: normalizeRatingTier(part?.switchgearRatingTier), synthetic: true, switchgearIndex: index }; }
  function sectionKey(a, b) { return [String(a.x) + "," + String(a.y), String(b.x) + "," + String(b.y)].sort().join(":" ); }
  function terminalPairKey(part) { const t = terminalCells(part); return sectionKey(t.A, t.B); }
  function isTerminalBypassSection(part, section) {
    if (!part || part.type !== "switchgear" || !section) return false;
    return terminalPairKey(part) === sectionKey({ x: Math.trunc(Number(section.x1)), y: Math.trunc(Number(section.y1)) }, { x: Math.trunc(Number(section.x2)), y: Math.trunc(Number(section.y2)) });
  }
  function capacityForTier(infra, tier) { const c = infra?.powerTiers?.[normalizeRatingTier(tier)] || {}; return { sustainedCapacityMw: Number(c.sustainedCapacityMw)||0, peakCapacityMw: Number(c.peakCapacityMw)||0 }; }
  return { MODES, RATINGS, normalizeMode, normalizeRatingTier, normalizeDesignPart, terminalCells, internalSectionId, internalSection, terminalPairKey, isTerminalBypassSection, capacityForTier };
}));
