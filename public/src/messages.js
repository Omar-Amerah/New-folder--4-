// Processes incoming WebSocket message packets and coordinates UI/State updates.

import { state } from "./state.js";
import { dom } from "./ui/dom.js";
import { applyServerParts } from "./design/parts.js";
import { normalizeDesign, normalizeWiring, defaultWiring } from "./design/blueprintStorage.js";
import { invalidateHeatAnalysisCache, renderBuildGrid, renderLocalStats } from "./ui/designerUi.js";
import { closeBlueprintDesigner } from "./ui/designerScreenUi.js";
import { resetWiringEditorState } from "./ui/wiringUi.js";
import { renderPalette } from "./ui/partPaletteUi.js";
import { renderPartInspector } from "./ui/partInspectorUi.js";
import { renderSavedDesigns } from "./ui/savedBlueprintsUi.js";
import * as lobbyUi from "./ui/lobbyUi.js";
import * as purchaseUi from "./ui/purchaseUi.js";
import { pruneSelection } from "./game/selection.js";
import { updateTeamHud, updateFleetHud, updateEconomyHud, updateRelayHud, updateSelectionHud, updateObjectiveHud, updateHeatHud, updateLatencyHud } from "./ui/hudUi.js";
import {
  onCombatStyleResult,
  onOrbitDirectionResult,
  onMovementTogglesResult,
  updateShipGroupUi,
  updateRallyUi,
  updateSelectionCommandUi,
  updateSelectedShipVitals,
  updateSelectedShipDamageUi,
  updateSelectedShipHeatUi,
  updateSelectedShipPowerUi
} from "./ui/sidePanelUi.js";
import {
  updateRelayStatus,
  updateControlVictoryStatus,
  updateScoreboardStatus,
  updateWinnerStatus
} from "./ui/matchStatusUi.js";
import { updateStationPanel } from "./ui/stationPanelUi.js";
import { notify, addLog } from "./ui/toastUi.js";
import { recordServerBalanceRevision } from "./balanceStatus.js";
import { LOCAL_ACTIVE_ROOM_KEY, LOCAL_DESIGN_KEY, WORLD_FALLBACK, FRONTEND_BUILD, DIAGNOSTICS_ENABLED, syncUrlParams } from "./constants.js";
import { saveResumeCredential, clearResumeCredential } from "./reconnectStorage.js";
import { recordComponentHpChanges } from "./game/componentDamage.js";
import { synchronizeTelemetryFocus } from "./telemetryFocus.js";
import { mergeSnapshotTransaction } from "./snapshotMerge.js";
import { mapSnapshotRejectionToResyncReason } from "./snapshotResync.js";
import { acceptSnapshotForRender, resetRenderHistory } from "./game/renderInterpolation.js";
import { disableReconnect, send, recordNetworkEvent } from "./network.js";
import { centerCameraOnPoint } from "./game/camera.js";
import {
  allPresentationChanges,
  buildSnapshotIndex,
  captureLocalPresentationState,
  changesForLocalInvalidation,
  derivePresentationChanges,
  dispatchPresentationChanges as dispatchSemanticPresentationChanges,
  refreshSnapshotSelectionIndex
} from "./snapshotPresentation.js";
import { registerPresentationInvalidationHandler, invalidatePresentation } from "./presentationInvalidation.js";

// Compatibility alias retained for existing diagnostics consumers.
const snapshotDiagnostics = state.presentationDiagnostics;
snapshotDiagnostics.snapshotPresentationErrorCount ||= 0;
snapshotDiagnostics.lobbyToDesignCount ||= 0;
snapshotDiagnostics.designToActiveCount ||= 0;
state.snapshotDiagnostics = snapshotDiagnostics;
if (DIAGNOSTICS_ENABLED) globalThis.__mfaSnapshotDiagnostics = snapshotDiagnostics;

function runPresentation(name, fn) {
  try {
    fn();
  } catch (e) {
    snapshotDiagnostics.presentationErrorCount += 1;
    snapshotDiagnostics.snapshotPresentationErrorCount += 1;
    console.error(`[mfa] ${name} failed:`, e);
  }
}

