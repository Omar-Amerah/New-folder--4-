// Owns global game constants, default rules, board layouts, and network/tick configurations.

const path = require("path");
const { COMPONENT_BALANCE_PATH, BALANCE } = require("./balanceConfig");

const PORT = Number(process.env.PORT || 5544);
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

const WORLD = { width: 5120, height: 3040 };

const WORLD_SIZES = Object.freeze([
  { maxPlayers: 0, width: 3200, height: 2000, label: "Testing" },
  { maxPlayers: 2, width: 4160, height: 2560, label: "Duel" },
  { maxPlayers: 4, width: 5120, height: 3040, label: "Skirmish" },
  { maxPlayers: 8, width: 6560, height: 3840, label: "Battle" },
  { maxPlayers: Infinity, width: 8000, height: 4640, label: "Grand battle" }
]);

const TICK_HZ = 30;
// Snapshots are per-client deltas against acknowledged baselines. They run on
// their own timer, so halving the rate halves each payload and reduces
// encoding/IO cost while the simulation continues at full tick rate.
const SNAPSHOT_HZ = 20;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PLAYERS_PER_ROOM = 8;
const ROOM_IDLE_MS = 15 * 60 * 1000;
const CLOSED_ROOM_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const ECONOMY = Object.freeze({ ...BALANCE.economy, ...BALANCE.shipPricing, weaponPremiums: Object.freeze({ ...BALANCE.shipPricing.weaponPremiums }) });

const REWARDS = Object.freeze({ ...BALANCE.rewards });
const INFRASTRUCTURE = Object.freeze({
  homeStation: Object.freeze({ ...BALANCE.infrastructure?.homeStation }),
  relayStation: Object.freeze({ ...BALANCE.infrastructure?.relayStation })
});

// Asteroid count multipliers relative to the original generation amount, which
// is now the "high" setting. "medium" is the default; "none" disables asteroids.
const ASTEROID_DENSITY = Object.freeze({
  none: 0,
  low: 0.35,
  medium: 0.62,
  high: 1,
  veryHigh: 1.5
});

// Skirmish is the size every generation budget was originally tuned against, so
// asteroid/cloud counts scale against its area instead of being flat constants.
const MAP_REFERENCE_AREA = 5120 * 3040;

// Single source of truth for map geometry buffers. The generator (rooms.js), the
// schema guard (mapValidation.js) and the spawn planner (spawnPlanner.js) all read
// these, so a change can never leave generation and validation disagreeing.
// All values are edge-to-edge gaps in world units, on top of both circles' radii.
const MAP_CLEARANCES = Object.freeze({
  edgeInset: 80,
  relayToSafeZone: 500,
  relayToRelay: 800,
  asteroidToSafeZone: 425,
  asteroidToRelayMin: 200,
  asteroidToRelayMax: 500,
  asteroidToAsteroid: 225,
  // Deliberately looser than asteroidToSafeZone: this one guards a *re-planned*
  // spawn slot against terrain that generation already kept 425 clear of, so it
  // always passes on a freshly generated map and only relaxes edge cases when a
  // roster change forces a re-plan against existing rocks.
  asteroidToSpawnSlot: 220
});

// relayToRelay is the one buffer that cannot be world-independent: 800u between
// relays is unsatisfiable on the smallest arenas, which is why small maps used to
// silently end up with far fewer relays than requested.
function resolveMapClearances(world) {
  const width = Number.isFinite(world?.width) ? world.width : WORLD.width;
  return Object.freeze({
    ...MAP_CLEARANCES,
    relayToRelay: Math.min(MAP_CLEARANCES.relayToRelay, Math.round(width * 0.19))
  });
}

const DEFAULT_ROOM_RULES = Object.freeze({
  startingMoney: ECONOMY.startingMoney,
  maxPlayers: MAX_PLAYERS_PER_ROOM,
  mapSize: "auto",
  gameMode: "teams",
  asteroidDensity: "medium",
  infrastructureMode: "stations",
  visibilityMode: "sensors"
});


const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8"
};

const COLORS = [
  "#3fd6ff",
  "#ffcc4d",
  "#ff5f7e",
  "#7cff8a",
  "#b995ff",
  "#ff9a52",
  "#6ef0c2",
  "#f17cff",
  "#a8e05f",
  "#78a7ff",
  "#f06b4f",
  "#f2f7ff"
];

const TEAM_NAMES = Object.freeze({
  blue: "Blue wing",
  red: "Red wing"
});

const TEAM_COLORS = Object.freeze({
  blue: "#38d5ff",
  red: "#ff5f7e"
});

const BOT_NAMES = [
  "Vector",
  "Kepler",
  "Nova",
  "Ion",
  "Zenith",
  "Pulse",
  "Apex",
  "Quasar"
];

const MAP_NAMES = [
  "Broken Halo",
  "Lattice Drift",
  "Iron Nebula",
  "Cinder Reach",
  "Glass Belt",
  "Silent Wake"
];

const MAP_CLOUD_COLORS = [
  "56,213,255",
  "185,149,255",
  "124,255,160",
  "255,202,87",
  "255,95,126"
];

const DEFAULT_DESIGN = Object.freeze([
  { x: 7, y: 7, type: "core" },

  { x: 6, y: 5, type: "armor" },
  { x: 7, y: 5, type: "armor" },
  { x: 8, y: 5, type: "compositeArmor" },

  { x: 5, y: 6, type: "radiator" },
  { x: 6, y: 6, type: "reactor", rotation: 90 },
  { x: 7, y: 6, type: "shield" },
  { x: 8, y: 6, type: "missile", rotation: 0 },

  { x: 5, y: 7, type: "shield" },
  { x: 8, y: 7, type: "gyroscope" },
  { x: 9, y: 7, type: "frame" },

  { x: 6, y: 8, type: "auxGenerator" },
  { x: 7, y: 8, type: "frame" },

  { x: 7, y: 9, type: "engine" }
]);

const WiringRules = require("../../public/src/shared/wiringRules");
const { PARTS } = require("./components");

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

// Authoritative default Wiring v2 is generated once from DEFAULT_DESIGN using
// shared browser/Node wiring rules.  It physically connects all default Power
// sources and consumers. The standard ship has no Data-support source modules,
// so Data wiring remains empty.
const DEFAULT_WIRING = deepFreeze(WiringRules.createGeneratedPowerWiring(DEFAULT_DESIGN, PARTS));

module.exports = {
  PORT,
  PUBLIC_DIR,
  COMPONENT_BALANCE_PATH,
  WORLD,
  WORLD_SIZES,
  TICK_HZ,
  SNAPSHOT_HZ,
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS_PER_ROOM,
  ROOM_IDLE_MS,
  CLOSED_ROOM_CODE_TTL_MS,
  ECONOMY,
  DEFAULT_ROOM_RULES,
  INFRASTRUCTURE,
  ASTEROID_DENSITY,
  MAP_REFERENCE_AREA,
  MAP_CLEARANCES,
  resolveMapClearances,
  REWARDS,
  MIME,
  COLORS,
  TEAM_NAMES,
  TEAM_COLORS,
  BOT_NAMES,
  MAP_NAMES,
  MAP_CLOUD_COLORS,
  DEFAULT_DESIGN,
  DEFAULT_WIRING
};
