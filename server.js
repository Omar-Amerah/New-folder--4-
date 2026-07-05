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
const TICK_HZ = 30;
const SNAPSHOT_HZ = 15;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PLAYERS_PER_ROOM = 12;
const ROOM_IDLE_MS = 15 * 60 * 1000;
const MATCH_SCORE = 900;
const ECONOMY = Object.freeze({
  startingMoney: 320,
  baseIncome: 13,
  relayIncome: 7,
  killBountyRatio: 0.28,
  killBountyMin: 24,
  captureBonus: 55,
  shipCap: 14
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
  core: { cost: 0, mass: 7, hp: 120, power: 3, shield: 30, thrust: 0, turn: 0, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  frame: { cost: 4, mass: 2, hp: 38, power: 0, shield: 0, thrust: 0, turn: 0, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  armor: { cost: 9, mass: 6, hp: 115, power: 0, shield: 0, thrust: 0, turn: -0.03, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  engine: { cost: 13, mass: 4, hp: 52, power: -1, shield: 0, thrust: 120, turn: 0.32, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  reactor: { cost: 12, mass: 5, hp: 58, power: 6, shield: 0, thrust: 0, turn: 0.02, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  battery: { cost: 10, mass: 3, hp: 42, power: 2, shield: 52, thrust: 0, turn: 0.01, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  shield: { cost: 16, mass: 5, hp: 48, power: -2, shield: 95, thrust: 0, turn: 0, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  blaster: { cost: 15, mass: 5, hp: 46, power: -2, shield: 0, thrust: 0, turn: -0.02, blaster: 1, missile: 0, railgun: 0, repair: 0 },
  missile: { cost: 22, mass: 7, hp: 54, power: -3, shield: 0, thrust: 0, turn: -0.03, blaster: 0, missile: 1, railgun: 0, repair: 0 },
  railgun: { cost: 24, mass: 8, hp: 58, power: -4, shield: 0, thrust: 0, turn: -0.04, blaster: 0, missile: 0, railgun: 1, repair: 0 },
  repair: { cost: 18, mass: 5, hp: 50, power: -2, shield: 28, thrust: 0, turn: -0.01, blaster: 0, missile: 0, railgun: 0, repair: 1 }
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
    const design = validateDesign(message.design);
    const wasReady = client.player.ready;
    client.player.design = design.modules;
    client.player.stats = design.stats;
    client.player.ready = true;
    if (!wasReady) {
      buyShip(client.room, client.player, performanceNow(), { starter: true });
    }
    broadcastRoom(client.room, { type: "notice", message: `${client.player.name} loaded a blueprint` });
    return;
  }

  if (message.type === "buyShip") {
    const count = clampNumber(message.count, 1, 5);
    let built = 0;
    for (let i = 0; i < count; i += 1) {
      if (buyShip(client.room, client.player, performanceNow())) built += 1;
      else break;
    }
    if (built === 0) {
      send(client, { type: "error", message: "Not enough money or fleet cap reached" });
    }
    return;
  }

  if (message.type === "command") {
    const x = clampNumber(message.x, 0, WORLD.width);
    const y = clampNumber(message.y, 0, WORLD.height);
    commandShips(client.room, client.player, x, y, {
      shipIds: Array.isArray(message.shipIds) ? message.shipIds : null,
      targetId: typeof message.targetId === "string" ? message.targetId : null,
      formation: sanitizeFormation(message.formation)
    });
    return;
  }

  if (message.type === "setTeam") {
    client.player.team = sanitizeTeam(message.team, client.player.id);
    broadcastRoom(client.room, { type: "notice", message: `${client.player.name} changed wing` });
    return;
  }

  if (message.type === "addBot") {
    addBot(client.room, client.player);
    return;
  }

  if (message.type === "setName") {
    client.player.name = sanitizeName(message.name, client.player.name);
    return;
  }
}

function joinRoom(client, message) {
  const requestedCode = sanitizeRoomCode(message.room);
  const code = requestedCode || makeRoomCode();
  let room = rooms.get(code);

  if (!room) {
    room = createRoom(code);
    rooms.set(code, room);
  }

  if (room.players.size >= MAX_PLAYERS_PER_ROOM && !room.clients.has(client)) {
    send(client, { type: "error", message: "Room is full" });
    return;
  }

  leaveRoom(client);

  const color = COLORS[room.colorCursor % COLORS.length];
  room.colorCursor += 1;

  const player = {
    id: client.id,
    name: sanitizeName(message.name, `Pilot ${client.id.slice(1)}`),
    color,
    team: sanitizeTeam(message.team, client.id),
    isBot: false,
    ai: null,
    ready: false,
    design: DEFAULT_DESIGN.map((part) => ({ ...part })),
    stats: computeStats(DEFAULT_DESIGN),
    ships: [],
    money: ECONOMY.startingMoney,
    income: ECONOMY.baseIncome,
    earned: ECONOMY.startingMoney,
    spent: 0,
    maxMoney: 1800,
    shipCap: ECONOMY.shipCap,
    score: 0,
    kills: 0,
    losses: 0,
    captures: 0,
    connected: true
  };

  client.room = room;
  client.player = player;
  room.clients.add(client);
  room.players.set(player.id, player);
  room.lastEmptyAt = 0;

  send(client, { type: "joined", id: client.id, room: room.code, world: WORLD });
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
      broadcastRoom(room, { type: "notice", message: `${player.name} left` });
    }
  }

  client.room = null;
  client.player = null;
}

function createRoom(code) {
  return {
    code,
    clients: new Set(),
    players: new Map(),
    bullets: [],
    effects: [],
    points: [
      { id: "A", x: WORLD.width * 0.23, y: WORLD.height * 0.35, radius: 145, ownerId: null, ownerTeam: null, progress: 0 },
      { id: "B", x: WORLD.width * 0.5, y: WORLD.height * 0.56, radius: 155, ownerId: null, ownerTeam: null, progress: 0 },
      { id: "C", x: WORLD.width * 0.77, y: WORLD.height * 0.35, radius: 145, ownerId: null, ownerTeam: null, progress: 0 }
    ],
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

function tickRoom(room, dt, now) {
  updateBots(room, now);
  updateEconomy(room, dt);
  updateDestroyedShips(room, now);

  const ships = getLiveShips(room);
  for (const ship of ships) {
    updateShipMovement(ship, dt);
  }

  updateShipSeparation(ships, dt);
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
  const stats = player.stats || computeStats(player.design);
  const activeCount = player.ships.filter((ship) => !ship.removed && ship.alive).length;
  if (activeCount >= player.shipCap) return false;
  if (player.money < stats.unitCost) return false;

  player.money -= stats.unitCost;
  player.spent += stats.unitCost;
  spawnShip(room, player, now, activeCount);
  if (!options.starter) {
    broadcastRoom(room, { type: "notice", message: `${player.name} built a ship for $${stats.unitCost}` });
  }
  return true;
}

function spawnShip(room, player, now, index = 0) {
  const stats = player.stats || computeStats(player.design);
  const spawn = getPlayerSpawn(room, player.id);
  const offset = index - Math.floor(player.shipCap / 2);
  const ySpread = Math.sin(index * 1.7) * 54;
  const ship = {
    id: `s${room.nextEntityId++}`,
    ownerId: player.id,
    x: clampNumber(spawn.x + offset * 16 + randomRange(-26, 26), 42, WORLD.width - 42),
    y: clampNumber(spawn.y + ySpread + randomRange(-32, 32), 42, WORLD.height - 42),
    vx: 0,
    vy: 0,
    angle: spawn.angle,
    targetX: WORLD.width / 2,
    targetY: WORLD.height / 2,
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

function resetPlayerForMatch(room, player, now) {
  for (const oldShip of player.ships) oldShip.removed = true;
  player.ships = [];
  player.money = ECONOMY.startingMoney;
  player.income = ECONOMY.baseIncome;
  player.earned = ECONOMY.startingMoney;
  player.spent = 0;
  room.bullets = room.bullets.filter((bullet) => bullet.ownerId !== player.id);
  if (player.ready) {
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
    ship.targetX = clampNumber(x + offset.x, 35, WORLD.width - 35);
    ship.targetY = clampNumber(y + offset.y, 35, WORLD.height - 35);
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
    player.money = Math.min(player.maxMoney || 1800, player.money + gained);
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

function updateShipMovement(ship, dt) {
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

  ship.x = clampNumber(ship.x + ship.vx * dt, 42, WORLD.width - 42);
  ship.y = clampNumber(ship.y + ship.vy * dt, 42, WORLD.height - 42);

  if (ship.x <= 43 || ship.x >= WORLD.width - 43) ship.vx *= -0.35;
  if (ship.y <= 43 || ship.y >= WORLD.height - 43) ship.vy *= -0.35;

  if (ship.maxShield > 0) {
    ship.shield = Math.min(ship.maxShield, ship.shield + stats.shieldRegen * dt);
  }
}

function updateShipSeparation(ships, dt) {
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
      a.x = clampNumber(a.x - nx * push, 42, WORLD.width - 42);
      a.y = clampNumber(a.y - ny * push, 42, WORLD.height - 42);
      b.x = clampNumber(b.x + nx * push, 42, WORLD.width - 42);
      b.y = clampNumber(b.y + ny * push, 42, WORLD.height - 42);

      const impulse = push * dt * 9;
      a.vx -= nx * impulse;
      a.vy -= ny * impulse;
      b.vx += nx * impulse;
      b.vy += ny * impulse;
    }
  }
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
    const heal = 15 * ship.stats.repair * ship.stats.efficiency * dt;
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
    for (let i = 0; i < shots; i += 1) {
      const spread = (i - (shots - 1) / 2) * 0.06 + randomRange(-0.025, 0.025);
      addBullet(room, {
        type: "bolt",
        ownerId: ship.ownerId,
        targetId: target.id,
        x: ship.x + Math.cos(aim) * (ship.radius + 8),
        y: ship.y + Math.sin(aim) * (ship.radius + 8),
        vx: Math.cos(aim + spread) * 620 + ship.vx * 0.25,
        vy: Math.sin(aim + spread) * 620 + ship.vy * 0.25,
        damage: 13 * ship.stats.efficiency,
        life: 1.25,
        bornAt: now
      });
    }
    ship.blasterCooldown = Math.max(0.18, 0.82 / Math.sqrt(ship.stats.blaster));
  }

  if (ship.stats.missile > 0 && distance <= ship.stats.missileRange && ship.missileCooldown <= 0) {
    addBullet(room, {
      type: "missile",
      ownerId: ship.ownerId,
      targetId: target.id,
      x: ship.x + Math.cos(aim) * (ship.radius + 12),
      y: ship.y + Math.sin(aim) * (ship.radius + 12),
      vx: Math.cos(aim) * 300 + ship.vx * 0.15,
      vy: Math.sin(aim) * 300 + ship.vy * 0.15,
      damage: 42 * ship.stats.efficiency,
      life: 2.8,
      bornAt: now
    });
    ship.missileCooldown = Math.max(1.1, 2.75 / Math.sqrt(ship.stats.missile));
  }

  if (ship.stats.railgun > 0 && distance <= ship.stats.railgunRange && ship.railgunCooldown <= 0) {
    addBullet(room, {
      type: "rail",
      ownerId: ship.ownerId,
      targetId: target.id,
      x: ship.x + Math.cos(aim) * (ship.radius + 15),
      y: ship.y + Math.sin(aim) * (ship.radius + 15),
      vx: Math.cos(aim) * 980 + ship.vx * 0.12,
      vy: Math.sin(aim) * 980 + ship.vy * 0.12,
      damage: 58 * ship.stats.railgun * ship.stats.efficiency,
      life: 1.15,
      bornAt: now
    });
    ship.railgunCooldown = Math.max(1.55, 3.4 / Math.sqrt(ship.stats.railgun));
  }
}

function addBullet(room, bullet) {
  bullet.id = `b${room.nextEntityId++}`;
  room.bullets.push(bullet);
}

function updateBullets(room, dt, now) {
  const liveShips = getLiveShips(room);
  const byId = new Map(liveShips.map((ship) => [ship.id, ship]));
  const kept = [];

  for (const bullet of room.bullets) {
    bullet.life -= dt;
    if (bullet.life <= 0) continue;

    if (bullet.type === "missile") {
      const target = byId.get(bullet.targetId);
      if (target && areEnemies(room, bullet.ownerId, target.ownerId)) {
        const desired = Math.atan2(target.y - bullet.y, target.x - bullet.x);
        const current = Math.atan2(bullet.vy, bullet.vx);
        const next = rotateToward(current, desired, 2.8 * dt);
        const speed = Math.min(460, Math.hypot(bullet.vx, bullet.vy) + 95 * dt);
        bullet.vx = Math.cos(next) * speed;
        bullet.vy = Math.sin(next) * speed;
      }
    }

    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;

    if (bullet.x < -80 || bullet.x > WORLD.width + 80 || bullet.y < -80 || bullet.y > WORLD.height + 80) {
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
  if (victim) victim.losses += 1;

  const attacker = room.players.get(attackerId);
  if (attacker && attacker.id !== ship.ownerId) {
    const bounty = Math.max(ECONOMY.killBountyMin, Math.round((ship.cost || ship.stats?.unitCost || 100) * ECONOMY.killBountyRatio));
    attacker.kills += 1;
    attacker.money = Math.min(attacker.maxMoney || 1800, attacker.money + bounty);
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
    if (contenders.length === 0) {
      point.progress = Math.max(0, point.progress - 0.08 * dt);
      continue;
    }

    if (contenders.length > 1 && contenders[0][1].count === contenders[1][1].count) {
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
            player.money = Math.min(player.maxMoney || 1800, player.money + ECONOMY.captureBonus);
            player.earned += ECONOMY.captureBonus;
            player.score += 14;
          }
        }
      }
    }
  }
}

function updateScoring(room, now) {
  if (room.winner) {
    if (now - room.winnerAt > 8000) resetMatch(room, now);
    return;
  }

  if (now - room.lastScoreAt < 1000) return;
  room.lastScoreAt = now;

  for (const point of room.points) {
    if (!point.ownerTeam || point.progress < 0.98) continue;
    for (const player of room.players.values()) {
      if (player.team === point.ownerTeam) player.score += 6;
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
    broadcastRoom(room, { type: "notice", message: `${room.winner.name} won the match` });
  }
}

function findTarget(room, ship, ships) {
  let best = null;
  let bestDistance = Infinity;
  const range = Math.max(ship.stats.blasterRange, ship.stats.missileRange, 420);

  if (ship.focusTargetId) {
    const focused = ships.find((other) => other.id === ship.focusTargetId && areEnemies(room, ship.ownerId, other.ownerId));
    if (focused) {
      const focusedDistance = Math.hypot(focused.x - ship.x, focused.y - ship.y);
      if (focusedDistance <= Math.max(range, ship.stats.railgunRange) * 1.12) return focused;
    }
  }

  for (const other of ships) {
    if (!other.alive || !areEnemies(room, ship.ownerId, other.ownerId)) continue;
    const distance = Math.hypot(other.x - ship.x, other.y - ship.y);
    if (distance < bestDistance && distance <= Math.max(range, ship.stats.railgunRange)) {
      best = other;
      bestDistance = distance;
    }
  }

  return best;
}

function snapshotRoom(room, now) {
  const players = [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    color: player.color,
    team: player.team,
    teamName: teamLabel(room, player.team, player.name),
    isBot: player.isBot,
    ready: player.ready,
    money: Math.floor(player.money),
    income: round(player.income),
    earned: Math.floor(player.earned),
    spent: Math.floor(player.spent),
    shipCap: player.shipCap,
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
    world: WORLD,
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

  for (const raw of modules.slice(0, 36)) {
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
  let power = 0;
  let thrust = 0;
  let turnBonus = 0;
  let blaster = 0;
  let missile = 0;
  let railgun = 0;
  let repair = 0;

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
    power += part.power;
    thrust += part.thrust;
    turnBonus += part.turn;
    blaster += part.blaster;
    missile += part.missile;
    railgun += part.railgun;
    repair += part.repair;
    minX = Math.min(minX, module.x);
    maxX = Math.max(maxX, module.x);
    minY = Math.min(minY, module.y);
    maxY = Math.max(maxY, module.y);
  }

  const efficiency = clampNumber(0.72 + power * 0.045, 0.45, 1.25);
  const baseAccel = 70 + thrust / Math.max(1, mass) * 38;
  const accel = baseAccel * clampNumber(efficiency, 0.55, 1.12);
  const maxSpeed = clampNumber(115 + thrust / Math.max(1, mass) * 17, 105, 360);
  const turnRate = clampNumber(1.2 + turnBonus + thrust / Math.max(55, mass * 20), 0.65, 2.85);
  const radius = clampNumber(24 + Math.max(maxX - minX, maxY - minY) * 9 + Math.sqrt(mass) * 1.6, 28, 76);
  const fleetCount = clampNumber(Math.floor(225 / Math.max(44, cost + mass * 0.32)), 1, 5);
  const unitCost = clampNumber(Math.round(
    55 +
    cost * 0.85 +
    mass * 1.1 +
    maxHp * 0.015 +
    maxShield * 0.04 +
    blaster * 14 +
    missile * 24 +
    railgun * 34 +
    repair * 22
  ), 95, 460);

  return {
    cost,
    unitCost,
    mass: round(mass),
    maxHp: Math.max(140, Math.round(maxHp * 0.82)),
    maxShield: Math.round(maxShield * efficiency),
    power,
    efficiency: round(efficiency),
    accel: round(accel),
    maxSpeed: round(maxSpeed),
    turnRate: round(turnRate),
    shieldRegen: round((1.5 + maxShield * 0.018) * clampNumber(efficiency, 0.35, 1.15)),
    blaster,
    missile,
    railgun,
    repair,
    blasterRange: blaster > 0 ? 570 : 0,
    missileRange: missile > 0 ? 820 : 0,
    railgunRange: railgun > 0 ? 980 : 0,
    repairRange: repair > 0 ? 410 : 0,
    radius: round(radius),
    fleetCount
  };
}

function summarizeStats(stats) {
  return {
    cost: stats.cost,
    mass: stats.mass,
    hp: stats.maxHp,
    shield: stats.maxShield,
    power: stats.power,
    speed: stats.maxSpeed,
    fleet: stats.fleetCount,
    unitCost: stats.unitCost,
    blaster: stats.blaster,
    missile: stats.missile,
    railgun: stats.railgun,
    repair: stats.repair,
    efficiency: stats.efficiency
  };
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
    ready: true,
    design,
    stats: computeStats(design),
    ships: [],
    money: ECONOMY.startingMoney,
    income: ECONOMY.baseIncome,
    earned: ECONOMY.startingMoney,
    spent: 0,
    maxMoney: 1800,
    shipCap: ECONOMY.shipCap,
    score: 0,
    kills: 0,
    losses: 0,
    captures: 0,
    connected: true
  };

  room.players.set(player.id, player);
  buyShip(room, player, performanceNow(), { starter: true });
  broadcastRoom(room, { type: "notice", message: `${player.name} joined as a bot` });
}

function updateBots(room, now) {
  if (room.winner) return;

  for (const player of room.players.values()) {
    if (!player.isBot || !player.ready || now < player.ai.nextThinkAt) continue;
    player.ai.nextThinkAt = now + randomRange(900, 1700);
    const currentCost = player.stats?.unitCost || computeStats(player.design).unitCost;
    if (player.money >= currentCost && player.ships.filter((ship) => ship.alive && !ship.removed).length < player.shipCap) {
      buyShip(room, player, now, { starter: true });
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
    player.score = 0;
    player.kills = 0;
    player.losses = 0;
    player.captures = 0;
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
    return { x: 260, y: WORLD.height * lanes[index % lanes.length], angle: 0 };
  }
  if (player?.team === "red") {
    const teamMates = [...room.players.values()].filter((candidate) => candidate.team === "red").map((candidate) => candidate.id).sort();
    const index = Math.max(0, teamMates.indexOf(playerId));
    const lanes = [0.68, 0.5, 0.32, 0.8, 0.2, 0.58, 0.42];
    return { x: WORLD.width - 260, y: WORLD.height * lanes[index % lanes.length], angle: Math.PI };
  }

  const ids = [...room.players.keys()].sort();
  const index = Math.max(0, ids.indexOf(playerId));
  const slots = [
    { x: 260, y: WORLD.height * 0.5, angle: 0 },
    { x: WORLD.width - 260, y: WORLD.height * 0.5, angle: Math.PI },
    { x: WORLD.width * 0.5, y: 220, angle: Math.PI / 2 },
    { x: WORLD.width * 0.5, y: WORLD.height - 220, angle: -Math.PI / 2 },
    { x: 340, y: 260, angle: 0.35 },
    { x: WORLD.width - 340, y: WORLD.height - 260, angle: Math.PI + 0.35 },
    { x: WORLD.width - 340, y: 260, angle: Math.PI - 0.35 },
    { x: 340, y: WORLD.height - 260, angle: -0.35 }
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
