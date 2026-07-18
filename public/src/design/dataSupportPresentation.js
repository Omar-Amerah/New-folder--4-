function rules() { return globalThis.DataSupportRules; }
const LABELS = { rangeBonus: "range", accuracyBonus: "accuracy", fireRateBonus: "fire rate" };
export function descriptorForBonusField(bonusField) {
  const info = rules()?.DATA_SOURCE_INFO || {};
  return Object.values(info).find((d) => d.bonusField === bonusField) || { bonusField, effect: LABELS[bonusField] || bonusField, unit: bonusField === "rangeBonus" ? "m" : "percent" };
}
export function formatDataSupportValue({ bonusField, amount, signed = true } = {}) {
  const value = Number(amount) || 0;
  const descriptor = descriptorForBonusField(bonusField);
  const sign = signed && value >= 0 ? "+" : "";
  if (descriptor.unit === "m") return `${sign}${Math.round(value)} m`;
  return `${sign}${(value * 100).toFixed(1)}%`;
}
export function formatDataSupportEquation(source) {
  const bonusField = source?.bonusField || rules()?.supportDescriptorForType?.(source?.sourceType)?.bonusField;
  const effect = source?.effect || descriptorForBonusField(bonusField).effect;
  return `${formatDataSupportValue({ bonusField, amount: source?.effectiveBudget })} ÷ ${source?.recipientCount || 0} recipients = ${formatDataSupportValue({ bonusField, amount: source?.bonusPerWeapon })} ${effect} per weapon`;
}
