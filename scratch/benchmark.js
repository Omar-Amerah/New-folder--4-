const { performanceNow } = require("../src/server/utils");
const { rooms, createRoom } = require("../src/server/rooms");

// Mock player and ship structures
const room = createRoom("TEST");
room.players = new Map();

for (let i = 0; i < 20; i++) {
  const player = {
    id: `p${i}`,
    ships: []
  };
  for (let j = 0; j < 100; j++) {
    player.ships.push({
      id: `s${i}_${j}`,
      alive: true,
      removed: false
    });
  }
  room.players.set(player.id, player);
}

function findShipByIdOld(room, id) {
  if (!id) return null;
  for (const player of room.players.values()) {
    const ship = player.ships.find((candidate) => candidate.id === id && candidate.alive && !candidate.removed);
    if (ship) return ship;
  }
  return null;
}

// 1. Measure Baseline
const targetId = 's19_99'; // Worst case: last player, last ship
const iterations = 100000;

const start = performanceNow();
for (let i = 0; i < iterations; i++) {
  findShipByIdOld(room, targetId);
}
const end = performanceNow();

console.log(`Baseline (Old O(P*S)): ${end - start} ms`);

// Mock room.ships map
room.ships = new Map();
for (const player of room.players.values()) {
  for (const ship of player.ships) {
    room.ships.set(ship.id, ship);
  }
}

function findShipByIdNew(room, id) {
  if (!id) return null;
  const ship = room.ships.get(id);
  if (ship && ship.alive && !ship.removed) return ship;
  return null;
}

const start2 = performanceNow();
for (let i = 0; i < iterations; i++) {
  findShipByIdNew(room, targetId);
}
const end2 = performanceNow();

console.log(`Optimized (New O(1)): ${end2 - start2} ms`);
