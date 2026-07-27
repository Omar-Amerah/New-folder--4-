#!/usr/bin/env node
"use strict";
// Regression coverage for the Wiring Analysis Summary stat-card layout.
// Verifies that the six stat cards are readable, evenly padded, never clip
// their labels or values, respond to panel width via container queries, and
// that the healthy state does not duplicate the top-level HEALTHY message.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server } = startServer(port);
let browser;
const artifactDir = path.join(__dirname, "test-artifacts", "wiring-summary-cards");
fs.mkdirSync(artifactDir, { recursive: true });

async function setupHealthyFixture(page) {
  await page.evaluate(async () => {
    const [{ state }, designer, wiring, { PART_STATS }] = await Promise.all([
      import("/src/state.js"), import("/src/ui/designerUi.js"),
      import("/src/ui/wiringUi.js"), import("/src/design/parts.js")
    ]);
    document.querySelector("#blueprintDesignerScreen").hidden = false;
    state.design = [
      { x: 0, y: 0, type: "core", rotation: 0 },
      { x: 1, y: 0, type: "gyroscope", rotation: 0 }
    ];
    let w = window.WiringRules.emptyWiring();
    w = window.WiringRules.addPathWithTier(w, "power", [{ x: 0, y: 0 }, { x: 1, y: 0 }], state.design, PART_STATS, "standard");
    state.wiring = w;
    wiring.resetWiringEditorState();
    state.wiringUi.mode = "power";
    designer.renderBuildGrid();
    designer.setBlueprintView("wiring");
    wiring.refreshWiringPresentation();
    designer.renderLocalStats();
  });
  await page.locator("#designerAnalysisTab").evaluate((b) => b.click());
  await page.locator("#analysisWiringTab").evaluate((b) => b.click());
  await page.locator('[data-wiring-status="healthy"]').waitFor({ state: "visible", timeout: 8000 });
}

async function setupWarningFixture(page) {
  await page.evaluate(async () => {
    const [{ state }, designer, wiring, { PART_STATS }] = await Promise.all([
      import("/src/state.js"), import("/src/ui/designerUi.js"),
      import("/src/ui/wiringUi.js"), import("/src/design/parts.js")
    ]);
    document.querySelector("#blueprintDesignerScreen").hidden = false;
    state.design = [
      { x: 5, y: 0, type: "reactor", rotation: 0 },
      { x: 7, y: 0, type: "beamEmitter", rotation: 0 },
      { x: 6, y: 1, type: "frame", rotation: 0 },
      { x: 7, y: 1, type: "frame", rotation: 0 }
    ];
    let w = window.WiringRules.emptyWiring();
    w = window.WiringRules.addPathWithTier(w, "power", [{ x: 6, y: 0 }, { x: 7, y: 0 }], state.design, PART_STATS, "light");
    w = window.WiringRules.addPathWithTier(w, "power", [{ x: 6, y: 0 }, { x: 6, y: 1 }, { x: 7, y: 1 }, { x: 7, y: 0 }], state.design, PART_STATS, "standard");
    state.wiring = w;
    wiring.resetWiringEditorState();
    state.wiringUi.mode = "power";
    designer.renderBuildGrid();
    designer.setBlueprintView("wiring");
    wiring.refreshWiringPresentation();
    designer.renderLocalStats();
  });
  await page.locator("#designerAnalysisTab").evaluate((b) => b.click());
  await page.locator("#analysisWiringTab").evaluate((b) => b.click());
  await page.locator(".wiring-stat-grid").waitFor({ state: "visible", timeout: 8000 });
}

