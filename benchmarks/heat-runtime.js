"use strict";

// Deterministic server-local Heat benchmark.  It reports measured values for
// this checkout; expected ranges are intentionally not treated as thresholds.

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");
const { getOccupiedCells } = require("../src/server/footprint");
const { initComponentState } = require("../src/server/componentHealth");
const { computeStats } = require("../src/server/shipStats");
const { initializeComponentPower } = require("../src/server/componentPower");
const Heat = require("../src/server/heat");
const RoomTelemetry = require("../src/server/roomTelemetry");
const { createImmutableShipTemplate } = require("../src/server/shipTemplates");
const { spawnShip } = require("../src/server/ships");

const OUTPUT_PATH = path.join(path.dirname(__dirname), "test-artifacts", "performance", "heat-runtime.json");
const args = new Set(process.argv.slice(2));
if (args.has("--quick") && args.has("--full")) throw new Error("Choose either --quick or --full");
const mode = args.has("--full") ? "full" : "quick";
const DEFAULT_STEPS = mode === "full" ? 12 : 5;
const WARMUP_STEPS = mode === "full" ? 2 : 1;

// Template spawning is intentionally quiet for this server-local benchmark.
process.env.NODE_ENV = "production";

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function stats(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    average: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
  };
}

function designFor(componentCount, scenario, shipIndex) {
  const design = [];
  const occupied = new Set();
  // 225 single-cell components fill the blueprint exactly.  Use larger
  // catalogue footprints only below that size, placing each component in the
  // first deterministic free footprint so benchmark fixtures do not silently
  // overlap multi-cell parts.
  const supportsMultiCell = componentCount < 225;
  for (let i = 0; i < componentCount; i += 1) {
    let type = "frame";
    if (supportsMultiCell && scenario === "cold-idle-reactor" && i === 0) type = "reactor";
    else if (supportsMultiCell && scenario === "one-active-engine" && i === 0) type = "engine";
    else if (scenario === "sparse-weapon-combat" && i === 0) type = "blaster";
    else if (i === componentCount - 1) type = "radiator";
    const rotation = (shipIndex + i) % 4 * 90;
    const part = PARTS[type] || PARTS.frame;
    const footprint = part.footprint || { width: 1, height: 1 };
    let placed = false;
    for (let y = 0; y < 15 && !placed; y += 1) {
      for (let x = 0; x < 15 && !placed; x += 1) {
        const cells = getOccupiedCells(x, y, footprint, rotation);
        if (cells.some((cell) => cell.x < 0 || cell.y < 0 || cell.x >= 15 || cell.y >= 15)) continue;
        if (cells.some((cell) => occupied.has(`${cell.x},${cell.y}`))) continue;
        design.push({ x, y, type, rotation });
        for (const cell of cells) occupied.add(`${cell.x},${cell.y}`);
        placed = true;
      }
    }
    if (!placed) throw new Error(`Unable to place benchmark component ${i} (${type}) in ${componentCount}-component design`);
  }
  return design;
}

