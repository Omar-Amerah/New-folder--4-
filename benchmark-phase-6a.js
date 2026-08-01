"use strict";

// Deterministic server-local Heat benchmark.  It reports measured values for
// this checkout; expected ranges are intentionally not treated as thresholds.

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const HeatRules = require("./public/src/shared/heatRules");
const WiringRules = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");
const { initComponentState } = require("./src/server/componentHealth");
const { computeStats } = require("./src/server/shipStats");
const { initializeComponentPower } = require("./src/server/componentPower");
const Heat = require("./src/server/heat");
const Flags = require("./src/server/performanceFlags");
const RoomTelemetry = require("./src/server/roomTelemetry");

const SHIP_COUNTS = [100, 250, 500, 1000];
const COMPONENT_COUNTS = [15, 75, 150, 225];
const DEFAULT_STEPS = 12;
const WARMUP_STEPS = 2;
const OUTPUT_PATH = path.join(__dirname, "test-artifacts", "performance", "benchmark-phase-6a.json");

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function stats(values) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), average: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length) };
}

function designFor(componentCount, scenario, shipIndex) {
  const design = [];
  for (let i = 0; i < componentCount; i += 1) {
    const x = i % 15;
    const y = Math.floor(i / 15);
    let type = "frame";
    if (scenario === "cold-idle-reactor" && i === 0) type = "reactor";
    else if (scenario === "one-active-engine" && i === 0) type = "engine";
    else if (scenario === "sparse-weapon-combat" && i === 0) type = "blaster";
    else if (scenario === "cable-heat-heavy" && i === 0) type = "reactor";
    else if (i === componentCount - 1) type = "radiator";
    design.push({ x, y, type, rotation: (shipIndex + i) % 4 * 90 });
  }
  return design;
}

