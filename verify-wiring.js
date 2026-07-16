#!/usr/bin/env node
// Verifies the shared ship-wiring engine (public/src/shared/wiringRules.js):
// segment normalization/validation, deduplication, ports, network discovery,
// deterministic labels, reachability, bonus previews, routing, and the
// default-ship wiring shipped in src/server/config.js.
"use strict";
const assert = require("assert");
const W = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");
const { DEFAULT_DESIGN, DEFAULT_WIRING } = require("./src/server/config");
const { validateWiring } = require("./src/server/shipDesign");
const { validateClientMessage } = require("./src/server/clientSchemas");

// ---- Segment normalization ----
assert.deepStrictEqual(W.normalizeSegment({ x1: 8, y1: 6, x2: 7, y2: 6 }), { x1: 7, y1: 6, x2: 8, y2: 6 }, "reversed segments normalize to canonical order");
assert.strictEqual(W.normalizeSegment({ x1: 7, y1: 6, x2: 8, y2: 7 }), null, "diagonal segments are rejected");
assert.strictEqual(W.normalizeSegment({ x1: 7, y1: 6, x2: 7, y2: 6 }), null, "zero-length segments are rejected");
assert.strictEqual(W.normalizeSegment({ x1: 7, y1: 6, x2: 9, y2: 6 }), null, "segments must join neighbouring grid points");
assert.strictEqual(W.normalizeSegment({ x1: -1, y1: 0, x2: 0, y2: 0 }), null, "segments must stay inside the blueprint area");
assert.strictEqual(W.segmentKey({ x1: 7, y1: 6, x2: 8, y2: 6 }), "7,6:8,6", "canonical segment keys");

// ---- Normalization against a ship: dedupe, floating removal, ordering ----
const miniShip = [
  { x: 7, y: 7, type: "core" },
  { x: 7, y: 8, type: "frame" }
];
const rawWiring = {
  power: [
    { x1: 8, y1: 7, x2: 7, y2: 7 },
    { x1: 7, y1: 7, x2: 8, y2: 7 },   // duplicate (reversed) — removed
    { x1: 7, y1: 7, x2: 8, y2: 7 },   // duplicate — removed
    { x1: 0, y1: 0, x2: 1, y2: 0 },   // floating far from the ship — removed
    { x1: 7, y1: 8, x2: 7, y2: 9 }
  ],
  data: [{ x1: 7, y1: 7, x2: 8, y2: 7 }] // Power and Data may share a grid edge
};
const normalized = W.normalizeWiring(rawWiring, miniShip, PARTS);
assert.strictEqual(normalized.wiring.version, W.WIRING_VERSION);
assert.deepStrictEqual(normalized.wiring.power, [
  { x1: 7, y1: 7, x2: 8, y2: 7 },
  { x1: 7, y1: 8, x2: 7, y2: 9 }
], "duplicates and floating segments removed, deterministic order");
assert.strictEqual(normalized.droppedSegments, 1, "invalid/floating segment count reported (duplicates dedupe silently)");
assert.deepStrictEqual(normalized.wiring.data, [{ x1: 7, y1: 7, x2: 8, y2: 7 }], "data may reuse a power edge");
assert.ok(W.validateSegment({ x1: 0, y1: 0, x2: 1, y2: 0 }, miniShip, PARTS).ok === false, "validateSegment flags floating segments");
assert.strictEqual(W.validateSegment({ x1: 0, y1: 0, x2: 1, y2: 0 }, miniShip, PARTS).reason, "floating");

// Segment cap
const flood = { power: [] };
for (let y = 0; y <= 15; y += 1) for (let x = 0; x < 15; x += 1) flood.power.push({ x1: x, y1: y, x2: x + 1, y2: y });
const fullBoard = [];
for (let y = 0; y < 15; y += 1) for (let x = 0; x < 15; x += 1) fullBoard.push({ x, y, type: "frame" });
const capped = W.normalizeWiring(flood, fullBoard, PARTS);
assert.ok(capped.wiring.power.length <= W.MAX_SEGMENTS_PER_KIND, "per-kind segment cap enforced");

// ---- Rotated multi-cell footprint ports ----
const rotatedReactor = [{ x: 6, y: 6, type: "reactor", rotation: 90 }]; // occupies (6,6) and (6,7)
const ports = W.componentPorts(rotatedReactor[0], PARTS);
const portKeys = new Set(ports.map((p) => `${p.x},${p.y}`));
for (const key of ["6,6", "7,6", "6,7", "7,7", "6,8", "7,8"]) {
  assert.ok(portKeys.has(key), `rotated reactor exposes port ${key}`);
}
assert.strictEqual(ports.length, 6, "2x1 rotated footprint exposes 6 perimeter ports");

