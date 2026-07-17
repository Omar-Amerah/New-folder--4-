// Manages keyboard keys, wheel zooms, pointer drag selects, canvas selections, and order trigger bindings.

import { dom } from "../ui/dom.js";
import { state } from "../state.js";
import { clampCameraToWorld, minimapWorldAt, screenToWorld, zoomCameraAtScreenPoint, resetCameraZoomToFit, centerCameraOnShips } from "./camera.js";
import { selectAt, selectBox, selectAllOwnShips, ownLiveShips } from "./selection.js";
import { rotateFocusedPart } from "../ui/designerUi.js";
import { closeConfirmModal } from "../ui/savedBlueprintsUi.js";
import { updateHud } from "../ui/hudUi.js";
import { renderSideControls, setRallyPointFromWorld } from "../ui/sidePanelUi.js";
import { showToast } from "../ui/toastUi.js";
import { issueCommand, destructSelectedShips } from "./commands.js";
import { getMobileTestingModeEnabled } from "./renderSettings.js";

let binding = null; let bindingGeneration = 0;
export function inputDiagnostics() { return { bindingGeneration, bound: !!binding, canvasMatches: binding?.canvas === dom.canvas, activePointerGesture: state.drag ? "select" : state.camDrag ? "pan" : null }; }
function eventIsOnCanvas(event) { return !!binding && event.currentTarget === binding.canvas && event.target === binding.canvas; }
function releaseCapture(canvas, id) { try { if (canvas?.hasPointerCapture?.(id)) canvas.releasePointerCapture(id); } catch {} }
export function cancelArenaPointerState(reason = "cancel") { if (binding) { releaseCapture(binding.canvas, state.drag?.pointerId); releaseCapture(binding.canvas, state.camDrag?.pointerId); } state.drag = null; state.camDrag = null; state.pointerCancelledAt = performance.now?.() || Date.now(); state.pointerCancelReason = reason; }