function presentationHandlers() {
  const handlers = {
    updateTeamHud,
    updateFleetHud,
    updateEconomyHud,
    updateRelayHud,
    updateSelectionHud,
    updateObjectiveHud,
    updateHeatHud,
    updateLatencyHud,
    updateShipGroupUi,
    updateRallyUi,
    updateSelectionCommandUi,
    updateSelectedShipVitals,
    updateSelectedShipDamageUi,
    updateSelectedShipHeatUi,
    updateSelectedShipPowerUi,
    updateLobbyVisibility: lobbyUi.updateLobbyVisibility,
    updateLobbyRules: lobbyUi.updateLobbyRules,
    updateLobbyPlayerRows: lobbyUi.updateLobbyPlayerRows,
    updateLobbyPlayerStatus: lobbyUi.updateLobbyPlayerStatus,
    updateStationPanel,
    updateRelayStatus,
    updateControlVictoryStatus,
    updateScoreboardStatus,
    updateWinnerStatus,
    updatePurchaseAffordability: purchaseUi.updatePurchaseAffordability,
    updatePurchasePendingState: purchaseUi.updatePurchasePendingState,
    updatePurchaseErrors: purchaseUi.updatePurchaseErrors,
    updatePurchaseCatalogue: purchaseUi.updatePurchaseCatalogue,
    updateDeploymentControls: purchaseUi.updateDeploymentControls
  };
  const forced = state.presentationTestHooks?.throwOnUpdater;
  if (!forced || !handlers[forced]) return handlers;
  return {
    ...handlers,
    [forced]: () => { throw new Error(`forced presentation updater failure: ${forced}`); }
  };
}

export function dispatchPresentationChanges(changes) {
  return dispatchSemanticPresentationChanges(changes, {
    handlers: presentationHandlers(),
    shipStatusView: state.shipStatusView,
    onDispatch: (operations) => {
      snapshotDiagnostics.presentationDispatchCount += 1;
      snapshotDiagnostics.latest.operations = operations.slice();
      state.snapshotPresentationUpdatePlan = operations;
    },
    onError: (operation, error) => {
      snapshotDiagnostics.presentationErrorCount += 1;
      snapshotDiagnostics.snapshotPresentationErrorCount += 1;
      console.error(`[mfa] ${operation} failed:`, error);
    }
  });
}

registerPresentationInvalidationHandler((reason) => {
  if (reason === "selection") refreshSnapshotSelectionIndex(state.snapshotIndex, state.selectedShipIds);
  dispatchPresentationChanges(changesForLocalInvalidation(reason));
});

// Authoritative phase presentation: drives critical mode switches and is never skipped by optional UI optimisation.
export function synchronizePhasePresentation(previousPhase, nextPhase) {
  if (nextPhase === previousPhase) return;
  snapshotDiagnostics.phasePresentationSyncCount += 1;
  runPresentation("phase:clearPendingEndGameAction", lobbyUi.clearPendingEndGameAction);

  if (nextPhase === "lobby") {
    runPresentation("phase:closeBlueprintDesigner", closeBlueprintDesigner);
    runPresentation("phase:clearMatchPanels", () => lobbyUi.clearMatchPanels?.());
    runPresentation("phase:openLobbyManagement", lobbyUi.openLobbyManagement);
    runPresentation("phase:updateDeploymentControls", purchaseUi.updateDeploymentControls);
    runPresentation("phase:updateStationPanel", updateStationPanel);
    runPresentation("phase:updateScoreboardStatus", updateScoreboardStatus);
    return;
  }

  runPresentation("phase:hideMenuScreens", lobbyUi.hideMenuScreens);
  runPresentation("phase:clearMatchPanels", lobbyUi.clearMatchPanels);
  // Lobby -> design deliberately leaves the designer open: a player building in
  // the lobby is doing the very thing the design phase asks for, and closing it
  // under them would discard the context they were working in.
  if (nextPhase !== "design") {
    runPresentation("phase:closeBlueprintDesigner", closeBlueprintDesigner);
  }
  runPresentation("phase:updateDeploymentControls", purchaseUi.updateDeploymentControls);
  runPresentation("phase:updateRallyUi", updateRallyUi);
  runPresentation("phase:updateSelectionCommandUi", updateSelectionCommandUi);
  // Any phase move out of the match invalidates the inspected station.
  runPresentation("phase:updateStationPanel", updateStationPanel);
  runPresentation("phase:updateScoreboardStatus", updateScoreboardStatus);

  if (nextPhase === "active") {
    runPresentation("phase:updateRelayStatus", updateRelayStatus);
    runPresentation("phase:updateControlVictoryStatus", updateControlVictoryStatus);
    runPresentation("phase:updateScoreboardStatus", updateScoreboardStatus);
    if (state.mine?.rallyPoint) runPresentation("phase:centerCameraOnRally", () => centerCameraOnPoint(state.mine.rallyPoint, 0.35));
    return;
  }

  if (nextPhase === "ended") {
    runPresentation("phase:updateWinnerStatus", updateWinnerStatus);
    runPresentation("phase:updateRelayStatus", updateRelayStatus);
    runPresentation("phase:updateControlVictoryStatus", updateControlVictoryStatus);
    runPresentation("phase:updateScoreboardStatus", updateScoreboardStatus);
    return;
  }
}

