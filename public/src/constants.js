// Owns static read-only configurations, local storage keys, and constant definitions for the client.

import { GENERATED_BALANCE } from "./generatedBalance.js";

// Blueprint storage uses a current schema containing modules and explicit
// logical Data Links only.
export const LOCAL_DESIGN_KEY = "modular-fleet-design-v3";
export const LOCAL_NAME_KEY = "modular-fleet-name-v1";
export const LOCAL_TEAM_KEY = "modular-fleet-team-v1";
export const LOCAL_SERVER_KEY = "modular-fleet-server-url-v1";
export const LOCAL_SAVED_DESIGNS_KEY = "modular-fleet-saved-designs-v2";
export const LOCAL_LOADOUTS_KEY = "modular-fleet-loadouts-v2";
export const LOCAL_ACTIVE_ROOM_KEY = "modular-fleet-active-room-v1";
export const LOCAL_DESIGN_BACKUP_KEY = "modular-fleet-design-last-good-v2";
// Preserves the exact original stored current-design value before it is migrated
// from a known older schema, so the pre-migration data stays recoverable.
export const LOCAL_DESIGN_PREMIGRATION_KEY = "modular-fleet-design-premigration";

// Frontend build identification. The deploy pipeline (netlify-build.js) emits
// /build-sha.js which sets globalThis.__MFA_BUILD_SHA__ before the app loads;
// local dev without a build reports "dev". Compared against the backend's
// serverBuildSha to diagnose frontend/backend deploy skew.
export const FRONTEND_BUILD = (typeof globalThis !== "undefined" && globalThis.__MFA_BUILD_SHA__) || "dev";
if (typeof globalThis !== "undefined") globalThis.__mfaFrontendBuild = FRONTEND_BUILD;

// Whether development/test-only global handles (arbitrary protocol send, state
// inspection, renderer failure injection) may be exposed. Enabled on local dev
// hosts (localhost / 127.0.0.1 / file), or explicitly via ?diagnostics=1 /
// ?debug=1 / window.__mfaEnableDiagnostics : automated browser tests run on
// 127.0.0.1 and so keep their handles. Normal production deploys do not expose
// these functions.
export const DIAGNOSTICS_ENABLED = (() => {
  if (typeof window === "undefined") return false;
  try {
    const host = (window.location && window.location.hostname) || "";
    const isLocal = host === "" || host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    const params = new URLSearchParams((window.location && window.location.search) || "");
    const explicit = params.get("diagnostics") === "1" || params.get("debug") === "1" || window.__mfaEnableDiagnostics === true;
    return isLocal || explicit;
  } catch {
    return false;
  }
})();

// Only used before the first authoritative hello/join payload arrives. All
// rendering and coordinate math continues to read state.world after that.
export const WORLD_FALLBACK = { width: 3200, height: 1900 };
export const PART_CATEGORIES = ["Structure", "Power", "Heat Components", "Engines", "Defence", "Weapons", "Support", "Command"];

export const HIDDEN_PARTS = new Set([
  "lightFrame",
  "heavyFrame",
  "bulkhead",
  "lightMount",
  "heavyMount",
  "smallReactor",
  "heavyReactor",
  "microThruster",
  "lightShield",
  "heavyShield",
  "regenShield",
  "lightBlaster",
  "heavyBlaster",
  "lightMissile",
  "lightRailgun",
  "heavyRailgun"
]);

export function syncUrlParams() {
  if (typeof window === "undefined" || typeof window.location === "undefined" || typeof localStorage === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const currentServer = localStorage.getItem(LOCAL_SERVER_KEY) || "";
  const currentRoom = localStorage.getItem(LOCAL_ACTIVE_ROOM_KEY) || "";

  let changed = false;
  if (currentServer) {
    if (params.get("server") !== currentServer) {
      params.set("server", currentServer);
      changed = true;
    }
  } else {
    if (params.has("server")) {
      params.delete("server");
      changed = true;
    }
  }

  if (currentRoom) {
    if (params.get("room") !== currentRoom) {
      params.set("room", currentRoom);
      changed = true;
    }
  } else {
    if (params.has("room")) {
      params.delete("room");
      changed = true;
    }
  }

  if (changed) {
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? "?" + newSearch : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);
  }
}
