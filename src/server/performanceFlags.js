"use strict";

// Authoritative server-side performance feature flags.  These are mutable for
// tests via the __set* helpers and default to the values that preserve the
// existing behaviour until parity is demonstrated.

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

module.exports = {
  circularShipSeparation,
  redundantFleetMapCollisionPass,
  __setCircularShipSeparation,
  __setRedundantFleetMapCollisionPass
};
