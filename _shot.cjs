const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const ROOT = "c:/Users/omara/Documents/Coding/New folder (4)/public";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("no"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
});

server.listen(5623, async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE:", m.text()); });
  await page.goto("http://localhost:5623/_artpreview.html", { waitUntil: "networkidle2" });
  await page.waitForFunction("window.__ready === true", { timeout: 10000 });
  const out = process.argv[2] || "C:/Users/omara/AppData/Local/Temp/claude/c--Users-omara-Documents-Coding-New-folder--4-/ed9ed5d0-9a82-47e8-bca9-45a68a3b3218/scratchpad/art.png";
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 900, height: 360 } });
  await browser.close();
  server.close();
  console.log("wrote", out);
});
