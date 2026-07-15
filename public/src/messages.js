// Processes incoming WebSocket message packets and coordinates UI/State updates.

import { state } from "./state.js";
import { dom } from "./ui/dom.js";
import { applyServerParts } from "./design/parts.js";
import { normalizeDesign } from "./design/blueprintStorage.js";
import { invalidateHeatAnalysisCache, renderBuildGrid, renderLocalStats } from "./ui/designerUi.js";
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
import { LOCAL_ACTIVE_ROOM_KEY, WORLD_FALLBACK, FRONTEND_BUILD, syncUrlParams } from "./constants.js";
import { saveResumeCredential, clearResumeCredential } from "./reconnectStorage.js";
import { recordComponentHpChanges } from "./game/componentDamage.js";
import { mergeSnapshotTransaction } from "./snapshotMerge.js";
import { buildRequestFullStateMessage } from "./snapshotResync.js";
import { acceptSnapshotForRender, resetRenderHistory } from "./game/renderInterpolation.js";
import { disableReconnect, send, recordNetworkEvent } from "./network.js";

// Records the backend's protocol/build identification and reports skew. The
// frontend (e.g. Netlify) and the WebSocket backend deploy separately, so a
// stale backend is a real failure mode: it must be called out instead of being
// silently masked by client fallbacks. Differing build SHAs alone never block
// play — only an actually incompatible (newer-than-supported) protocol is
// rejected. Returns "ok", "stale", or "incompatible".
const protocolReportedFor = new Set();
export function checkServerProtocol(info) {
  const protocol = globalThis.MFAProtocol || {};
  const maxSupported = protocol.MAX_SUPPORTED_PROTOCOL ?? 2;
  const anglesMin = protocol.WEAPON_ANGLES_PROTOCOL ?? 2;
  const version = Number.isFinite(Number(info?.protocolVersion)) ? Number(info.protocolVersion) : null;
  const backendSha = info?.buildSha || "unknown";
  const reportKey = `${version}:${backendSha}`;
  const alreadyReported = protocolReportedFor.has(reportKey);
  if (!alreadyReported) protocolReportedFor.add(reportKey);

  if (version !== null && version > maxSupported) {
    if (!alreadyReported) {
      console.error(
        `[mfa] Incompatible WebSocket protocol: server speaks v${version}, this client supports up to v${maxSupported}. ` +
        `Refresh to get the current frontend build. frontend=${FRONTEND_BUILD} backend=${backendSha}`
      );
    }
    return "incompatible";
  }

  if (version === null || version < anglesMin) {
    if (!alreadyReported) {
      console.warn(
        `[mfa] Stale WebSocket backend detected: protocolVersion=${version ?? "missing"} (authoritative weapon ` +
        `angles require v${anglesMin}). Turret verification cannot be claimed against this backend — the ` +
        `WebSocket server needs redeploying/restarting from the current main commit. ` +
        `frontend=${FRONTEND_BUILD} backend=${backendSha}`
      );
    }
    return "stale";
  }

  return "ok";
}

function recordServerBuild(message) {
  const info = {
    protocolVersion: message.protocolVersion ?? null,
    buildSha: message.serverBuildSha || null
  };
  const previous = state.server;
  if (previous && previous.protocolVersion === info.protocolVersion && previous.buildSha === info.buildSha) {
    return previous.compatibility;
  }
  info.compatibility = checkServerProtocol(info);
  state.server = info;
  // Read-only debug handle for diagnostics and the missing-angle warning.
  globalThis.__mfaServerBuild = { ...info };
  return info.compatibility;
}

