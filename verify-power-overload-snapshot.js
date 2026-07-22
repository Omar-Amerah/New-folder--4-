#!/usr/bin/env node
"use strict";

// Section 7G — runtime Power-protection snapshot verifier.
// Covers the compact protection block, its dedicated revision, per-client
// delta preservation, immediate trip/retry delivery, reset-on-replacement
// and numeric hygiene (no NaN/Infinity/negative zero).

const assert = require("assert");
const { snapshotRoom } = require("./src/server/snapshots");
const { createShipBlueprintSnapshot } = require("./src/server/shipDesign");
const { initializeComponentPower, reallocateShipPower, powerProtectionConfig } = require("./src/server/componentPower");
const { updateShipPowerProtection } = require("./src/server/powerProtection");

function finite(value) {
  if (typeof value === "number") assert(Number.isFinite(value) && !Object.is(value, -0), `non-finite or -0: ${value}`);
  else if (Array.isArray(value)) value.forEach(finite);
  else if (value && typeof value === "object") Object.values(value).forEach(finite);
}

function makeShip() {
  const design = [
    { x: 0, y: 0, type: "reactor" },
    { x: 3, y: 0, type: "shield" },
    { x: 1, y: 0, type: "switchgear", rotation: 0, switchgearMode: "closed", switchgearRatingTier: "light" }
  ];
  const wiring = {
    version: 3,
    power: { sections: [{ id: "a1", x1: 0, y1: 0, x2: 1, y2: 0, tier: "standard" }, { id: "b1", x1: 2, y1: 0, x2: 3, y2: 0, tier: "standard" }], connections: [] },
    data: { sections: [], connections: [] },
    powerPolicy: { preset: "custom", customOrder: ["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"] }
  };
  const snap = createShipBlueprintSnapshot(design, wiring);
  const ship = {
    id: "s", ownerId: "p", designRevision: 1, x: 0, y: 0, vx: 0, vy: 0, angle: 0, targetX: 0, targetY: 0,
    hp: 100, maxHp: 100, shield: 0, maxShield: 0, radius: 10, cost: 1, weaponAngles: [], alive: true,
    stats: { unitCost: 1 }, design: snap.design, wiring: snap.wiring,
    componentHp: snap.design.map(() => 1), componentMaxHp: snap.design.map(() => 1),
    componentHeat: snap.design.map(() => 0), componentHeatState: snap.design.map(() => 0),
    componentThermals: snap.design.map(() => ({ capacity: 100 })),
    dirtyComponents: new Set(), dirtyHeat: new Set(),
    _activityDemandByIndex: { 1: 6 }
  };
  initializeComponentPower(ship);
  return ship;
}

