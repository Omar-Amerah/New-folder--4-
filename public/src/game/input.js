// Manages keyboard keys, wheel zooms, pointer drag selects, canvas selections, and order trigger bindings.

import { dom } from "../ui/dom.js";
import { state } from "../state.js";
import { clamp } from "../shared/math.js";
import { minimapWorldAt, screenToWorld } from "./camera.js";
import { selectAt, selectBox, selectAllOwnShips } from "./selection.js";
import { rotateFocusedPart } from "../ui/designerUi.js";
import { closeConfirmModal } from "../ui/savedBlueprintsUi.js";
import { updateHud } from "../ui/hudUi.js";
import { renderSideControls, setRallyPointFromWorld } from "../ui/sidePanelUi.js";
import { showToast } from "../ui/toastUi.js";
import { issueCommand, destructSelectedShips } from "./commands.js";
import { getMobileTestingModeEnabled } from "./renderSettings.js";

export function handlePointerDown(event) {
  if (!state.snapshot) return;
  dom.canvas.setPointerCapture(event.pointerId);
  state.pointer = { x: event.clientX, y: event.clientY };

  if (event.button === 2) {
    event.preventDefault();
    issueCommand(event);
    return;
  }

  // Camera panning using Middle Mouse Button (1) or Spacebar + Left Mouse Button (0)
  const isPanButton = event.button === 1 || (event.button === 0 && state.keys.has(" "));
  if (isPanButton) {
    event.preventDefault();
    state.camDrag = {
      pointerId: event.pointerId,
      startCameraX: state.camera.x,
      startCameraY: state.camera.y,
      startClientX: event.clientX,
      startClientY: event.clientY
    };
    state.camera.follow = false;
    return;
  }

  if (event.button !== 0) return;

  const mobileTestingMode = getMobileTestingModeEnabled();
  const mini = minimapWorldAt(event.clientX, event.clientY);
  if (state.settingRallyPoint) {
    event.preventDefault();
    setRallyPointFromWorld(mini || screenToWorld(event.clientX, event.clientY));
    return;
  }

  if (mini) {
    state.camera.x = mini.x;
    state.camera.y = mini.y;
    state.camera.follow = false;
    return;
  }

  if (mobileTestingMode) {
    state.camDrag = {
      pointerId: event.pointerId,
      startCameraX: state.camera.x,
      startCameraY: state.camera.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
      commandOnTap: true
    };
    state.camera.follow = false;
    return;
  }

  state.drag = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    currentClientX: event.clientX,
    currentClientY: event.clientY,
    startWorld: screenToWorld(event.clientX, event.clientY),
    currentWorld: screenToWorld(event.clientX, event.clientY),
    shift: event.shiftKey
  };
}

export function handlePointerMove(event) {
  state.pointer = { x: event.clientX, y: event.clientY };

  // Handle active camera panning
  if (state.camDrag && state.camDrag.pointerId === event.pointerId) {
    event.preventDefault();
    const dx = (event.clientX - state.camDrag.startClientX) / state.camera.zoom;
    const dy = (event.clientY - state.camDrag.startClientY) / state.camera.zoom;
    state.camera.x = clamp(state.camDrag.startCameraX - dx, 0, state.world?.width || 2000);
    state.camera.y = clamp(state.camDrag.startCameraY - dy, 0, state.world?.height || 2000);
    return;
  }

  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  state.drag.currentClientX = event.clientX;
  state.drag.currentClientY = event.clientY;
  state.drag.currentWorld = screenToWorld(event.clientX, event.clientY);
}

export function handlePointerUp(event) {
  if (state.camDrag && state.camDrag.pointerId === event.pointerId) {
    event.preventDefault();
    const camDrag = state.camDrag;
    state.camDrag = null;
    const distance = Math.hypot(event.clientX - camDrag.startClientX, event.clientY - camDrag.startClientY);
    if (camDrag.commandOnTap && distance < 10) {
      issueCommand(event);
    }
    return;
  }

  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  const drag = state.drag;
  state.drag = null;

  const distance = Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY);
  if (distance < 6) {
    selectAt(drag.currentWorld, drag.shift);
  } else {
    selectBox(drag.startWorld, drag.currentWorld, drag.shift);
  }
  updateHud();
  renderSideControls();
}

export function handleWheel(event) {
  event.preventDefault();
  const before = screenToWorld(event.clientX, event.clientY);
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  state.camera.manualZoom = clamp((state.camera.manualZoom || state.camera.zoom) * factor, 0.32, 1.45);
  state.camera.zoom = state.camera.manualZoom;
  const after = screenToWorld(event.clientX, event.clientY);
  state.camera.x += before.x - after.x;
  state.camera.y += before.y - after.y;
  state.camera.follow = false;
}

export function handleKeyDown(event) {
  if (event.key === "Escape" && dom.confirmModal && !dom.confirmModal.hidden) {
    event.preventDefault();
    closeConfirmModal();
    return;
  }
  const key = event.key.toLowerCase();
  const tag = document.activeElement?.tagName;
  if (key === "escape" && state.settingRallyPoint) {
    event.preventDefault();
    state.settingRallyPoint = false;
    renderSideControls();
    return;
  }
  if (key === "r" && tag !== "INPUT" && tag !== "SELECT") {
    event.preventDefault();
    rotateFocusedPart();
    return;
  }
  if (tag === "INPUT" || tag === "SELECT") return;
  state.keys.add(key);

  if (
    key === "arrowup" ||
    key === "arrowdown" ||
    key === "arrowleft" ||
    key === "arrowright" ||
    key === " "
  ) {
    event.preventDefault();
  }

  if (key === "q") {
    event.preventDefault();
    selectAllOwnShips();
    renderSideControls();
  } else if (key === "f") {
    event.preventDefault();
    state.camera.follow = true;
  } else if (key === "escape") {
    state.selectedShipIds.clear();
    state.activeShipGroup = null;
    updateHud();
    renderSideControls();
  } else if (key === "delete" || key === "backspace") {
    event.preventDefault();
    destructSelectedShips();
  } else if (key === "v") {
    // Client-only Component Damage View: stronger status tints on all ships.
    event.preventDefault();
    state.componentDamageView = !state.componentDamageView;
    showToast(`Component damage view ${state.componentDamageView ? "on" : "off"}`, "good");
    renderSideControls();
  }
}

export function bindArenaPointerListeners(canvasEl) {
  canvasEl.addEventListener("pointerdown", handlePointerDown);
  canvasEl.addEventListener("pointermove", handlePointerMove);
  canvasEl.addEventListener("pointerup", handlePointerUp);
  canvasEl.addEventListener("wheel", handleWheel, { passive: false });
  canvasEl.addEventListener("contextmenu", (event) => event.preventDefault());
}
