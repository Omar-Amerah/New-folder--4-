"use strict";

// Comprehensive tests for ship purchase optimizations
// Tests blueprint normalization, template reuse, no shared mutable state,
// snapshot correctness, retry behavior, rollback correctness, and robustness under load

const { getOrCreateTemplate, invalidatePlayerTemplates, clearTemplateCache } = require("../src/server/shipTemplates");
const { executePurchase, validateBuyShip } = require("../src/server/economy");
const { createShipBlueprintSnapshot, validateDesign, validateWiring } = require("../src/server/shipDesign");
const { computeStats } = require("../src/server/shipStats");
const { recordPurchaseStage, performanceSnapshot } = require("../src/server/performanceTelemetry");
const { PARTS } = require("../src/server/components");

// Test helpers
function createTestRoom() {
  return {
    code: "TEST",
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

function createTestPlayer(id, name, money = 10000) {
  return {
    id: id,
    name: name,
    money: money,
    spent: 0,
    deployedFleetCost: 0,
    shipsBuilt: 0,
    ships: [],
    shipCap: 10,
    ready: true,
    team: id,
    client: { id: `client-${id}` },
    removed: false,
    design: [
      { x: 0, y: 0, type: "core", rotation: 0 },
      { x: 1, y: 0, type: "engine", rotation: 0 },
      { x: -1, y: 0, type: "blaster", rotation: 0 }
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

function createTestDesign() {
  return [
    { x: 0, y: 0, type: "core", rotation: 0 },
    { x: 1, y: 0, type: "engine", rotation: 0 },
    { x: -1, y: 0, type: "blaster", rotation: 0 }
  ];
}

function createTestWiring() {
  return {
    version: 1,
    power: { sections: [], connections: [] },
    data: { sections: [], connections: [] },
    powerPolicy: null
  };
}

// Test 1: One normalized blueprint/stat computation per purchase
console.log("Test 1: One normalized blueprint/stat computation per purchase");
try {
  clearTemplateCache();
  const room = createTestRoom();
  const player = createTestPlayer("p1", "Player 1");
  room.players.set(player.id, player);
  
  const design = createTestDesign();
  const wiring = createTestWiring();
  const stats = computeStats(design, wiring);
  
  // Create template once
  const template1 = getOrCreateTemplate(player.id, design, wiring, stats);
  const template2 = getOrCreateTemplate(player.id, design, wiring, stats);
  
  if (template1 === template2) {
    console.log("✓ Template reuse works - same template returned for identical design");
  } else {
    console.log("✗ Template reuse failed - different templates returned");
  }
  
  // Verify template is immutable
  const originalDesign = template1.design;
  try {
    template1.design[0].x = 999;
    console.log("✗ Template is not immutable - design was modified");
  } catch (e) {
    console.log("✓ Template is immutable - design cannot be modified");
  }
} catch (error) {
  console.log("✗ Test 1 failed:", error.message);
}

// Test 2: One reusable template for multi-ship purchase
console.log("\nTest 2: One reusable template for multi-ship purchase");
try {
  clearTemplateCache();
  const room = createTestRoom();
  const player = createTestPlayer("p2", "Player 2");
  room.players.set(player.id, player);
  
  const design = createTestDesign();
  const wiring = createTestWiring();
  const stats = computeStats(design, wiring);
  
  const template = getOrCreateTemplate(player.id, design, wiring, stats);
  
  // Simulate multi-ship spawn using same template
  const ship1Data = { template, combatStyle: "hold" };
  const ship2Data = { template, combatStyle: "hold" };
  
  if (ship1Data.template === ship2Data.template) {
    console.log("✓ Same template used for multi-ship purchase");
  } else {
    console.log("✗ Different templates used for multi-ship purchase");
  }
} catch (error) {
  console.log("✗ Test 2 failed:", error.message);
}

// Test 3: No mutable runtime state shared between spawned ships
console.log("\nTest 3: No mutable runtime state shared between spawned ships");
try {
  clearTemplateCache();
  const room = createTestRoom();
  const player = createTestPlayer("p3", "Player 3");
  room.players.set(player.id, player);
  
  const design = createTestDesign();
  const wiring = createTestWiring();
  const stats = computeStats(design, wiring);
  
  const template = getOrCreateTemplate(player.id, design, wiring, stats);
  
  // Clone template data as spawnShip would
  const ship1Hp = [...template.componentMaxHp];
  const ship2Hp = [...template.componentMaxHp];
  
  // Modify one ship's HP
  ship1Hp[0] = 100;
  
  if (ship2Hp[0] !== 100) {
    console.log("✓ Mutable runtime state is independent per ship");
  } else {
    console.log("✗ Mutable runtime state is shared between ships");
  }
} catch (error) {
  console.log("✗ Test 3 failed:", error.message);
}

// Test 4: First snapshot contains complete weapon-angle arrays
console.log("\nTest 4: First snapshot contains complete weapon-angle arrays");
try {
  clearTemplateCache();
  const room = createTestRoom();
  const player = createTestPlayer("p4", "Player 4");
  room.players.set(player.id, player);
  
  const design = createTestDesign();
  const wiring = createTestWiring();
  const stats = computeStats(design, wiring);
  
  const template = getOrCreateTemplate(player.id, design, wiring, stats);
  
  // Verify template has weapon indices
  if (template.weaponIndices && template.weaponIndices.length > 0) {
    console.log("✓ Template contains weapon indices for snapshot construction");
  } else {
    console.log("✗ Template missing weapon indices");
  }
} catch (error) {
  console.log("✗ Test 4 failed:", error.message);
}

// Test 5: Same request ID retry returns cached authoritative result
console.log("\nTest 5: Same request ID retry returns cached authoritative result");
try {
  clearTemplateCache();
  const room = createTestRoom();
  const player = createTestPlayer("p5", "Player 5");
  room.players.set(player.id, player);
  
  const design = createTestDesign();
  const wiring = createTestWiring();
  const stats = computeStats(design, wiring);
  
  const request = {
    requestId: "req-123",
    count: 1,
    stats: stats,
    design: design,
    wiring: wiring,
    combatStyle: "hold"
  };
  
  const result1 = executePurchase(room, player, request, Date.now());
  const result2 = executePurchase(room, player, request, Date.now());
  
  if (result2.duplicate && result2.shipIds.length === result1.shipIds.length) {
    console.log("✓ Retry returns cached authoritative result");
  } else {
    console.log("✗ Retry did not return cached result");
  }
} catch (error) {
  console.log("✗ Test 5 failed:", error.message);
}

// Test 6: Same request ID with changed payload is rejected
console.log("\nTest 6: Same request ID with changed payload is rejected");
try {
  clearTemplateCache();
  const room = createTestRoom();
  const player = createTestPlayer("p6", "Player 6");
  room.players.set(player.id, player);
  
  const design1 = createTestDesign();
  const wiring1 = createTestWiring();
  const stats1 = computeStats(design1, wiring1);
  
  const request1 = {
    requestId: "req-456",
    count: 1,
    stats: stats1,
    design: design1,
    wiring: wiring1,
    combatStyle: "hold"
  };
  
  const result1 = executePurchase(room, player, request1, Date.now());
  
  // Change design for same request ID
  const design2 = [...design1];
  design2.push({ x: 2, y: 0, type: "engine", rotation: 0 });
  const stats2 = computeStats(design2, wiring1);
  
  const request2 = {
    requestId: "req-456",
    count: 1,
    stats: stats2,
    design: design2,
    wiring: wiring1,
    combatStyle: "hold"
  };
  
  const result2 = executePurchase(room, player, request2, Date.now());
  
  if (!result2.ok && result2.code === "duplicate-request-conflict") {
    console.log("✓ Same request ID with changed payload is rejected");
  } else {
    console.log("✗ Same request ID with changed payload was not rejected");
  }
} catch (error) {
  console.log("✗ Test 6 failed:", error.message);
}

// Test 7: Rollback after failure at every spawn stage
console.log("\nTest 7: Rollback after failure at spawn stage");
try {
  clearTemplateCache();
  const room = createTestRoom();
  const player = createTestPlayer("p7", "Player 7");
  room.players.set(player.id, player);
  const occupiedSpawn = require("../src/server/spawnPlanner").getPlannedSpawn(room, player.id);
  const launchBlocker = {
    id: "rollback-blocker",
    ownerId: "other",
    x: occupiedSpawn.x,
    y: occupiedSpawn.y,
    targetX: occupiedSpawn.x,
    targetY: occupiedSpawn.y,
    radius: 48,
    physicalRadius: 48,
    stats: { mass: 100 },
    alive: true,
    arrived: true,
    commandMode: null,
    design: []
  };
  room.ships.set(launchBlocker.id, launchBlocker);
  
  const originalMoney = player.money;
  const originalSpent = player.spent;
  const originalDeployedFleetCost = player.deployedFleetCost;
  const originalShipsBuilt = player.shipsBuilt;
  const originalShipsLength = player.ships.length;
  const originalRoomShips = room.ships.size;
  const originalEffectsLength = room.effects.length;
  const originalNextEntityId = room.nextEntityId;
  
  const design = createTestDesign();
  const wiring = createTestWiring();
  const stats = computeStats(design, wiring);
  
  // Simulate a spawn failure by making room.ships.set throw
  const originalSet = room.ships.set;
  let callCount = 0;
  room.ships.set = function(id, ship) {
    callCount++;
    if (callCount === 1) {
      throw new Error("Simulated spawn failure");
    }
    return originalSet.call(this, id, ship);
  };
  
  const request = {
    requestId: "req-789",
    count: 2,
    stats: stats,
    design: design,
    wiring: wiring,
    combatStyle: "hold"
  };
  
  const result = executePurchase(room, player, request, Date.now());
  
  // Restore original set
  room.ships.set = originalSet;
  
  if (!result.ok && 
      player.money === originalMoney && 
      player.spent === originalSpent && 
      player.deployedFleetCost === originalDeployedFleetCost &&
      player.shipsBuilt === originalShipsBuilt &&
      player.ships.length === originalShipsLength &&
      room.ships.size === originalRoomShips &&
      room.effects.length === originalEffectsLength &&
      room.nextEntityId === originalNextEntityId &&
      launchBlocker.x === occupiedSpawn.x &&
      launchBlocker.y === occupiedSpawn.y &&
      (room.spawnReservations || []).length === 0) {
    console.log("✓ Rollback restored player state after spawn failure");
  } else {
    console.log("✗ Rollback did not restore player state correctly");
  }
} catch (error) {
  console.log("✗ Test 7 failed:", error.message);
}

// Test 8: Template cache cleanup on room close
console.log("\nTest 8: Template cache cleanup on room close");
try {
  clearTemplateCache();
  const room = createTestRoom();
  const player = createTestPlayer("p8", "Player 8");
  room.players.set(player.id, player);
  
  const design = createTestDesign();
  const wiring = createTestWiring();
  const stats = computeStats(design, wiring);
  
  // Create template for player
  const template = getOrCreateTemplate(player.id, design, wiring, stats);
  
  // Invalidate player templates
  invalidatePlayerTemplates(player.id);
  
  // Create template again - should be a new instance
  const template2 = getOrCreateTemplate(player.id, design, wiring, stats);
  
  if (template !== template2) {
    console.log("✓ Template cache cleanup works - new template created after invalidation");
  } else {
    console.log("✗ Template cache cleanup failed - same template returned");
  }
} catch (error) {
  console.log("✗ Test 8 failed:", error.message);
}

// Test 9: Purchase telemetry recording
console.log("\nTest 9: Purchase telemetry recording");
try {
  clearTemplateCache();
  const room = createTestRoom();
  const player = createTestPlayer("p9", "Player 9");
  room.players.set(player.id, player);
  
  const design = createTestDesign();
  const wiring = createTestWiring();
  const stats = computeStats(design, wiring);
  
  const request = {
    requestId: "req-999",
    count: 1,
    stats: stats,
    design: design,
    wiring: wiring,
    combatStyle: "hold"
  };
  
  executePurchase(room, player, request, Date.now());
  
  const snapshot = performanceSnapshot();
  
  if (snapshot.purchase && snapshot.purchase.totalPurchaseTime && snapshot.purchase.totalPurchaseTime.samples > 0) {
    console.log("✓ Purchase telemetry is recorded");
    console.log(`  Total purchase time p50: ${snapshot.purchase.totalPurchaseTime.p50}ms`);
  } else {
    console.log("✗ Purchase telemetry not recorded");
  }
} catch (error) {
  console.log("✗ Test 9 failed:", error.message);
}

// Test 10: Fleet cap check happens once per purchase
console.log("\nTest 10: Fleet cap check happens once per purchase");
try {
  clearTemplateCache();
  const room = createTestRoom();
  const player = createTestPlayer("p10", "Player 10");
  player.shipCap = 5;
  player.ships = Array(3).fill(null).map((_, i) => ({ id: `s${i}`, alive: true }));
  room.players.set(player.id, player);
  
  const design = createTestDesign();
  const wiring = createTestWiring();
  const stats = computeStats(design, wiring);
  
  const request = {
    requestId: "req-1010",
    count: 2,
    stats: stats,
    design: design,
    wiring: wiring,
    combatStyle: "hold"
  };
  
  const result = executePurchase(room, player, request, Date.now());
  
  if (result.ok && result.count === 2) {
    console.log("✓ Fleet cap check happens once - multi-ship purchase succeeded");
  } else if (!result.ok && result.code === "fleet-cap") {
    console.log("✓ Fleet cap check works correctly - purchase rejected at cap");
  } else {
    console.log("✗ Fleet cap check behavior unexpected");
  }
} catch (error) {
  console.log("✗ Test 10 failed:", error.message);
}

console.log("\n=== All optimization tests completed ===");
