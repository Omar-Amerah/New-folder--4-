"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const WORLD = { width: 3200, height: 1900 };
const WORLD_SIZES = Object.freeze([
  { maxPlayers: 2, width: 2600, height: 1600, label: "Duel" },
  { maxPlayers: 4, width: 3200, height: 1900, label: "Skirmish" },
  { maxPlayers: 8, width: 4100, height: 2400, label: "Battle" },
  { maxPlayers: Infinity, width: 5000, height: 2900, label: "Grand battle" }
]);
const TICK_HZ = 30;
const SNAPSHOT_HZ = 15;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PLAYERS_PER_ROOM = 12;
const ROOM_IDLE_MS = 15 * 60 * 1000;
const MATCH_SCORE = 900;
const SCORE_PER_CONTROLLED_POINT = 6;
const ECONOMY = Object.freeze({
  startingMoney: 420,
  maxMoney: 2200,
  baseIncome: 13,
  relayIncome: 7,
  killBountyRatio: 0.28,
  killBountyMin: 24,
  captureBonus: 55,
  shipCap: 20,
  deploymentBudget: 700,
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
    railgun: 48
  })
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

const PARTS = Object.freeze({
  core: { cost: 0, mass: 8, hp: 150, powerGeneration: 4, powerUse: 0, shield: 25, shieldRegen: 0.4, thrust: 0, turn: 0, energyStorage: 80, repairRate: 0, weapon: null },
  frame: { cost: 2, mass: 2, hp: 42, powerGeneration: 0, powerUse: 0, shield: 0, shieldRegen: 0, thrust: 0, turn: 0, energyStorage: 0, repairRate: 0, weapon: null },
  armor: { cost: 9, mass: 8, hp: 135, powerGeneration: 0, powerUse: 0, shield: 0, shieldRegen: 0, thrust: 0, turn: -0.04, energyStorage: 0, repairRate: 0, weapon: null },
  engine: { cost: 14, mass: 4, hp: 52, powerGeneration: 0, powerUse: 1, shield: 0, shieldRegen: 0, thrust: 135, turn: 0.24, energyStorage: 0, repairRate: 0, weapon: null },
  reactor: { cost: 20, mass: 6, hp: 62, powerGeneration: 9, powerUse: 0, shield: 0, shieldRegen: 0, thrust: 0, turn: 0.01, energyStorage: 30, repairRate: 0, explosionRisk: "Medium when destroyed", weapon: null },
  battery: { cost: 12, mass: 3, hp: 44, powerGeneration: 0, powerUse: 0, shield: 42, shieldRegen: 0.8, thrust: 0, turn: 0, energyStorage: 180, repairRate: 0, weapon: null },
  shield: { cost: 18, mass: 5, hp: 48, powerGeneration: 0, powerUse: 3, shield: 115, shieldRegen: 2.4, thrust: 0, turn: -0.01, energyStorage: 0, repairRate: 0, weapon: null },
  blaster: { cost: 25, mass: 5, hp: 48, powerGeneration: 0, powerUse: 2, shield: 0, shieldRegen: 0, thrust: 0, turn: -0.02, energyStorage: 0, repairRate: 0, blaster: 1, weapon: makeWeapon("blaster", { damage: 14, fireRate: 1.55, range: 520, projectileSpeed: 650, accuracy: 0.88, tracking: 0 }) },
  missile: { cost: 35, mass: 7, hp: 54, powerGeneration: 0, powerUse: 3, shield: 0, shieldRegen: 0, thrust: 0, turn: -0.03, energyStorage: 0, repairRate: 0, missile: 1, weapon: makeWeapon("missile", { damage: 64, fireRate: 0.3, range: 820, projectileSpeed: 330, accuracy: 0.72, tracking: 0.82 }) },
  railgun: { cost: 45, mass: 9, hp: 58, powerGeneration: 0, powerUse: 6, shield: 0, shieldRegen: 0, thrust: 0, turn: -0.05, energyStorage: 0, repairRate: 0, railgun: 1, weapon: makeWeapon("railgun", { damage: 105, fireRate: 0.19, range: 1100, projectileSpeed: 1080, accuracy: 0.96, tracking: 0 }) },
  repair: { cost: 22, mass: 5, hp: 50, powerGeneration: 0, powerUse: 2, shield: 20, shieldRegen: 0.5, thrust: 0, turn: -0.01, energyStorage: 0, repairRate: 10, repair: 1, weapon: null }
});

const DEFAULT_DESIGN = Object.freeze([
  { x: 3, y: 3, type: "core" },
  { x: 3, y: 4, type: "reactor" },
  { x: 2, y: 4, type: "engine" },
  { x: 4, y: 4, type: "engine" },
  { x: 2, y: 3, type: "blaster" },
  { x: 4, y: 3, type: "blaster" },
  { x: 3, y: 2, type: "shield" },
  { x: 2, y: 2, type: "armor" },
  { x: 4, y: 2, type: "armor" }
]);

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

const rooms = new Map();
const sockets = new Set();
let nextClientId = 1;

const server = http.createServer(handleHttpRequest);

server.on("upgrade", (req, socket) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    socket.destroy();
    return;
  }

  if (url.pathname !== "/socket" || req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const client = createClient(socket);
  sockets.add(client);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Modular Fleet Arena running on http://localhost:${PORT}`);
  for (const address of getLocalUrls(PORT)) {
    console.log(`LAN: ${address}`);
  }
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.clients.size === 0 && now - room.lastEmptyAt > ROOM_IDLE_MS) {
      rooms.delete(room.code);
    }
  }
}, 60_000).unref();

let lastTick = performanceNow();
setInterval(() => {
  const now = performanceNow();
  const dt = Math.min(0.06, Math.max(0.001, (now - lastTick) / 1000));
  lastTick = now;

  for (const room of rooms.values()) {
    tickRoom(room, dt, now);
  }
}, 1000 / TICK_HZ).unref();

setInterval(() => {
  const now = performanceNow();
  for (const room of rooms.values()) {
    broadcastRoom(room, snapshotRoom(room, now));
  }
}, 1000 / SNAPSHOT_HZ).unref();

function handleHttpRequest(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=600"
    });
    res.end(data);
  });
}

function createClient(socket) {
  const client = {
    id: `p${nextClientId++}`,
    socket,
    buffer: Buffer.alloc(0),
    room: null,
    player: null,
    joinedAt: Date.now(),
    lastMessageAt: Date.now(),
    isClosed: false
  };

  socket.setNoDelay(true);
  socket.on("data", (chunk) => handleSocketData(client, chunk));
  socket.on("close", () => finalizeClient(client));
  socket.on("error", () => finalizeClient(client));

  send(client, {
    type: "hello",
    id: client.id,
    world: WORLD,
    parts: PARTS,
    economy: {
      startingMoney: ECONOMY.startingMoney,
      deploymentBudget: ECONOMY.deploymentBudget,
      shipCap: ECONOMY.shipCap
    },
    defaultDesign: DEFAULT_DESIGN
  });

  return client;
}

function handleSocketData(client, chunk) {
  if (client.isClosed) return;
  client.buffer = Buffer.concat([client.buffer, chunk]);

  if (client.buffer.length > MAX_MESSAGE_BYTES) {
    closeClient(client, 1009, "Message too large");
    return;
  }

  while (client.buffer.length >= 2) {
    const frame = readFrame(client.buffer);
    if (!frame) return;
    client.buffer = client.buffer.subarray(frame.bytesRead);

    if (frame.opcode === 0x8) {
      closeClient(client, 1000, "Bye");
      return;
    }

    if (frame.opcode === 0x9) {
      writeFrame(client.socket, frame.payload, 0xA);
      continue;
    }

    if (frame.opcode !== 0x1) continue;

    try {
      const message = JSON.parse(frame.payload.toString("utf8"));
      client.lastMessageAt = Date.now();
      handleMessage(client, message);
    } catch {
      send(client, { type: "error", message: "Bad message" });
    }
  }
}

function readFrame(buffer) {
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    if (high !== 0) return null;
    length = low;
    offset += 8;
  }

  if (!masked) return null;
  if (length > MAX_MESSAGE_BYTES) return null;
  if (buffer.length < offset + 4 + length) return null;

  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    payload[i] = buffer[offset + i] ^ mask[i % 4];
  }

  return { opcode, payload, bytesRead: offset + length };
}

function writeFrame(socket, payload, opcode = 0x1) {
  if (typeof payload === "string") payload = Buffer.from(payload, "utf8");
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }

  socket.write(Buffer.concat([header, payload]));
}

