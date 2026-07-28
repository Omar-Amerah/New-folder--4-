// Renders compact in-match side controls: ship groups, rally point, and selected combat style.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { notify } from "./toastUi.js";
import { send, recordNetworkEvent } from "../network.js";
import { ownLiveShips, pruneSelection } from "../game/selection.js";
import {
  renderShipDamagePanel,
  updateSelectedShipDamageUi as repaintSelectedShipDamage,
  updateSelectedShipHeatUi as repaintSelectedShipHeat,
  updateSelectedShipPowerUi as repaintSelectedShipPower
} from "./shipDamagePanelUi.js";
import { STYLE_DESCRIPTIONS, selectedShipSummary, commonStyle } from "./section13bUi.js";
import { invalidatePresentation } from "../presentationInvalidation.js";
import { synchronizeTelemetryFocus } from "../telemetryFocus.js";

const SHIP_GROUP_DEFS = [
  { id: "group1", label: "Group 1" },
  { id: "group2", label: "Group 2" },
  { id: "group3", label: "Group 3" },
  { id: "group4", label: "Group 4" },
  { id: "group5", label: "Group 5" },
  { id: "unassigned", label: "Unassigned" }
];

const ASSIGNABLE_GROUP_IDS = ["group1", "group2", "group3", "group4", "group5"];

const SELECTED_COMBAT_STYLES = [
  { id: "charge", label: "Charge", description: STYLE_DESCRIPTIONS.charge },
  { id: "hold", label: "Hold", description: STYLE_DESCRIPTIONS.hold },
  { id: "orbit", label: "Orbit", description: STYLE_DESCRIPTIONS.orbit },
  { id: "kite", label: "Kite", description: STYLE_DESCRIPTIONS.kite }
];

const GROUP_COMBAT_STYLES = [
  { id: "ship", label: "Use Ship Stance" },
  ...SELECTED_COMBAT_STYLES
];

