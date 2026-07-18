"use strict";

const assert = require("assert");
const { createRoom } = require("./src/server/rooms");
const { DEFAULT_DESIGN } = require("./src/server/config");
const { computeStats } = require("./src/server/shipStats");
const { createGeneratedPowerWiring, validateWiring } = require("./src/server/shipDesign");
const { executePurchase, buyShip } = require("./src/server/economy");
const { spawnShip, addBot } = require("./src/server/ships");

function setup() {
  const room = createRoom("WIRE"); room.phase = "active"; room.players.clear(); room.ships.clear(); room.effects.length = 0;
  const design = DEFAULT_DESIGN.map((part) => ({ ...part }));
  const wiring = createGeneratedPowerWiring(design);
  const player = { id: "p", name: "Pilot", team: "blue", ready: true, design, wiring, stats: computeStats(design), ships: [], money: 100000, spent: 0, deployedFleetCost: 0, shipCap: 10, connected: true, removed: false, client: {}, purchaseRequests: new Map() };
  room.players.set(player.id, player);
  return { room, player, design, wiring };
}

{
  const { room, player, design, wiring } = setup();
  const request = { requestId: "multi", count: 2, stats: player.stats, design, wiring, combatStyle: "charge" };
  const result = executePurchase(room, player, request, 1);
  assert(result.ok && result.count === 2, "normalized wiring reaches multi-spawn purchase");
  const [a, b] = player.ships;
  assert.deepStrictEqual(a.wiring, wiring); assert.deepStrictEqual(b.wiring, wiring);
  assert.notStrictEqual(a.wiring, b.wiring); assert.notStrictEqual(a.wiring.power.sections, b.wiring.power.sections);
  const before = JSON.stringify(a.wiring); player.wiring.power.sections.length = 0; b.wiring.power.sections[0].tier = "changed";
  assert.strictEqual(JSON.stringify(a.wiring), before, "ships are isolated from player and sibling wiring mutations");

  const canonical = createGeneratedPowerWiring(design);
  const reversed = JSON.parse(JSON.stringify(canonical));
  reversed.power.sections = reversed.power.sections.flatMap((section) => [{ ...section, x1: section.x2, y1: section.y2, x2: section.x1, y2: section.y1 }, section]);
  const replay = executePurchase(room, player, { ...request, wiring: reversed }, 2);
  assert.strictEqual(replay.duplicate, true, "equivalent canonical wiring has the same idempotency signature");
  const conflict = executePurchase(room, player, { ...request, wiring: { version: 2, power: { sections: [], connections: [] }, data: { sections: [], connections: [] } } }, 3);
  assert.strictEqual(conflict.code, "duplicate-request-conflict", "different normalized wiring conflicts");
}

{
  const { room, player, design } = setup();
  player.wiring = undefined;
  const direct = spawnShip(room, player, 0, 0, { design });
  assert.deepStrictEqual(direct.wiring, { version: 2, power: { sections: [], connections: [] }, data: { sections: [], connections: [] } }, "missing wiring gets safe Wiring v2 fallback");
  const invalid = spawnShip(room, player, 0, 1, { design, wiring: { version: 2, power: { sections: [{ x1: 0, y1: 0, x2: 1, y2: 0, tier: "hacked" }], connections: [{ sourceIndex: 999, targetIndex: -1, sectionIds: ["bad"] }] }, data: { networkIds: ["client"] } } });
  assert.deepStrictEqual(invalid.wiring, validateWiring(design, invalid.wiring).wiring, "raw invalid client-derived fields are not stored");
}

{
  const { room, player, design, wiring } = setup();
  const originalPush = room.effects.push; let pushes = 0;
  room.effects.push = function failSecondEffect(...items) { if (++pushes === 2) throw new Error("injected spawn failure"); return originalPush.apply(this, items); };
  const before = { money: player.money, spent: player.spent, fleet: player.deployedFleetCost, built: player.shipsBuilt || 0, id: room.nextEntityId, effects: room.effects.length };
  const result = executePurchase(room, player, { requestId: "rollback", count: 2, stats: player.stats, design, wiring, combatStyle: "sentry" }, 0);
  assert.strictEqual(result.code, "spawn-failed"); assert.strictEqual(player.ships.length, 0); assert.strictEqual(room.ships.size, 0);
  assert.deepStrictEqual({ money: player.money, spent: player.spent, fleet: player.deployedFleetCost, built: player.shipsBuilt || 0, id: room.nextEntityId, effects: room.effects.length }, before, "failed multi-spawn rolls back all authoritative state");
}

{
  const { room, player, wiring } = setup();
  const starter = buyShip(room, player, 0, { starter: true });
  assert.deepStrictEqual(starter.wiring, wiring, "starter snapshots the player's wiring");
  player.wiring.power.sections.length = 0; assert.notStrictEqual(starter.wiring.power.sections.length, 0);
  addBot(room, player); const bot = [...room.players.values()].find((candidate) => candidate.isBot);
  assert.strictEqual(bot.wiring.version, 2); bot.ready = true; bot.client = {}; const botShip = buyShip(room, bot, 0, { silent: true });
  assert.strictEqual(botShip.wiring.version, 2); assert(botShip.wiring.power.sections.length > 0, "bot ship receives deterministic physical Power wiring");
}

console.log("Wiring purchase/spawn pipeline checks passed");
