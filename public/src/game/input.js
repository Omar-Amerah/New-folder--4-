// Manages keyboard keys, wheel zooms, pointer drag selects, canvas selections, and order trigger bindings.

import { dom } from "../ui/dom.js";
import { state } from "../state.js";
import { clampCameraToWorld, minimapWorldAt, screenToWorld, zoomCameraAtScreenPoint, resetCameraZoomToFit, centerCameraOnShips, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM } from "./camera.js";
import { selectAt, selectBox, selectAllOwnShips, ownLiveShips } from "./selection.js";
import { rotateFocusedPart, flipFocusedPart, undoBlueprintEdit } from "../ui/designerUi.js";
import { canUndoBlueprintEdit } from "../design/blueprintEditHistory.js";
import { closeConfirmModal } from "../ui/savedBlueprintsUi.js";
import { closeLedger } from "../ledger/fleetLedgerUi.js";
import { setRallyPointFromWorld } from "../ui/sidePanelUi.js";
import { invalidatePresentation } from "../presentationInvalidation.js";
import { issueCommand, destructSelectedShips, stopSelectedShips, rotateSelectedShips, releaseAllRotatingShips } from "./commands.js";
import { getMobileTestingModeEnabled } from "./renderSettings.js";

let binding = null; let bindingGeneration = 0;
let pendingZoomIntent = 0;
let pendingZoomPoint = null;
export function inputDiagnostics() { return { bindingGeneration, bound: !!binding, canvasMatches: binding?.canvas === dom.canvas, activePointerGesture: state.drag ? "select" : state.camDrag ? "pan" : null, pendingZoom: pendingZoomIntent !== 0 }; }
export function consumePendingZoom() {
  if (pendingZoomIntent === 0 || pendingZoomPoint === null) return false;
  const intent = clampNumber(pendingZoomIntent, -6, 6);
  const preZoom = state.camera.zoom;
  const targetZoom = clampNumber(preZoom * Math.exp(intent * 0.13), CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM);
  if (Math.abs(targetZoom - preZoom) < 1e-9) {
    pendingZoomIntent = 0;
    pendingZoomPoint = null;
    return false;
  }
  const point = pendingZoomPoint;
  pendingZoomIntent = 0;
  pendingZoomPoint = null;
  Object.assign(state.camera, zoomCameraAtScreenPoint(state.camera, point, intent));
  state.camera.follow = false;
  state.camera.panTarget = null;
  return true;
}
function eventIsOnCanvas(event) { return !!binding && event.currentTarget === binding.canvas && event.target === binding.canvas; }
function releaseCapture(canvas, id) { try { if (canvas?.hasPointerCapture?.(id)) canvas.releasePointerCapture(id); } catch {} }
export function cancelArenaPointerState(reason = "cancel") { if (binding) { releaseCapture(binding.canvas, state.drag?.pointerId); releaseCapture(binding.canvas, state.camDrag?.pointerId); } state.drag = null; state.camDrag = null; state.pointerCancelledAt = performance.now?.() || Date.now(); state.pointerCancelReason = reason; }
function cancelKeyboardState() { releaseAllRotatingShips(); state.keys.delete("o"); state.keys.delete("i"); }

