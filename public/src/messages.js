// Processes incoming WebSocket message packets and coordinates UI/State updates.

import { state } from "./state.js";
import { dom } from "./ui/dom.js";
import { applyServerParts } from "./design/parts.js";
import { normalizeDesign } from "./design/blueprintStorage.js";
import { renderBuildGrid, renderLocalStats } from "./ui/designerUi.js";
import { renderPalette } from "./ui/partPaletteUi.js";
import { renderPartInspector } from "./ui/partInspectorUi.js";
import { renderSavedDesigns } from "./ui/savedBlueprintsUi.js";
import * as lobbyUi from "./ui/lobbyUi.js";
import * as purchaseUi from "./ui/purchaseUi.js";
import { pruneSelection } from "./game/selection.js";
import { updateHud } from "./ui/hudUi.js";
import { renderSideControls } from "./ui/sidePanelUi.js";
import { renderScoreboard } from "./ui/scoreboardUi.js";
import { updateWinnerBanner } from "./ui/endGameUi.js";
import { showToast, addNotice } from "./ui/toastUi.js";
import { LOCAL_ACTIVE_ROOM_KEY, WORLD_FALLBACK, syncUrlParams } from "./constants.js";
import { recordComponentHpChanges } from "./game/componentDamage.js";

export function handleServerMessage(message) {
  if (message.type === "hello") {
    state.myId = message.id;
    applyServerParts(message.parts || {});
    state.design = normalizeDesign(state.design);
    renderPalette();
    renderPartInspector();
    renderBuildGrid();
    renderLocalStats();
    renderSavedDesigns();
    state.world = message.world || { ...WORLD_FALLBACK };
    state.rules = { ...state.rules, ...(message.economy || {}) };
    const LOCAL_DESIGN_KEY = "modular-fleet-design-v2";
    if (!localStorage.getItem(LOCAL_DESIGN_KEY)) {
      state.design = normalizeDesign(message.defaultDesign || state.design);
      renderBuildGrid();
      renderLocalStats();
    }
    return;
  }

  if (message.type === "joined") {
    state.joiningLobby = false;
    state.myId = message.id;
    state.room = message.room;
    state.world = message.world || state.world;
    state.map = message.map || state.map;
    state.phase = message.phase || "lobby";
    state.adminId = message.adminId || null;
    state.rules = { ...state.rules, ...(message.rules || {}) };
    state.selectedShipIds.clear();
    state.activeShipGroup = null;
    dom.roomCode.value = message.room;
    dom.currentRoomCode.textContent = message.room;
    dom.currentRoomCard.hidden = false;
    dom.roomLabel.textContent = message.room;
    lobbyUi.clearMenuNotice();
    rememberActiveRoom(message.room);
    lobbyUi.setConnectionStatus("online", "Room linked");
    renderSideControls();
    lobbyUi.updateLobbyState();
    if (state.phase === "design" || state.phase === "active") {
      lobbyUi.hideMenuScreens();
    } else {
      lobbyUi.openLobbyManagement();
    }
    return;
  }

  if (message.type === "state") {
    const previousPhase = state.phase;
    if (state.snapshot && state.snapshot.players && message.players) {
      const oldPlayers = new Map(state.snapshot.players.map(p => [p.id, p]));
      for (const newPlayer of message.players) {
        const oldPlayer = oldPlayers.get(newPlayer.id);
        if (oldPlayer) {
          if (newPlayer.design === undefined) newPlayer.design = oldPlayer.design;
          if (newPlayer.stats === undefined) newPlayer.stats = oldPlayer.stats;
        }
      }
    }
    // The server sends each ship's design once (it never changes after spawn);
    // reuse the cached copy from the previous snapshot on later updates.
    // Component hp (`chp`) works the same way: a full array rides along with the
    // design, later snapshots only carry `chpD` deltas of [index, hp, ...].
    if (state.snapshot && state.snapshot.ships && message.ships) {
      const oldShips = new Map(state.snapshot.ships.map(s => [s.id, s]));
      for (const newShip of message.ships) {
        const oldShip = oldShips.get(newShip.id);
        if (newShip.design === undefined && oldShip) newShip.design = oldShip.design;
        const oldChp = oldShip?.chp;
        if (newShip.chp === undefined && oldChp) {
          if (newShip.chpD && newShip.chpD.length) {
            const merged = oldChp.slice();
            for (let k = 0; k + 1 < newShip.chpD.length; k += 2) {
              merged[newShip.chpD[k]] = newShip.chpD[k + 1];
            }
            newShip.chp = merged;
          } else {
            newShip.chp = oldChp;
          }
        }
        // Client-only damage feedback (flashes, penetration trace, damage feed,
        // core warnings) derived from what changed between cached and new hp.
        if (oldChp && newShip.chp && newShip.chp !== oldChp) {
          recordComponentHpChanges(newShip, oldChp, newShip.chp);
        }
      }
    }
    state.snapshotReceivedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    state.snapshot = message;
    state.mine = state.snapshot.players?.find((player) => player.id === state.myId) || null;
    state.room = message.room;
    state.world = message.world || state.world;
    state.map = message.map || state.map;
    state.phase = message.phase || state.phase;
    state.adminId = message.adminId || state.adminId;
    state.rules = { ...state.rules, ...(message.rules || {}) };
    dom.roomLabel.textContent = message.room;
    purchaseUi.reconcilePendingPurchasesWithSnapshot();
    pruneSelection();
    updateHud();
    renderSideControls();
    renderScoreboard();
    purchaseUi.updateEconomyUi();
    lobbyUi.updateLobbyState();
    updateWinnerBanner();
    if (previousPhase !== state.phase && (state.phase === "design" || state.phase === "active")) lobbyUi.hideMenuScreens();
    return;
  }

  if (message.type === "purchaseResult") {
    const pending = message.requestId ? purchaseUi.clearPendingPurchase(message.requestId) : null;
    if (message.ok) {
      const count = Number(message.count) || pending?.count || 1;
      const totalCost = Number(message.totalCost) || 0;
      showToast(`Built ${count} ship${count === 1 ? "" : "s"}${totalCost ? ` for $${totalCost}` : ""}`, "good");
    } else {
      const reason = message.message || "Purchase failed";
      if (pending?.optionId) purchaseUi.setPurchaseError(pending.optionId, reason);
      showToast(reason, "error");
    }
    purchaseUi.renderPurchaseBar();
    renderSideControls();
    return;
  }

  if (message.type === "pong") {
    if (message.at) {
      state.latency = performance.now() - message.at;
      state.lastPongAt = performance.now();
    }
    return;
  }

  if (message.type === "notice") {
    if (message.requestId) purchaseUi.clearPendingPurchase(message.requestId);
    addNotice(message.message, "good");
    return;
  }

  if (message.type === "error") {
    state.joiningLobby = false;
    if (message.requestId) purchaseUi.clearPendingPurchase(message.requestId);
    if (/closed|kicked/i.test(message.message || "")) forgetActiveRoom();
    if (!state.room || !dom.mainMenuScreen?.hidden) {
      import("./ui/lobbyUi.js").then((mod) => {
        mod.showMenuNotice(message.message || "Server error", "error");
        mod.setConnectionStatus("error", "Join failed");
        mod.updateLobbyState();
      });
      return;
    }
    addNotice(message.message || "Server error", "error");
    return;
  }

  if (message.type === "kicked" || message.type === "closed" || message.type === "leftLobby") {
    const tone = message.type === "kicked" ? "error" : "warning";
    forgetActiveRoom();
    lobbyUi.returnToMainMenu(message.message || "Left lobby", tone);
  }
}

export function rememberActiveRoom(roomCode) {
  if (roomCode) {
    localStorage.setItem(LOCAL_ACTIVE_ROOM_KEY, String(roomCode).toUpperCase());
    syncUrlParams();
  }
}

export function forgetActiveRoom() {
  localStorage.removeItem(LOCAL_ACTIVE_ROOM_KEY);
  syncUrlParams();
}
