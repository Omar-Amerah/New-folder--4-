// Bootstraps the browser client by wiring state, networking, UI, input, and rendering.

import { applyShipEconomy, applyWiringInfrastructure } from "./constants.js";
import { notify } from "./ui/toastUi.js";
import { dom } from "./ui/dom.js";
import { state } from "./state.js";
import { renderPalette, setPartPaletteSelectionPresentationRefresh } from "./ui/partPaletteUi.js";
import { renderPartInspector } from "./ui/partInspectorUi.js";
import { renderBuildGrid, renderLocalStats, requestResetDesign, requestClearDesign, undoBlueprintEdit, refreshBlueprintSelectionPresentation } from "./ui/designerUi.js";
import { renderSavedDesigns, initializeSavedBlueprintLibraryControls, handleSavedDesignPointerDown, handleSavedDesignPointerUp, handleSavedDesignKeyboardClick, confirmModalAction, closeConfirmModal, confirmDiscardAction, saveCurrentDesignAsCopy, refreshLoadedBlueprintPresentation } from "./ui/savedBlueprintsUi.js";
import { openBlueprintDesigner, openBlueprintDesignerFromLobby, closeBlueprintDesigner, requestCloseBlueprintDesigner } from "./ui/designerScreenUi.js";
import { initializeDesignerInspector } from "./ui/designerInspectorUi.js";
import { bindPowerPriorityControls } from "./ui/wiringUi.js";
import { renderPurchaseBar, setPurchaseQuantity, handlePurchasePointerDown, handlePurchasePointerUp, handlePurchaseKeyboardClick, handlePurchaseWheel, restoreActiveLoadout } from "./ui/purchaseUi.js";
import { renderSideControls, handleShipGroupListClick, handleShipGroupListChange, beginRallyPointPlacement, resetRallyPointToSpawn, handleSelectedCombatStyleClick, handleMovementToggleClick } from "./ui/sidePanelUi.js";
import { updateLobbyState, createGame, joinExistingGame, joinRoom, deployDesign, startDesign, closeLobby, restartMatch, returnToLobby, leaveLobby, openMainMenu, openLobbyManagement, openSettings, closeSettings, hideMenuScreens, saveServerSetting, clearServerSetting, sendRulesUpdate, bindKickButtonContainer, bindSettingsRecoveryControls } from "./ui/lobbyUi.js";
import { focusPanelStation } from "./ui/stationPanelUi.js";
import { initArenaRenderer, resizeArenaRenderer } from "./game/renderController.js";
import { handleKeyDown, handleKeyUp, bindArenaPointerListeners } from "./game/input.js";
import { LOCAL_ACTIVE_ROOM_KEY, syncUrlParams, DIAGNOSTICS_ENABLED } from "./constants.js";
import { loadPreferences, persistPreferences, applyInterfacePreferences } from "./localPreferences.js";
import { bindRoomRecoveryCard, renderRecoveryCard } from "./ui/roomRecoveryUi.js";
import { send, getConfiguredServerUrl, persistServerQueryParam } from "./network.js";
import { applyComponentBalance } from "./design/parts.js";
import { initLedger, openLedger, closeLedger } from "./ledger/fleetLedgerUi.js";
import { applyFeatureFlagPresentation, WIRING_ENABLED } from "./featureFlags.js";
import { initMusic } from "./audio/musicSystem.js";

const loadedPreferences = loadPreferences().preferences;
applyFeatureFlagPresentation();
initMusic(loadedPreferences);
if (!loadedPreferences.pilotName) loadedPreferences.pilotName = `Pilot-${Math.floor(100 + Math.random() * 900)}`;
applyInterfacePreferences(loadedPreferences);
dom.pilotName.value = loadedPreferences.pilotName;
dom.pilotColor.value = loadedPreferences.preferredColor;
dom.teamSelect.value = loadedPreferences.preferredTeam;
if (dom.combatStyleSelect) {
  dom.combatStyleSelect.value = state.combatStyle || "hold";
}

// Development/test-only handles: read-only client-state access and an
// arbitrary-protocol-send function. Exposed only when diagnostics are enabled
// (local dev hosts or explicit ?diagnostics=1 / window.__mfaEnableDiagnostics),
// never in normal production builds. Not used by game code.
if (DIAGNOSTICS_ENABLED) {
  window.__mfaMainLoaded = true;
  window.__mfaState = state;
  // Send a message through the live WebSocket. Lets the end-to-end turret test
  // drive real lobby/deploy/command messages over the real protocol.
  window.__mfaNetSend = (message) => send(message);
}

