"use strict";

// Performance test for ship purchase optimizations
// Simulates a 12-player active match scenario measuring detailed performance metrics

const { getOrCreateTemplate, clearTemplateCache } = require("./src/server/shipTemplates");
const { executePurchase } = require("./src/server/economy");
const { computeStats } = require("./src/server/shipStats");
const { performanceSnapshot } = require("./src/server/performanceTelemetry");

function createTestRoom() {
  return {
    code: "PERF-TEST",
    phase: "active",
    players: new Map(),
    ships: new Map(),
    drones: new Map(),
    bullets: [],
    effects: [],
    nextEntityId: 1000,
    world: { width: 2000, height: 2000 },
    map: { safeZones: [] },
    spatialIndex: {
      append: () => {},
      remove: () => {},
      queryRangeUnordered: () => []
    }
  };
}

function createTestPlayer(id, team, money = 50000) {
  return {
    id: id,
    name: `Player ${id}`,
    money: money,
    spent: 0,
    deployedFleetCost: 0,
    shipsBuilt: 0,
    ships: [],
    shipCap: 10,
    ready: true,
    team: team,
    client: { id: `client-${id}` },
    removed: false,
    design: [
      { x: 0, y: 0, type: "core", rotation: 0 },
      { x: 1, y: 0, type: "engine", rotation: 0 },
      { x: -1, y: 0, type: "engine", rotation: 0 },
      { x: 0, y: 1, type: "blaster", rotation: 0 },
      { x: 0, y: -1, type: "blaster", rotation: 0 }
    ],
    wiring: {
      version: 1,
      power: { sections: [], connections: [] },
      data: { sections: [], connections: [] },
      powerPolicy: null
    },
    purchaseRequests: new Map()
  };
}

function createComplexDesign() {
  return [
    { x: 0, y: 0, type: "core", rotation: 0 },
    { x: 1, y: 0, type: "engine", rotation: 0 },
    { x: -1, y: 0, type: "engine", rotation: 0 },
    { x: 0, y: 1, type: "engine", rotation: 0 },
    { x: 0, y: -1, type: "engine", rotation: 0 },
    { x: 2, y: 0, type: "blaster", rotation: 0 },
    { x: -2, y: 0, type: "blaster", rotation: 0 },
    { x: 0, y: 2, type: "blaster", rotation: 0 },
    { x: 0, y: -2, type: "blaster", rotation: 0 },
    { x: 1, y: 1, type: "shield", rotation: 0 },
    { x: -1, y: -1, type: "shield", rotation: 0 }
  ];
}

function createComplexWiring() {
  return {
    version: 1,
    power: { sections: [], connections: [] },
    data: { sections: [], connections: [] },
    powerPolicy: null
  };
}

console.log("=== 12-Player Match Purchase Performance Test ===\n");

// Setup 12-player match
console.log("Setting up 12-player match...");
clearTemplateCache();
const room = createTestRoom();
const players = [];

for (let i = 0; i < 12; i++) {
  const team = i < 6 ? "team-a" : "team-b";
  const player = createTestPlayer(`p${i}`, team);
  room.players.set(player.id, player);
  players.push(player);
}

console.log(`✓ Created ${players.length} players (6 per team)`);

// Baseline: Single ship purchases
console.log("\n--- Baseline: Single Ship Purchases ---");
const design = createComplexDesign();
const wiring = createComplexWiring();
const stats = computeStats(design, wiring);

const singleShipStart = performance.now();
let singleShipSuccess = 0;
let singleShipFail = 0;

for (let i = 0; i < 24; i++) {
  const player = players[i % players.length];
  const request = {
    requestId: `single-${i}`,
    count: 1,
    stats: stats,
    design: design,
    wiring: wiring,
    combatStyle: "hold"
  };
  
  const result = executePurchase(room, player, request, Date.now());
  if (result.ok) {
    singleShipSuccess++;
  } else {
    singleShipFail++;
  }
}

const singleShipTime = performance.now() - singleShipStart;
console.log(`✓ Completed 24 single-ship purchases in ${singleShipTime.toFixed(2)}ms`);
console.log(`  Success: ${singleShipSuccess}, Failed: ${singleShipFail}`);
console.log(`  Average per purchase: ${(singleShipTime / 24).toFixed(2)}ms`);

