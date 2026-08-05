"use strict";

// The snapshot timeline must be honest: consecutive snapshots have to advance
// simulationTimeMs by exactly as much simulated time as the ships inside them
// actually moved.
//
// The client interpolates purely by that stamp (public/src/game/renderInterpolation.js
// sampleVisual lerps on simulationTimeMs), so any mismatch is rendered directly
// as a change of speed. Simulation and snapshot broadcast run on independent
// timers -- 30 Hz and 20 Hz -- so a snapshot carries state that is anywhere from
// zero to a full tick old. Stamping it with the broadcast time claims every
// snapshot covers a uniform 50 ms when the content alternately covers 33 ms and
// 67 ms: a ship holding a true 510 px/s was rendered swinging between 340 and
// 680 px/s, twice a second.

const assert = require("assert");
const { tickRoom } = require("./src/server/simulation");
const { TICK_HZ, SNAPSHOT_HZ } = require("./src/server/config");
const { snapshotRoom } = require("./src/server/snapshots");
const { computeStats } = require("./src/server/shipStats");
const { commandShips } = require("./src/server/movement");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");

const DESIGN = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];

function makeScenario() {
  const stats = computeStats(DESIGN);
  const ship = {
    id: "s1", ownerId: "p1", alive: true, x: 600, y: 1500, vx: 0, vy: 0, angle: 0,
    targetX: 600, targetY: 1500, radius: stats.radius, physicalRadius: 42,
    design: DESIGN.map((part) => ({ ...part })),
    wiring: createGeneratedPowerWiring(DESIGN), stats, combatStyle: "hold"
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  const player = {
    id: "p1", name: "P", team: "A", ships: [ship], money: 0, ready: true,
    connected: true, design: DESIGN, wiring: ship.wiring, stats
  };
  const room = {
    id: "r1", phase: "active", world: { width: 8000, height: 3000 },
    map: { asteroids: [], relays: [] },
    ships: new Map([["s1", ship]]), players: new Map([["p1", player]]),
    clients: new Set(), stations: [], effects: [], bullets: [], points: [], drones: [],
    stateEpoch: 1, snapshotSeq: 0, staticRevision: 1, rules: {}
  };
  return { room, player, ship, client: { player, room, protocol: { capabilities: [] } } };
}

function run() {
  const { room, player, ship, client } = makeScenario();
  commandShips(room, player, 7000, 1500, { shipIds: ["s1"] });

  const tickMs = 1000 / TICK_HZ;
  const snapshotMs = 1000 / SNAPSHOT_HZ;
  const dt = 1 / TICK_HZ;

  // Two independent timers, exactly as server.js drives them: the snapshot timer
  // fires on its own interval and ships whatever the last completed tick left.
  const rows = [];
  let nextSnapshotAt = snapshotMs;
  for (let i = 0; i * tickMs < 12000; i += 1) {
    const now = i * tickMs;
    tickRoom(room, dt, now);
    while (nextSnapshotAt <= now + tickMs) {
      room.snapshotSeq += 1;
      room._buildingSnapshotSeq = room.snapshotSeq;
      const snapshot = snapshotRoom(room, nextSnapshotAt, player, true, null, client);
      const entry = (snapshot.ships || []).find((candidate) => candidate.id === "s1");
      if (entry) {
        rows.push({
          stamp: snapshot.simulationTimeMs,
          x: entry.x,
          speed: Math.hypot(ship.vx, ship.vy)
        });
      }
      nextSnapshotAt += snapshotMs;
    }
  }

  assert(rows.length > 40, `expected a useful run of snapshots (got ${rows.length})`);

  // The stamp must be monotonic and must never stand still.
  for (let i = 1; i < rows.length; i += 1) {
    assert(rows[i].stamp > rows[i - 1].stamp,
      `simulationTimeMs must advance every snapshot (${rows[i - 1].stamp} -> ${rows[i].stamp})`);
  }

  // Steady cruise: the ship is at terminal speed, so the speed implied by each
  // pair of snapshots must match the speed the server actually has.
  const topSpeed = Math.max(...rows.map((row) => row.speed));
  const cruise = [];
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].speed < topSpeed * 0.999 || rows[i - 1].speed < topSpeed * 0.999) continue;
    const span = rows[i].stamp - rows[i - 1].stamp;
    cruise.push((rows[i].x - rows[i - 1].x) / (span / 1000));
  }
  assert(cruise.length > 10, `expected a steady-cruise window (got ${cruise.length} pairs)`);

  const min = Math.min(...cruise);
  const max = Math.max(...cruise);
  const swing = (max - min) / topSpeed;
  // Stamps are whole milliseconds, so a 33 ms interval carries up to ~1.5% of
  // rounding. Anything beyond a few percent means the stamp has stopped
  // describing the state it is attached to.
  assert(swing < 0.05,
    `snapshot stamps must track the motion they carry (implied speed ${min.toFixed(1)}-${max.toFixed(1)} px/s on a true ${topSpeed.toFixed(1)}, swing ${(swing * 100).toFixed(1)}%)`);
  for (const implied of cruise) {
    assert(Math.abs(implied - topSpeed) / topSpeed < 0.05,
      `implied speed ${implied.toFixed(1)} px/s should match the true ${topSpeed.toFixed(1)} px/s`);
  }

  console.log(`verify-snapshot-timeline: OK (${cruise.length} cruise pairs, swing ${(swing * 100).toFixed(2)}%)`);
}

run();