setPartPaletteSelectionPresentationRefresh(refreshBlueprintSelectionPresentation);

// Register core window listeners
window.addEventListener("resize", resizeArenaRenderer);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (dom.confirmModal && !dom.confirmModal.hidden) { closeConfirmModal(); return; }
    if (dom.keybindsModal && !dom.keybindsModal.hidden) { dom.keybindsModal.hidden = true; return; }
    if (dom.mainMenuScreen && !dom.mainMenuScreen.hidden) { if (!dom.mainMenuCloseButton?.disabled) hideMenuScreens(); return; }
    if (dom.lobbyManagementScreen && !dom.lobbyManagementScreen.hidden) { hideMenuScreens(); return; }
    if (dom.settingsScreen && !dom.settingsScreen.hidden) { closeSettings(); return; }
  }
  handleKeyDown(event);
});
window.addEventListener("keyup", (event) => handleKeyUp(event));

// Register main DOM actions
dom.createButton.addEventListener("click", createGame);
dom.joinButton.addEventListener("click", joinExistingGame);
dom.deployButton.addEventListener("click", deployDesign);
if (dom.openBlueprintDesignerButton) dom.openBlueprintDesignerButton.addEventListener("click", () => openBlueprintDesigner());
if (dom.lobbyOpenDesignerButton) dom.lobbyOpenDesignerButton.addEventListener("click", openBlueprintDesignerFromLobby);
if (dom.closeBlueprintDesignerButton) dom.closeBlueprintDesignerButton.addEventListener("click", requestCloseBlueprintDesigner);
dom.shipGroupList?.addEventListener("click", handleShipGroupListClick);
dom.shipGroupList?.addEventListener("change", handleShipGroupListChange);
dom.rallyPointButton?.addEventListener("click", beginRallyPointPlacement);
dom.resetRallyButton?.addEventListener("click", resetRallyPointToSpawn);
dom.combatStyleControls?.addEventListener("click", handleSelectedCombatStyleClick);
dom.movementToggleControls?.addEventListener("click", handleMovementToggleClick);
dom.blueprintCostBanner?.addEventListener("click", () => {
  if (dom.blueprintCostBreakdown) {
    const open = dom.blueprintCostBreakdown.hidden;
    dom.blueprintCostBreakdown.hidden = !open;
    dom.blueprintCostBanner.setAttribute("aria-expanded", open ? "true" : "false");
  }
});
dom.combatStyleSelect?.addEventListener("change", (e) => {
  state.combatStyle = e.target.value;
  import("./design/blueprintStorage.js").then((mod) => {
    mod.persistDesign(state.design, state.wiring, state.dataLinks, state.combatStyle);
  });
  refreshLoadedBlueprintPresentation();
  if (state.phase === "active" && state.socket && state.socket.readyState === WebSocket.OPEN) {
    send({ type: "deploy", design: state.design, wiring: state.wiring, dataLinks: state.dataLinks, combatStyle: state.combatStyle });
  }
});
dom.saveDesignButton?.addEventListener("click", () => {
  import("./ui/savedBlueprintsUi.js").then((mod) => {
    mod.saveCurrentDesign();
  });
});
dom.saveAsCopyButton?.addEventListener("click", () => {
  saveCurrentDesignAsCopy();
});
dom.confirmDiscardButton?.addEventListener("click", () => {
  confirmDiscardAction();
});
dom.resetButton.addEventListener("click", requestResetDesign);
dom.clearGridButton.addEventListener("click", requestClearDesign);
dom.undoBlueprintEditButton?.addEventListener("click", undoBlueprintEdit);
dom.copyCodeButton?.addEventListener("click", () => {
  if (!navigator.clipboard?.writeText) return;
  navigator.clipboard.writeText(state.room);
  notify.clipboard("Room code copied");
});

dom.keybindsButton?.addEventListener("click", () => {
  if (dom.keybindsModal) dom.keybindsModal.hidden = false;
});
dom.keybindsCloseButton?.addEventListener("click", () => {
  if (dom.keybindsModal) dom.keybindsModal.hidden = true;
});
dom.keybindsModal?.addEventListener("click", (event) => {
  if (event.target === dom.keybindsModal) dom.keybindsModal.hidden = true;
});

