// Owns room creation, room lookup, lifecycle cleanup, map generation, and room code generation.

const crypto = require("crypto");
const {
  WORLD_SIZES,
  MAX_PLAYERS_PER_ROOM,
  DEFAULT_ROOM_RULES,
  MATCH_SCORE,
  ECONOMY,
  CLOSED_ROOM_CODE_TTL_MS,
  MAP_NAMES,
  MAP_CLOUD_COLORS
} = require("./config");
const {
  clampNumber,
  rngRange,
  seededRandom,
  hashString,
  round,
  performanceNow
} = require("./utils");
const { sanitizeRoomCode } = require("./validation");

const rooms = new Map();
const closedRoomCodes = new Map();

function createRoom(code) {
  const world = chooseWorldSize(1);
  const map = generateMap(code, world);
  return {
    code,
    adminId: null,
    phase: "lobby",
    world,
    mapSizeLabel: world.label,
    clients: new Set(),
    players: new Map(),
    bullets: [],
    effects: [],
    map,
    points: map.relays.map((relay) => ({ ...relay, ownerId: null, ownerTeam: null, progress: 0 })),
    kickedIds: new Set(),
    kickedNames: new Set(),
    nextEntityId: 1,
    nextBotId: 1,
    colorCursor: 0,
    lastEmptyAt: 0,
    lastScoreAt: performanceNow(),
    winner: null,
    winnerAt: 0,
    maxScore: MATCH_SCORE,
    rules: { ...DEFAULT_ROOM_RULES },
    playerColors: new Map()
  };
}

function setRoomRules(room, requester, updates) {
  const { isAdmin } = require("./players");
  if (!isAdmin(room, requester)) {
    const { sendPlayer } = require("./messages");
    sendPlayer(room, requester, { type: "error", message: "Only the room admin can change game rules" });
    return;
  }
  if (room.phase !== "lobby") {
    const { sendPlayer } = require("./messages");
    sendPlayer(room, requester, { type: "error", message: "Game rules are locked after ship design starts" });
    return;
  }

  room.rules = sanitizeRoomRules({ ...room.rules, ...updates }, room.players.size);
  applyGameModeTeams(room);
  const world = chooseRoomWorld(room);
  room.world = world;
  room.mapSizeLabel = world.label;
  room.map = generateMap(room.code, world);
  room.points = room.map.relays.map((relay) => ({ ...relay, ownerId: null, ownerTeam: null, progress: 0 }));

  for (const player of room.players.values()) {
    player.money = room.rules.startingMoney;
    player.bank = room.rules.startingMoney;
    player.earned = room.rules.startingMoney;
    player.maxMoney = Math.max(ECONOMY.maxMoney, room.rules.startingMoney);
  }

  const { broadcastSnapshot } = require("./messages");
  broadcastSnapshot(room, performanceNow());
}

function sanitizeRoomRules(input, playerCount = 1) {
  const currentPlayers = Math.max(1, Number(playerCount) || 1);
  const startingMoney = Math.round(clampNumber(input.startingMoney, 100, ECONOMY.maxMoney));
  const maxPlayers = Math.trunc(clampNumber(input.maxPlayers, Math.max(2, currentPlayers), MAX_PLAYERS_PER_ROOM));
  const mapSize = sanitizeMapSize(input.mapSize);
  const gameMode = sanitizeGameMode(input.gameMode);
  return { startingMoney, maxPlayers, mapSize, gameMode };
}

function sanitizeMapSize(value) {
  const text = String(value || "auto");
  if (text === "auto") return "auto";
  const match = WORLD_SIZES.find((size) => size.label === text);
  return match ? match.label : "auto";
}

function sanitizeGameMode(value) {
  const text = String(value || "").toLowerCase();
  return text === "solo" ? "solo" : "teams";
}

function applyGameModeTeams(room) {
  if (room.rules?.gameMode === "solo") {
    for (const player of room.players.values()) player.team = player.id;
    return;
  }

  const { balanceTeam } = require("./players");
  for (const player of room.players.values()) {
    if (player.team !== "blue" && player.team !== "red") {
      player.team = balanceTeam(room);
    }
  }
}

function generateMap(roomCode, world) {
  const seed = (crypto.randomBytes(4).readUInt32BE(0) ^ hashString(roomCode)) >>> 0;
  const rng = seededRandom(seed);
  const relays = generateRelays(rng, world);
  const asteroids = generateAsteroids(rng, world, relays);
  const clouds = generateClouds(rng, world);

  return {
    seed,
    name: MAP_NAMES[seed % MAP_NAMES.length],
    relays,
    asteroids,
    clouds
  };
}

