"use strict";

const assert = require("assert");
const { ECONOMY, DEFAULT_DESIGN } = require("../src/server/config");
const { createRoom } = require("../src/server/rooms");
const { computeStats } = require("../src/server/shipStats");
const { executePurchase, updateEconomy, activeFleetCount, PURCHASE_IDEMPOTENCY_TTL_MS } = require("../src/server/economy");
const { snapshotRoom } = require("../src/server/snapshots");

function makePlayer(id, team = "blue") {
  const design = DEFAULT_DESIGN.map((part) => ({ ...part }));
  return {
    id,
    name: id,
    color: "#fff",
    team,
    isBot: false,
    ready: true,
    design,
    stats: computeStats(design),
    ships: [],
    money: 1000,
    income: ECONOMY.baseIncome,
    incomeRemainder: 0,
    earned: 1000,
    spent: 0,
    maxMoney: ECONOMY.maxMoney,
    shipCap: ECONOMY.shipCap,
    deployedFleetCost: 0,
    destroyedEnemyCost: 0,
    lostFleetCost: 0,
    kills: 0,
    losses: 0,
    captures: 0,
    connected: true,
    removed: false,
    client: {},
    purchaseRequests: new Map()
  };
}

function makeActiveRoom() {
  const room = createRoom("ECON", { seed: 42 });
  room.phase = "active";
  room.players.clear();
  room.ships.clear();
  room.clients.clear();
  room.nextEntityId = 1;
  const p1 = makePlayer("p1", "blue");
  const p2 = makePlayer("p2", "red");
  room.players.set(p1.id, p1);
  room.players.set(p2.id, p2);
  return { room, p1, p2 };
}

function purchasePayload(player, requestId, count = 1) {
  return {
    requestId,
    count,
    stats: player.stats,
    design: player.design,
    combatStyle: "charge"
  };
}

function testIdempotentPurchase() {
  const { room, p1 } = makeActiveRoom();
  const first = executePurchase(room, p1, purchasePayload(p1, "same-id", 1), 1000);
  assert.strictEqual(first.ok, true, "first purchase should succeed");
  assert.strictEqual(first.count, 1, "first purchase creates one ship");
  const afterFirst = { money: p1.money, spent: p1.spent, ships: p1.ships.length, ids: first.shipIds.join(",") };

  const replay = executePurchase(room, p1, purchasePayload(p1, "same-id", 1), 1010);
  assert.strictEqual(replay.ok, true, "identical replay returns success");
  assert.strictEqual(replay.duplicate, true, "identical replay is marked duplicate internally");
  assert.strictEqual(p1.money, afterFirst.money, "replay must not charge again");
  assert.strictEqual(p1.spent, afterFirst.spent, "replay must not add spent again");
  assert.strictEqual(p1.ships.length, afterFirst.ships, "replay must not spawn again");
  assert.strictEqual(replay.shipIds.join(","), afterFirst.ids, "replay returns original ship ids");

  const conflict = executePurchase(room, p1, purchasePayload(p1, "same-id", 2), 1020);
  assert.strictEqual(conflict.ok, false, "same request ID with different payload is rejected");
  assert.strictEqual(conflict.code, "duplicate-request-conflict");
}

function testAtomicFleetAndFunds() {
  const { room, p1 } = makeActiveRoom();
  const cost = p1.stats.unitCost;
  p1.money = cost;
  const one = executePurchase(room, p1, purchasePayload(p1, "one", 1), 2000);
  assert.strictEqual(one.ok, true, "exact-money purchase should succeed");
  assert.strictEqual(Math.floor(p1.money), 0, "exact-money purchase leaves zero floor balance");
  const two = executePurchase(room, p1, purchasePayload(p1, "two", 1), 2010);
  assert.strictEqual(two.ok, false, "second purchase without funds should fail");
  assert.strictEqual(two.code, "insufficient-funds");
  assert.strictEqual(p1.ships.length, 1, "failed purchase spawns no ships");
  assert.strictEqual(p1.spent, cost, "failed purchase does not change spent");

  const capped = makeActiveRoom();
  capped.p1.shipCap = activeFleetCount(capped.p1) + 4;
  const capResult = executePurchase(capped.room, capped.p1, purchasePayload(capped.p1, "five", 5), 3000);
  assert.strictEqual(capResult.ok, false, "five-ship purchase with four slots should fail all-or-nothing");
  assert.strictEqual(capResult.code, "fleet-cap");
  assert.strictEqual(capped.p1.ships.length, 0, "fleet-cap failure does not partially spawn");
  assert.strictEqual(capped.p1.spent, 0, "fleet-cap failure does not charge");
}

