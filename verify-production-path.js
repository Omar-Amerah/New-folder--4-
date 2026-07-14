"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: pathname }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

(async () => {
  const build = spawnSync(process.execPath, ["netlify-build.js"], { cwd: __dirname, encoding: "utf8" });
  assert.strictEqual(build.status, 0, build.stdout + build.stderr);
  assert.ok(!fs.existsSync(path.join(__dirname, "public", "client.js")), "obsolete public/client.js must not exist after build");
  const port = 5731 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ["server.js"], { cwd: __dirname, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  try {
    for (let i = 0; i < 50 && !/running on/i.test(log); i++) await new Promise((r) => setTimeout(r, 100));
    const index = await request(port, "/index.html");
    assert.strictEqual(index.status, 200);
    assert.match(index.body, /<script type="module" src="\/src\/main\.js/);
    assert.doesNotMatch(index.body, /client\.js/);
    const moduleMatches = [...index.body.matchAll(/<script[^>]+src="([^"]+\.js(?:\?[^"]*)?)"/g)].map((m) => m[1].split("?")[0]);
    assert.ok(moduleMatches.includes("/src/main.js"), "index must request /src/main.js");
    for (const asset of moduleMatches) {
      const res = await request(port, asset);
      assert.strictEqual(res.status, 200, `${asset} returned ${res.status}`);
    }
    const main = await request(port, "/src/main.js");
    assert.strictEqual(main.status, 200);
    assert.match(main.body, /initializeClient|initArenaRenderer/);
    const sha = await request(port, "/build-sha.js");
    assert.strictEqual(sha.status, 200);
    assert.match(sha.body, /__MFA_BUILD_SHA__/);
    console.log("Production path verification passed");
  } finally {
    server.kill("SIGTERM");
  }
})().catch((err) => { console.error(err); process.exit(1); });
