#!/usr/bin/env node
"use strict";
// Blueprint Designer "Ship summary" — rendered contract in a real browser.
//
// Covers the rendered hierarchy (headline grid → status area → collapsed detail
// accordions), the consolidated Power item, degrees-per-second turn units,
// accordion accessibility, the 3/2/1 responsive grid, and that switching designs
// leaves no stale warnings or values behind.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { uniquePort, startServer, waitForServer, launchChromium } = require("./verify-pixi-browser-support.js");

const artifactDir = path.join("test-artifacts", "ship-summary");

// Representative designs, applied through the same state the designer edits.
// "medium" is the app's own starter Blueprint — a real, fully wired and fully
// powered ship — so the healthy-state assertions exercise the authoritative
// solved Power path rather than an unwired hull.
const STARTER = "__starter__";
const DESIGNS = {
  light: [["core", 7, 7], ["engine", 7, 8], ["blaster", 7, 6]],
  medium: STARTER,
  heavy: [["core", 7, 7], ["reactor", 7, 6], ["reactor", 7, 5], ["armor", 6, 6], ["armor", 8, 6],
    ["shield", 7, 8], ["shield", 5, 7], ["engine", 6, 9], ["engine", 8, 9], ["beamEmitter", 8, 7], ["missile", 4, 7]],
  bare: [["core", 7, 7], ["frame", 7, 8]],
  underpowered: [["core", 7, 7], ["shield", 7, 6], ["shield", 7, 8], ["beamEmitter", 6, 7], ["beamEmitter", 8, 7]],
  support: [["core", 7, 7], ["reactor", 7, 8], ["repair", 7, 6], ["droneBay", 4, 4]],
  asymmetric: [["core", 7, 7], ["reactor", 7, 8], ["maneuverThruster", 5, 7, 90]]
};

async function applyDesign(page, key) {
  await page.evaluate(async ({ modules, starter }) => {
    const [{ state }, designerUi, storage] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/designerUi.js"),
      import("/src/design/blueprintStorage.js")
    ]);
    if (modules === starter) {
      state.design = storage.defaultDesign();
      state.wiring = storage.defaultWiring();
    } else {
      state.design = modules.map(([type, x, y, rotation]) => ({ type, x, y, rotation: rotation || 0 }));
      state.wiring = window.WiringRules.emptyWiring();
    }
    state.selectedCell = null;
    state.selectedPart = null;
    designerUi.renderBuildGrid();
    designerUi.renderLocalStats();
  }, { modules: DESIGNS[key], starter: STARTER });
  await page.locator("#statsGrid .ship-summary-grid").waitFor({ state: "visible", timeout: 5000 });
}

async function readSummary(page) {
  return page.evaluate(() => {
    const root = document.querySelector("#statsGrid");
    const text = (node) => (node?.textContent || "").trim();
    return {
      overview: Array.from(root.querySelectorAll(".ship-summary-grid .stat")).map((cell) => ({
        key: cell.dataset.statKey,
        label: text(cell.querySelector("span")),
        value: text(cell.querySelector("strong")),
        hint: text(cell.querySelector(".stat-hint")),
        diagnostic: cell.dataset.statDiagnostic,
        ariaLabel: cell.getAttribute("aria-label")
      })),
      status: Array.from(root.querySelectorAll(".ship-status-line")).map((line) => ({
        id: line.dataset.statusId,
        level: Array.from(line.classList).find((name) => name.startsWith("is-"))?.slice(3) || "",
        icon: text(line.querySelector(".ship-status-icon")),
        text: text(line.querySelector(".ship-status-text"))
      })),
      sections: Array.from(root.querySelectorAll(".part-accordion")).map((accordion) => {
        const trigger = accordion.querySelector(".part-accordion-trigger");
        const panel = accordion.querySelector(".part-accordion-panel");
        return {
          id: accordion.dataset.accordion,
          title: text(accordion.querySelector(".part-accordion-title")),
          expanded: trigger.getAttribute("aria-expanded"),
          controls: trigger.getAttribute("aria-controls"),
          panelId: panel.id,
          labelledBy: panel.getAttribute("aria-labelledby"),
          triggerId: trigger.id,
          triggerTag: trigger.tagName,
          role: panel.getAttribute("role"),
          hidden: panel.hidden,
          rows: Array.from(panel.querySelectorAll(".part-detail-row")).map((row) => ({
            label: text(row.querySelector(".part-spec-label")),
            value: text(row.querySelector(".part-detail-value"))
          })),
          note: text(panel.querySelector(".part-accordion-note"))
        };
      }),
      allText: text(root)
    };
  });
}

