// Validates generated map data so rooms, snapshots and tests share one schema guard.

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

  const ids = { relays: new Set(), asteroids: new Set(), clouds: new Set() };
  validateCircles(map.relays || [], "relay", ids.relays, 0);
  validateCircles(map.asteroids || [], "asteroid", ids.asteroids, 80);
  validateClouds(map.clouds || [], ids.clouds);
  validateSafeZones(map.safeZones || []);
  if (world.label !== "Testing") validateClearance(map.relays || [], "relay", map.safeZones || [], "safe zone", 500);
  validateClearance(map.asteroids || [], "asteroid", map.safeZones || [], "safe zone", 220);
  validateClearance(map.asteroids || [], "asteroid", map.relays || [], "relay", 200);
  validateClearance(map.relays || [], "relay", map.relays || [], "relay", 0, true);
  validateClearance(map.asteroids || [], "asteroid", map.asteroids || [], "asteroid", 220, true);

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
  function validateClouds(items, seen) {
    for (const item of items) {
      if (typeof item.id !== "string" || seen.has(item.id)) errors.push(`cloud id ${item.id || "?"} is missing or duplicated`);
      seen.add(item.id);
      for (const key of ["x", "y", "rx", "ry", "rotation", "alpha"]) if (!isFiniteNumber(item[key])) errors.push(`cloud ${item.id || "?"}.${key} must be finite`);
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
