/**
 * Browser benchmark for Wiring hover/render performance.
 *
 * This module creates a large valid Blueprint with many Data and Power sections,
 * switches to the Wiring Data inspector and runs the scenarios requested in the
 * performance review.  Results are logged to the console and returned.
 *
 * Usage from a loaded game page:
 *   const mod = await import("/benchmark-wiring-hover.js");
 *   const result = await mod.runWiringHoverBenchmark();
 */

export async function runWiringHoverBenchmark() {
  const [{ state }, { PART_STATS }, wiring, designer] = await Promise.all([
    import("/src/state.js"),
    import("/src/design/parts.js"),
    import("/src/ui/wiringUi.js"),
    import("/src/ui/designerUi.js")
  ]);

  const WiringRules = globalThis.WiringRules;
  if (!WiringRules) throw new Error("WiringRules global is not loaded");

  function buildLargeDesign() {
    const design = [
      { x: 7, y: 7, type: "core", rotation: 0 },
      { x: 7, y: 6, type: "reactor", rotation: 0 },
      { x: 5, y: 7, type: "signalAmplifier", rotation: 0 },
      { x: 9, y: 7, type: "signalAmplifier", rotation: 0 },
      { x: 7, y: 5, type: "signalAmplifier", rotation: 0 },
      { x: 7, y: 9, type: "signalAmplifier", rotation: 0 }
    ];
    const occupied = new Set(design.map((m) => `${m.x},${m.y}`));
    for (let y = 4; y < 11; y += 1) {
      for (let x = 4; x < 11; x += 1) {
        const key = `${x},${y}`;
        if (occupied.has(key)) continue;
        design.push({ x, y, type: "frame", rotation: 0 });
      }
    }
    const weapons = [
      { x: 5, y: 5, type: "blaster", rotation: 0 },
      { x: 9, y: 5, type: "blaster", rotation: 0 },
      { x: 5, y: 9, type: "blaster", rotation: 0 },
      { x: 9, y: 9, type: "blaster", rotation: 0 }
    ];
    design.push(...weapons);
    return design;
  }

  function buildWiring(design) {
    let w = WiringRules.emptyWiring();
    // Power routes from the central reactor to each blaster.
    w = WiringRules.addPath(w, "power", [{ x: 7, y: 6 }, { x: 7, y: 5 }], design, PART_STATS);
    w = WiringRules.addPath(w, "power", [{ x: 7, y: 6 }, { x: 7, y: 7 }, { x: 7, y: 8 }], design, PART_STATS);
    // Data routes from each amplifier to nearby blasters.
    w = WiringRules.addPath(w, "data", [{ x: 5, y: 7 }, { x: 5, y: 6 }, { x: 5, y: 5 }], design, PART_STATS);
    w = WiringRules.addPath(w, "data", [{ x: 9, y: 7 }, { x: 9, y: 6 }, { x: 9, y: 5 }], design, PART_STATS);
    w = WiringRules.addPath(w, "data", [{ x: 7, y: 9 }, { x: 7, y: 8 }, { x: 7, y: 7 }, { x: 6, y: 7 }, { x: 5, y: 7 }], design, PART_STATS);
    w = WiringRules.addPath(w, "data", [{ x: 7, y: 9 }, { x: 7, y: 8 }, { x: 7, y: 7 }, { x: 8, y: 7 }, { x: 9, y: 7 }], design, PART_STATS);
    w = WiringRules.addPath(w, "data", [{ x: 7, y: 5 }, { x: 7, y: 6 }, { x: 7, y: 7 }, { x: 6, y: 7 }, { x: 5, y: 7 }], design, PART_STATS);
    w = WiringRules.addPath(w, "data", [{ x: 7, y: 5 }, { x: 7, y: 6 }, { x: 7, y: 7 }, { x: 8, y: 7 }, { x: 9, y: 7 }], design, PART_STATS);
    return w;
  }

  const design = buildLargeDesign();
  const builtWiring = buildWiring(design);

  state.design = design;
  state.wiring = builtWiring;
  state.thermalLoadMode = "combat";
  state.wiringUi.mode = "data";
  state.wiringUi.wiringTool = "inspect";

  designer.setBlueprintView("wiring");
  wiring.refreshWiringPresentation();

  const host = document.querySelector("#wiringOverlayHost");
  const svg = document.querySelector("svg.wiring-overlay");
  if (!host || !svg) throw new Error("Wiring overlay is not available for benchmarking");
  const rect = svg.getBoundingClientRect();
  const toScreen = (gridX, gridY) => ({
    x: rect.left + (gridX + 0.5) * rect.width / 15,
    y: rect.top + (gridY + 0.5) * rect.height / 15
  });

  function reset() {
    wiring.resetWiringPerformanceCounters();
  }

  function measure(label, fn) {
    reset();
    const t0 = performance.now();
    fn();
    const duration = performance.now() - t0;
    return { label, durationMs: duration, counters: wiring.getWiringPerformanceCounters() };
  }

  // Allow one animation frame to flush any pending rAF work between scenarios.
  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

  const results = [];

  // 1. 1,000 pointer moves in the same cell.
  const sameCell = toScreen(7, 7);
  results.push(measure("1,000 pointer moves in same cell", () => {
    for (let i = 0; i < 1000; i += 1) {
      host.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: sameCell.x,
        clientY: sameCell.y,
        pointerType: "mouse"
      }));
    }
  }));
  await nextFrame();

  // 2. 100 distinct cell pointer moves.
  results.push(measure("100 distinct cell pointer moves", () => {
    for (let i = 0; i < 100; i += 1) {
      const gx = 4 + (i % 7);
      const gy = 4 + Math.floor(i / 7) % 7;
      const p = toScreen(gx, gy);
      host.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: p.x,
        clientY: p.y,
        pointerType: "mouse"
      }));
    }
  }));
  await nextFrame();

  // 3. Hover every Data section.
  const dataHits = [...host.querySelectorAll('.wire-hit[data-section-id]')];
  results.push(measure(`hover every Data section (${dataHits.length})`, () => {
    for (const hit of dataHits) {
      const r = hit.getBoundingClientRect();
      hit.dispatchEvent(new MouseEvent("mouseover", {
        bubbles: true,
        cancelable: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2
      }));
    }
  }));
  await nextFrame();

  // 4. Select several Data networks.
  const analysis = WiringRules.analyzeWiring(state.design, state.wiring, PART_STATS);
  const networkIds = (analysis.data?.networks || []).slice(0, 5).map((n) => n.id);
  results.push(measure(`select ${networkIds.length} Data networks`, () => {
    for (const id of networkIds) {
      state.wiringUi.selectedDataNetworkId = id;
      wiring.refreshWiringPresentation();
    }
  }));
  await nextFrame();

  // 5. Commit one route.
  const before = state.wiring;
  const newWiring = WiringRules.addPath(before, "data", [
    { x: 9, y: 9 }, { x: 9, y: 8 }, { x: 9, y: 7 }
  ], state.design, PART_STATS);
  results.push(measure("commit one Data route", () => {
    state.wiring = newWiring;
    wiring.refreshWiringPresentation();
  }));
  await nextFrame();

  // 6. Undo/redo style switches.
  const afterCommit = state.wiring;
  results.push(measure("undo and redo wiring", () => {
    state.wiring = before;
    wiring.refreshWiringPresentation();
    state.wiring = afterCommit;
    wiring.refreshWiringPresentation();
  }));
  await nextFrame();

  const summary = {
    scenarios: results,
    totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0)
  };
  console.log("Wiring hover benchmark:", summary);
  return summary;
}

globalThis.runWiringHoverBenchmark = runWiringHoverBenchmark;