(async () => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const port = uniquePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { server, getLog } = startServer(port);
  let browser;
  let passed = 0;
  const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
  try {
    await waitForServer(baseUrl);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console.error: ${message.text()}`); });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__mfaMainLoaded === true);
    await page.evaluate(async () => {
      document.querySelector("#mainMenuScreen").hidden = true;
      const screenUi = await import("/src/ui/designerScreenUi.js");
      const designerUi = await import("/src/ui/designerUi.js");
      screenUi.openBlueprintDesigner();
      designerUi.renderBuildGrid();
      designerUi.renderLocalStats();
    });
    await page.locator("#blueprintDesignerScreen:not([hidden])").waitFor({ state: "visible" });

    const snapshots = {};
    for (const key of Object.keys(DESIGNS)) {
      await applyDesign(page, key);
      snapshots[key] = await readSummary(page);
    }

    // -- Default overview ------------------------------------------------------
    check("every design shows the same nine headline values in the same order", () => {
      for (const [key, view] of Object.entries(snapshots)) {
        assert.deepEqual(view.overview.map((cell) => cell.key),
          ["cost", "class", "mass", "hull", "shield", "weapons", "speed", "turn", "power"],
          `${key} renders the nine headline fields`);
        for (const cell of view.overview) {
          assert.ok(cell.value && cell.value.length, `${key}/${cell.label} has a value`);
          assert.ok(cell.ariaLabel && cell.ariaLabel.includes(cell.label), `${key}/${cell.label} is labelled for assistive tech`);
        }
      }
    });

    check("technical calculations are no longer headline cards", () => {
      const technical = /effective thrust|thrust\/mass|thrust-to-mass|engine efficiency|power efficiency|power penalty|mass drag/i;
      for (const [key, view] of Object.entries(snapshots)) {
        for (const cell of view.overview) {
          assert.doesNotMatch(cell.label, technical, `${key}: "${cell.label}" is no longer a headline card`);
        }
      }
    });

    check("no summary label is rendered twice", () => {
      for (const [key, view] of Object.entries(snapshots)) {
        const labels = [
          ...view.overview.map((cell) => cell.label),
          ...view.sections.flatMap((section) => section.rows.map((row) => row.label))
        ].map((label) => label.trim().toLowerCase()).filter(Boolean);
        assert.equal(new Set(labels).size, labels.length, `${key} renders no duplicate label`);
      }
    });

    // -- Power -----------------------------------------------------------------
    check("Power is one consolidated item with generation, demand and the balance", () => {
      for (const [key, view] of Object.entries(snapshots)) {
        const power = view.overview.filter((cell) => cell.key === "power");
        assert.equal(power.length, 1, `${key} shows exactly one Power card`);
        assert.equal(power[0].hint, "", `${key} keeps the Power headline to a single value with no sub-line`);
        assert.match(power[0].value, /MW (spare|short)$/, `${key} states the balance`);
        const strays = view.overview.filter((cell) => /efficiency|penalty|gen \/ demand/i.test(cell.label));
        assert.deepEqual(strays, [], `${key} has no separate Power efficiency/penalty cards`);
      }
      assert.match(snapshots.medium.overview.find((c) => c.key === "power").value, /MW spare$/);
      assert.equal(snapshots.medium.overview.find((c) => c.key === "power").diagnostic, "good");
      assert.match(snapshots.underpowered.overview.find((c) => c.key === "power").value, /MW short$/);
      assert.equal(snapshots.underpowered.overview.find((c) => c.key === "power").diagnostic, "bad");
    });

    check("Power Penalty: None and Repair: 0 HP/s are never rendered", () => {
      for (const [key, view] of Object.entries(snapshots)) {
        assert.doesNotMatch(view.allText, /power penalty\s*none/i, `${key} shows no "Power Penalty: None"`);
        assert.doesNotMatch(view.allText, /repair[^.]{0,12}\s0(\.0)?\s*HP\/s/i, `${key} shows no zero repair rate`);
        assert.doesNotMatch(view.allText, /\bnot applicable\b/i, `${key} shows no "Not applicable"`);
      }
      assert.doesNotMatch(snapshots.bare.allText, /repair/i, "a ship with no repair shows no repair row at all");
    });

    check("a healthy design says Fully powered and an underpowered one names the shortfall", () => {
      const healthy = snapshots.medium.status.find((message) => message.id === "power-ok");
      assert.ok(healthy, "healthy design reports Fully powered");
      assert.equal(healthy.text, "Fully powered");
      assert.equal(healthy.level, "good");
      const short = snapshots.underpowered.status.find((message) => message.id === "power-short");
      assert.ok(short, "underpowered design reports the shortfall");
      assert.equal(short.level, "bad");
      assert.match(short.text, /MW short ·/);
    });

    // -- Mobility --------------------------------------------------------------
    check("turn rate is rendered in degrees per second with a unit on every side", () => {
      for (const [key, view] of Object.entries(snapshots)) {
        const turn = view.overview.find((cell) => cell.key === "turn");
        assert.match(turn.value, /°\/s/, `${key} uses degrees per second`);
        assert.doesNotMatch(turn.value, /rad\/s/, `${key} shows no raw radians`);
        for (const side of turn.value.match(/(Left|Right)[^·]*/g) || []) {
          assert.match(side.trim(), /°\/s$/, `${key}: "${side.trim()}" carries its unit`);
        }
      }
      assert.match(snapshots.asymmetric.overview.find((c) => c.key === "turn").value,
        /Left \d+°\/s · Right \d+°\/s/, "asymmetric ship shows both sides with units");
    });

    check("asymmetric turning is explained in the status area", () => {
      const message = snapshots.asymmetric.status.find((entry) => entry.id === "asymmetric-turn");
      assert.ok(message, "asymmetric turning is surfaced");
      assert.equal(message.level, "warning");
      assert.match(message.text, /Asymmetric turning:/);
      assert.equal(snapshots.medium.status.some((entry) => entry.id === "asymmetric-turn"), false,
        "a symmetric ship raises no asymmetry warning");
    });

    check("engineering mobility values moved into Mobility details", () => {
      const mobility = snapshots.medium.sections.find((section) => section.id === "mobility");
      assert.ok(mobility, "Mobility details exists");
      const labels = mobility.rows.map((row) => row.label.toLowerCase());
      for (const expected of ["effective thrust", "thrust-to-mass", "engine efficiency", "mass drag limit", "left turn", "right turn"]) {
        assert.ok(labels.includes(expected), `Mobility details carries "${expected}" (${JSON.stringify(labels)})`);
      }
      assert.ok(mobility.note, "the speed/drag-limit relationship is explained");
      assert.match(mobility.note, /mass drag limit/i);
    });

    // -- Sections --------------------------------------------------------------
    check("detail sections are collapsed accordions rendered only when useful", () => {
      for (const [key, view] of Object.entries(snapshots)) {
        for (const section of view.sections) {
          assert.equal(section.triggerTag, "BUTTON", `${key}/${section.title} uses a real button`);
          assert.equal(section.expanded, "false", `${key}/${section.title} starts collapsed`);
          assert.equal(section.hidden, true, `${key}/${section.title} panel starts hidden`);
          assert.equal(section.controls, section.panelId, `${key}/${section.title} aria-controls points at its panel`);
          assert.equal(section.labelledBy, section.triggerId, `${key}/${section.title} panel is labelled by its trigger`);
          assert.equal(section.role, "region", `${key}/${section.title} panel is a region`);
          assert.ok(section.rows.length > 0, `${key}/${section.title} is not empty`);
        }
      }
      assert.ok(snapshots.support.sections.some((s) => s.id === "support"), "a repair ship gets Support details");
      assert.equal(snapshots.bare.sections.some((s) => s.id === "support"), false, "a bare hull gets no Support details");
      assert.equal(snapshots.bare.sections.some((s) => s.id === "combat"), false, "an unarmed hull gets no Combat details");
      assert.ok(snapshots.heavy.sections.some((s) => s.id === "combat"), "an armed ship gets Combat details");
    });

    await applyDesign(page, "medium");
    const accordion = page.locator('#statsGrid [data-summary-section="mobility"]');
    await accordion.focus();
    await page.keyboard.press("Enter");
    const opened = await page.evaluate(() => {
      const trigger = document.querySelector('#statsGrid [data-summary-section="mobility"]');
      const panel = document.getElementById(trigger.getAttribute("aria-controls"));
      const style = getComputedStyle(trigger);
      return {
        expanded: trigger.getAttribute("aria-expanded"),
        hidden: panel.hidden,
        focusVisible: trigger.matches(":focus-visible"),
        outlineWidth: parseFloat(style.outlineWidth) || 0,
        height: trigger.getBoundingClientRect().height
      };
    });
    check("Mobility details opens from the keyboard with a visible focus ring", () => {
      assert.equal(opened.expanded, "true");
      assert.equal(opened.hidden, false);
      assert.equal(opened.focusVisible, true, "keyboard focus engages :focus-visible");
      assert.ok(opened.outlineWidth > 0, `focus ring is visible (${opened.outlineWidth}px)`);
      assert.ok(opened.height >= 40, `trigger stays tappable (${opened.height}px)`);
    });

    // -- Status colour discipline ---------------------------------------------
    check("status messages carry an icon so meaning never rests on colour alone", () => {
      for (const [key, view] of Object.entries(snapshots)) {
        for (const message of view.status) {
          assert.ok(message.icon && message.icon.length, `${key}/${message.id} has an icon`);
          assert.ok(["good", "warning", "bad", "neutral"].includes(message.level), `${key}/${message.id} has a known level`);
          assert.ok(message.text.length, `${key}/${message.id} has text`);
        }
      }
    });

    check("amber and red are not applied to ordinary technical values", () => {
      for (const [key, view] of Object.entries(snapshots)) {
        for (const cell of view.overview) {
          if (cell.key === "power") continue;
          assert.equal(cell.diagnostic, "neutral",
            `${key}/${cell.label} is not coloured merely for being a calculation`);
        }
      }
    });

    // -- Stale state -----------------------------------------------------------
    check("switching designs leaves no stale warnings or values", () => {
      const markers = {
        underpowered: /MW short/,
        asymmetric: /Asymmetric turning/,
        support: /Support details/,
        bare: /cannot attack/
      };
      for (const [owner, marker] of Object.entries(markers)) {
        assert.match(snapshots[owner].allText, marker, `${owner} shows its own marker`);
      }
      assert.doesNotMatch(snapshots.medium.allText, /MW short/, "a healthy design carries no shortfall text");
      assert.doesNotMatch(snapshots.medium.allText, /Asymmetric turning/, "a symmetric design carries no asymmetry text");
      assert.doesNotMatch(snapshots.medium.allText, /cannot attack/, "an armed design carries no unarmed warning");
    });

    const sweep = await (async () => {
      const seen = [];
      for (const key of ["underpowered", "medium", "asymmetric", "medium", "bare", "medium"]) {
        await applyDesign(page, key);
        const view = await readSummary(page);
        seen.push({ key, statuses: view.status.map((s) => s.id), sections: view.sections.map((s) => s.id) });
      }
      return seen;
    })();
    check("returning to a healthy design always clears previous warnings", () => {
      for (const entry of sweep.filter((item) => item.key === "medium")) {
        assert.equal(entry.statuses.includes("power-short"), false, "no stale Power shortfall");
        assert.equal(entry.statuses.includes("asymmetric-turn"), false, "no stale asymmetry warning");
        assert.equal(entry.statuses.includes("no-weapons"), false, "no stale unarmed warning");
        assert.ok(entry.statuses.includes("power-ok"), "the healthy state is reported");
      }
    });

    // -- Responsive ------------------------------------------------------------
    const widths = [
      { label: "desktop-wide", width: 1920, height: 1080, columns: 3 },
      { label: "desktop", width: 1600, height: 1000, columns: 3 },
      { label: "medium", width: 1100, height: 900, columns: 2 },
      { label: "tablet", width: 820, height: 1180, columns: 2 },
      { label: "mobile", width: 430, height: 932, columns: 1 }
    ];
    for (const viewport of widths) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const key of ["light", "medium", "heavy", "underpowered"]) {
        await applyDesign(page, key);
        const layout = await page.evaluate(() => {
          const root = document.querySelector("#statsGrid");
          const grid = root.querySelector(".ship-summary-grid");
          const doc = document.documentElement;
          const rootRect = root.getBoundingClientRect();
          return {
            columns: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
            panelOverflow: root.scrollWidth - root.clientWidth,
            docOverflow: doc.scrollWidth - doc.clientWidth,
            cellsInside: Array.from(root.querySelectorAll(".stat")).every((cell) => {
              const rect = cell.getBoundingClientRect();
              return rect.left >= rootRect.left - 1 && rect.right <= rootRect.right + 1;
            })
          };
        });
        assert.equal(layout.columns, viewport.columns,
          `${viewport.label}/${key}: ${viewport.columns}-column grid (got ${layout.columns})`);
        assert.ok(layout.panelOverflow <= 1, `${viewport.label}/${key}: summary does not scroll horizontally`);
        assert.ok(layout.docOverflow <= 1, `${viewport.label}/${key}: page does not scroll horizontally`);
        assert.equal(layout.cellsInside, true, `${viewport.label}/${key}: every cell stays inside the panel`);
      }
      await applyDesign(page, "medium");
      await page.locator("#statsGrid").screenshot({ path: path.join(artifactDir, `summary-${viewport.label}-${viewport.width}.png`) });
    }
    check("the summary grid is 3 / 2 / 1 columns at desktop, medium and mobile widths", () => {});

    await page.setViewportSize({ width: 1600, height: 1000 });
    for (const key of Object.keys(DESIGNS)) {
      await applyDesign(page, key);
      await page.locator("#statsGrid").screenshot({ path: path.join(artifactDir, `design-${key}.png`) });
    }

    check("no uncaught page errors during the Ship summary review", () => {
      assert.deepEqual(errors, [], `no page errors: ${errors.join("; ")}`);
    });

    console.log(`\nShip summary browser checks: ${passed}/${passed} passed`);
    console.log(`Ship summary browser verification passed; screenshots: ${artifactDir}`);
  } catch (error) {
    console.error(error);
    console.error("Server log:\n", getLog?.() || "");
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server?.kill?.();
  }
})();