async function measureCards(page) {
  return page.evaluate(() => {
    const panel = document.querySelector("#wiringStatusPanel");
    const grid = document.querySelector(".wiring-stat-grid");
    if (!grid) return { error: "no .wiring-stat-grid found" };
    const panelRect = panel.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    const cards = [...grid.querySelectorAll(".wiring-stat-card")];
    const cardData = cards.map((card) => {
      const cRect = card.getBoundingClientRect();
      const cs = getComputedStyle(card);
      const label = card.querySelector(".wiring-stat-label");
      const value = card.querySelector(".wiring-stat-value");
      const lRect = label ? label.getBoundingClientRect() : null;
      const vRect = value ? value.getBoundingClientRect() : null;
      const vText = value ? value.textContent.trim() : "";
      const lText = label ? label.textContent.trim() : "";
      return {
        label: lText,
        value: vText,
        cardRect: { x: cRect.x, y: cRect.y, width: cRect.width, height: cRect.height },
        paddingLeft: parseFloat(cs.paddingLeft),
        paddingRight: parseFloat(cs.paddingRight),
        paddingTop: parseFloat(cs.paddingTop),
        paddingBottom: parseFloat(cs.paddingBottom),
        labelRect: lRect ? { x: lRect.x, y: lRect.y, width: lRect.width, height: lRect.height } : null,
        valueRect: vRect ? { x: vRect.x, y: vRect.y, width: vRect.width, height: vRect.height } : null,
        valueOverflow: cs.overflow,
        valueTextOverflow: cs.textOverflow,
        valueWhiteSpace: cs.whiteSpace,
        valueAlignSelf: cs.alignSelf,
        display: cs.display,
        gridTemplateRows: cs.gridTemplateRows
      };
    });
    return {
      panelWidth: panelRect.width,
      panelScrollWidth: panel.scrollWidth,
      panelClientWidth: panel.clientWidth,
      gridWidth: gridRect.width,
      gridScrollWidth: grid.scrollWidth,
      gridTemplateColumns: getComputedStyle(grid).gridTemplateColumns,
      columnCount: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      cardCount: cards.length,
      cards: cardData,
      conditions: [...panel.querySelectorAll(".wiring-condition-item")].map((item) => ({
        text: item.textContent.trim(),
        className: item.className
      })),
      statusText: panel.querySelector('[data-wiring-status]')?.textContent?.trim() || null,
      statusAttr: panel.querySelector('[data-wiring-status]')?.dataset?.wiringStatus || null
    };
  });
}

function assertCardLayout(metrics, label) {
  assert.ok(metrics.cardCount === 6, `${label}: expected 6 stat cards, got ${metrics.cardCount}`);
  for (let i = 0; i < metrics.cards.length; i++) {
    const c = metrics.cards[i];
    const cr = c.cardRect;
    assert.ok(cr.width > 0 && cr.height > 0, `${label}: card ${i} (${c.label}) has positive width and height`);
    assert.ok(cr.height <= 100, `${label}: card ${i} (${c.label}) is not excessively tall (${cr.height}px)`);
    assert.ok(cr.height >= 50, `${label}: card ${i} (${c.label}) has reasonable minimum height (${cr.height}px)`);
    assert.ok(c.paddingLeft >= 10 && c.paddingRight >= 10, `${label}: card ${i} (${c.label}) has >=10px horizontal padding (L:${c.paddingLeft} R:${c.paddingRight})`);
    assert.ok(c.paddingTop >= 9 && c.paddingBottom >= 9, `${label}: card ${i} (${c.label}) has >=9px vertical padding (T:${c.paddingTop} B:${c.paddingBottom})`);
    assert.strictEqual(c.display, "grid", `${label}: card ${i} (${c.label}) uses display:grid`);
    assert.strictEqual(c.valueOverflow, "visible", `${label}: card ${i} (${c.label}) value does not use overflow:hidden`);
    assert.notStrictEqual(c.valueTextOverflow, "ellipsis", `${label}: card ${i} (${c.label}) value does not use text-overflow:ellipsis`);
    assert.notStrictEqual(c.valueAlignSelf, "flex-end", `${label}: card ${i} (${c.label}) value does not use align-self:flex-end`);
    if (c.labelRect && c.valueRect) {
      assert.ok(c.labelRect.x >= cr.x + c.paddingLeft - 1, `${label}: card ${i} (${c.label}) label is inside left padding`);
      assert.ok(c.labelRect.y >= cr.y + c.paddingTop - 1, `${label}: card ${i} (${c.label}) label is inside top padding`);
      assert.ok(c.valueRect.x >= cr.x + c.paddingLeft - 1, `${label}: card ${i} (${c.label}) value is inside left padding`);
      const valueRight = c.valueRect.x + c.valueRect.width;
      const cardRight = cr.x + cr.width - c.paddingRight;
      assert.ok(valueRight <= cardRight + 1, `${label}: card ${i} (${c.label}) value right edge (${valueRight}) does not exceed card content area (${cardRight})`);
      const rightClearance = cardRight - valueRight;
      assert.ok(rightClearance >= -1, `${label}: card ${i} (${c.label}) value has clearance from right border (${rightClearance}px)`);
      const valueBottom = c.valueRect.y + c.valueRect.height;
      const cardBottom = cr.y + cr.height - c.paddingBottom;
      assert.ok(valueBottom <= cardBottom + 1, `${label}: card ${i} (${c.label}) value bottom does not exceed card content area`);
    }
    assert.ok(c.value.length > 0, `${label}: card ${i} (${c.label}) has non-empty value text`);
    assert.ok(c.label.length > 0, `${label}: card ${i} has non-empty label text`);
  }
}

