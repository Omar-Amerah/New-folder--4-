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

// --- Phase Three weapon targeting and profile performance flags ---

let _weaponTargetAcquisitionCadence = false;

// --- Phase Four authoritative fixed-timestep simulation flag ---

let _fixedAuthoritativeTimestep = false;

function FIXED_AUTHORITATIVE_TIMESTEP() {
  return _fixedAuthoritativeTimestep;
}

function __setFIXED_AUTHORITATIVE_TIMESTEP(value) {
  _fixedAuthoritativeTimestep = Boolean(value);
}

// --- Phase 4B incremental spatial-index updates flag ---

let _incrementalSpatialIndex = false;

function INCREMENTAL_SPATIAL_INDEX() {
  return _incrementalSpatialIndex;
}

function __setINCREMENTAL_SPATIAL_INDEX(value) {
  _incrementalSpatialIndex = Boolean(value);
}

// --- Phase 4C/4D shared ship contact pairs and packed-fleet solver flags ---
// Both paths remain opt-in. PACKED_FLEET_SOLVER is only honoured when the
// shared pair set is enabled by the movement collision path.

let _sharedMovementContactPairs = false;
let _packedFleetSolver = false;

function SHARED_MOVEMENT_CONTACT_PAIRS() {
  return _sharedMovementContactPairs;
}

function PACKED_FLEET_SOLVER() {
  return _packedFleetSolver;
}

function __setSHARED_MOVEMENT_CONTACT_PAIRS(value) {
  _sharedMovementContactPairs = Boolean(value);
}

function __setPACKED_FLEET_SOLVER(value) {
  _packedFleetSolver = Boolean(value);
}
let _pointDefenceSharedThreats = false;
let _weaponProfileRevisionCache = false;

function WEAPON_TARGET_ACQUISITION_CADENCE() {
  return _weaponTargetAcquisitionCadence;
}

function POINT_DEFENCE_SHARED_THREATS() {
  return _pointDefenceSharedThreats;
}

function WEAPON_PROFILE_REVISION_CACHE() {
  return _weaponProfileRevisionCache;
}

function __setWEAPON_TARGET_ACQUISITION_CADENCE(value) {
  _weaponTargetAcquisitionCadence = Boolean(value);
}

function __setPOINT_DEFENCE_SHARED_THREATS(value) {
  _pointDefenceSharedThreats = Boolean(value);
}

function __setWEAPON_PROFILE_REVISION_CACHE(value) {
  _weaponProfileRevisionCache = Boolean(value);
}

module.exports = {
  circularShipSeparation,
  redundantFleetMapCollisionPass,
  PROJECTILE_FLAK_SINGLE_PASS,
  PROJECTILE_GUIDANCE_CADENCE,
  PROJECTILE_GRID_COLLISION,
  WEAPON_TARGET_ACQUISITION_CADENCE,
  POINT_DEFENCE_SHARED_THREATS,
  WEAPON_PROFILE_REVISION_CACHE,
  __setCircularShipSeparation,
  __setRedundantFleetMapCollisionPass,
  __setPROJECTILE_FLAK_SINGLE_PASS,
  __setPROJECTILE_GUIDANCE_CADENCE,
  __setPROJECTILE_GRID_COLLISION,
  __setWEAPON_TARGET_ACQUISITION_CADENCE,
  __setPOINT_DEFENCE_SHARED_THREATS,
  __setWEAPON_PROFILE_REVISION_CACHE,
  FIXED_AUTHORITATIVE_TIMESTEP,
  __setFIXED_AUTHORITATIVE_TIMESTEP,
  INCREMENTAL_SPATIAL_INDEX,
  __setINCREMENTAL_SPATIAL_INDEX,
  SHARED_MOVEMENT_CONTACT_PAIRS,
  __setSHARED_MOVEMENT_CONTACT_PAIRS,
  PACKED_FLEET_SOLVER,
  __setPACKED_FLEET_SOLVER
};
