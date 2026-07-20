(function initPowerAllocationRules(root, factory) {
  const onNode = typeof module !== "undefined" && module.exports;
  const policy = onNode ? require("./powerPolicyRules") : root.PowerPolicyRules;
  const rules = factory(policy);
  if (onNode) module.exports = rules;
  root.PowerAllocationRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makePowerAllocationRules(PowerPolicyRules) {
  "use strict";

  // 1 MW = 1000 internal fixed-point units. All allocation arithmetic runs on
  // non-negative integers so results are deterministic and never accumulate
  // floating-point error. Foundation only — no gameplay reads this yet.
  const POWER_FLOW_SCALE = 1000;

  // MW -> integer units. Invalid, negative or non-finite input becomes zero.
  function mwToPowerUnits(value) {
    const mw = Number(value);
    if (!Number.isFinite(mw) || mw < 0) return 0;
    return Math.round(mw * POWER_FLOW_SCALE);
  }

  // Units -> MW. Guards invalid input and never returns negative zero.
  function powerUnitsToMw(value) {
    const units = Number(value);
    if (!Number.isFinite(units) || units <= 0) return 0;
    return units / POWER_FLOW_SCALE;
  }

  function stableId(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function idSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true });
  }

  // Consolidate the request list into deterministic per-id demand in integer
  // units. Duplicate ids are consolidated by summing their demand (the chosen,
  // tested behaviour); entries without a stable id are dropped. Never mutates
  // the input.
  function consolidateRequests(requests) {
    const byId = new Map();
    for (const raw of Array.isArray(requests) ? requests : []) {
      const id = stableId(raw && raw.id);
      if (!id) continue;
      const units = mwToPowerUnits(raw && raw.requestedMw);
      if (byId.has(id)) byId.get(id).requestedUnits += units;
      else byId.set(id, { id, requestedUnits: units });
    }
    return [...byId.values()].sort((a, b) => idSort(a.id, b.id));
  }

  // Proportional allocation across ONE tied priority band. Consumers share a
  // shortage in proportion to demand; a surplus gives everyone their full
  // request. Integer largest-remainder (Hamilton) distribution keeps every
  // consumer within one unit of the exact proportional share and is
  // deterministic regardless of input order. Never mutates inputs.
  function allocateProportionally(requests, availableMw) {
    const entries = consolidateRequests(requests);
    const availableUnits = mwToPowerUnits(availableMw);
    const totalRequestedUnits = entries.reduce((sum, entry) => sum + entry.requestedUnits, 0);
    const allocatedUnits = new Map();

    if (totalRequestedUnits <= availableUnits) {
      // Surplus (or exact): everyone is fully satisfied.
      for (const entry of entries) allocatedUnits.set(entry.id, entry.requestedUnits);
    } else if (availableUnits <= 0 || totalRequestedUnits === 0) {
      for (const entry of entries) allocatedUnits.set(entry.id, 0);
    } else {
      // Shortage: floor(available * demand / total), then hand out the integer
      // leftover by largest fractional remainder (ties broken by stable id).
      let assigned = 0;
      const remainders = [];
      for (const entry of entries) {
        const numerator = availableUnits * entry.requestedUnits;
        const base = Math.floor(numerator / totalRequestedUnits);
        allocatedUnits.set(entry.id, base);
        assigned += base;
        remainders.push({ id: entry.id, remainder: numerator - base * totalRequestedUnits, requestedUnits: entry.requestedUnits });
      }
      let leftover = availableUnits - assigned;
      remainders.sort((a, b) => (b.remainder - a.remainder) || idSort(a.id, b.id));
      for (const item of remainders) {
        if (leftover <= 0) break;
        if (allocatedUnits.get(item.id) < item.requestedUnits) {
          allocatedUnits.set(item.id, allocatedUnits.get(item.id) + 1);
          leftover -= 1;
        }
      }
    }

    let totalAllocatedUnits = 0;
    const allocations = entries.map((entry) => {
      const alloc = allocatedUnits.get(entry.id) || 0;
      totalAllocatedUnits += alloc;
      const unmet = Math.max(0, entry.requestedUnits - alloc);
      // Zero-demand consumers are fully satisfied by definition.
      const satisfactionRatio = entry.requestedUnits > 0 ? alloc / entry.requestedUnits : 1;
      return {
        id: entry.id,
        requestedMw: powerUnitsToMw(entry.requestedUnits),
        allocatedMw: powerUnitsToMw(alloc),
        unmetMw: powerUnitsToMw(unmet),
        satisfactionRatio,
        requestedUnits: entry.requestedUnits,
        allocatedUnits: alloc,
        unmetUnits: unmet
      };
    });

    return {
      availableMw: powerUnitsToMw(availableUnits),
      requestedMw: powerUnitsToMw(totalRequestedUnits),
      allocatedMw: powerUnitsToMw(totalAllocatedUnits),
      unmetMw: powerUnitsToMw(Math.max(0, totalRequestedUnits - totalAllocatedUnits)),
      availableUnits,
      requestedUnits: totalRequestedUnits,
      allocatedUnits: totalAllocatedUnits,
      allocations
    };
  }

  // Optional orchestration: process priority bands high-to-low against a single
  // shared Power pool, allocating each band proportionally and passing only the
  // remaining Power down. No topology, networks, section capacity or stranded
  // generation — a single pool by design.
  function allocatePriorityBands(input) {
    const options = input && typeof input === "object" ? input : {};
    const bands = PowerPolicyRules.resolvePriorityBands(options.policy);
    const consumers = Array.isArray(options.consumers) ? options.consumers : [];
    const byCategory = new Map();
    for (const consumer of consumers) {
      const category = stableId(consumer && consumer.category);
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category).push({ id: stableId(consumer && consumer.id), requestedMw: consumer && consumer.requestedMw });
    }
    const availableUnits = mwToPowerUnits(options.availableMw);
    let remainingUnits = availableUnits;
    const bandResults = [];
    const allocations = [];
    for (const band of bands) {
      const bandRequests = [];
      for (const category of band) for (const request of byCategory.get(category) || []) bandRequests.push(request);
      const result = allocateProportionally(bandRequests, powerUnitsToMw(remainingUnits));
      remainingUnits = Math.max(0, remainingUnits - result.allocatedUnits);
      bandResults.push({ categories: [...band], result });
      for (const allocation of result.allocations) allocations.push(allocation);
    }
    return {
      availableMw: powerUnitsToMw(availableUnits),
      remainingMw: powerUnitsToMw(remainingUnits),
      bands: bandResults,
      allocations: allocations.sort((a, b) => idSort(a.id, b.id))
    };
  }

  return {
    POWER_FLOW_SCALE,
    mwToPowerUnits,
    powerUnitsToMw,
    consolidateRequests,
    allocateProportionally,
    allocatePriorityBands
  };
}));
