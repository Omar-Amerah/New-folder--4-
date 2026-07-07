const crypto = require("crypto");

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function rngRange(rng, min, max) {
  return min + rng() * (max - min);
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return function () {
    value = Math.imul(value, 1664525) + 1013904223 | 0;
    return (value >>> 0) / 4294967296;
  };
}

function angleDifference(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

function rotateToward(current, target, maxStep) {
  const diff = angleDifference(current, target);
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function performanceNow() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function makeRoomCode(rooms, isClosedRoomCode) {
  let code = "";
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  do {
    code = "";
    for (let i = 0; i < 5; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  } while (rooms.has(code) || isClosedRoomCode(code));
  return code;
}

function sanitizeRoomCode(room) {
  return String(room || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
}

function sanitizeRequestId(requestId) {
  return String(requestId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
}

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

function teamLabel(room, team, fallback) {
  if (room.rules?.gameMode === "solo") {
    const owner = room.players.get(team);
    return owner?.name || fallback || "No wing";
  }
  // To avoid circular dep, we assume TEAM_NAMES can be passed or checked elsewhere,
  // but let's just return the team name.
  if (team === 'blue') return "Blue wing";
  if (team === 'red') return "Red wing";
  const owner = room.players.get(team);
  return owner?.name || fallback || "Solo";
}

function effectiveStackedValue(values, falloff) {
  return [...values].sort((a, b) => b - a).reduce((total, value, index) => total + value * Math.pow(falloff, index), 0);
}

function softCap(value, cap, softness = 0.35) {
  if (value <= cap) return value;
  return cap + (value - cap) * softness;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeRotation(value) {
  const rotation = Number(value);
  return [0, 90, 180, 270].includes(rotation) ? rotation : 0;
}

function getLocalUrls(port) {
  const os = require('os');
  const urls = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        urls.push(`http://${iface.address}:${port}`);
      }
    }
  }
  return urls;
}

module.exports = {
  clampNumber, randomRange, rngRange, hashString, seededRandom,
  angleDifference, rotateToward, round, performanceNow,
  makeRoomCode, sanitizeRoomCode, sanitizeRequestId,
  sanitizeName, sanitizeTeam, sanitizeFormation, teamLabel,
  effectiveStackedValue, softCap, toNumber, normalizeRotation, getLocalUrls
};
