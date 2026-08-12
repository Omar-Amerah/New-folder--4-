import { dom } from "../dom.js";
import { state, DEFAULT_THERMAL_LOAD_MODE } from "../../state.js";
import { renderPartInspector } from "../partInspectorUi.js";
import { refreshRotationIndicator } from "./buildMode.js";
import {
  dataLinksHintText,
  isDataLinksBlueprintMode,
  refreshDataLinksControls
} from "./dataLinksMode.js";
import {
  closeHeatLegend,
  ensureHeatLegendDisclosureBinding,
  refreshHeatPresentationSafely,
  refreshHeatStateLegend
} from "./heatMode.js";

const THERMAL_SCENARIO_NAMES = { idle: "Idle", combat: "Typical Combat", full: "Maximum Sustained Load" };

const BLUEPRINT_MODE_CONTENT = {
  build: { title: "Build", description: "Add, rotate and remove ship components." },
  heat: { title: "Heat", description: "Build while viewing predicted component Heat and thermal flow." },
  dataLinks: { title: "Data Links", description: "Directly link Data-support sources to weapons. Component placement is paused." }
};

export function refreshBlueprintControls() {
  const heatView = state.blueprintView === "heat";
  const dataLinksView = isDataLinksBlueprintMode();
  const buildView = !heatView && !dataLinksView;
  dom.grid.classList.toggle("heat-overlay-active", heatView);
  dom.blueprintBuildTab?.classList.toggle("active", buildView);
  dom.blueprintHeatTab?.classList.toggle("active", heatView);
  dom.blueprintDataLinksTab?.classList.toggle("active", dataLinksView);
  const tabs = [[dom.blueprintBuildTab, buildView], [dom.blueprintHeatTab, heatView], [dom.blueprintDataLinksTab, dataLinksView]];
  for (const [tab, active] of tabs) {
    tab?.setAttribute("aria-selected", String(active));
    tab?.setAttribute("tabindex", active ? "0" : "-1");
    tab?.setAttribute("aria-controls", "blueprintModeContext");
  }
  if (dom.blueprintModeContext) {
    dom.blueprintModeContext.dataset.mode = state.blueprintView;
  }
  if (dom.blueprintModeTitle) dom.blueprintModeTitle.textContent = BLUEPRINT_MODE_CONTENT[state.blueprintView].title;
  if (dom.blueprintModeDescription) dom.blueprintModeDescription.textContent = BLUEPRINT_MODE_CONTENT[state.blueprintView].description;
  refreshDataLinksControls();
  if (dom.heatToolbar) dom.heatToolbar.hidden = !heatView;
  if (!heatView) closeHeatLegend();
  ensureHeatLegendDisclosureBinding();
  refreshHeatStateLegend();
  if (dom.thermalLoadModes) {
    dom.thermalLoadModes.hidden = !heatView;
    for (const button of dom.thermalLoadModes.querySelectorAll("[data-thermal-load]")) {
      const active = button.dataset.thermalLoad === (state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE);
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }
  if (dom.thermalScenarioLabel) {
    dom.thermalScenarioLabel.hidden = !heatView;
    dom.thermalScenarioLabel.textContent = `Predicted component heat : ${THERMAL_SCENARIO_NAMES[state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE]}`;
  }
  if (dom.buildInteractionGuide) {
    dom.buildInteractionGuide.hidden = false;
    // Data Links pauses placement, so the guide carries its linking hint here
    // instead of a separate sentence under the grid.
    dom.buildInteractionGuide.textContent = dataLinksView
      ? dataLinksHintText()
      : heatView
        ? "Place: left-click · Rotate: R or click again · Remove: right-click · Hover to inspect Heat"
        : "Place: left-click · Rotate: R or click again · Remove: right-click";
  }
  if (dom.emptyGridInstruction) {
    dom.emptyGridInstruction.hidden = !((buildView || heatView) && state.design.length === 0);
    const main = dom.emptyGridInstruction.querySelector?.("strong");
    const secondary = dom.emptyGridInstruction.querySelector?.("span");
    if (main) main.textContent = heatView
      ? "Choose a component, then left-click a grid cell to place it while viewing predicted Heat."
      : "Choose a component, then left-click a grid cell to place it.";
    if (secondary) secondary.textContent = heatView
      ? "Click the same component again or press R to rotate · F to mirror shaped structure · Right-click to remove · Hover components to inspect Heat"
      : "Click the same component again or press R to rotate · F to mirror shaped structure · Right-click to remove";
  }
  if (dom.rotationIndicator) refreshRotationIndicator();
}

export function ensureBlueprintToolbarEventHandlers({ setBlueprintView, renderLocalStats }) {
  if (dom.grid.dataset.hasHeatTabs) return;

  dom.blueprintBuildTab?.addEventListener("click", () => {
    setBlueprintView("build");
    renderLocalStats();
  });
  dom.blueprintHeatTab?.addEventListener("click", () => {
    setBlueprintView("heat");
    renderLocalStats();
    renderPartInspector();
  });
  dom.blueprintDataLinksTab?.addEventListener("click", () => {
    setBlueprintView("dataLinks");
    renderLocalStats();
    renderPartInspector();
  });
  const modeEntries = [
    [dom.blueprintBuildTab, "build"],
    [dom.blueprintHeatTab, "heat"],
    [dom.blueprintDataLinksTab, "dataLinks"]
  ].filter(([tab]) => Boolean(tab));
  const modeTabs = modeEntries.map(([tab]) => tab);
  const activateTab = (index) => { const mode = modeEntries[index][1]; setBlueprintView(mode); renderLocalStats(); if (mode === "heat") renderPartInspector(); modeTabs[index]?.focus(); };
  for (const tab of modeTabs) tab.addEventListener("keydown", (event) => {
    const index = modeTabs.indexOf(tab);
    if (event.key === "ArrowRight") { event.preventDefault(); activateTab((index + 1) % modeTabs.length); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); activateTab((index + modeTabs.length - 1) % modeTabs.length); }
    else if (event.key === "Home") { event.preventDefault(); activateTab(0); }
    else if (event.key === "End") { event.preventDefault(); activateTab(modeTabs.length - 1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activateTab(index); }
  });
  ensureHeatLegendDisclosureBinding();
  dom.thermalLoadModes?.addEventListener("click", event => {
    const button = event.target.closest("[data-thermal-load]");
    if (!button) return;
    state.thermalLoadMode = button.dataset.thermalLoad;
    refreshBlueprintControls();
    refreshHeatPresentationSafely();
    renderLocalStats();
    renderPartInspector();
  });
  dom.grid.dataset.hasHeatTabs = "true";
}
