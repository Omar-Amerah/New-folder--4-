// Renders compact in-match side controls: ship groups, rally point, and selected combat style.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { send } from "../network.js";
import { showToast } from "./toastUi.js";
import { updateHud } from "./hudUi.js";
import { ownLiveShips, pruneSelection } from "../game/selection.js";
import { renderShipDamagePanel } from "./shipDamagePanelUi.js";
import { STYLE_DESCRIPTIONS, selectedShipSummary, commonStyle } from "./section13bUi.js";

const SHIP_GROUP_DEFS = [
  { id: "group1", label: "Group 1" },
  { id: "group2", label: "Group 2" },
  { id: "group3", label: "Group 3" },
  { id: "group4", label: "Group 4" },
  { id: "group5", label: "Group 5" },
  { id: "unassigned", label: "Unassigned" }
];

const ASSIGNABLE_GROUP_IDS = ["group1", "group2", "group3", "group4", "group5"];
const FORMATION_OPTIONS = [
  { id: "line", label: "Line" },
  { id: "wedge", label: "Wedge" },
  { id: "clump", label: "Clump" }
];

const SELECTED_COMBAT_STYLES = [
  { id: "charge", label: "Charge", description: STYLE_DESCRIPTIONS.charge },
  { id: "hold", label: "Hold", description: STYLE_DESCRIPTIONS.hold },
  { id: "sentry", label: "Sentry", description: STYLE_DESCRIPTIONS.sentry },
  { id: "circle", label: "Circle", description: STYLE_DESCRIPTIONS.circle }
];

const GROUP_COMBAT_STYLES = [
  { id: "ship", label: "Use ship stance" },
  ...SELECTED_COMBAT_STYLES
];

export function renderSideControls() {
  renderShipGroups();
  renderRallyControls();
  renderSelectionControls();
}

export function handleShipGroupListClick(event) {
  const assignButton = event.target?.closest?.("[data-assign-ship-group]");
  if (assignButton) {
    event.preventDefault();
    assignSelectedShipsToGroup(assignButton.dataset.assignShipGroup);
    return;
  }

  const groupButton = event.target?.closest?.("[data-ship-group]");
  if (!groupButton) return;
  event.preventDefault();
  selectShipGroup(groupButton.dataset.shipGroup);
}

export function handleShipGroupListChange(event) {
  const formationSelect = event.target?.closest?.("[data-ship-group-formation]");
  if (formationSelect) {
    setGroupFormation(formationSelect.dataset.shipGroupFormation, formationSelect.value);
    return;
  }

  const stanceSelect = event.target?.closest?.("[data-ship-group-stance]");
  if (stanceSelect) {
    setGroupCombatStyle(stanceSelect.dataset.shipGroupStance, stanceSelect.value);
  }
}

export function beginRallyPointPlacement() {
  if (state.phase !== "active") {
    showToast("Rally point is available during the match.", "warning");
    return;
  }
  state.settingRallyPoint = !state.settingRallyPoint;
  renderRallyControls();
}

export function resetRallyPointToSpawn() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || state.phase !== "active") return;
  state.settingRallyPoint = false;
  send({ type: "resetRallyPoint" });
  renderRallyControls();
}

export function setRallyPointFromWorld(world) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || state.phase !== "active") return;
  state.settingRallyPoint = false;
  send({ type: "setRallyPoint", x: world.x, y: world.y });
  renderRallyControls();
}

export function handleSelectedCombatStyleClick(event) {
  const button = event.target?.closest?.("[data-combat-style]");
  if (!button || !dom.combatStyleControls?.contains?.(button)) return;
  event.preventDefault();
  setSelectedCombatStyle(button.dataset.combatStyle);
}

export function getRallyPoint() {
  if (state.phase !== "active") return null;
  const rally = state.mine?.rallyPoint;
  if (!rally || !Number.isFinite(rally.x) || !Number.isFinite(rally.y)) return null;
  return rally;
}

export function formationForCommand() {
  ensureShipGroups();
  ensureShipGroupSettings();
  if (state.activeShipGroup && ASSIGNABLE_GROUP_IDS.includes(state.activeShipGroup)) {
    return normalizeFormation(state.shipGroupSettings[state.activeShipGroup]?.formation);
  }
  return normalizeFormation(dom.formationSelect?.value);
}

