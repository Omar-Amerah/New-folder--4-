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
const { SERVER_BUILD_SHA, PROTOCOL_VERSION } = require("./src/server/buildInfo");
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
    headers["content-length"] = gzip.length;
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : gzip);
    return;
  }
  headers["content-length"] = data.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : data);
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


function sendUpgradeError(socket, status, message, headers = {}) {
  const reason = message || http.STATUS_CODES[status] || "Error";
  const lines = [`HTTP/1.1 ${status} ${reason}`, "Connection: close", "Content-Type: text/plain; charset=utf-8"];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  lines.push("", reason);
  try { socket.write(lines.join("\r\n")); } finally { socket.destroy(); }
}

function headerValues(req, name) {
  const out = [];
  const n = name.toLowerCase();
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === n) out.push(req.rawHeaders[i + 1]);
  return out;
}

function hasToken(value, token) {
  return String(value || "").split(",").map((v) => v.trim().toLowerCase()).includes(token.toLowerCase());
}

function normalizeOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad origin");
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return `${u.protocol}//${u.hostname.toLowerCase()}:${port}`;
}

function configuredAllowedOrigins(options = {}) {
  return (options.allowedOrigins ?? process.env.WS_ALLOWED_ORIGINS ?? (process.env.NODE_ENV === "production" ? "" : "*"))
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function websocketOriginPolicy(options = {}) {
  const allowlist = configuredAllowedOrigins(options);
  const production = process.env.NODE_ENV === "production";
  const wildcard = allowlist.includes("*");
  return {
    mode: wildcard && !production ? "development-wildcard" : allowlist.length ? "exact-allowlist" : "same-origin-or-missing",
    allowedOriginCount: allowlist.filter((v) => v !== "*").length,
    wildcardEnabled: wildcard && !production
  };
}

function isOriginAllowed(req, options = {}) {
  const origin = req.headers.origin;
  const allowMissing = options.allowMissingOrigin ?? process.env.WS_ALLOW_MISSING_ORIGIN !== "0";
  const allowlist = configuredAllowedOrigins(options);
  const production = process.env.NODE_ENV === "production";
  if (!origin) return allowMissing;
  let normalized;
  try { normalized = normalizeOrigin(origin); } catch { return false; }
  if (!production && allowlist.includes("*")) return true;
  for (const allowed of allowlist) {
    if (allowed === "*") continue;
    try { if (normalizeOrigin(allowed) === normalized) return true; } catch {}
  }
  if (!production) {
    try {
      const host = req.headers.host;
      if (host && normalizeOrigin(`${req.socket.encrypted ? "https" : "http"}://${host}`) === normalized) return true;
    } catch {}
  }
  return false;
}

function validateWebSocketUpgrade(req, socket, options = {}) {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch { return sendUpgradeError(socket, 400, "Bad Request"); }
  if (url.pathname !== (options.socketPath || "/socket")) return sendUpgradeError(socket, 404, "Not Found");
  if (req.method !== "GET") return sendUpgradeError(socket, 405, "Method Not Allowed", { Allow: "GET" });
  for (const h of ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version"]) {
    if (headerValues(req, h).length !== 1) return sendUpgradeError(socket, 400, "Bad Request");
  }
  if (!hasToken(req.headers.upgrade, "websocket") || !hasToken(req.headers.connection, "upgrade")) return sendUpgradeError(socket, 400, "Bad Request");
  if (req.headers["sec-websocket-version"] !== "13") return sendUpgradeError(socket, 426, "Upgrade Required", { "Sec-WebSocket-Version": "13" });
  const key = String(req.headers["sec-websocket-key"] || "").trim();
  if (!/^[A-Za-z0-9+/]{22}==$/u.test(key)) return sendUpgradeError(socket, 400, "Bad Request");
  if (Buffer.from(key, "base64").length !== 16) return sendUpgradeError(socket, 400, "Bad Request");
  if (!isOriginAllowed(req, options)) return sendUpgradeError(socket, 403, "Forbidden");
  return key;
}

function shortSha(value) { return String(value || "dev").slice(0, 12); }

function healthPayload() {
  const policy = websocketOriginPolicy();
  return {
    ok: true,
    service: "modular-fleet-arena",
    protocolVersion: PROTOCOL_VERSION,
    serverBuildSha: shortSha(SERVER_BUILD_SHA),
    uptimeSeconds: Math.floor(process.uptime()),
    activeRooms: rooms.size,
    activeClients: transport.sockets.size,
    originPolicy: { mode: policy.mode, allowedOriginCount: policy.allowedOriginCount }
  };
}

function handleHealthRequest(req, res) {
  const body = Buffer.from(JSON.stringify(healthPayload()));
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "content-length": req.method === "HEAD" ? 0 : body.length
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

// HTTP request handler for static files and balance JSON
function handleHttpRequest(req, res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405, { allow: "GET, HEAD" }); res.end(); return; }
  let requestUrl;
  try { requestUrl = new URL(req.url, "http://localhost"); } catch { res.writeHead(400); res.end("Bad request"); return; }
  let pathname;
  try { pathname = decodeURIComponent(requestUrl.pathname); } catch { res.writeHead(400); res.end("Bad request"); return; }
  if (pathname === "/") pathname = "/index.html";

  if (pathname === "/health") {
    handleHealthRequest(req, res);
    return;
  }

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
    const key = validateWebSocketUpgrade(req, socket, options);
    if (!key) return;
    const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
    transport.createClient(socket);
  });

  function start() {
    if (diagnosticsState.started) throw new Error("Server already started");
    const policy = websocketOriginPolicy(options);
    if (process.env.NODE_ENV === "production" && policy.allowedOriginCount === 0) {
      console.warn("Production WebSocket origin allowlist is empty. Cross-origin frontends such as Netlify will be rejected.");
    }
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
    const policy = websocketOriginPolicy();
    console.log(`Modular Fleet Arena running on http://localhost:${actual}`);
    console.log(`[deploy] build=${shortSha(SERVER_BUILD_SHA)} protocol=${PROTOCOL_VERSION} port=${actual} NODE_ENV=${process.env.NODE_ENV || "development"} wsOriginMode=${policy.mode} allowedOriginCount=${policy.allowedOriginCount} healthPath=/health socketPath=/socket`);
    for (const address of getLocalUrls(actual)) console.log(`LAN: ${address}`);
  }).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { createGameServer, handleHttpRequest, handleHealthRequest, handleTurretDebugRequest, validateWebSocketUpgrade, isOriginAllowed, websocketOriginPolicy };
