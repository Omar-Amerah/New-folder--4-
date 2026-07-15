"use strict";
// Shared support for the Pixi browser tests: portable Chromium resolution, a
// throwaway game server, and the in-page helper script that injects synthetic
// snapshots. Chromium resolution order:
//   1. PW_CHROME env var, when it points at an existing binary
//   2. a discovered /opt/pw-browsers/chromium-* binary, when present
//   3. Playwright's own chromium.launch() resolution (default)
// The tests must NOT fail merely because /opt/pw-browsers does not exist.

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");

function discoverChrome() {
  const envPath = process.env.PW_CHROME;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const root = "/opt/pw-browsers";
  try {
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith("chromium")).sort().reverse();
    for (const d of dirs) {
      for (const rel of [["chrome-linux", "chrome"], ["chrome-linux", "headless_shell"], ["chrome-mac", "Chromium.app"]]) {
        const cand = path.join(root, d, ...rel);
        if (fs.existsSync(cand)) return cand;
      }
    }
  } catch {
    // /opt/pw-browsers absent — fall through to Playwright's default resolution.
  }
  return undefined;
}

// Launches headless Chromium with WebGL (SwiftShader) enabled. Uses a discovered
// executable when available, otherwise Playwright's bundled resolution.
async function launchChromium(chromium) {
  const executablePath = discoverChrome();
  const args = ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
  const opts = { headless: true, args };
  if (executablePath) opts.executablePath = executablePath;
  try {
    return await chromium.launch(opts);
  } catch (err) {
    if (executablePath) {
      // The discovered binary failed; retry with Playwright's own resolution.
      return chromium.launch({ headless: true, args });
    }
    throw err;
  }
}

