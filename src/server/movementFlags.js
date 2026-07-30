"use strict";

// Temporary rollback switch for the movement rewrite.
//
// The rewritten controller (movementV2.js) is the default. Setting
// MFA_MOVEMENT_FALLBACK=1 in the environment restores the whole pre-rewrite
// movement stack -- runtime shape, intents, steering, commands -- exactly as it
// was, so a bad build can be reverted without a code change.
//
// This is deliberately a load-time switch, not a per-tick one: the two
// implementations keep different per-ship runtime state, and a room may not
// change its mind about which one owns ship.movement half way through a match.
//
// Delete this file, movementFallback.js and the movement*Legacy/Intents/
// Steering/Commands/Modern modules once the rewrite has shipped and the phases
// below are signed off.

function movementFallbackEnabled() {
  const raw = process.env.MFA_MOVEMENT_FALLBACK;
  if (raw === undefined || raw === null || raw === "") return false;
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

// Combat stances frozen for the duration of the rewrite. The controller flies
// every ship as "hold": it obeys explicit move/stop orders and otherwise keeps
// station. Charge, orbit and kite remain selectable in the UI and are still
// carried on the ship and in snapshots -- they simply have no steering
// behaviour attached while the rewrite is in progress.
const FROZEN_COMBAT_STYLES = Object.freeze(["charge", "orbit", "kite"]);

// Order types the rewritten controller understands.
const SUPPORTED_MOVEMENT_TYPES = Object.freeze(["move", "stop", "attack", "repair"]);

module.exports = {
  FROZEN_COMBAT_STYLES,
  SUPPORTED_MOVEMENT_TYPES,
  movementFallbackEnabled
};