function testIncomePrecisionAndPrivacy() {
  const { room, p1, p2 } = makeActiveRoom();
  p1.money = 0;
  p1.earned = 0;
  updateEconomy(room, 0.1);
  updateEconomy(room, 0.2);
  const split = { money: p1.money, remainder: p1.incomeRemainder };
  p1.money = 0;
  p1.earned = 0;
  p1.incomeRemainder = 0;
  updateEconomy(room, 0.3);
  assert.deepStrictEqual({ money: p1.money, remainder: p1.incomeRemainder }, split, "whole income and its private remainder are subdivision invariant");
  p1.money = 0;
  p1.earned = 0;
  p1.incomeRemainder = 0;
  updateEconomy(room, 1 / 30);
  assert.strictEqual(p1.money, 0, "a fractional tick does not enter the authoritative wallet");
  assert(p1.incomeRemainder > 0 && p1.incomeRemainder < 1, "a fractional tick is retained privately");
  updateEconomy(room, 2 / 30);
  assert.strictEqual(p1.money, 2, "accumulated passive income transfers only whole currency");
  assert.strictEqual(Number.isInteger(p1.earned), true, "earned currency remains whole internally");

  p1.money = 123;
  p1.earned = 456;
  p1.spent = 89;
  const enemyView = snapshotRoom(room, 4000, p2, true);
  const p1RowForEnemy = enemyView.players.find((player) => player.id === "p1");
  assert.strictEqual(p1RowForEnemy.money, null, "enemy snapshot hides current money");
  assert.strictEqual(p1RowForEnemy.income, null, "enemy snapshot hides income");
  assert.strictEqual(p1RowForEnemy.spent, null, "enemy snapshot hides spent during active match");
  assert.strictEqual(p1RowForEnemy.deployedFleetCost, null, "enemy snapshot hides deployed value during active match");

  const ownView = snapshotRoom(room, 4000, p1, true);
  const ownRow = ownView.players.find((player) => player.id === "p1");
  assert.strictEqual(ownRow.money, 123, "own snapshot publishes the whole authoritative wallet");
}

function testTeamRelayIncome() {
  assert.strictEqual(ECONOMY.baseIncome, 20, "base income is $20/s");
  assert.strictEqual(ECONOMY.relayIncome, 5, "each captured relay is worth $5/s");
  const { room, p1, p2 } = makeActiveRoom();
  const ally = makePlayer("ally", "blue");
  room.players.set(ally.id, ally);
  room.points = [{ id: "relay", ownerTeam: "blue", progress: 1 }];
  for (const player of [p1, p2, ally]) {
    player.money = 0;
    player.earned = 0;
  }

  updateEconomy(room, 1);

  assert.strictEqual(p1.income, 25, "capturing player receives base plus relay income");
  assert.strictEqual(ally.income, 25, "every teammate receives the relay income");
  assert.strictEqual(p2.income, 20, "opposing team receives base income only");
  assert.strictEqual(p1.money, 25);
  assert.strictEqual(ally.money, 25);
  assert.strictEqual(p2.money, 20);
}

function testCacheBoundedAndTtlDocumented() {
  const { room, p1 } = makeActiveRoom();
  p1.money = 9999;
  for (let i = 0; i < 70; i += 1) {
    executePurchase(room, p1, purchasePayload(p1, `req-${i}`, 1), 5000 + i);
  }
  assert.ok(p1.purchaseRequests.size <= 64, "purchase idempotency cache is bounded");
  executePurchase(room, p1, purchasePayload(p1, "fresh", 1), 5000 + PURCHASE_IDEMPOTENCY_TTL_MS + 1000);
  assert.ok(p1.purchaseRequests.size < 64, "stale idempotency entries are pruned by TTL");
}

testIdempotentPurchase();
testAtomicFleetAndFunds();
testIncomePrecisionAndPrivacy();
testTeamRelayIncome();
testCacheBoundedAndTtlDocumented();
console.log("Economy, purchase, precision, and privacy checks passed");