function generateRelays(rng, world) {
  const relays = [];
  addMirroredRelayPair(rng, relays, {
    minX: world.width * 0.2,
    maxX: world.width * 0.38,
    minY: world.height * 0.25,
    maxY: world.height * 0.75
  }, world);

  if (rng() > 0.45) {
    addMirroredRelayPair(rng, relays, {
      minX: world.width * 0.25,
      maxX: world.width * 0.43,
      minY: world.height * 0.18,
      maxY: world.height * 0.82
    }, world);
  }

  relays.push({
    x: world.width * 0.5 + rngRange(rng, -130, 130),
    y: world.height * 0.5 + rngRange(rng, -120, 120),
    radius: rngRange(rng, 138, 166)
  });

  return relays
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((relay, index) => ({
      id: String.fromCharCode(65 + index),
      x: Math.round(relay.x),
      y: Math.round(relay.y),
      radius: Math.round(relay.radius)
    }));
}

function addMirroredRelayPair(rng, relays, bounds, world) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const radius = rngRange(rng, 125, 158);
    const relay = {
      x: rngRange(rng, bounds.minX, bounds.maxX),
      y: rngRange(rng, bounds.minY, bounds.maxY),
      radius
    };
    const mirror = {
      x: world.width - relay.x,
      y: world.height - relay.y,
      radius
    };
    if (circlesClear(relay, relays, 390) && circlesClear(mirror, relays, 390)) {
      relays.push(relay, mirror);
      return true;
    }
  }
  return false;
}

function generateAsteroids(rng, world, relays) {
  const asteroids = [];
  const reserved = mapSafetyZones(relays, world);
  const pairCount = 4 + Math.floor(rng() * 3);

  for (let pair = 0; pair < pairCount; pair += 1) {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const radius = rngRange(rng, 46, 105);
      const asteroid = {
        x: rngRange(rng, world.width * 0.18, world.width * 0.48),
        y: rngRange(rng, 170, world.height - 170),
        radius
      };
      const mirror = {
        x: world.width - asteroid.x,
        y: world.height - asteroid.y,
        radius
      };
      if (!canPlaceMapCircle(asteroid, reserved, asteroids, 34, world) || !canPlaceMapCircle(mirror, reserved, asteroids, 34, world)) {
        continue;
      }
      asteroids.push(
        makeAsteroid(rng, `R${asteroids.length + 1}`, asteroid),
        makeAsteroid(rng, `R${asteroids.length + 2}`, mirror)
      );
      break;
    }
  }

  if (rng() > 0.55) {
    for (let attempt = 0; attempt < 70; attempt += 1) {
      const radius = rngRange(rng, 54, 92);
      const asteroid = {
        x: world.width * 0.5 + rngRange(rng, -110, 110),
        y: rngRange(rng, world.height * 0.18, world.height * 0.38),
        radius
      };
      const mirror = {
        x: world.width - asteroid.x,
        y: world.height - asteroid.y,
        radius
      };
      if (!canPlaceMapCircle(asteroid, reserved, asteroids, 42, world) || !canPlaceMapCircle(mirror, reserved, asteroids, 42, world)) {
        continue;
      }
      asteroids.push(
        makeAsteroid(rng, `R${asteroids.length + 1}`, asteroid),
        makeAsteroid(rng, `R${asteroids.length + 2}`, mirror)
      );
      break;
    }
  }

  return asteroids;
}

function makeAsteroid(rng, id, asteroid) {
  const points = 12;
  const shape = [];
  const craters = [];

  for (let i = 0; i < points; i += 1) {
    shape.push(round(rngRange(rng, 0.82, 1.16)));
  }
  for (let i = 0; i < 4; i += 1) {
    craters.push({
      angle: round(rngRange(rng, 0, Math.PI * 2)),
      distance: round(rngRange(rng, 0.12, 0.58)),
      radius: round(rngRange(rng, 0.08, 0.18))
    });
  }

  return {
    id,
    x: Math.round(asteroid.x),
    y: Math.round(asteroid.y),
    radius: Math.round(asteroid.radius),
    rotation: round(rngRange(rng, 0, Math.PI * 2)),
    spin: round(rngRange(rng, -0.018, 0.018)),
    shade: rng() > 0.52 ? "cold" : "warm",
    shape,
    craters
  };
}

function generateClouds(rng, world) {
  const clouds = [];
  const count = 5 + Math.floor(rng() * 4);
  for (let i = 0; i < count; i += 1) {
    clouds.push({
      id: `N${i + 1}`,
      x: Math.round(rngRange(rng, 260, world.width - 260)),
      y: Math.round(rngRange(rng, 190, world.height - 190)),
      rx: Math.round(rngRange(rng, 250, 560)),
      ry: Math.round(rngRange(rng, 130, 310)),
      rotation: round(rngRange(rng, -0.7, 0.7)),
      color: MAP_CLOUD_COLORS[Math.floor(rng() * MAP_CLOUD_COLORS.length)],
      alpha: round(rngRange(rng, 0.08, 0.18))
    });
  }
  return clouds;
}

