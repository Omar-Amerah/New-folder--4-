const assert = require("assert");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const ARTIFACT_DIR = path.join(ROOT, "test-artifacts", "split-origin");
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

function allocatePort() {
  return 24000 + Math.floor(Math.random() * 20000);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.status < 500) return response;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function safePublicPath(requestUrl) {
  const url = new URL(requestUrl, "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return null;
  return filePath;
}

function startStaticFrontend(port) {
  const logs = [];
  let rejectedUpgradeCount = 0;
  const server = http.createServer((req, res) => {
    const filePath = safePublicPath(req.url || "/");
    if (!filePath) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    fs.readFile(filePath, (error, data) => {
      if (error) {
        logs.push(`[http] ${req.method} ${req.url} -> 404`);
        res.writeHead(404).end("Not found");
        return;
      }
      logs.push(`[http] ${req.method} ${req.url} -> 200`);
      res.writeHead(200, { "content-type": contentTypeFor(filePath) });
      res.end(data);
    });
  });
  server.on("upgrade", (req, socket) => {
    rejectedUpgradeCount += 1;
    logs.push(`[upgrade] rejected ${req.url}`);
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        logs,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
        get rejectedUpgradeCount() { return rejectedUpgradeCount; }
      });
    });
  });
}

function startBackend(port, frontendOrigin) {
  const logs = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      WS_ALLOWED_ORIGINS: frontendOrigin
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(`[out] ${chunk}`));
  child.stderr.on("data", (chunk) => logs.push(`[err] ${chunk}`));
  child.exitPromise = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  child.logs = logs;
  return child;
}

async function stopBackend(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  const killer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await child.exitPromise.finally(() => clearTimeout(killer));
}

async function runSmokeTest() {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });

  const frontendPort = allocatePort();
  const backendPort = allocatePort();
  const diagnostics = { frontendPort, backendPort, pageErrors: [], consoleErrors: [] };
  let frontend;
  let backend;
  let browser;
  let context;
  let page;

  try {
    frontend = await startStaticFrontend(frontendPort);
    backend = startBackend(backendPort, frontend.origin);
    await waitForHttp(`${frontend.origin}/index.html`);
    await waitForHttp(`http://127.0.0.1:${backendPort}/health`);

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    page = await context.newPage();
    page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
    });

    const backendSocketUrl = `ws://127.0.0.1:${backendPort}/socket`;
    const appUrl = `${frontend.origin}/index.html?server=${encodeURIComponent(backendSocketUrl)}`;
    await page.goto(appUrl, { waitUntil: "load" });
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto(appUrl, { waitUntil: "load" });

    await page.waitForFunction(() => window.__mfaMainLoaded === true, null, { timeout: 15000 });
    await page.waitForFunction(() => {
      const menu = document.querySelector("#mainMenuScreen");
      const create = document.querySelector("#createButton");
      return menu && !menu.hidden && create && !create.hidden && !create.disabled;
    }, null, { timeout: 15000 });

    await page.fill("#pilotName", "Pilot-split-origin");
    await page.click("#createButton");
    await page.waitForFunction(() => window.__mfaNetworkDiagnostics?.joinedReceived, null, { timeout: 15000 });
    await page.waitForFunction(() => window.__mfaNetworkDiagnostics?.firstFullSnapshotReceived, null, { timeout: 15000 });

    const result = await page.evaluate(() => ({
      room: window.__mfaState?.room || "",
      configuredServer: localStorage.getItem("modular-fleet-server-url-v1"),
      diagnostics: window.__mfaNetworkDiagnostics
    }));
    diagnostics.result = result;

    assert.match(result.room, /^[A-Z0-9]{4,8}$/, "generated room code populated");
    assert.equal(result.configuredServer, backendSocketUrl, "server query parameter persisted before URL sync");
    assert.equal(result.diagnostics?.websocketHostname, "127.0.0.1", "browser connected to backend host");
    assert.equal(frontend.rejectedUpgradeCount, 0, "static frontend did not receive a WebSocket fallback");
    assert.deepEqual(diagnostics.pageErrors, [], "no page errors");

    fs.writeFileSync(path.join(ARTIFACT_DIR, "fresh-split-origin.json"), JSON.stringify(diagnostics, null, 2));
    console.log("fresh split-origin browser verification passed");
  } catch (error) {
    diagnostics.error = error.stack || String(error);
    diagnostics.frontendLog = frontend?.logs?.join("") || "";
    diagnostics.backendLog = backend?.logs?.join("") || "";
    if (page) await page.screenshot({ path: path.join(ARTIFACT_DIR, "fresh-split-origin-failure.png") }).catch(() => {});
    fs.writeFileSync(path.join(ARTIFACT_DIR, "fresh-split-origin-failure.json"), JSON.stringify(diagnostics, null, 2));
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (frontend) await frontend.close().catch(() => {});
    await stopBackend(backend);
  }
}

runSmokeTest().catch((error) => {
  console.error(error);
  process.exit(1);
});
