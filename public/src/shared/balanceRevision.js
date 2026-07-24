// Authoritative gameplay-balance revision shared by server and client.
//
// The server advertises the revision of the balance it is simulating with; the
// client compares it against the revision of the balance it was built with. A
// mismatch means the frontend and backend were deployed from different balance
// data and combat must not proceed until the outdated side is refreshed or
// redeployed. The same deterministic hash runs in Node and the browser, so equal
// balance content always yields an equal revision.
//
// UMD: CommonJS for the server (require) and a global (BalanceRevision) for the
// browser, mirroring the other shared rule modules. Dependency-free.

(function initBalanceRevision(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BalanceRevision = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeBalanceRevision() {
  "use strict";

  // Deterministic canonical JSON: object keys are sorted recursively so key
  // ordering never affects the hash, while any value change does.
  function canonicalJSON(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  // FNV-1a 32-bit hash rendered as 8 hex chars. Stable across Node and browsers.
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  // Only gameplay-affecting sections drive the revision — cosmetic notes or
  // metadata must not force a spurious incompatibility. Missing sections are
  // serialized as null so absence still contributes deterministically.
  const REVISION_SECTIONS = [
    "components", "shipPricing", "economy", "rewards", "match", "movement",
    "projectiles", "missileGuidance", "fleetLimits", "capture", "repair", "drones",
    "wiringInfrastructure", "powerDemand", "powerProtection"
  ];

  function computeBalanceRevision(balance) {
    if (!balance || typeof balance !== "object") return null;
    const subset = {};
    for (const key of REVISION_SECTIONS) subset[key] = balance[key] === undefined ? null : balance[key];
    return hash32(canonicalJSON(subset));
  }

  // Structural validation used before applying a fetched balance. It never
  // zero-fills: it reports why the payload is unusable so the caller can keep the
  // last known good balance instead of silently degrading.
  function validateBalancePayload(balance) {
    const errors = [];
    if (!balance || typeof balance !== "object" || Array.isArray(balance)) {
      return { ok: false, errors: ["Balance payload must be a JSON object."] };
    }
    if (!Array.isArray(balance.components) || balance.components.length === 0) {
      errors.push("Balance payload is missing a non-empty components array.");
    } else {
      balance.components.forEach((component, i) => {
        if (!component || typeof component !== "object" || Array.isArray(component)) {
          errors.push(`components[${i}] must be an object.`);
        } else if (typeof component.id !== "string" || !component.id) {
          errors.push(`components[${i}].id must be a non-empty string.`);
        }
      });
    }
    for (const key of ["shipPricing", "economy", "match"]) {
      if (balance[key] === undefined) errors.push(`Balance payload is missing required section '${key}'.`);
    }
    return { ok: errors.length === 0, errors };
  }

  // Compare the client's balance revision against the server's advertised one.
  // "unknown" is returned when either side has not provided a revision (older
  // build) — the caller decides how strict to be, but it is never treated as a
  // confirmed match.
  function evaluateBalanceCompatibility(clientRevision, serverRevision) {
    if (!clientRevision || !serverRevision) return "unknown";
    return clientRevision === serverRevision ? "ok" : "mismatch";
  }

  return { computeBalanceRevision, validateBalancePayload, evaluateBalanceCompatibility, canonicalJSON, hash32 };
}));
