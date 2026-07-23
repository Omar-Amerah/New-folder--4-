// Owns static read-only configurations, local storage keys, and constant definitions for the client.

import { GENERATED_BALANCE } from "./generatedBalance.js";

// Blueprint storage moved to new keys when wiring was added (schema v2).
// Old keys ("modular-fleet-design-v2", "...-saved-designs-v1", "...-loadouts-v1",
// "...-design-last-good-v1") are intentionally never read: users with old data
// simply start from the current default ship with its default wiring.
export const LOCAL_DESIGN_KEY = "modular-fleet-design-v3";
export const LOCAL_NAME_KEY = "modular-fleet-name-v1";
export const LOCAL_TEAM_KEY = "modular-fleet-team-v1";
export const LOCAL_FORMATION_KEY = "modular-fleet-formation-v1";
export const LOCAL_SERVER_KEY = "modular-fleet-server-url-v1";
export const LOCAL_SAVED_DESIGNS_KEY = "modular-fleet-saved-designs-v2";
export const LOCAL_LOADOUTS_KEY = "modular-fleet-loadouts-v2";
export const LOCAL_ACTIVE_ROOM_KEY = "modular-fleet-active-room-v1";
export const LOCAL_DESIGN_BACKUP_KEY = "modular-fleet-design-last-good-v2";

// Frontend build identification. The deploy pipeline (netlify-build.js) emits
// /build-sha.js which sets globalThis.__MFA_BUILD_SHA__ before the app loads;
// local dev without a build reports "dev". Compared against the backend's
// serverBuildSha to diagnose frontend/backend deploy skew.
export const FRONTEND_BUILD = (typeof globalThis !== "undefined" && globalThis.__MFA_BUILD_SHA__) || "dev";
if (typeof globalThis !== "undefined") globalThis.__mfaFrontendBuild = FRONTEND_BUILD;

export const WORLD_FALLBACK = { width: 3200, height: 1900 };
export const PART_CATEGORIES = ["Structure", "Power", "Engines", "Defence", "Weapons", "Support"];

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

export let SHIP_ECONOMY = Object.freeze({ ...GENERATED_BALANCE.shipPricing, weaponPremiums: Object.freeze({ ...GENERATED_BALANCE.shipPricing.weaponPremiums }) });
export function applyShipEconomy(economy) { SHIP_ECONOMY = Object.freeze({ ...economy, weaponPremiums: Object.freeze({ ...(economy?.weaponPremiums || {}) }) }); }

// Authoritative wiring infrastructure balance (Power cable tiers, Data cable,
// minimum Heat capacity). Loaded from the same balance file as the server so
// cable cost and Heat displacement match client preview and server totals.
export let WIRING_INFRASTRUCTURE = GENERATED_BALANCE.wiringInfrastructure;
export function applyWiringInfrastructure(infrastructure) {
  if (infrastructure && typeof infrastructure === "object" && !Array.isArray(infrastructure)) WIRING_INFRASTRUCTURE = infrastructure;
}

// Authoritative activity-driven Power demand balance (per-role standby
// fractions). Loaded from the same balance file as the server so Blueprint
// prediction demand matches runtime demand for the same activity.
export let POWER_DEMAND = GENERATED_BALANCE.powerDemand;
export function applyPowerDemand(powerDemand) {
  if (powerDemand && typeof powerDemand === "object" && !Array.isArray(powerDemand)) POWER_DEMAND = powerDemand;
}

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