(async () => {
  const { mergeCachedShipFields } = await import("./public/src/snapshotMerge.js");
  const ship = makeShip();
  const player = { id: "p", name: "P", color: "#fff", team: "blue", ships: [ship], selectedShipIds: new Set(), stats: {}, money: 0, rallyPoint: { x: 0, y: 0 } };
  const room = { code: "R", phase: "active", adminId: "p", stateEpoch: 1, snapshotSeq: 1, staticRevision: 1, mapSizeLabel: "tiny", world: { width: 100, height: 100 }, map: { asteroids: [] }, rules: { gameMode: "control" }, players: new Map([["p", player]]), ships: new Map([["s", ship]]), bullets: [], points: [], effects: [], winner: null, matchStartedAt: 1, maxScore: 100, controlVictory: null };
  const client = { player, knownShipPowerRevisions: new Map(), knownShipPowerProtectionRevisions: new Map() };

  // 39. Full snapshots carry the compact protection block.
  updateShipPowerProtection(ship, 0.5);
  const full = snapshotRoom(room, 0, player, true, null, client);
  const fullShip = full.ships[0];
  assert(fullShip.powerProtection, "full snapshot includes powerProtection");
  assert.strictEqual(fullShip.powerProtection.state, "strained", "6 MW through a light internal edge is strained");
  assert(fullShip.powerProtection.aboveSustainedSectionCount >= 1);
  assert(fullShip.powerProtection.sections.length >= 1, "compact stressed-section records present");
  const internal = fullShip.powerProtection.sections.find((s) => s.kind === "switchgear");
  assert(internal && internal.stress > 0 && internal.tier === "light");
  assert(Number.isInteger(fullShip.powerProtectionRevision) && fullShip.powerProtectionRevision >= 1);
  finite(fullShip.powerProtection);
  finite(fullShip.switchgear);
  assert(Object.prototype.hasOwnProperty.call(fullShip.switchgear[0], "cooldownRemaining"), "switchgear snapshot carries expanded trip/retry fields");

  // Mark the client as having written this state.
  client.knownShipDesignRevisions = new Map([["s", 1]]);
  client.knownShipPowerRevisions.set("s", ship.powerRevision);
  client.knownShipPowerProtectionRevisions.set("s", ship.powerProtectionRevision);

  // Stress-only change: protection block is resent without resending
  // componentPower (no Power revision change).
  const powerRevBefore = ship.powerRevision;
  updateShipPowerProtection(ship, 0.5);
  assert.strictEqual(ship.powerRevision, powerRevBefore, "stress accumulation does not bump the Power revision");
  assert.notStrictEqual(ship.powerProtectionRevision, client.knownShipPowerProtectionRevisions.get("s"));
  const stressOnly = snapshotRoom(room, 16, player, false, null, client).ships[0];
  assert(!stressOnly.componentPower, "stress-only compact update does not resend componentPower");
  assert(stressOnly.powerProtection, "stress change is delivered to the player");
  assert(stressOnly.powerProtection.mostStressedStress > fullShip.powerProtection.mostStressedStress);

  // Client merge keeps the newest protection block and preserves it when a
  // later compact update omits it.
  const merged = mergeCachedShipFields([fullShip], [stressOnly])[0];
  assert.strictEqual(merged.powerProtection.mostStressedStress, stressOnly.powerProtection.mostStressedStress);
  client.knownShipPowerProtectionRevisions.set("s", ship.powerProtectionRevision);
  const unchanged = snapshotRoom(room, 32, player, false, null, client).ships[0];
  assert.strictEqual(unchanged.powerProtection, undefined, "unchanged protection state resends nothing");
  const retained = mergeCachedShipFields([merged], [unchanged])[0];
  assert.strictEqual(retained.powerProtection.mostStressedStress, stressOnly.powerProtection.mostStressedStress, "omitted protection block preserves the previous one");

  // 40. Trip changes are sent immediately even when unrelated allocations are
  // untouched between the two snapshots.
  while (ship.runtimeSwitchgear[0].state !== "tripped") updateShipPowerProtection(ship, 0.05);
  const afterTrip = snapshotRoom(room, 48, player, false, null, client).ships[0];
  assert(afterTrip.powerProtection, "trip state change is delivered immediately");
  assert.strictEqual(afterTrip.powerProtection.trippedSwitchgearCount, 1);
  assert.strictEqual(afterTrip.powerProtection.state, "protection-trip");
  assert(afterTrip.powerProtection.nextRetrySeconds > 0);
  assert(afterTrip.switchgear, "switchgear runtime block refreshed with the trip");
  const trippedRecord = afterTrip.switchgear.find((r) => r.state === "tripped");
  assert(trippedRecord && /overload trip/.test(trippedRecord.trippedReason));
  assert(trippedRecord.cooldownRemaining > 0 && trippedRecord.lastTripFlowMw === 6);
  finite(afterTrip.powerProtection);
  finite(afterTrip.switchgear);
  client.knownShipPowerProtectionRevisions.set("s", ship.powerProtectionRevision);
  client.knownShipPowerRevisions.set("s", ship.powerRevision);

  // Failed retry fields flow through the compact snapshot too.
  const config = powerProtectionConfig();
  for (let t = 0; t < config.tripCooldownSeconds + config.retryIntervalSeconds + 0.5; t += 0.05) updateShipPowerProtection(ship, 0.05);
  const afterRetry = snapshotRoom(room, 64, player, false, null, client).ships[0];
  assert(afterRetry.powerProtection, "retry bookkeeping change is delivered");
  const retriedRecord = afterRetry.switchgear.find((r) => r.state === "tripped");
  assert(retriedRecord.retryCount >= 1, "retry count visible");
  assert.strictEqual(retriedRecord.lastRetryReason, "projected flow above safe reclose threshold");

  // 36-analogue at the snapshot level: replacement clears stale diagnostics.
  ship._activityDemandByIndex = { 1: 1 };
  initializeComponentPower(ship);
  updateShipPowerProtection(ship, 0.05);
  const replaced = snapshotRoom(room, 96, player, true, null, client).ships[0];
  assert.strictEqual(replaced.powerProtection.state, "normal");
  assert.strictEqual(replaced.powerProtection.trippedSwitchgearCount, 0);
  assert.strictEqual(replaced.powerProtection.sections.length, 0, "no stale stressed sections after design replacement");
  assert.strictEqual(replaced.powerProtection.mostStressedSectionId, null);
  assert.strictEqual(replaced.powerProtection.nextRetrySeconds, 0, "missing optional values normalise to zero");
  finite(replaced.powerProtection);

  console.log("Section 7G runtime Power-protection snapshot verification passed.");
})().catch((error) => { console.error(error); process.exit(1); });