// Records the backend's protocol/build identification and reports skew. The
// frontend (e.g. Netlify) and the WebSocket backend deploy separately, so a
// stale backend is a real failure mode: it must be called out instead of being
// silently masked by client fallbacks. Differing build SHAs alone never block
// play : only an actually incompatible (newer-than-supported) protocol is
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
        `angles require v${anglesMin}). Turret verification cannot be claimed against this backend : the ` +
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
    notify.error("Game balance is out of date : refresh the page (or redeploy the server) before playing.", { key: "balance-mismatch", keyTtl: 15000 });
  } else if (balanceCompatibility === "ok") {
    balanceMismatchReported = false;
  }
  const previous = state.server;
  if (previous && previous.protocolVersion === info.protocolVersion && previous.buildSha === info.buildSha && previous.balanceRevision === info.balanceRevision) {
    return previous.compatibility;
  }
  info.compatibility = checkServerProtocol(info);
  state.server = info;
  invalidatePresentation("purchase-catalogue");
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
  return /^(Ready confirmed :|Design saved : you are ready|Editor blueprint saved\.)/i.test(text);
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
      notify.error("Server protocol is newer than this client build : refresh the page.", { key: "protocol-mismatch", keyTtl: 15000 });
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
    state.pendingMovementToggles.clear();
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
    invalidatePresentation("selection");
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
    const previousSnapshot = state.snapshot;
    const previousIndex = state.snapshotIndex;
    const previousLocalState = captureLocalPresentationState(state);
    const mergeStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const result = mergeSnapshotTransaction(state.snapshot, state.snapshotNetwork, message, state?.renderHistory?.renderSimulationTimeMs);
    recordNetworkEvent("snapshotMerge", { durationMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - mergeStartedAt });
    if (!result.ok) {
      const wireReason = mapSnapshotRejectionToResyncReason(result.reason);
      recordNetworkEvent("snapshotRejected", { reason: result.reason, wireReason });
      if (!["stale-sequence", "duplicate-sequence"].includes(result.reason)) {
        requestFullState(result.reason);
      }
      return;
    }
    state.snapshotNetwork = { ...result.networkState, resyncing: false, lastResyncRequestAt: state.snapshotNetwork?.lastResyncRequestAt || 0 };
    state.snapshotReceivedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    snapshotDiagnostics.snapshotAcceptedCount += 1;
    snapshotDiagnostics.latest.snapshotSeq = state.snapshotNetwork.snapshotSeq;

    const accepted = result.snapshot;
    const nextIndex = buildSnapshotIndex(accepted, state.myId, state.selectedShipIds);

    // Apply authoritative state unconditionally before any optional presentation work.
    state.snapshot = accepted;
    state.snapshotIndex = nextIndex;
    state.mine = nextIndex.playerById.get(state.myId) || null;
    state.room = accepted.room ?? state.room;
    state.world = accepted.world ?? state.world;
    state.map = accepted.map ?? state.map;
    state.phase = accepted.phase ?? state.phase;
    state.adminId = accepted.adminId ?? state.adminId;
    state.rules = { ...state.rules, ...(accepted.rules || {}) };
    if (state.phase === "design" && state.pendingStartDesign) state.pendingStartDesign = false;
    if (state.pendingDeploy && state.mine?.ready) state.pendingDeploy = false;
    pruneSelection({ invalidate: false });

    recordNetworkEvent("acceptedSnapshot", { stateEpoch: state.snapshotNetwork.stateEpoch, snapshotSeq: state.snapshotNetwork.snapshotSeq, snapshotKind: message.snapshotKind || null });
    const phaseChanged = previousPhase !== state.phase;
    snapshotDiagnostics.latest.previousPhase = previousPhase;
    snapshotDiagnostics.latest.acceptedPhase = accepted.phase ?? previousPhase;
    snapshotDiagnostics.latest.statePhase = state.phase;
    snapshotDiagnostics.latest.phaseChanged = phaseChanged;
    if (phaseChanged) snapshotDiagnostics.phaseTransitionCount += 1;

    // Renderer authority and presentation-side damage history are isolated from
    // semantic comparators: neither can prevent accepted state from being stored.
    runPresentation("acceptSnapshotForRender", () => acceptSnapshotForRender(accepted, state.snapshotReceivedAt));
    runPresentation("recordComponentHpChanges", () => {
      const oldShips = previousIndex?.shipById || new Map();
      for (const newShip of accepted.ships || []) {
        const oldShip = oldShips.get(newShip.id);
        const hpChanged = oldShip && newShip.componentDamageRevision !== oldShip.componentDamageRevision;
        const hasDelta = Boolean(newShip.chpD?.length);
        if ((hpChanged || hasDelta) && newShip.chp) {
          recordComponentHpChanges(newShip, oldShip?.chp || newShip.chp, newShip.chp);
        }
      }
    });
    runPresentation("reconcilePendingPurchasesWithSnapshot", purchaseUi.reconcilePendingPurchasesWithSnapshot);
    synchronizeTelemetryFocus();

    const nextLocalState = captureLocalPresentationState(state);
    let changes;
    try {
      if (state.presentationTestHooks?.throwOnComparator) throw new Error("forced presentation comparator failure");
      changes = derivePresentationChanges({
        previousSnapshot,
        nextSnapshot: accepted,
        previousIndex,
        nextIndex,
        previousLocalState,
        nextLocalState,
        myId: state.myId
      });
    } catch (e) {
      snapshotDiagnostics.presentationErrorCount += 1;
      snapshotDiagnostics.snapshotPresentationErrorCount += 1;
      console.error("[mfa] derivePresentationChanges failed:", e);
      changes = allPresentationChanges(previousPhase, state.phase);
    }
    // The joined packet may establish the phase before the first authoritative
    // snapshot. Presentation phase ownership compares the applied client phase,
    // so initial lobby domains are not accidentally suppressed as a transition.
    changes.phase.previous = previousPhase;
    changes.phase.next = state.phase;
    changes.phase.changed = phaseChanged;
    state.snapshotChangeSummary = changes;

    // Optional domains are isolated from each other. Critical phase
    // synchronization always runs afterwards, even if a comparator/updater fails.
    dispatchPresentationChanges(changes);
    if (phaseChanged) {
      synchronizePhasePresentation(previousPhase, state.phase);
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
    return;
  }

  if (message.type === "combatStyleResult") {
    onCombatStyleResult(message);
    return;
  }

  if (message.type === "orbitDirectionResult") {
    onOrbitDirectionResult(message);
    return;
  }

  if (message.type === "movementTogglesResult") {
    onMovementTogglesResult(message);
    return;
  }

  if (message.type === "pong") {
    if (message.at) {
      state.latency = performance.now() - message.at;
      state.lastPongAt = performance.now();
      invalidatePresentation("latency");
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
    state.pendingMovementToggles.clear();
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