function startServer(port) {
  const server = spawn("node", ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  return { server, getLog: () => log };
}

function uniquePort() {
  if (process.env.TEST_PORT) return Number(process.env.TEST_PORT);
  const base = 30000 + (process.pid % 20000);
  return base + Math.floor(Math.random() * 2000);
}

function uniqueRoom(prefix) {
  // Production URL room codes are uppercased and truncated to eight chars.
  // Generate exactly that shape once so the URL, Node clients, and assertions
  // all use the same value without scattered slice/toUpperCase fixes.
  const safePrefix = String(prefix || "browser").replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const first = (safePrefix[0] || "B").replace(/[^A-Z0-9]/, "B");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let n = (Date.now() ^ (process.pid << 8) ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  let suffix = "";
  for (let i = 0; i < 7; i += 1) {
    suffix += alphabet[n % alphabet.length];
    n = Math.floor(n / alphabet.length) ^ Math.floor(Math.random() * alphabet.length);
  }
  return `${first}${suffix}`.slice(0, 8);
}

async function collectReadiness(page, expectedRoom) {
  return page.evaluate((room) => {
    const state = window.__mfaState || null;
    const net = window.__mfaNetworkDiagnostics || {};
    return {
      mainModuleLoaded: Boolean(window.__mfaMainLoaded),
      stateExists: Boolean(state),
      websocketCreated: Boolean(net.websocketCreated || state?.socket),
      websocketOpened: Boolean(net.websocketOpened || state?.socket?.readyState === WebSocket.OPEN),
      helloReceived: Boolean(net.helloReceived || state?.server?.protocolVersion),
      protocolAccepted: state?.server?.compatibility === "ok" || Boolean(net.protocolAccepted),
      joinPacketSent: Boolean(net.joinPacketSent || net.sentTypes?.some((entry) => entry.type === "join")),
      joinedMessageReceived: Boolean(net.joinedReceived || state?.room),
      roomExpected: room,
      roomActual: state?.room || null,
      roomMatches: state?.room === room,
      myId: state?.myId || null,
      myIdPopulated: Boolean(state?.myId),
      firstFullSnapshotReceived: Boolean(net.firstFullSnapshotReceived || state?.snapshot),
      server: state?.server || null,
      socketReadyState: state?.socket?.readyState ?? null,
      sentTypes: net.sentTypes || [],
      receivedTypes: net.receivedTypes || []
    };
  }, expectedRoom);
}

async function waitForBrowserReady(page, expectedRoom, diagnostics, timeoutMs = 20000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start <= timeoutMs) {
    last = await collectReadiness(page, expectedRoom);
    if (diagnostics) diagnostics.readiness = last;
    if (last.mainModuleLoaded && last.stateExists && last.websocketCreated && last.websocketOpened
      && last.helloReceived && last.protocolAccepted && last.joinPacketSent
      && last.joinedMessageReceived && last.roomMatches && last.myIdPopulated
      && last.firstFullSnapshotReceived) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`browser initial readiness timeout after ${timeoutMs}ms: ${JSON.stringify(last, null, 2)}`);
}

function writeJsonArtifact(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function defaultArtifactDir(name) {
  const root = process.env.TEST_ARTIFACT_DIR || process.env.SHOT_DIR || path.join(os.tmpdir(), "mfa-browser-artifacts");
  return path.join(root, name);
}

function waitForServer(base, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${base}/index.html`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error("server did not start"));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

// In-page helpers: build synthetic snapshots and step real rAF frames. Injected
// via page.addScriptTag({ content: PAGE_HELPERS }).
const PAGE_HELPERS = `
window.__mfaTest = {
  async frames(n) {
    for (let i = 0; i < n + 2; i++) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    }
  },
  setSnapshot(snapshot, cameraTarget) {
    const state = window.__mfaState;
    state.myId = "p1";
    state.snapshot = snapshot;
    state.snapshotReceivedAt = performance.now();
    state.visualShips = new Map();
    for (const s of (snapshot.ships || [])) {
      state.visualShips.set(s.id, { x: s.x, y: s.y, angle: s.angle });
    }
    const focus = cameraTarget || (snapshot.ships && snapshot.ships[0]) || { x: 1600, y: 950 };
    state.camera.x = focus.x;
    state.camera.y = focus.y;
    state.camera.zoom = 3.0;
    state.camera.follow = false;
    state.camera.manualZoom = 3.0;
  },
  setHullAngle(shipId, angle) {
    const state = window.__mfaState;
    const ship = state.snapshot.ships.find((s) => s.id === shipId);
    ship.angle = angle;
    const vis = state.visualShips.get(shipId);
    if (vis) vis.angle = angle;
  },
  setWeaponAngle(shipId, designIndex, angle) {
    const ship = window.__mfaState.snapshot.ships.find((s) => s.id === shipId);
    ship.weaponAngles[designIndex] = angle;
  },
  setCamera(x, y, zoom) {
    const state = window.__mfaState;
    state.camera.x = x;
    state.camera.y = y;
    state.camera.zoom = zoom;
    state.camera.manualZoom = zoom;
    state.camera.follow = false;
  },
  clearShips() {
    const state = window.__mfaState;
    const players = state.snapshot ? state.snapshot.players : [];
    state.snapshot = { players, ships: [], bullets: [], points: [], map: { asteroids: [], safeZones: [], clouds: [] } };
    state.visualShips = new Map();
  }
};
`;

// Build a design array from [x, y, type, rotation?] tuples.
function design(...parts) {
  return parts.map((p) => ({ x: p[0], y: p[1], type: p[2], rotation: p[3] || 0 }));
}

// A one-ship snapshot centred in the 3200x1900 world.
function snapshotWith(shipId, shipDesign, extra = {}) {
  return {
    players: [{ id: "p1", name: "Tester", color: "#38bdf8", design: shipDesign }],
    ships: [{
      id: shipId, ownerId: "p1", x: 1600, y: 950, vx: 0, vy: 0, angle: 0,
      radius: 30, alive: true, hp: 500, maxHp: 500, shield: 0, maxShield: 0,
      design: shipDesign, weaponAngles: shipDesign.map(() => 0), ...extra
    }],
    bullets: [], points: [], map: { asteroids: [], safeZones: [], clouds: [] }
  };
}

// A many-ship snapshot: identical design/colour tiled across the world.
function snapshotManyShips(count, shipDesign, color = "#38bdf8") {
  const ships = [];
  for (let i = 0; i < count; i += 1) {
    ships.push({
      id: `ship-${i}`, ownerId: "p1", x: 400 + (i % 5) * 120, y: 300 + Math.floor(i / 5) * 120,
      vx: 0, vy: 0, angle: 0, radius: 30, alive: true, hp: 500, maxHp: 500,
      shield: 0, maxShield: 0, design: shipDesign, weaponAngles: shipDesign.map(() => 0)
    });
  }
  return {
    players: [{ id: "p1", name: "Tester", color, design: shipDesign }],
    ships, bullets: [], points: [], map: { asteroids: [], safeZones: [], clouds: [] }
  };
}

// Dismiss the boot menu overlays so the arena is on-screen for screenshots.
const DISMISS_MENUS = `
for (const id of ["mainMenuScreen","lobbyManagementScreen","settingsScreen","lobbyScreen","designerScreen"]) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}
`;

module.exports = {
  discoverChrome,
  launchChromium,
  startServer,
  waitForServer,
  uniquePort,
  uniqueRoom,
  collectReadiness,
  waitForBrowserReady,
  writeJsonArtifact,
  defaultArtifactDir,
  PAGE_HELPERS,
  DISMISS_MENUS,
  design,
  snapshotWith,
  snapshotManyShips
};
