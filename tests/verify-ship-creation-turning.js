"use strict";

const assert = require("assert");
const { createRoom } = require("../src/server/rooms");
const { computeStats } = require("../src/server/shipStats");
const { validateDesign } = require("../src/server/shipDesign");
const { validateBuildShip } = require("../src/server/validation");
const { executePurchase } = require("../src/server/economy");

const TURNING_ERROR = "Invalid design: ship must be able to turn.";
const noTurningDesign = [
  { x: 7, y: 7, type: "core" },
  { x: 7, y: 8, type: "compactEngine" },
  { x: 6, y: 7, type: "armor" },
  { x: 8, y: 7, type: "armor" }
];
const turningDesign = [
  { x: 7, y: 7, type: "core" },
  { x: 7, y: 8, type: "compactEngine" }
];

async function run() {
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null };
  globalThis.window = globalThis;
  const { validateBlueprint } = await import("../public/src/design/blueprintValidation.js");
  const noTurningStats = computeStats(noTurningDesign);
  const turningStats = computeStats(turningDesign);

  assert(noTurningStats.thrust > 0, "the invalid fixture has propulsion");
  assert.strictEqual(noTurningStats.turnRate, 0, "the invalid fixture has no bidirectional turning capability");
  assert(turningStats.turnRate > 0, "the valid fixture can turn");
  assert.strictEqual(validateDesign(noTurningDesign).ok, true, "structural editing remains permissive");
  assert.strictEqual(validateBlueprint(noTurningDesign, { requireThrust: false }).ok, true,
    "non-creation validation remains permissive");

  const clientResult = validateBlueprint(noTurningDesign);
  assert.strictEqual(clientResult.ok, false, "client creation preflight rejects a ship with no turning");
  assert(clientResult.errors.includes(TURNING_ERROR), "client preflight explains the missing turning capability");
  assert.strictEqual(validateBlueprint(turningDesign).ok, true, "client preflight accepts a ship that can turn");

  const room = createRoom("TURN", { seed: 17 });
  room.phase = "active";
  room.players.clear();
  room.ships.clear();
  const player = {
    id: "pilot",
    name: "Pilot",
    color: "#fff",
    team: "blue",
    ready: true,
    removed: false,
    client: {},
    design: noTurningDesign,
    stats: noTurningStats,
    ships: [],
    money: 1000,
    spent: 0,
    deployedFleetCost: 0,
    shipCap: 5,
    purchaseRequests: new Map()
  };
  room.players.set(player.id, player);

  const deployResult = validateBuildShip(room, player, noTurningStats);
  assert.deepStrictEqual(deployResult, { ok: false, reason: TURNING_ERROR },
    "active-match blueprint save rejects a ship with no turning");

  const purchaseResult = executePurchase(room, player, {
    requestId: "no-turning",
    count: 1,
    stats: noTurningStats,
    design: noTurningDesign,
    combatStyle: "hold"
  }, 1000);
  assert.strictEqual(purchaseResult.ok, false, "purchase rejects a ship with no turning");
  assert.strictEqual(purchaseResult.code, "invalid-design");
  assert.strictEqual(purchaseResult.message, TURNING_ERROR);
  assert.strictEqual(player.ships.length, 0, "rejected purchase creates no ship");

  console.log("Ship creation turning validation checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