function renderShipGroups() {
  if (!dom.shipGroupList) return;
  const ships = ownLiveShips();
  const liveIds = new Set(ships.map((ship) => ship.id));
  cleanupShipGroups(liveIds);
  const selectedCount = state.selectedShipIds.size;
  ensureShipGroupSettings();
  ensureShipGroupRows();

  if (dom.shipGroupTotal) dom.shipGroupTotal.textContent = String(ships.length);
  for (const group of SHIP_GROUP_DEFS) {
    const shipIds = shipIdsForGroup(group.id, liveIds);
    const groupButton = dom.shipGroupList.querySelector?.(`[data-ship-group="${group.id}"]`) || null;
    const assignButton = dom.shipGroupList.querySelector?.(`[data-assign-ship-group="${group.id}"]`) || null;
    const formationSelect = dom.shipGroupList.querySelector?.(`[data-ship-group-formation="${group.id}"]`) || null;
    const stanceSelect = dom.shipGroupList.querySelector?.(`[data-ship-group-stance="${group.id}"]`) || null;
    const countEl = groupButton?.querySelector?.(".ship-group-count");
    if (groupButton) groupButton.classList.toggle("active", state.activeShipGroup === group.id);
    if (countEl) countEl.textContent = String(shipIds.length);
    const assignDisabled = group.id === "unassigned" || selectedCount === 0;
    if (assignButton) assignButton.disabled = assignDisabled;
    if (formationSelect) formationSelect.value = normalizeFormation(state.shipGroupSettings[group.id]?.formation);
    if (stanceSelect) stanceSelect.value = normalizeGroupCombatStyle(state.shipGroupSettings[group.id]?.combatStyle);
    // Formation/stance controls only make sense once a group has ships in it.
    const controls = dom.shipGroupList.querySelector?.(`[data-ship-group-controls="${group.id}"]`) || null;
    if (controls) controls.hidden = shipIds.length === 0;
  }
}

function ensureShipGroupRows() {
  if (!dom.shipGroupList) return;
  if (dom.shipGroupList.dataset.ready === "true") return;
  dom.shipGroupList.textContent = "";
  for (const group of SHIP_GROUP_DEFS) {
    const row = document.createElement("div");
    row.className = "ship-group-row";

    const groupButton = document.createElement("button");
    groupButton.type = "button";
    groupButton.className = "ship-group-button";
    groupButton.dataset.shipGroup = group.id;
    groupButton.title = `Select ${group.label}`;

    const name = document.createElement("span");
    name.className = "ship-group-name";
    name.textContent = group.label;
    groupButton.appendChild(name);

    const count = document.createElement("span");
    count.className = "ship-group-count";
    count.textContent = "0";
    groupButton.appendChild(count);

    const assignButton = document.createElement("button");
    assignButton.type = "button";
    assignButton.className = "ship-group-assign";
    assignButton.dataset.assignShipGroup = group.id;
    assignButton.title = `Assign selected ships to ${group.label}`;
    assignButton.textContent = "+";

    row.appendChild(groupButton);
    row.appendChild(assignButton);

    if (ASSIGNABLE_GROUP_IDS.includes(group.id)) {
      const controls = document.createElement("div");
      controls.className = "ship-group-controls";
      controls.dataset.shipGroupControls = group.id;

      const formationSelect = document.createElement("select");
      formationSelect.className = "ship-group-select";
      formationSelect.dataset.shipGroupFormation = group.id;
      formationSelect.title = `${group.label} formation`;
      formationSelect.setAttribute("aria-label", `${group.label} formation`);
      for (const option of FORMATION_OPTIONS) {
        const optionEl = document.createElement("option");
        optionEl.value = option.id;
        optionEl.textContent = option.label;
        formationSelect.appendChild(optionEl);
      }

      const stanceSelect = document.createElement("select");
      stanceSelect.className = "ship-group-select";
      stanceSelect.dataset.shipGroupStance = group.id;
      stanceSelect.title = `${group.label} combat stance`;
      stanceSelect.setAttribute("aria-label", `${group.label} combat stance`);
      for (const option of GROUP_COMBAT_STYLES) {
        const optionEl = document.createElement("option");
        optionEl.value = option.id;
        optionEl.textContent = option.label;
        stanceSelect.appendChild(optionEl);
      }

      controls.appendChild(formationSelect);
      controls.appendChild(stanceSelect);
      row.appendChild(controls);
    }
    dom.shipGroupList.appendChild(row);
  }
  dom.shipGroupList.dataset.ready = "true";
}

function renderRallyControls() {
  const active = state.phase === "active";
  if (!active) state.settingRallyPoint = false;
  const rally = getRallyPoint();
  if (dom.rallyPanel) dom.rallyPanel.hidden = !active;
  if (dom.rallyPointButton) {
    dom.rallyPointButton.disabled = !active;
    dom.rallyPointButton.classList.toggle("active", Boolean(state.settingRallyPoint));
    dom.rallyPointButton.textContent = state.settingRallyPoint ? "Click Map" : "Rally Point";
  }
  if (dom.resetRallyButton) dom.resetRallyButton.disabled = !active;
  if (dom.rallyStatus) {
    dom.rallyStatus.textContent = rally && state.mine?.rallyPointCustom
      ? `${Math.round(rally.x)}, ${Math.round(rally.y)}`
      : "Spawn";
  }
}