export function handlePointerDown(event) {
  if (!eventIsOnCanvas(event) || !state.snapshot) return;
  binding.canvas.setPointerCapture?.(event.pointerId); state.pointer = { x: event.clientX, y: event.clientY };
  if (event.button === 2) { event.preventDefault(); issueCommand(event); return; }
  const isPanButton = event.button === 1 || (event.button === 0 && state.keys.has(" "));
  if (isPanButton) { event.preventDefault(); state.camDrag = { pointerId: event.pointerId, startCameraX: state.camera.x, startCameraY: state.camera.y, startClientX: event.clientX, startClientY: event.clientY, canvas: binding.canvas }; state.camera.follow = false; state.camera.panTarget = null; return; }
  if (event.button !== 0) return;
  const mini = minimapWorldAt(event.clientX, event.clientY);
  if (state.settingRallyPoint) { event.preventDefault(); setRallyPointFromWorld(mini || screenToWorld(event.clientX, event.clientY)); return; }
  if (mini) { state.camera.x = mini.x; state.camera.y = mini.y; state.camera.follow = false; state.camera.panTarget = null; Object.assign(state.camera, clampCameraToWorld(state.camera)); return; }
  if (getMobileTestingModeEnabled()) { state.camDrag = { pointerId: event.pointerId, startCameraX: state.camera.x, startCameraY: state.camera.y, startClientX: event.clientX, startClientY: event.clientY, commandOnTap: true, canvas: binding.canvas }; state.camera.follow = false; state.camera.panTarget = null; return; }
  state.drag = { pointerId: event.pointerId, canvas: binding.canvas, startClientX: event.clientX, startClientY: event.clientY, currentClientX: event.clientX, currentClientY: event.clientY, startWorld: screenToWorld(event.clientX, event.clientY), currentWorld: screenToWorld(event.clientX, event.clientY), shift: event.shiftKey };
}
export function handlePointerMove(event) {
  if (!eventIsOnCanvas(event)) return; state.pointer = { x: event.clientX, y: event.clientY };
  if (state.camDrag && state.camDrag.pointerId === event.pointerId && state.camDrag.canvas === binding.canvas) { event.preventDefault(); const dx = (event.clientX - state.camDrag.startClientX) / state.camera.zoom; const dy = (event.clientY - state.camDrag.startClientY) / state.camera.zoom; state.camera.x = state.camDrag.startCameraX - dx; state.camera.y = state.camDrag.startCameraY - dy; state.camera.panTarget = null; Object.assign(state.camera, clampCameraToWorld(state.camera)); return; }
  if (!state.drag || state.drag.pointerId !== event.pointerId || state.drag.canvas !== binding.canvas) return;
  state.drag.currentClientX = event.clientX; state.drag.currentClientY = event.clientY; state.drag.currentWorld = screenToWorld(event.clientX, event.clientY);
}
export function handlePointerUp(event) {
  if (!eventIsOnCanvas(event)) return;
  if (state.camDrag && state.camDrag.pointerId === event.pointerId && state.camDrag.canvas === binding.canvas) { event.preventDefault(); const camDrag = state.camDrag; state.camDrag = null; releaseCapture(binding.canvas, event.pointerId); if (camDrag.commandOnTap && Math.hypot(event.clientX - camDrag.startClientX, event.clientY - camDrag.startClientY) < 10) issueCommand(event); return; }
  if (!state.drag || state.drag.pointerId !== event.pointerId || state.drag.canvas !== binding.canvas) return;
  const drag = state.drag; state.drag = null; releaseCapture(binding.canvas, event.pointerId);
  if (Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY) < 6) selectAt(drag.currentWorld, drag.shift); else selectBox(drag.startWorld, drag.currentWorld, drag.shift);
}
function handlePointerCancel(event) { if (state.drag?.pointerId === event.pointerId || state.camDrag?.pointerId === event.pointerId) cancelArenaPointerState(event.type); }
export function handleWheel(event) {
  if (!eventIsOnCanvas(event)) return; event.preventDefault(); event.stopPropagation();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1; const intent = clampNumber(-event.deltaY * unit / 120, -4, 4);
  pendingZoomIntent += intent;
  pendingZoomPoint = { x: event.clientX, y: event.clientY };
}
function clampNumber(v, lo, hi) { return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0)); }
export function eventComesFromEditableControl(event) {
  const target = event.target || document.activeElement;
  return Boolean(target?.isContentEditable
    || target?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}
export function handleKeyDown(event) {
  if (event.key === "Escape" && dom.confirmModal && !dom.confirmModal.hidden) { event.preventDefault(); closeConfirmModal(); return; }
  if (event.key === "Escape" && dom.ledgerOverlay && !dom.ledgerOverlay.hidden) { event.preventDefault(); closeLedger(); return; }
  if (event.repeat) return;
  const key = event.key.toLowerCase();
  const designerOpen = dom.blueprintDesignerScreen && !dom.blueprintDesignerScreen.hidden;
  if (designerOpen && key === "z" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !eventComesFromEditableControl(event)) {
    if (canUndoBlueprintEdit()) { event.preventDefault(); undoBlueprintEdit(); }
    return;
  }
  if (key === "escape" && state.settingRallyPoint) { event.preventDefault(); state.settingRallyPoint = false; invalidatePresentation("rally-mode"); return; }
  if (eventComesFromEditableControl(event)) return;
  state.keys.add(key);
  if (key === "r") { event.preventDefault(); rotateFocusedPart(); return; }
  // F mirrors the focused/pending component while the designer is open, and
  // stays the arena's camera-follow key everywhere else. Non-flippable parts
  // simply do nothing.
  if (key === "f" && designerOpen) { event.preventDefault(); flipFocusedPart(); return; }
  if (key === "o") { event.preventDefault(); rotateSelectedShips(1, true); return; }
  if (key === "i") { event.preventDefault(); rotateSelectedShips(-1, true); return; }
  if (["arrowup","arrowdown","arrowleft","arrowright"," "].includes(key)) event.preventDefault();
  if (key === "q") { event.preventDefault(); selectAllOwnShips(); } else if (key === "f") { event.preventDefault(); state.camera.follow = true; } else if (key === "escape") { state.selectedShipIds.clear(); state.activeShipGroup = null; cancelArenaPointerState("escape"); invalidatePresentation("selection"); } else if (key === "0") { event.preventDefault(); resetCameraZoomToFit(); } else if (key === "c") { event.preventDefault(); const ships = state.snapshotIndex?.selectedLivingShips?.length ? state.snapshotIndex.selectedLivingShips : ownLiveShips(); centerCameraOnShips(ships); } else if (key === "v") { event.preventDefault(); state.componentDamageView = !state.componentDamageView; invalidatePresentation("panel-mode"); } else if (key === "delete" || key === "backspace") { event.preventDefault(); destructSelectedShips(); } else if (key === "b") { event.preventDefault(); stopSelectedShips(); }
}
export function bindArenaPointerListeners(canvasEl) {
  if (!canvasEl) return () => {}; if (binding?.canvas === canvasEl) return binding.unbind; if (binding) binding.unbind(); const canvas = canvasEl; bindingGeneration += 1;
  const contextmenu = (event) => { if (event.currentTarget === canvas) event.preventDefault(); };
  const blur = () => { cancelArenaPointerState("blur"); cancelKeyboardState(); }; const vis = () => { if (document.visibilityState === "hidden") { cancelArenaPointerState("hidden"); cancelKeyboardState(); } };
  canvas.addEventListener("pointerdown", handlePointerDown); canvas.addEventListener("pointermove", handlePointerMove); canvas.addEventListener("pointerup", handlePointerUp); canvas.addEventListener("pointercancel", handlePointerCancel); canvas.addEventListener("lostpointercapture", handlePointerCancel); canvas.addEventListener("wheel", handleWheel, { passive: false }); canvas.addEventListener("contextmenu", contextmenu); window.addEventListener("blur", blur); document.addEventListener("visibilitychange", vis);
  const unbind = () => { if (binding?.canvas !== canvas) return; cancelArenaPointerState("unbind"); cancelKeyboardState(); canvas.removeEventListener("pointerdown", handlePointerDown); canvas.removeEventListener("pointermove", handlePointerMove); canvas.removeEventListener("pointerup", handlePointerUp); canvas.removeEventListener("pointercancel", handlePointerCancel); canvas.removeEventListener("lostpointercapture", handlePointerCancel); canvas.removeEventListener("wheel", handleWheel); canvas.removeEventListener("contextmenu", contextmenu); window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", vis); binding = null; };
  binding = { canvas, unbind }; return unbind;
}
export function handleKeyUp(event) {
  const key = event.key.toLowerCase();
  if (key === "o" || key === "i") {
    const otherKey = key === "o" ? "i" : "o";
    if (state.keys.has(otherKey)) {
      const direction = otherKey === "o" ? 1 : -1;
      rotateSelectedShips(direction, true);
    } else {
      rotateSelectedShips(key === "o" ? 1 : -1, false);
    }
  }
  state.keys.delete(key);
}

export function unbindArenaPointerListeners() { if (binding) binding.unbind(); }
