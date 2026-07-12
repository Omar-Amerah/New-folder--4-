const puppeteer = require("puppeteer-core");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 950 });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message + "\n" + (e.stack||"").split("\n").slice(0,4).join("\n")));
  page.on("requestfailed", (r) => errors.push("REQ FAILED: " + r.url()));
  page.on("response", (r) => { if (r.status() >= 400) errors.push("HTTP " + r.status() + ": " + r.url()); });
  page.on("console", (m) => { if (m.text().includes("HeatRules") || m.text().includes("heat")) errors.push("LOG: " + m.text()); });

  await page.goto("http://localhost:5544", { waitUntil: "networkidle2", timeout: 20000 });
  await new Promise(r => setTimeout(r, 1500));

  // Try to open the blueprint designer directly via the button if present.
  const opened = await page.evaluate(() => {
    const btn = document.getElementById("openBlueprintDesignerButton") || document.getElementById("mainMenuButton");
    if (btn) { btn.click(); return true; }
    return false;
  });
  await new Promise(r => setTimeout(r, 800));

  // Force-show the designer screen + switch to heat view, then run its renderers.
  const state = await page.evaluate(() => {
    const scr = document.getElementById("blueprintDesignerScreen");
    if (scr) scr.hidden = false;
    const heatTab = document.getElementById("blueprintHeatTab");
    if (heatTab) heatTab.click();
    const panel = document.getElementById("fullLoadThermalPanel");
    return {
      designerHidden: scr ? scr.hidden : "no-screen",
      heatTabExists: !!heatTab,
      panelExists: !!panel,
      panelHidden: panel ? panel.hidden : "n/a",
      panelHTMLLen: panel ? panel.innerHTML.length : 0,
      panelText: panel ? panel.textContent.slice(0, 120) : "",
      gridChildren: document.getElementById("buildGrid")?.childElementCount ?? "no-grid",
      statsChildren: document.getElementById("statsGrid")?.childElementCount ?? "no-stats"
    };
  });

  const rects = await page.evaluate(() => {
    const r = (id) => { const el = document.getElementById(id); if (!el) return "missing"; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), vis: b.width > 0 && b.height > 0 }; };
    return { panel: r("fullLoadThermalPanel"), statsGrid: r("statsGrid"), rightCol: (document.querySelector(".designer-right-col")?.getBoundingClientRect().width|0) };
  });
  console.log("RECTS:", JSON.stringify(rects));
  await page.screenshot({ path: "_heatshot.png", fullPage: false });
  console.log("STATE:", JSON.stringify(state, null, 2));
  console.log("ERRORS (" + errors.length + "):");
  for (const e of errors.slice(0, 15)) console.log(e);
  await browser.close();
})().catch(e => { console.error("SCRIPT FAIL:", e.message); process.exit(1); });
