"use strict";

// Phase 6F profiling benchmark. The production profile remains legacy by
// default; Stage B also runs a deterministic opt-in station-weapon comparison
// and rejects any authoritative divergence.

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { performance } = require("perf_hooks");

const { createRoom, sanitizeRoomRules } = require("./src/server/rooms");
const {
  createStationsForRoom,
  updateStations
} = require("./src/server/stations");
const { updateStationWeapons } = require("./src/server/stationCombat");
const { updateBullets } = require("./src/server/projectiles");
const { updateCapturePoints, updateControlVictory } = require("./src/server/objectives");
const { computeStats } = require("./src/server/shipStats");
const { createImmutableShipTemplate } = require("./src/server/shipTemplates");
const { resetRoomTelemetry, getRoomTelemetry } = require("./src/server/roomTelemetry");
const { ensureTeamVisibility, invalidateVisibility } = require("./src/server/visibility");
const flags = require("./src/server/performanceFlags");

const args = new Set(process.argv.slice(2));
if (args.has("--quick") && args.has("--full")) throw new Error("Choose either --quick or --full");
const MODE = args.has("--full") ? "full" : "quick";
const WARMUP_SAMPLES = 5;
const MEASURED_SAMPLES = MODE === "full" ? 30 : 8;
const REPEATS = MODE === "full" ? 3 : 1;
const DT = 1 / 30;
const OUTPUT_PATH = path.join(__dirname, "test-artifacts", "performance", "profile-phase-6f.json");

const WEAPON_SCENARIOS = [
  { name: "two idle home stations", subsystem: "stationWeapons", ships: 0, relays: 0, density: "idle", variant: "idle" },
  { name: "two homes and three relays, 50 ships", subsystem: "stationWeapons", ships: 50, relays: 3, density: "light", variant: "mixed" },
  { name: "medium battle, 150 ships", subsystem: "stationWeapons", ships: 150, relays: 3, density: "medium", variant: "mixed" },
  { name: "large battle, 300 ships", subsystem: "stationWeapons", ships: 300, relays: 3, density: "large", variant: "mixed" },
  { name: "stable retained targets", subsystem: "stationWeapons", ships: 150, relays: 3, density: "stable", variant: "stable" },
  { name: "high target churn", subsystem: "stationWeapons", ships: 150, relays: 3, density: "churn", variant: "churn" },
  { name: "mostly destroyed station weapons", subsystem: "stationWeapons", ships: 150, relays: 3, density: "destroyed", variant: "destroyed" },
  { name: "ordinary anti-ship weapons only", subsystem: "stationWeapons", ships: 150, relays: 3, density: "ordinary", variant: "ordinary" },
  { name: "point-defence missile storm", subsystem: "stationWeapons", ships: 150, relays: 3, density: "missile-storm", variant: "missile-storm" },
  { name: "point-defence drone storm", subsystem: "stationWeapons", ships: 150, relays: 3, density: "drone-storm", variant: "drone-storm" },
  { name: "mixed ordinary and point defence weapons", subsystem: "stationWeapons", ships: 150, relays: 3, density: "mixed", variant: "mixed" },
  { name: "sensors and fog enabled", subsystem: "stationWeapons", ships: 150, relays: 3, density: "sensor-fog", variant: "sensor-fog", visibilityMode: "sensors" },
  { name: "targets entering and leaving safe zones", subsystem: "stationWeapons", ships: 150, relays: 3, density: "safe-zone-churn", variant: "safe-zone-churn" },
  { name: "no spatial index diagnostic fixture", subsystem: "stationWeapons", ships: 150, relays: 3, density: "no-index", variant: "no-index", noSpatialIndex: true }
];

const CAPTURE_SCENARIOS = [
  { name: "one relay, no ships nearby", subsystem: "capture", ships: 0, relays: 1, density: "empty", variant: "empty" },
  { name: "three relays, no ships nearby", subsystem: "capture", ships: 0, relays: 3, density: "empty", variant: "empty" },
  { name: "three relays with 150 distant ships", subsystem: "capture", ships: 150, relays: 3, density: "distant", variant: "distant" },
  { name: "three relays with dense nearby formations", subsystem: "capture", ships: 150, relays: 3, density: "dense", variant: "dense" },
  { name: "eight-relay stress fixture", subsystem: "capture", ships: 150, relays: 8, density: "dense", variant: "dense" },
  { name: "single-team capture", subsystem: "capture", ships: 50, relays: 1, density: "single-team", variant: "single-team" },
  { name: "exact contested tie", subsystem: "capture", ships: 50, relays: 1, density: "tie", variant: "tie" },
  { name: "leader changes every tick", subsystem: "capture", ships: 50, relays: 1, density: "leader-churn", variant: "leader-churn" },
  { name: "neutral relay capture", subsystem: "capture", ships: 50, relays: 1, density: "neutral", variant: "neutral" },
  { name: "disabled enemy relay capture", subsystem: "capture", ships: 50, relays: 1, density: "disabled", variant: "disabled" },
  { name: "friendly recapture cancellation", subsystem: "capture", ships: 50, relays: 1, density: "friendly-cancel", variant: "friendly-cancel" },
  { name: "capture decay", subsystem: "capture", ships: 0, relays: 1, density: "decay", variant: "decay" },
  { name: "relay ownership transition", subsystem: "capture", ships: 50, relays: 1, density: "ownership", variant: "ownership", event: "relay-ownership-transition" },
  { name: "full-control countdown stable", subsystem: "capture", ships: 0, relays: 3, density: "victory", variant: "victory", event: "victory-countdown-start" },
  { name: "full-control countdown repeatedly interrupted", subsystem: "capture", ships: 0, relays: 3, density: "victory-interrupted", variant: "victory-interrupted", event: "victory-countdown-interruption" },
  { name: "classic capture reference", subsystem: "classicCapture", ships: 50, relays: 1, density: "classic", variant: "classic", infrastructureMode: "classic" }
];

