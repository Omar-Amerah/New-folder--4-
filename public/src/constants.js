// Owns static read-only configurations, local storage keys, and constant definitions for the client.

export const LOCAL_DESIGN_KEY = "modular-fleet-design-v2";
export const LOCAL_NAME_KEY = "modular-fleet-name-v1";
export const LOCAL_TEAM_KEY = "modular-fleet-team-v1";
export const LOCAL_FORMATION_KEY = "modular-fleet-formation-v1";
export const LOCAL_SERVER_KEY = "modular-fleet-server-url-v1";
export const LOCAL_SAVED_DESIGNS_KEY = "modular-fleet-saved-designs-v1";
export const LOCAL_LOADOUTS_KEY = "modular-fleet-loadouts-v1";
export const LOCAL_ACTIVE_ROOM_KEY = "modular-fleet-active-room-v1";

// Frontend build identification. The deploy pipeline (netlify-build.js) emits
// /build-sha.js which sets globalThis.__MFA_BUILD_SHA__ before the app loads;
// local dev without a build reports "dev". Compared against the backend's
// serverBuildSha to diagnose frontend/backend deploy skew.
export const FRONTEND_BUILD = (typeof globalThis !== "undefined" && globalThis.__MFA_BUILD_SHA__) || "dev";
if (typeof globalThis !== "undefined") globalThis.__mfaFrontendBuild = FRONTEND_BUILD;

export const WORLD_FALLBACK = { width: 3200, height: 1900 };
export const PURCHASE_PENDING_MS = 2500;
export const PART_CATEGORIES = ["Structure", "Power", "Engines", "Defence", "Weapons", "Support", "Utility"];

export const HIDDEN_PARTS = new Set([
  "lightFrame",
  "heavyFrame",
  "bulkhead",
  "lightMount",
  "heavyMount",
  "smallReactor",
  "heavyReactor",
  "microThruster",
  "heavyEngine",
  "lightShield",
  "heavyShield",
  "regenShield",
  "lightBlaster",
  "heavyBlaster",
  "lightMissile",
  "lightRailgun",
  "heavyRailgun"
]);

export const SHIP_ECONOMY = Object.freeze({
  baseShipCost: 48,
  partCostMultiplier: 1.32,
  massCostMultiplier: 0.9,
  hullCostMultiplier: 0.012,
  shieldCostMultiplier: 0.05,
  repairCostMultiplier: 0.8,
  largeShipThreshold: 400,
  largeShipCostTax: 0.15,
  hugeShipThreshold: 700,
  hugeShipCostTax: 0.25,
  weaponPremiums: Object.freeze({
    blaster: 18,
    missile: 32,
    railgun: 48,
    beam: 42
  })
});

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
