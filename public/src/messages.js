// Processes incoming WebSocket message packets and coordinates UI/State updates.

import { state } from "./state.js";
import { dom } from "./ui/dom.js";
import { applyServerParts } from "./design/parts.js";
import { normalizeDesign, normalizeWiring, defaultWiring } from "./design/blueprintStorage.js";
import { invalidateHeatAnalysisCache, renderBuildGrid, renderLocalStats } from "./ui/designerUi.js";
import { resetWiringEditorState } from "./ui/wiringUi.js";
import { renderPalette } from "./ui/partPaletteUi.js";
import { renderPartInspector } from "./ui/partInspectorUi.js";
import { renderSavedDesigns } from "./ui/savedBlueprintsUi.js";
import * as lobbyUi from "./ui/lobbyUi.js";
import * as purchaseUi from "./ui/purchaseUi.js";
import { pruneSelection } from "./game/selection.js";
import { updateHud } from "./ui/hudUi.js";
import { renderSideControls, onCombatStyleResult } from "./ui/sidePanelUi.js";
import { renderMatchStatus } from "./ui/matchStatusUi.js";
import { updateWinnerBanner } from "./ui/endGameUi.js";
import { notify, addLog } from "./ui/toastUi.js";
import { recordServerBalanceRevision } from "./balanceStatus.js";
import { LOCAL_ACTIVE_ROOM_KEY, LOCAL_DESIGN_KEY, WORLD_FALLBACK, FRONTEND_BUILD, syncUrlParams } from "./constants.js";
import { saveResumeCredential, clearResumeCredential } from "./reconnectStorage.js";
import { recordComponentHpChanges } from "./game/componentDamage.js";
import { synchronizeTelemetryFocus } from "./telemetryFocus.js";
import { mergeSnapshotTransaction } from "./snapshotMerge.js";
import { mapSnapshotRejectionToResyncReason } from "./snapshotResync.js";
import { acceptSnapshotForRender, resetRenderHistory } from "./game/renderInterpolation.js";
import { disableReconnect, send, recordNetworkEvent } from "./network.js";
import { centerCameraOnPoint } from "./game/camera.js";

// One snapshot-derived client index per accepted snapshot. UI panes read from
// this index instead of independently filtering snapshot.ships/players arrays.
function buildClientSnapshotIndex(snapshot, myId, selectedIds) {
  const shipById = new Map();
  const ownLivingShips = [];
  const ownLivingShipIds = [];
  const selectedLivingShips = [];
  const playersById = new Map();
  const relaysByTeam = new Map();
  for (const player of snapshot.players || []) playersById.set(player.id, player);
  for (const ship of snapshot.ships || []) {
    if (!ship) continue;
    shipById.set(ship.id, ship);
    const alive = ship.alive !== false;
    if (alive && ship.ownerId === myId) {
      ownLivingShips.push(ship);
      ownLivingShipIds.push(ship.id);
    }
    if (alive && selectedIds && selectedIds.has(ship.id)) selectedLivingShips.push(ship);
    if (ship.type === "relay" || ship.kind === "relay") {
      const owner = ship.ownerId || "neutral";
      let list = relaysByTeam.get(owner);
      if (!list) relaysByTeam.set(owner, list = []);
      list.push(ship);
    }
  }
  return { shipById, ownLivingShips, ownLivingShipIds, selectedLivingShips, playersById, relaysByTeam };
}

