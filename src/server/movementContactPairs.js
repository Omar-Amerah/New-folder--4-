"use strict";

// Friendly ships are not a pathing or traffic system. This module only builds
// a deterministic superset of nearby ship pairs for movementCollision.js.
// Exact overlap, correction and velocity handling belong to that module.

const { compareEntityIds } = require("./utils");
const { bump, setCounter } = require("./roomTelemetry");
const { SEPARATION_BROAD_PHASE_PAD } = require("./movementTuning");
const { physicalCollisionRadius } = require("./movementCollision");

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isLiveShip(room, ship) {
  return Boolean(
    ship
      && ship.alive !== false
      && ship.removed !== true
      && (!room?.ships || room.ships.get(ship.id) === ship)
  );
}

function ensureState(room) {
  if (!room) return null;
  if (!Array.isArray(room._movementContactPairs)) room._movementContactPairs = [];
  if (!Array.isArray(room._movementContactPairPreviousShips)) room._movementContactPairPreviousShips = [];
  if (!Number.isFinite(Number(room._movementContactStepSerial))) room._movementContactStepSerial = 0;
  if (!(room._movementContactPairKeys instanceof Set)) room._movementContactPairKeys = new Set();
  return room;
}

function clearPair(pair) {
  pair.a = null;
  pair.b = null;
  pair.aId = null;
  pair.bId = null;
  pair.orderA = 0;
  pair.orderB = 0;
}

function clearMovementContactPairs(room) {
  const state = ensureState(room);
  if (!state) return;
  for (const pair of state._movementContactPairs) clearPair(pair);
  state._movementContactPairs.length = 0;
  state._movementContactPairKeys.clear();
  state._movementContactPairPreviousShips.length = 0;
  state._movementContactPairStepId = null;
  state._movementContactPairBuildStepId = null;
}

function beginMovementContactStep(room, ships, now = 0) {
  const state = ensureState(room);
  if (!state) return null;
  for (const pair of state._movementContactPairs) clearPair(pair);
  state._movementContactPairs.length = 0;
  state._movementContactPairKeys.clear();
  state._movementContactPairBuildStepId = null;
  state._movementContactPairStepId = ++state._movementContactStepSerial;
  state._movementContactPairNow = Number.isFinite(Number(now)) ? Number(now) : 0;
  state._movementContactPairPreviousShips.length = 0;
  for (const ship of ships || []) {
    if (!isLiveShip(room, ship)) continue;
    ship._movementContactPreviousX = finiteNumber(ship.x, 0);
    ship._movementContactPreviousY = finiteNumber(ship.y, 0);
    ship._movementContactPreviousStep = state._movementContactPairStepId;
    state._movementContactPairPreviousShips.push(ship);
  }
  return state._movementContactPairStepId;
}

function sweptBounds(ship, stepId) {
  const currentX = finiteNumber(ship.x, 0);
  const currentY = finiteNumber(ship.y, 0);
  const previousX = ship._movementContactPreviousStep === stepId
    ? finiteNumber(ship._movementContactPreviousX, currentX)
    : currentX;
  const previousY = ship._movementContactPreviousStep === stepId
    ? finiteNumber(ship._movementContactPreviousY, currentY)
    : currentY;
  const radius = physicalCollisionRadius(ship) + SEPARATION_BROAD_PHASE_PAD;
  return {
    minX: Math.min(previousX, currentX) - radius,
    maxX: Math.max(previousX, currentX) + radius,
    minY: Math.min(previousY, currentY) - radius,
    maxY: Math.max(previousY, currentY) + radius
  };
}

function pairKey(orderA, orderB) {
  return `${orderA}:${orderB}`;
}

