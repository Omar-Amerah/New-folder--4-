(function initDataSupportRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.DataSupportRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeDataSupportRules() {
  "use strict";

  // Descriptors identify catalogue fields only. The catalogue remains the
  // authority for every numerical budget.
  const DATA_SOURCE_INFO = Object.freeze({
    fireControl: Object.freeze({ bonusField: "fireRateBonus", effect: "fire rate", unit: "percent" }),
    sensorArray: Object.freeze({ bonusField: "rangeBonus", effect: "range", unit: "m" }),
    signalAmplifier: Object.freeze({ bonusField: "rangeBonus", effect: "range", unit: "m" }),
    targetingComputer: Object.freeze({ bonusField: "accuracyBonus", effect: "accuracy", unit: "percent" }),
    stabilizerNode: Object.freeze({ bonusField: "accuracyBonus", effect: "accuracy", unit: "percent" })
  });
  const DATA_SOURCE_TYPES = Object.freeze(Object.keys(DATA_SOURCE_INFO));
  const BONUS_FIELDS = Object.freeze(["rangeBonus", "accuracyBonus", "fireRateBonus"]);
  const stringSort = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
  const numericSort = (a, b) => a - b;
  const modulesOf = (design) => Array.isArray(design) ? design : Array.isArray(design?.components) ? design.components : Array.isArray(design?.modules) ? design.modules : [];
  const partFor = (catalogue, type) => catalogue && typeof catalogue === "object" ? (catalogue[type] || {}) : {};
  const isWeapon = (module, catalogue) => Boolean(module && partFor(catalogue, module.type).weapon);
  const isValidComponentIndex = (value, modules, predicate) => typeof value === "number" && Number.isInteger(value)
    && value >= 0 && value < modules.length && predicate(modules[value], value);
  const uniqueValidIndices = (values, modules, predicate) => [...new Set((Array.isArray(values) ? values : [])
    .filter((index) => isValidComponentIndex(index, modules, predicate)))].sort(numericSort);
  function fallbackNetworkId(sectionIds, sourceIndices, weaponIndices) {
    const encode = (prefix, values) => `${prefix}${values.length ? values.join(".") : "none"}`;
    return `data-${encode("sec-", sectionIds)}-${encode("src-", sourceIndices)}-${encode("wpn-", weaponIndices)}`;
  }

  function isDataSupportSource(type) { return Object.prototype.hasOwnProperty.call(DATA_SOURCE_INFO, type); }
  function supportDescriptorForType(type) { const value = DATA_SOURCE_INFO[type]; return value ? { ...value } : null; }
  function nominalSupportBudget(type, catalogue) {
    const descriptor = DATA_SOURCE_INFO[type];
    if (!descriptor) return 0;
    const value = Number(partFor(catalogue, type)[descriptor.bonusField]);
    return Number.isFinite(value) ? value : 0;
  }
  function normalizeSourceMultiplier(value) {
    if (value === undefined) return 1;
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }
  function allocateSourceBudget(source, weaponIndices) {
    const recipients = [...new Set(Array.isArray(weaponIndices) ? weaponIndices : [])].sort(numericSort);
    const effectiveBudget = Number.isFinite(source?.effectiveBudget) ? source.effectiveBudget : 0;
    return { connectedWeaponIndices: recipients, recipientCount: recipients.length, bonusPerWeapon: recipients.length ? effectiveBudget / recipients.length : 0 };
  }

  function analyzeDataSupport(design, dataNetworks, catalogue, options = {}) {
    const modules = modulesOf(design);
    const rawNetworks = Array.isArray(dataNetworks) ? dataNetworks : [];
    const normalized = rawNetworks.map((network) => {
      const sourceIndices = uniqueValidIndices(network?.sourceIndices, modules, (module) => isDataSupportSource(module?.type));
      const weaponIndices = uniqueValidIndices(network?.weaponIndices, modules, (module) => isWeapon(module, catalogue));
      const sectionIds = [...new Set((Array.isArray(network?.sectionIds) ? network.sectionIds : []).filter((id) => typeof id === "string"))].sort(stringSort);
      const identity = typeof network?.id === "string" && network.id ? network.id : fallbackNetworkId(sectionIds, sourceIndices, weaponIndices);
      return { id: identity, label: typeof network?.label === "string" ? network.label : identity, sourceIndices, weaponIndices, sectionIds };
    }).filter((network) => network.sourceIndices.length || network.weaponIndices.length)
      .sort((a, b) => stringSort(a.sectionIds.join(";"), b.sectionIds.join(";")) || stringSort(a.id, b.id));

    const parent = normalized.map((_, index) => index);
    const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
    const union = (a, b) => { const x = find(a); const y = find(b); if (x !== y) parent[Math.max(x, y)] = Math.min(x, y); };
    const owners = new Map();
    normalized.forEach((network, index) => [...network.sourceIndices.map((i) => `s:${i}`), ...network.weaponIndices.map((i) => `w:${i}`)].forEach((key) => {
      if (owners.has(key)) union(index, owners.get(key)); else owners.set(key, index);
    }));
    const grouped = new Map();
    normalized.forEach((network, index) => { const root = find(index); if (!grouped.has(root)) grouped.set(root, []); grouped.get(root).push(network); });
    const warnings = [];
    const networks = [...grouped.values()].map((members) => {
      const sourceIndices = [...new Set(members.flatMap((item) => item.sourceIndices))].sort(numericSort);
      const weaponIndices = [...new Set(members.flatMap((item) => item.weaponIndices))].sort(numericSort);
      const sectionIds = [...new Set(members.flatMap((item) => item.sectionIds))].sort(stringSort);
      const ids = members.map((item) => item.id).sort(stringSort);
      if (members.length > 1) warnings.push({ code: "merged-overlapping-data-domains", networkIds: ids });
      return { id: members.length === 1 ? members[0].id : fallbackNetworkId(sectionIds, sourceIndices, weaponIndices), label: members[0].label, sourceIndices, weaponIndices,
        componentIndices: [...new Set([...sourceIndices, ...weaponIndices])].sort(numericSort), sectionIds };
    }).sort((a, b) => stringSort(a.id, b.id));
    networks.forEach((network, index) => { network.label = network.label || `Data Network ${String.fromCharCode(65 + index)}`; });

    const domainBySource = new Map(); const domainByWeapon = new Map();
    networks.forEach((network) => { network.sourceIndices.forEach((i) => domainBySource.set(i, network)); network.weaponIndices.forEach((i) => domainByWeapon.set(i, network)); });
    const allSources = modules.map((module, index) => isDataSupportSource(module?.type) ? index : -1).filter((i) => i >= 0);
    const allWeapons = modules.map((module, index) => isWeapon(module, catalogue) ? index : -1).filter((i) => i >= 0);
    const sourceAllocations = allSources.map((sourceIndex) => {
      const module = modules[sourceIndex]; const part = partFor(catalogue, module.type); const network = domainBySource.get(sourceIndex) || null;
      const connectedWeaponIndices = network ? [...network.weaponIndices] : [];
      const eligible = typeof options.isSourceEligible === "function" ? Boolean(options.isSourceEligible(sourceIndex, module, part, network)) : true;
      const eligibleWeaponIndices = connectedWeaponIndices.filter((index) => typeof options.isWeaponEligible !== "function" || options.isWeaponEligible(index, modules[index], partFor(catalogue, modules[index].type), network));
      const rawMultiplier = typeof options.sourceMultiplier === "function" ? options.sourceMultiplier(sourceIndex, module, part, network) : undefined;
      const sourceMultiplier = normalizeSourceMultiplier(rawMultiplier); const nominalBudget = nominalSupportBudget(module.type, catalogue);
      const effectiveBudget = eligible ? nominalBudget * sourceMultiplier : 0;
      const allocation = allocateSourceBudget({ effectiveBudget }, eligibleWeaponIndices);
      const descriptor = DATA_SOURCE_INFO[module.type];
      return { sourceIndex, sourceType: module.type, networkId: network?.id || null, networkLabel: network?.label || null, ...descriptor,
        nominalBudget, sourceMultiplier, effectiveBudget, connectedWeaponIndices, eligibleWeaponIndices: [...allocation.connectedWeaponIndices],
        recipientCount: allocation.recipientCount, bonusPerWeapon: allocation.bonusPerWeapon,
        status: !eligible || sourceMultiplier === 0 ? "disabled" : allocation.recipientCount ? "active" : "idle-no-weapons" };
    });
    const weaponBonuses = allWeapons.map((weaponIndex) => {
      const module = modules[weaponIndex]; const network = domainByWeapon.get(weaponIndex) || null;
      const eligible = typeof options.isWeaponEligible !== "function" || options.isWeaponEligible(weaponIndex, module, partFor(catalogue, module.type), network);
      const contributions = sourceAllocations.filter((source) => source.eligibleWeaponIndices.includes(weaponIndex)).map((source) => ({
        sourceIndex: source.sourceIndex, sourceType: source.sourceType, bonusField: source.bonusField, amount: source.bonusPerWeapon
      })).sort((a, b) => a.sourceIndex - b.sourceIndex);
      const totals = { rangeBonus: 0, accuracyBonus: 0, fireRateBonus: 0 };
      contributions.forEach((item) => { totals[item.bonusField] += item.amount; });
      return { weaponIndex, weaponType: module.type, networkId: network?.id || null, networkLabel: network?.label || null, ...totals,
        sourceIndices: contributions.map((item) => item.sourceIndex), contributions,
        status: !eligible ? "ineligible" : !network ? "disconnected" : contributions.some((item) => item.amount !== 0) ? "supported" : "connected-unsupported" };
    });
    const sourceAllocationByIndex = Array(modules.length).fill(null); sourceAllocations.forEach((item) => { sourceAllocationByIndex[item.sourceIndex] = { ...item, connectedWeaponIndices: [...item.connectedWeaponIndices], eligibleWeaponIndices: [...item.eligibleWeaponIndices] }; });
    const weaponBonusByIndex = Array(modules.length).fill(null); weaponBonuses.forEach((item) => { weaponBonusByIndex[item.weaponIndex] = { ...item, sourceIndices: [...item.sourceIndices], contributions: item.contributions.map((entry) => ({ ...entry })) }; });
    return { version: 1, networkCount: networks.length, activeSourceCount: sourceAllocations.filter((item) => item.status === "active").length,
      supportedWeaponCount: weaponBonuses.filter((item) => item.status === "supported").length, networks, sources: sourceAllocations, weapons: weaponBonuses,
      sourceAllocations, weaponBonuses, sourceAllocationByIndex, weaponBonusByIndex, warnings };
  }
  function weaponSupportForIndex(analysis, weaponIndex) {
    const value = analysis?.weaponBonusByIndex?.[weaponIndex];
    return value ? { ...value, sourceIndices: [...value.sourceIndices], contributions: value.contributions.map((item) => ({ ...item })) }
      : { weaponIndex, rangeBonus: 0, accuracyBonus: 0, fireRateBonus: 0, sourceIndices: [], contributions: [], status: "disconnected" };
  }
  function effectiveWeaponProfile(baseWeapon, support) {
    const base = baseWeapon && typeof baseWeapon === "object" ? baseWeapon : {};
    const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
    const range = finite(base.range) + finite(support?.rangeBonus);
    const accuracy = Math.max(0, Math.min(0.99, finite(base.accuracy) + finite(support?.accuracyBonus)));
    const fireRate = finite(base.fireRate) * (1 + finite(support?.fireRateBonus));
    const result = { ...base, range, accuracy, fireRate, reload: fireRate > 0 ? 1000 / fireRate : 0 };
    if (Number.isFinite(Number(result.damage)) && Number.isFinite(fireRate)) result.dps = Number(result.damage) * fireRate;
    return result;
  }
  return { DATA_SOURCE_INFO, DATA_SOURCE_TYPES, BONUS_FIELDS, isDataSupportSource, supportDescriptorForType, nominalSupportBudget,
    normalizeSourceMultiplier, allocateSourceBudget, analyzeDataSupport, weaponSupportForIndex, effectiveWeaponProfile };
}));