function makeShip(design, shipIndex) {
  const dataLinks = [];
  const ship = {
    id: `benchmark-${shipIndex}`,
    alive: true,
    design,
    dataLinks,
    stats: computeStats(design, { dataLinks }),
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

function templateRoom(player) {
  return {
    nextEntityId: 1,
    mapSeed: 1,
    world: { width: 100000, height: 100000 },
    map: { asteroids: [], safeZones: [] },
    players: new Map([[player.id, player]]),
    ships: new Map(),
    effects: [],
    drones: new Map(),
    stations: []
  };
}

function makeTemplateFleet(shipCount, componentCount, scenario) {
  const design = designFor(componentCount, scenario, 0);
  const dataLinks = [];
  const stats = computeStats(design, { dataLinks });
  const template = createImmutableShipTemplate(design, dataLinks, stats);
  const player = {
    id: `benchmark-template-${scenario}-${componentCount}`,
    team: "blue",
    shipCap: shipCount,
    ships: [],
    design,
    dataLinks,
    stats,
    rallyPoint: null
  };
  const room = templateRoom(player);
  const fleet = [];
  for (let shipIndex = 0; shipIndex < shipCount; shipIndex += 1) {
    fleet.push(spawnShip(room, player, 0, shipIndex, {
      template,
      // Explicit points avoid spawn-planner work; this benchmark measures the
      // thermal stage after construction, not fleet deployment placement.
      spawnPoint: { x: 0, y: 0, angle: 0 }
    }));
  }
  const shared = fleet.every((ship) => ship.thermalTopology === template.thermalTopology);
  const localArrays = fleet.slice(1).every((ship) => ship.componentHeat !== fleet[0].componentHeat && ship._thermalRuntime !== fleet[0]._thermalRuntime);
  if (!shared || !localArrays) throw new Error("Template topology/state isolation invariant failed");
  return { fleet, template, templateRoom: room };
}

function makeFleet(shipCount, componentCount, scenario, templateShared) {
  if (templateShared) return makeTemplateFleet(shipCount, componentCount, scenario);
  const fleet = [];
  for (let shipIndex = 0; shipIndex < shipCount; shipIndex += 1) {
    fleet.push(makeShip(designFor(componentCount, scenario, shipIndex), shipIndex));
  }
  return { fleet, template: null, templateRoom: null };
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
  const typedArrays = [
    ship._thermalRuntime?.heatBearingMembership,
    ship._thermalRuntime?.heatBearingPositions,
    ship._thermalRuntime?.hotMembership,
    ship._thermalRuntime?.hotPositions,
    ship._thermalRuntime?.pendingInputMembership,
    ship._thermalRuntime?.loadedGeneratorMembership,
    ship._thermalRuntime?.powerSourceMembership,
    ship._thermalRuntime?.dataSourceMembership,
    ship._thermalRuntime?.lifecycleMembership,
    ship._thermalRuntime?.workMembership,
    ship._thermalRuntime?.touchedMembership,
    ship._thermalRuntime?.edgeVisitStamps,
    ship._thermalRuntime?.transferEdgeIds,
    ship._thermalRuntime?.telemetryCandidateStamps
  ];
  const typedBytes = typedArrays.reduce((sum, value) => sum + (value?.byteLength || 0), 0)
    + (ship._thermalRuntime?.transferAmounts?.byteLength || 0)
    + (ship._thermalRuntime?.delta?.byteLength || 0)
    + (ship._thermalRuntime?.workingHeat?.byteLength || 0)
    + (ship._thermalRuntime?.outflow?.byteLength || 0)
    + (ship._thermalRuntime?.lastHeatValues?.byteLength || 0)
    + (ship._thermalRuntime?.telemetryValues?.byteLength || 0);
  const publicArrays = [
    "componentHeat", "componentHeatCapacity", "componentHeatState", "componentHeatGenerated",
    "componentHeatReceived", "componentHeatRemoved", "componentHeatTransferredOut",
    "componentHeatCooled", "componentHeatSentThroughFrame", "componentHeatRadiated",
    "componentVentedOverflowHeatThisTick", "componentTotalVentedOverflowHeat", "componentHeatInput",
    "componentMeltdown"
  ].reduce((sum, field) => sum + ((ship[field]?.length || 0) * 8), 0);
  const reusableLists = [
    "heatBearingComponents", "hotComponents", "pendingInputComponents",
    "loadedGeneratorComponents", "lifecycleComponents", "workComponents", "touchedComponents",
    "candidateEdgeIds", "telemetryComponents", "telemetrySpareComponents"
  ].reduce((sum, field) => sum + ((ship._thermalRuntime?.[field]?.length || 0) * 8), 0);
  return typedBytes + publicArrays + reusableLists + n * 32;
}

function approximateTopologyBytes(topology) {
  if (!topology) return 0;
  const edges = topology.edgeA.length;
  const scalarArrays = [
    topology.edgeA, topology.edgeB, topology.edgeSharedEdges, topology.edgeBaseConductivity,
    topology.edgeThroughFrame, topology.incidentEdgeIds,
    topology.incidentEdgeOffsets, topology.transferOrder, topology.transferRank,
    topology.powerSourceIndices, topology.dataSourceIndices, topology.radiatorIndices,
    topology.heatVentIndices, topology.heatSinkIndices, topology.thermalRouteIndices,
    topology.coolantPipeIndices
  ];
  const packedBytes = scalarArrays.reduce((sum, values) => sum + values.length * 8, 0);
  return packedBytes + edges * 32;
}

function runCanonicalMode({ shipCount, componentCount, scenario, templateShared }) {
  const heapBeforeRun = process.memoryUsage().heapUsed;
  const { fleet, template } = makeFleet(shipCount, componentCount, scenario, templateShared);
  prepareFleet(fleet, scenario);
  const room = {};
  const stepDurations = [];
  const visitedComponents = [];
  const visitedEdges = [];
  const transfers = [];
  const stableSkipped = [];
  const wakeups = [];

  const advance = (step, collect) => {
    applyScenarioInput(fleet, scenario, step);
    RoomTelemetry.resetRoomTelemetry(room);
    const started = performance.now();
    for (const ship of fleet) Heat.updateShipHeat(ship, HeatRules.TICK_SECONDS, room, step * HeatRules.TICK_SECONDS);
    const elapsed = performance.now() - started;
    if (collect) {
      stepDurations.push(elapsed);
      visitedComponents.push(room._roomTelemetry.heatComponentsVisited || 0);
      visitedEdges.push(room._roomTelemetry.heatEdgesVisited || 0);
      transfers.push(room._roomTelemetry.heatTransfersApplied || 0);
      stableSkipped.push(room._roomTelemetry.heatShipsStableSkipped || 0);
      wakeups.push(room._roomTelemetry.heatShipWakeups || 0);
    }
  };

  for (let step = 0; step < WARMUP_STEPS + DEFAULT_STEPS; step += 1) advance(step, step >= WARMUP_STEPS);
  const heapBeforeRepeatedRun = process.memoryUsage().heapUsed;
  for (let step = 0; step < DEFAULT_STEPS; step += 1) advance(WARMUP_STEPS + DEFAULT_STEPS + step, false);
  const heapAfterRepeatedRun = process.memoryUsage().heapUsed;

  const first = fleet[0];
  const topologyBytes = approximateTopologyBytes(first.thermalTopology);
  return {
    mode: "canonical",
    fixtureKind: templateShared ? "template-shared" : "direct",
    heatStageMs: stats(stepDurations),
    // This benchmark deliberately does not call this value a full simulation
    // step: it measures only the authoritative Heat stage over a fleet.
    fullSimulationStepMeasured: false,
    componentsVisited: stats(visitedComponents),
    edgesVisited: stats(visitedEdges),
    transfersApplied: stats(transfers),
    stableStepsSkipped: stableSkipped.reduce((sum, value) => sum + value, 0),
    wakeups: wakeups.reduce((sum, value) => sum + value, 0),
    topologyBuilds: templateShared ? 1 : fleet.reduce((sum, ship) => sum + (ship._thermalRuntime?.topologyBuilds || 0), 0),
    topologyCacheHits: fleet.reduce((sum, ship) => sum + (ship._thermalRuntime?.topologyCacheHits || 0), 0),
    topologySharedShips: fleet.reduce((sum, ship) => sum + (ship._thermalRuntime?.topologyShared ? 1 : 0), 0),
    templateTopologyIdentityVerified: templateShared
      ? fleet.every((ship) => ship.thermalTopology === template.thermalTopology)
      : false,
    approximateMemoryPerShipBytes: approximateRuntimeBytes(first),
    approximateRuntimeOnlyBytes: approximateRuntimeBytes(first),
    sharedTopologyMemoryBytes: templateShared ? topologyBytes : 0,
    topologyMemoryPerShipBytes: templateShared ? topologyBytes / Math.max(1, shipCount) : topologyBytes,
    heapGrowthOverRepeatedRunBytes: heapAfterRepeatedRun - heapBeforeRepeatedRun,
    heapGrowthIncludingConstructionBytes: process.memoryUsage().heapUsed - heapBeforeRun,
    outcomeChecksum: checksum(fleet),
    ships: shipCount,
    components: componentCount,
    scenario
  };
}

function fixtureDefinitions() {
  if (mode === "quick") {
    return [
      ["cold-idle-reactor", 100, 15],
      ["cold-no-reactors", 250, 75],
      ["one-active-engine", 100, 15],
      ["sparse-weapon-combat", 250, 75],
      ["mixed-idle-active", 500, 150],
      ["fully-warm-hot", 250, 150],
      ["damage-repair-churn", 250, 150],
      ["mixed-idle-active", 100, 225]
    ];
  }
  return [
    ["cold-idle-reactor", 100, 15], ["cold-idle-reactor", 250, 75], ["cold-idle-reactor", 500, 150], ["cold-idle-reactor", 1000, 150],
    ["cold-no-reactors", 100, 15], ["cold-no-reactors", 250, 75], ["cold-no-reactors", 500, 150], ["cold-no-reactors", 1000, 225],
    ["one-active-engine", 100, 15], ["one-active-engine", 250, 75], ["one-active-engine", 500, 150],
    ["sparse-weapon-combat", 100, 15], ["sparse-weapon-combat", 250, 75], ["sparse-weapon-combat", 500, 150],
    ["mixed-idle-active", 250, 75], ["mixed-idle-active", 500, 150], ["mixed-idle-active", 1000, 225],
    ["fully-warm-hot", 100, 75], ["fully-warm-hot", 250, 150], ["fully-warm-hot", 500, 225],
    ["damage-repair-churn", 100, 75], ["damage-repair-churn", 250, 150], ["damage-repair-churn", 500, 225],
    ["mixed-idle-active", 100, 225]
  ];
}

const fixtures = [];
for (const [scenario, shipCount, componentCount] of fixtureDefinitions()) {
  const canonical = runCanonicalMode({ shipCount, componentCount, scenario, templateShared: false });
  const repeat = runCanonicalMode({ shipCount, componentCount, scenario, templateShared: false });
  fixtures.push({ scenario, shipCount, componentCount, fixtureKind: "direct", canonical, repeat, equivalentOutcome: canonical.outcomeChecksum === repeat.outcomeChecksum });
}

// Hundreds of template-spawned ships are a separate fixture so shared-topology
// identity and the canonical immutable-topology memory cost are visible in the
// machine-readable result instead of being inferred from direct construction.
const templateCount = mode === "full" ? 500 : 250;
const templateComponents = mode === "full" ? 150 : 75;
const templateScenario = "mixed-idle-active";
const templateCanonical = runCanonicalMode({ shipCount: templateCount, componentCount: templateComponents, scenario: templateScenario, templateShared: true });
const templateRepeat = runCanonicalMode({ shipCount: templateCount, componentCount: templateComponents, scenario: templateScenario, templateShared: true });
fixtures.push({
  scenario: templateScenario,
  shipCount: templateCount,
  componentCount: templateComponents,
  fixtureKind: "template-shared",
  canonical: templateCanonical,
  repeat: templateRepeat,
  equivalentOutcome: templateCanonical.outcomeChecksum === templateRepeat.outcomeChecksum,
  topologyIdentityVerified: templateCanonical.templateTopologyIdentityVerified && templateRepeat.templateTopologyIdentityVerified
});

const output = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  mode,
  heatTickSeconds: HeatRules.TICK_SECONDS,
  methodology: {
    warmupSteps: WARMUP_STEPS,
    measuredSteps: DEFAULT_STEPS,
    timing: "performance.now wall-clock for Heat.updateShipHeat across the fleet",
    fullSimulationStepMeasured: false,
    fullSimulationStepNote: "A production whole-simulation boundary is not measured by this server-local Heat benchmark; heatStageMs must not be presented as whole-server speedup.",
    checksum: "rounded component Heat at 1e-6 units",
    memoryNote: "Approximate field-size estimate; shared topology is counted once for template fixtures."
  },
  fixtures,
  allEquivalent: fixtures.every((fixture) => fixture.equivalentOutcome),
  allTemplateTopologyIdentityVerified: fixtures.filter((fixture) => fixture.fixtureKind === "template-shared").every((fixture) => fixture.topologyIdentityVerified)
};
fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ outputPath: OUTPUT_PATH, mode, fixtures: fixtures.length, allEquivalent: output.allEquivalent, templateTopologyIdentityVerified: output.allTemplateTopologyIdentityVerified }, null, 2));