function renderSelectionControls() {
  if (!dom.selectionPanel) return;
  pruneSelection();
  const selectedShips = selectedLiveShips();
  const count = selectedShips.length;
  if (dom.selectionPanelCount) {
    dom.selectionPanelCount.textContent = `${count} ship${count === 1 ? "" : "s"}`;
  }
  const activeStyle = commonCombatStyle(selectedShips);
  const buttons = dom.combatStyleControls ? Array.from(dom.combatStyleControls.children || []) : [];
  for (const button of buttons) {
    const style = button.dataset?.combatStyle;
    button.disabled = state.phase !== "active" || count === 0;
    button.classList.toggle("active", Boolean(style && activeStyle === style));
    const def = SELECTED_COMBAT_STYLES.find((item) => item.id === style);
    if (def && button.textContent !== def.label) button.textContent = def.label;
    if (def) { button.title = def.description; button.setAttribute("aria-description", def.description); }
  }
  renderSelectedSummary(selectedShips);
  renderShipDamagePanel();
}

function assignSelectedShipsToGroup(groupId) {
  if (!ASSIGNABLE_GROUP_IDS.includes(groupId)) return;
  pruneSelection();
  const selected = [...state.selectedShipIds];
  if (selected.length === 0) return;
  ensureShipGroups();
  for (const key of ASSIGNABLE_GROUP_IDS) {
    for (const id of selected) state.shipGroups[key].delete(id);
  }
  for (const id of selected) state.shipGroups[groupId].add(id);
  rememberBaseCombatStyles(selected);
  state.activeShipGroup = groupId;
  applyGroupCombatStyle(groupId);
  renderSideControls();
}

function selectShipGroup(groupId) {
  const liveIds = new Set(ownLiveShips().map((ship) => ship.id));
  const ids = shipIdsForGroup(groupId, liveIds);
  state.selectedShipIds = new Set(ids);
  state.activeShipGroup = groupId;
  if (ids.length > 0) state.camera.follow = true;
  updateHud();
  renderSideControls();
}

function setSelectedCombatStyle(style) {
  if (!SELECTED_COMBAT_STYLES.some((item) => item.id === style)) return;
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || state.phase !== "active") return;
  pruneSelection();
  const shipIds = [...state.selectedShipIds];
  if (shipIds.length === 0) {
    showToast("Select ships before changing combat style.", "warning");
    renderSelectionControls();
    return;
  }
  state.pendingCombatStyle = { style, shipIds: [...shipIds], at: performance.now() };
  send({ type: "setCombatStyle", combatStyle: style, shipIds });
  renderSelectionControls();
}

function setGroupFormation(groupId, formation) {
  if (!ASSIGNABLE_GROUP_IDS.includes(groupId)) return;
  ensureShipGroupSettings();
  state.shipGroupSettings[groupId].formation = normalizeFormation(formation);
  renderShipGroups();
}

function setGroupCombatStyle(groupId, style) {
  if (!ASSIGNABLE_GROUP_IDS.includes(groupId)) return;
  ensureShipGroupSettings();
  state.shipGroupSettings[groupId].combatStyle = normalizeGroupCombatStyle(style);
  if (state.shipGroupSettings[groupId].combatStyle === "ship") {
    restoreGroupCombatStyles(groupId);
  } else {
    applyGroupCombatStyle(groupId);
  }
  renderShipGroups();
  renderSelectionControls();
}

function applyGroupCombatStyle(groupId) {
  ensureShipGroups();
  ensureShipGroupSettings();
  const style = normalizeGroupCombatStyle(state.shipGroupSettings[groupId]?.combatStyle);
  if (style === "ship") return;
  const liveIds = new Set(ownLiveShips().map((ship) => ship.id));
  const shipIds = shipIdsForGroup(groupId, liveIds);
  if (shipIds.length === 0) return;
  rememberBaseCombatStyles(shipIds);
  for (const ship of state.snapshot?.ships || []) {
    if (shipIds.includes(ship.id)) ship.combatStyle = style;
  }
  if (state.socket && state.socket.readyState === WebSocket.OPEN && state.phase === "active") {
    send({ type: "setCombatStyle", combatStyle: style, shipIds });
  }
}

