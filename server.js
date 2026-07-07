"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

// Load configuration and utilities
const { PORT, PUBLIC_DIR, MIME, TICK_HZ, SNAPSHOT_HZ, ROOM_IDLE_MS } = require("./src/server/config");
const { COMPONENT_BALANCE } = require("./src/server/components");
const { performanceNow, getLocalUrls } = require("./src/server/utils");
const { rooms, pruneClosedRoomCodes } = require("./src/server/rooms");
const { sockets, createClient } = require("./src/server/websocketServer");
const { broadcastSnapshot } = require("./src/server/messages");

// Modular game loop ticks
const { updateBots } = require("./src/server/ships");
const { updateEconomy } = require("./src/server/economy");
const { updateDestroyedShips } = require("./src/server/combat");
const { getLiveShips } = require("./src/server/ships");
const { updateShipMovement, updateShipSeparation, resolveFleetMapCollisions } = require("./src/server/movement");
const { updateShipSupport, updateShipWeapons } = require("./src/server/combat");
const { updateBullets } = require("./src/server/projectiles");
const { updateCapturePoints, updateScoring } = require("./src/server/objectives");

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

// HTTP request handler for static files and balance JSON
function handleHttpRequest(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === "/") pathname = "/index.html";

  if (pathname === "/component-balance.json") {
    res.writeHead(200, {
      "content-type": MIME[".json"],
      "cache-control": "no-store"
    });
    res.end(JSON.stringify(COMPONENT_BALANCE));
    return;
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
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

const server = http.createServer(handleHttpRequest);

// WebSocket handshake handler
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

  createClient(socket);
});

// Start HTTP server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Modular Fleet Arena running on http://localhost:${PORT}`);
  for (const address of getLocalUrls(PORT)) {
    console.log(`LAN: ${address}`);
  }
});

// Periodic room cleanup
setInterval(() => {
  const now = Date.now();
  pruneClosedRoomCodes(now);
  for (const room of rooms.values()) {
    if (room.clients.size === 0 && now - room.lastEmptyAt > ROOM_IDLE_MS) {
      rooms.delete(room.code);
    }
  }
}, 60_000).unref();

// Game simulation tick loop
let lastTick = performanceNow();
setInterval(() => {
  const now = performanceNow();
  const dt = Math.min(0.06, Math.max(0.001, (now - lastTick) / 1000));
  lastTick = now;

  for (const room of rooms.values()) {
    tickRoom(room, dt, now);
  }
}, 1000 / TICK_HZ).unref();

// Client state snapshot broadcast loop
setInterval(() => {
  const now = performanceNow();
  for (const room of rooms.values()) {
    broadcastSnapshot(room, now);
  }
}, 1000 / SNAPSHOT_HZ).unref();
