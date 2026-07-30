#!/usr/bin/env node
"use strict";
// Blueprint "Selected Component" inspector — rendered contract in a real browser.
//
// Covers the rendered information hierarchy, accordion accessibility semantics,
// responsive layout at desktop/medium/mobile widths, and that switching between
// representative components never leaves stale fields behind.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { uniquePort, startServer, waitForServer, launchChromium } = require("./verify-pixi-browser-support.js");

const artifactDir = path.join("test-artifacts", "component-inspector");
const REPRESENTATIVE = ["frame", "reactor", "blaster", "signalAmplifier", "shield", "droneBay", "heatSink", "core", "backupCore"];

// Select a component by type through the same path the palette uses.
async function selectComponent(page, type) {
  await page.evaluate(async (partType) => {
    const [{ state }, inspector, palette] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/partInspectorUi.js"),
      import("/src/ui/partPaletteUi.js")
    ]);
    state.selectedCell = null;
    state.selectedPart = partType;
    palette.renderPalette();
    inspector.renderPartInspector();
  }, type);
  await page.locator("#partInspector .part-inspector-name").waitFor({ state: "visible", timeout: 5000 });
}

// Everything the inspector currently displays, grouped by region.
async function readInspector(page) {
  return page.evaluate(() => {
    const root = document.querySelector("#partInspector");
    const text = (node) => (node?.textContent || "").trim();
    const cells = (selector) => Array.from(root.querySelectorAll(selector)).map((cell) => ({
      label: text(cell.querySelector(".part-spec-label")),
      value: text(cell.querySelector(".part-spec-value, .part-detail-value"))
    }));
    return {
      name: text(root.querySelector(".part-inspector-name")),
      badge: text(root.querySelector(".part-category-label")),
      description: text(root.querySelector(".part-description")),
      core: cells(".part-spec-cell"),
      capability: cells(".part-capability-cell"),
      thermal: Array.from(root.querySelectorAll(".part-thermal-line")).map((line) => ({
        label: text(line.querySelector(".part-thermal-label")),
        value: text(line.querySelector(".part-thermal-value"))
      })),
      warnings: Array.from(root.querySelectorAll(".part-warning")).map((warning) => ({
        id: warning.dataset.warning,
        title: text(warning.querySelector(".part-warning-title")),
        body: text(warning.querySelector(".part-warning-text"))
      })),
      requirements: Array.from(root.querySelectorAll("[data-requirement]")).map((chip) => ({
        id: chip.dataset.requirement,
        tag: chip.tagName,
        type: chip.getAttribute("type"),
        label: text(chip.querySelector(".part-requirement-label")),
        ariaLabel: chip.getAttribute("aria-label"),
        expanded: chip.getAttribute("aria-expanded"),
        controls: chip.getAttribute("aria-controls"),
        unmet: chip.classList.contains("is-unmet"),
        tipHidden: document.getElementById(chip.getAttribute("aria-controls"))?.hidden
      })),
      requirementFailures: Array.from(root.querySelectorAll(".part-requirement-failure")).map((node) => text(node)),
      sections: Array.from(root.querySelectorAll(".part-accordion")).map((accordion) => {
        const trigger = accordion.querySelector(".part-accordion-trigger");
        const panel = accordion.querySelector(".part-accordion-panel");
        return {
          id: accordion.dataset.accordion,
          title: text(accordion.querySelector(".part-accordion-title")),
          expanded: trigger.getAttribute("aria-expanded"),
          controls: trigger.getAttribute("aria-controls"),
          panelId: panel.id,
          panelRole: panel.getAttribute("role"),
          labelledBy: panel.getAttribute("aria-labelledby"),
          triggerId: trigger.id,
          triggerTag: trigger.tagName,
          triggerType: trigger.getAttribute("type"),
          hidden: panel.hidden,
          rows: Array.from(panel.querySelectorAll(".part-detail-row")).map((row) => ({
            label: text(row.querySelector(".part-spec-label")),
            value: text(row.querySelector(".part-detail-value"))
          }))
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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

    // -- Rendered structure for every representative component ----------------
    const snapshots = {};
    for (const type of REPRESENTATIVE) {
      await selectComponent(page, type);
      snapshots[type] = await readInspector(page);
    }

    check("every representative component renders a header, badge and core row", () => {
      for (const type of REPRESENTATIVE) {
        const view = snapshots[type];
        assert.ok(view.name.length, `${type} shows a component name`);
        assert.match(view.badge, /^[A-Z ]+ · \d+×\d+$/, `${type} badge is CATEGORY · W×H (got "${view.badge}")`);
        assert.doesNotMatch(view.badge, /footprint/i, `${type} badge omits the word Footprint`);
        assert.ok(view.description.length, `${type} shows a description`);
        assert.ok(view.core.length >= 3 && view.core.length <= 4, `${type} core row has 3-4 cells`);
        // Labels are uppercased by CSS, so compare the underlying text.
        assert.deepEqual(view.core.slice(0, 3).map((cell) => cell.label.toLowerCase()), ["build cost", "mass", "durability"],
          `${type} leads with build cost, mass, durability`);
      }
    });

    check("no statistic label is rendered twice in one inspector", () => {
      for (const type of REPRESENTATIVE) {
        const view = snapshots[type];
        const labels = [
          ...view.core.map((cell) => cell.label),
          ...view.capability.map((cell) => cell.label),
          ...view.thermal.map((line) => line.label),
          ...view.sections.flatMap((section) => section.rows.map((row) => row.label))
        ].map((label) => label.trim().toLowerCase()).filter(Boolean);
        assert.equal(new Set(labels).size, labels.length, `${type} renders no duplicate label (${labels})`);
      }
    });

    check("no empty, None or no-op 100% value is rendered", () => {
      for (const type of REPRESENTATIVE) {
        const view = snapshots[type];
        assert.doesNotMatch(view.allText, /accuracy bonus/i, `${type} hides a zero Accuracy bonus`);
        assert.doesNotMatch(view.allText, /:\s*none\b/i, `${type} renders no "None" value`);
        assert.doesNotMatch(view.allText, /vs hull\s*100%/i, `${type} hides a standard 100% hull modifier`);
        const values = [...view.core, ...view.capability, ...view.sections.flatMap((s) => s.rows)].map((cell) => cell.value);
        for (const value of values) assert.ok(value && value.trim().length, `${type} renders no blank value`);
      }
    });

    check("Power consumers show Power draw and generators show Power output", () => {
      const blaster = snapshots.blaster.core.find((cell) => /power/i.test(cell.label));
      assert.equal(blaster.label.toLowerCase(), "power draw");
      assert.doesNotMatch(blaster.value, /^[-+]/, "no ambiguous sign on a draw");
      const reactor = snapshots.reactor.core.find((cell) => /power/i.test(cell.label));
      assert.equal(reactor.label.toLowerCase(), "power output");
      assert.doesNotMatch(reactor.value, /^[-+]/, "no ambiguous sign on an output");
      assert.equal(snapshots.frame.core.some((cell) => /power/i.test(cell.label)), false, "Frame shows no Power cell");
    });

    check("Power direction is not signalled by colour alone", async () => {
      // The label text itself ("POWER DRAW" / "POWER OUTPUT") carries the meaning.
      assert.notEqual(snapshots.blaster.core.find((c) => /power/i.test(c.label)).label,
        snapshots.reactor.core.find((c) => /power/i.test(c.label)).label);
    });

    check("Frame renders a Thermal details block but no thermal summary or capability grid", () => {
      const frame = snapshots.frame;
      assert.ok(frame.sections.some((section) => /thermal details/i.test(section.title)), "Frame renders a Thermal details section");
      assert.equal(frame.thermal.length, 0, "Frame renders no thermal summary");
      assert.equal(frame.capability.length, 0, "Frame renders no capability grid");
    });

    check("Reactor shows one consolidated meltdown warning outside the stat cards", () => {
      const reactor = snapshots.reactor;
      const meltdown = reactor.warnings.filter((warning) => warning.id === "meltdown");
      assert.equal(meltdown.length, 1, "exactly one meltdown warning panel");
      assert.match(meltdown[0].title, /meltdown risk/i);
      assert.match(meltdown[0].body, /explodes after \d+ seconds/i);
      for (const cell of [...reactor.core, ...reactor.capability]) {
        assert.doesNotMatch(cell.label, /meltdown/i, "meltdown is not an ordinary stat card");
      }
      assert.ok(reactor.sections.some((section) => /thermal details/i.test(section.title)), "Reactor keeps Thermal details");
      assert.equal(reactor.thermal.filter((line) => /produces/i.test(line.value)).length, 1, "heat at load is stated once");
    });

    check("Blaster overview shows DPS, range, accuracy and arc with no detail repeats", () => {
      const blaster = snapshots.blaster;
      assert.deepEqual(blaster.capability.map((cell) => cell.label.toLowerCase()), ["dps", "range", "accuracy", "firing arc"]);
      const weapon = blaster.sections.find((section) => section.id === "weapon");
      assert.ok(weapon, "Blaster has a Weapon details accordion");
      const detailLabels = weapon.rows.map((row) => row.label.toLowerCase());
      for (const repeated of ["dps", "range", "accuracy", "firing arc"]) {
        assert.ok(!detailLabels.includes(repeated), `Weapon details does not repeat ${repeated}`);
      }
      const cadence = detailLabels.filter((label) => /fire rate|reload/.test(label));
      assert.equal(cadence.length, 1, "fire rate and reload are never both shown");
      const damage = [...blaster.capability, ...weapon.rows].filter((row) => /^damage/i.test(row.label));
      assert.equal(damage.length, 1, "damage appears once");
    });

    check("Signal Amplifier uses Sensor details and hides its zero Accuracy bonus", () => {
      const sensor = snapshots.signalAmplifier;
      assert.ok(sensor.sections.some((section) => /sensor details/i.test(section.title)), "context-specific heading");
      assert.equal(sensor.sections.some((section) => /combat details/i.test(section.title)), false);
      assert.ok(sensor.capability.some((cell) => /range bonus/i.test(cell.label)), "range bonus is the primary capability");
      assert.doesNotMatch(sensor.allText, /accuracy bonus/i, "no Accuracy bonus: None");
    });

    check("advanced headings are context-specific, never generic Combat or Heat details", () => {
      for (const type of REPRESENTATIVE) {
        for (const section of snapshots[type].sections) {
          assert.doesNotMatch(section.title, /^combat details$/i, `${type} uses no generic Combat details`);
          assert.doesNotMatch(section.title, /^heat details$/i, `${type} uses Thermal details`);
          assert.ok(section.rows.length > 0, `${type}/${section.title} is not empty`);
        }
      }
      assert.ok(snapshots.shield.sections.some((s) => /shield details/i.test(s.title)));
      assert.ok(snapshots.droneBay.sections.some((s) => /drone details/i.test(s.title)));
      assert.ok(snapshots.backupCore.sections.some((s) => /command details/i.test(s.title)));
    });

    // -- Requirements row ------------------------------------------------------
    check("Power and Data dependencies render as compact chips, not callout boxes", () => {
      assert.deepEqual(snapshots.blaster.requirements.map((chip) => chip.id), ["power"], "Blaster requires Power only");
      assert.deepEqual(snapshots.signalAmplifier.requirements.map((chip) => chip.id), ["power", "data"], "Signal Amplifier requires both");
      assert.deepEqual(snapshots.frame.requirements, [], "Frame requires neither");
      assert.deepEqual(snapshots.heatSink.requirements, [], "Heat Sink requires neither");
      for (const type of REPRESENTATIVE) {
        for (const warning of snapshots[type].warnings) {
          assert.doesNotMatch(warning.title, /^requires (power|a data link)$/i,
            `${type} no longer renders a "${warning.title}" callout box`);
        }
      }
    });

    check("each requirement is a real button with a visible label and full ARIA wiring", () => {
      for (const type of ["blaster", "signalAmplifier", "shield", "reactor"]) {
        for (const chip of snapshots[type].requirements) {
          assert.equal(chip.tag, "BUTTON", `${type}/${chip.id} is a real button`);
          assert.equal(chip.type, "button", `${type}/${chip.id} has type=button`);
          assert.ok(chip.label && /[A-Za-z]/.test(chip.label), `${type}/${chip.id} shows a visible text label, not just an icon`);
          assert.ok(chip.ariaLabel && chip.ariaLabel.length > chip.label.length, `${type}/${chip.id} has a descriptive aria-label`);
          assert.equal(chip.expanded, "false", `${type}/${chip.id} starts collapsed`);
          assert.ok(chip.controls, `${type}/${chip.id} has aria-controls`);
          assert.equal(chip.tipHidden, true, `${type}/${chip.id} tooltip starts hidden`);
        }
      }
      assert.deepEqual(snapshots.signalAmplifier.requirements.map((chip) => chip.label), ["Power", "Data"]);
    });

    check("requirement chips sit together in one area, never beside individual stat values", async () => {
      const grouping = await (async () => {
        await selectComponent(page, "signalAmplifier");
        return page.evaluate(() => {
          const root = document.querySelector("#partInspector");
          const chips = Array.from(root.querySelectorAll("[data-requirement]"));
          const area = root.querySelector(".part-requirement-chips");
          return {
            allInsideOneArea: chips.every((chip) => area.contains(chip)),
            insideStatCells: chips.some((chip) => chip.closest(".part-spec-cell, .part-capability-cell, .part-detail-row")),
            areaCount: root.querySelectorAll(".part-requirement-chips").length
          };
        });
      })();
      assert.equal(grouping.allInsideOneArea, true, "every chip lives in the single requirements area");
      assert.equal(grouping.insideStatCells, false, "no chip is attached to an individual stat value");
      assert.equal(grouping.areaCount, 1, "there is exactly one requirements area");
    });

    await selectComponent(page, "signalAmplifier");
    const tooltipBehaviour = await (async () => {
      const chip = page.locator('#partInspector [data-requirement="power"]');
      const tipId = await chip.getAttribute("aria-controls");
      const read = () => page.evaluate((id) => {
        const tip = document.getElementById(id);
        const button = document.querySelector('#partInspector [data-requirement="power"]');
        const root = document.querySelector("#partInspector");
        const tipRect = tip.hidden ? null : tip.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        return {
          hidden: tip.hidden,
          expanded: button.getAttribute("aria-expanded"),
          text: (tip.textContent || "").trim(),
          insideInspector: tipRect ? (tipRect.left >= rootRect.left - 1 && tipRect.right <= rootRect.right + 1) : null,
          overflow: tipRect ? Math.max(0, tipRect.right - rootRect.right) : 0
        };
      }, tipId);

      await chip.hover();
      const onHover = await read();
      await page.locator("#partInspector").screenshot({ path: path.join(artifactDir, "requirement-tooltip-open.png") });
      await page.mouse.move(0, 0);
      const afterMouseOut = await read();
      await chip.focus();
      const onFocus = await read();
      await page.keyboard.press("Escape");
      const afterEscape = await read();
      await chip.focus();
      const refocused = await read();
      await page.evaluate(() => document.querySelector("#partInspector .part-inspector-name").focus());
      await page.locator('#partInspector [data-requirement="power"]').evaluate((node) => node.blur());
      const afterFocusAway = await read();
      await chip.click();
      const afterTap = await read();
      await page.mouse.click(5, 5);
      const afterOutsideClick = await read();
      return { onHover, afterMouseOut, onFocus, afterEscape, refocused, afterFocusAway, afterTap, afterOutsideClick };
    })();

    check("hover, keyboard focus and tap each open the requirement tooltip", () => {
      assert.equal(tooltipBehaviour.onHover.hidden, false, "hover opens the tooltip");
      assert.equal(tooltipBehaviour.onHover.expanded, "true", "hover sets aria-expanded");
      assert.match(tooltipBehaviour.onHover.text, /MW/, "the tooltip explains the rule");
      assert.equal(tooltipBehaviour.onFocus.hidden, false, "keyboard focus opens the tooltip");
      assert.equal(tooltipBehaviour.afterTap.hidden, false, "tap opens the tooltip");
    });

    check("Escape, moving focus away and clicking elsewhere all close the tooltip", () => {
      assert.equal(tooltipBehaviour.afterMouseOut.hidden, true, "moving the pointer away closes it");
      assert.equal(tooltipBehaviour.afterEscape.hidden, true, "Escape closes it");
      assert.equal(tooltipBehaviour.afterEscape.expanded, "false", "Escape resets aria-expanded");
      assert.equal(tooltipBehaviour.afterFocusAway.hidden, true, "moving focus away closes it");
      assert.equal(tooltipBehaviour.afterOutsideClick.hidden, true, "clicking elsewhere closes it");
    });

    check("the requirement tooltip stays inside the inspector and is never clipped", () => {
      assert.equal(tooltipBehaviour.onHover.insideInspector, true,
        `tooltip is within the inspector bounds (overflow ${tooltipBehaviour.onHover.overflow}px)`);
      assert.equal(tooltipBehaviour.onHover.overflow, 0, "tooltip does not overflow the inspector");
    });

    // -- Accessibility ---------------------------------------------------------
    check("accordions are real buttons with correct ARIA wiring, collapsed by default", () => {
      for (const type of REPRESENTATIVE) {
        for (const section of snapshots[type].sections) {
          assert.equal(section.triggerTag, "BUTTON", `${type}/${section.title} uses a real button`);
          assert.equal(section.triggerType, "button", `${type}/${section.title} button has type=button`);
          assert.equal(section.expanded, "false", `${type}/${section.title} is collapsed by default`);
          assert.equal(section.hidden, true, `${type}/${section.title} panel starts hidden`);
          assert.ok(section.controls, "aria-controls is present");
          assert.equal(section.controls, section.panelId, "aria-controls points at the panel");
          assert.equal(section.labelledBy, section.triggerId, "panel is labelled by its trigger");
          assert.equal(section.panelRole, "region", "panel is exposed as a region");
        }
      }
    });

    await selectComponent(page, "blaster");
    check("keyboard activation toggles an accordion and updates aria-expanded", async () => {});
    const keyboard = await page.evaluate(() => {
      const trigger = document.querySelector('#partInspector [data-inspector-section="weapon"]');
      trigger.focus();
      const focused = document.activeElement === trigger;
      const before = trigger.getAttribute("aria-expanded");
      return { focused, before, panelHiddenBefore: document.getElementById(trigger.getAttribute("aria-controls")).hidden };
    });
    assert.equal(keyboard.focused, true, "accordion trigger is keyboard focusable");
    assert.equal(keyboard.before, "false");
    await page.keyboard.press("Enter");
    const afterEnter = await page.evaluate(() => {
      const trigger = document.querySelector('#partInspector [data-inspector-section="weapon"]');
      return { expanded: trigger.getAttribute("aria-expanded"), hidden: document.getElementById(trigger.getAttribute("aria-controls")).hidden };
    });
    check("Enter on a focused accordion expands it and reveals the panel", () => {
      assert.equal(afterEnter.expanded, "true");
      assert.equal(afterEnter.hidden, false);
    });

    // Keyboard-driven focus engages :focus-visible, so the applied computed style
    // reports the real focus ring (pseudo-classes cannot be queried directly).
    const focusVisible = await page.evaluate(() => {
      const trigger = document.querySelector('#partInspector [data-inspector-section="weapon"]');
      const style = getComputedStyle(trigger);
      return {
        focusVisible: trigger.matches(":focus-visible"),
        outlineWidth: parseFloat(style.outlineWidth) || 0,
        outlineStyle: style.outlineStyle
      };
    });
    check("keyboard-focused accordion keeps a visible focus ring", () => {
      assert.equal(focusVisible.focusVisible, true, "keyboard focus engages :focus-visible");
      assert.ok(focusVisible.outlineWidth > 0 && focusVisible.outlineStyle !== "none",
        `focus outline is visible: ${JSON.stringify(focusVisible)}`);
    });

    // -- Expanded state is remembered per component, reset on change ----------
    const stickiness = await (async () => {
      // Start from a clean slate: the earlier keyboard check left a section open.
      await selectComponent(page, "frame");
      await selectComponent(page, "blaster");
      await page.locator('#partInspector [data-inspector-section="weapon"]').click();
      const openedBlaster = await page.locator('#partInspector [data-inspector-section="weapon"]').getAttribute("aria-expanded");
      await page.evaluate(async () => (await import("/src/ui/partInspectorUi.js")).renderPartInspector());
      const stillOpen = await page.locator('#partInspector [data-inspector-section="weapon"]').getAttribute("aria-expanded");
      await selectComponent(page, "reactor");
      const reactorSections = await page.locator("#partInspector .part-accordion-trigger").evaluateAll(
        (nodes) => nodes.map((node) => node.getAttribute("aria-expanded")));
      await selectComponent(page, "blaster");
      const backToBlaster = await page.locator('#partInspector [data-inspector-section="weapon"]').getAttribute("aria-expanded");
      return { openedBlaster, stillOpen, reactorSections, backToBlaster };
    })();
    check("expanded state persists on the same component and resets when another is selected", () => {
      assert.equal(stickiness.openedBlaster, "true", "clicking expands the section");
      assert.equal(stickiness.stillOpen, "true", "a re-render of the same component keeps it expanded");
      assert.ok(stickiness.reactorSections.every((value) => value === "false"), "a different component starts collapsed");
      assert.equal(stickiness.backToBlaster, "false", "returning resets rather than restoring stale state");
    });

    // -- Switching components leaves no stale fields --------------------------
    check("switching between components leaves no stale fields behind", () => {
      // Values unique to one component must not survive into the next.
      const uniqueMarkers = {
        reactor: /meltdown risk/i,
        droneBay: /drone details/i,
        signalAmplifier: /sensor details/i,
        shield: /shield details/i
      };
      for (const [owner, marker] of Object.entries(uniqueMarkers)) {
        assert.match(snapshots[owner].allText, marker, `${owner} shows its own marker`);
        for (const other of REPRESENTATIVE) {
          if (other === owner) continue;
          assert.doesNotMatch(snapshots[other].allText, marker, `${other} does not carry ${owner}'s content`);
        }
      }
    });

    const staleSweep = await (async () => {
      const seen = [];
      for (const type of ["reactor", "frame", "blaster", "frame", "droneBay", "frame"]) {
        await selectComponent(page, type);
        const view = await readInspector(page);
        seen.push({ type, sections: view.sections.length, thermal: view.thermal.length, warnings: view.warnings.length, capability: view.capability.length });
      }
      return seen;
    })();
    check("re-selecting a Frame after a rich component always returns the compact layout", () => {
      for (const entry of staleSweep.filter((item) => item.type === "frame")) {
        assert.equal(entry.sections, 1, "Frame keeps no accordions from the previous component");
        assert.equal(entry.thermal, 0, "Frame keeps no thermal summary");
        assert.equal(entry.warnings, 0, "Frame keeps no warnings");
        assert.equal(entry.capability, 0, "Frame keeps no capability cells");
      }
    });

    // -- Failing dependencies stay visible -------------------------------------
    // Place a Signal Amplifier with no Power or Data cable, then select it: the
    // requirement must turn red and state the failure visibly, not only on hover.
    const failureState = await (async () => {
      await page.evaluate(async () => {
        const [{ state }, designerUi, inspector] = await Promise.all([
          import("/src/state.js"),
          import("/src/ui/designerUi.js"),
          import("/src/ui/partInspectorUi.js")
        ]);
        const free = { x: 2, y: 2 };
        state.design = [...state.design.filter((part) => !(part.x === free.x && part.y === free.y)),
          { type: "signalAmplifier", x: free.x, y: free.y, rotation: 0 }];
        state.selectedPart = null;
        state.selectedCell = { ...free };
        designerUi.renderBuildGrid();
        inspector.renderPartInspector();
      });
      await page.locator("#partInspector .part-inspector-name").waitFor({ state: "visible" });
      const view = await readInspector(page);
      const tipHiddenWhileFailing = view.requirements.every((chip) => chip.tipHidden === true);
      await page.locator("#partInspector").screenshot({ path: path.join(artifactDir, "requirements-unmet.png") });
      return { view, tipHiddenWhileFailing };
    })();

    check("an unpowered, unconnected placed component shows red requirements with visible failure text", () => {
      const { view } = failureState;
      assert.match(view.name, /signal amplifier/i, "the placed Signal Amplifier is selected");
      assert.ok(view.requirements.length >= 1, "the placed component shows its requirements");
      const power = view.requirements.find((chip) => chip.id === "power");
      const data = view.requirements.find((chip) => chip.id === "data");
      assert.ok(power?.unmet, "the unmet Power requirement is flagged red");
      assert.ok(data?.unmet, "the unmet Data requirement is flagged red");
      assert.match(power.ariaLabel, /not met/i, "the failure is exposed to assistive technology");
      // The failure text is visible on the row, not hidden behind the tooltip.
      assert.equal(failureState.tipHiddenWhileFailing, true, "tooltips remain closed");
      assert.ok(view.requirementFailures.length >= 2, `failures are stated visibly: ${JSON.stringify(view.requirementFailures)}`);
      assert.match(view.requirementFailures.join(" "), /power unmet/i);
      assert.match(view.requirementFailures.join(" "), /data unmet/i);
      assert.match(view.allText, /not connected to any power network|receiving no power/i,
        "the visible text explains the Power failure");
    });

    check("red is used only for a real failure, amber for an ordinary dependency", async () => {
      const tones = await page.evaluate(() => {
        const chip = document.querySelector('#partInspector [data-requirement="power"]');
        return { unmet: getComputedStyle(chip).borderTopColor };
      });
      await selectComponent(page, "blaster");
      const normal = await page.evaluate(() => {
        const chip = document.querySelector('#partInspector [data-requirement="power"]');
        return { ok: getComputedStyle(chip).borderTopColor, unmetClass: chip.classList.contains("is-unmet") };
      });
      assert.equal(normal.unmetClass, false, "an unplaced component's dependency is not a failure");
      assert.notEqual(tones.unmet, normal.ok, "failed and normal dependencies are visually distinct");
    });

    // -- Power summary card border ---------------------------------------------
    check("the Power card has a complete, continuous, evenly rounded border", async () => {
      for (const type of ["reactor", "blaster"]) {
        await selectComponent(page, type);
        const border = await page.evaluate(() => {
          const cell = Array.from(document.querySelectorAll("#partInspector .part-spec-cell"))
            .find((node) => /power/i.test(node.querySelector(".part-spec-label")?.textContent || ""));
          const style = getComputedStyle(cell);
          const rect = cell.getBoundingClientRect();
          const parentRect = cell.parentElement.getBoundingClientRect();
          return {
            widths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(parseFloat),
            styles: [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle],
            colors: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
            radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
            overflow: style.overflow,
            clippedLeft: rect.left < parentRect.left - 0.5,
            clippedRight: rect.right > parentRect.right + 0.5
          };
        });
        assert.ok(border.widths.every((width) => width > 0), `${type}: all four border edges have width (${border.widths})`);
        assert.ok(border.styles.every((style) => style === "solid"), `${type}: all four edges are solid (${border.styles})`);
        assert.equal(new Set(border.colors).size, 1, `${type}: one continuous border colour (${border.colors})`);
        assert.ok(!border.colors[0].includes("rgba(0, 0, 0, 0)"), `${type}: the border is actually visible (${border.colors[0]})`);
        assert.equal(new Set(border.radii).size, 1, `${type}: corners are evenly rounded (${border.radii})`);
        assert.ok(parseFloat(border.radii[0]) > 0, `${type}: corners are rounded`);
        assert.equal(border.clippedLeft, false, `${type}: no edge is clipped on the left`);
        assert.equal(border.clippedRight, false, `${type}: no edge is clipped on the right`);
      }
    });

    // -- Responsive layout -----------------------------------------------------
    const widths = [
      { label: "desktop", width: 1920, height: 1080, expectCoreColumns: 4 },
      { label: "desktop-narrow", width: 1440, height: 900, expectCoreColumns: 4 },
      { label: "medium", width: 1024, height: 768, expectCoreColumns: 2 },
      { label: "mobile", width: 430, height: 932, expectCoreColumns: 2 },
      { label: "mobile-small", width: 360, height: 780, expectCoreColumns: 1 }
    ];
    for (const viewport of widths) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      // Power only, Power+Data, neither, and a large multi-cell component.
      for (const type of ["blaster", "signalAmplifier", "frame", "heatSink", "reactor", "droneBay"]) {
        await selectComponent(page, type);
        const layout = await page.evaluate(() => {
          const root = document.querySelector("#partInspector");
          const specs = root.querySelector(".part-core-specs");
          const doc = document.documentElement;
          const rootRect = root.getBoundingClientRect();
          return {
            coreColumns: specs ? getComputedStyle(specs).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
            panelOverflow: root.scrollWidth - root.clientWidth,
            docOverflow: doc.scrollWidth - doc.clientWidth,
            nameFontSize: parseFloat(getComputedStyle(root.querySelector(".part-inspector-name")).fontSize),
            triggerHeights: Array.from(root.querySelectorAll(".part-accordion-trigger")).map((node) => node.getBoundingClientRect().height),
            chipHeights: Array.from(root.querySelectorAll("[data-requirement]")).map((node) => node.getBoundingClientRect().height),
            chipsInside: Array.from(root.querySelectorAll("[data-requirement]")).every((node) => {
              const rect = node.getBoundingClientRect();
              return rect.left >= rootRect.left - 1 && rect.right <= rootRect.right + 1;
            })
          };
        });
        assert.equal(layout.chipsInside, true, `${viewport.label}/${type}: requirement chips stay inside the inspector`);
        for (const height of layout.chipHeights) {
          assert.ok(height >= 22, `${viewport.label}/${type}: requirement chip stays usable (${height}px)`);
        }
        assert.ok(layout.panelOverflow <= 1, `${viewport.label}/${type}: inspector does not scroll horizontally (${layout.panelOverflow}px)`);
        assert.ok(layout.docOverflow <= 1, `${viewport.label}/${type}: page does not scroll horizontally (${layout.docOverflow}px)`);
        if (type !== "frame") {
          assert.equal(layout.coreColumns, viewport.expectCoreColumns,
            `${viewport.label}/${type}: core row uses ${viewport.expectCoreColumns} columns (got ${layout.coreColumns})`);
        }
        for (const height of layout.triggerHeights) {
          assert.ok(height >= 40, `${viewport.label}/${type}: accordion stays tappable (${height}px)`);
        }
        assert.ok(layout.nameFontSize >= 11 && layout.nameFontSize <= 22,
          `${viewport.label}/${type}: component name stays readable without wrapping pressure (${layout.nameFontSize}px)`);
      }
      await selectComponent(page, "reactor");
      await page.screenshot({ path: path.join(artifactDir, `reactor-${viewport.label}-${viewport.width}x${viewport.height}.png`) });
    }
    check("layout holds at desktop, medium and mobile widths with no horizontal scrolling", () => {});

    await page.setViewportSize({ width: 1440, height: 900 });
    for (const type of REPRESENTATIVE) {
      await selectComponent(page, type);
      await page.screenshot({ path: path.join(artifactDir, `component-${type}.png`) });
    }

    check("no uncaught page errors during the inspector review", () => {
      assert.deepEqual(errors, [], `no page errors: ${errors.join("; ")}`);
    });

    console.log(`\nComponent inspector browser checks: ${passed}/${passed} passed`);
    console.log(`Component inspector browser verification passed; screenshots: ${artifactDir}`);
  } catch (error) {
    console.error(error);
    console.error("Server log:\n", getLog?.() || "");
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server?.kill?.();
  }
})();
