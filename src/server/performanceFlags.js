"use strict";

// Authoritative server-side performance feature flags for Phase One.
// Defaults enable the circular separation and redundant-pass removals now that
// parity tests pass; tests can override them via the __set* helpers.

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
