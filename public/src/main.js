import { FALLBACK_PART_STATS, PART_STATS, LOCAL_NAME_KEY, LOCAL_TEAM_KEY, LOCAL_FORMATION_KEY } from "./constants.js";
import { dom, state, applyComponentBalance, applyServerParts, openMainMenu, sendRulesUpdate, bindKickButtonContainer } from "./ui/dom.js";
import { joinExistingGame } from "./ui/lobbyUi.js";
import { handlePurchasePointerDown, handlePurchasePointerUp, clearPurchasePointer, handlePurchaseKeyboardClick, setPurchaseQuantity, send, updateLobbyState, renderPalette, renderPartInspector, buildPartStatsFromBalance, normalizeRuntimeParts, renderBuildGrid, handleSavedDesignPointerDown, handleSavedDesignPointerUp, clearSavedDesignPointer, handleSavedDesignKeyboardClick, renderSavedDesigns, renderLocalStats, renderPurchaseBar } from "./ui/purchaseUi.js";
import { handlePointerDown, handlePointerMove, handlePointerUp, handleWheel, resizeCanvas, frame, teamValue, normalizeDesign } from "./ui/scoreboardUi.js";


export function initializeClient() {
  await loadComponentBalance();
  renderPalette();
  renderPartInspector();
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
  renderPurchaseBar();
  updateLobbyState();
  openMainMenu();
  resizeCanvas();
  requestAnimationFrame(frame);
}

async function loadComponentBalance() {
  if (typeof fetch !== "function") return;
  try {
    const response = await fetch("/component-balance.json", { cache: "no-store" });
    if (!response.ok) return;
    applyComponentBalance(await response.json());
  } catch {
    // Local file previews and older test harnesses can run without fetch; keep the bundled fallback.
  }
}

export function applyComponentBalance(balance) {
  const nextParts = buildPartStatsFromBalance(balance, FALLBACK_PART_STATS);
  if (!nextParts.core || !nextParts.frame) return;
  PART_STATS = nextParts;
  state.design = normalizeDesign(state.design);
}

export function applyServerParts(parts) {
  const nextParts = normalizeRuntimeParts(parts);
  if (!nextParts.core || !nextParts.frame) return;
  PART_STATS = nextParts;
  state.parts = nextParts;
  state.design = normalizeDesign(state.design);
  renderPalette();
  renderPartInspector();
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
  renderPurchaseBar();
}

dom.formationSelect.addEventListener("change", () => {
  localStorage.setItem(LOCAL_FORMATION_KEY, dom.formationSelect.value);
});
dom.teamSelect.addEventListener("change", () => {
  localStorage.setItem(LOCAL_TEAM_KEY, dom.teamSelect.value);
  send({ type: "setTeam", team: teamValue() });
});
dom.pilotName.addEventListener("change", () => {
  localStorage.setItem(LOCAL_NAME_KEY, dom.pilotName.value.trim());
  send({ type: "setName", name: dom.pilotName.value });
});
dom.roomCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinExistingGame();
});
dom.startingMoneyInput?.addEventListener("change", sendRulesUpdate);
dom.maxPlayersInput?.addEventListener("change", sendRulesUpdate);
dom.mapSizeSelect?.addEventListener("change", sendRulesUpdate);
dom.gameModeSelect?.addEventListener("change", sendRulesUpdate);
dom.purchaseQuantityOne?.addEventListener("click", () => setPurchaseQuantity(1));
dom.purchaseQuantityFive?.addEventListener("click", () => setPurchaseQuantity(5));
dom.purchaseOptions?.addEventListener("pointerdown", handlePurchasePointerDown);
dom.purchaseOptions?.addEventListener("pointerup", handlePurchasePointerUp);
dom.purchaseOptions?.addEventListener("pointercancel", clearPurchasePointer);
dom.purchaseOptions?.addEventListener("lostpointercapture", clearPurchasePointer);
dom.purchaseOptions?.addEventListener("click", handlePurchaseKeyboardClick);
dom.savedDesignList?.addEventListener("pointerdown", handleSavedDesignPointerDown);
dom.savedDesignList?.addEventListener("pointerup", handleSavedDesignPointerUp);
dom.savedDesignList?.addEventListener("pointercancel", clearSavedDesignPointer);
dom.savedDesignList?.addEventListener("lostpointercapture", clearSavedDesignPointer);
dom.savedDesignList?.addEventListener("click", handleSavedDesignKeyboardClick);
bindKickButtonContainer(dom.playerList);
bindKickButtonContainer(dom.scoreList);

dom.canvas.addEventListener("pointerdown", handlePointerDown);
dom.canvas.addEventListener("pointermove", handlePointerMove);
dom.canvas.addEventListener("pointerup", handlePointerUp);
dom.canvas.addEventListener("pointercancel", () => {
  state.drag = null;
});
dom.canvas.addEventListener("wheel", handleWheel, { passive: false });
dom.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

setInterval(() => {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.lastPingAt = performance.now();
  send({ type: "ping", at: state.lastPingAt });
}, 2000);