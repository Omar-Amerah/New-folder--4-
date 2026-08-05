"use strict";
// Group 3: per-weapon fallback targeting. A weapon should keep the assigned
// (primary) target when it can reach it, but fire at another in-range enemy
// instead of idling when the primary is out of reach. The assigned target is
// never changed by this helper (retention/switch-back is handled at ship level).
const assert = require("assert");
const { pickWeaponFireTarget } = require("./src/server/combat");

// Minimal room: two teams, no asteroids (so line-of-sight is always clear).
const room = {
  rules: { gameMode: "teams" },
  map: { asteroids: [] },
  players: new Map([
    ["me", { id: "me", team: "A" }],
    ["foe", { id: "foe", team: "B" }]
  ])
};
const ship = { ownerId: "me" };

const primary = { id: "primary", ownerId: "foe", alive: true, x: 1000, y: 0 }; // far away
const closeEnemy = { id: "close", ownerId: "foe", alive: true, x: 200, y: 0 }; // in range
const ally = { id: "ally", ownerId: "me", alive: true, x: 150, y: 0 };
const ships = [primary, closeEnemy, ally];

const range = 400;

// 1. Primary out of range -> fall back to the in-range enemy (weapon does not idle).
const fallback = pickWeaponFireTarget(room, ship, ships, 0, 0, primary, range);
assert.strictEqual(fallback && fallback.id, "close", "weapon should fall back to in-range enemy when primary is out of range");

// 2. Primary in range -> keep the assigned primary even if another enemy is closer.
const nearPrimary = { id: "primary", ownerId: "foe", alive: true, x: 300, y: 0 };
const kept = pickWeaponFireTarget(room, ship, [nearPrimary, closeEnemy, ally], 0, 0, nearPrimary, range);
assert.strictEqual(kept.id, "primary", "weapon should keep the assigned target when it is reachable");

// 3. Never targets an ally.
assert.notStrictEqual(fallback.ownerId, "me", "weapon must not target a friendly ship");

// 4. No valid enemy in range -> returns null (weapon holds fire rather than mis-firing).
const noneInRange = pickWeaponFireTarget(room, ship, [primary, ally], 0, 0, primary, 100);
assert.strictEqual(noneInRange, null, "weapon should hold fire when nothing is in range");

console.log("Targeting verification passed");
