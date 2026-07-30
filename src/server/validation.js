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


// Hold is currently the only combat stance the movement controller implements.
//
// Charge, Orbit and Kite are withdrawn rather than deleted: the names still
// parse, so saved blueprints, older clients and stored player preferences all
// keep loading, but every one of them resolves to Hold. That means a ship can
// never end up carrying a stance nothing will fly, and the stances can be
// reinstated later by removing one line here.
//
// Clients are still free to send them; they simply get Hold back in the
// acknowledgement and in the snapshot, which is what tells the UI what actually
// happened.
const WITHDRAWN_COMBAT_STYLES = new Set(["charge", "orbit", "kite"]);

function sanitizeCombatStyle(style, fallback = "hold") {
  const clean = String(style || "").toLowerCase();
  if (WITHDRAWN_COMBAT_STYLES.has(clean)) return "hold";
  if (clean === "hold" || clean === "static") return clean;
  // Compatibility for saved blueprints and older clients.
  if (clean === "circle" || clean === "evasive") return "hold";
  if (clean === "maintain" || clean === "sentry" || clean === "heavy") return "hold";
  if (clean === "direct" || clean === "interceptor" || clean === "brawler") return "hold";
  const cleanFallback = String(fallback || "").toLowerCase();
  if (cleanFallback !== clean) return sanitizeCombatStyle(cleanFallback, "hold");
  return "hold";
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
  sanitizeName,
  sanitizeTeam,
  sanitizeCombatStyle,
  sanitizeRoomCode,
  sanitizeRequestId,
  validateBuildShip
};