const HANGAR_SCENARIOS = [
  { name: "empty queues and no active launches", subsystem: "hangar", ships: 0, relays: 3, density: "empty", variant: "empty" },
  { name: "one queued ship", subsystem: "hangar", ships: 0, relays: 3, density: "one-queue", variant: "one-queue", queueQuantity: 1, event: "ship-spawn" },
  { name: "ten queued ships", subsystem: "hangar", ships: 0, relays: 3, density: "ten-queue", variant: "ten-queue", queueQuantity: 10, event: "ship-spawn-burst" },
  { name: "large burst queue", subsystem: "hangar", ships: 0, relays: 3, density: "burst-queue", variant: "burst-queue", queueQuantity: 10, event: "large-spawn-burst" },
  { name: "fleet-cap blocked queue", subsystem: "hangar", ships: 0, relays: 3, density: "fleet-cap", variant: "fleet-cap", event: "fleet-cap-block" },
  { name: "missing or disconnected player", subsystem: "hangar", ships: 0, relays: 3, density: "missing-player", variant: "missing-player", event: "missing-player-block" },
  { name: "disabled home station", subsystem: "hangar", ships: 0, relays: 3, density: "disabled-home", variant: "disabled-home", event: "disabled-home-block" },
  { name: "one active launch", subsystem: "hangar", ships: 0, relays: 3, density: "active-launch", variant: "active-launch", queueQuantity: 1, event: "active-launch" },
  { name: "several simultaneous launches", subsystem: "hangar", ships: 0, relays: 3, density: "simultaneous", variant: "simultaneous", queueQuantity: 3, event: "simultaneous-launches" },
  { name: "three occupied bays", subsystem: "hangar", ships: 0, relays: 3, density: "occupied-bays", variant: "occupied-bays", queueQuantity: 3, event: "occupied-bays" },
  { name: "ship destroyed while launching", subsystem: "hangar", ships: 0, relays: 3, density: "destroyed-launch", variant: "destroyed-launch", queueQuantity: 1, event: "launch-destruction" },
  { name: "launch completion and rally assignment", subsystem: "hangar", ships: 0, relays: 3, density: "release", variant: "release", queueQuantity: 1, event: "launch-release" },
  { name: "small ship template", subsystem: "hangar", ships: 0, relays: 3, density: "small-template", variant: "small-template", queueQuantity: 1, event: "small-template-spawn" },
  { name: "large ship template", subsystem: "hangar", ships: 0, relays: 3, density: "large-template", variant: "large-template", queueQuantity: 1, event: "large-template-spawn" },
  { name: "repeated queue and spawn lifecycle churn", subsystem: "hangar", ships: 0, relays: 3, density: "churn", variant: "churn", queueQuantity: 1, event: "queue-spawn-churn" }
];

