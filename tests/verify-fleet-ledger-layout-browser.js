"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { launchChromium } = require("./verify-pixi-browser-support.js");

const publicRoot = path.join(__dirname, "..", "public");
let server;
let base;
let browser;

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png"
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function startStaticServer() {
  server = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }

    if (pathname === "/ledger-test.html") {
      const source = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8")
        .replace(/\s*<script type="module" src="\/src\/main\.js[^"]*"><\/script>/, "");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(source);
      return;
    }

    const filePath = path.resolve(publicRoot, `.${pathname}`);
    if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": contentType(filePath) }).end(fs.readFileSync(filePath));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

const fixture = {
  title: "Movement & Orders",
  category: "movement",
  summary: "Movement rules",
  importantStats: [
    { label: "Engine Authority", value: "Linear per live component" },
    { label: "Braking", value: "5x forward acceleration" },
    { label: "Turn Authority", value: "No built-in hull turn. Turn comes from Engines, Gyroscopes, and Maneuver Thrusters." },
    { label: "Maneuver Thrust", value: "0.35 minimum, +0.35 per cell, 1.75 maximum" },
    { label: "Mass", value: "Affects movement continuously" },
    { label: "Acceleration", value: "Shows how quickly the ship changes velocity" },
    { label: "Turn Rate", value: "Turning systems, reduced continuously by mass" },
    { label: "Movement Efficiency", value: "Linear per consumer, capped at 100%" }
  ],
  practicalUse: "Balance propulsion and turning systems against the hull you are building."
};

async function inspectViewport(page, expectedColumns) {
  await page.evaluate(async (article) => {
    const { renderArticleContent } = await import("/src/ledger/fleetLedgerUi.js");
    const overlay = document.getElementById("fleetLedgerOverlay");
    const content = document.getElementById("ledgerContent");
    overlay.hidden = false;
    content.innerHTML = renderArticleContent(article);
  }, fixture);

  const result = await page.evaluate(() => {
    const list = document.querySelector(".ledger-key-stat-list");
    const section = document.querySelector(".ledger-key-stats-section");
    const practicalUse = document.querySelector("#ledger-sec-practical-use");
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    const listBox = box(list);
    const rows = [...list.querySelectorAll(".ledger-key-stat-row")].map((row) => box(row));
    const labels = [...list.querySelectorAll("dt")].map((label) => label.textContent);
    const overflowing = [list, section].some((element) => element.scrollWidth > element.clientWidth + 1);
    return {
      columns: getComputedStyle(list).gridTemplateColumns.trim().split(/\s+/).length,
      labels,
      overflowing,
      rowsInsidePanel: rows.every((row) => row.left >= listBox.left - 1 && row.right <= listBox.right + 1),
      practicalUseBelow: practicalUse.getBoundingClientRect().top > listBox.bottom
    };
  });

  assert.equal(result.columns, expectedColumns, `expected ${expectedColumns} Key Stats column(s)`);
  assert.equal(result.overflowing, false, "Key Stats must not introduce horizontal overflow");
  assert.equal(result.rowsInsidePanel, true, "Key Stats rows must remain inside the shared panel");
  assert.equal(result.practicalUseBelow, true, "Practical Use must remain below Key Stats");
  assert.deepEqual(result.labels, fixture.importantStats.map((stat) => stat.label),
    "browser-rendered Key Stats labels must remain complete");
}

async function run() {
  await startStaticServer();
  browser = await launchChromium(chromium);
  for (const [viewport, expectedColumns] of [
    [{ width: 1200, height: 800 }, 2],
    [{ width: 520, height: 800 }, 1],
    [{ width: 360, height: 800 }, 1]
  ]) {
    const page = await browser.newPage({ viewport });
    try {
      await page.goto(`${base}/ledger-test.html`, { waitUntil: "domcontentloaded" });
      await inspectViewport(page, expectedColumns);
    } finally {
      await page.close();
    }
  }
  console.log("Fleet Ledger browser layout verification passed at wide, narrow, and compact viewports");
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close().catch(() => {});
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  });
