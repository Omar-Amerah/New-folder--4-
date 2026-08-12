#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server, getLog } = startServer(port);
let browser;

function edgeError(actual, expected) {
  return Math.max(
    Math.abs(actual.left - expected.left),
    Math.abs(actual.top - expected.top),
    Math.abs(actual.right - expected.right),
    Math.abs(actual.bottom - expected.bottom)
  );
}

function assertAligned(measurement, label) {
  const error = edgeError(measurement.preview, measurement.target);
  assert.ok(error <= 0.25, `${label} preview/grid edge error ${error.toFixed(4)}px exceeds tolerance`);
  assert.equal(measurement.inline.left, "", `${label} preview must not use inline left positioning`);
  assert.equal(measurement.inline.top, "", `${label} preview must not use inline top positioning`);
  assert.equal(measurement.inline.width, "", `${label} preview must not use inline width positioning`);
  assert.equal(measurement.inline.height, "", `${label} preview must not use inline height positioning`);
  assert.equal(measurement.computedPosition, "relative", `${label} preview is a CSS Grid item`);
  assert.equal(measurement.pointerEvents, "none", `${label} preview must not intercept pointer input`);
  assert.equal(measurement.previewParent, "buildGrid", `${label} preview remains an overlay child of the build grid`);
  assert.equal(measurement.gridColumn, `${measurement.bounds.minX + 1} / span ${measurement.bounds.width}`);
  assert.equal(measurement.gridRow, `${measurement.bounds.minY + 1} / span ${measurement.bounds.height}`);
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

(async () => {
  const pageErrors = [];
  const consoleErrors = [];
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1181, height: 900 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__mfaMainLoaded === true);
    await page.evaluate(async () => {
      const [{ state }, designer, screen] = await Promise.all([
        import("/src/state.js"),
        import("/src/ui/designerUi.js"),
        import("/src/ui/designerScreenUi.js")
      ]);
      screen.openBlueprintDesigner();
      state.mine = { money: 99999 };
      state.rules = { startingMoney: 99999 };
      state.design = [{ x: 1, y: 1, type: "core", rotation: 0 }];
      state.dataLinks = [];
      state.blueprintView = "build";
      state.selectedCell = null;
      window.__blueprintPlacementPreviewTest = { state, designer };
    });
    await page.waitForFunction(() => document.querySelector("#buildGrid")?.getBoundingClientRect().width > 0);

    const setupPlacement = (placement, { allowPartial = false } = {}) => page.evaluate(({ next, allowPartial: permitPartial }) => {
      const { state, designer } = window.__blueprintPlacementPreviewTest;
      state.design = [{ x: 1, y: 1, type: "core", rotation: 0 }];
      state.blueprintView = "build";
      state.selectedPart = next.type;
      state.previewRotation = next.rotation || 0;
      state.previewFlipped = next.flipped === true;
      state.hoveredCell = { x: next.x, y: next.y };
      state.selectedCell = null;
      designer.renderBaseBlueprintGrid();
      designer.renderHoverPreview();

      const preview = document.querySelector("#buildGrid .build-preview");
      if (!preview) throw new Error(`No placement preview rendered for ${next.type}`);
      const placementModule = window.__blueprintPlacementPreviewCandidate;
      const candidate = placementModule.createPlacementCandidate({
        grid: { x: next.x, y: next.y },
        componentType: next.type,
        rotation: next.rotation || 0,
        flipped: next.flipped === true,
        design: state.design,
        catalogue: placementModule.PART_STATS
      });
      if (!candidate.part) throw new Error(`Could not resolve placement candidate for ${next.type}`);
      const bounds = placementModule.getFootprintBounds(
        candidate.part.x,
        candidate.part.y,
        placementModule.PART_STATS[next.type]?.footprint || { width: 1, height: 1 },
        candidate.normalizedRotation,
        candidate.normalizedFlipped
      );
      const targetCells = [...document.querySelectorAll("#buildGrid .build-cell")].filter((cell) => {
        const x = Number(cell.dataset.x);
        const y = Number(cell.dataset.y);
        return x >= bounds.minX && x < bounds.minX + bounds.width && y >= bounds.minY && y < bounds.minY + bounds.height;
      });
      if (!bounds || (!permitPartial && targetCells.length !== bounds.width * bounds.height)) {
        throw new Error(`Could not resolve target grid cells for ${next.type}: ${targetCells.length}`);
      }
      const rects = targetCells.map((cell) => cell.getBoundingClientRect());
      const previewRect = preview.getBoundingClientRect();
      const target = {
        left: Math.min(...rects.map((rect) => rect.left)),
        top: Math.min(...rects.map((rect) => rect.top)),
        right: Math.max(...rects.map((rect) => rect.right)),
        bottom: Math.max(...rects.map((rect) => rect.bottom))
      };
      const computed = getComputedStyle(preview);
      const badge = preview.querySelector(".rotation-preview-badge");
      const auxiliary = (selector) => [...document.querySelectorAll(`#buildGrid ${selector}`)].map((element) => ({
        gridColumn: element.style.gridColumn,
        gridRow: element.style.gridRow,
        left: element.style.left,
        top: element.style.top,
        width: element.style.width,
        height: element.style.height,
        position: getComputedStyle(element).position,
        pointerEvents: getComputedStyle(element).pointerEvents
      }));
      return {
        type: next.type,
        bounds,
        preview: { left: previewRect.left, top: previewRect.top, right: previewRect.right, bottom: previewRect.bottom },
        target,
        gridWidth: document.getElementById("buildGrid").getBoundingClientRect().width,
        gridColumn: preview.style.gridColumn,
        gridRow: preview.style.gridRow,
        inline: {
          left: preview.style.left,
          top: preview.style.top,
          width: preview.style.width,
          height: preview.style.height
        },
        computedPosition: computed.position,
        pointerEvents: computed.pointerEvents,
        previewParent: preview.parentElement?.id || "",
        badgeParent: badge?.parentElement === preview,
        badgePosition: badge ? getComputedStyle(badge).position : "",
        exhaustOverlays: auxiliary(".engine-exhaust-preview"),
        thrustArrows: auxiliary(".engine-thrust-arrow")
      };
    }, { next: placement, allowPartial });

    // The candidate/bounds helper is kept in the page once so setupPlacement
    // can compare the rendered preview against the same footprint authority.
    await page.evaluate(async () => {
      const [{ PART_STATS }, candidate, footprint] = await Promise.all([
        import("/src/design/parts.js"),
        import("/src/design/placementCandidate.js"),
        import("/src/design/footprint.js")
      ]);
      window.__blueprintPlacementPreviewCandidate = {
        PART_STATS,
        createPlacementCandidate: candidate.createPlacementCandidate,
        getFootprintBounds: footprint.getFootprintBounds
      };
    });

    const oneByOne = [];
    for (const point of [{ x: 0, y: 0 }, { x: 7, y: 7 }, { x: 14, y: 14 }]) {
      const measurement = await setupPlacement({ type: "frame", ...point });
      assertAligned(measurement, `1x1 at ${point.x},${point.y}`);
      oneByOne.push({ point, error: edgeError(measurement.preview, measurement.target) });
    }
    assert.ok(oneByOne[2].error <= oneByOne[0].error + 0.01,
      `bottom-right preview drift increased: top-left=${oneByOne[0].error}, bottom-right=${oneByOne[2].error}`);

    const multiCell = await setupPlacement({ type: "heavyEngine", x: 13, y: 11 });
    assertAligned(multiCell, "2x3 at 13,11");
    assert.equal(multiCell.bounds.width, 2);
    assert.equal(multiCell.bounds.height, 3);
    assert.ok(multiCell.exhaustOverlays.length > 0, "engine exhaust preview is rendered for a multi-cell engine");
    for (const overlay of [...multiCell.exhaustOverlays, ...multiCell.thrustArrows]) {
      assert.match(overlay.gridColumn, /^\d+ \/ span 1$/, "engine overlay uses a CSS Grid column");
      assert.match(overlay.gridRow, /^\d+ \/ span 1$/, "engine overlay uses a CSS Grid row");
      assert.deepEqual(
        [overlay.left, overlay.top, overlay.width, overlay.height],
        ["", "", "", ""],
        "engine overlay does not reconstruct whole-grid pixel geometry"
      );
      assert.equal(overlay.position, "relative", "engine overlay is a positioned grid item");
      assert.equal(overlay.pointerEvents, "none", "engine overlay remains non-interactive");
    }

    const rotated = await setupPlacement({ type: "railgun", x: 12, y: 14, rotation: 90 });
    assertAligned(rotated, "rotated railgun at 12,14");
    assert.equal(rotated.bounds.width, 3, "90-degree railgun preview resolves the rotated width");
    assert.equal(rotated.bounds.height, 1, "90-degree railgun preview resolves the rotated height");
    assert.equal(rotated.badgeParent, true, "rotation badge is anchored inside the aligned preview");
    assert.equal(rotated.badgePosition, "absolute", "rotation badge uses local preview positioning");

    const flipped = await setupPlacement({ type: "halfArmorDiagonal", x: 14, y: 14, flipped: true });
    assertAligned(flipped, "flipped 1x1 at 14,14");

    const gridBeforeInvalid = await page.evaluate(() => document.getElementById("buildGrid").getBoundingClientRect().width);
    await setupPlacement({ type: "heavyEngine", x: 14, y: 13 }, { allowPartial: true });
    const invalidEdge = await page.evaluate(() => {
      const grid = document.getElementById("buildGrid");
      const preview = grid.querySelector(".build-preview");
      return {
        gridWidth: grid.getBoundingClientRect().width,
        gridColumn: preview?.style.gridColumn || "",
        gridRow: preview?.style.gridRow || "",
        hidden: Boolean(preview?.hidden)
      };
    });
    assert.equal(invalidEdge.gridWidth, gridBeforeInvalid, "an out-of-bounds preview does not resize the CSS Grid");
    assert.equal(invalidEdge.gridColumn, "15 / 16", "an out-of-bounds preview is clipped to explicit grid columns");
    assert.equal(invalidEdge.gridRow, "14 / 16", "an out-of-bounds preview is clipped to explicit grid rows");
    assert.equal(invalidEdge.hidden, false, "a partially visible invalid preview remains visible");

    await setupPlacement({ type: "frame", x: 14, y: 14 });
    await page.evaluate(() => { document.getElementById("buildGridStage").style.width = "646px"; });
    await page.setViewportSize({ width: 1000, height: 900 });
    await settle(page);
    const evenResize = await page.evaluate(() => {
      const preview = document.querySelector("#buildGrid .build-preview");
      const target = [...document.querySelectorAll("#buildGrid .build-cell")]
        .find((cell) => cell.dataset.x === "14" && cell.dataset.y === "14");
      const a = preview.getBoundingClientRect();
      const b = target.getBoundingClientRect();
      return {
        preview: { left: a.left, top: a.top, right: a.right, bottom: a.bottom },
        target: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
        gridWidth: document.getElementById("buildGrid").getBoundingClientRect().width
      };
    });
    assert.ok(edgeError(evenResize.preview, evenResize.target) <= 0.25,
      "active preview stays aligned after resizing to an even-track viewport");
    assert.equal(evenResize.gridWidth, 646, "even-track check uses an explicit rendered grid width");
    await page.evaluate(() => { document.getElementById("buildGridStage").style.width = "647px"; });
    await page.setViewportSize({ width: 1001, height: 900 });
    await settle(page);
    const fractionalResize = await page.evaluate(() => {
      const preview = document.querySelector("#buildGrid .build-preview");
      const target = [...document.querySelectorAll("#buildGrid .build-cell")]
        .find((cell) => cell.dataset.x === "14" && cell.dataset.y === "14");
      const a = preview.getBoundingClientRect();
      const b = target.getBoundingClientRect();
      return {
        preview: { left: a.left, top: a.top, right: a.right, bottom: a.bottom },
        target: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
        gridWidth: document.getElementById("buildGrid").getBoundingClientRect().width
      };
    });
    assert.ok(edgeError(fractionalResize.preview, fractionalResize.target) <= 0.25,
      "active preview stays aligned after resizing to a fractional-track viewport");
    assert.equal(fractionalResize.gridWidth, 647, "fractional-track check uses an explicit rendered grid width");
    assert.notEqual(evenResize.gridWidth, fractionalResize.gridWidth, "responsive checks use different rendered grid widths");

    if (pageErrors.length || consoleErrors.length) {
      throw new Error(`browser errors during placement-preview test: ${JSON.stringify({ pageErrors, consoleErrors })}`);
    }
    console.log("Blueprint placement preview CSS Grid alignment passed");
  } catch (error) {
    console.error(error.stack || error);
    if (getLog()) console.error(getLog());
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
  }
})();