dom.copyButton.addEventListener("click", () => {
  // Copy invite logic
  const url = new URL(location.href);
  if (state.room) url.searchParams.set("room", state.room);
  const configuredServer = getConfiguredServerUrl();
  if (configuredServer) url.searchParams.set("server", configuredServer);
  const text = state.room ? `${url.toString()}  Room: ${state.room}` : url.toString();
  if (!navigator.clipboard?.writeText) {
    notify.clipboard("Clipboard unavailable", false);
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => notify.clipboard("Invite copied"),
    () => notify.clipboard("Clipboard unavailable", false)
  );
});

dom.botButton.addEventListener("click", () => {
  import("./ui/lobbyUi.js").then((mod) => mod.addBot());
});
dom.leaveLobbyButton?.addEventListener("click", leaveLobby);
dom.startDesignButton.addEventListener("click", startDesign);
dom.restartLobbyButton?.addEventListener("click", returnToLobby);
dom.closeLobbyButton.addEventListener("click", closeLobby);
dom.restartButton.addEventListener("click", restartMatch);
if (dom.returnToLobbyButton) dom.returnToLobbyButton.addEventListener("click", returnToLobby);
dom.endCloseButton.addEventListener("click", closeLobby);
dom.endLeaveButton?.addEventListener("click", leaveLobby);
dom.minimizeEndGameButton?.addEventListener("click", () => {
  state.endGameMinimized = true;
  if (dom.endGameScreen) dom.endGameScreen.hidden = true;
  if (dom.showEndGameButton) dom.showEndGameButton.hidden = false;
});
dom.showEndGameButton?.addEventListener("click", () => {
  state.endGameMinimized = false;
  if (dom.endGameScreen) dom.endGameScreen.hidden = false;
  if (dom.showEndGameButton) dom.showEndGameButton.hidden = true;
});
dom.mainMenuButton?.addEventListener("click", openMainMenu);
dom.lobbyManagementButton?.addEventListener("click", openLobbyManagement);
dom.settingsButton?.addEventListener("click", openSettings);
dom.mainMenuSettingsButton?.addEventListener("click", openSettings);
dom.mainMenuCloseButton?.addEventListener("click", hideMenuScreens);
dom.lobbyCloseButton?.addEventListener("click", hideMenuScreens);
dom.settingsCloseButton?.addEventListener("click", closeSettings);
dom.fleetLedgerButton?.addEventListener("click", () => openLedger("overview"));
dom.sidePanelFleetLedgerButton?.addEventListener("click", () => openLedger("overview"));
dom.designerFleetLedgerButton?.addEventListener("click", () => openLedger("overview"));
dom.ledgerCloseButton?.addEventListener("click", closeLedger);
dom.ledgerOverlay?.addEventListener("pointerdown", (event) => {
  if (event.target === dom.ledgerOverlay) closeLedger();
});
initLedger();
dom.saveServerButton?.addEventListener("click", saveServerSetting);
dom.clearServerButton?.addEventListener("click", clearServerSetting);
dom.confirmCancelButton?.addEventListener("click", closeConfirmModal);
dom.confirmAcceptButton?.addEventListener("click", confirmModalAction);
dom.confirmModal?.addEventListener("pointerdown", (event) => {
  if (event.target === dom.confirmModal) closeConfirmModal();
});

// Rules controls updates
dom.gameModeSelect?.addEventListener("change", sendRulesUpdate);
dom.startingMoneyInput?.addEventListener("change", sendRulesUpdate);
dom.maxPlayersInput?.addEventListener("change", sendRulesUpdate);
dom.mapSizeSelect?.addEventListener("change", sendRulesUpdate);
dom.asteroidDensitySelect?.addEventListener("change", sendRulesUpdate);
dom.infrastructureModeSelect?.addEventListener("change", sendRulesUpdate);
dom.visibilityModeSelect?.addEventListener("change", sendRulesUpdate);
dom.stationPanelFocus?.addEventListener("click", focusPanelStation);

// Team select updates
dom.teamSelect?.addEventListener("change", () => {
  persistPreferences({ ...loadPreferences().preferences, preferredTeam: dom.teamSelect.value });
  if (state.room && state.socket && state.socket.readyState === WebSocket.OPEN) {
    send({ type: "setTeam", team: dom.teamSelect.value });
  }
});

// Name input updates
dom.pilotName?.addEventListener("change", () => {
  const name = String(dom.pilotName.value || "").trim().slice(0, 18);
  if (name) {
    persistPreferences({ ...loadPreferences().preferences, pilotName: name });
    if (state.room && state.socket && state.socket.readyState === WebSocket.OPEN) {
      send({ type: "setName", name });
    }
  }
});