function handleMessage(client, message) {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "ping") {
    send(client, { type: "pong", at: Number(message.at) || 0, serverTime: Date.now() });
    return;
  }

  if (message.type === "join") {
    joinRoom(client, message);
    return;
  }

  if (!client.room || !client.player) {
    send(client, { type: "error", message: "Join a room first" });
    return;
  }

  if (message.type === "deploy") {
    if (client.room.phase !== "design" && client.room.phase !== "active") {
      send(client, { type: "error", message: "Ship designs can only be saved during design or active match phases" });
      return;
    }
    const design = validateDesign(message.design);
    const validation = validateBuildShip(client.room, client.player, design.stats);
    if (client.room.phase === "design" && !validation.ok) {
      send(client, { type: "error", message: validation.reason });
      return;
    }
    client.player.design = design.modules;
    client.player.stats = design.stats;
    if (client.room.phase === "design") {
      client.player.ready = true;
      client.player.lastReadyAt = performanceNow();
      broadcastRoom(client.room, { type: "notice", message: `${client.player.name} is ready` });
      maybeStartMatch(client.room, performanceNow());
    } else {
      send(client, { type: "notice", message: `Blueprint saved. New ships cost $${design.stats.unitCost}` });
    }
    return;
  }

  if (message.type === "buyShip") {
    if (client.room.phase !== "active") {
      send(client, { type: "error", message: "Ships can only be built after the match starts" });
      return;
    }
    const count = clampNumber(message.count, 1, 5);
    const purchaseDesign = message.design ? validateDesign(message.design) : null;
    const validation = validateBuyShip(client.room, client.player, count, purchaseDesign?.stats);
    if (!validation.ok) {
      client.player.lastBuildError = validation.reason;
      send(client, { type: "error", message: validation.reason });
      return;
    }
    for (let i = 0; i < validation.count; i += 1) {
      buyShip(client.room, client.player, performanceNow(), {
        prevalidated: true,
        stats: validation.shipStats,
        design: purchaseDesign?.modules
      });
    }
    return;
  }

  if (message.type === "command") {
    if (client.room.phase !== "active") return;
    const x = clampNumber(message.x, 0, client.room.world.width);
    const y = clampNumber(message.y, 0, client.room.world.height);
    commandShips(client.room, client.player, x, y, {
      shipIds: Array.isArray(message.shipIds) ? message.shipIds : null,
      targetId: typeof message.targetId === "string" ? message.targetId : null,
      formation: sanitizeFormation(message.formation)
    });
    return;
  }

  if (message.type === "setTeam") {
    if (client.room.phase !== "lobby") {
      send(client, { type: "error", message: "Wings can only be changed in the lobby before ship design" });
      return;
    }
    client.player.team = sanitizeTeam(message.team, client.player.id);
    broadcastRoom(client.room, { type: "notice", message: `${client.player.name} changed wing` });
    return;
  }

  if (message.type === "addBot") {
    if (!isAdmin(client.room, client.player)) {
      send(client, { type: "error", message: "Only the room admin can add bots" });
      return;
    }
    if (client.room.phase !== "lobby") {
      send(client, { type: "error", message: "Bots can only be added before ship design starts" });
      return;
    }
    addBot(client.room, client.player);
    return;
  }

  if (message.type === "setName") {
    client.player.name = sanitizeName(message.name, client.player.name);
    return;
  }

  if (message.type === "startDesign") {
    startDesignPhase(client.room, client.player);
    return;
  }

  if (message.type === "kick") {
    kickPlayer(client.room, client.player, String(message.targetId || ""));
    return;
  }

  if (message.type === "restart") {
    restartFromEnd(client.room, client.player);
    return;
  }

  if (message.type === "closeLobby") {
    closeLobby(client.room, client.player);
    return;
  }
}

function joinRoom(client, message) {
  const requestedCode = sanitizeRoomCode(message.room);
  const code = requestedCode || makeRoomCode();
  const requestedName = sanitizeName(message.name, `Pilot ${client.id.slice(1)}`);
  let room = rooms.get(code);

  if (!room) {
    room = createRoom(code);
    rooms.set(code, room);
  }

  if (room.phase !== "lobby") {
    send(client, { type: "error", message: "That game has already started. Create a new room or wait for the next lobby." });
    return;
  }

  if (room.players.size >= MAX_PLAYERS_PER_ROOM && !room.clients.has(client)) {
    send(client, { type: "error", message: "Room is full" });
    return;
  }

  if (room.kickedIds?.has(client.id) || room.kickedNames?.has(requestedName.toLowerCase())) {
    send(client, { type: "error", message: "You were kicked from this room by the host." });
    return;
  }

  leaveRoom(client);

  const color = COLORS[room.colorCursor % COLORS.length];
  room.colorCursor += 1;

  const player = {
    id: client.id,
    name: requestedName,
    color,
    team: sanitizeTeam(message.team, client.id),
    isBot: false,
    ai: null,
    ready: false,
    design: DEFAULT_DESIGN.map((part) => ({ ...part })),
    stats: computeStats(DEFAULT_DESIGN),
    ships: [],
    money: ECONOMY.startingMoney,
    bank: ECONOMY.startingMoney,
    income: ECONOMY.baseIncome,
    earned: ECONOMY.startingMoney,
    spent: 0,
    maxMoney: ECONOMY.maxMoney,
    shipCap: ECONOMY.shipCap,
    deploymentBudget: ECONOMY.deploymentBudget,
    deployedFleetCost: 0,
    destroyedEnemyCost: 0,
    lostFleetCost: 0,
    lastReward: null,
    score: 0,
    kills: 0,
    losses: 0,
    captures: 0,
    connected: true,
    lastReadyAt: 0
  };

  client.room = room;
  client.player = player;
  room.clients.add(client);
  room.players.set(player.id, player);
  if (!room.adminId) room.adminId = player.id;
  room.lastEmptyAt = 0;

  send(client, { type: "joined", id: client.id, room: room.code, world: room.world, map: room.map, phase: room.phase, adminId: room.adminId });
  broadcastRoom(room, { type: "notice", message: `${player.name} joined ${room.code}` });
}

function leaveRoom(client) {
  if (client.room && client.player) {
    const { room, player } = client;
    for (const ship of player.ships) {
      ship.alive = false;
      ship.removed = true;
    }
    room.clients.delete(client);
    room.players.delete(player.id);
    room.bullets = room.bullets.filter((bullet) => bullet.ownerId !== player.id);
    if (room.clients.size === 0) {
      room.lastEmptyAt = Date.now();
    } else {
      ensureAdmin(room);
      broadcastRoom(room, { type: "notice", message: `${player.name} left` });
      if (room.phase === "design") maybeStartMatch(room, performanceNow());
    }
  }

  client.room = null;
  client.player = null;
}

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
    maxScore: MATCH_SCORE
  };
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

function tickRoom(room, dt, now) {
  if (room.phase !== "active") {
    room.effects = room.effects.filter((effect) => now - effect.at < 900);
    return;
  }

  updateBots(room, now);
  updateEconomy(room, dt);
  updateDestroyedShips(room, now);

  const ships = getLiveShips(room);
  for (const ship of ships) {
    updateShipMovement(room, ship, dt);
  }

  updateShipSeparation(room, ships, dt);
  resolveFleetMapCollisions(room, ships);
  updateShipSupport(room, ships, dt, now);

  for (const ship of ships) {
    updateShipWeapons(room, ship, ships, dt, now);
  }

  updateBullets(room, dt, now);
  updateCapturePoints(room, ships, dt);
  updateScoring(room, now);
}

function buyShip(room, player, now, options = {}) {
  if (!player.ready) return false;
  const stats = options.stats || player.stats || computeStats(player.design);
  const design = normalizeShipDesignSnapshot(options.design || player.design);
  if (!options.prevalidated) {
    const validation = options.starter
      ? validateBuildShip(room, player, stats)
      : validateBuyShip(room, player, 1, stats);
    if (!validation.ok) {
      if (!options.silent) player.lastBuildError = validation.reason;
      return false;
    }
  }

  player.money -= stats.unitCost;
  player.spent += stats.unitCost;
  player.deployedFleetCost += stats.unitCost;
  const activeCount = player.ships.filter((ship) => !ship.removed && ship.alive).length;
  spawnShip(room, player, now, activeCount, { stats, design });
  if (!options.starter) {
    broadcastRoom(room, { type: "notice", message: `${player.name} built a ship for $${stats.unitCost}` });
  }
  return true;
}

function validateBuyShip(room, player, count = 1, stats = null) {
  if (room.phase !== "active") {
    return { ok: false, reason: "Ships can only be built after the match starts" };
  }
  if (!player.ready) {
    return { ok: false, reason: "Invalid design: save a blueprint first." };
  }
  const shipStats = stats || player.stats || computeStats(player.design);
  const requestedCount = clampNumber(count, 1, 5);
  const activeCount = player.ships.filter((ship) => !ship.removed && ship.alive).length;
  if (activeCount >= player.shipCap) {
    return { ok: false, reason: `Fleet cap reached: ${activeCount}/${player.shipCap}` };
  }
  const availableSlots = Math.max(0, player.shipCap - activeCount);
  if (requestedCount > availableSlots) {
    return { ok: false, reason: `Fleet cap reached: ${activeCount}/${player.shipCap}. ${availableSlots} slot${availableSlots === 1 ? "" : "s"} available.` };
  }
  const totalCost = shipStats.unitCost * requestedCount;
  if (player.money < totalCost) {
    return { ok: false, reason: `Not enough money: need $${totalCost - Math.floor(player.money)} more` };
  }
  return { ok: true, shipStats, count: requestedCount, totalCost };
}

function normalizeShipDesignSnapshot(design) {
  const source = Array.isArray(design) ? design : DEFAULT_DESIGN;
  return source.map((part) => ({ x: part.x, y: part.y, type: part.type }));
}

function validateBuildShip(room, player, stats = null) {
  if (!player.ready && room.phase === "active") {
    return { ok: false, reason: "Invalid design: save a blueprint first." };
  }
  const shipStats = stats || player.stats || computeStats(player.design);
  const activeCount = player.ships.filter((ship) => !ship.removed && ship.alive).length;
  if (activeCount >= player.shipCap) {
    return { ok: false, reason: "Ship limit reached for this match." };
  }
  const activeFleetCost = getActiveFleetCost(player);
  if (activeFleetCost + shipStats.unitCost > player.deploymentBudget) {
    return { ok: false, reason: `Starting fleet limit exceeded by $${activeFleetCost + shipStats.unitCost - player.deploymentBudget}.` };
  }
  if (shipStats.unitCost > player.money) {
    return { ok: false, reason: `Cannot build ship. Need $${shipStats.unitCost - Math.floor(player.money)} more.` };
  }
  return { ok: true, shipCost: shipStats.unitCost, shipStats };
}