function restoreGroupCombatStyles(groupId) {
  ensureShipGroups();
  ensureBaseCombatStyles();
  const liveIds = new Set(ownLiveShips().map((ship) => ship.id));
  const shipIds = shipIdsForGroup(groupId, liveIds);
  const byStyle = new Map();
  for (const id of shipIds) {
    const style = normalizeCombatStyle(state.shipGroupBaseCombatStyles.get(id) || state.combatStyle || "charge");
    if (!byStyle.has(style)) byStyle.set(style, []);
    byStyle.get(style).push(id);
  }
  for (const ship of state.snapshot?.ships || []) {
    const base = state.shipGroupBaseCombatStyles.get(ship.id);
    if (shipIds.includes(ship.id) && base) ship.combatStyle = base;
  }
  if (state.socket && state.socket.readyState === WebSocket.OPEN && state.phase === "active") {
    for (const [combatStyle, ids] of byStyle.entries()) {
      if (ids.length > 0) send({ type: "setCombatStyle", combatStyle, shipIds: ids });
    }
  }
}

function rememberBaseCombatStyles(shipIds) {
  ensureBaseCombatStyles();
  const byId = new Map((state.snapshot?.ships || []).map((ship) => [ship.id, ship]));
  for (const id of shipIds) {
    if (!state.shipGroupBaseCombatStyles.has(id)) {
      state.shipGroupBaseCombatStyles.set(id, normalizeCombatStyle(byId.get(id)?.combatStyle || state.combatStyle || "charge"));
    }
  }
}

function selectedLiveShips() {
  const selected = state.selectedShipIds;
  return ownLiveShips().filter((ship) => selected.has(ship.id));
}

function commonCombatStyle(ships) { return commonStyle(ships); }

function renderSelectedSummary(selectedShips) {
  if (!dom.selectionPanelCount) return;
  const pending = state.pendingCombatStyle;
  if (pending && (performance.now() - pending.at > 3000 || selectedShips.every((ship) => !pending.shipIds.includes(ship.id) || normalizeCombatStyle(ship.combatStyle) === pending.style))) {
    state.pendingCombatStyle = null;
  }
  const summary = selectedShipSummary(selectedShips);
  const pendingText = state.pendingCombatStyle ? ` · Pending ${state.pendingCombatStyle.style}` : "";
  dom.selectionPanelCount.textContent = `${selectedShips.length} ship${selectedShips.length === 1 ? "" : "s"}${summary.style ? ` · ${summary.style}` : ""}${pendingText}`;
  dom.selectionPanelCount.title = summary.text;
  dom.selectionPanelCount.setAttribute("aria-label", summary.text + pendingText);
}

function normalizeCombatStyle(style) {
  return SELECTED_COMBAT_STYLES.some((item) => item.id === style) ? style : "charge";
}

function normalizeGroupCombatStyle(style) {
  return GROUP_COMBAT_STYLES.some((item) => item.id === style) ? style : "ship";
}

function normalizeFormation(formation) {
  return FORMATION_OPTIONS.some((item) => item.id === formation) ? formation : "line";
}

function shipIdsForGroup(groupId, liveIds) {
  ensureShipGroups();
  if (groupId === "unassigned") {
    const assigned = new Set();
    for (const key of ASSIGNABLE_GROUP_IDS) {
      for (const id of state.shipGroups[key]) assigned.add(id);
    }
    return [...liveIds].filter((id) => !assigned.has(id));
  }
  if (!state.shipGroups[groupId]) return [];
  return [...state.shipGroups[groupId]].filter((id) => liveIds.has(id));
}

function cleanupShipGroups(liveIds) {
  ensureShipGroups();
  ensureBaseCombatStyles();
  const seen = new Set();
  for (const key of ASSIGNABLE_GROUP_IDS) {
    for (const id of [...state.shipGroups[key]]) {
      if (!liveIds.has(id) || seen.has(id)) {
        state.shipGroups[key].delete(id);
      } else {
        seen.add(id);
      }
    }
  }
  if (state.activeShipGroup && shipIdsForGroup(state.activeShipGroup, liveIds).length === 0) {
    state.activeShipGroup = null;
  }
  for (const id of [...state.shipGroupBaseCombatStyles.keys()]) {
    if (!liveIds.has(id)) state.shipGroupBaseCombatStyles.delete(id);
  }
}

function ensureShipGroups() {
  if (!state.shipGroups) state.shipGroups = {};
  for (const key of ASSIGNABLE_GROUP_IDS) {
    if (!(state.shipGroups[key] instanceof Set)) state.shipGroups[key] = new Set(state.shipGroups[key] || []);
  }
}

function ensureBaseCombatStyles() {
  if (!(state.shipGroupBaseCombatStyles instanceof Map)) {
    state.shipGroupBaseCombatStyles = new Map(Object.entries(state.shipGroupBaseCombatStyles || {}));
  }
}

function ensureShipGroupSettings() {
  if (!state.shipGroupSettings) state.shipGroupSettings = {};
  for (const key of ASSIGNABLE_GROUP_IDS) {
    const current = state.shipGroupSettings[key] || {};
    state.shipGroupSettings[key] = {
      formation: normalizeFormation(current.formation),
      combatStyle: normalizeGroupCombatStyle(current.combatStyle)
    };
  }
}