function assertEqualPadding(metrics, label) {
  const paddings = metrics.cards.map((c) => ({ pl: c.paddingLeft, pr: c.paddingRight }));
  const firstPL = paddings[0].pl;
  const firstPR = paddings[0].pr;
  for (let i = 1; i < paddings.length; i++) {
    assert.ok(Math.abs(paddings[i].pl - firstPL) < 0.5, `${label}: card ${i} left padding (${paddings[i].pl}) matches card 0 (${firstPL})`);
    assert.ok(Math.abs(paddings[i].pr - firstPR) < 0.5, `${label}: card ${i} right padding (${paddings[i].pr}) matches card 0 (${firstPR})`);
  }
}

function assertEqualRowHeight(metrics, label) {
  const rows = {};
  for (const c of metrics.cards) {
    const rowKey = Math.round(c.cardRect.y);
    if (!rows[rowKey]) rows[rowKey] = [];
    rows[rowKey].push(c.cardRect.height);
  }
  for (const [rowKey, heights] of Object.entries(rows)) {
    if (heights.length > 1) {
      const min = Math.min(...heights);
      const max = Math.max(...heights);
      assert.ok(Math.abs(max - min) <= 2, `${label}: cards in row @y=${rowKey} have equal height (min=${min}, max=${max})`);
    }
  }
}