function spawnShip(room, player, now, index = 0, options = {}) {
  const stats = options.stats || player.stats || computeStats(player.design);
  const design = normalizeShipDesignSnapshot(options.design || player.design);
  const spawn = getPlayerSpawn(room, player.id);
  const offset = index - Math.floor(player.shipCap / 2);
  const ySpread = Math.sin(index * 1.7) * 54;
  const spawnPoint = nearestClearPoint(
    room,
    spawn.x + offset * 16 + randomRange(-26, 26),
    spawn.y + ySpread + randomRange(-32, 32),
    Math.max(46, stats.radius * 0.72)
  );
  const ship = {
    id: `s${room.nextEntityId++}`,
    ownerId: player.id,
    x: spawnPoint.x,
    y: spawnPoint.y,
    vx: 0,
    vy: 0,
    angle: spawn.angle,
    targetX: room.world.width / 2,
    targetY: room.world.height / 2,
    formationX: 0,
    formationY: 0,
    alive: true,
    removed: false,
    removeAt: 0,
    hp: stats.maxHp,
    shield: stats.maxShield,
    maxHp: stats.maxHp,
    maxShield: stats.maxShield,
    stats,
    design,
    cost: stats.unitCost,
    radius: stats.radius,
    blasterCooldown: randomRange(0.08, 0.42),
    missileCooldown: randomRange(0.35, 0.9),
    railgunCooldown: randomRange(0.45, 1.4),
    repairPulseAt: 0,
    focusTargetId: null,
    lastDamagedBy: null
  };
  player.ships.push(ship);
  room.effects.push({ type: "warp", x: ship.x, y: ship.y, at: now });
  return ship;
}

function resetPlayerForMatch(room, player, now, options = {}) {
  for (const oldShip of player.ships) oldShip.removed = true;
  player.ships = [];
  player.money = ECONOMY.startingMoney;
  player.income = ECONOMY.baseIncome;
  player.earned = player.money;
  player.spent = 0;
  player.deployedFleetCost = 0;
  player.destroyedEnemyCost = 0;
  player.lostFleetCost = 0;
  player.lastReward = null;
  player.lastBuildError = "";
  room.bullets = room.bullets.filter((bullet) => bullet.ownerId !== player.id);
  if (options.spawn && player.ready) {
    buyShip(room, player, now, { starter: true });
  }
}

function commandShips(room, player, x, y, options = {}) {
  const shipIdSet = Array.isArray(options.shipIds)
    ? new Set(options.shipIds.map((id) => String(id)).slice(0, 24))
    : null;
  let ships = player.ships.filter((ship) => ship.alive && !ship.removed);

  if (shipIdSet && shipIdSet.size > 0) {
    ships = ships.filter((ship) => shipIdSet.has(ship.id));
  }

  if (ships.length === 0) return;

  const target = findShipById(room, options.targetId);
  const focusTargetId = target && areEnemies(room, player.id, target.ownerId) ? target.id : null;
  const formation = options.formation || "line";
  const spacing = clampNumber(62 + ships[0].radius * 0.55, 58, 110);

  ships.forEach((ship, index) => {
    const offset = formationOffset(index, ships.length, spacing, formation);
    const targetPoint = nearestClearPoint(room, x + offset.x, y + offset.y, Math.max(42, ship.radius * 0.72));
    ship.targetX = targetPoint.x;
    ship.targetY = targetPoint.y;
    ship.focusTargetId = focusTargetId;
  });
}

function formationOffset(index, count, spacing, formation) {
  const center = index - (count - 1) / 2;
  if (formation === "wedge") {
    const side = index % 2 === 0 ? -1 : 1;
    const rank = Math.ceil(index / 2);
    return { x: -rank * spacing * 0.75, y: side * rank * spacing * 0.62 };
  }
  if (formation === "clump") {
    const ring = Math.ceil(Math.sqrt(index + 1));
    const angle = index * 2.399963;
    return { x: Math.cos(angle) * ring * spacing * 0.28, y: Math.sin(angle) * ring * spacing * 0.28 };
  }
  return { x: center * spacing, y: Math.sin(index * 1.7) * spacing * 0.28 };
}

function updateEconomy(room, dt) {
  const ownedRelays = new Map();
  for (const point of room.points) {
    if (point.ownerTeam && point.progress >= 0.98) {
      ownedRelays.set(point.ownerTeam, (ownedRelays.get(point.ownerTeam) || 0) + 1);
    }
  }

  for (const player of room.players.values()) {
    if (!player.ready || room.winner) {
      player.income = 0;
      continue;
    }

    const relays = ownedRelays.get(player.team) || 0;
    player.income = ECONOMY.baseIncome + relays * ECONOMY.relayIncome;
    const gained = player.income * dt;
    player.money = Math.min(player.maxMoney || ECONOMY.maxMoney, player.money + gained);
    player.earned += gained;
  }
}

function updateDestroyedShips(room, now) {
  for (const player of room.players.values()) {
    for (const ship of player.ships) {
      if (!ship.alive && !ship.removed && ship.removeAt && now >= ship.removeAt) {
        ship.removed = true;
      }
    }
  }
}

function updateShipMovement(room, ship, dt) {
  const dx = ship.targetX - ship.x;
  const dy = ship.targetY - ship.y;
  const distance = Math.hypot(dx, dy);
  const stats = ship.stats;

  if (distance > 12) {
    const desired = Math.atan2(dy, dx);
    ship.angle = rotateToward(ship.angle, desired, stats.turnRate * dt);

    const alignment = Math.max(0.12, Math.cos(angleDifference(ship.angle, desired)));
    const thrust = stats.accel * alignment;
    ship.vx += Math.cos(ship.angle) * thrust * dt;
    ship.vy += Math.sin(ship.angle) * thrust * dt;
  }

  const damping = distance < 85 ? 0.9 : 0.985;
  ship.vx *= Math.pow(damping, dt * 60);
  ship.vy *= Math.pow(damping, dt * 60);

  const speed = Math.hypot(ship.vx, ship.vy);
  if (speed > stats.maxSpeed) {
    const scale = stats.maxSpeed / speed;
    ship.vx *= scale;
    ship.vy *= scale;
  }

  ship.x = clampNumber(ship.x + ship.vx * dt, 42, room.world.width - 42);
  ship.y = clampNumber(ship.y + ship.vy * dt, 42, room.world.height - 42);
  resolveMapCollision(room, ship);

  if (ship.x <= 43 || ship.x >= room.world.width - 43) ship.vx *= -0.35;
  if (ship.y <= 43 || ship.y >= room.world.height - 43) ship.vy *= -0.35;

  if (ship.maxShield > 0) {
    ship.shield = Math.min(ship.maxShield, ship.shield + stats.shieldRegen * dt);
  }
}

