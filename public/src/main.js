// Bootstraps the browser client by wiring state, networking, UI, input, and rendering.

import { applyShipEconomy } from "./constants.js";
import { dom } from "./ui/dom.js";
import { state } from "./state.js";
import { renderPalette } from "./ui/partPaletteUi.js";
import { renderPartInspector } from "./ui/partInspectorUi.js";
import { renderBuildGrid, renderLocalStats, requestResetDesign, requestClearDesign, undoBlueprintEdit } from "./ui/designerUi.js";
import { renderSavedDesigns, handleSavedDesignPointerDown, handleSavedDesignPointerUp, handleSavedDesignKeyboardClick, confirmModalAction, closeConfirmModal } from "./ui/savedBlueprintsUi.js";
import { openBlueprintDesigner, closeBlueprintDesigner } from "./ui/designerScreenUi.js";
import { renderPurchaseBar, setPurchaseQuantity, handlePurchasePointerDown, handlePurchasePointerUp, handlePurchaseKeyboardClick } from "./ui/purchaseUi.js";
import { renderSideControls, handleShipGroupListClick, handleShipGroupListChange, beginRallyPointPlacement, resetRallyPointToSpawn, handleSelectedCombatStyleClick } from "./ui/sidePanelUi.js";
import { updateLobbyState, createGame, joinExistingGame, joinRoom, deployDesign, startDesign, closeLobby, restartMatch, returnToLobby, leaveLobby, openMainMenu, openLobbyManagement, openSettings, hideMenuScreens, saveServerSetting, clearServerSetting, sendRulesUpdate, bindKickButtonContainer, bindSettingsRecoveryControls } from "./ui/lobbyUi.js";
import { initArenaRenderer, resizeArenaRenderer } from "./game/renderController.js";
import { handleKeyDown, bindArenaPointerListeners } from "./game/input.js";
import { LOCAL_ACTIVE_ROOM_KEY, syncUrlParams } from "./constants.js";
import { loadPreferences, persistPreferences, applyInterfacePreferences } from "./localPreferences.js";
import { bindRoomRecoveryCard, renderRecoveryCard } from "./ui/roomRecoveryUi.js";
import { send, getConfiguredServerUrl, persistServerQueryParam } from "./network.js";
import { applyComponentBalance } from "./design/parts.js";

const loadedPreferences = loadPreferences().preferences;
if (!loadedPreferences.pilotName) loadedPreferences.pilotName = `Pilot-${Math.floor(100 + Math.random() * 900)}`;
applyInterfacePreferences(loadedPreferences);
dom.pilotName.value = loadedPreferences.pilotName;
dom.teamSelect.value = loadedPreferences.preferredTeam;
dom.formationSelect.value = loadedPreferences.formation;
if (dom.combatStyleSelect) {
  dom.combatStyleSelect.value = state.combatStyle || "sentry";
}

// Debug/test handle: read-only access to the client state from the console
// and automated browser checks. Not used by game code.
window.__mfaMainLoaded = true;
window.__mfaState = state;

// Debug/test handle: send a message through the live WebSocket. Lets the
// end-to-end turret test drive real lobby/deploy/command messages over the
// real protocol (never used by game code).
window.__mfaNetSend = (message) => send(message);

// Register core window listeners
window.addEventListener("resize", resizeArenaRenderer);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (dom.confirmModal && !dom.confirmModal.hidden) { closeConfirmModal(); return; }
    if (dom.mainMenuScreen && !dom.mainMenuScreen.hidden) { if (!dom.mainMenuCloseButton?.disabled) hideMenuScreens(); return; }
    if (dom.lobbyManagementScreen && !dom.lobbyManagementScreen.hidden) { hideMenuScreens(); return; }
    if (dom.settingsScreen && !dom.settingsScreen.hidden) { hideMenuScreens(); return; }
  }
  handleKeyDown(event);
});
window.addEventListener("keyup", (event) => state.keys.delete(event.key.toLowerCase()));