// ---- Networks, membership, reachability ----
const powerShip = [
  { x: 7, y: 7, type: "core" },
  { x: 6, y: 7, type: "shield" },
  { x: 9, y: 7, type: "shield" },   // separated consumer
  { x: 8, y: 7, type: "frame" }
];
const powerWiring = { power: [{ x1: 6, y1: 7, x2: 7, y2: 7 }], data: [] };
let analysis = W.analyzeWiring(powerShip, powerWiring, PARTS);
assert.strictEqual(analysis.power.networks.length, 1);
assert.strictEqual(analysis.power.networks[0].label, "Power Network 1");
assert.deepStrictEqual(analysis.power.networks[0].componentIndices, [0, 1], "membership derived from ports");
assert.ok(W.componentReachesPowerSource(analysis, 1), "wired shield reaches the core");
assert.ok(!W.componentReachesPowerSource(analysis, 2), "unwired shield does not");
assert.deepStrictEqual(analysis.power.disconnectedConsumerIndices, [2]);
assert.ok(analysis.warnings.some((w) => w.code === "unpowered-consumer"), "disconnected consumer warning");
assert.strictEqual(analysis.power.networks[0].generation, PARTS.core.powerGeneration);
assert.strictEqual(analysis.power.networks[0].demand, PARTS.shield.powerUse);

// Networks merge through a component that touches two wire runs.
const bridgeWiring = { power: [
  { x1: 6, y1: 7, x2: 6, y2: 8 },   // touches shield at (6,7) only
  { x1: 8, y1: 7, x2: 8, y2: 8 }    // touches core at (8,7) / frame
], data: [] };
analysis = W.analyzeWiring(powerShip, bridgeWiring, PARTS);
assert.strictEqual(analysis.power.networks.length, 2, "separate wire runs form separate networks unless bridged");
const bridged = W.analyzeWiring(powerShip, { power: [
  { x1: 6, y1: 7, x2: 6, y2: 8 },
  { x1: 7, y1: 7, x2: 7, y2: 8 }    // both runs touch the core's ports -> one network through the core
], data: [] }, PARTS);
assert.strictEqual(bridged.power.networks.length, 1, "components internally connect their ports into one network");

// ---- Data networks: labels, compatibility, bonus preview ----
const dataShip = [
  { x: 7, y: 7, type: "signalAmplifier" },
  { x: 5, y: 7, type: "blaster" },
  { x: 9, y: 7, type: "blaster" },
  { x: 7, y: 5, type: "fireControl" },
  { x: 7, y: 3, type: "beamEmitter" },
  { x: 6, y: 7, type: "frame" },
  { x: 8, y: 7, type: "frame" },
  { x: 7, y: 6, type: "frame" },
  { x: 7, y: 4, type: "frame" }
];
const dataWiring = { power: [], data: [
  { x1: 6, y1: 7, x2: 7, y2: 7 },   // amplifier <- blaster A
  { x1: 8, y1: 7, x2: 9, y2: 7 },   // amplifier -> blaster B (via shared ports)
  { x1: 7, y1: 7, x2: 8, y2: 7 },
  { x1: 5, y1: 7, x2: 6, y2: 7 },
  { x1: 7, y1: 4, x2: 7, y2: 5 }    // fire control <-> beam emitter (incompatible)
], data2: undefined };
analysis = W.analyzeWiring(dataShip, dataWiring, PARTS);
assert.strictEqual(analysis.data.networks.length, 2, "two data networks");
assert.deepStrictEqual(analysis.data.networks.map((n) => n.label), ["Weapon Network A", "Weapon Network B"], "labels ordered by upper-left position");
const amplifier = analysis.data.supports.find((s) => s.type === "signalAmplifier");
assert.strictEqual(amplifier.connectedWeaponIndices.length, 2, "amplifier reaches both blasters");
assert.strictEqual(amplifier.bonusTotal, 75, "signal amplifier range bonus total");
assert.strictEqual(amplifier.bonusPerWeapon, 37.5, "equal split preview: 75 / 2 weapons");
const fireControl = analysis.data.supports.find((s) => s.type === "fireControl");
assert.strictEqual(fireControl.connectedWeaponIndices.length, 0, "beam emitter is not fire-control compatible");
assert.deepStrictEqual(fireControl.incompatibleWeaponIndices, [4]);
assert.ok(analysis.warnings.some((w) => w.code === "incompatible-weapon"), "incompatible weapon warning");
assert.ok(analysis.warnings.some((w) => w.code === "support-without-weapon"), "support without compatible weapon warning");
const weaponEntry = analysis.data.weapons.find((w2) => w2.index === 1);
assert.deepStrictEqual(weaponEntry.supportIndices, [0], "weapon reports its connected support modules");

