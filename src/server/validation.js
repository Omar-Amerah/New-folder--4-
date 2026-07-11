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

function sanitizeFormation(formation) {
  const clean = String(formation || "").toLowerCase();
  if (clean === "wedge" || clean === "clump") return clean;
  return "line";
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
  if (shipStats.unitCost > player.money) {
    return { ok: false, reason: `Cannot build ship. Need $${shipStats.unitCost - Math.floor(player.money)} more.` };
  }
  return { ok: true, shipCost: shipStats.unitCost, shipStats };
}

module.exports = {
  sanitizeName,
  sanitizeTeam,
  sanitizeFormation,
  sanitizeRoomCode,
  sanitizeRequestId,
  validateBuildShip
};
