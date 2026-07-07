// Manages keyboard keys, wheel zooms, pointer drag selects, canvas selections, and order trigger bindings.

import { dom } from "../ui/dom.js";
import { state } from "../state.js";
import { clamp } from "../shared/math.js";
import { minimapWorldAt, screenToWorld } from "./camera.js";
import { selectAt, selectBox, selectAllOwnShips } from "./selection.js";
import { rotateFocusedPart } from "../ui/designerUi.js";
import { closeConfirmModal } from "../ui/savedBlueprintsUi.js";
import { updateHud } from "../ui/hudUi.js";
import { issueCommand } from "./commands.js";

export function handlePointerDown(event) {
  if (!state.snapshot) return;
  dom.canvas.setPointerCapture(event.pointerId);
  state.pointer = { x: event.clientX, y: event.clientY };

  if (event.button === 2) {
    event.preventDefault();
    issueCommand(event);
    return;
  }

  if (event.button !== 0) return;

  const mini = minimapWorldAt(event.clientX, event.clientY);
  if (mini) {
    state.camera.x = mini.x;
    state.camera.y = mini.y;
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
  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  state.drag.currentClientX = event.clientX;
  state.drag.currentClientY = event.clientY;
  state.drag.currentWorld = screenToWorld(event.clientX, event.clientY);
}

export function handlePointerUp(event) {
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
  if (key === "r" && tag !== "INPUT" && tag !== "SELECT") {
    event.preventDefault();
    rotateFocusedPart();
    return;
  }
  if (tag === "INPUT" || tag === "SELECT" || tag === "BUTTON") return;
  state.keys.add(key);

  if (key === "q") {
    event.preventDefault();
    selectAllOwnShips();
  } else if (key === "f") {
    event.preventDefault();
    state.camera.follow = true;
  } else if (key === "escape") {
    state.selectedShipIds.clear();
    updateHud();
  }
}
