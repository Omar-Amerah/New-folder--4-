// Renders the parts selection palette, tabs, and categories.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS, isPalettePart, partCategory, partIconMarkup } from "../design/parts.js";
import { renderPartInspector } from "./partInspectorUi.js";
import { PART_CATEGORIES } from "../constants.js";

export function renderPalette() {
  dom.palette.textContent = "";
  const tabs = document.createElement("div");
  tabs.className = "part-category-tabs";
  for (const category of PART_CATEGORIES) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = category === state.selectedPartCategory ? "active" : "";
    tab.textContent = category;
    tab.addEventListener("click", () => {
      state.selectedPartCategory = category;
      const first = Object.keys(PART_DEFS).find((type) => isPalettePart(type) && partCategory(type) === category);
      if (first) {
        state.selectedPart = first;
        state.previewRotation = 0;
      }
      renderPalette();
      renderPartInspector();
    });
    tabs.appendChild(tab);
  }
  dom.palette.appendChild(tabs);

  const list = document.createElement("div");
  list.className = "part-category-list";
  for (const type of Object.keys(PART_DEFS)) {
    if (!isPalettePart(type)) continue;
    if (partCategory(type) !== state.selectedPartCategory) continue;
    const stat = PART_STATS[type];
    const button = document.createElement("button");
    button.type = "button";
    button.className = `part-button${state.selectedPart === type ? " active" : ""}`;
    button.title = `${PART_DEFS[type].name} | ${partCategory(type)} | cost ${stat.cost} | mass ${stat.mass}`;
    button.innerHTML = `${partIconMarkup(type)}<span class="part-name">${PART_DEFS[type].name}</span>`;
    button.addEventListener("click", () => {
      const wasSelected = state.selectedPart === type;
      state.selectedPart = wasSelected ? null : type;
      state.selectedPartCategory = partCategory(type);
      state.previewRotation = 0;
      renderPalette();
      renderPartInspector();
      for (const stale of dom.grid.querySelectorAll(".build-preview, .engine-exhaust-preview, .engine-thrust-arrow")) stale.remove();
    });
    list.appendChild(button);
  }
  dom.palette.appendChild(list);
}
