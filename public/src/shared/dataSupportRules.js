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
  function automaticDataNetworks(design, catalogue) {
    const modules = modulesOf(design);
    const sourceIndices = modules.map((module, index) => isDataSupportSource(module?.type) ? index : -1).filter((index) => index >= 0);
    const weaponIndices = modules.map((module, index) => isWeapon(module, catalogue) ? index : -1).filter((index) => index >= 0);
    if (!sourceIndices.length && !weaponIndices.length) return [];
    return [{
      id: "automatic-data-links",
      label: "Automatic Data Links",
      mode: "automatic",
      sourceIndices,
      weaponIndices,
      componentIndices: [...new Set([...sourceIndices, ...weaponIndices])].sort(numericSort),
      sectionIds: []
    }];
  }
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
    // Index allocations once. The previous weapon-side scan searched every
    // source and then linearly searched each source's recipients, which became
    // cubic on large Data networks and multiplied the cost of failure analysis.
    const allocationsByWeapon = new Map();
    sourceAllocations.forEach((source) => source.eligibleWeaponIndices.forEach((weaponIndex) => {
      if (!allocationsByWeapon.has(weaponIndex)) allocationsByWeapon.set(weaponIndex, []);
      allocationsByWeapon.get(weaponIndex).push(source);
    }));
    const weaponBonuses = allWeapons.map((weaponIndex) => {
      const module = modules[weaponIndex]; const network = domainByWeapon.get(weaponIndex) || null;
      const eligible = typeof options.isWeaponEligible !== "function" || options.isWeaponEligible(weaponIndex, module, partFor(catalogue, module.type), network);
      const contributions = (allocationsByWeapon.get(weaponIndex) || []).map((source) => ({
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
    // Support may sharpen accuracy up to the shared 0.99 ceiling, but never below
    // a weapon's own base accuracy — a "cannot miss" weapon (base 1.0) keeps its
    // perfect aim rather than being clamped down to 0.99 by the support pass.
    const accuracyCeiling = Math.max(0.99, finite(base.accuracy));
    const accuracy = Math.max(0, Math.min(accuracyCeiling, finite(base.accuracy) + finite(support?.accuracyBonus)));
    const fireRate = finite(base.fireRate) * (1 + finite(support?.fireRateBonus));
    const result = { ...base, range, accuracy, fireRate, reload: fireRate > 0 ? 1000 / fireRate : 0 };
    if (Number.isFinite(Number(result.damage)) && Number.isFinite(fireRate)) result.dps = Number(result.damage) * fireRate;
    return result;
  }
  function normalizeDataLinks(design, dataLinks, catalogue) {
    const modules = modulesOf(design);
    const raw = Array.isArray(dataLinks) ? dataLinks : [];
    const seen = new Set();
    const result = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const sourceIndex = Number.isInteger(entry?.sourceIndex) ? entry.sourceIndex : Number(entry?.sourceIndex);
      const targetIndex = Number.isInteger(entry?.targetIndex) ? entry.targetIndex : Number(entry?.targetIndex);
      if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex)) continue;
      if (sourceIndex === targetIndex) continue;
      if (sourceIndex < 0 || sourceIndex >= modules.length || targetIndex < 0 || targetIndex >= modules.length) continue;
      const source = modules[sourceIndex];
      const target = modules[targetIndex];
      if (!source || !target) continue;
      if (!isDataSupportSource(source.type)) continue;
      if (!isWeapon(target, catalogue)) continue;
      const key = `${sourceIndex}:${targetIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ sourceIndex, targetIndex });
    }
    return result.sort((a, b) => a.sourceIndex - b.sourceIndex || a.targetIndex - b.targetIndex);
  }

  function validateDataLinks(design, dataLinks, catalogue) {
    const modules = modulesOf(design);
    const raw = Array.isArray(dataLinks) ? dataLinks : [];
    const valid = [];
    const rejected = [];
    const seen = new Set();
    for (let i = 0; i < raw.length; i += 1) {
      const entry = raw[i];
      const reason = (code, detail = "") => ({ index: i, code, entry, detail });
      if (!entry || typeof entry !== "object") { rejected.push(reason("malformed-record")); continue; }
      const sourceIndex = Number(entry?.sourceIndex);
      const targetIndex = Number(entry?.targetIndex);
      if (!Number.isInteger(sourceIndex) || sourceIndex < 0) { rejected.push(reason("invalid-source-index")); continue; }
      if (!Number.isInteger(targetIndex) || targetIndex < 0) { rejected.push(reason("invalid-target-index")); continue; }
      if (sourceIndex >= modules.length || targetIndex >= modules.length) { rejected.push(reason("missing-component")); continue; }
      if (sourceIndex === targetIndex) { rejected.push(reason("self-link")); continue; }
      const source = modules[sourceIndex];
      const target = modules[targetIndex];
      if (!source || !target) { rejected.push(reason("missing-component")); continue; }
      if (isDataSupportSource(target.type)) { rejected.push(reason("target-is-source", "Source-to-source link rejected.")); continue; }
      if (isWeapon(source, catalogue)) { rejected.push(reason("source-is-weapon", "Weapon-to-weapon link rejected.")); continue; }
      if (!isDataSupportSource(source.type)) { rejected.push(reason("unsupported-source")); continue; }
      if (!isWeapon(target, catalogue)) { rejected.push(reason("non-weapon-target")); continue; }
      const key = `${sourceIndex}:${targetIndex}`;
      if (seen.has(key)) { rejected.push(reason("duplicate")); continue; }
      seen.add(key);
      valid.push({ sourceIndex, targetIndex });
    }
    return { valid: valid.sort((a, b) => a.sourceIndex - b.sourceIndex || a.targetIndex - b.targetIndex), rejected };
  }

  function analyzeDirectDataSupport(design, dataLinks, catalogue, options = {}) {
    const modules = modulesOf(design);
    const bySource = new Map();
    const byWeapon = new Map();
    const normalized = normalizeDataLinks(design, dataLinks, catalogue);
    for (const link of normalized) {
      if (!bySource.has(link.sourceIndex)) bySource.set(link.sourceIndex, []);
      bySource.get(link.sourceIndex).push(link.targetIndex);
      if (!byWeapon.has(link.targetIndex)) byWeapon.set(link.targetIndex, []);
      byWeapon.get(link.targetIndex).push(link.sourceIndex);
    }
    const allSources = modules.map((module, index) => isDataSupportSource(module?.type) ? index : -1).filter((i) => i >= 0);
    const allWeapons = modules.map((module, index) => isWeapon(module, catalogue) ? index : -1).filter((i) => i >= 0);
    const sourceAllocations = allSources.map((sourceIndex) => {
      const module = modules[sourceIndex];
      const part = partFor(catalogue, module.type);
      const descriptor = DATA_SOURCE_INFO[module.type];
      const directWeaponIndices = [...(bySource.get(sourceIndex) || [])].sort(numericSort);
      const connectedWeaponIndices = directWeaponIndices;
      const eligible = typeof options.isSourceEligible === "function" ? Boolean(options.isSourceEligible(sourceIndex, module, part, null)) : true;
      const eligibleWeaponIndices = connectedWeaponIndices.filter((index) => typeof options.isWeaponEligible !== "function" || options.isWeaponEligible(index, modules[index], partFor(catalogue, modules[index].type), null));
      const rawPower = typeof options.powerMultiplier === "function" ? options.powerMultiplier(sourceIndex, module, part, null) : options.powerMultiplier;
      const powerMultiplier = normalizeSourceMultiplier(Number.isFinite(rawPower) ? rawPower : 1);
      const rawThermal = typeof options.thermalMultiplier === "function" ? options.thermalMultiplier(sourceIndex, module, part, null) : options.thermalMultiplier;
      const thermalMultiplier = normalizeSourceMultiplier(Number.isFinite(rawThermal) ? rawThermal : 1);
      const rawOperational = typeof options.operationalMultiplier === "function" ? options.operationalMultiplier(sourceIndex, module, part, null) : options.operationalMultiplier;
      const operationalMultiplier = normalizeSourceMultiplier(Number.isFinite(rawOperational) ? rawOperational : 1);
      const rawMultiplier = typeof options.sourceMultiplier === "function" ? options.sourceMultiplier(sourceIndex, module, part, null) : options.sourceMultiplier;
      const sourceMultiplier = normalizeSourceMultiplier(rawMultiplier !== undefined ? rawMultiplier : powerMultiplier * thermalMultiplier * operationalMultiplier);
      const nominalBudget = nominalSupportBudget(module.type, catalogue);
      const effectiveBudget = eligible ? nominalBudget * sourceMultiplier : 0;
      const allocation = allocateSourceBudget({ effectiveBudget }, eligibleWeaponIndices);
      const status = !eligible || sourceMultiplier === 0 ? "disabled" : allocation.recipientCount ? "active" : "idle-no-weapons";
      const statusReason = status === "disabled" ? "Source is disabled or unpowered." : status === "idle-no-weapons" ? "No eligible weapon recipients are linked." : "Source is allocating its effective support budget.";
      return { sourceIndex, sourceType: module.type, directWeaponIndices, eligibleWeaponIndices,
        nominalBudget, powerMultiplier, thermalMultiplier, operationalMultiplier, sourceMultiplier, effectiveBudget,
        recipientCount: allocation.recipientCount, bonusPerWeapon: allocation.bonusPerWeapon,
        status, statusReason, ...descriptor };
    });
    const allocationsByWeapon = new Map();
    sourceAllocations.forEach((source) => source.eligibleWeaponIndices.forEach((weaponIndex) => {
      if (!allocationsByWeapon.has(weaponIndex)) allocationsByWeapon.set(weaponIndex, []);
      allocationsByWeapon.get(weaponIndex).push(source);
    }));
    const weaponBonuses = allWeapons.map((weaponIndex) => {
      const module = modules[weaponIndex];
      const eligible = typeof options.isWeaponEligible !== "function" || options.isWeaponEligible(weaponIndex, module, partFor(catalogue, module.type), null);
      const sourceList = (allocationsByWeapon.get(weaponIndex) || []).sort((a, b) => a.sourceIndex - b.sourceIndex);
      const contributions = sourceList.map((source) => ({
        sourceIndex: source.sourceIndex, sourceType: source.sourceType, bonusField: source.bonusField, amount: source.bonusPerWeapon
      }));
      const totals = { rangeBonus: 0, accuracyBonus: 0, fireRateBonus: 0 };
      contributions.forEach((item) => { totals[item.bonusField] += item.amount; });
      const sourceIndices = sourceList.map((s) => s.sourceIndex);
      const status = !eligible ? "ineligible" : !sourceList.length ? "unsupported" : contributions.some((c) => c.amount !== 0) ? "supported" : "connected-unsupported";
      const statusReason = status === "supported" ? "Predicted Data support is applied to this weapon." : status === "connected-unsupported" ? "Operating at base stats; no active source contributes." : "Operating at base stats.";
      return { weaponIndex, weaponType: module.type, sourceIndices, contributions, ...totals, status, statusReason };
    });
    const sourceAllocationByIndex = Array(modules.length).fill(null); sourceAllocations.forEach((item) => { sourceAllocationByIndex[item.sourceIndex] = { ...item, directWeaponIndices: [...item.directWeaponIndices], eligibleWeaponIndices: [...item.eligibleWeaponIndices] }; });
    const weaponBonusByIndex = Array(modules.length).fill(null); weaponBonuses.forEach((item) => { weaponBonusByIndex[item.weaponIndex] = { ...item, sourceIndices: [...item.sourceIndices], contributions: item.contributions.map((entry) => ({ ...entry })) }; });
    const links = [...bySource].flatMap(([sourceIndex, targets]) => targets.map((targetIndex) => ({ sourceIndex, targetIndex }))).sort((a, b) => a.sourceIndex - b.sourceIndex || a.targetIndex - b.targetIndex);
    return { version: 1, topologyMode: "direct-links", linkCount: links.length, activeSourceCount: sourceAllocations.filter((item) => item.status === "active").length,
      supportedWeaponCount: weaponBonuses.filter((item) => item.status === "supported").length, links, sources: sourceAllocations, weapons: weaponBonuses,
      sourceAllocations, weaponBonuses, sourceAllocationByIndex, weaponBonusByIndex, warnings: [] };
  }

  return { DATA_SOURCE_INFO, DATA_SOURCE_TYPES, BONUS_FIELDS, isDataSupportSource, supportDescriptorForType, automaticDataNetworks, nominalSupportBudget,
    normalizeSourceMultiplier, allocateSourceBudget, analyzeDataSupport, analyzeDirectDataSupport, normalizeDataLinks, validateDataLinks, weaponSupportForIndex, effectiveWeaponProfile };
}));
