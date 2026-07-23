// Accessible navigation for the Blueprint Designer's right-side inspector.

import { dom } from "./dom.js";
import { state } from "../state.js";
const INSPECTOR_TABS = [
  ["design", "designerDesignTab", "designerDesignPanel"],
  ["analysis", "designerAnalysisTab", "designerAnalysisPanel"],
  ["blueprints", "designerBlueprintsTab", "designerBlueprintsPanel"]
];
const ANALYSIS_TABS = [
  ["heat", "analysisHeatTab", "analysisHeatPanel"],
  ["power", "analysisPowerTab", "analysisPowerPanel"],
  ["wiring", "analysisWiringTab", "analysisWiringPanel"],
  ["movement", "analysisMovementTab", "analysisMovementPanel"]
];

function applyTabState(entries, activeKey) {
  for (const [key, tabKey, panelKey] of entries) {
    const active = key === activeKey;
    const tab = dom[tabKey];
    const panel = dom[panelKey];
    tab?.setAttribute("aria-selected", String(active));
    tab?.setAttribute("tabindex", active ? "0" : "-1");
    if (panel) panel.hidden = !active;
  }
}

function analysisForBlueprintView(view = state.blueprintView) {
  if (view === "heat") return "heat";
  if (view === "wiring") return "wiring";
  return "movement";
}

export function syncDesignerAnalysisToBlueprintView() {
  activateDesignerAnalysisTab(analysisForBlueprintView());
}

export function activateDesignerAnalysisTab(key, { focus = false } = {}) {
  const entry = ANALYSIS_TABS.find(([candidate]) => candidate === key) || ANALYSIS_TABS[0];
  state.designerAnalysisTab = entry[0];
  applyTabState(ANALYSIS_TABS, entry[0]);
  if (focus) dom[entry[1]]?.focus();
}

export function activateDesignerInspectorTab(key, { focus = false } = {}) {
  const entry = INSPECTOR_TABS.find(([candidate]) => candidate === key) || INSPECTOR_TABS[0];
  state.designerInspectorTab = entry[0];
  applyTabState(INSPECTOR_TABS, entry[0]);
  if (entry[0] === "analysis") syncDesignerAnalysisToBlueprintView();
  if (focus) dom[entry[1]]?.focus();
}

function bindTablist(entries, activate) {
  const tabs = entries.map(([, tabKey]) => dom[tabKey]).filter(Boolean);
  for (const tab of tabs) {
    if (tab.dataset.inspectorTabBound === "true") continue;
    const entry = entries.find(([, tabKey]) => dom[tabKey] === tab);
    tab.addEventListener("click", () => activate(entry[0]));
    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      let next = null;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else if (event.key === "Enter" || event.key === " ") next = index;
      if (next === null) return;
      event.preventDefault();
      activate(entries[next][0], { focus: true });
    });
    tab.dataset.inspectorTabBound = "true";
  }
}

export function initializeDesignerInspector() {
  bindTablist(INSPECTOR_TABS, activateDesignerInspectorTab);
  bindTablist(ANALYSIS_TABS, activateDesignerAnalysisTab);
  syncDesignerAnalysisToBlueprintView();
  activateDesignerInspectorTab(state.designerInspectorTab || "design");
}

document.addEventListener?.("designer-inspector-activate", (event) => {
  activateDesignerInspectorTab(event.detail?.tab || "design");
});

document.addEventListener?.("blueprint-mode-change", syncDesignerAnalysisToBlueprintView);
