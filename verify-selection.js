"use strict";

const assert = require("assert");
const { createRoom } = require("./src/server/rooms");
const { computeStats } = require("./src/server/shipStats");
const { DEFAULT_DESIGN } = require("./src/server/config");
const { spawnShip } = require("./src/server/ships");
const { commandShips } = require("./src/server/movement");
const { requestSelfDestruct } = require("./src/server/combat");
const { selectOwnedLivingShips } = require("./src/server/selection");

function player(id, team) {
  const design = DEFAULT_DESIGN.map((part) => ({ ...part }));
  return { id, name: id, team, ready: true, design, stats: computeStats(design), ships: [], shipCap: 10, money: 1000, spent: 0, deployedFleetCost: 0 };
}
function setup() {
  const room = createRoom("SEL");
  room.phase = "active";
  room.players.clear(); room.ships.clear(); room.effects.length = 0; room.nextEntityId = 1;
  const p1 = player("p1", "blue"); const p2 = player("p2", "red");
  room.players.set(p1.id, p1); room.players.set(p2.id, p2);
  const a = spawnShip(room, p1, 0, 0); const b = spawnShip(room, p1, 0, 1); const e = spawnShip(room, p2, 0, 0);
  return { room, p1, p2, a, b, e };
}

{
  const { p1 } = setup();
  assert.strictEqual(selectOwnedLivingShips(p1, []).ships.length, 0, "explicit empty selects no ships");
  assert.strictEqual(selectOwnedLivingShips(p1, "bad").ok, false, "malformed selection rejected");
  assert.strictEqual(selectOwnedLivingShips(p1, [p1.ships[0].id, p1.ships[0].id]).ships.length, 1, "duplicates collapse");
}
{
  const { room, p1, a } = setup();
  assert.strictEqual(commandShips(room, p1, 700, 700, { shipIds: [] }).commanded, 0, "empty command affects no ships");
  assert.strictEqual(commandShips(room, p1, 700, 700, { shipIds: [a.id, "enemy", a.id] }).commanded, 1, "mixed command affects only owned living ships once");
}
{
  const { room, p1, a, e } = setup();
  assert.strictEqual(requestSelfDestruct(room, p1, [], 10), 0, "empty destruct arms no ships");
  assert.strictEqual(requestSelfDestruct(room, p1, undefined, 15), 0, "omitted destruct selection never arms the fleet");
  assert.strictEqual(requestSelfDestruct(room, p1, { bad: true }, 20), 0, "malformed destruct never arms whole fleet");
  assert.strictEqual(requestSelfDestruct(room, p1, [a.id, e.id, a.id], 30), 1, "mixed valid/enemy destruct affects only owned ship");
  assert.strictEqual(requestSelfDestruct(room, p1, [a.id], 40), 0, "repeated self-destruct is idempotent");
}
console.log("Selection normalization safety checks passed");