export function handleServerMessage(message) {
  if (message.type === "hello") {
    recordServerBuild(message);
    if (state.server?.compatibility === "incompatible") {
      showToast("Server protocol is newer than this client build — refresh the page.", "error");
    }
    state.connectionId = message.connectionId || message.id;
    applyServerParts(message.parts || {});
    state.design = normalizeDesign(state.design);
    invalidateHeatAnalysisCache();
    state.hoveredHeatPartIndex = null;
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
      invalidateHeatAnalysisCache();
      state.hoveredHeatPartIndex = null;
      renderBuildGrid();
      renderLocalStats();
    }
    return;
  }

  if (message.type === "joined") {
    state.joiningLobby = false;
    state.myId = message.playerId || message.id;
    recordNetworkEvent("joined", { playerId: state.myId });
    state.connectionId = message.connectionId || state.connectionId;
    state.attachmentId = message.attachmentId || null;
    state.room = message.room;
    state.world = message.world || state.world;
    state.map = message.map || state.map;
    state.phase = message.phase || "lobby";
    state.adminId = message.adminId || null;
    state.rules = { ...state.rules, ...(message.rules || {}) };
    if (message.resumeToken) saveResumeCredential(message.room, message.resumeToken);
    state.selectedShipIds.clear();
    state.snapshotNetwork = { stateEpoch: 0, snapshotSeq: 0, staticRevision: 0, hasFullBaseline: false, resyncing: false, lastResyncRequestAt: 0 };
    resetRenderHistory();
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
    recordServerBuild(message);
    const previousPhase = state.phase;
    const result = mergeSnapshotTransaction(state.snapshot, state.snapshotNetwork, message);
    if (!result.ok) {
      recordNetworkEvent("snapshotRejected", { reason: result.reason });
      if (!["stale-epoch", "stale-sequence", "duplicate-sequence"].includes(result.reason)) {
        requestFullState(result.reason);
      }
      return;
    }
    state.snapshotNetwork = { ...result.networkState, resyncing: false, lastResyncRequestAt: state.snapshotNetwork?.lastResyncRequestAt || 0 };
    recordNetworkEvent("acceptedSnapshot", { stateEpoch: state.snapshotNetwork.stateEpoch, snapshotSeq: state.snapshotNetwork.snapshotSeq, snapshotKind: message.snapshotKind || null });
    state.snapshotReceivedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const accepted = result.snapshot;
    const oldShips = new Map((state.snapshot?.ships || []).map((s) => [s.id, s]));
    for (const newShip of accepted.ships || []) {
      const oldShip = oldShips.get(newShip.id);
      if (oldShip?.chp && newShip.chp && newShip.chp !== oldShip.chp) recordComponentHpChanges(newShip, oldShip.chp, newShip.chp);
    }
    state.snapshot = accepted;
    acceptSnapshotForRender(accepted, state.snapshotReceivedAt);
    state.mine = state.snapshot.players?.find((player) => player.id === state.myId) || null;
    state.room = accepted.room;
    state.world = accepted.world || state.world;
    state.map = accepted.map || state.map;
    state.phase = accepted.phase || state.phase;
    state.adminId = accepted.adminId || state.adminId;
    state.rules = { ...state.rules, ...(accepted.rules || {}) };
    dom.roomLabel.textContent = accepted.room;
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

function requestFullState(reason) {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const net = state.snapshotNetwork || (state.snapshotNetwork = { stateEpoch: 0, snapshotSeq: 0, staticRevision: 0, hasFullBaseline: false });
  if (net.resyncing && now - (net.lastResyncRequestAt || 0) < 1000) return;
  net.resyncing = true;
  net.lastResyncRequestAt = now;
  lobbyUi.setConnectionStatus("connecting", "Resynchronizing");
  const resync = buildRequestFullStateMessage(net, reason || "client-request");
  recordNetworkEvent("notice", { type: "requestFullState", localReason: resync.localReason, wireReason: resync.wireReason, epoch: resync.message.epoch, sequence: resync.message.sequence });
  send(resync.message);
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
    recordNetworkEvent("notice", { message: message.message });
    addNotice(message.message, "good");
    return;
  }

  if (message.type === "error") {
    state.joiningLobby = false;
    if (message.requestId) purchaseUi.clearPendingPurchase(message.requestId);
    recordNetworkEvent("error", { code: message.code || null, message: message.message || "Server error", requestId: message.requestId || null, retryable: Boolean(message.retryable) });
    if (message.code === "credential-expired" || message.code === "credential-invalid") { clearResumeCredential(state.room || dom.roomCode?.value); disableReconnect(message.code); }
    if (["room-closed", "kicked", "incompatible-protocol"].includes(message.code)) { disableReconnect(message.code); forgetActiveRoom(); }
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
    disableReconnect(message.type);
    clearResumeCredential(state.room || dom.roomCode?.value);
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
