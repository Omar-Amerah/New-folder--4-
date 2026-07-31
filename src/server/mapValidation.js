// Validates generated map data so rooms, snapshots and tests share one schema guard.

const { resolveMapClearances } = require("./config");

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function validateGeneratedMap(map, world, options = {}) {
  const errors = [];
  const seedLabel = options.seed ?? map?.seed ?? "unknown";
  if (!map || typeof map !== "object") errors.push("map must be an object");
  if (!world || !isFiniteNumber(world.width) || !isFiniteNumber(world.height) || world.width <= 0 || world.height <= 0) {
    errors.push("world must have positive finite width and height");
  }
  if (errors.length) return { ok: false, seed: seedLabel, errors };

  if (!Number.isInteger(map.seed) || map.seed < 0) errors.push("map.seed must be a non-negative integer");
  if (typeof map.name !== "string" || !map.name.trim()) errors.push("map.name must be a non-empty string");
  for (const key of ["relays", "asteroids", "clouds", "safeZones"]) {
    if (!Array.isArray(map[key])) errors.push(`map.${key} must be an array`);
  }

  // Buffers come from the same table the generator places against, so the guard
  // actually guards. relay<->relay used to be 0 here while generation enforced
  // 800, meaning a regression collapsing relay spacing was invisible.
  const clearances = resolveMapClearances(world);
  const ids = { relays: new Set(), asteroids: new Set(), clouds: new Set() };
  // Hand-authored fixtures place bare obstruction circles on purpose, so the
  // generator-only invariants (render art, terrain spacing) are opt-out. Schema,
  // bounds and id checks always run.
  const generated = options.syntheticTerrain !== true;
  if (!Array.isArray(map.relays) || map.relays.length === 0) errors.push("map.relays must contain at least one relay");
  validateCircles(map.relays || [], "relay", ids.relays, 0);
  validateCircles(map.asteroids || [], "asteroid", ids.asteroids, generated ? clearances.edgeInset : 0);
  if (generated) validateAsteroidArt(map.asteroids || []);
  validateClouds(map.clouds || [], ids.clouds);
  validateSafeZones(map.safeZones || []);
  if (generated && world.label !== "Testing") validateClearance(map.relays || [], "relay", map.safeZones || [], "safe zone", clearances.relayToSafeZone);
  validateClearance(map.relays || [], "relay", map.relays || [], "relay", clearances.relayToRelay, true);
  if (generated) {
    validateClearance(map.asteroids || [], "asteroid", map.safeZones || [], "safe zone", clearances.asteroidToSafeZone);
    validateClearance(map.asteroids || [], "asteroid", map.relays || [], "relay", clearances.asteroidToRelayMin);
    validateClearance(map.asteroids || [], "asteroid", map.asteroids || [], "asteroid", clearances.asteroidToAsteroid, true);
  }

  function validateCircles(items, label, seen, edgeInset) {
    for (const item of items) {
      if (!item || typeof item !== "object") { errors.push(`${label} must be an object`); continue; }
      if (typeof item.id !== "string" || !item.id) errors.push(`${label} id must be non-empty`);
      else if (seen.has(item.id)) errors.push(`${label} id ${item.id} is duplicated`);
      else seen.add(item.id);
      if (!isFiniteNumber(item.x) || !isFiniteNumber(item.y) || !isFiniteNumber(item.radius)) errors.push(`${label} ${item.id || "?"} coordinates/radius must be finite`);
      if (!(item.radius > 0)) errors.push(`${label} ${item.id || "?"} radius must be positive`);
      if (isFiniteNumber(item.x) && isFiniteNumber(item.y) && isFiniteNumber(item.radius)) {
        if (item.x - item.radius < edgeInset || item.x + item.radius > world.width - edgeInset || item.y - item.radius < edgeInset || item.y + item.radius > world.height - edgeInset) {
          errors.push(`${label} ${item.id || "?"} is outside world bounds`);
        }
      }
    }
  }
  // The client renders these fields directly (public/src/game/worldArt.js
  // drawAsteroid walks shape/craters), so malformed art must fail here rather
  // than reach a browser and break the frame.
  function validateAsteroidArt(items) {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const label = item.id || "?";
      if (!Array.isArray(item.shape) || item.shape.length < 6) errors.push(`asteroid ${label}.shape must be an array of at least 6 radii`);
      else if (item.shape.some((value) => !isFiniteNumber(value) || value <= 0)) errors.push(`asteroid ${label}.shape must hold positive finite radii`);
      if (!Array.isArray(item.craters)) errors.push(`asteroid ${label}.craters must be an array`);
      else for (const crater of item.craters) {
        if (!crater || ["angle", "distance", "radius"].some((key) => !isFiniteNumber(crater[key]))) {
          errors.push(`asteroid ${label} has a crater with non-finite geometry`);
          break;
        }
      }
      for (const key of ["rotation", "spin"]) if (!isFiniteNumber(item[key])) errors.push(`asteroid ${label}.${key} must be finite`);
      if (typeof item.shade !== "string" || !item.shade) errors.push(`asteroid ${label}.shade must be a non-empty string`);
    }
  }
  function validateClouds(items, seen) {
    for (const item of items) {
      if (typeof item.id !== "string" || seen.has(item.id)) errors.push(`cloud id ${item.id || "?"} is missing or duplicated`);
      seen.add(item.id);
      for (const key of ["x", "y", "rx", "ry", "rotation", "alpha"]) if (!isFiniteNumber(item[key])) errors.push(`cloud ${item.id || "?"}.${key} must be finite`);
      for (const key of ["rx", "ry"]) if (!(item[key] > 0)) errors.push(`cloud ${item.id || "?"}.${key} must be positive`);
    }
  }
  function validateSafeZones(items) {
    for (const zone of items) {
      if (!isFiniteNumber(zone.x) || !isFiniteNumber(zone.y) || !(zone.radius > 0)) errors.push("safe zone must have finite x/y and positive radius");
      if (zone.id != null && typeof zone.id !== "string") errors.push("safe zone id must be a string when present");
      if (zone.team != null && typeof zone.team !== "string") errors.push("safe zone team must be a string when present");
      if (zone.ownerId != null && typeof zone.ownerId !== "string") errors.push("safe zone ownerId must be a string when present");
      if (typeof zone.color !== "string" || !zone.color) errors.push("safe zone color must be present");
    }
  }
  function validateClearance(left, leftLabel, right, rightLabel, buffer, same = false) {
    for (let i = 0; i < left.length; i += 1) {
      const a = left[i];
      for (let j = 0; j < right.length; j += 1) {
        if (same && j <= i) continue;
        const b = right[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius + buffer) errors.push(`${leftLabel} ${a.id || i} overlaps ${rightLabel} ${b.id || j}`);
      }
    }
  }
  return { ok: errors.length === 0, seed: seedLabel, errors };
}

module.exports = { validateGeneratedMap };
