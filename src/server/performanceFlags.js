"use strict";

// Authoritative server-side performance feature flags for Phase One and Phase Two.
// Defaults keep new projectile paths disabled until their parity tests pass;
// tests can override them via the __set* helpers.

let _circularShipSeparation = true;
let _redundantFleetMapCollisionPass = false;

function circularShipSeparation() {
  return _circularShipSeparation;
}

function redundantFleetMapCollisionPass() {
  return _redundantFleetMapCollisionPass;
}

function __setCircularShipSeparation(value) {
  _circularShipSeparation = Boolean(value);
}

function __setRedundantFleetMapCollisionPass(value) {
  _redundantFleetMapCollisionPass = Boolean(value);
}

// --- Phase Two projectile performance flags ---

let _projectileFlakSinglePass = false;
let _projectileGuidanceCadence = false;
let _projectileGridCollision = false;

function PROJECTILE_FLAK_SINGLE_PASS() {
  return _projectileFlakSinglePass;
}

function PROJECTILE_GUIDANCE_CADENCE() {
  return _projectileGuidanceCadence;
}

function PROJECTILE_GRID_COLLISION() {
  return _projectileGridCollision;
}

function __setPROJECTILE_FLAK_SINGLE_PASS(value) {
  _projectileFlakSinglePass = Boolean(value);
}

function __setPROJECTILE_GUIDANCE_CADENCE(value) {
  _projectileGuidanceCadence = Boolean(value);
}

function __setPROJECTILE_GRID_COLLISION(value) {
  _projectileGridCollision = Boolean(value);
}

module.exports = {
  circularShipSeparation,
  redundantFleetMapCollisionPass,
  PROJECTILE_FLAK_SINGLE_PASS,
  PROJECTILE_GUIDANCE_CADENCE,
  PROJECTILE_GRID_COLLISION,
  __setCircularShipSeparation,
  __setRedundantFleetMapCollisionPass,
  __setPROJECTILE_FLAK_SINGLE_PASS,
  __setPROJECTILE_GUIDANCE_CADENCE,
  __setPROJECTILE_GRID_COLLISION
};