// A compact, single-pass comparison that drives which UI layers run for a
// snapshot. Avoids blindly calling every renderer on every accepted state.
function snapshotChangeSummary(previous, next, myId, selectedIds, previousIndex) {
  const all = !previous || !previousIndex;
  const selectedIdsArray = selectedIds ? [...selectedIds] : [];
  const summary = {
    phaseChanged: all || previous.phase !== next.phase,
    playersChanged: all || previous.players !== next.players,
    rulesChanged: all || previous.rules !== next.rules,
    economyChanged: all || previous.economy !== next.economy,
    fleetChanged: all || previous.ships !== next.ships,
    selectionAffected: all || previousIndex?.selectedLivingShips?.length !== selectedLivingShips.length,
    objectivesChanged: all || previous.objectives !== next.objectives || previous.victor !== next.victor,
    winnerChanged: all || previous.victor !== next.victor,
    selectedShipDamageChanged: false,
    selectedShipHeatChanged: false,
    selectedShipPowerChanged: false,
    lobbyVisible: Boolean((dom.lobbyManagementScreen && !dom.lobbyManagementScreen.hidden) || (dom.mainMenuScreen && !dom.mainMenuScreen.hidden))
  };
  if (all) {
    summary.selectedShipDamageChanged = true;
    summary.selectedShipHeatChanged = true;
    summary.selectedShipPowerChanged = true;
    return summary;
  }
  if (previousIndex && summary.fleetChanged) {
    const selectedIdsSet = selectedIds || new Set();
    for (const id of selectedIdsSet) {
      const prevShip = previousIndex.shipById.get(id);
      const nextShip = (next.shipsById || shipByIdFrom(next)).get(id);
      if (prevShip && nextShip) {
        if (prevShip.chp !== nextShip.chp || prevShip.hp !== nextShip.hp) summary.selectedShipDamageChanged = true;
        if (prevShip.heat !== nextShip.heat || prevShip.componentHeatD !== nextShip.componentHeatD) summary.selectedShipHeatChanged = true;
        if (prevShip.powerRevision !== nextShip.powerRevision || prevShip.componentPower !== nextShip.componentPower) summary.selectedShipPowerChanged = true;
      }
    }
  }
  return summary;
}

function shipByIdFrom(snapshot) {
  const m = new Map();
  for (const ship of snapshot.ships || []) if (ship) m.set(ship.id, ship);
  return m;
}

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

let balanceMismatchReported = false;
function recordServerBuild(message) {
  const info = {
    protocolVersion: message.protocolVersion ?? null,
    buildSha: message.serverBuildSha || null,
    balanceRevision: message.balanceRevision || null
  };
  // Authoritative-balance skew: block combat if the server simulates a different
  // balance than this frontend was built with.
  const balanceCompatibility = recordServerBalanceRevision(info.balanceRevision);
  info.balanceCompatibility = balanceCompatibility;
  if (balanceCompatibility === "mismatch" && !balanceMismatchReported) {
    balanceMismatchReported = true;
    notify.error("Game balance is out of date — refresh the page (or redeploy the server) before playing.", { key: "balance-mismatch", keyTtl: 15000 });
  } else if (balanceCompatibility === "ok") {
    balanceMismatchReported = false;
  }
  const previous = state.server;
  if (previous && previous.protocolVersion === info.protocolVersion && previous.buildSha === info.buildSha && previous.balanceRevision === info.balanceRevision) {
    return previous.compatibility;
  }
  info.compatibility = checkServerProtocol(info);
  state.server = info;
  // Read-only debug handle for diagnostics and the missing-angle warning.
  globalThis.__mfaServerBuild = { ...info };
  return info.compatibility;
}

function noticeTone(text, team) {
  if (team === "blue") return "blue";
  if (team === "red") return "red";
  if (/Red wing/i.test(text)) return "red";
  if (/Blue wing/i.test(text)) return "blue";
  return "";
}

function isInlineOnlyNotice(text) {
  // These are reflected directly by the deploy button, blueprint status, or lobby UI.
  return /^(Design saved — you are ready|Editor blueprint saved\.)/i.test(text);
}

function isUrgentNotice(text) {
  return /(victory countdown started|countdown interrupted|wins!?$|victory|defeat|match ended|lobby closed|room closed)/i.test(text);
}

function urgentNoticeKey(text) {
  if (/victory countdown started/i.test(text)) return "victory-countdown";
  if (/countdown interrupted/i.test(text)) return "countdown-interrupted";
  if (/wins!?$|victory|defeat|match ended/i.test(text)) return "match-ended";
  if (/lobby closed|room closed/i.test(text)) return "room-closed";
  return null;
}