function updateShipSeparation(room, ships, dt) {
  for (let i = 0; i < ships.length; i += 1) {
    for (let j = i + 1; j < ships.length; j += 1) {
      const a = ships[i];
      const b = ships[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const minimum = (a.radius + b.radius) * 0.72;
      if (distance >= minimum) continue;

      const push = (minimum - distance) * 0.5;
      const nx = dx / distance;
      const ny = dy / distance;
      a.x = clampNumber(a.x - nx * push, 42, room.world.width - 42);
      a.y = clampNumber(a.y - ny * push, 42, room.world.height - 42);
      b.x = clampNumber(b.x + nx * push, 42, room.world.width - 42);
      b.y = clampNumber(b.y + ny * push, 42, room.world.height - 42);

      const impulse = push * dt * 9;
      a.vx -= nx * impulse;
      a.vy -= ny * impulse;
      b.vx += nx * impulse;
      b.vy += ny * impulse;
    }
  }
}

function resolveFleetMapCollisions(room, ships) {
  for (const ship of ships) resolveMapCollision(room, ship);
}

function resolveMapCollision(room, ship) {
  const asteroids = room.map?.asteroids || [];
  for (const asteroid of asteroids) {
    let dx = ship.x - asteroid.x;
    let dy = ship.y - asteroid.y;
    let distance = Math.hypot(dx, dy);
    if (distance < 0.001) {
      dx = Math.cos(ship.angle || 0);
      dy = Math.sin(ship.angle || 0);
      distance = 1;
    }
    const minimum = asteroid.radius + Math.max(24, ship.radius * 0.62);
    if (distance >= minimum) continue;

    const nx = dx / distance;
    const ny = dy / distance;
    const push = minimum - distance;
    ship.x = clampNumber(ship.x + nx * push, 42, room.world.width - 42);
    ship.y = clampNumber(ship.y + ny * push, 42, room.world.height - 42);

    const towardRock = ship.vx * nx + ship.vy * ny;
    if (towardRock < 0) {
      ship.vx -= towardRock * nx * 1.25;
      ship.vy -= towardRock * ny * 1.25;
    }
    ship.vx *= 0.82;
    ship.vy *= 0.82;
  }
}

function nearestClearPoint(room, x, y, clearance) {
  let px = clampNumber(x, 42, room.world.width - 42);
  let py = clampNumber(y, 42, room.world.height - 42);
  const asteroids = room.map?.asteroids || [];

  for (let pass = 0; pass < 8; pass += 1) {
    let adjusted = false;
    for (const asteroid of asteroids) {
      const dx = px - asteroid.x;
      const dy = py - asteroid.y;
      const distance = Math.hypot(dx, dy);
      const minimum = asteroid.radius + clearance;
      if (distance >= minimum) continue;

      const angle = distance > 0.001 ? Math.atan2(dy, dx) : Math.atan2(py - room.world.height * 0.5, px - room.world.width * 0.5);
      px = asteroid.x + Math.cos(angle) * minimum;
      py = asteroid.y + Math.sin(angle) * minimum;
      px = clampNumber(px, 42, room.world.width - 42);
      py = clampNumber(py, 42, room.world.height - 42);
      adjusted = true;
    }
    if (!adjusted) break;
  }

  return { x: px, y: py };
}

function updateShipSupport(room, ships, dt, now) {
  for (const ship of ships) {
    if (!ship.stats.repair) continue;

    let target = null;
    let worst = 0;
    for (const other of ships) {
      if (!areAllies(room, ship.ownerId, other.ownerId)) continue;
      const missing = other.maxHp - other.hp;
      if (missing <= 0) continue;
      const distance = Math.hypot(other.x - ship.x, other.y - ship.y);
      if (distance > ship.stats.repairRange) continue;
      if (missing > worst) {
        target = other;
        worst = missing;
      }
    }

    if (!target) continue;
    const heal = ship.stats.repairRate * ship.stats.efficiency * dt;
    target.hp = Math.min(target.maxHp, target.hp + heal);

    if (now - ship.repairPulseAt > 420) {
      ship.repairPulseAt = now;
      room.effects.push({ type: "repair", x: target.x, y: target.y, at: now, ownerId: ship.ownerId });
    }
  }
}

function updateShipWeapons(room, ship, ships, dt, now) {
  const target = findTarget(room, ship, ships);
  ship.blasterCooldown = Math.max(0, ship.blasterCooldown - dt);
  ship.missileCooldown = Math.max(0, ship.missileCooldown - dt);
  ship.railgunCooldown = Math.max(0, ship.railgunCooldown - dt);
  if (!target) return;

  const dx = target.x - ship.x;
  const dy = target.y - ship.y;
  const distance = Math.hypot(dx, dy);
  const aim = Math.atan2(dy, dx);

  if (ship.stats.blaster > 0 && distance <= ship.stats.blasterRange && ship.blasterCooldown <= 0) {
    const shots = Math.min(3, ship.stats.blaster);
    const accuracy = clampNumber(ship.stats.blasterAccuracy || 0.85, 0.1, 1);
    const spreadScale = (1 - accuracy) * 0.26;
    for (let i = 0; i < shots; i += 1) {
      const spread = (i - (shots - 1) / 2) * 0.055 + randomRange(-spreadScale, spreadScale);
      const speed = ship.stats.blasterProjectileSpeed || 620;
      addBullet(room, {
        type: "bolt",
        ownerId: ship.ownerId,
        targetId: target.id,
        x: ship.x + Math.cos(aim) * (ship.radius + 8),
        y: ship.y + Math.sin(aim) * (ship.radius + 8),
        vx: Math.cos(aim + spread) * speed + ship.vx * 0.25,
        vy: Math.sin(aim + spread) * speed + ship.vy * 0.25,
        damage: ship.stats.blasterDamage / Math.max(1, ship.stats.blaster) * ship.stats.efficiency,
        life: 1.25,
        bornAt: now
      });
    }
    ship.blasterCooldown = Math.max(0.16, ship.stats.blasterReload / Math.sqrt(ship.stats.blaster));
  }

  if (ship.stats.missile > 0 && distance <= ship.stats.missileRange && ship.missileCooldown <= 0) {
    const missileAccuracy = clampNumber(ship.stats.missileAccuracy || 0.7, 0.1, 1);
    const spread = randomRange(-(1 - missileAccuracy) * 0.22, (1 - missileAccuracy) * 0.22);
    const speed = ship.stats.missileProjectileSpeed || 330;
    addBullet(room, {
      type: "missile",
      ownerId: ship.ownerId,
      targetId: target.id,
      x: ship.x + Math.cos(aim) * (ship.radius + 12),
      y: ship.y + Math.sin(aim) * (ship.radius + 12),
      vx: Math.cos(aim + spread) * speed + ship.vx * 0.15,
      vy: Math.sin(aim + spread) * speed + ship.vy * 0.15,
      damage: ship.stats.missileDamage / Math.max(1, ship.stats.missile) * ship.stats.efficiency,
      tracking: ship.stats.missileTracking || 0.75,
      maxSpeed: speed * 1.45,
      life: 2.8,
      bornAt: now
    });
    ship.missileCooldown = Math.max(1.2, ship.stats.missileReload / Math.sqrt(ship.stats.missile));
  }

  if (ship.stats.railgun > 0 && distance <= ship.stats.railgunRange && ship.railgunCooldown <= 0) {
    const accuracy = clampNumber(ship.stats.railgunAccuracy || 0.95, 0.1, 1);
    const spread = randomRange(-(1 - accuracy) * 0.11, (1 - accuracy) * 0.11);
    const speed = ship.stats.railgunProjectileSpeed || 1080;
    addBullet(room, {
      type: "rail",
      ownerId: ship.ownerId,
      targetId: target.id,
      x: ship.x + Math.cos(aim) * (ship.radius + 15),
      y: ship.y + Math.sin(aim) * (ship.radius + 15),
      vx: Math.cos(aim + spread) * speed + ship.vx * 0.12,
      vy: Math.sin(aim + spread) * speed + ship.vy * 0.12,
      damage: ship.stats.railgunDamage * ship.stats.efficiency,
      life: 1.15,
      bornAt: now
    });
    ship.railgunCooldown = Math.max(1.65, ship.stats.railgunReload / Math.sqrt(ship.stats.railgun));
  }
}

function addBullet(room, bullet) {
  bullet.id = `b${room.nextEntityId++}`;
  room.bullets.push(bullet);
}

function projectileMapImpact(room, x1, y1, bullet) {
  const margin = bullet.type === "missile" ? 8 : bullet.type === "rail" ? 3 : 5;
  let hit = null;
  for (const asteroid of room.map?.asteroids || []) {
    const impact = segmentCircleHit(x1, y1, bullet.x, bullet.y, asteroid.x, asteroid.y, asteroid.radius + margin);
    if (!impact) continue;
    if (!hit || impact.t < hit.t) hit = impact;
  }
  return hit;
}

function segmentCircleHit(x1, y1, x2, y2, cx, cy, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0.0001) {
    return Math.hypot(x1 - cx, y1 - cy) <= radius ? { x: x1, y: y1, t: 0 } : null;
  }

  const t = clampNumber(((cx - x1) * dx + (cy - y1) * dy) / lengthSq, 0, 1);
  const px = x1 + dx * t;
  const py = y1 + dy * t;
  if (Math.hypot(px - cx, py - cy) > radius) return null;
  return { x: px, y: py, t };
}

function updateBullets(room, dt, now) {
  const liveShips = getLiveShips(room);
  const byId = new Map(liveShips.map((ship) => [ship.id, ship]));
  const kept = [];

  for (const bullet of room.bullets) {
    bullet.life -= dt;
    if (bullet.life <= 0) continue;
    const previousX = bullet.x;
    const previousY = bullet.y;

    if (bullet.type === "missile") {
      const target = byId.get(bullet.targetId);
      if (target && areEnemies(room, bullet.ownerId, target.ownerId)) {
        const desired = Math.atan2(target.y - bullet.y, target.x - bullet.x);
        const current = Math.atan2(bullet.vy, bullet.vx);
        const next = rotateToward(current, desired, (1.6 + (bullet.tracking || 0.75) * 1.8) * dt);
        const speed = Math.min(bullet.maxSpeed || 460, Math.hypot(bullet.vx, bullet.vy) + 95 * dt);
        bullet.vx = Math.cos(next) * speed;
        bullet.vy = Math.sin(next) * speed;
      }
    }

    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;

    if (bullet.x < -80 || bullet.x > room.world.width + 80 || bullet.y < -80 || bullet.y > room.world.height + 80) {
      continue;
    }

    const rockHit = projectileMapImpact(room, previousX, previousY, bullet);
    if (rockHit) {
      room.effects.push({ type: "rockhit", x: rockHit.x, y: rockHit.y, at: now });
      continue;
    }

    let hit = false;
    for (const ship of liveShips) {
      if (!areEnemies(room, bullet.ownerId, ship.ownerId)) continue;
      const hitRadius = bullet.type === "missile" ? 14 : bullet.type === "rail" ? 9 : 6;
      if (Math.hypot(ship.x - bullet.x, ship.y - bullet.y) <= ship.radius + hitRadius) {
        damageShip(room, ship, bullet.damage, bullet.ownerId, now);
        room.effects.push({ type: bullet.type === "missile" ? "burst" : bullet.type === "rail" ? "railhit" : "spark", x: bullet.x, y: bullet.y, at: now });
        hit = true;
        break;
      }
    }

    if (!hit) kept.push(bullet);
  }

  room.bullets = kept;
  room.effects = room.effects.filter((effect) => now - effect.at < 900);
}

function damageShip(room, ship, damage, attackerId, now) {
  ship.lastDamagedBy = attackerId;

  if (ship.shield > 0) {
    const blocked = Math.min(ship.shield, damage);
    ship.shield -= blocked;
    damage -= blocked * 0.72;
  }

  ship.hp -= damage;
  if (ship.hp > 0) return;

  ship.alive = false;
  ship.removeAt = now + 3200;
  ship.hp = 0;
  ship.shield = 0;
  ship.vx *= 0.25;
  ship.vy *= 0.25;
  room.effects.push({ type: "boom", x: ship.x, y: ship.y, at: now });

  const victim = room.players.get(ship.ownerId);
  if (victim) {
    victim.losses += 1;
    victim.lostFleetCost += ship.cost || ship.stats?.unitCost || 0;
  }

  const attacker = room.players.get(attackerId);
  if (attacker && attacker.id !== ship.ownerId) {
    const bounty = Math.max(ECONOMY.killBountyMin, Math.round((ship.cost || ship.stats?.unitCost || 100) * ECONOMY.killBountyRatio));
    attacker.kills += 1;
    attacker.destroyedEnemyCost += ship.cost || ship.stats?.unitCost || 0;
    attacker.money = Math.min(attacker.maxMoney || ECONOMY.maxMoney, attacker.money + bounty);
    attacker.earned += bounty;
    attacker.score += 30 + Math.round(bounty * 0.4);
  }
}