// Multi-ship purchases
console.log("\n--- Multi-Ship Purchases (5 ships each) ---");
clearTemplateCache();
const multiShipStart = performance.now();
let multiShipSuccess = 0;
let multiShipFail = 0;

for (let i = 0; i < 12; i++) {
  const player = players[i];
  const request = {
    requestId: `multi-${i}`,
    count: 5,
    stats: stats,
    design: design,
    wiring: wiring,
    combatStyle: "hold"
  };
  
  const result = executePurchase(room, player, request, Date.now());
  if (result.ok) {
    multiShipSuccess += result.count;
  } else {
    multiShipFail++;
  }
}

const multiShipTime = performance.now() - multiShipStart;
console.log(`✓ Completed 12 multi-ship purchases (60 ships total) in ${multiShipTime.toFixed(2)}ms`);
console.log(`  Success: ${multiShipSuccess}, Failed: ${multiShipFail}`);
console.log(`  Average per ship: ${(multiShipTime / 60).toFixed(2)}ms`);
console.log(`  Average per purchase: ${(multiShipTime / 12).toFixed(2)}ms`);

// Concurrent purchase simulation
console.log("\n--- Concurrent Purchase Simulation ---");
clearTemplateCache();
const concurrentStart = performance.now();
let concurrentSuccess = 0;
let concurrentFail = 0;

// Simulate rapid purchases from multiple players
for (let round = 0; round < 3; round++) {
  for (let i = 0; i < 12; i++) {
    const player = players[i];
    const request = {
      requestId: `concurrent-${round}-${i}`,
      count: 2,
      stats: stats,
      design: design,
      wiring: wiring,
      combatStyle: "hold"
    };
    
    const result = executePurchase(room, player, request, Date.now());
    if (result.ok) {
      concurrentSuccess += result.count;
    } else {
      concurrentFail++;
    }
  }
}

const concurrentTime = performance.now() - concurrentStart;
console.log(`✓ Completed 36 concurrent purchases (72 ships) in ${concurrentTime.toFixed(2)}ms`);
console.log(`  Success: ${concurrentSuccess}, Failed: ${concurrentFail}`);
console.log(`  Average per ship: ${(concurrentTime / 72).toFixed(2)}ms`);

// Template reuse test
console.log("\n--- Template Reuse Test ---");
clearTemplateCache();
const templateReuseStart = performance.now();
let templateReuseCount = 0;

for (let i = 0; i < 50; i++) {
  const player = players[i % players.length];
  const template = getOrCreateTemplate(player.id, design, wiring, stats);
  templateReuseCount++;
}

const templateReuseTime = performance.now() - templateReuseStart;
console.log(`✓ Created/retrieved 50 templates in ${templateReuseTime.toFixed(2)}ms`);
console.log(`  Average per template: ${(templateReuseTime / 50).toFixed(2)}ms`);

// Performance snapshot
console.log("\n--- Performance Metrics ---");
const snapshot = performanceSnapshot();

if (snapshot.purchase) {
  console.log("Purchase Stage Metrics:");
  for (const [stage, metrics] of Object.entries(snapshot.purchase)) {
    if (metrics.samples > 0) {
      console.log(`  ${stage}:`);
      console.log(`    Samples: ${metrics.samples}`);
      console.log(`    p50: ${metrics.p50.toFixed(3)}ms`);
      console.log(`    p95: ${metrics.p95.toFixed(3)}ms`);
      console.log(`    max: ${metrics.max.toFixed(3)}ms`);
    }
  }
}

// Summary
console.log("\n=== Performance Test Summary ===");
console.log(`Single ship purchases: ${(singleShipTime / 24).toFixed(2)}ms avg`);
console.log(`Multi-ship purchases: ${(multiShipTime / 60).toFixed(2)}ms avg per ship`);
console.log(`Concurrent purchases: ${(concurrentTime / 72).toFixed(2)}ms avg per ship`);
console.log(`Template reuse: ${(templateReuseTime / 50).toFixed(2)}ms avg`);

const totalShips = singleShipSuccess + multiShipSuccess + concurrentSuccess;
const totalTime = singleShipTime + multiShipTime + concurrentTime;
console.log(`\nTotal ships spawned: ${totalShips}`);
console.log(`Total time: ${totalTime.toFixed(2)}ms`);
console.log(`Overall average: ${(totalTime / totalShips).toFixed(2)}ms per ship`);

console.log("\n=== Performance Test Completed ===");