let combatStyleRequestCounter = 0;
function makeCombatStyleRequestId() {
  const base = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${++combatStyleRequestCounter}`;
  return `cs-${base}`.slice(0, 64);
}

export function renderSideControls() {
  renderShipGroups();
  renderRallyControls();
  renderSelectionControls();
  renderShipDamagePanel();
}

function bumpSelectedDiagnostic(name) {
  const diagnostics = state.presentationDiagnostics;
  if (diagnostics) diagnostics[name] = (diagnostics[name] || 0) + 1;
}
export function updateSelectedShipVitals() {
  bumpSelectedDiagnostic("selectedVitalsUpdateCount");
  renderSelectedSummary(selectedLiveShips());
}
export function updateSelectedShipDamageUi() { repaintSelectedShipDamage(); }
export function updateSelectedShipHeatUi() { repaintSelectedShipHeat(); }
export function updateSelectedShipPowerUi() { repaintSelectedShipPower(); }
export function updateShipGroupUi() { bumpSelectedDiagnostic("shipGroupUpdateCount"); renderShipGroups(); }
export function updateRallyUi() { bumpSelectedDiagnostic("rallyUpdateCount"); renderRallyControls(); }
export function updateSelectionCommandUi() { bumpSelectedDiagnostic("selectionCommandUpdateCount"); renderSelectionControls(); }

export function handleShipGroupListClick(event) {
  const unassignButton = event.target?.closest?.("[data-unassign-ship-group]");
  if (unassignButton) {
    event.preventDefault();
    unassignSelectedShipsFromGroup(unassignButton.dataset.unassignShipGroup);
    return;
  }

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
  const stanceSelect = event.target?.closest?.("[data-ship-group-stance]");
  if (stanceSelect) {
    setGroupCombatStyle(stanceSelect.dataset.shipGroupStance, stanceSelect.value);
  }
}

export function beginRallyPointPlacement() {
  if (state.phase !== "active") {
    notify.warning("Rally point is available during the match.");
    return;
  }
  state.settingRallyPoint = !state.settingRallyPoint;
  invalidatePresentation("rally-mode");
}

export function resetRallyPointToSpawn() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || state.phase !== "active") return;
  state.settingRallyPoint = false;
  send({ type: "resetRallyPoint" });
  invalidatePresentation("rally-mode");
}

export function setRallyPointFromWorld(world) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || state.phase !== "active") return;
  state.settingRallyPoint = false;
  send({ type: "setRallyPoint", x: world.x, y: world.y });
  invalidatePresentation("rally-mode");
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

function renderShipGroups() {
  if (!dom.shipGroupList) return;
  const ships = ownLiveShips();
  const liveIds = new Set(ships.map((ship) => ship.id));
  cleanupShipGroups(liveIds);
  const selectedLiveIds = new Set((state.snapshotIndex?.selectedLivingShips || []).map((ship) => ship.id));
  const selectedCount = selectedLiveIds.size;
  ensureShipGroupSettings();
  ensureShipGroupRows();

  if (dom.shipGroupTotal) {
    const assignedIds = new Set();
    for (const groupId of ASSIGNABLE_GROUP_IDS) {
      for (const shipId of state.shipGroups[groupId]) if (liveIds.has(shipId)) assignedIds.add(shipId);
    }
    const configuredCap = Number(state.mine?.shipCap ?? state.rules?.shipCap);
    dom.shipGroupTotal.textContent = Number.isFinite(configuredCap) && configuredCap > 0
      ? `${assignedIds.size} / ${configuredCap} assigned`
      : `${assignedIds.size} ship${assignedIds.size === 1 ? "" : "s"} assigned`;
  }
  for (const group of SHIP_GROUP_DEFS) {
    const shipIds = shipIdsForGroup(group.id, liveIds);
    const groupButton = dom.shipGroupList.querySelector?.(`[data-ship-group="${group.id}"]`) || null;
    const actionButton = dom.shipGroupList.querySelector?.(`[data-ship-group-action="${group.id}"]`) || null;
    const stanceSelect = dom.shipGroupList.querySelector?.(`[data-ship-group-stance="${group.id}"]`) || null;
    const countEl = groupButton?.querySelector?.(".ship-group-count");
    const row = groupButton?.closest?.(".ship-group-row") || null;
    const selected = state.activeShipGroup === group.id;
    if (groupButton) {
      groupButton.classList.toggle("active", selected);
      groupButton.setAttribute("aria-pressed", String(selected));
    }
    if (row) {
      row.classList.toggle("is-selected", selected);
      row.classList.toggle("is-empty", shipIds.length === 0);
      row.classList.toggle("has-ships", shipIds.length > 0);
    }
    if (countEl) countEl.textContent = `${shipIds.length} ship${shipIds.length === 1 ? "" : "s"}`;
    if (actionButton) {
      if (group.id === "unassigned") {
        actionButton.disabled = false;
      } else {
        const selectedInGroup = [...selectedLiveIds].filter((id) => state.shipGroups[group.id].has(id));
        const allSelectedInGroup = selectedInGroup.length > 0 && selectedInGroup.length === selectedCount;
        if (allSelectedInGroup) {
          actionButton.className = "ship-group-action ship-group-unassign";
          actionButton.textContent = "− Remove";
          actionButton.title = `Remove selected ships from ${group.label}`;
          actionButton.setAttribute("aria-label", `Remove selected ships from ${group.label}`);
          delete actionButton.dataset.assignShipGroup;
          actionButton.dataset.unassignShipGroup = group.id;
          actionButton.disabled = false;
        } else {
          actionButton.className = "ship-group-action ship-group-assign";
          actionButton.textContent = "+ Add";
          actionButton.title = `Add selected ships to ${group.label}`;
          actionButton.setAttribute("aria-label", `Add selected ships to ${group.label}`);
          actionButton.dataset.assignShipGroup = group.id;
          delete actionButton.dataset.unassignShipGroup;
          actionButton.disabled = selectedCount === 0;
        }
      }
    }
    if (stanceSelect) stanceSelect.value = normalizeGroupCombatStyle(state.shipGroupSettings[group.id]?.combatStyle);
  }
}

function ensureShipGroupRows() {
  if (!dom.shipGroupList) return;
  if (!dom.shipGroupList.dataset || typeof document === "undefined" || typeof document.createElement !== "function") return;
  if (dom.shipGroupList.dataset.ready === "true") return;
  dom.shipGroupList.textContent = "";
  for (const group of SHIP_GROUP_DEFS) {
    const row = document.createElement("div");
    row.className = `ship-group-row${group.id === "unassigned" ? " is-unassigned" : ""}`;

    const main = document.createElement("div");
    main.className = "ship-group-main";

    const groupButton = document.createElement("button");
    groupButton.type = "button";
    groupButton.className = "ship-group-button";
    groupButton.dataset.shipGroup = group.id;
    groupButton.title = `Select ${group.label}`;
    groupButton.setAttribute("aria-label", `Select ${group.label}`);
    groupButton.setAttribute("aria-pressed", "false");

    const name = document.createElement("span");
    name.className = "ship-group-name";
    name.textContent = group.label;
    groupButton.appendChild(name);

    const count = document.createElement("span");
    count.className = "ship-group-count";
    count.textContent = "0";
    groupButton.appendChild(count);

    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.dataset.shipGroupAction = group.id;
    if (group.id === "unassigned") {
      actionButton.className = "ship-group-action ship-group-view";
      actionButton.dataset.shipGroup = group.id;
      actionButton.title = "View unassigned ships";
      actionButton.setAttribute("aria-label", "View unassigned ships");
      actionButton.textContent = "View";
    } else {
      actionButton.className = "ship-group-action ship-group-assign";
      actionButton.dataset.assignShipGroup = group.id;
      actionButton.title = `Add selected ships to ${group.label}`;
      actionButton.setAttribute("aria-label", `Add selected ships to ${group.label}`);
      actionButton.textContent = "+ Add";
    }

    main.appendChild(groupButton);
    main.appendChild(actionButton);
    row.appendChild(main);

    if (ASSIGNABLE_GROUP_IDS.includes(group.id)) {
      const controls = document.createElement("div");
      controls.className = "ship-group-controls";
      controls.dataset.shipGroupControls = group.id;

      const stanceLabel = document.createElement("span");
      stanceLabel.className = "ship-group-stance-label";
      stanceLabel.textContent = "Stance";

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

      controls.appendChild(stanceLabel);
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
  invalidatePresentation("active-group");
}

function unassignSelectedShipsFromGroup(groupId) {
  if (!ASSIGNABLE_GROUP_IDS.includes(groupId)) return;
  pruneSelection();
  const liveIds = new Set(ownLiveShips().map((ship) => ship.id));
  const selected = [...state.selectedShipIds].filter((id) => liveIds.has(id));
  if (selected.length === 0) return;
  ensureShipGroups();
  const toRemove = selected.filter((id) => state.shipGroups[groupId].has(id));
  if (toRemove.length === 0) return;
  for (const id of toRemove) state.shipGroups[groupId].delete(id);
  restoreShipCombatStyles(toRemove);
  cleanupShipGroups(liveIds);
  invalidatePresentation("active-group");
}

function restoreShipCombatStyles(shipIds) {
  ensureBaseCombatStyles();
  const byStyle = new Map();
  for (const id of shipIds) {
    const style = normalizeCombatStyle(state.shipGroupBaseCombatStyles.get(id) || state.combatStyle || "hold");
    if (!byStyle.has(style)) byStyle.set(style, []);
    byStyle.get(style).push(id);
  }
  if (state.socket && state.socket.readyState === WebSocket.OPEN && state.phase === "active") {
    for (const [combatStyle, ids] of byStyle.entries()) {
      if (ids.length > 0) {
        const requestId = makeCombatStyleRequestId();
        send({ type: "setCombatStyle", requestId, combatStyle, shipIds: ids });
      }
    }
  }
}

function selectShipGroup(groupId) {
  const liveIds = new Set(ownLiveShips().map((ship) => ship.id));
  const ids = shipIdsForGroup(groupId, liveIds);
  state.selectedShipIds = new Set(ids);
  state.activeShipGroup = groupId;
  if (ids.length > 0) state.camera.follow = true;
  synchronizeTelemetryFocus();
  invalidatePresentation("selection");
}

const COMBAT_STYLE_REQUEST_TIMEOUT_MS = 5000;
const MAX_COMBAT_STYLE_EXPLICIT_IDS = 360;

function setSelectedCombatStyle(style) {
  if (!SELECTED_COMBAT_STYLES.some((item) => item.id === style)) return;
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || state.phase !== "active") {
    notify.warning("Style commands are only available during an active match.");
    return;
  }
  pruneSelection();
  const ownShips = ownLiveShips();
  const ownIds = new Set(ownShips.map((ship) => ship.id));
  const shipIds = ownShips.filter((ship) => state.selectedShipIds.has(ship.id)).map((ship) => ship.id);
  if (shipIds.length === 0) {
    notify.warning("Select ships before changing combat style.");
    renderSelectionControls();
    return;
  }
  const requestId = makeCombatStyleRequestId();
  const useScopeAll = shipIds.length === ownShips.length || shipIds.length > MAX_COMBAT_STYLE_EXPLICIT_IDS;
  const payload = { type: "setCombatStyle", requestId, combatStyle: style };
  if (useScopeAll) {
    payload.scope = "all-owned";
  } else {
    payload.shipIds = shipIds;
  }
  const previousStyles = new Map();
  for (const ship of ownShips) {
    if (useScopeAll || shipIds.includes(ship.id)) previousStyles.set(ship.id, normalizeCombatStyle(ship.combatStyle));
  }
  const sent = send(payload);
  if (!sent) {
    notify.warning("Unable to send style command — connection is offline.", { key: `style-send:${requestId}` });
    recordNetworkEvent("notice", { message: "Style command failed to send (offline)", requestId, style });
    return;
  }
  state.pendingCombatStyle = {
    requestId,
    style,
    shipIds: useScopeAll ? null : shipIds,
    scope: useScopeAll ? "all-owned" : null,
    previousStyles,
    connectionGeneration: state.connectionGeneration,
    room: state.room || "",
    at: performance.now(),
    acknowledged: false,
    warned: false
  };
  renderSelectionControls();
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
  if (state.socket && state.socket.readyState === WebSocket.OPEN && state.phase === "active") {
    const requestId = makeCombatStyleRequestId();
    send({ type: "setCombatStyle", requestId, combatStyle: style, shipIds });
  }
}

function restoreGroupCombatStyles(groupId) {
  ensureShipGroups();
  ensureBaseCombatStyles();
  const liveIds = new Set(ownLiveShips().map((ship) => ship.id));
  const shipIds = shipIdsForGroup(groupId, liveIds);
  const byStyle = new Map();
  for (const id of shipIds) {
    const style = normalizeCombatStyle(state.shipGroupBaseCombatStyles.get(id) || state.combatStyle || "hold");
    if (!byStyle.has(style)) byStyle.set(style, []);
    byStyle.get(style).push(id);
  }
  if (state.socket && state.socket.readyState === WebSocket.OPEN && state.phase === "active") {
    for (const [combatStyle, ids] of byStyle.entries()) {
      if (ids.length > 0) {
        const requestId = makeCombatStyleRequestId();
        send({ type: "setCombatStyle", requestId, combatStyle, shipIds: ids });
      }
    }
  }
}

function rememberBaseCombatStyles(shipIds) {
  ensureBaseCombatStyles();
  const byId = state.snapshotIndex?.shipById || new Map();
  for (const id of shipIds) {
    if (!state.shipGroupBaseCombatStyles.has(id)) {
      state.shipGroupBaseCombatStyles.set(id, normalizeCombatStyle(byId.get(id)?.combatStyle || state.combatStyle || "hold"));
    }
  }
}

function selectedLiveShips() {
  return state.snapshotIndex?.selectedLivingShips || [];
}

function commonCombatStyle(ships) { return commonStyle(ships); }

function reconcilePendingCombatStyle() {
  const pending = state.pendingCombatStyle;
  if (!pending) return;
  const now = performance.now();
  const stale = pending.connectionGeneration !== state.connectionGeneration ||
    (pending.room && pending.room !== (state.room || "")) ||
    now - pending.at > COMBAT_STYLE_REQUEST_TIMEOUT_MS;
  if (stale) {
    if (!pending.warned) {
      pending.warned = true;
      notify.warning(pending.acknowledged ? "Style change acknowledged, but snapshot confirmation timed out." : "Style change request timed out without confirmation.", { key: `style-timeout:${pending.requestId}` });
      recordNetworkEvent("notice", { message: "Combat style request timed out", requestId: pending.requestId, style: pending.style });
    }
    state.pendingCombatStyle = null;
    return;
  }
  const targetIds = pending.shipIds || state.snapshotIndex?.ownLivingShipIds || [];
  const allConfirmed = targetIds.length > 0 && targetIds.every((id) => {
    const ship = state.snapshotIndex?.shipById?.get(id);
    return ship && normalizeCombatStyle(ship.combatStyle) === pending.style;
  });
  if (pending.acknowledged && allConfirmed) {
    state.pendingCombatStyle = null;
    return;
  }
}

function renderSelectedSummary(selectedShips) {
  if (!dom.selectionPanelCount) return;
  reconcilePendingCombatStyle();
  const summary = selectedShipSummary(selectedShips);
  dom.selectionPanelCount.textContent = `${selectedShips.length} ship${selectedShips.length === 1 ? "" : "s"}${summary.style ? ` · ${combatStyleLabel(summary.style)}` : ""}`;
  if (dom.selectionPanelCount.title !== summary.text) dom.selectionPanelCount.title = summary.text;
  if (dom.selectionPanelCount.getAttribute?.("aria-label") !== summary.text) {
    dom.selectionPanelCount.setAttribute?.("aria-label", summary.text);
  }
}

export function onCombatStyleResult(message) {
  const pending = state.pendingCombatStyle;
  if (!pending || pending.requestId !== message.requestId) return;
  if (message.ok) {
    pending.acknowledged = true;
    recordNetworkEvent("notice", { message: "Combat style acknowledged", requestId: message.requestId, style: message.combatStyle, updatedCount: message.updatedCount });
    renderSelectionControls();
  } else {
    state.pendingCombatStyle = null;
    notify.error(message.message || "Style change failed.", { key: `style-failed:${message.requestId || "unknown"}` });
    recordNetworkEvent("error", { code: message.code || "style-failed", message: message.message || "Style change failed", requestId: message.requestId });
    renderSelectionControls();
  }
}

function combatStyleLabel(style) {
  const value = String(style || "");
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function normalizeCombatStyle(style) {
  if (SELECTED_COMBAT_STYLES.some((item) => item.id === style)) return style;
  if (style === "circle" || style === "evasive") return "orbit";
  if (style === "direct" || style === "interceptor" || style === "brawler") return "charge";
  return "hold";
}

function normalizeGroupCombatStyle(style) {
  return GROUP_COMBAT_STYLES.some((item) => item.id === style) ? style : "ship";
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
      combatStyle: normalizeGroupCombatStyle(current.combatStyle)
    };
  }
}
