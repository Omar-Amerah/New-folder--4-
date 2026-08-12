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


// The combat stances the movement controller implements: Charge, Hold, Kite,
// Orbit, Static.
//
// A stance belongs here only once the controller actually flies it. Kite was
// withdrawn to Hold for exactly as long as it had no controller; it has one now
// (planKite in movementV2.js), so it is canonical again and every value that
// was parked on Hold in the meantime -- saved blueprints, stored player
// preferences, older clients that never stopped sending it -- loads as Kite.
//
// The set is kept rather than deleted: it is the seam a future stance is
// withdrawn through, and an empty one states plainly that nothing is currently
// parked.
const WITHDRAWN_COMBAT_STYLES = new Set();

function sanitizeCombatStyle(style, fallback = "hold") {
  const clean = String(style || "").toLowerCase();
  if (WITHDRAWN_COMBAT_STYLES.has(clean)) return "hold";
  if (clean === "charge" || clean === "hold" || clean === "kite"
    || clean === "orbit" || clean === "static") return clean;
  // Compatibility for saved blueprints and older clients. The aggressive aliases
  // resolve to Charge, matching how the client's own normalizeCombatStyle maps
  // them, so a blueprint saved as "brawler" gets the stance it was named for.
  if (clean === "direct" || clean === "interceptor" || clean === "brawler") return "charge";
  if (clean === "circle" || clean === "evasive") return "orbit";
  if (clean === "maintain" || clean === "sentry" || clean === "heavy") return "hold";
  const cleanFallback = String(fallback || "").toLowerCase();
  if (cleanFallback !== clean) return sanitizeCombatStyle(cleanFallback, "hold");
  return "hold";
}

// Which way round an orbiting ship goes. This is deliberately NOT a combat
// style: "orbit-clockwise" and "orbit-anticlockwise" as separate stances would
// have to be spelled out separately in every validation, snapshot, UI-highlight
// and movement branch that mentions a stance, and every one of those is a place
// the two could drift apart. It is one stance carrying a direction.
//
// Screen coordinates increase downward, so clockwise on screen is the positive
// mathematical rotation. See orbitTangent in movementV2.js, which is the one
// place the sign is turned into a heading.
const ORBIT_DIRECTION = Object.freeze({
  CLOCKWISE: 1,
  ANTICLOCKWISE: -1
});

// Anything that is not explicitly anticlockwise orbits clockwise. There is no
// third state and no null: a ship always has a direction to fall back on, which
// is what lets the stance be re-selected later without the UI having to
// remember one for it.
function sanitizeOrbitDirection(value, fallback = ORBIT_DIRECTION.CLOCKWISE) {
  const clean = Number(value);
  if (clean === ORBIT_DIRECTION.ANTICLOCKWISE) return ORBIT_DIRECTION.ANTICLOCKWISE;
  if (clean === ORBIT_DIRECTION.CLOCKWISE) return ORBIT_DIRECTION.CLOCKWISE;
  return Number(fallback) === ORBIT_DIRECTION.ANTICLOCKWISE
    ? ORBIT_DIRECTION.ANTICLOCKWISE
    : ORBIT_DIRECTION.CLOCKWISE;
}

// Per-ship movement toggles.
//
// Every one defaults to true, and true is how the game behaves without them, so
// a ship that has never been told otherwise flies exactly as it always did and
// an older client that sends none of this is unaffected.
const MOVEMENT_TOGGLE_DEFAULTS = Object.freeze({
  // Act on a target combat acquired by itself. Off, the ship will still shoot
  // what it can reach, it just will not go anywhere about it.
  autoEngage: true,
  // Go after a target that opens the range again once already established.
  pursue: true,
  // Swing the hull round to face what it is fighting. Off, nothing the combat
  // code decides may turn the ship: its heading is whatever flying the player's
  // own orders and the I/O keys leave it on.
  autoTurn: true
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
  const shipStats = stats || player.stats || computeStats(player.design);
  if (shipStats.thrust <= 0) {
    return { ok: false, reason: "Invalid design: add at least one engine." };
  }
  if (shipStats.turnRate <= 0) {
    return { ok: false, reason: "Invalid design: ship must be able to turn." };
  }
  if (shipStats.unitCost > player.money) {
    return { ok: false, reason: `Cannot build ship. Need $${shipStats.unitCost - Math.floor(player.money)} more.` };
  }
  return { ok: true, shipCost: shipStats.unitCost, shipStats };
}

module.exports = {
  MOVEMENT_TOGGLE_DEFAULTS,
  MOVEMENT_TOGGLE_KEYS,
  ORBIT_DIRECTION,
  sanitizeName,
  sanitizeTeam,
  sanitizeCombatStyle,
  sanitizeOrbitDirection,
  sanitizeMovementToggles,
  sanitizeRoomCode,
  sanitizeRequestId,
  validateBuildShip
};
