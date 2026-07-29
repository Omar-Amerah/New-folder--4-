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

// Natural ("s2" before "s10") ordering for entity ids, without ICU.
//
// The simulation orders collision pairs, avoidance ties and target lists by id
// so results are deterministic. Those comparisons used
// String.localeCompare(other, undefined, { numeric: true }), which runs a full
// ICU collation per call: at 60 ships the separation solver alone spent the
// majority of the server tick inside it. This produces the same ordering for
// the ids the simulation generates (an ASCII prefix followed by a decimal
// counter) at a fraction of the cost.
function compareNaturalIds(left, right) {
  const a = typeof left === "string" ? left : String(left ?? "");
  const b = typeof right === "string" ? right : String(right ?? "");
  if (a === b) return 0;
  const aLength = a.length;
  const bLength = b.length;
  let i = 0;
  let j = 0;
  while (i < aLength && j < bLength) {
    const aCode = a.charCodeAt(i);
    const bCode = b.charCodeAt(j);
    const aIsDigit = aCode >= 48 && aCode <= 57;
    const bIsDigit = bCode >= 48 && bCode <= 57;
    if (aIsDigit && bIsDigit) {
      // Leading zeros do not change a number's value, so skip them before
      // comparing: a longer run of significant digits is the larger number.
      while (i < aLength && a.charCodeAt(i) === 48) i += 1;
      while (j < bLength && b.charCodeAt(j) === 48) j += 1;
      let aEnd = i;
      while (aEnd < aLength) { const code = a.charCodeAt(aEnd); if (code < 48 || code > 57) break; aEnd += 1; }
      let bEnd = j;
      while (bEnd < bLength) { const code = b.charCodeAt(bEnd); if (code < 48 || code > 57) break; bEnd += 1; }
      const aDigits = aEnd - i;
      const bDigits = bEnd - j;
      if (aDigits !== bDigits) return aDigits < bDigits ? -1 : 1;
      while (i < aEnd) {
        const aDigit = a.charCodeAt(i);
        const bDigit = b.charCodeAt(j);
        if (aDigit !== bDigit) return aDigit < bDigit ? -1 : 1;
        i += 1;
        j += 1;
      }
      continue;
    }
    if (aCode !== bCode) return aCode < bCode ? -1 : 1;
    i += 1;
    j += 1;
  }
  if (i < aLength) return 1;
  if (j < bLength) return -1;
  return 0;
}

function compareEntityIds(a, b) {
  return compareNaturalIds(a?.id, b?.id);
}

// Plain lexical ordering, for the tie-breaks that used String.localeCompare
// without { numeric: true }. Those sites only need a stable total order, and
// for the ASCII ids the simulation produces this is the same order ICU gives —
// without constructing a collator on every comparison.
function compareIdStrings(left, right) {
  const a = typeof left === "string" ? left : String(left ?? "");
  const b = typeof right === "string" ? right : String(right ?? "");
  if (a === b) return 0;
  return a < b ? -1 : 1;
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

// Angles are radians, so two decimals is 0.573 degrees of quantization -- a
// tenth of a fast hull's per-tick step, and the client interpolates between two
// already-quantized samples without smoothing it away. Three decimals costs a
// few bytes per ship and puts the error below anything visible.
function roundAngle(value) {
  return Math.round(value * 1000) / 1000;
}

// Math.hypot is robust but slow for 2-D work; callers pass finite deltas well
// inside the double range, so sqrt(x*x + y*y) is equivalent and much cheaper.
function fastHypot(dx, dy) { return Math.sqrt(dx * dx + dy * dy); }

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
  compareNaturalIds,
  compareEntityIds,
  compareIdStrings,
  seededRandom,
  angleDifference,
  rotateToward,
  round,
  roundAngle,
  fastHypot,
  performanceNow,
  getLocalUrls
};