function updateCapturePoints(room, ships, dt) {
  for (const point of room.points) {
    const counts = new Map();

    for (const ship of ships) {
      if (Math.hypot(ship.x - point.x, ship.y - point.y) <= point.radius) {
        const player = room.players.get(ship.ownerId);
        if (!player) continue;
        const current = counts.get(player.team) || { count: 0, ownerId: ship.ownerId };
        current.count += 1;
        counts.set(player.team, current);
      }
    }

    const contenders = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
    point.contested = false;
    if (contenders.length === 0) {
      point.progress = Math.max(0, point.progress - 0.08 * dt);
      continue;
    }

    if (contenders.length > 1 && contenders[0][1].count === contenders[1][1].count) {
      point.contested = true;
      continue;
    }

    const [leaderTeam, leader] = contenders[0];
    const captureRate = (0.1 + leader.count * 0.045) * dt;

    if (point.ownerTeam === leaderTeam) {
      point.progress = Math.min(1, point.progress + captureRate);
    } else {
      point.progress -= captureRate;
      if (point.progress <= 0) {
        point.ownerTeam = leaderTeam;
        point.ownerId = leader.ownerId;
        point.progress = Math.min(1, captureRate * 3);
        for (const player of room.players.values()) {
          if (player.team === leaderTeam) {
            player.captures += 1;
            player.money = Math.min(player.maxMoney || ECONOMY.maxMoney, player.money + ECONOMY.captureBonus);
            player.earned += ECONOMY.captureBonus;
            player.score += 14;
          }
        }
        broadcastRoom(room, {
          type: "notice",
          message: `${teamLabel(room, leaderTeam, "A wing")} captured relay ${point.id}: +$${ECONOMY.captureBonus}, +$${ECONOMY.relayIncome}/s`
        });
      }
    }
  }
}

function updateScoring(room, now) {
  if (room.phase !== "active" || room.winner) return;

  if (now - room.lastScoreAt < 1000) return;
  room.lastScoreAt = now;

  for (const point of room.points) {
    if (!point.ownerTeam || point.progress < 0.98) continue;
    for (const player of room.players.values()) {
      if (player.team === point.ownerTeam) player.score += SCORE_PER_CONTROLLED_POINT;
    }
  }

  const winner = [...room.players.values()]
    .filter((player) => player.score >= room.maxScore)
    .sort((a, b) => b.score - a.score)[0];
  if (winner) {
    room.winner = {
      id: winner.id,
      team: winner.team,
      name: teamLabel(room, winner.team, winner.name)
    };
    room.winnerAt = now;
    room.phase = "ended";
    finalizeMatchRewards(room);
    broadcastRoom(room, { type: "notice", message: `${room.winner.name} won the match` });
  }
}

function finalizeMatchRewards(room) {
  if (!room.winner) return;
  const players = [...room.players.values()];
  for (const player of players) {
    const didWin = player.team === room.winner.team;
    const enemyFleetCost = players
      .filter((other) => other.team !== player.team)
      .reduce((total, other) => total + Math.max(other.deployedFleetCost, getActiveFleetCost(other)), 0);
    const playerFleetCost = Math.max(player.deployedFleetCost, player.spent, getActiveFleetCost(player), 1);
    const survivingFriendlyShips = player.ships.filter((ship) => ship.alive && !ship.removed).length;
    const reward = calculateBattleReward({
      didWin,
      destroyedEnemyCost: player.destroyedEnemyCost,
      enemyFleetCost,
      playerFleetCost,
      survivingFriendlyShips
    });
    player.money = Math.min(player.maxMoney || ECONOMY.maxMoney, player.money + reward.total);
    player.bank = player.money;
    player.earned += reward.total;
    player.lastReward = reward;
  }
}

function calculateBattleReward({ didWin, destroyedEnemyCost, enemyFleetCost, playerFleetCost, survivingFriendlyShips }) {
  const destroyedReward = Math.min(
    destroyedEnemyCost * REWARDS.destroyedEnemyCostMultiplier,
    REWARDS.maxDestroyedReward
  );

  if (!didWin) {
    const lossDestroyed = destroyedEnemyCost * REWARDS.lossDestroyedMultiplier;
    const total = Math.max(REWARDS.minimumLossReward, REWARDS.lossSupport + lossDestroyed);
    return {
      didWin,
      base: 0,
      lossSupport: REWARDS.lossSupport,
      destroyed: Math.round(lossDestroyed),
      victory: 0,
      survival: 0,
      efficiency: 0,
      overpowerMultiplier: 1,
      total: Math.round(total)
    };
  }

  const survivalBonus = survivingFriendlyShips * REWARDS.survivalBonusPerShip;
  let efficiencyBonus = 0;
  if (enemyFleetCost > playerFleetCost) {
    const efficiencyRatio = enemyFleetCost / Math.max(playerFleetCost, 1);
    efficiencyBonus = Math.min((efficiencyRatio - 1) * REWARDS.efficiencyBonusScale, REWARDS.maxEfficiencyBonus);
  }

  let victoryBonus = REWARDS.victoryBonus;
  let overpowerMultiplier = 1;
  if (playerFleetCost > enemyFleetCost * 1.4) {
    const overpowerRatio = playerFleetCost / Math.max(enemyFleetCost, 1);
    overpowerMultiplier = Math.max(REWARDS.minimumOverpowerRewardMultiplier, 1 - ((overpowerRatio - 1.4) * 0.25));
    victoryBonus *= overpowerMultiplier;
  }

  const total = REWARDS.baseReward + destroyedReward + victoryBonus + survivalBonus + efficiencyBonus;
  return {
    didWin,
    base: REWARDS.baseReward,
    destroyed: Math.round(destroyedReward),
    victory: Math.round(victoryBonus),
    survival: Math.round(survivalBonus),
    efficiency: Math.round(efficiencyBonus),
    overpowerMultiplier: round(overpowerMultiplier),
    total: Math.max(REWARDS.minimumWinReward, Math.round(total))
  };
}

function findTarget(room, ship, ships) {
  let best = null;
  let bestDistance = Infinity;
  const range = Math.max(ship.stats.blasterRange, ship.stats.missileRange, 420);

  if (ship.focusTargetId) {
    const focused = ships.find((other) => other.id === ship.focusTargetId && areEnemies(room, ship.ownerId, other.ownerId));
    if (focused) {
      const focusedDistance = Math.hypot(focused.x - ship.x, focused.y - ship.y);
      if (focusedDistance <= Math.max(range, ship.stats.railgunRange) * 1.12 && !isLineBlocked(room, ship.x, ship.y, focused.x, focused.y, 8)) return focused;
    }
  }

  for (const other of ships) {
    if (!other.alive || !areEnemies(room, ship.ownerId, other.ownerId)) continue;
    const distance = Math.hypot(other.x - ship.x, other.y - ship.y);
    if (distance < bestDistance && distance <= Math.max(range, ship.stats.railgunRange) && !isLineBlocked(room, ship.x, ship.y, other.x, other.y, 8)) {
      best = other;
      bestDistance = distance;
    }
  }

  return best;
}

function isLineBlocked(room, x1, y1, x2, y2, margin = 0) {
  for (const asteroid of room.map?.asteroids || []) {
    if (segmentCircleHit(x1, y1, x2, y2, asteroid.x, asteroid.y, asteroid.radius + margin)) return true;
  }
  return false;
}

function snapshotRoom(room, now) {
  const players = [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    color: player.color,
    team: player.team,
    teamName: teamLabel(room, player.team, player.name),
    isBot: player.isBot,
    isAdmin: room.adminId === player.id,
    connected: player.connected !== false,
    ready: player.ready,
    money: Math.floor(player.money),
    income: round(player.income),
    earned: Math.floor(player.earned),
    spent: Math.floor(player.spent),
    shipCap: player.shipCap,
    deploymentBudget: player.deploymentBudget,
    activeFleetCost: getActiveFleetCost(player),
    deployedFleetCost: Math.floor(player.deployedFleetCost),
    destroyedEnemyCost: Math.floor(player.destroyedEnemyCost),
    lastReward: player.lastReward,
    activeShips: player.ships.filter((ship) => ship.alive && !ship.removed).length,
    score: Math.floor(player.score),
    kills: player.kills,
    losses: player.losses,
    captures: player.captures,
    design: player.design,
    stats: summarizeStats(player.stats || computeStats(player.design))
  }));

  const ships = [];
  for (const player of room.players.values()) {
    for (const ship of player.ships) {
      if (ship.removed) continue;
      ships.push({
        id: ship.id,
        ownerId: ship.ownerId,
        x: round(ship.x),
        y: round(ship.y),
        vx: round(ship.vx),
        vy: round(ship.vy),
        angle: round(ship.angle),
        targetX: round(ship.targetX),
        targetY: round(ship.targetY),
        hp: round(ship.hp),
        maxHp: round(ship.maxHp),
        shield: round(ship.shield),
        maxShield: round(ship.maxShield),
        radius: round(ship.radius),
        design: ship.design || [],
        cost: ship.cost || ship.stats?.unitCost || 0,
        focusTargetId: ship.focusTargetId,
        alive: ship.alive,
        respawnIn: 0,
        removeIn: ship.alive ? 0 : Math.max(0, Math.ceil(((ship.removeAt || now) - now) / 1000))
      });
    }
  }

  return {
    type: "state",
    room: room.code,
    phase: room.phase,
    adminId: room.adminId,
    mapSizeLabel: room.mapSizeLabel,
    world: room.world,
    map: room.map,
    players,
    ships,
    bullets: room.bullets.map((bullet) => ({
      id: bullet.id,
      type: bullet.type,
      ownerId: bullet.ownerId,
      x: round(bullet.x),
      y: round(bullet.y),
      vx: round(bullet.vx),
      vy: round(bullet.vy)
    })),
    points: room.points.map((point) => ({
      id: point.id,
      x: point.x,
      y: point.y,
      radius: point.radius,
      ownerId: point.ownerId,
      ownerTeam: point.ownerTeam,
      contested: Boolean(point.contested),
      progress: round(point.progress)
    })),
    effects: room.effects.map((effect) => ({ ...effect, age: Math.max(0, now - effect.at) })),
    winner: room.winner,
    maxScore: room.maxScore,
    time: Math.floor(now)
  };
}