// Register main DOM actions
dom.createButton.addEventListener("click", createGame);
dom.joinButton.addEventListener("click", joinExistingGame);
dom.deployButton.addEventListener("click", deployDesign);
if (dom.openBlueprintDesignerButton) dom.openBlueprintDesignerButton.addEventListener("click", openBlueprintDesigner);
if (dom.closeBlueprintDesignerButton) dom.closeBlueprintDesignerButton.addEventListener("click", closeBlueprintDesigner);
dom.shipGroupList?.addEventListener("click", handleShipGroupListClick);
dom.shipGroupList?.addEventListener("change", handleShipGroupListChange);
dom.rallyPointButton?.addEventListener("click", beginRallyPointPlacement);
dom.resetRallyButton?.addEventListener("click", resetRallyPointToSpawn);
dom.combatStyleControls?.addEventListener("click", handleSelectedCombatStyleClick);
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
    mod.persistDesign(state.design, state.wiring, state.combatStyle);
  });
  if (state.phase === "active" && state.socket && state.socket.readyState === WebSocket.OPEN) {
    send({ type: "deploy", design: state.design, wiring: state.wiring, combatStyle: state.combatStyle });
  }
});
dom.saveDesignButton?.addEventListener("click", () => {
  import("./ui/savedBlueprintsUi.js").then((mod) => {
    mod.saveCurrentDesign();
  });
});
dom.resetButton.addEventListener("click", requestResetDesign);
dom.clearGridButton.addEventListener("click", requestClearDesign);
dom.undoBlueprintEditButton?.addEventListener("click", undoBlueprintEdit);
dom.copyCodeButton?.addEventListener("click", () => {
  if (!navigator.clipboard?.writeText) return;
  navigator.clipboard.writeText(state.room);
  import("./ui/toastUi.js").then((toastMod) => {
    toastMod.showToast("Room code copied", "good");
  });
});

dom.copyButton.addEventListener("click", () => {
  // Copy invite logic
  const url = new URL(location.href);
  if (state.room) url.searchParams.set("room", state.room);
  const configuredServer = getConfiguredServerUrl();
  if (configuredServer) url.searchParams.set("server", configuredServer);
  const text = state.room ? `${url.toString()}  Room: ${state.room}` : url.toString();
  if (!navigator.clipboard?.writeText) {
    import("./ui/toastUi.js").then((toastMod) => {
      toastMod.addNotice("Clipboard unavailable", "warning");
    });
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => {
      import("./ui/toastUi.js").then((toastMod) => {
        toastMod.addNotice("Invite copied", "good");
      });
    },
    () => {
      import("./ui/toastUi.js").then((toastMod) => {
        toastMod.addNotice("Clipboard unavailable", "warning");
      });
    }
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
dom.mainMenuCloseButton?.addEventListener("click", hideMenuScreens);
dom.lobbyCloseButton?.addEventListener("click", hideMenuScreens);
dom.settingsCloseButton?.addEventListener("click", hideMenuScreens);
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

// Formation updates
dom.formationSelect?.addEventListener("change", () => {
  persistPreferences({ ...loadPreferences().preferences, formation: dom.formationSelect.value });
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

// Bind kick handlers
bindKickButtonContainer(dom.playerList);
bindKickButtonContainer(dom.scoreList);

// Bind canvas pointer listeners
if (dom.canvas) bindArenaPointerListeners(dom.canvas);

// Initialize bootstrapping
bindRoomRecoveryCard();
bindSettingsRecoveryControls();
initializeClient();

async function initializeClient() {
  await loadComponentBalance();
  renderPalette();
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
  try {
    const response = await fetch("/component-balance.json", { cache: "no-store" });
    if (!response.ok) return;
    const balance = await response.json();
    applyShipEconomy(balance.shipPricing);
    const applied = applyComponentBalance(balance);
    if (!applied) return;
    renderPalette();
    renderPartInspector();
    renderBuildGrid();
    renderLocalStats();
    renderSavedDesigns();
  } catch {
    // Fail silently, use defaults
  }
}