const ALL_SCENARIOS = [...WEAPON_SCENARIOS, ...CAPTURE_SCENARIOS, ...HANGAR_SCENARIOS];
const QUICK_SCENARIO_NAMES = new Set([
  "two idle home stations",
  "medium battle, 150 ships",
  "point-defence missile storm",
  "three relays with dense nearby formations",
  "exact contested tie",
  "classic capture reference",
  "empty queues and no active launches",
  "one queued ship",
  "launch completion and rally assignment"
]);

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function summary(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return {
    samples: clean.length,
    p50: percentile(clean, 0.5),
    p95: percentile(clean, 0.95),
    mean: clean.reduce((sum, value) => sum + value, 0) / Math.max(1, clean.length),
    max: clean.length ? Math.max(...clean) : 0
  };
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function checksumValue(value) {
  let hash = 2166136261 >>> 0;
  const text = JSON.stringify(value);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function deterministicRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function withDeterministicRandom(seed, callback) {
  const previous = Math.random;
  Math.random = deterministicRandom(seed);
  try {
    return callback();
  } finally {
    Math.random = previous;
  }
}

function roomMemory() {
  if (typeof global.gc === "function") global.gc();
  return process.memoryUsage().heapUsed;
}

function quietCreateRoom(code, seed) {
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    return createRoom(code, { seed });
  } finally {
    console.warn = previousWarn;
  }
}

function makePlayer(id, team) {
  return {
    id,
    name: id,
    team,
    ready: true,
    removed: false,
    connected: true,
    money: 1_000_000,
    maxMoney: 1_000_000,
    income: 0,
    earned: 0,
    captures: 0,
    spent: 0,
    deployedFleetCost: 0,
    shipCap: 1000,
    ships: [],
    rallyPoint: { x: 5000, y: 5000 },
    design: [{ x: 7, y: 7, type: "core", rotation: 0 }, { x: 7, y: 6, type: "engine", rotation: 0 }],
    wiring: null,
    combatStyle: "hold",
    purchaseRequests: new Map()
  };
}

function addShip(room, id, ownerId, x, y) {
  const player = room.players.get(ownerId);
  const ship = {
    id,
    type: "ship",
    entityType: "ship",
    ownerId,
    team: player?.team || null,
    alive: true,
    removed: false,
    x,
    y,
    vx: 0,
    vy: 0,
    angle: 0,
    radius: 24,
    physicalRadius: 24,
    hp: 100,
    maxHp: 100,
    shield: 0,
    maxShield: 0,
    design: [{ x: 7, y: 7, type: "core", rotation: 0 }],
    componentHp: [100],
    componentMaxHp: [100],
    componentCellIndex: new Map([[7 * 15 + 7, 0]]),
    componentAliveRevision: 1,
    coreDestroyed: false,
    componentPower: { byComponentIndex: [{ operationalMultiplier: 1, state: "powered" }] },
    stats: { repairRange: 0 },
    dirtyComponents: new Set(),
    dirtyHeat: new Set()
  };
  room.ships.set(id, ship);
  if (player) player.ships.push(ship);
  return ship;
}

function addProjectile(room, id, ownerId, x, y, index) {
  const bullet = {
    id,
    type: "missile",
    subtype: "missile",
    interceptable: true,
    ownerId,
    targetId: null,
    x,
    y,
    previousX: x,
    previousY: y,
    vx: index % 2 ? -80 : 80,
    vy: index % 3 ? 20 : -20,
    hp: 30,
    damage: 20,
    shieldDamageMultiplier: 1,
    hullDamageMultiplier: 1,
    life: 12,
    bornAt: 0,
    age: 0,
    radius: 5
  };
  room.bullets.push(bullet);
  room.projectileById.set(id, bullet);
  return bullet;
}

function addDrone(room, id, ownerId, x, y) {
  const player = room.players.get(ownerId);
  const drone = {
    id,
    type: "drone",
    entityType: "drone",
    ownerId,
    teamId: player?.team || null,
    x,
    y,
    vx: 0,
    vy: 0,
    radius: 10,
    hull: 30,
    maxHull: 30,
    destroyed: false,
    removed: false
  };
  room.drones.set(id, drone);
  return drone;
}

function makeTemplate(size) {
  const design = [{ x: 7, y: 7, type: "core", rotation: 0 }];
  for (let i = 1; i < size; i += 1) design.push({ x: i % 15, y: Math.floor(i / 15), type: "frame", rotation: 0 });
  const stats = computeStats(design, null);
  return createImmutableShipTemplate(design, null, stats);
}

function buildFixture(config, repeatIndex) {
  const seed = 0x6f000000 + repeatIndex * 101 + config.name.length;
  const room = quietCreateRoom(`phase-6f-${repeatIndex}-${config.name}`, seed);
  const relays = Array.from({ length: config.relays || 0 }, (_, index) => ({
    id: String.fromCharCode(65 + index),
    x: 5000 + ((index % 4) - 1.5) * 600,
    y: 5000 + (Math.floor(index / 4) - 0.5) * 600,
    radius: 120
  }));
  room.world = { width: 10000, height: 10000 };
  room.map = {
    seed,
    asteroids: [],
    relays,
    safeZones: [
      { id: "blue-home", x: 900, y: 5000, radius: 180, team: "blue", ownerId: "p-blue" },
      { id: "red-home", x: 9100, y: 5000, radius: 180, team: "red", ownerId: "p-red" }
    ]
  };
  room.rules = sanitizeRoomRules({
    ...room.rules,
    gameMode: "teams",
    infrastructureMode: config.infrastructureMode || "stations",
    visibilityMode: config.visibilityMode || "full"
  }, 2);
  room.phase = "active";
  room.players = new Map([
    ["p-blue", makePlayer("p-blue", "blue")],
    ["p-red", makePlayer("p-red", "red")]
  ]);
  room.ships = new Map();
  room.drones = new Map();
  room.decoys = new Map();
  room.bullets = [];
  room.projectileById = new Map();
  room.effects = [];
  room.points = relays.map((relay) => ({ ...relay, ownerId: null, ownerTeam: null, progress: 0, contested: false }));
  room.spatialIndex = config.noSpatialIndex ? null : room.spatialIndex;

  if (config.infrastructureMode !== "classic") createStationsForRoom(room, 0);
  else room.stations = [];

  const homes = (room.stations || []).filter((station) => station.stationType === "home");
  const stationRelays = (room.stations || []).filter((station) => station.stationType === "relay");
  const targetShips = config.subsystem === "stationWeapons" ? config.ships : 0;
  const captureShips = config.subsystem === "capture" || config.subsystem === "classicCapture" ? config.ships : 0;
  const shipCount = Math.max(targetShips, captureShips);
  for (let index = 0; index < shipCount; index += 1) {
    const team = index % 2 === 0 ? "blue" : "red";
    const ownerId = team === "blue" ? "p-blue" : "p-red";
    let x;
    let y;
    if (config.subsystem === "capture" || config.subsystem === "classicCapture") {
      const relay = relays[index % Math.max(1, relays.length)] || { x: 5000, y: 5000 };
      if (config.variant === "distant") {
        x = team === "blue" ? 1200 + index * 3 : 8800 - index * 3;
        y = 1200 + (index % 20) * 20;
      } else if (config.variant === "tie") {
        x = relay.x + (team === "blue" ? -30 : 30);
        y = relay.y;
      } else if (["single-team", "neutral", "disabled", "friendly-cancel", "ownership"].includes(config.variant) && team === "red") {
        x = 8000 + index * 2;
        y = 1200 + (index % 20) * 20;
      } else {
        x = relay.x + ((index % 10) - 5) * 12;
        y = relay.y + (Math.floor(index / 10) - 3) * 12;
      }
    } else {
      const home = homes[index % Math.max(1, homes.length)] || { x: 5000, y: 5000 };
      const enemySide = team === "blue" ? homes.find((station) => station.team === "red") : homes.find((station) => station.team === "blue");
      const anchor = enemySide || home;
      const angle = (index % 30) * (Math.PI * 2 / 30);
      const distance = config.variant === "idle" ? 3000 : 720 + (index % 7) * 18;
      x = anchor.x + Math.cos(angle) * distance;
      y = anchor.y + Math.sin(angle) * distance;
    }
    addShip(room, `ship-${index}`, ownerId, x, y);
  }

  if (config.variant === "missile-storm") {
    for (let index = 0; index < 80; index += 1) addProjectile(room, `incoming-${index}`, "p-red", 1400 + index * 12, 5000 + (index % 9) * 20, index);
  }
  if (config.variant === "drone-storm") {
    for (let index = 0; index < 80; index += 1) addDrone(room, `drone-${index}`, "p-red", 1400 + index * 12, 5000 + (index % 9) * 20);
  }

  if (config.variant === "destroyed" || config.variant === "ordinary") {
    for (const station of homes) {
      for (let index = 0; index < station.design.length; index += 1) {
        const type = station.design[index]?.type;
        if (config.variant === "destroyed" && index % 2 === 0) station.componentHp[index] = 0;
        if (config.variant === "ordinary" && type === "pointDefense") station.componentHp[index] = 0;
      }
    }
  }

  if (config.subsystem === "capture") configureCaptureFixture(room, config, stationRelays);
  if (config.subsystem === "classicCapture") configureClassicFixture(room, config);
  if (config.subsystem === "hangar") configureHangarFixture(room, config, homes[0]);

  room.controlVictory = {
    team: null,
    playerId: null,
    startedAt: null,
    remaining: null,
    requiredSeconds: 20
  };
  return { room, homes, relays: stationRelays, buildFixture: { ships: shipCount, stations: (room.stations || []).length, relays: stationRelays.length, density: config.density } };
}

function configureCaptureFixture(room, config, relays) {
  if (config.variant === "disabled" || config.variant === "friendly-cancel" || config.variant === "ownership") {
    const relay = relays[0];
    if (relay) {
      relay.state = "disabled";
      relay.alive = true;
      relay.team = config.variant === "friendly-cancel" ? "blue" : "red";
      relay.ownerId = config.variant === "friendly-cancel" ? "p-blue" : "p-red";
      relay.captureProgress = config.variant === "ownership" ? 0.999 : 0;
    }
  }
  if (config.variant === "decay" && relays[0]) {
    relays[0].captureProgress = 0.7;
    relays[0].captureTeam = "blue";
  }
  if (config.variant === "victory" || config.variant === "victory-interrupted") {
    for (const relay of relays) {
      relay.state = "operational";
      relay.alive = true;
      relay.team = "blue";
      relay.ownerId = "p-blue";
      relay.captureProgress = 0;
    }
  }
}

function configureClassicFixture(room, config) {
  room.rules.infrastructureMode = "classic";
  room.points = [{ id: "A", x: 5000, y: 5000, radius: 120, ownerId: null, ownerTeam: null, progress: 0, contested: false }];
  for (const ship of room.ships.values()) {
    ship.x = 5000 + (ship.team === "blue" ? -30 : 30);
    ship.y = 5000;
  }
}

function queueTemplate(config) {
  if (config.variant === "large-template") return makeTemplate(60);
  if (config.variant === "small-template") return makeTemplate(2);
  return makeTemplate(4);
}

function enqueueBenchmarkItem(room, home, config, playerId = "p-blue") {
  const template = queueTemplate(config);
  home.productionQueue.push({
    id: `benchmark-queue-${room.nextEntityId++}`,
    playerId,
    requestId: `benchmark-request-${room.nextEntityId}`,
    template,
    combatStyle: "hold",
    unitCost: template.stats.unitCost,
    quantityRemaining: config.queueQuantity || 1,
    buildStartedAt: 0,
    buildDurationSeconds: 1,
    state: "queued"
  });
  home.productionRevision += 1;
}

function configureHangarFixture(room, config, home) {
  const player = room.players.get("p-blue");
  if (!home) return;
  player.rallyPoint = { x: 5000, y: 5000 };
  if (config.variant === "fleet-cap") player.shipCap = 0;
  if (config.variant === "disabled-home") home.state = "disabled";
  if (config.variant === "missing-player") enqueueBenchmarkItem(room, home, config, "missing-player");
}

function prepareMeasuredFixture(room, config, homes) {
  const home = homes[0];
  if (!home) return;
  if (config.variant === "one-queue" || config.variant === "ten-queue" || config.variant === "burst-queue" || config.variant === "fleet-cap" || config.variant === "active-launch" || config.variant === "simultaneous" || config.variant === "occupied-bays" || config.variant === "destroyed-launch" || config.variant === "release" || config.variant === "small-template" || config.variant === "large-template") {
    enqueueBenchmarkItem(room, home, config);
  }
  if (config.variant === "churn" && config.subsystem === "hangar") enqueueBenchmarkItem(room, home, config);
}

function mutateBeforeFrame(room, config, frame) {
  if (config.variant === "churn" && config.subsystem === "stationWeapons") {
    for (const ship of room.ships.values()) {
      if (ship.team !== "red") continue;
      ship.x = frame % 2 ? 1050 : 900;
    }
  }
  if (config.variant === "safe-zone-churn") {
    for (const ship of room.ships.values()) ship.x = frame % 2 ? 900 : 1200;
  }
  if (config.variant === "leader-churn" && room.ships.size) {
    const first = room.ships.values().next().value;
    first.x = frame % 2 ? 4980 : 900;
  }
  if (config.variant === "victory-interrupted" && room.stations?.some((station) => station.stationType === "relay")) {
    const relay = room.stations?.find((station) => station.stationType === "relay");
    if (relay && frame % 2 === 1) relay.team = "red";
    else if (relay) relay.team = "blue";
  }
  if (config.variant === "destroyed-launch" && frame === 1) {
    for (const ship of room.ships.values()) if (ship.launchPhase) ship.alive = false;
  }
  if (config.variant === "release" && frame === 1) {
    for (const ship of room.ships.values()) {
      if (!ship.launchPhase) continue;
      const station = room.stationsById?.get(ship.launchPhase.stationId);
      if (station) {
        ship.x = station.x + Math.cos(station.angle) * (ship.launchPhase.releaseDistance + 2);
        ship.y = station.y + Math.sin(station.angle) * (ship.launchPhase.releaseDistance + 2);
      }
    }
  }
  if (config.variant === "churn" && config.subsystem === "hangar" && frame > 0) {
    const home = room.stations?.find((station) => station.stationType === "home");
    if (home && home.productionQueue.length === 0 && room.players.get("p-blue").ships.length < 100) enqueueBenchmarkItem(room, home, config);
  }
}

function outcomeChecksum(room) {
  return checksumValue({
    stations: (room.stations || []).map((station) => ({
      id: station.id,
      type: station.stationType,
      team: station.team,
      ownerId: station.ownerId,
      state: station.state,
      hp: round(station.hp, 6),
      captureProgress: round(station.captureProgress, 6),
      captureTeam: station.captureTeam || null,
      weaponAngles: station.weaponAngles?.map((value) => round(value, 6)),
      weaponCooldowns: station.weaponCooldowns?.map((value) => round(value, 6)),
      aimTargets: station.weaponAimTargetIds,
      fireTargets: station.weaponFireTargetIds,
      queue: station.productionQueue?.map((item) => [item.id, item.quantityRemaining, item.state]),
      launches: station.activeLaunches?.map((launch) => [launch.shipId, launch.releasedAt])
    })),
    ships: [...room.ships.values()].map((ship) => [ship.id, ship.alive, round(ship.x, 4), round(ship.y, 4), ship.launchPhase?.stationId || null]),
    bullets: (room.bullets || []).map((bullet) => [bullet.id, bullet.type, bullet.targetId, round(bullet.x, 4), round(bullet.y, 4), round(bullet.life, 4)]),
    controlVictory: room.controlVictory,
    winner: room.winner
  });
}

function runFrame(room, config, frame) {
  resetRoomTelemetry(room);
  if (config.visibilityMode === "sensors") {
    invalidateVisibility(room, `phase-6f-${frame}`);
    ensureTeamVisibility(room, "blue", frame * 33);
    ensureTeamVisibility(room, "red", frame * 33);
  }
  const tickStartedAt = performance.now();

  const weaponStartedAt = performance.now();
  const liveShips = room._liveShipScratch || (room._liveShipScratch = []);
  liveShips.length = 0;
  for (const ship of room.ships.values()) if (ship.alive) liveShips.push(ship);
  updateStationWeapons(room, room.stations || [], liveShips, DT, frame * 33);
  const stationWeaponWallMs = performance.now() - weaponStartedAt;

  const projectileStartedAt = performance.now();
  updateBullets(room, DT, frame * 33);
  const projectileWallMs = performance.now() - projectileStartedAt;

  const stationStartedAt = performance.now();
  updateStations(room, DT, frame * 33);
  const stationWallMs = performance.now() - stationStartedAt;

  const captureStartedAt = performance.now();
  updateCapturePoints(room, [...room.ships.values()], DT);
  const classicCaptureWallMs = performance.now() - captureStartedAt;

  const controlStartedAt = performance.now();
  updateControlVictory(room, frame * 33);
  const controlWallMs = performance.now() - controlStartedAt;
  const tickRuntimeMs = performance.now() - tickStartedAt;
  const telemetry = getRoomTelemetry(room);

  return {
    telemetry,
    timings: { stationWeaponWallMs, projectileWallMs, stationWallMs, classicCaptureWallMs, controlWallMs, tickRuntimeMs },
    checksum: outcomeChecksum(room)
  };
}

function summarizeFrames(frames, config, buildMs, memory, authoritativeOutcomeChecksums = frames.map((frame) => frame.checksum)) {
  const durationFields = [
    "stationRuntimeMs", "stationWeaponRuntimeMs", "stationObjectiveRuntimeMs", "stationHangarRuntimeMs",
    "stationRepairRuntimeMs", "stationRecoveryRuntimeMs", "stationControlVictoryMs", "classicCaptureRuntimeMs",
    "stationWeaponTargetPreparationMs", "stationWeaponProfileLookupMs", "stationWeaponValidationMs",
    "stationWeaponOrdinaryAcquisitionMs", "stationWeaponPointDefenceMs", "stationWeaponAimMs", "stationWeaponFireMs",
    "stationCaptureCandidateCollectionMs", "stationCaptureAggregationMs", "stationCaptureStateTransitionMs",
    "stationProductionQueueMs", "stationSpawnAttemptMs", "stationLaunchControlMs", "stationLaunchReleaseMs",
    "stationCorridorQueryMs"
  ];
  const counterFields = [
    "stationsWeaponProcessed", "stationWeaponComponentsVisited", "stationWeaponComponentsOperational", "stationWeaponOrdinaryMounts",
    "stationWeaponPointDefenceMounts", "stationWeaponTargetValidations", "stationWeaponTargetSearches", "stationWeaponFullTargetScans",
    "stationWeaponSpatialQueries", "stationWeaponCandidatesVisited", "stationWeaponRetainedTargets", "stationWeaponImmediateReacquisitions",
    "stationWeaponShotsCreated", "stationWeaponCooldownSkips", "stationWeaponArcRejects", "stationWeaponRangeRejects", "stationWeaponVisibilityRejects",
    "stationRelaysProcessed", "stationCaptureFullShipScans", "stationCaptureSpatialQueries", "stationCaptureCandidatesVisited",
    "stationCaptureEligibleShips", "stationCaptureTeamsPresent", "stationCaptureContestedTicks", "stationCaptureProgressChanges",
    "stationCapturesCompleted", "stationControlVictoryEvaluations", "stationControlVictoryCacheHits", "classicCapturePointsProcessed",
    "classicCaptureCandidatesVisited", "stationHomeStationsProcessed", "stationQueuesVisited", "stationQueueItemsVisited",
    "stationSpawnAttempts", "stationSpawnSuccesses", "stationSpawnFleetCapBlocks", "stationSpawnMissingPlayerBlocks",
    "stationSpawnMissingHangarBlocks", "stationActiveLaunchesVisited", "stationLaunchesReleased", "stationLaunchesRemovedMissingShip",
    "stationEmptyQueueSkips", "stationEmptyLaunchSkips"
  ];
  const timings = {};
  for (const field of durationFields) timings[field] = summary(frames.map((frame) => frame.telemetry[field]));
  for (const field of ["stationWeaponWallMs", "projectileWallMs", "stationWallMs", "classicCaptureWallMs", "controlWallMs", "tickRuntimeMs"]) {
    timings[field] = summary(frames.map((frame) => frame.timings[field]));
  }
  const counters = {};
  for (const field of counterFields) counters[field] = round(frames.reduce((sum, frame) => sum + (Number(frame.telemetry[field]) || 0), 0) / Math.max(1, frames.length), 4);
  const checksums = frames.map((frame) => frame.checksum);
  const event = config.event ? {
    label: config.event,
    firstMeasured: frames[0]?.timings || null,
    maximumTickRuntimeMs: Math.max(...frames.map((frame) => frame.timings.tickRuntimeMs)),
    p95TickRuntimeMs: summary(frames.map((frame) => frame.timings.tickRuntimeMs)).p95
  } : null;
  return {
    scenario: config.name,
    subsystem: config.subsystem,
    fixture: { ...config, event: undefined },
    buildMs,
    warmupSamples: WARMUP_SAMPLES,
    measuredSamples: frames.length,
    timings,
    counters,
    eventSpike: event,
    outcomeChecksums: checksums,
    authoritativeOutcomeChecksums,
    deterministicOutcomeChecksum: checksums.every((checksum) => checksum === checksums[0]) ? checksums[0] : null,
    memory
  };
}

function runScenario(config, repeatIndex, optimized = false) {
  const previousFlag = flags.OPTIMIZED_STATION_WEAPON_RUNTIME();
  flags.__setOPTIMIZED_STATION_WEAPON_RUNTIME(optimized);
  try {
    const memoryBefore = roomMemory();
    const buildStartedAt = performance.now();
    const fixture = buildFixture(config, repeatIndex);
    const buildMs = performance.now() - buildStartedAt;
    const room = fixture.room;
    const authoritativeChecksums = [];
    for (let frame = 0; frame < WARMUP_SAMPLES; frame += 1) {
      mutateBeforeFrame(room, config, frame);
      authoritativeChecksums.push(runFrame(room, config, frame).checksum);
    }
    prepareMeasuredFixture(room, config, fixture.homes);
    const measured = [];
    for (let frame = 0; frame < MEASURED_SAMPLES; frame += 1) {
      mutateBeforeFrame(room, config, frame);
      const result = runFrame(room, config, WARMUP_SAMPLES + frame);
      measured.push(result);
      authoritativeChecksums.push(result.checksum);
    }
    const memoryAfter = roomMemory();
    return summarizeFrames(measured, config, buildMs, {
      heapBeforeBytes: memoryBefore,
      heapAfterBytes: memoryAfter,
      heapDeltaBytes: memoryAfter - memoryBefore
    }, authoritativeChecksums);
  } finally {
    flags.__setOPTIMIZED_STATION_WEAPON_RUNTIME(previousFlag);
  }
}

function runScenarioComparison(config, repeatIndex) {
  const seed = 0x6f6f0000 + repeatIndex * 17 + config.name.length;
  const legacy = withDeterministicRandom(seed, () => runScenario(config, repeatIndex, false));
  const optimized = withDeterministicRandom(seed, () => runScenario(config, repeatIndex, true));
  const legacyChecksums = legacy.authoritativeOutcomeChecksums;
  const optimizedChecksums = optimized.authoritativeOutcomeChecksums;
  assert.equal(optimizedChecksums.length, legacyChecksums.length, `${config.name}: legacy/optimized tick counts differ`);
  let firstMismatchAt = null;
  for (let i = 0; i < legacyChecksums.length; i += 1) {
    if (legacyChecksums[i] !== optimizedChecksums[i]) {
      firstMismatchAt = i;
      break;
    }
  }
  assert.equal(firstMismatchAt, null, `${config.name}: legacy/optimized state diverged at authoritative tick ${firstMismatchAt}`);
  const legacyTick = legacy.timings.tickRuntimeMs;
  const optimizedTick = optimized.timings.tickRuntimeMs;
  const legacyStation = legacy.timings.stationWeaponRuntimeMs;
  const optimizedStation = optimized.timings.stationWeaponRuntimeMs;
  return {
    scenario: config.name,
    subsystem: config.subsystem,
    repeatIndex,
    authoritativeTicksCompared: legacyChecksums.length,
    checksumsEqualAfterEveryTick: true,
    legacy: {
      stationWeaponRuntimeMs: legacyStation,
      tickRuntimeMs: legacyTick,
      heapDeltaBytes: legacy.memory.heapDeltaBytes,
      eventSpike: legacy.eventSpike
    },
    optimized: {
      stationWeaponRuntimeMs: optimizedStation,
      tickRuntimeMs: optimizedTick,
      heapDeltaBytes: optimized.memory.heapDeltaBytes,
      eventSpike: optimized.eventSpike
    },
    delta: {
      stationWeaponP50Ms: round(optimizedStation.p50 - legacyStation.p50),
      stationWeaponP95Ms: round(optimizedStation.p95 - legacyStation.p95),
      tickP50Ms: round(optimizedTick.p50 - legacyTick.p50),
      tickP95Ms: round(optimizedTick.p95 - legacyTick.p95),
      heapDeltaBytes: optimized.memory.heapDeltaBytes - legacy.memory.heapDeltaBytes
    }
  };
}

function aggregate(results) {
  const fields = [
    "stationRuntimeMs", "stationWeaponRuntimeMs", "stationObjectiveRuntimeMs", "stationHangarRuntimeMs",
    "stationRepairRuntimeMs", "stationRecoveryRuntimeMs", "stationControlVictoryMs", "classicCaptureRuntimeMs"
  ];
  const allFrames = Object.fromEntries(fields.map((field) => [field, []]));
  const tickValues = [];
  for (const result of results) {
    for (const field of fields) allFrames[field].push(...Array(result.measuredSamples).fill(result.timings[field].p50));
    tickValues.push(result.timings.tickRuntimeMs.p50);
  }
  const tickMean = tickValues.reduce((sum, value) => sum + value, 0) / Math.max(1, tickValues.length);
  const subsystems = {};
  for (const field of fields) {
    const values = allFrames[field];
    subsystems[field] = {
      p50: summary(values).p50,
      p95: summary(values).p95,
      representativeTickSharePercent: tickMean > 0 ? round((summary(values).mean / tickMean) * 100, 2) : 0
    };
  }
  const eventSpikes = results.filter((result) => result.eventSpike).map((result) => ({
    scenario: result.scenario,
    ...result.eventSpike
  }));
  return { subsystems, eventSpikes, representativeTickP50Ms: round(tickMean, 4) };
}

function main() {
  const scenarios = MODE === "quick" ? ALL_SCENARIOS.filter((scenario) => QUICK_SCENARIO_NAMES.has(scenario.name)) : ALL_SCENARIOS;
  const runs = [];
  const optimizationRuns = [];
  const previousLog = console.log;
  const previousWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    for (const config of scenarios) {
      for (let repeat = 0; repeat < REPEATS; repeat += 1) {
        runs.push(withDeterministicRandom(0x6f6f0000 + repeat * 17 + config.name.length, () => runScenario(config, repeat)));
        optimizationRuns.push(runScenarioComparison(config, repeat));
      }
    }
  } finally {
    console.log = previousLog;
    console.warn = previousWarn;
  }

  const byScenario = new Map();
  for (const run of runs) {
    const entries = byScenario.get(run.scenario) || [];
    entries.push(run);
    byScenario.set(run.scenario, entries);
  }
  const scenarioResults = [...byScenario.entries()].map(([scenario, entries]) => {
    const first = entries[0];
    return {
      ...first,
      repeats: entries.length,
      repeatMemory: entries.map((entry) => entry.memory),
      repeatChecksums: entries.map((entry) => entry.deterministicOutcomeChecksum),
      deterministicAcrossRepeats: entries.every((entry) => entry.deterministicOutcomeChecksum === first.deterministicOutcomeChecksum)
    };
  });
  const allChecksums = scenarioResults.map((result) => [result.scenario, result.repeatChecksums]);
  const artifact = {
    status: "passed",
    phase: "6F",
    mode: MODE,
    startingCommitSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: __dirname, encoding: "utf8" }).trim(),
    nodeVersion: process.version,
    warmUpCounts: { samplesPerScenario: WARMUP_SAMPLES },
    measuredSampleCounts: { samplesPerScenario: MEASURED_SAMPLES, repeats: REPEATS },
    fixtureSizeAndDensity: scenarios.map((scenario) => ({ name: scenario.name, subsystem: scenario.subsystem, ships: scenario.ships, stations: 2 + (scenario.relays || 0), relays: scenario.relays || 0, density: scenario.density })),
    independentSubsystems: aggregate(scenarioResults),
    scenarios: scenarioResults,
    optimizationEvidence: {
      flag: "OPTIMIZED_STATION_WEAPON_RUNTIME",
      productionDefault: false,
      comparedScenarios: optimizationRuns.length,
      checksumsEqualAfterEveryTick: optimizationRuns.every((entry) => entry.checksumsEqualAfterEveryTick),
      authoritativeTicksCompared: optimizationRuns.reduce((sum, entry) => sum + entry.authoritativeTicksCompared, 0),
      runs: optimizationRuns
    },
    deterministicOutcomeChecksums: allChecksums,
    memoryGrowth: scenarioResults.map((result) => ({ scenario: result.scenario, heapDeltaBytes: result.memory.heapDeltaBytes, repeatDeltas: result.repeatMemory.map((memory) => memory.heapDeltaBytes) })),
    optimizationDecision: {
      rule: "Only optimize when representative tick share is at least 10 percent, p95 exceeds 1 ms, scaling is pathological, or an event spike threatens the tick budget.",
      benchmarkedFlags: ["OPTIMIZED_STATION_WEAPON_RUNTIME"],
      productionFlagsEnabled: [],
      candidate: "station weapon profile cache and authoritative live-target reuse",
      stage: "profiled-with-opt-in-parity"
    }
  };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(artifact, null, 2));
  previousLog(JSON.stringify({ status: artifact.status, mode: MODE, scenarios: scenarioResults.length, repeats: REPEATS, output: OUTPUT_PATH, representativeTickP50Ms: artifact.independentSubsystems.representativeTickP50Ms }, null, 2));
}

if (require.main === module) main();

module.exports = {
  ALL_SCENARIOS,
  WEAPON_SCENARIOS,
  CAPTURE_SCENARIOS,
  HANGAR_SCENARIOS,
  buildFixture,
  prepareMeasuredFixture,
  mutateBeforeFrame,
  runFrame,
  outcomeChecksum,
  withDeterministicRandom
};