function broadcastRoom(room, data) {
  for (const client of room.clients) send(client, data);
}

function startDesignPhase(room, requester) {
  if (!isAdmin(room, requester)) {
    sendPlayer(room, requester, { type: "error", message: "Only the room admin can start ship design" });
    return;
  }
  if (room.phase !== "lobby") {
    sendPlayer(room, requester, { type: "error", message: "Ship design has already started" });
    return;
  }
  if (room.players.size < 1) return;

  prepareArenaForCurrentPlayers(room);
  room.phase = "design";
  room.winner = null;
  room.winnerAt = 0;
  room.lastScoreAt = performanceNow();
  for (const player of room.players.values()) {
    resetRoundPlayerStats(player);
    player.ready = player.isBot;
    player.lastReadyAt = 0;
    resetPlayerForMatch(room, player, performanceNow(), { spawn: false });
  }
  broadcastRoom(room, { type: "notice", message: `Ship design started on ${room.mapSizeLabel} map` });
}

function maybeStartMatch(room, now) {
  if (room.phase !== "design") return;
  const players = [...room.players.values()];
  if (!players.length || players.some((player) => !player.ready)) return;
  room.phase = "active";
  room.winner = null;
  room.winnerAt = 0;
  room.lastScoreAt = now;
  for (const player of players) {
    resetPlayerForMatch(room, player, now, { spawn: true });
  }
  broadcastRoom(room, { type: "notice", message: "All pilots ready. Match started." });
}

function restartFromEnd(room, requester) {
  if (!isAdmin(room, requester)) {
    sendPlayer(room, requester, { type: "error", message: "Only the room admin can restart the match" });
    return;
  }
  if (room.phase !== "ended") {
    sendPlayer(room, requester, { type: "error", message: "Restart is available after the match ends" });
    return;
  }
  prepareArenaForCurrentPlayers(room);
  room.phase = "design";
  room.winner = null;
  room.winnerAt = 0;
  room.lastScoreAt = performanceNow();
  for (const player of room.players.values()) {
    resetRoundPlayerStats(player);
    player.ready = player.isBot;
    resetPlayerForMatch(room, player, performanceNow(), { spawn: false });
  }
  broadcastRoom(room, { type: "notice", message: "New ship design phase started" });
}

function resetRoundPlayerStats(player) {
  player.score = 0;
  player.kills = 0;
  player.losses = 0;
  player.captures = 0;
  player.destroyedEnemyCost = 0;
  player.lostFleetCost = 0;
  player.deployedFleetCost = 0;
  player.lastReward = null;
  player.lastBuildError = "";
}

function closeLobby(room, requester) {
  if (!isAdmin(room, requester)) {
    sendPlayer(room, requester, { type: "error", message: "Only the room admin can close the lobby" });
    return;
  }
  broadcastRoom(room, { type: "closed", message: "The room admin closed this lobby" });
  for (const client of [...room.clients]) {
    closeClient(client, 1000, "Lobby closed");
  }
  rooms.delete(room.code);
}

function kickPlayer(room, requester, targetId) {
  if (!isAdmin(room, requester)) {
    sendPlayer(room, requester, { type: "error", message: "Only the room admin can kick players" });
    return;
  }
  if (!targetId || targetId === requester.id) {
    sendPlayer(room, requester, { type: "error", message: "Choose another player to kick" });
    return;
  }

  const target = room.players.get(targetId);
  if (!target) {
    sendPlayer(room, requester, { type: "error", message: "That player is no longer in the room" });
    return;
  }

  removePlayerFromRoom(room, target, "kicked");
  room.kickedIds.add(target.id);
  room.kickedNames.add(target.name.toLowerCase());
  broadcastRoom(room, { type: "notice", message: `${target.name} was kicked` });
  if (room.phase === "design") maybeStartMatch(room, performanceNow());
}

function removePlayerFromRoom(room, player, reason) {
  for (const ship of player.ships) {
    ship.alive = false;
    ship.removed = true;
  }
  room.players.delete(player.id);
  room.bullets = room.bullets.filter((bullet) => bullet.ownerId !== player.id);
  for (const point of room.points) {
    if (point.ownerId === player.id) {
      point.ownerId = null;
      point.ownerTeam = null;
      point.progress = 0;
      point.contested = false;
    }
  }

  if (!player.isBot) {
    const client = [...room.clients].find((candidate) => candidate.player?.id === player.id);
    if (client) {
      send(client, { type: "kicked", message: reason === "kicked" ? "You were kicked by the room admin" : "Removed from room" });
      room.clients.delete(client);
      client.room = null;
      client.player = null;
      closeClient(client, 1000, reason === "kicked" ? "Kicked" : "Removed");
    }
  }

  ensureAdmin(room);
}

function prepareArenaForCurrentPlayers(room) {
  const world = chooseWorldSize(Math.max(1, room.players.size));
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

function ensureAdmin(room) {
  if (room.adminId && room.players.has(room.adminId) && !room.players.get(room.adminId).isBot) return;
  const nextAdmin = [...room.players.values()].find((player) => !player.isBot);
  room.adminId = nextAdmin?.id || null;
}

function isAdmin(room, player) {
  return Boolean(room && player && room.adminId === player.id && !player.isBot);
}

function sendPlayer(room, player, data) {
  const client = [...room.clients].find((candidate) => candidate.player?.id === player?.id);
  if (client) send(client, data);
}

function send(client, data) {
  if (client.isClosed || client.socket.destroyed) return;
  try {
    writeFrame(client.socket, JSON.stringify(data));
  } catch {
    closeClient(client, 1011, "Send failed");
  }
}

function closeClient(client, code, reason) {
  if (client.isClosed) return;
  finalizeClient(client);

  const reasonBuffer = Buffer.from(reason || "");
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  try {
    writeFrame(client.socket, payload, 0x8);
  } catch {
    // The socket may already be gone.
  }
  client.socket.destroy();
}

function finalizeClient(client) {
  if (client.isClosed) return;
  client.isClosed = true;
  sockets.delete(client);
  leaveRoom(client);
}

function validateDesign(input) {
  const modules = Array.isArray(input) ? input : DEFAULT_DESIGN;
  const clean = [];
  const occupied = new Set();
  let coreCount = 0;

  for (const raw of modules) {
    const x = Math.trunc(Number(raw?.x));
    const y = Math.trunc(Number(raw?.y));
    const type = String(raw?.type || "");
    const key = `${x},${y}`;

    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 6 || y < 0 || y > 6) continue;
    if (!PARTS[type] || occupied.has(key)) continue;
    if (type === "core") coreCount += 1;

    occupied.add(key);
    clean.push({ x, y, type });
  }

  if (coreCount !== 1) return validateDesign(DEFAULT_DESIGN);
  if (!isConnected(clean)) return validateDesign(DEFAULT_DESIGN);

  return { modules: clean, stats: computeStats(clean) };
}

function isConnected(modules) {
  const keys = new Set(modules.map((part) => `${part.x},${part.y}`));
  const core = modules.find((part) => part.type === "core");
  if (!core) return false;

  const queue = [core];
  const seen = new Set([`${core.x},${core.y}`]);
  for (let i = 0; i < queue.length; i += 1) {
    const part = queue[i];
    const neighbors = [
      [part.x + 1, part.y],
      [part.x - 1, part.y],
      [part.x, part.y + 1],
      [part.x, part.y - 1]
    ];

    for (const [x, y] of neighbors) {
      const key = `${x},${y}`;
      if (keys.has(key) && !seen.has(key)) {
        seen.add(key);
        queue.push({ x, y });
      }
    }
  }

  return seen.size === modules.length;
}

