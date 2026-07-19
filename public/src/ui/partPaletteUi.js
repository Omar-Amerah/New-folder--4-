// Renders the parts selection palette, tabs, and categories.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS, isPalettePart, partCategory, partIconMarkup } from "../design/parts.js";
import { renderPartInspector } from "./partInspectorUi.js";
import { PART_CATEGORIES } from "../constants.js";
import { isPaletteBlueprintEditMode } from "./designerUi.js";

let selectionPresentationRefresh = () => {};

export function setPartPaletteSelectionPresentationRefresh(handler) {
  selectionPresentationRefresh = typeof handler === "function" ? handler : () => {};
}

export function renderPalette() {
  const locked = !isPaletteBlueprintEditMode();
  dom.palette.textContent = "";
  dom.palette.classList.toggle("palette-locked", locked);
  dom.palette.setAttribute("aria-disabled", String(locked));
  const tabs = document.createElement("div");
  tabs.className = "part-category-tabs";
  for (const category of PART_CATEGORIES) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = category === state.selectedPartCategory ? "active" : "";
    tab.textContent = category;
    tab.disabled = locked;
    tab.setAttribute("aria-disabled", String(locked));
    tab.addEventListener("click", () => {
      if (!isPaletteBlueprintEditMode()) return;
      state.selectedPartCategory = category;
      const first = Object.keys(PART_DEFS).find((type) => isPalettePart(type) && partCategory(type) === category);
      if (first) {
        state.selectedPart = first;
        state.previewRotation = PART_STATS[first]?.allowedRotations?.[0] ?? 0;
      }
      renderPalette();
      renderPartInspector();
      selectionPresentationRefresh();
    });
    tabs.appendChild(tab);
  }
  dom.palette.appendChild(tabs);

  if (locked) {
    const notice = document.createElement("div");
    notice.id = "blueprintPaletteLockedNotice";
    notice.className = "palette-locked-notice";
    notice.setAttribute("role", "status");
    const title = document.createElement("strong");
    title.textContent = "Component placement paused in Wiring mode";
    const description = document.createElement("span");
    description.textContent = "Switch to Build or Heat to add or change components.";
    notice.appendChild(title);
    notice.appendChild(description);
    dom.palette.appendChild(notice);
  }

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
    button.disabled = locked;
    button.setAttribute("aria-disabled", String(locked));
    if (locked) button.setAttribute("aria-describedby", "blueprintPaletteLockedNotice");
    button.addEventListener("click", () => {
      if (!isPaletteBlueprintEditMode()) return;
      const wasSelected = state.selectedPart === type;
      state.selectedPart = wasSelected ? null : type;
      state.selectedPartCategory = partCategory(type);
      state.previewRotation = wasSelected ? 0 : (PART_STATS[type]?.allowedRotations?.[0] ?? 0);
      renderPalette();
      renderPartInspector();
      selectionPresentationRefresh();
    });
    list.appendChild(button);
  }
  dom.palette.appendChild(list);
}


if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("blueprint-mode-change", () => renderPalette());
}