(async () => {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);

    // ── Test 1: Healthy fixture at desktop width ──
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${base}/index.html`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__mfaMainLoaded === true, null, { timeout: 15000 }).catch(() => {});
      await setupHealthyFixture(page);
      const metrics = await measureCards(page);
      assertCardLayout(metrics, "healthy-desktop");
      assertEqualPadding(metrics, "healthy-desktop");
      assertEqualRowHeight(metrics, "healthy-desktop");
      assert.ok(metrics.panelScrollWidth <= metrics.panelClientWidth + 1,
        `healthy-desktop: grid does not overflow panel (${metrics.panelScrollWidth}/${metrics.panelClientWidth})`);
      assert.ok(metrics.columnCount >= 2, `healthy-desktop: wide panel shows >=2 columns (${metrics.columnCount})`);

      // Verify compound value "1 Power · 0 Data" is fully visible (no clipping)
      const networksCard = metrics.cards.find((c) => c.label === "Networks");
      assert.ok(networksCard, "healthy-desktop: Networks card exists");
      assert.match(networksCard.value, /Power.*Data/, "healthy-desktop: Networks value contains Power and Data");
      const vRect = networksCard.valueRect;
      const cRect = networksCard.cardRect;
      const valueRight = vRect.x + vRect.width;
      const cardContentRight = cRect.x + cRect.width - networksCard.paddingRight;
      assert.ok(valueRight <= cardContentRight + 1,
        `healthy-desktop: Networks value "${networksCard.value}" does not cross card right border (valueRight=${valueRight}, contentRight=${cardContentRight})`);

      // Verify no duplicate healthy message
      assert.strictEqual(metrics.statusAttr, "healthy", "healthy-desktop: top-level status is healthy");
      const conditionTexts = metrics.conditions.map((c) => c.text);
      const hasNoOverloaded = conditionTexts.some((t) => /No overloaded/i.test(t));
      assert.ok(!hasNoOverloaded,
        `healthy-desktop: conditions strip does not repeat "No overloaded sections" (got ${JSON.stringify(conditionTexts)})`);
      const hasCapacityHealthy = conditionTexts.some((t) => /Power capacity healthy/i.test(t));
      assert.ok(hasCapacityHealthy,
        `healthy-desktop: conditions strip shows "Power capacity healthy" instead of duplicate (got ${JSON.stringify(conditionTexts)})`);

      await page.screenshot({ path: path.join(artifactDir, "healthy-desktop.png") });
      await page.close();
      console.log("Wiring summary cards: healthy desktop layout passed");
    }

    // ── Test 2: Warning fixture at desktop width ──
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${base}/index.html`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__mfaMainLoaded === true, null, { timeout: 15000 }).catch(() => {});
      await setupWarningFixture(page);
      const metrics = await measureCards(page);
      assertCardLayout(metrics, "warning-desktop");
      assertEqualPadding(metrics, "warning-desktop");
      assertEqualRowHeight(metrics, "warning-desktop");
      assert.ok(metrics.panelScrollWidth <= metrics.panelClientWidth + 1,
        `warning-desktop: grid does not overflow panel`);
      // Warning state should show overloaded/broken conditions, not the healthy compact text
      const conditionTexts = metrics.conditions.map((c) => c.text);
      const hasCapacityHealthy = conditionTexts.some((t) => /Power capacity healthy/i.test(t));
      assert.ok(!hasCapacityHealthy,
        `warning-desktop: conditions strip does not show "Power capacity healthy" in warning state (got ${JSON.stringify(conditionTexts)})`);
      await page.screenshot({ path: path.join(artifactDir, "warning-desktop.png") });
      await page.close();
      console.log("Wiring summary cards: warning desktop layout passed");
    }

    // ── Test 3: Responsive — narrow panel forces fewer columns ──
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${base}/index.html`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__mfaMainLoaded === true, null, { timeout: 15000 }).catch(() => {});
      await setupHealthyFixture(page);

      // Narrow the viewport and verify no clipping at any size
      for (const [vw, vh] of [
        [1440, 900],
        [768, 1024],
        [430, 932],
        [360, 800]
      ]) {
        await page.setViewportSize({ width: vw, height: vh });
        await page.waitForTimeout(200);
        const metrics = await measureCards(page);
        assertCardLayout(metrics, `responsive-${vw}x${vh}`);
        assert.ok(metrics.panelScrollWidth <= metrics.panelClientWidth + 1,
          `responsive-${vw}x${vh}: grid does not overflow panel (${metrics.panelScrollWidth}/${metrics.panelClientWidth})`);
        // At narrow widths the grid should reduce columns
        if (vw <= 360) {
          assert.ok(metrics.columnCount <= 2,
            `responsive-${vw}x${vh}: narrow viewport reduces to <=2 columns (${metrics.columnCount})`);
        }
        // Verify no value is clipped
        for (const card of metrics.cards) {
          if (card.valueRect && card.cardRect) {
            const vRight = card.valueRect.x + card.valueRect.width;
            const cRight = card.cardRect.x + card.cardRect.width - card.paddingRight;
            assert.ok(vRight <= cRight + 1,
              `responsive-${vw}x${vh}: card "${card.label}" value "${card.value}" not clipped (vRight=${vRight}, cRight=${cRight})`);
          }
        }
      }
      await page.screenshot({ path: path.join(artifactDir, "responsive-narrow.png") });
      await page.close();
      console.log("Wiring summary cards: responsive layout passed");
    }

    // ── Test 4: Browser zoom 125% ──
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.25 });
      await page.goto(`${base}/index.html`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__mfaMainLoaded === true, null, { timeout: 15000 }).catch(() => {});
      await setupHealthyFixture(page);
      const metrics = await measureCards(page);
      assertCardLayout(metrics, "zoom-125");
      assert.ok(metrics.panelScrollWidth <= metrics.panelClientWidth + 1,
        `zoom-125: grid does not overflow panel`);
      await page.screenshot({ path: path.join(artifactDir, "zoom-125.png") });
      await page.close();
      console.log("Wiring summary cards: 125% zoom passed");
    }

    // ── Test 5: Browser zoom 150% ──
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
      await page.goto(`${base}/index.html`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__mfaMainLoaded === true, null, { timeout: 15000 }).catch(() => {});
      await setupHealthyFixture(page);
      const metrics = await measureCards(page);
      assertCardLayout(metrics, "zoom-150");
      assert.ok(metrics.panelScrollWidth <= metrics.panelClientWidth + 1,
        `zoom-150: grid does not overflow panel`);
      await page.screenshot({ path: path.join(artifactDir, "zoom-150.png") });
      await page.close();
      console.log("Wiring summary cards: 150% zoom passed");
    }

    await browser.close();
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    server.kill("SIGTERM");
  }
})();
