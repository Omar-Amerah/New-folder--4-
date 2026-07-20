"use strict";

const assert = require("assert");
const WiringRules = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");
const { analyzeShipPower } = require("./src/server/shipDesign");
const { spawnShip } = require("./src/server/ships");

const moduleAt = (type, x, y) => ({ type, x, y, rotation: 0 });
function wiringFor(design, paths) {
  let wiring = WiringRules.emptyWiring();
  for (const [source, target, cells] of paths) wiring = WiringRules.addConnection(wiring, "power", source, target, cells, design, PARTS);
  return wiring;
}

const design = [moduleAt("core", 0, 0), moduleAt("engine", 3, 0), moduleAt("engine", 3, 2), moduleAt("reactor", 1, 2), moduleAt("frame", 1, 0), moduleAt("frame", 2, 0), moduleAt("frame", 1, 1), moduleAt("frame", 2, 1)];
const shared = wiringFor(design, [
  [0, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]],
  [0, 2, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 2 }]],
  [3, 2, [{ x: 2, y: 2 }, { x: 3, y: 2 }]]
]);
const analysis = WiringRules.analyzePowerNetworks(design, shared, PARTS);
assert.equal(analysis.networkCount, 1, "shared cells/trunks and terminals join one network");
assert.deepEqual(analysis.networks[0].sourceIndices, [0, 3]);
assert.deepEqual(analysis.networks[0].consumerIndices, [1, 2]);
assert.equal(analysis.networks[0].demandMw, PARTS.engine.powerUse * 2, "unique consumers count once");
assert.equal(analysis.networks[0].generationMw, PARTS.core.powerGeneration + PARTS.reactor.powerGeneration, "unique sources count once");
assert.deepEqual(analyzeShipPower(design, shared), analysis, "server uses the shared analyzer");

const empty = WiringRules.analyzePowerNetworks(design, null, PARTS);
assert.equal(empty.networkCount, 0);
assert.deepEqual(empty.disconnectedConsumerIndices, [1, 2]);
assert.deepEqual(empty.unusedSourceIndices, [0, 3]);

const transitDesign = [moduleAt("core", 0, 0), moduleAt("engine", 3, 0), moduleAt("engine", 1, 0), moduleAt("frame", 2, 0)];
const transit = WiringRules.analyzePowerNetworks(transitDesign, wiringFor(transitDesign, [[0, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]]]), PARTS);
assert.deepEqual(transit.networks[0].consumerIndices, [1, 2], "every crossed consumer automatically joins");
assert(!transit.disconnectedConsumerIndices.includes(2));
const crossedSourceDesign = [moduleAt("core", 0, 0), moduleAt("auxGenerator", 1, 0), moduleAt("engine", 2, 0)];
const crossedSource = WiringRules.analyzePowerNetworks(crossedSourceDesign, wiringFor(crossedSourceDesign, [[0, 2, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]]), PARTS);
assert.deepEqual(crossedSource.networks[0].sourceIndices, [0, 1], "every crossed source automatically joins");
assert(!crossedSource.unusedSourceIndices.includes(1));

const weakDesign = [moduleAt("auxGenerator", 0, 0), moduleAt("engine", 1, 0)];
const weak = WiringRules.analyzePowerNetworks(weakDesign, wiringFor(weakDesign, [[0, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }]]]), PARTS);
assert(["online", "underpowered"].includes(weak.networks[0].status));

const malformed = WiringRules.cloneWiring(shared);
malformed.power.connections.push({ sourceIndex: 0, targetIndex: 1, sectionIds: ["missing"] });
const invalid = WiringRules.analyzePowerNetworks(design, malformed, PARTS);
assert.equal(invalid.invalidConnectionCount, 0, "legacy route metadata cannot contradict valid physical sections");
assert.equal(invalid.networks[0].demandMw, analysis.networks[0].demandMw);
assert.deepEqual(WiringRules.analyzePowerNetworks(design, shared, PARTS), analysis, "analysis is deterministic and non-mutating");

const room = { nextEntityId: 1, mapSeed: 1, world: { width: 1000, height: 1000 }, ships: new Map(), effects: [], players: new Map(), safeZones: [] };
const stats = { maxHp: 10, maxShield: 0, unitCost: 1, radius: 10 };
const player = { id: "p", shipCap: 1, ships: [], design, wiring: shared, stats };
const ship = spawnShip(room, player, 0, 0, { design, wiring: shared, stats });
// Runtime ship.powerAnalysis is now the shared 7C-2 power-flow solver result,
// not the static connection analyzer. The pure analyzeShipPower authority is
// unchanged (asserted above); only the runtime allocator moved to the solver.
assert.strictEqual(ship.powerAnalysis, ship.powerFlow, "runtime power analysis is the shared power-flow solver result");
assert(Array.isArray(ship.powerAnalysis.networks) && Array.isArray(ship.powerAnalysis.byComponentIndex), "solver result exposes networks and per-component allocations");
assert.deepEqual(ship.stats, stats, "spawn analysis does not change gameplay stats");

console.log("Power analysis verification passed.");

const heatPipeOnly = [moduleAt("core", 0, 0), moduleAt("heatPipe", 1, 0)];
const heatPipePower = WiringRules.analyzePowerNetworks(heatPipeOnly, null, PARTS);
assert.deepEqual(heatPipePower.consumerIndices, [], "Heat Pipe is a passive Power component");
assert.deepEqual(heatPipePower.disconnectedConsumerIndices, [], "unwired Heat Pipe does not create disconnected Power status");
