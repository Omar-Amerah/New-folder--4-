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

// --- Phase Five entity/field-level snapshot delivery flag ---
// This remains opt-in until the focused protocol, lifecycle and production
// benchmark checks have established parity with the existing compact format.
let _entityDeltaSnapshots = false;

// --- Phase 6A authoritative Heat runtime flag ---
// Keep the optimized path opt-in until the parity and soak evidence is
// accepted.  Tests and benchmarks can switch it explicitly through the
// setter while the legacy solver remains the production default.
let _optimizedHeatRuntime = false;

// --- Phase 6B authoritative drone decision/runtime flag ---
// The optimized drone architecture remains opt-in until its differential and
// production-path checks establish parity with the existing loop.
let _optimizedDroneRuntime = false;

// --- Phase 6C authoritative visibility runtime flag ---
// Keep the incremental source/team/snapshot architecture disabled until its
// differential and production-path checks establish parity with the legacy
// visibility implementation.  This is intentionally one switch for the full
// Phase 6C architecture; do not split it into sensor/filter/team flags.
let _optimizedVisibilityRuntime = false;

// --- Phase 6D authoritative incremental Command Aura runtime ---
// Keep the cache/incremental path opt-in until differential and production-path
// verification is accepted. This is intentionally one flag for the complete
// Command Aura runtime rather than separate source/membership/winner switches.
let _optimizedCommandAuraRuntime = false;
// --- Phase 6F station weapon runtime flag ---
// The legacy station weapon loop remains the production default. The optimized
// path is enabled only by focused parity/benchmark checks after the measured
// Phase 6F station-weapon bottleneck evidence.
let _optimizedStationWeaponRuntime = false;

function OPTIMIZED_STATION_WEAPON_RUNTIME() {
  return _optimizedStationWeaponRuntime;
}

function __setOPTIMIZED_STATION_WEAPON_RUNTIME(value) {
  _optimizedStationWeaponRuntime = Boolean(value);
}

function OPTIMIZED_VISIBILITY_RUNTIME() {
  return _optimizedVisibilityRuntime;
}

function __setOPTIMIZED_VISIBILITY_RUNTIME(value) {
  _optimizedVisibilityRuntime = Boolean(value);
}

function OPTIMIZED_COMMAND_AURA_RUNTIME() {
  return _optimizedCommandAuraRuntime;
}

function __setOPTIMIZED_COMMAND_AURA_RUNTIME(value) {
  _optimizedCommandAuraRuntime = Boolean(value);
}

function OPTIMIZED_DRONE_RUNTIME() {
  return _optimizedDroneRuntime;
}

function __setOPTIMIZED_DRONE_RUNTIME(value) {
  _optimizedDroneRuntime = Boolean(value);
}

function OPTIMIZED_HEAT_RUNTIME() {
  return _optimizedHeatRuntime;
}

function __setOPTIMIZED_HEAT_RUNTIME(value) {
  _optimizedHeatRuntime = Boolean(value);
}

function ENTITY_DELTA_SNAPSHOTS() {
  return _entityDeltaSnapshots;
}

function __setENTITY_DELTA_SNAPSHOTS(value) {
  _entityDeltaSnapshots = Boolean(value);
}

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
  ENTITY_DELTA_SNAPSHOTS,
  __setENTITY_DELTA_SNAPSHOTS,
  FIXED_AUTHORITATIVE_TIMESTEP,
  __setFIXED_AUTHORITATIVE_TIMESTEP,
  INCREMENTAL_SPATIAL_INDEX,
  __setINCREMENTAL_SPATIAL_INDEX,
  SHARED_MOVEMENT_CONTACT_PAIRS,
  __setSHARED_MOVEMENT_CONTACT_PAIRS,
  PACKED_FLEET_SOLVER,
  __setPACKED_FLEET_SOLVER,
  OPTIMIZED_DRONE_RUNTIME,
  __setOPTIMIZED_DRONE_RUNTIME,
  OPTIMIZED_HEAT_RUNTIME,
  __setOPTIMIZED_HEAT_RUNTIME,
  OPTIMIZED_VISIBILITY_RUNTIME,
  __setOPTIMIZED_VISIBILITY_RUNTIME,
  OPTIMIZED_COMMAND_AURA_RUNTIME,
  __setOPTIMIZED_COMMAND_AURA_RUNTIME
  OPTIMIZED_STATION_WEAPON_RUNTIME,
  __setOPTIMIZED_STATION_WEAPON_RUNTIME
};