function computeStats(modules) {
  let cost = 0;
  let mass = 0;
  let maxHp = 0;
  let maxShield = 0;
  let shieldRegen = 0;
  let powerGeneration = 0;
  let powerUse = 0;
  let thrust = 0;
  let turnBonus = 0;
  let energyStorage = 0;
  let blaster = 0;
  let missile = 0;
  let railgun = 0;
  let repair = 0;
  let repairRate = 0;
  const weaponTotals = {
    blaster: weaponAccumulator(),
    missile: weaponAccumulator(),
    railgun: weaponAccumulator()
  };

  let minX = 3;
  let maxX = 3;
  let minY = 3;
  let maxY = 3;

  for (const module of modules) {
    const part = PARTS[module.type] || PARTS.frame;
    cost += part.cost;
    mass += part.mass;
    maxHp += part.hp;
    maxShield += part.shield;
    shieldRegen += part.shieldRegen || 0;
    powerGeneration += part.powerGeneration || 0;
    powerUse += part.powerUse || 0;
    thrust += part.thrust;
    turnBonus += part.turn;
    energyStorage += part.energyStorage || 0;
    blaster += part.blaster || 0;
    missile += part.missile || 0;
    railgun += part.railgun || 0;
    repair += part.repair || 0;
    repairRate += part.repairRate || 0;
    if (part.weapon) addWeaponStats(weaponTotals[part.weapon.type], part.weapon);
    minX = Math.min(minX, module.x);
    maxX = Math.max(maxX, module.x);
    minY = Math.min(minY, module.y);
    maxY = Math.max(maxY, module.y);
  }

  const power = powerGeneration - powerUse;
  const powerRatio = powerUse > 0 ? powerGeneration / powerUse : 1.2;
  const efficiency = clampNumber(powerUse > 0 ? 0.58 + powerRatio * 0.42 : 1.08, 0.48, 1.15);
  const thrustRatio = thrust / Math.max(1, mass);
  // Mobility balance: armor and large weapons add mass, while engines add thrust.
  // Speed and acceleration scale from total thrust divided by total mass so heavy ships need more engines.
  const accel = clampNumber(46 + thrustRatio * 46 * clampNumber(efficiency, 0.55, 1.08), 38, 420);
  const maxSpeed = clampNumber(82 + thrustRatio * 21 * clampNumber(efficiency, 0.62, 1.08), 72, 360);
  const turnRate = clampNumber(1.05 + turnBonus + thrustRatio * 0.035, 0.55, 2.85);
  const radius = clampNumber(24 + Math.max(maxX - minX, maxY - minY) * 9 + Math.sqrt(mass) * 1.6, 28, 76);
  const costBreakdown = calculateCostBreakdown({ cost, mass, maxHp, maxShield, repairRate, blaster, missile, railgun });
  const unitCost = costBreakdown.total;
  const fleetCount = clampNumber(Math.floor(260 / Math.max(58, unitCost * 0.72 + mass * 0.45)), 1, 5);
  const weapons = summarizeWeaponTotals(weaponTotals);
  const warnings = shipWarnings({ powerGeneration, powerUse, thrustRatio, blaster, missile, railgun, mass, turnRate, repair, shield: maxShield, modules });

  return {
    cost,
    unitCost,
    mass: round(mass),
    maxHp: Math.max(140, Math.round(maxHp * 0.82)),
    maxShield: Math.round(maxShield * efficiency),
    shieldRegen: round(shieldRegen * clampNumber(efficiency, 0.4, 1.12)),
    powerGeneration,
    powerUse,
    power,
    efficiency: round(efficiency),
    thrust: round(thrust),
    thrustRatio: round(thrustRatio),
    energyStorage,
    accel: round(accel),
    maxSpeed: round(maxSpeed),
    turnRate: round(turnRate),
    blaster,
    missile,
    railgun,
    repair,
    repairRate,
    blasterRange: weaponRange(weaponTotals.blaster),
    missileRange: weaponRange(weaponTotals.missile),
    railgunRange: weaponRange(weaponTotals.railgun),
    blasterDamage: weapons.blaster.damage,
    missileDamage: weapons.missile.damage,
    railgunDamage: weapons.railgun.damage,
    blasterReload: weapons.blaster.reload,
    missileReload: weapons.missile.reload,
    railgunReload: weapons.railgun.reload,
    blasterProjectileSpeed: weapons.blaster.projectileSpeed,
    missileProjectileSpeed: weapons.missile.projectileSpeed,
    railgunProjectileSpeed: weapons.railgun.projectileSpeed,
    blasterAccuracy: weapons.blaster.accuracy,
    missileAccuracy: weapons.missile.accuracy,
    railgunAccuracy: weapons.railgun.accuracy,
    missileTracking: weapons.missile.tracking,
    weaponDps: round(weapons.blaster.dps + weapons.missile.dps + weapons.railgun.dps),
    weapons,
    warnings,
    costBreakdown,
    repairRange: repair > 0 ? 410 : 0,
    radius: round(radius),
    fleetCount
  };
}

function makeWeapon(type, stats) {
  const fireRate = Number(stats.fireRate) || 1;
  const damage = Number(stats.damage) || 0;
  return {
    type,
    damage,
    fireRate,
    reload: calculateReload({ fireRate }),
    range: stats.range,
    projectileSpeed: stats.projectileSpeed,
    accuracy: stats.accuracy,
    tracking: stats.tracking || 0,
    dps: calculateDps({ damage, fireRate })
  };
}

function calculateCostBreakdown(stats) {
  const base = ECONOMY.baseShipCost;
  const parts = stats.cost * ECONOMY.partCostMultiplier;
  const mass = stats.mass * ECONOMY.massCostMultiplier;
  const hull = stats.maxHp * ECONOMY.hullCostMultiplier;
  const shield = stats.maxShield * ECONOMY.shieldCostMultiplier;
  const repair = stats.repairRate * ECONOMY.repairCostMultiplier;
  const weaponPremium =
    stats.blaster * ECONOMY.weaponPremiums.blaster +
    stats.missile * ECONOMY.weaponPremiums.missile +
    stats.railgun * ECONOMY.weaponPremiums.railgun;
  const preTaxTotal = base + parts + mass + hull + shield + repair + weaponPremium;
  const largeTax = Math.max(0, preTaxTotal - ECONOMY.largeShipThreshold) * ECONOMY.largeShipCostTax;
  const hugeTax = Math.max(0, preTaxTotal - ECONOMY.hugeShipThreshold) * ECONOMY.hugeShipCostTax;
  const sizeTax = largeTax + hugeTax;
  return {
    base: Math.round(base),
    parts: Math.round(parts),
    mass: Math.round(mass),
    hull: Math.round(hull),
    shield: Math.round(shield),
    repair: Math.round(repair),
    weaponPremium: Math.round(weaponPremium),
    sizeTax: Math.round(sizeTax),
    total: clampNumber(Math.round(preTaxTotal + sizeTax), 80, 1100)
  };
}

function weaponAccumulator() {
  return { count: 0, damage: 0, range: 0, fireRate: 0, reload: 0, projectileSpeed: 0, accuracy: 0, tracking: 0, dps: 0 };
}

function addWeaponStats(total, weapon) {
  total.count += 1;
  total.damage += weapon.damage;
  total.range = Math.max(total.range, weapon.range);
  total.fireRate += weapon.fireRate;
  total.reload += calculateReload(weapon);
  total.projectileSpeed += weapon.projectileSpeed;
  total.accuracy += weapon.accuracy;
  total.tracking += weapon.tracking || 0;
  total.dps += calculateDps(weapon);
}

function calculateDps(weapon) {
  return Number(((weapon.damage || 0) * (weapon.fireRate || 0)).toFixed(1));
}

function calculateReload(weapon) {
  return round(1 / Math.max(0.01, weapon.fireRate || 1));
}

function weaponRange(total) {
  return total.count > 0 ? total.range : 0;
}

function summarizeWeaponTotals(totals) {
  const result = {};
  for (const [type, total] of Object.entries(totals)) {
    result[type] = {
      count: total.count,
      damage: total.damage,
      range: total.range,
      fireRate: round(total.fireRate),
      reload: total.count ? round(total.reload / total.count) : 0,
      projectileSpeed: total.count ? Math.round(total.projectileSpeed / total.count) : 0,
      accuracy: total.count ? round(total.accuracy / total.count) : 0,
      tracking: total.count ? round(total.tracking / total.count) : 0,
      dps: round(total.dps)
    };
  }
  return result;
}

function shipWarnings(stats) {
  const warnings = [];
  const weaponCount = stats.blaster + stats.missile + stats.railgun;
  const hasReactor = stats.modules.some((module) => module.type === "reactor");
  if (stats.powerGeneration < stats.powerUse) warnings.push(`Power deficit: uses ${stats.powerUse} but generates ${stats.powerGeneration}`);
  if (!hasReactor && stats.powerUse > PARTS.core.powerGeneration) warnings.push("No reactor: high-power systems need stronger generation");
  if (stats.thrustRatio < 3.2 && stats.mass > 18) warnings.push("Low mobility: heavy for its engine power");
  if (stats.mass > 85 || stats.turnRate < 0.85) warnings.push("Heavy ship: turning will be slow");
  if (stats.repair > 0 && stats.powerGeneration < stats.powerUse) warnings.push("Repair installed but power is insufficient");
  if (stats.shield > 0 && stats.powerGeneration < stats.powerUse) warnings.push("Shields installed but power is insufficient");
  if (weaponCount === 0) warnings.push("No weapons: this ship cannot attack");
  return warnings;
}

function summarizeStats(stats) {
  return {
    cost: stats.cost,
    mass: stats.mass,
    hp: stats.maxHp,
    shield: stats.maxShield,
    power: stats.power,
    powerGeneration: stats.powerGeneration,
    powerUse: stats.powerUse,
    thrust: stats.thrust,
    thrustRatio: stats.thrustRatio,
    speed: stats.maxSpeed,
    fleet: stats.fleetCount,
    unitCost: stats.unitCost,
    blaster: stats.blaster,
    missile: stats.missile,
    railgun: stats.railgun,
    repair: stats.repair,
    repairRate: stats.repairRate,
    weaponDps: stats.weaponDps,
    warnings: stats.warnings,
    costBreakdown: stats.costBreakdown,
    efficiency: stats.efficiency
  };
}