function routeServerNotice(message) {
  const text = message.message || "";
  if (message.requestId) purchaseUi.clearPendingPurchase(message.requestId);
  recordNetworkEvent("notice", { message: text });
  if (isInlineOnlyNotice(text)) return;
  const tone = noticeTone(text, message.team);
  const key = urgentNoticeKey(text);
  if (key) {
    notify.urgent(text, { key, color: message.color || undefined });
    return;
  }
  addLog(text, tone);
}

export function handleServerMessage(message) {
  if (message.type === "hello") {
    recordServerBuild(message);
    if (state.server?.compatibility === "incompatible") {
      notify.error("Server protocol is newer than this client build — refresh the page.", { key: "protocol-mismatch", keyTtl: 15000 });
    }
    state.connectionId = message.connectionId || message.id;
    applyServerParts(message.parts || {});
    state.design = normalizeDesign(state.design);
    state.wiring = normalizeWiring(state.wiring, state.design);
    resetWiringEditorState();
    invalidateHeatAnalysisCache();
    state.hoveredHeatPartIndex = null;
    renderPalette();
    renderPartInspector();
    renderBuildGrid();
    renderLocalStats();
    renderSavedDesigns();
    state.world = message.world || { ...WORLD_FALLBACK };
    state.rules = { ...state.rules, ...(message.economy || {}) };
    if (!localStorage.getItem(LOCAL_DESIGN_KEY)) {
      state.design = normalizeDesign(message.defaultDesign || state.design);
      state.wiring = normalizeWiring(message.defaultWiring || defaultWiring(), state.design);
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
    state.pendingCombatStyle = null;
    state.joinedConnectionGeneration = state.connectionGeneration;
    state.snapshotNetwork = { stateEpoch: 0, snapshotSeq: 0, staticRevision: 0, hasFullBaseline: false, resyncing: false, lastResyncRequestAt: 0 };
    resetRenderHistory();
    state.activeShipGroup = null;
    synchronizeTelemetryFocus();
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
      const wireReason = mapSnapshotRejectionToResyncReason(result.reason);
      recordNetworkEvent("snapshotRejected", { reason: result.reason, wireReason });
      if (!["stale-sequence", "duplicate-sequence"].includes(result.reason)) {
        requestFullState(result.reason);
      }
      return;
    }
    state.snapshotNetwork = { ...result.networkState, resyncing: false, lastResyncRequestAt: state.snapshotNetwork?.lastResyncRequestAt || 0 };
    recordNetworkEvent("acceptedSnapshot", { stateEpoch: state.snapshotNetwork.stateEpoch, snapshotSeq: state.snapshotNetwork.snapshotSeq, snapshotKind: message.snapshotKind || null });
    state.snapshotReceivedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const accepted = result.snapshot;
    const previousSnapshot = state.snapshot;
    const previousIndex = state.snapshotIndex;

    // Reduce component-HP comparison work: only examine ships that carry a
    // changed component-HP payload. The backend already sends chpD for deltas.
    const oldShips = new Map((previousSnapshot?.ships || []).map((s) => [s.id, s]));
    for (const newShip of accepted.ships || []) {
      const oldShip = oldShips.get(newShip.id);
      const hpChanged = oldShip && newShip.chp && newShip.chp !== oldShip.chp;
      const hasDelta = newShip.chpD && newShip.chpD.length;
      if ((hpChanged || hasDelta) && newShip.chp) recordComponentHpChanges(newShip, oldShip?.chp || newShip.chp, newShip.chp);
    }

    state.snapshot = accepted;
    state.snapshotIndex = buildClientSnapshotIndex(accepted, state.myId, state.selectedShipIds);
    const summary = snapshotChangeSummary(previousSnapshot, accepted, state.myId, state.selectedShipIds, previousIndex);
    state.snapshotChangeSummary = summary;

    acceptSnapshotForRender(accepted, state.snapshotReceivedAt);
    state.mine = state.snapshotIndex.playersById.get(state.myId) || null;
    state.room = accepted.room;
    state.world = accepted.world || state.world;
    state.map = accepted.map || state.map;
    state.phase = accepted.phase || state.phase;
    state.adminId = accepted.adminId || state.adminId;
    state.rules = { ...state.rules, ...(accepted.rules || {}) };
    dom.roomLabel.textContent = accepted.room;
    purchaseUi.reconcilePendingPurchasesWithSnapshot();
    pruneSelection();
    synchronizeTelemetryFocus();
    if (summary.fleetChanged || summary.selectionAffected) updateHud();
    if (summary.fleetChanged || summary.selectionAffected || summary.phaseChanged) renderSideControls();
    if (summary.objectivesChanged || summary.winnerChanged || summary.phaseChanged) renderMatchStatus();
    if (summary.economyChanged) purchaseUi.updateEconomyUi({ refreshCatalogue: false });
    if (summary.playersChanged || summary.rulesChanged || summary.phaseChanged || summary.lobbyVisible) lobbyUi.updateLobbyState();
    if (summary.winnerChanged) updateWinnerBanner();
    if (previousPhase !== state.phase && (state.phase === "design" || state.phase === "active")) lobbyUi.hideMenuScreens();
    if (previousPhase !== "active" && state.phase === "active" && state.mine?.rallyPoint) {
      centerCameraOnPoint(state.mine.rallyPoint, 0.35);
    }
    return;
  }

function requestFullState(reason) {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const net = state.snapshotNetwork || (state.snapshotNetwork = { stateEpoch: 0, snapshotSeq: 0, staticRevision: 0, hasFullBaseline: false });
  if (net.resyncing && now - (net.lastResyncRequestAt || 0) < 1000) return;
  net.resyncing = true;
  net.lastResyncRequestAt = now;
  lobbyUi.setConnectionStatus("connecting", "Resynchronizing");
  const wireReason = mapSnapshotRejectionToResyncReason(reason);
  recordNetworkEvent("resyncRequested", { localReason: reason || null, wireReason, epoch: net.stateEpoch || 0, sequence: net.snapshotSeq || 0 });
  if (!send({ type: "requestFullState", epoch: net.stateEpoch || 0, sequence: net.snapshotSeq || 0, reason: wireReason })) { net.resyncing = false; }
}

  if (message.type === "purchaseResult") {
    purchaseUi.handlePurchaseResult(message);
    renderSideControls();
    return;
  }

  if (message.type === "combatStyleResult") {
    onCombatStyleResult(message);
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
    routeServerNotice(message);
    return;
  }

  if (message.type === "error") {
    state.joiningLobby = false;
    lobbyUi.onServerError(message);
    if (message.requestId) purchaseUi.clearPendingPurchase(message.requestId);
    recordNetworkEvent("error", { code: message.code || null, message: message.message || "Server error", requestId: message.requestId || null, retryable: Boolean(message.retryable) });
    if (message.code === "credential-expired" || message.code === "credential-invalid") { const staleRoom = state.room || dom.roomCode?.value; clearResumeCredential(staleRoom); disableReconnect(message.code); forgetActiveRoom(); lobbyUi.returnToMainMenu(message.message || "Room resume expired", "error"); return; }
    if (["room-closed", "kicked", "incompatible-protocol"].includes(message.code)) { disableReconnect(message.code); forgetActiveRoom(); }
    if (!state.room || !dom.mainMenuScreen?.hidden) {
      import("./ui/lobbyUi.js").then((mod) => {
        mod.showMenuNotice(message.message || "Server error", "error");
        mod.setConnectionStatus("error", "Join failed");
        mod.updateLobbyState();
      });
      return;
    }
    notify.error(message.message || "Server error", { key: message.code ? `server-error:${message.code}` : undefined });
    return;
  }

  if (message.type === "kicked" || message.type === "closed" || message.type === "leftLobby") {
    const tone = message.type === "kicked" ? "error" : "warning";
    state.pendingCombatStyle = null;
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
