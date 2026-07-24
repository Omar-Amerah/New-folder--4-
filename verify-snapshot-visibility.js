// Regression coverage for viewer-specific enemy ship snapshot redaction.
//
// Owner and allied viewers may receive full internal ship detail. Enemy viewers
// receive only a safe public visual representation (the design needed to render
// the hull and weapons) plus externally observable dynamics — never per-component
// HP/Heat, Power allocation, power status/thermal, wiring, switchgear or
// protection. Redaction holds for full AND compact snapshots, survives reconnect
// / forced resync, and the client merge can never restore private fields cached
// from an earlier full-detail snapshot.

const assert = require("assert");
const { snapshotRoom } = require("./src/server/snapshots");

const PRIVATE_FIELDS = [
  "componentPower", "powerStatus", "powerThermal", "powerRevision", "wiringRevision",
  "wiringStatus", "switchgear", "powerProtection", "powerProtectionRevision",
  "powerWiring", "powerWiringRevision", "powerWiringRuntime",
  "chp", "chpD", "componentHeat", "componentHeatD"
];

function assertNoPrivateFields(entry, label) {
  for (const key of PRIVATE_FIELDS) {
    assert.ok(entry[key] === undefined, `${label}: private field '${key}' must be absent (got ${JSON.stringify(entry[key])})`);
  }
}

function makePlayer(id, team) {
  return {
    id, name: id, color: "#39f", team, isBot: false, connected: true, ready: true,
    money: 0, income: 0, earned: 0, spent: 0, shipCap: 5, deployedFleetCost: 0,
    destroyedEnemyCost: 0, lastReward: 0, score: 0, kills: 0, losses: 0, captures: 0,
    ships: [], design: [{ type: "core" }], stats: { unitCost: 1 }, shipsBuilt: 0,
    lostFleetCost: 0, rallyPoint: { x: 0, y: 0 }
  };
}

function makeShip(id, ownerId) {
  return {
    id, ownerId, designRevision: 1, x: 1, y: 2, vx: 0, vy: 0, angle: 0,
    targetX: 0, targetY: 0, hp: 100, maxHp: 100, shield: 3, maxShield: 5, radius: 10,
    cost: 1, weaponAngles: [0], alive: true, removed: false, stats: { unitCost: 1 },
    design: [{ type: "core", x: 7, y: 7, rotation: 0 }, { type: "engine", x: 7, y: 8, rotation: 0 }],
    componentHp: [10, 20], componentMaxHp: [10, 20], componentHeat: [1, 2], componentHeatState: [0, 0],
    componentThermals: [{ capacity: 10 }, { capacity: 20 }],
    componentPower: { byComponentIndex: [{ state: "ok", networkId: 1, operationalMultiplier: 1 }, { state: "ok", networkId: 1, operationalMultiplier: 1 }] },
    powerStatus: {}, powerRevision: 1, wiringRevision: 1, powerProtectionRevision: 1,
    dirtyComponents: new Set(), dirtyHeat: new Set()
  };
}

function makeRoom(mode) {
  const pa = makePlayer("pa", mode === "solo" ? "pa" : "blue");
  const pAlly = makePlayer("pAlly", mode === "solo" ? "pAlly" : "blue");
  const pe = makePlayer("pe", mode === "solo" ? "pe" : "red");
  const shipA = makeShip("shipA", "pa");
  pa.ships.push(shipA);
  return {
    code: "R", phase: "active", adminId: "pa", stateEpoch: 1, snapshotSeq: 0,
    staticRevision: 1, componentCatalogueRevision: 1, mapSizeLabel: "tiny",
    world: { width: 100, height: 100 }, map: { seed: 1, asteroids: [] },
    rules: { gameMode: mode }, winner: null, matchStartedAt: 1, maxScore: 100,
    bullets: [], effects: [], points: [], controlVictory: null, teamScores: {},
    players: new Map([["pa", pa], ["pAlly", pAlly], ["pe", pe]]),
    ships: new Map([["shipA", shipA]]), clients: new Set()
  };
}

function shipEntry(snapshot, id) {
  return snapshot.ships.find((s) => s.id === id);
}

// 1. Owner receives full internal detail.
(function ownerFullDetail() {
  const room = makeRoom("teams");
  const owner = room.players.get("pa");
  const snap = snapshotRoom(room, 0, owner, true, null, { player: owner });
  const entry = shipEntry(snap, "shipA");
  assert.ok(entry.design && entry.chp && entry.componentHeat && entry.componentPower, "owner sees full internal detail");
  assert.strictEqual(entry.detail, "full", "owner ship marked full detail");
  console.log("PASS: owner receives full internal detail");
})();