function getActiveFleetCost(player) {
  return Math.round(player.ships
    .filter((ship) => ship.alive && !ship.removed)
    .reduce((total, ship) => total + (ship.cost || ship.stats?.unitCost || 0), 0));
}

function getLiveShips(room) {
  const ships = [];
  for (const player of room.players.values()) {
    for (const ship of player.ships) {
      if (ship.alive && !ship.removed) ships.push(ship);
    }
  }
  return ships;
}

function addBot(room, requester) {
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) return;

  const id = `bot${room.nextBotId++}`;
  const color = COLORS[room.colorCursor % COLORS.length];
  room.colorCursor += 1;
  const design = chooseBotDesign(room.nextBotId);
  const team = chooseBotTeam(room, requester, id);
  const name = BOT_NAMES[(room.nextBotId - 2) % BOT_NAMES.length];
  const player = {
    id,
    name,
    color,
    team,
    isBot: true,
    ai: { nextThinkAt: 0, objectiveId: null },
    ready: false,
    design,
    stats: computeStats(design),
    ships: [],
    money: ECONOMY.startingMoney,
    bank: ECONOMY.startingMoney,
    income: ECONOMY.baseIncome,
    earned: ECONOMY.startingMoney,
    spent: 0,
    maxMoney: ECONOMY.maxMoney,
    shipCap: ECONOMY.shipCap,
    deploymentBudget: ECONOMY.deploymentBudget,
    deployedFleetCost: 0,
    destroyedEnemyCost: 0,
    lostFleetCost: 0,
    lastReward: null,
    score: 0,
    kills: 0,
    losses: 0,
    captures: 0,
    connected: true,
    lastReadyAt: 0
  };

  room.players.set(player.id, player);
  broadcastRoom(room, { type: "notice", message: `${player.name} joined as a bot` });
}

function updateBots(room, now) {
  if (room.winner) return;

  for (const player of room.players.values()) {
    if (!player.isBot || !player.ready || now < player.ai.nextThinkAt) continue;
    player.ai.nextThinkAt = now + randomRange(900, 1700);
    const currentCost = player.stats?.unitCost || computeStats(player.design).unitCost;
    if (player.money >= currentCost && player.ships.filter((ship) => ship.alive && !ship.removed).length < player.shipCap) {
      buyShip(room, player, now, { silent: true });
    }
    const ships = player.ships.filter((ship) => ship.alive && !ship.removed);
    if (ships.length === 0) continue;

    const enemies = getLiveShips(room)
      .filter((ship) => areEnemies(room, player.id, ship.ownerId))
      .sort((a, b) => distanceToFleet(ships, a) - distanceToFleet(ships, b));
    const nearestEnemy = enemies[0];

    if (nearestEnemy && distanceToFleet(ships, nearestEnemy) < 760) {
      commandShips(room, player, nearestEnemy.x, nearestEnemy.y, {
        targetId: nearestEnemy.id,
        formation: ships.length > 2 ? "wedge" : "line"
      });
      continue;
    }

    const objective = room.points
      .filter((point) => point.ownerTeam !== player.team || point.progress < 0.95)
      .sort((a, b) => distanceToFleet(ships, a) - distanceToFleet(ships, b))[0] || room.points[Math.floor(Math.random() * room.points.length)];
    commandShips(room, player, objective.x + randomRange(-80, 80), objective.y + randomRange(-80, 80), {
      formation: ships.length > 3 ? "clump" : "line"
    });
  }
}

function chooseBotDesign(seed) {
  const heavy = [
    { x: 3, y: 3, type: "core" },
    { x: 2, y: 3, type: "armor" },
    { x: 4, y: 3, type: "armor" },
    { x: 3, y: 2, type: "shield" },
    { x: 3, y: 4, type: "reactor" },
    { x: 2, y: 4, type: "engine" },
    { x: 4, y: 4, type: "engine" },
    { x: 3, y: 1, type: "railgun" },
    { x: 2, y: 2, type: "blaster" },
    { x: 4, y: 2, type: "blaster" },
    { x: 3, y: 5, type: "battery" }
  ];
  const skirmish = [
    { x: 3, y: 3, type: "core" },
    { x: 2, y: 3, type: "blaster" },
    { x: 4, y: 3, type: "blaster" },
    { x: 3, y: 2, type: "missile" },
    { x: 3, y: 4, type: "reactor" },
    { x: 2, y: 4, type: "engine" },
    { x: 4, y: 4, type: "engine" },
    { x: 1, y: 4, type: "engine" },
    { x: 5, y: 4, type: "engine" },
    { x: 3, y: 5, type: "battery" }
  ];
  const support = [
    { x: 3, y: 3, type: "core" },
    { x: 3, y: 2, type: "shield" },
    { x: 2, y: 3, type: "repair" },
    { x: 4, y: 3, type: "repair" },
    { x: 3, y: 4, type: "reactor" },
    { x: 2, y: 4, type: "engine" },
    { x: 4, y: 4, type: "engine" },
    { x: 2, y: 2, type: "blaster" },
    { x: 4, y: 2, type: "missile" },
    { x: 3, y: 5, type: "battery" }
  ];
  return [heavy, skirmish, support][seed % 3].map((part) => ({ ...part }));
}

function chooseBotTeam(room, requester, fallbackId) {
  if (requester && (requester.team === "blue" || requester.team === "red")) {
    return requester.team === "blue" ? "red" : "blue";
  }

  const blue = [...room.players.values()].filter((player) => player.team === "blue").length;
  const red = [...room.players.values()].filter((player) => player.team === "red").length;
  if (blue || red) return blue <= red ? "blue" : "red";
  return fallbackId;
}

function findShipById(room, id) {
  if (!id) return null;
  for (const player of room.players.values()) {
    const ship = player.ships.find((candidate) => candidate.id === id && candidate.alive && !candidate.removed);
    if (ship) return ship;
  }
  return null;
}

function distanceToFleet(ships, target) {
  let best = Infinity;
  for (const ship of ships) {
    best = Math.min(best, Math.hypot(ship.x - target.x, ship.y - target.y));
  }
  return best;
}

function areAllies(room, ownerA, ownerB) {
  if (ownerA === ownerB) return true;
  const a = room.players.get(ownerA);
  const b = room.players.get(ownerB);
  return Boolean(a && b && a.team === b.team);
}

function areEnemies(room, ownerA, ownerB) {
  if (ownerA === ownerB) return false;
  const a = room.players.get(ownerA);
  const b = room.players.get(ownerB);
  return Boolean(a && b && a.team !== b.team);
}

function resetMatch(room, now) {
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

function getPlayerSpawn(room, playerId) {
  const player = room.players.get(playerId);
  if (player?.team === "blue") {
    const teamMates = [...room.players.values()].filter((candidate) => candidate.team === "blue").map((candidate) => candidate.id).sort();
    const index = Math.max(0, teamMates.indexOf(playerId));
    const lanes = [0.32, 0.5, 0.68, 0.2, 0.8, 0.42, 0.58];
    return { x: 260, y: room.world.height * lanes[index % lanes.length], angle: 0 };
  }
  if (player?.team === "red") {
    const teamMates = [...room.players.values()].filter((candidate) => candidate.team === "red").map((candidate) => candidate.id).sort();
    const index = Math.max(0, teamMates.indexOf(playerId));
    const lanes = [0.68, 0.5, 0.32, 0.8, 0.2, 0.58, 0.42];
    return { x: room.world.width - 260, y: room.world.height * lanes[index % lanes.length], angle: Math.PI };
  }

  const ids = [...room.players.keys()].sort();
  const index = Math.max(0, ids.indexOf(playerId));
  const slots = [
    { x: 260, y: room.world.height * 0.5, angle: 0 },
    { x: room.world.width - 260, y: room.world.height * 0.5, angle: Math.PI },
    { x: room.world.width * 0.5, y: 220, angle: Math.PI / 2 },
    { x: room.world.width * 0.5, y: room.world.height - 220, angle: -Math.PI / 2 },
    { x: 340, y: 260, angle: 0.35 },
    { x: room.world.width - 340, y: room.world.height - 260, angle: Math.PI + 0.35 },
    { x: room.world.width - 340, y: 260, angle: Math.PI - 0.35 },
    { x: 340, y: room.world.height - 260, angle: -0.35 }
  ];
  return slots[index % slots.length];
}

function sanitizeName(name, fallback) {
  const clean = String(name || "").replace(/[^\w .-]/g, "").trim().slice(0, 18);
  return clean || fallback;
}

function sanitizeTeam(team, fallbackId) {
  const clean = String(team || "").toLowerCase();
  if (clean === "blue" || clean === "red") return clean;
  return fallbackId;
}

function sanitizeFormation(formation) {
  const clean = String(formation || "").toLowerCase();
  if (clean === "wedge" || clean === "clump") return clean;
  return "line";
}

function teamLabel(room, team, fallback) {
  if (TEAM_NAMES[team]) return TEAM_NAMES[team];
  const owner = room.players.get(team);
  return owner?.name || fallback || "Solo";
}

function sanitizeRoomCode(room) {
  return String(room || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
}

function makeRoomCode() {
  let code = "";
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  do {
    code = "";
    for (let i = 0; i < 5; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  } while (rooms.has(code));
  return code;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function randomRange(min, max) {
  return min + Math.random() * (max - min);
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

function angleDifference(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

function rotateToward(current, target, maxStep) {
  const diff = angleDifference(current, target);
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function performanceNow() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function getLocalUrls(port) {
  const urls = [];
  for (const values of Object.values(os.networkInterfaces())) {
    for (const net of values || []) {
      if (net.family === "IPv4" && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}