function makeShip(design, shipIndex) {
  const wiring = WiringRules.emptyWiring();
  const ship = {
    id: `benchmark-${shipIndex}`,
    alive: true,
    design,
    wiring,
    stats: computeStats(design, wiring),
    x: 0,
    y: 0,
    angle: 0,
    dirtyComponents: new Set(),
    dirtyHeat: new Set()
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  Heat.initShipHeat(ship);
  return ship;
}

function makeFleet(shipCount, componentCount, scenario) {
  const fleet = [];
  for (let shipIndex = 0; shipIndex < shipCount; shipIndex += 1) fleet.push(makeShip(designFor(componentCount, scenario, shipIndex), shipIndex));
  return fleet;
}

function cableRates(ship) {
  const rates = ship.design.map((_, index) => index % 3 === 0 ? 0.45 : 0.12);
  const total = rates.reduce((sum, value) => sum + value, 0);
  ship.componentPowerCableHeatRate = rates;
  ship.powerCableHeatRate = total;
  // The checked-in server currently has WIRING_ENABLED=false, so the normal
  // cable-analysis authority intentionally clears physical cable rates.  Keep
  // this synthetic benchmark fixture in the disabled-analysis mode after
  // injecting deterministic rates; that exercises the Heat runtime's cable
  // list without changing the production feature flag or cable formula.
  ship.powerCableThermalAnalysis = { mode: "disabled", sections: [], components: [], summary: { totalPowerCableHeatPerSecond: total, hottestSectionId: null } };
  ship._powerCableThermalFlowRevision = ship.powerFlowRevision || 0;
  Heat.refreshHeatRuntimeCableComponents(ship, rates, total);
}

function prepareFleet(fleet, scenario) {
  for (const [shipIndex, ship] of fleet.entries()) {
    if (scenario === "fully-warm-hot") {
      for (let i = 0; i < ship.componentHeat.length; i += 1) {
        ship.componentHeat[i] = ship.componentThermals[i].capacity * (i % 3 === 0 ? 0.86 : 0.72);
        ship.componentHeatState[i] = HeatRules.stateFor(ship.componentHeat[i] / ship.componentThermals[i].capacity, ship.componentHeatState[i]);
      }
      Heat.refreshHeatRuntimeLists(ship);
      ship.hasActiveHeat = true;
    } else if (scenario === "cable-heat-heavy") {
      cableRates(ship);
    } else if (scenario === "damage-repair-churn") {
      ship.componentHeat[shipIndex % ship.componentHeat.length] = 35;
      Heat.refreshHeatRuntimeLists(ship);
      ship.hasActiveHeat = true;
    }
  }
}

function applyScenarioInput(fleet, scenario, step) {
  for (let shipIndex = 0; shipIndex < fleet.length; shipIndex += 1) {
    const ship = fleet[shipIndex];
    if (scenario === "damage-repair-churn") ship.hasActiveHeat = true;
    const active = scenario === "mixed-idle-active" ? shipIndex % 5 === 0
      : scenario === "sparse-weapon-combat" ? shipIndex % 7 === 0
        : scenario === "one-active-engine" ? true
          : scenario === "damage-repair-churn" ? shipIndex % 3 === step % 3
            : false;
    if (scenario === "one-active-engine" && active) Heat.addComponentHeat(ship, 0, 4);
    if (scenario === "sparse-weapon-combat" && active) Heat.addComponentHeat(ship, 0, 8);
    if (scenario === "mixed-idle-active" && active) Heat.addComponentHeat(ship, 0, 5);
    if (scenario === "damage-repair-churn" && active) {
      // Keep the legacy compatibility wake hint asserted while this fixture
      // models ongoing lifecycle churn.  Phase 6A itself tracks every finite
      // positive retained-Heat value, including a sub-threshold cooling tail.
      ship.hasActiveHeat = true;
      const index = shipIndex % ship.componentHp.length;
      ship.componentHp[index] = step % 2 === 0 ? Math.max(1, ship.componentMaxHp[index] * 0.6) : ship.componentMaxHp[index];
      Heat.recalculateEffectiveThermalCapacities(ship, index);
      Heat.refreshHeatRuntimeLists(ship);
      ship.hasActiveHeat = true;
    }
  }
}

function checksum(fleet) {
  let hash = 2166136261 >>> 0;
  for (const ship of fleet) for (const value of ship.componentHeat) {
    const units = Math.round(value * 1e6);
    hash ^= units & 0xff; hash = Math.imul(hash, 16777619) >>> 0;
    hash ^= (units >>> 8) & 0xff; hash = Math.imul(hash, 16777619) >>> 0;
    hash ^= (units >>> 16) & 0xff; hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function approximateRuntimeBytes(ship) {
  const n = ship.componentHeat.length;
  const arrays = 19 * n * 8;
  const runtime = (ship._thermalRuntime?.transferEdgeIds?.length || 0) * 4
    + (ship._thermalRuntime?.transferAmounts?.length || 0) * 8
    + (ship._thermalRuntime?.telemetryValues?.length || 0) * 8
    + n * 4 * 8;
  return arrays + runtime;
}

function approximateTopologyBytes(topology) {
  const edges = topology.edgeA.length;
  return edges * (4 + 4 + 4 + 8 + 8 + 1) + topology.incidentEdgeIds.length * 4 + topology.incidentEdgeOffsets.length * 4;
}

function runMode({ shipCount, componentCount, scenario, optimized }) {
  Flags.__setOPTIMIZED_HEAT_RUNTIME(optimized);
  const heapBeforeRun = process.memoryUsage().heapUsed;
  const fleet = makeFleet(shipCount, componentCount, scenario);
  prepareFleet(fleet, scenario);
  const room = {};
  const stepDurations = [];
  const fullDurations = [];
  const visitedComponents = [];
  const visitedEdges = [];
  const transfers = [];
  const transferAllocations = [];
  const stableSkipped = [];
  const wakeups = [];
  for (let step = 0; step < WARMUP_STEPS + DEFAULT_STEPS; step += 1) {
    applyScenarioInput(fleet, scenario, step);
    RoomTelemetry.resetRoomTelemetry(room);
    const started = performance.now();
    for (const ship of fleet) Heat.updateShipHeat(ship, HeatRules.TICK_SECONDS, room, step * HeatRules.TICK_SECONDS);
    const elapsed = performance.now() - started;
    if (step >= WARMUP_STEPS) {
      stepDurations.push(elapsed);
      fullDurations.push(elapsed);
      visitedComponents.push(room._roomTelemetry.heatComponentsVisited || 0);
      visitedEdges.push(room._roomTelemetry.heatEdgesVisited || 0);
      transfers.push(room._roomTelemetry.heatTransfersApplied || 0);
      transferAllocations.push(room._roomTelemetry.heatTransferObjectsAllocated || 0);
      stableSkipped.push(room._roomTelemetry.heatShipsStableSkipped || 0);
      wakeups.push(room._roomTelemetry.heatShipWakeups || 0);
    }
  }
  const first = fleet[0];
  return {
    mode: optimized ? "optimized" : "legacy",
    heatStageMs: stats(stepDurations),
    fullSimulationStepMs: stats(fullDurations),
    componentsVisited: stats(visitedComponents),
    edgesVisited: stats(visitedEdges),
    transfersApplied: stats(transfers),
    transferObjectsAllocated: transferAllocations.reduce((sum, value) => sum + value, 0),
    stableStepsSkipped: stableSkipped.reduce((sum, value) => sum + value, 0),
    wakeups: wakeups.reduce((sum, value) => sum + value, 0),
    // Topology lifecycle counters are per-ship initialization facts and may
    // have been reported during warm-up, so read the persistent runtime state
    // instead of the last reset room sample.
    topologyBuilds: fleet.reduce((sum, ship) => sum + (ship._thermalRuntime?.topologyBuilds || 0), 0),
    topologyCacheHits: fleet.reduce((sum, ship) => sum + (ship._thermalRuntime?.topologyCacheHits || 0), 0),
    topologySharedShips: fleet.reduce((sum, ship) => sum + (ship._thermalRuntime?.topologyShared ? 1 : 0), 0),
    approximateMemoryPerShipBytes: approximateRuntimeBytes(first),
    sharedTopologyMemoryBytes: approximateTopologyBytes(first.thermalTopology),
    heapUsedAfterRunBytes: process.memoryUsage().heapUsed,
    heapGrowthOverRepeatedRunBytes: process.memoryUsage().heapUsed - heapBeforeRun,
    outcomeChecksum: checksum(fleet),
    ships: shipCount,
    components: componentCount,
    scenario
  };
}

const scenarios = [
  "cold-idle-reactor", "cold-no-reactors", "one-active-engine", "sparse-weapon-combat",
  "mixed-idle-active", "fully-warm-hot", "cable-heat-heavy", "damage-repair-churn"
];
const fixtures = [];
for (const scenario of scenarios) {
  const sizes = scenario === "fully-warm-hot" || scenario === "cable-heat-heavy" ? [[100, 75], [250, 150]] : [[100, 15], [250, 75], [500, 150], [1000, 225]];
  for (const [shipCount, componentCount] of sizes) {
    const legacy = runMode({ shipCount, componentCount, scenario, optimized: false });
    const optimized = runMode({ shipCount, componentCount, scenario, optimized: true });
    fixtures.push({ scenario, shipCount, componentCount, legacy, optimized, equivalentOutcome: legacy.outcomeChecksum === optimized.outcomeChecksum });
  }
}
Flags.__setOPTIMIZED_HEAT_RUNTIME(false);
const output = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  heatTickSeconds: HeatRules.TICK_SECONDS,
  flagDefaultAfterRun: Flags.OPTIMIZED_HEAT_RUNTIME(),
  methodology: { warmupSteps: WARMUP_STEPS, measuredSteps: DEFAULT_STEPS, timing: "performance.now wall-clock per fleet thermal stage", checksum: "rounded component Heat at 1e-6 units" },
  fixtures
};
fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ outputPath: OUTPUT_PATH, fixtures: fixtures.length, allEquivalent: fixtures.every((fixture) => fixture.equivalentOutcome) }, null, 2));