// Personal colour input updates
dom.pilotColor?.addEventListener("change", () => {
  const color = String(dom.pilotColor.value || "").trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
    persistPreferences({ ...loadPreferences().preferences, preferredColor: color });
    if (state.room && state.socket && state.socket.readyState === WebSocket.OPEN) {
      send({ type: "setColor", color });
    }
  }
});

// Purchase quantity updates
dom.purchaseQuantityOne?.addEventListener("click", () => setPurchaseQuantity(1));
dom.purchaseQuantityFive?.addEventListener("click", () => setPurchaseQuantity(5));

// Bind Saved designs listeners
dom.savedDesignList?.addEventListener("pointerdown", handleSavedDesignPointerDown);
dom.savedDesignList?.addEventListener("pointerup", handleSavedDesignPointerUp);
dom.savedDesignList?.addEventListener("click", handleSavedDesignKeyboardClick);

// Bind Purchase options listeners
dom.purchaseOptions?.addEventListener("pointerdown", handlePurchasePointerDown);
dom.purchaseOptions?.addEventListener("pointerup", handlePurchasePointerUp);
dom.purchaseOptions?.addEventListener("click", handlePurchaseKeyboardClick);
dom.purchaseBar?.addEventListener("wheel", handlePurchaseWheel, { passive: false });

// Bind kick handlers
bindKickButtonContainer(dom.playerList);
bindKickButtonContainer(dom.playerStatusList);

// Bind canvas pointer listeners
if (dom.canvas) bindArenaPointerListeners(dom.canvas);

// Initialize bootstrapping
bindRoomRecoveryCard();
bindSettingsRecoveryControls();
initializeClient();

async function initializeClient() {
  await loadComponentBalance();
  renderPalette();
  initializeDesignerInspector();
  if (WIRING_ENABLED) bindPowerPriorityControls();
  initializeSavedBlueprintLibraryControls();
  restoreActiveLoadout();
  renderPartInspector();
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
  renderPurchaseBar();
  renderSideControls();
  updateLobbyState();
  openMainMenu();
  await initArenaRenderer();
  
  // Connection ping tick loop
  setInterval(() => {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      send({ type: "ping", at: performance.now() });
    }
  }, 3000);

  // Persist the server query parameter before syncUrlParams can remove it.
  persistServerQueryParam();

  // Auto-connect if URL parameter room or active local room exists
  const roomFromUrl = new URLSearchParams(location.search).get("room");
  if (roomFromUrl) {
    const cleanRoom = roomFromUrl.toUpperCase().slice(0, 8);
    dom.roomCode.value = cleanRoom;
    joinRoom(cleanRoom);
  } else {
    const activeRoom = (localStorage.getItem(LOCAL_ACTIVE_ROOM_KEY) || "").toUpperCase().slice(0, 8);
    if (activeRoom) {
      dom.roomCode.value = activeRoom;
      joinRoom(activeRoom);
    }
  }
  syncUrlParams();
  renderRecoveryCard();
}

async function loadComponentBalance() {
  if (typeof fetch !== "function") return;
  const { acceptDownloadedBalance, recordBalanceFetchFailure } = await import("./balanceStatus.js");
  let balance;
  try {
    const response = await fetch("/component-balance.generated.json", { cache: "no-store" });
    if (!response.ok) {
      // Fetch failed: keep the packaged copy and surface a restrained warning.
      recordBalanceFetchFailure(`HTTP ${response.status}`);
      notify.warning("Live game balance could not be confirmed; using the built-in copy.", { key: "balance-fetch" });
      return;
    }
    balance = await response.json();
  } catch (error) {
    recordBalanceFetchFailure(String(error?.message || error));
    notify.warning("Live game balance could not be confirmed; using the built-in copy.", { key: "balance-fetch" });
    return;
  }

  // Validate the downloaded payload before applying anything. A malformed
  // response must never be partially applied or coerced to zeros : keep the last
  // known good balance and record a diagnostic.
  const result = acceptDownloadedBalance(balance);
  if (!result.ok) {
    console.error("[mfa] Rejected live component balance:", result.errors.join("; "));
    notify.warning("Live game balance was invalid; using the built-in copy.", { key: "balance-fetch" });
    return;
  }

  applyShipEconomy(balance.shipPricing);
  applyWiringInfrastructure(balance.wiringInfrastructure);
  const applied = applyComponentBalance(balance);
  if (!applied) return;
  renderPalette();
  renderPartInspector();
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
}
