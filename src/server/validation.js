// String and number sanitization, validating message structures, and request parameters.

function sanitizeName(name, fallback) {
  const clean = String(name || "").replace(/[^\w .-]/g, "").trim().slice(0, 18);
  return clean || fallback;
}

function sanitizeTeam(team, fallbackId) {
  const clean = String(team || "").toLowerCase();
  if (clean === "blue" || clean === "red") return clean;
  return fallbackId;
}


// The combat stances the movement controller implements: Charge, Hold, Static.
//
// Orbit and Kite are withdrawn rather than deleted: the names still parse, so
// saved blueprints, older clients and stored player preferences all keep
// loading, but both resolve to Hold. That means a ship can never end up carrying
// a stance nothing will fly, and either can be reinstated by removing it from
// this set once the controller flies it.
//
// Clients are still free to send them; they simply get Hold back in the
// acknowledgement and in the snapshot, which is what tells the UI what actually
// happened.
const WITHDRAWN_COMBAT_STYLES = new Set(["orbit", "kite"]);

function sanitizeCombatStyle(style, fallback = "hold") {
  const clean = String(style || "").toLowerCase();
  if (WITHDRAWN_COMBAT_STYLES.has(clean)) return "hold";
  if (clean === "charge" || clean === "hold" || clean === "static") return clean;
  // Compatibility for saved blueprints and older clients. The aggressive aliases
  // resolve to Charge, matching how the client's own normalizeCombatStyle maps
  // them, so a blueprint saved as "brawler" gets the stance it was named for.
  if (clean === "direct" || clean === "interceptor" || clean === "brawler") return "charge";
  if (clean === "circle" || clean === "evasive") return "hold";
  if (clean === "maintain" || clean === "sentry" || clean === "heavy") return "hold";
  const cleanFallback = String(fallback || "").toLowerCase();
  if (cleanFallback !== clean) return sanitizeCombatStyle(cleanFallback, "hold");
  return "hold";
}

// Per-ship movement toggles.
//
// Every one defaults to true, and true is how the game behaves without them, so
// a ship that has never been told otherwise flies exactly as it always did and
// an older client that sends none of this is unaffected.
const MOVEMENT_TOGGLE_DEFAULTS = Object.freeze({
  // Swing the nose onto whatever the ship is engaging once it has stopped.
  autoTurn: true,
  // Act on a target combat acquired by itself. Off, the ship will still shoot
  // what it can reach, it just will not go anywhere about it.
  autoEngage: true,
  // Go after a target that opens the range again once already established.
  pursue: true,
  // Travel at the group's pace rather than the hull's own.
  matchFormationSpeed: true
});

const MOVEMENT_TOGGLE_KEYS = Object.freeze(Object.keys(MOVEMENT_TOGGLE_DEFAULTS));

function sanitizeMovementToggles(toggles, fallback = null) {
  const base = fallback && typeof fallback === "object" ? fallback : MOVEMENT_TOGGLE_DEFAULTS;
  const source = toggles && typeof toggles === "object" ? toggles : null;
  const clean = {};
  for (const key of MOVEMENT_TOGGLE_KEYS) {
    const requested = source ? source[key] : undefined;
    if (requested === undefined) {
      clean[key] = base[key] === undefined ? MOVEMENT_TOGGLE_DEFAULTS[key] : Boolean(base[key]);
    } else {
      clean[key] = Boolean(requested);
    }
  }
  return clean;
}

function sanitizeRoomCode(room) {
  return String(room || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
}

function sanitizeRequestId(requestId) {
  return String(requestId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
}

function validateBuildShip(room, player, stats = null) {
  if (!player.ready && room.phase === "active") {
    return { ok: false, reason: "Invalid design: save a blueprint first." };
  }
  const { computeStats } = require("./shipStats");
  const shipStats = stats || player.stats || computeStats(player.design, player.wiring);
  if (shipStats.thrust <= 0) {
    return { ok: false, reason: "Invalid design: add at least one engine." };
  }
  if (shipStats.unitCost > player.money) {
    return { ok: false, reason: `Cannot build ship. Need $${shipStats.unitCost - Math.floor(player.money)} more.` };
  }
  return { ok: true, shipCost: shipStats.unitCost, shipStats };
}

module.exports = {
  MOVEMENT_TOGGLE_DEFAULTS,
  MOVEMENT_TOGGLE_KEYS,
  sanitizeName,
  sanitizeTeam,
  sanitizeCombatStyle,
  sanitizeMovementToggles,
  sanitizeRoomCode,
  sanitizeRequestId,
  validateBuildShip
};