function buildMovementContactPairs(room, ships, now = 0, options = {}) {
  const state = ensureState(room);
  if (!state) return [];
  const stepId = options.stepId ?? state._movementContactPairStepId ?? beginMovementContactStep(room, ships, now);
  if (state._movementContactPairBuildStepId === stepId) return state._movementContactPairs;

  for (const pair of state._movementContactPairs) clearPair(pair);
  state._movementContactPairs.length = 0;
  state._movementContactPairKeys.clear();

  const ordered = [...(ships || room?.ships?.values?.() || [])]
    .filter((ship) => isLiveShip(room, ship))
    .sort(compareEntityIds);
  const entries = ordered.map((ship, index) => ({ ship, index, bounds: sweptBounds(ship, stepId) }));
  entries.sort((left, right) => (
    left.bounds.minX - right.bounds.minX
      || left.bounds.minY - right.bounds.minY
      || left.index - right.index
  ));

  const active = [];
  let candidatesVisited = 0;
  let duplicatesRejected = 0;
  for (const entry of entries) {
    let write = 0;
    for (const activeEntry of active) {
      if (activeEntry.bounds.maxX >= entry.bounds.minX) active[write++] = activeEntry;
    }
    active.length = write;
    for (const activeEntry of active) {
      candidatesVisited += 1;
      const a = ordered[Math.min(entry.index, activeEntry.index)];
      const b = ordered[Math.max(entry.index, activeEntry.index)];
      if (activeEntry.bounds.maxY < entry.bounds.minY || entry.bounds.maxY < activeEntry.bounds.minY) continue;
      const key = pairKey(Math.min(entry.index, activeEntry.index), Math.max(entry.index, activeEntry.index));
      if (state._movementContactPairKeys.has(key)) {
        duplicatesRejected += 1;
        continue;
      }
      state._movementContactPairKeys.add(key);
      state._movementContactPairs.push({
        a,
        b,
        aId: a.id,
        bId: b.id,
        orderA: Math.min(entry.index, activeEntry.index),
        orderB: Math.max(entry.index, activeEntry.index)
      });
    }
    active.push(entry);
  }

  state._movementContactPairs.sort((a, b) => a.orderA - b.orderA || a.orderB - b.orderB);
  state._movementContactPairStepId = stepId;
  state._movementContactPairBuildStepId = stepId;
  bump(room, "movementContactPairBuilds");
  setCounter(room, "movementContactPairsGenerated", state._movementContactPairs.length);
  setCounter(room, "movementContactPairCandidatesVisited", candidatesVisited);
  setCounter(room, "movementContactPairDuplicatesRejected", duplicatesRejected);
  setCounter(room, "movementContactPairMaxPerStep", state._movementContactPairs.length);
  return state._movementContactPairs;
}

function getMovementContactPairs(room, stepId = null) {
  const state = ensureState(room);
  if (!state) return [];
  if (stepId !== null && stepId !== undefined && state._movementContactPairBuildStepId !== stepId) return [];
  return state._movementContactPairs;
}

function hasMovementContactPair(room, a, b) {
  const state = ensureState(room);
  if (!state || !a || !b) return false;
  return state._movementContactPairs.some((pair) => (
    (pair.a === a && pair.b === b) || (pair.a === b && pair.b === a)
  ));
}

function removeShipFromMovementContactPairs(room, ship) {
  const state = ensureState(room);
  if (!state || !ship) return 0;
  let removed = 0;
  const kept = [];
  for (const pair of state._movementContactPairs) {
    if (pair.a === ship || pair.b === ship) {
      clearPair(pair);
      removed += 1;
    } else {
      kept.push(pair);
    }
  }
  state._movementContactPairs.length = 0;
  state._movementContactPairs.push(...kept);
  if (removed) {
    state._movementContactPairKeys.clear();
    for (const pair of state._movementContactPairs) state._movementContactPairKeys.add(pairKey(pair.orderA, pair.orderB));
  }
  return removed;
}

module.exports = {
  beginMovementContactStep,
  buildMovementContactPairs,
  clearMovementContactPairs,
  getMovementContactPairs,
  hasMovementContactPair,
  removeShipFromMovementContactPairs
};