export function handlePointerDown(event) {
  if (!eventIsOnCanvas(event) || !state.snapshot) return;
  binding.canvas.setPointerCapture?.(event.pointerId); state.pointer = { x: event.clientX, y: event.clientY };
  if (event.button === 2) { event.preventDefault(); issueCommand(event); return; }
  const isPanButton = event.button === 1 || (event.button === 0 && state.keys.has(" "));
  if (isPanButton) { event.preventDefault(); state.camDrag = { pointerId: event.pointerId, startCameraX: state.camera.x, startCameraY: state.camera.y, startClientX: event.clientX, startClientY: event.clientY, canvas: binding.canvas }; state.camera.follow = false; return; }
  if (event.button !== 0) return;
  const mini = minimapWorldAt(event.clientX, event.clientY);
  if (state.settingRallyPoint) { event.preventDefault(); setRallyPointFromWorld(mini || screenToWorld(event.clientX, event.clientY)); return; }
  if (mini) { state.camera.x = mini.x; state.camera.y = mini.y; state.camera.follow = false; Object.assign(state.camera, clampCameraToWorld(state.camera)); return; }
  if (getMobileTestingModeEnabled()) { state.camDrag = { pointerId: event.pointerId, startCameraX: state.camera.x, startCameraY: state.camera.y, startClientX: event.clientX, startClientY: event.clientY, commandOnTap: true, canvas: binding.canvas }; state.camera.follow = false; return; }
  state.drag = { pointerId: event.pointerId, canvas: binding.canvas, startClientX: event.clientX, startClientY: event.clientY, currentClientX: event.clientX, currentClientY: event.clientY, startWorld: screenToWorld(event.clientX, event.clientY), currentWorld: screenToWorld(event.clientX, event.clientY), shift: event.shiftKey };
}
export function handlePointerMove(event) {
  if (!eventIsOnCanvas(event)) return; state.pointer = { x: event.clientX, y: event.clientY };
  if (state.camDrag && state.camDrag.pointerId === event.pointerId && state.camDrag.canvas === binding.canvas) { event.preventDefault(); const dx = (event.clientX - state.camDrag.startClientX) / state.camera.zoom; const dy = (event.clientY - state.camDrag.startClientY) / state.camera.zoom; state.camera.x = state.camDrag.startCameraX - dx; state.camera.y = state.camDrag.startCameraY - dy; Object.assign(state.camera, clampCameraToWorld(state.camera)); return; }
  if (!state.drag || state.drag.pointerId !== event.pointerId || state.drag.canvas !== binding.canvas) return;
  state.drag.currentClientX = event.clientX; state.drag.currentClientY = event.clientY; state.drag.currentWorld = screenToWorld(event.clientX, event.clientY);
}
export function handlePointerUp(event) {
  if (!eventIsOnCanvas(event)) return;
  if (state.camDrag && state.camDrag.pointerId === event.pointerId && state.camDrag.canvas === binding.canvas) { event.preventDefault(); const camDrag = state.camDrag; state.camDrag = null; releaseCapture(binding.canvas, event.pointerId); if (camDrag.commandOnTap && Math.hypot(event.clientX - camDrag.startClientX, event.clientY - camDrag.startClientY) < 10) issueCommand(event); return; }
  if (!state.drag || state.drag.pointerId !== event.pointerId || state.drag.canvas !== binding.canvas) return;
  const drag = state.drag; state.drag = null; releaseCapture(binding.canvas, event.pointerId);
  if (Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY) < 6) selectAt(drag.currentWorld, drag.shift); else selectBox(drag.startWorld, drag.currentWorld, drag.shift);
  updateHud(); renderSideControls();
}
function handlePointerCancel(event) { if (state.drag?.pointerId === event.pointerId || state.camDrag?.pointerId === event.pointerId) cancelArenaPointerState(event.type); }
export function handleWheel(event) {
  if (!eventIsOnCanvas(event)) return; event.preventDefault(); event.stopPropagation();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1; const intent = clampNumber(-event.deltaY * unit / 120, -4, 4);
  Object.assign(state.camera, zoomCameraAtScreenPoint(state.camera, { x: event.clientX, y: event.clientY }, intent)); state.camera.follow = false;
}
function clampNumber(v, lo, hi) { return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0)); }
export function eventComesFromEditableControl(event) {
  const target = event.target || document.activeElement;
  return Boolean(target?.isContentEditable
    || target?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}
export function handleKeyDown(event) {
  if (event.key === "Escape" && dom.confirmModal && !dom.confirmModal.hidden) { event.preventDefault(); closeConfirmModal(); return; }
  if (event.repeat) return;
  const key = event.key.toLowerCase();
  if (key === "escape" && state.settingRallyPoint) { event.preventDefault(); state.settingRallyPoint = false; renderSideControls(); return; }
  if (eventComesFromEditableControl(event)) return;
  if (key === "r") { event.preventDefault(); rotateFocusedPart(); return; }
  state.keys.add(key);
  if (["arrowup","arrowdown","arrowleft","arrowright"," "].includes(key)) event.preventDefault();
  if (key === "q") { event.preventDefault(); selectAllOwnShips(); renderSideControls(); } else if (key === "f") { event.preventDefault(); state.camera.follow = true; } else if (key === "escape") { state.selectedShipIds.clear(); state.activeShipGroup = null; cancelArenaPointerState("escape"); updateHud(); renderSideControls(); } else if (key === "0") { event.preventDefault(); resetCameraZoomToFit(); } else if (key === "c") { event.preventDefault(); const ships = [...state.selectedShipIds].length ? (state.snapshot?.ships || []).filter(s => state.selectedShipIds.has(s.id)) : ownLiveShips(); centerCameraOnShips(ships); } else if (key === "v") { event.preventDefault(); state.componentDamageView = !state.componentDamageView; showToast(`Component damage view ${state.componentDamageView ? "on" : "off"}`, "good"); renderSideControls(); } else if (key === "delete" || key === "backspace") { event.preventDefault(); destructSelectedShips(); }
}
export function bindArenaPointerListeners(canvasEl) {
  if (!canvasEl) return () => {}; if (binding?.canvas === canvasEl) return binding.unbind; if (binding) binding.unbind(); const canvas = canvasEl; bindingGeneration += 1;
  const contextmenu = (event) => { if (event.currentTarget === canvas) event.preventDefault(); };
  const blur = () => cancelArenaPointerState("blur"); const vis = () => { if (document.visibilityState === "hidden") cancelArenaPointerState("hidden"); };
  canvas.addEventListener("pointerdown", handlePointerDown); canvas.addEventListener("pointermove", handlePointerMove); canvas.addEventListener("pointerup", handlePointerUp); canvas.addEventListener("pointercancel", handlePointerCancel); canvas.addEventListener("lostpointercapture", handlePointerCancel); canvas.addEventListener("wheel", handleWheel, { passive: false }); canvas.addEventListener("contextmenu", contextmenu); window.addEventListener("blur", blur); document.addEventListener("visibilitychange", vis);
  const unbind = () => { if (binding?.canvas !== canvas) return; cancelArenaPointerState("unbind"); canvas.removeEventListener("pointerdown", handlePointerDown); canvas.removeEventListener("pointermove", handlePointerMove); canvas.removeEventListener("pointerup", handlePointerUp); canvas.removeEventListener("pointercancel", handlePointerCancel); canvas.removeEventListener("lostpointercapture", handlePointerCancel); canvas.removeEventListener("wheel", handleWheel); canvas.removeEventListener("contextmenu", contextmenu); window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", vis); binding = null; };
  binding = { canvas, unbind }; return unbind;
}
export function unbindArenaPointerListeners() { if (binding) binding.unbind(); }
