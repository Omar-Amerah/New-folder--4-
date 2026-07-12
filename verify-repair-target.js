"use strict";
// Group 4: clicking a ship classifies the command — an enemy becomes an attack
// focus target, an ally becomes a repair target (so repair ships can be steered
// to a chosen friendly). Any other command clears the repair target.
const assert = require("assert");
const { commandShips } = require("./src/server/movement");

function makeRoom() {
  const me = { id: "s1", ownerId: "me", alive: true, radius: 30, x: 500, y: 500, ships: undefined, design: [{ type: "repairBeam" }] };
  const ally = { id: "a1", ownerId: "friend", alive: true, radius: 30, x: 900, y: 500 };
  const enemy = { id: "e1", ownerId: "foe", alive: true, radius: 30, x: 1200, y: 500 };
  const player = { id: "me", ships: [me] };
  const room = {
    ships: new Map([["s1", me], ["a1", ally], ["e1", enemy]]),
    map: { asteroids: [] },
    world: { width: 4000, height: 4000 },
    rules: { gameMode: "teams" },
    players: new Map([
      ["me", { id: "me", team: "A" }],
      ["friend", { id: "friend", team: "A" }],
      ["foe", { id: "foe", team: "B" }]
    ])
  };
  return { room, player, me };
}

// 1. Clicking an ally sets a repair target, not an attack focus.
{
  const { room, player, me } = makeRoom();
  commandShips(room, player, 900, 500, { targetId: "a1", shipIds: ["s1"] });
  assert.strictEqual(me.repairTargetId, "a1", "clicking an ally should set the repair target");
  assert(!me.focusTargetId, "clicking an ally should not set an attack focus");
}

// 2. Clicking an enemy sets an attack focus and no repair target.
{
  const { room, player, me } = makeRoom();
  commandShips(room, player, 1200, 500, { targetId: "e1", shipIds: ["s1"] });
  assert.strictEqual(me.focusTargetId, "e1", "clicking an enemy should set the attack focus");
  assert(!me.repairTargetId, "clicking an enemy should not set a repair target");
}

// 3. A plain move (no target) clears a previously assigned repair target.
{
  const { room, player, me } = makeRoom();
  commandShips(room, player, 900, 500, { targetId: "a1", shipIds: ["s1"] });
  commandShips(room, player, 300, 300, { shipIds: ["s1"] });
  assert(!me.repairTargetId, "a plain move should clear the repair target");
}

// 4. Patching accuracy: component-only damage counts as a valid repair need,
// even when aggregate hull HP is already full.
{
  const { shipRepairNeed } = require("./src/server/combat");
  const componentDamaged = {
    id: "a2",
    alive: true,
    hp: 100,
    maxHp: 100,
    componentHp: [100, 35],
    componentMaxHp: [100, 100]
  };
  assert(shipRepairNeed(componentDamaged) > 0, "component-only damage should request repairs");
}

console.log("Repair-target verification passed");
