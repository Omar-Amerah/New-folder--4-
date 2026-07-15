"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const { URL } = require("url");

// Load configuration and utilities
const { PORT, PUBLIC_DIR, MIME, TICK_HZ, SNAPSHOT_HZ, ROOM_IDLE_MS } = require("./src/server/config");
const { COMPONENT_BALANCE } = require("./src/server/components");
const { performanceNow, getLocalUrls } = require("./src/server/utils");
const { rooms, pruneClosedRoomCodes } = require("./src/server/rooms");
const transport = require("./src/server/websocketServer");
const messages = require("./src/server/messages");
const { broadcastSnapshot } = require("./src/server/snapshotDelivery");
const { tickRoom } = require("./src/server/simulation");

// In-memory static file cache (validated against file mtime) with pre-compressed
// gzip variants for text assets — avoids re-reading and re-sending full payloads.
const staticCache = new Map();
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".json", ".svg"]);
const componentBalanceJson = JSON.stringify(COMPONENT_BALANCE);
const componentBalanceGzip = zlib.gzipSync(componentBalanceJson);

function acceptsGzip(req) {
  return /\bgzip\b/.test(req.headers["accept-encoding"] || "");
}

function serveBuffer(req, res, { data, gzip, contentType, cacheControl }) {
  const headers = {
    "content-type": contentType,
    "cache-control": cacheControl,
    "vary": "Accept-Encoding"
  };
  if (gzip && acceptsGzip(req)) {
    headers["content-encoding"] = "gzip";
    res.writeHead(200, headers);
    res.end(gzip);
    return;
  }
  res.writeHead(200, headers);
  res.end(data);
}

// Development-only turret aim diagnostics (never enabled in production unless
// MFA_TURRET_DEBUG=1 is set explicitly). Returns the full per-weapon aim/fire
// decision state for a room so live tracking issues can be inspected without
// bloating normal snapshots.
const TURRET_DEBUG_ENABLED = process.env.NODE_ENV !== "production" || process.env.MFA_TURRET_DEBUG === "1";

function handleTurretDebugRequest(requestUrl, res) {
  const { buildShipTurretDiagnostics } = require("./src/server/combat");
  const { SERVER_BUILD_SHA, PROTOCOL_VERSION } = require("./src/server/buildInfo");
  const roomCode = String(requestUrl.searchParams.get("room") || "").toUpperCase();
  const shipId = requestUrl.searchParams.get("ship") || null;
  const room = rooms.get(roomCode);
  if (!room) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "room not found", room: roomCode }));
    return;
  }
  const ships = [];
  for (const ship of room.ships.values()) {
    if (ship.removed || (shipId && ship.id !== shipId)) continue;
    ships.push({ shipId: ship.id, alive: ship.alive, turrets: buildShipTurretDiagnostics(room, ship) });
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({
    room: roomCode,
    phase: room.phase,
    protocolVersion: PROTOCOL_VERSION,
    serverBuildSha: SERVER_BUILD_SHA,
    ships
  }));
}

// HTTP request handler for static files and balance JSON
function handleHttpRequest(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === "/") pathname = "/index.html";

  if (pathname === "/debug/turrets") {
    if (!TURRET_DEBUG_ENABLED) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    handleTurretDebugRequest(requestUrl, res);
    return;
  }

  if (pathname === "/component-balance.json") {
    serveBuffer(req, res, {
      data: componentBalanceJson,
      gzip: componentBalanceGzip,
      contentType: MIME[".json"],
      cacheControl: "no-store"
    });
    return;
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  const cacheControl = ext === ".html" ? "no-store" : "public, max-age=600";

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const cached = staticCache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      serveBuffer(req, res, { data: cached.data, gzip: cached.gzip, contentType, cacheControl });
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const gzip = COMPRESSIBLE.has(ext) ? zlib.gzipSync(data) : null;
      staticCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, data, gzip });
      serveBuffer(req, res, { data, gzip, contentType, cacheControl });
    });
  });
}


function createGameServer(options = {}) {
  const port = options.port ?? PORT;
  const host = options.host || "0.0.0.0";
  const httpServer = http.createServer(handleHttpRequest);
  const timers = new Map();
  const diagnosticsState = { started: false, stopped: true, shutdown: "idle" };
  let lastTick = performanceNow();

  messages.configureOutbound?.({ writeFrame: transport.writeFrame, closeClient: transport.closeClient });
  transport.configureTransport({ handleMessage: messages.handleMessage, send: messages.send, resetOutbound: messages.resetOutbound });

  httpServer.on("upgrade", (req, socket) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { socket.destroy(); return; }
    if (url.pathname !== "/socket" || req.headers.upgrade?.toLowerCase() !== "websocket") { socket.destroy(); return; }
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
    transport.createClient(socket);
  });

  function start() {
    if (diagnosticsState.started) throw new Error("Server already started");
    return new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        diagnosticsState.started = true; diagnosticsState.stopped = false;
        timers.set("cleanup", setInterval(() => { const now = Date.now(); pruneClosedRoomCodes(now); for (const room of rooms.values()) if (room.clients.size === 0 && now - room.lastEmptyAt > ROOM_IDLE_MS) rooms.delete(room.code); }, 60_000));
        timers.set("simulation", setInterval(() => { const now = performanceNow(); const dt = Math.min(0.06, Math.max(0.001, (now - lastTick) / 1000)); lastTick = now; for (const room of rooms.values()) tickRoom(room, dt, now); }, 1000 / TICK_HZ));
        timers.set("snapshot", setInterval(() => { const now = performanceNow(); for (const room of rooms.values()) if (room.phase === "active") broadcastSnapshot(room, now); }, 1000 / SNAPSHOT_HZ));
        for (const t of timers.values()) t.unref?.();
        httpServer.removeListener("error", reject);
        resolve(api);
      });
    });
  }

  function stop() {
    if (diagnosticsState.stopped) return Promise.resolve();
    diagnosticsState.shutdown = "stopping";
    for (const t of timers.values()) clearInterval(t); timers.clear();
    for (const client of Array.from(transport.sockets)) transport.closeClient(client, 1001, "server-shutdown");
    return new Promise((resolve) => {
      const done = () => { diagnosticsState.started = false; diagnosticsState.stopped = true; diagnosticsState.shutdown = "stopped"; resolve(); };
      const timeout = setTimeout(done, options.closeTimeoutMs || 1500); timeout.unref?.();
      httpServer.close(() => { clearTimeout(timeout); done(); });
    });
  }

  function address() { return httpServer.address(); }
  function diagnostics() { return { ...diagnosticsState, activeClients: transport.sockets.size, activeRooms: rooms.size, activeTimers: Array.from(timers.keys()) }; }
  const api = { start, stop, address, diagnostics, server: httpServer };
  return api;
}

if (require.main === module) {
  const instance = createGameServer();
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return; shuttingDown = true;
    instance.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  instance.start().then(() => {
    const actual = instance.address()?.port || PORT;
    console.log(`Modular Fleet Arena running on http://localhost:${actual}`);
    for (const address of getLocalUrls(actual)) console.log(`LAN: ${address}`);
  }).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { createGameServer, handleHttpRequest, handleTurretDebugRequest };
