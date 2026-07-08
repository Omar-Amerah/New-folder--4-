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
  const map = generateMap(code, world, DEFAULT_ROOM_RULES.gameMode);
  return {
    code,
    adminId: null,
    phase: "lobby",
    world,
    mapSizeLabel: world.label,
    clients: new Set(),
    players: new Map(),
    ships: new Map(),
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
    controlVictory: {
      team: null,
      playerId: null,
      startedAt: null,
      remaining: null,
      requiredSeconds: 20
    },
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
  room.map = generateMap(room.code, world, room.rules.gameMode);
  room.points = room.map.relays.map((relay) => ({ ...relay, ownerId: null, ownerTeam: null, progress: 0 }));
  room.lastStaticSnapshotAt = 0;

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

function generateMap(roomCode, world, gameMode) {
  const seed = (crypto.randomBytes(4).readUInt32BE(0) ^ hashString(roomCode)) >>> 0;
  const rng = seededRandom(seed);
  const safeZones = generateSafeZones(world, gameMode);
  const relays = generateRelays(rng, world, safeZones);
  const asteroids = generateAsteroids(rng, world, relays, safeZones);
  const clouds = generateClouds(rng, world);

  return {
    seed,
    name: MAP_NAMES[seed % MAP_NAMES.length],
    relays,
    asteroids,
    clouds,
    safeZones
  };
}

function generateSafeZones(world, gameMode) {
  const zones = [];
  if (gameMode === "teams") {
    // Large base zones
    zones.push({ x: 300, y: world.height * 0.5, radius: 550, color: "rgba(63,214,255,0.06)", isSpawn: true, team: "blue" });
    zones.push({ x: world.width - 300, y: world.height * 0.5, radius: 550, color: "rgba(255,95,126,0.06)", isSpawn: true, team: "red" });
  } else {
    // Solo zones
    zones.push({ x: 300, y: world.height * 0.5, radius: 550, color: "rgba(255,255,255,0.06)", isSpawn: true });
    zones.push({ x: world.width - 300, y: world.height * 0.5, radius: 550, color: "rgba(255,255,255,0.06)", isSpawn: true });
    zones.push({ x: world.width * 0.5, y: 300, radius: 550, color: "rgba(255,255,255,0.06)", isSpawn: true });
    zones.push({ x: world.width * 0.5, y: world.height - 300, radius: 550, color: "rgba(255,255,255,0.06)", isSpawn: true });
  }
  return zones;
}

function generateRelays(rng, world, safeZones) {
  const relays = [];

  // Always one central relay (add first so mirrored pairs check clearance against it)
  relays.push({
    x: world.width * 0.5 + rngRange(rng, -200, 200),
    y: world.height * 0.5 + rngRange(rng, -200, 200),
    radius: rngRange(rng, 150, 180)
  });

  // Try to place up to 3 pairs of mirrored relays
  const pairCount = rng() > 0.6 ? 3 : 2;

  for (let i = 0; i < pairCount; i++) {
    addMirroredRelayPair(rng, relays, {
      minX: world.width * 0.15,
      maxX: world.width * 0.45,
      minY: world.height * 0.15,
      maxY: world.height * 0.85
    }, world, safeZones);
  }

  return relays
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((relay, index) => ({
      id: String.fromCharCode(65 + index),
      x: Math.round(relay.x),
      y: Math.round(relay.y),
      radius: Math.round(relay.radius)
    }));
}

function addMirroredRelayPair(rng, relays, bounds, world, safeZones) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const radius = rngRange(rng, 140, 170);
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

    // Check clearance against other relays (wider distance), between the pair itself, and against safe zones
    if (circlesClear(relay, relays, 800) && circlesClear(mirror, relays, 800) &&
        circlesClear(relay, [mirror], 800) &&
        circlesClear(relay, safeZones, 500) && circlesClear(mirror, safeZones, 500)) {
      relays.push(relay, mirror);
      return true;
    }
  }
  return false;
}

function circlesClearWithNoise(circle, others, minBuffer, maxBuffer, rng) {
  for (const other of others) {
    const buffer = rngRange(rng, minBuffer, maxBuffer);
    const minimum = circle.radius + other.radius + buffer;
    if (Math.hypot(circle.x - other.x, circle.y - other.y) < minimum) return false;
  }
  return true;
}

function generateAsteroids(rng, world, relays, safeZones) {
  const asteroids = [];
  // Exclude safe zones (relays checked dynamically with noise)
  const reserved = safeZones.map(s => ({ x: s.x, y: s.y, radius: s.radius + 200 }));

  const pairCount = 8 + Math.floor(rng() * 8);

  for (let pair = 0; pair < pairCount; pair += 1) {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const radius = rngRange(rng, 60, 140);
      // Place anywhere except extreme edges
      const asteroid = {
        x: rngRange(rng, world.width * 0.05, world.width * 0.49),
        y: rngRange(rng, world.height * 0.05, world.height * 0.95),
        radius
      };
      const mirror = {
        x: world.width - asteroid.x,
        y: world.height - asteroid.y,
        radius
      };
      if (!canPlaceMapCircle(asteroid, reserved, asteroids, 220, world) || !canPlaceMapCircle(mirror, reserved, asteroids, 220, world)) {
        continue;
      }
      if (!circlesClearWithNoise(asteroid, relays, 200, 500, rng) || !circlesClearWithNoise(mirror, relays, 200, 500, rng)) {
        continue;
      }
      asteroids.push(
        makeAsteroid(rng, `R${asteroids.length + 1}`, asteroid),
        makeAsteroid(rng, `R${asteroids.length + 2}`, mirror)
      );
      break;
    }
  }

  // Central scattered asteroids
  const centralCount = 4 + Math.floor(rng() * 4);
  for (let i = 0; i < centralCount; i += 1) {
      for (let attempt = 0; attempt < 70; attempt += 1) {
        const radius = rngRange(rng, 70, 120);
        const asteroid = {
          x: world.width * 0.5 + rngRange(rng, -800, 800),
          y: world.height * 0.5 + rngRange(rng, -800, 800),
          radius
        };
        const mirror = {
          x: world.width - asteroid.x,
          y: world.height - asteroid.y,
          radius
        };
        if (!canPlaceMapCircle(asteroid, reserved, asteroids, 220, world) || !canPlaceMapCircle(mirror, reserved, asteroids, 220, world)) {
          continue;
        }
        if (!circlesClearWithNoise(asteroid, relays, 200, 500, rng) || !circlesClearWithNoise(mirror, relays, 200, 500, rng)) {
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
  room.map = generateMap(room.code, world, room.rules?.gameMode || "teams");
  room.points = room.map.relays.map((relay) => ({ ...relay, ownerId: null, ownerTeam: null, progress: 0 }));
  room.lastStaticSnapshotAt = 0;
  room.bullets = [];
  room.effects = [];
  room.nextEntityId = 1;
}

function chooseWorldSize(playerCount) {
  for (let i = 0; i < WORLD_SIZES.length; i += 1) {
    const candidate = WORLD_SIZES[i];
    if (playerCount <= candidate.maxPlayers) {
      return { width: candidate.width, height: candidate.height, label: candidate.label };
    }
  }
  const fallback = WORLD_SIZES[WORLD_SIZES.length - 1];
  return { width: fallback.width, height: fallback.height, label: fallback.label };
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
      code += alphabet[crypto.randomInt(alphabet.length)];
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
  generateSafeZones,
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

