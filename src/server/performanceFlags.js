"use strict";

// Authoritative server-side gameplay/safety switches. Performance rollouts have
// completed; only the two independent movement safety decisions remain.

let _circularShipSeparation = true;
// Static geometry is already resolved during each movement substep. The
// post-solver safety boundary should therefore revisit only ships changed by
// separation or static correction; keep the full-fleet mode as a diagnostic
// comparison switch, but do not pay for it in the authoritative path.
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
  __setCircularShipSeparation,
  redundantFleetMapCollisionPass,
  __setRedundantFleetMapCollisionPass
};