// Deterministic results: same blueprint (shuffled segment order) -> same summaries.
const shuffled = { power: [], data: dataWiring.data.slice().reverse() };
const analysis2 = W.analyzeWiring(dataShip, shuffled, PARTS);
assert.deepStrictEqual(W.networkSummaries(analysis2), W.networkSummaries(analysis), "deterministic network summaries");

// ---- Routing ----
const routeShip = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "frame" },
  { x: 9, y: 7, type: "shield" },
  { x: 3, y: 3, type: "shield" }    // island far from the rest
];
const route = W.findRoute(routeShip, 0, 2, PARTS);
assert.ok(route.ok, "route across the hull is found");
assert.ok(route.segments.length >= 1);
const routeAgain = W.findRoute(routeShip, 0, 2, PARTS);
assert.deepStrictEqual(routeAgain.segments, route.segments, "route calculation is deterministic (preview === placement)");
const unreachable = W.findRoute(routeShip, 0, 3, PARTS);
assert.strictEqual(unreachable.ok, false, "routes cannot float across empty space");
assert.strictEqual(unreachable.reason, "unreachable");

// Adjacent components still get a real segment so the network is derived from wires.
const adjacent = W.findRoute([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "shield" }], 0, 1, PARTS);
assert.ok(adjacent.ok && adjacent.segments.length === 1, "adjacent components connect with one deterministic edge");

// addRoute / removeSegments round trip
let wiring = W.emptyWiring();
wiring = W.addRoute(wiring, "power", route.segments, routeShip, PARTS);
assert.ok(wiring.power.length === route.segments.length, "route segments added");
wiring = W.addRoute(wiring, "power", route.segments, routeShip, PARTS);
assert.ok(wiring.power.length === route.segments.length, "re-adding the same route deduplicates");
wiring = W.removeSegments(wiring, "power", route.segments, routeShip, PARTS);
assert.strictEqual(wiring.power.length, 0, "route removal clears its segments");

// ---- Server-side validation path never trusts client results ----
const hostile = {
  power: [{ x1: 6, y1: 7, x2: 7, y2: 7 }],
  data: [],
  networks: [{ id: "spoofed" }],
  poweredStates: { all: true }
};
const validated = validateWiring(powerShip, hostile);
assert.ok(validated.ok);
assert.deepStrictEqual(Object.keys(validated.wiring).sort(), ["data", "power", "version"], "server output carries only version/power/data");
assert.equal(validateClientMessage({ type: "deploy", design: [{ type: "core", x: 7, y: 7 }], wiring: hostile }).code, "invalid-wiring", "schema rejects payloads with precomputed network fields");

// ---- Default ship wiring ----
const defaultAnalysis = W.analyzeWiring(DEFAULT_DESIGN.map((p) => ({ ...p })), DEFAULT_WIRING, PARTS);
assert.strictEqual(defaultAnalysis.droppedSegments, 0, "default wiring is fully valid");
assert.strictEqual(defaultAnalysis.power.networks.length, 1, "default ship has one power network");
assert.strictEqual(defaultAnalysis.power.disconnectedConsumerIndices.length, 0, "every powered component reaches a source");
assert.strictEqual(defaultAnalysis.power.networks[0].sourceIndices.length, 3, "core + reactor + aux generator share the default network");
assert.deepStrictEqual(defaultAnalysis.data.networks, [], "default ship has no data wiring");
assert.deepStrictEqual(defaultAnalysis.warnings, [], "default ship has no wiring warnings");

// ---- Client/server share one engine ----
(async () => {
  await import("./public/src/shared/wiringRules.js");
  assert.ok(globalThis.WiringRules, "shared module attaches to globalThis for the browser");
  assert.strictEqual(globalThis.WiringRules.WIRING_VERSION, W.WIRING_VERSION);
  assert.deepStrictEqual(
    globalThis.WiringRules.normalizeWiring(rawWiring, miniShip, PARTS),
    normalized,
    "browser-global engine and CommonJS engine agree"
  );
  console.log("Wiring verification passed");
})().catch((err) => { console.error(err); process.exit(1); });
