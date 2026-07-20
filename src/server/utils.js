// Contains small utility functions, random range generation, distance/angle math helper functions, and formatting.

const os = require("os");

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
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
  return function nextRandom() {
    value = (value + 0x6D2B79F5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// Shared with the client renderer (public/src/shared/rotationRules.js) so
// server aim math and the client's turret prediction can never drift.
const { angleDifference, approachAngle: rotateToward } = require("../../public/src/shared/rotationRules");

function round(value) {
  return Math.round(value * 100) / 100;
}

function performanceNow() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function getLocalUrls(port) {
  const urls = [];
  const interfaces = os.networkInterfaces();
  for (const values of Object.values(interfaces)) {
    for (const net of values || []) {
      if (net.family === "IPv4" && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

module.exports = {
  clampNumber,
  rngRange,
  hashString,
  seededRandom,
  angleDifference,
  rotateToward,
  round,
  performanceNow,
  getLocalUrls
};
