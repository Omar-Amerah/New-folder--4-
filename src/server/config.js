// Owns global game constants, default rules, board layouts, and network/tick configurations.

const path = require("path");

const PORT = Number(process.env.PORT || 5544);
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
const COMPONENT_BALANCE_PATH = path.join(__dirname, "..", "..", "component-balance.json");

const WORLD = { width: 5120, height: 3040 };

const WORLD_SIZES = Object.freeze([
  { maxPlayers: 0, width: 3200, height: 2000, label: "Testing" },
  { maxPlayers: 2, width: 4160, height: 2560, label: "Duel" },
  { maxPlayers: 4, width: 5120, height: 3040, label: "Skirmish" },
  { maxPlayers: 8, width: 6560, height: 3840, label: "Battle" },
  { maxPlayers: Infinity, width: 8000, height: 4640, label: "Grand battle" }
]);

const TICK_HZ = 30;
const SNAPSHOT_HZ = 15;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PLAYERS_PER_ROOM = 12;
const ROOM_IDLE_MS = 15 * 60 * 1000;
const CLOSED_ROOM_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const MATCH_SCORE = 900;
const SCORE_PER_CONTROLLED_POINT = 7;

const ECONOMY = Object.freeze({
  startingMoney: 700,
  maxMoney: 9999,
  baseIncome: 25,
  relayIncome: 10,
  killBountyRatio: 0.28,
  killBountyMin: 24,
  captureBonus: 70,
  shipCap: 30,
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

const DEFAULT_ROOM_RULES = Object.freeze({
  startingMoney: ECONOMY.startingMoney,
  maxPlayers: MAX_PLAYERS_PER_ROOM,
  mapSize: "auto",
  gameMode: "teams"
});

const REWARDS = Object.freeze({
  baseReward: 30,
  victoryBonus: 80,
  lossSupport: 35,
  minimumWinReward: 90,
  minimumLossReward: 35,
  destroyedEnemyCostMultiplier: 0.35,
  maxDestroyedReward: 250,
  lossDestroyedMultiplier: 0.18,
  survivalBonusPerShip: 15,
  efficiencyBonusScale: 45,
  maxEfficiencyBonus: 80,
  minimumOverpowerRewardMultiplier: 0.65
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
  { x: 7, y: 8, type: "frame" },
  { x: 6, y: 8, type: "engine" },
  { x: 8, y: 8, type: "engine" },
  { x: 6, y: 7, type: "blaster" },
  { x: 8, y: 7, type: "blaster" },
  { x: 7, y: 6, type: "shield" },
  { x: 6, y: 6, type: "armor" },
  { x: 8, y: 6, type: "armor" }
]);

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
  MATCH_SCORE,
  SCORE_PER_CONTROLLED_POINT,
  ECONOMY,
  DEFAULT_ROOM_RULES,
  REWARDS,
  MIME,
  COLORS,
  TEAM_NAMES,
  BOT_NAMES,
  MAP_NAMES,
  MAP_CLOUD_COLORS,
  DEFAULT_DESIGN
};