function mapSafetyZones(relays, world) {
  const zones = relays.map((relay) => ({ x: relay.x, y: relay.y, radius: relay.radius + 190 }));
  zones.push(
    { x: 260, y: world.height * 0.5, radius: 440 },
    { x: world.width - 260, y: world.height * 0.5, radius: 440 },
    { x: world.width * 0.5, y: 220, radius: 300 },
    { x: world.width * 0.5, y: world.height - 220, radius: 300 }
  );
  return zones;
}

function canPlaceMapCircle(circle, reserved, existing, buffer, world) {
  if (circle.x - circle.radius < 80 || circle.x + circle.radius > world.width - 80) return false;
  if (circle.y - circle.radius < 80 || circle.y + circle.radius > world.height - 80) return false;
  return circlesClear(circle, reserved, buffer) && circlesClear(circle, existing, buffer);
}

function circlesClear(circle, others, buffer) {
  for (const other of others) {
    const minimum = circle.radius + other.radius + buffer;
    if (Math.hypot(circle.x - other.x, circle.y - other.y) < minimum) return false;
  }
  return true;
}

function prepareArenaForCurrentPlayers(room) {
  const world = chooseRoomWorld(room);
  room.world = world;
  room.mapSizeLabel = world.label;
  room.map = generateMap(room.code, world);
  room.points = room.map.relays.map((relay) => ({ ...relay, ownerId: null, ownerTeam: null, progress: 0 }));
  room.bullets = [];
  room.effects = [];
  room.nextEntityId = 1;
}

function chooseWorldSize(playerCount) {
  const size = WORLD_SIZES.find((candidate) => playerCount <= candidate.maxPlayers) || WORLD_SIZES[WORLD_SIZES.length - 1];
  return { width: size.width, height: size.height, label: size.label };
}

function chooseRoomWorld(room) {
  const requested = room.rules?.mapSize;
  if (requested && requested !== "auto") {
    const fixed = WORLD_SIZES.find((candidate) => candidate.label === requested);
    if (fixed) return { width: fixed.width, height: fixed.height, label: fixed.label };
  }
  return chooseWorldSize(Math.max(1, room.players.size));
}

function makeRoomCode() {
  let code = "";
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  do {
    code = "";
    for (let i = 0; i < 5; i += 1) {
      code += alphabet[crypto.randomInt(0, alphabet.length)];
    }
  } while (rooms.has(code) || isClosedRoomCode(code));
  return code;
}

function rememberClosedRoom(code) {
  const clean = sanitizeRoomCode(code);
  if (!clean) return;
  closedRoomCodes.set(clean, Date.now() + CLOSED_ROOM_CODE_TTL_MS);
}

function isClosedRoomCode(code) {
  const clean = sanitizeRoomCode(code);
  const expiresAt = closedRoomCodes.get(clean);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    closedRoomCodes.delete(clean);
    return false;
  }
  return true;
}

function pruneClosedRoomCodes(now) {
  for (const [code, expiresAt] of closedRoomCodes) {
    if (expiresAt <= now) closedRoomCodes.delete(code);
  }
}

function resetMatch(room, now) {
  const { resetRoundPlayerStats, resetPlayerForMatch } = require("./players");
  const { broadcastRoom } = require("./messages");

  room.winner = null;
  room.winnerAt = 0;
  room.lastScoreAt = now;
  for (const point of room.points) {
    point.ownerId = null;
    point.ownerTeam = null;
    point.progress = 0;
  }
  for (const player of room.players.values()) {
    resetRoundPlayerStats(player);
    resetPlayerForMatch(room, player, now);
  }
  broadcastRoom(room, { type: "notice", message: "New match started" });
}

module.exports = {
  rooms,
  closedRoomCodes,
  createRoom,
  setRoomRules,
  sanitizeRoomRules,
  sanitizeMapSize,
  sanitizeGameMode,
  applyGameModeTeams,
  generateMap,
  generateRelays,
  addMirroredRelayPair,
  generateAsteroids,
  makeAsteroid,
  generateClouds,
  mapSafetyZones,
  canPlaceMapCircle,
  circlesClear,
  prepareArenaForCurrentPlayers,
  chooseWorldSize,
  chooseRoomWorld,
  makeRoomCode,
  rememberClosedRoom,
  isClosedRoomCode,
  pruneClosedRoomCodes,
  resetMatch
};