// 2. Ally receives full/allied detail.
(function allyFullDetail() {
  const room = makeRoom("teams");
  const ally = room.players.get("pAlly");
  const snap = snapshotRoom(room, 0, ally, true, null, { player: ally });
  const entry = shipEntry(snap, "shipA");
  assert.ok(entry.design && entry.chp && entry.componentHeat, "ally on the same team sees internal detail");
  console.log("PASS: ally receives the intended full/allied detail");
})();

// 3. Enemy receives no private fields (full snapshot redacted), but keeps a
//    public visual design.
(function enemyFullRedacted() {
  const room = makeRoom("teams");
  const enemy = room.players.get("pe");
  const snap = snapshotRoom(room, 0, enemy, true, null, { player: enemy });
  const entry = shipEntry(snap, "shipA");
  assert.strictEqual(entry.detail, "public", "enemy ship marked public detail");
  assert.ok(entry.design, "enemy keeps a public visual design for rendering");
  assert.ok(entry.hp !== undefined && entry.shield !== undefined && entry.radius !== undefined, "enemy keeps observable combat fields");
  assertNoPrivateFields(entry, "enemy full snapshot");
  console.log("PASS: enemy receives no private component/Heat/Power/wiring fields in a full snapshot");
})();

// 4. Compact snapshots remain redacted for enemies (dirty component/heat state
//    must not leak via deltas).
(function enemyCompactRedacted() {
  const room = makeRoom("teams");
  const enemy = room.players.get("pe");
  const client = { player: enemy, knownShipDesignRevisions: new Map(), knownShipPowerRevisions: new Map() };
  // Prime the client with a full snapshot first.
  snapshotRoom(room, 0, enemy, true, null, client);
  client.knownShipDesignRevisions.set("shipA", 1);
  // Mutate internal component state and mark dirty, then request a compact.
  const ship = room.ships.get("shipA");
  ship.componentHp[0] = 5; ship.dirtyComponents.add(0);
  ship.componentHeat[1] = 9; ship.dirtyHeat.add(1);
  const compact = snapshotRoom(room, 16, enemy, false, null, client);
  const entry = shipEntry(compact, "shipA");
  assert.strictEqual(entry.detail, "public", "enemy compact ship marked public");
  assertNoPrivateFields(entry, "enemy compact snapshot");
  console.log("PASS: enemy compact snapshots omit all private fields including dirty deltas");
})();

// 5. Reconnect / forced full resync stays redacted.
(function enemyResyncRedacted() {
  const room = makeRoom("teams");
  const enemy = room.players.get("pe");
  const client = { player: enemy, knownShipDesignRevisions: new Map(), knownShipPowerRevisions: new Map() };
  const full = snapshotRoom(room, 0, enemy, true, null, client); // forced full resync
  assertNoPrivateFields(shipEntry(full, "shipA"), "enemy forced resync");
  console.log("PASS: reconnect and forced resync remain redacted");
})();

// 6. The client merge cannot restore private fields from an earlier cached
//    full-detail snapshot when the ship later arrives as public.
(async function mergeCannotRestorePrivate() {
  const merge = await import("./public/src/snapshotMerge.js");
  // Previous (cached) snapshot: ship had full private detail.
  const previous = {
    ships: [{
      id: "shipA", detail: "full",
      design: [{ type: "core" }], chp: [10, 20], componentHeat: [[1, 0, 0, 10], [2, 0, 0, 20]],
      componentPower: [["ok", 1, 1]], powerStatus: {}, switchgear: [], powerProtection: {}
    }]
  };
  // Next compact snapshot: same ship now redacted (enemy), private fields omitted.
  const next = { ships: [{ id: "shipA", detail: "public", design: [{ type: "core" }] }] };
  const merged = merge.mergeCachedShipFields(previous.ships, next.ships);
  const entry = merged.find((s) => s.id === "shipA");
  assertNoPrivateFields(entry, "client merge of public over cached full");
  assert.ok(entry.design, "public visual design still present after merge");
  console.log("PASS: client merge cannot restore private fields from an earlier cached snapshot");
})();

// 7. Solo mode: every non-owner is an enemy => redacted.
(function soloEnemyRedacted() {
  const room = makeRoom("solo");
  const other = room.players.get("pe");
  const snap = snapshotRoom(room, 0, other, true, null, { player: other });
  const entry = shipEntry(snap, "shipA");
  assert.strictEqual(entry.detail, "public", "solo non-owner sees redacted ship");
  assertNoPrivateFields(entry, "solo enemy");
  console.log("PASS: solo mode redacts every non-owner ship");
})();

console.log("\nSNAPSHOT VISIBILITY REGRESSION TESTS PASSED");
