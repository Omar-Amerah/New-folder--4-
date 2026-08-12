import { dom } from "../dom.js";
import { state } from "../../state.js";
import { PART_STATS, isFlippablePart, isRotatablePart, partIconMarkup } from "../../design/parts.js";
import { createPlacementCandidate } from "../../design/placementCandidate.js";
import { normalizeRotation } from "../../design/rotation.js";
import { getFootprintBounds } from "../../design/footprint.js";
import { coolantConnectionMasks } from "../../design/coolantLayout.js";
import { calculateCenterOfMass } from "../../shared/movementStats.js";
import {
  findPartAt,
  positionGridCellRelativeOverlay,
  positionGridOverlay
} from "./layout.js";

export function isPhysicalBlueprintEditMode(mode = state.blueprintView) { return mode === "build" || mode === "heat"; }
export function isPaletteBlueprintEditMode(mode = state.blueprintView) { return mode === "build" || mode === "heat"; }
export function isBlueprintRotationMode(mode = state.blueprintView) { return isPhysicalBlueprintEditMode(mode); }
export function isBlueprintRemovalMode(mode = state.blueprintView) { return isPhysicalBlueprintEditMode(mode); }

function removePlacementPreviewElements() {
  for (const stale of dom.grid.querySelectorAll(".build-preview, .rotation-preview-badge, .engine-exhaust-preview, .engine-thrust-arrow, .maneuver-preview-plume, .maneuver-preview-weak")) {
    stale.remove();
  }
}

export function renderHoverPreview() {
  removePlacementPreviewElements();

  if (!isPhysicalBlueprintEditMode()) return;
  if (!state.hoveredCell || !state.selectedPart) return;

  {
    const selectedType = state.selectedPart;
    const candidate = createPlacementCandidate({
      grid: state.hoveredCell,
      componentType: selectedType,
      rotation: state.previewRotation || 0,
      flipped: state.previewFlipped === true,
      design: state.design,
      catalogue: PART_STATS
    });
    if (!candidate.part) return;
    const footprint = (PART_STATS[selectedType] || PART_STATS.frame).footprint || { width: 1, height: 1 };
    // The ghost is drawn from the candidate's own normalized transform, so what
    // is previewed is exactly what placement validated and will place.
    const bounds = getFootprintBounds(candidate.part.x, candidate.part.y, footprint, candidate.normalizedRotation, candidate.normalizedFlipped);

    const preview = document.createElement("div");
    preview.className = `build-preview ${candidate.ok ? "valid" : "invalid"}`;
    preview.title = candidate.message || "";
    // The ghost shows the pipe shape the placement would actually create, so a
    // player sees the coolant run join up before committing the click.
    const previewMask = coolantConnectionMasks(candidate.nextDesign, PART_STATS)[candidate.nextDesign.indexOf(candidate.part)] || 0;
    preview.innerHTML = partIconMarkup(selectedType, "preview-glyph", candidate.normalizedRotation, candidate.normalizedFlipped, previewMask);
    positionGridOverlay(preview, bounds.minX, bounds.minY, bounds.width, bounds.height);
    renderRotationPreviewBadge(candidate, preview);
    dom.grid.appendChild(preview);
    const candidateIndex = candidate.nextDesign.indexOf(candidate.part);
    const candidateStat = PART_STATS[selectedType] || {};
    if (selectedType === "maneuverThruster") {
      renderManeuverThrusterPreview(candidate.part, candidate.ok, candidate.nextDesign);
      renderEngineExhaustPreview(candidate.nextDesign, candidateIndex, candidate.ok);
    } else if (candidateStat.thrust > 0) renderEngineExhaustPreview(candidate.nextDesign, candidateIndex, candidate.ok);
  }
}

function renderRotationPreviewBadge(candidate, preview) {
  if (!candidate?.part || !isRotatablePart(candidate.part.type)) return;
  const badge = document.createElement("div");
  badge.className = `rotation-preview-badge ${candidate.ok ? "valid" : "invalid"}`;
  const mirrorMark = candidate.normalizedFlipped ? " ↔" : "";
  badge.textContent = `${normalizeRotation(candidate.normalizedRotation, PART_STATS[candidate.part.type]?.allowedRotations, candidate.part.x)}° ↻${mirrorMark}`;
  badge.setAttribute("aria-hidden", "true");
  preview.appendChild(badge);
}

function renderManeuverThrusterPreview(part, placementValid, design) {
  const rotation = normalizeRotation(part.rotation, PART_STATS[part.type]?.allowedRotations, part.x);
  const nozzleSide = rotation === 270 ? 1 : -1;
  const plume = document.createElement("div");
  plume.className = `maneuver-preview-plume ${placementValid ? "valid" : "invalid"} ${nozzleSide < 0 ? "left" : "right"}`;
  plume.title = nozzleSide < 0 ? "Nozzle plume left; force right" : "Nozzle plume right; force left";
  positionGridCellRelativeOverlay(plume, part.x, part.y, {
    width: "50%",
    height: "44%",
    left: `${nozzleSide * 44}%`,
    top: "28%"
  });
  dom.grid.appendChild(plume);

  const centerOfMass = calculateCenterOfMass(Array.isArray(design) ? design : state.design, PART_STATS);

  if (Math.abs((Number(part.y) || 0) - centerOfMass.y) < 0.75) {
    const weak = document.createElement("div");
    weak.className = `maneuver-preview-weak ${placementValid ? "valid" : "invalid"}`;
    weak.textContent = "Weak";
    weak.title = "Weak torque near the centre of mass";
    positionGridCellRelativeOverlay(weak, part.x, part.y, {
      width: "88%",
      height: "28%",
      left: "6%",
      top: "2%"
    });
    dom.grid.appendChild(weak);
  }
}

function renderEngineExhaustPreview(design, engineIndex, placementValid) {
  const analysis = globalThis.EngineExhaustRules.analyze(design, PART_STATS);
  const engine = analysis.engines.get(engineIndex);
  if (!engine) return;
  for (const channel of engine.channelCells) {
    const overlay = document.createElement("div");
    overlay.className = `engine-exhaust-preview ${placementValid && engine.valid ? "valid" : "invalid"}${channel.blocked ? " blocker" : ""}`;
    overlay.title = channel.blocked ? "Exhaust blocked here" : "Required clear exhaust channel";
    positionGridOverlay(overlay, channel.x, channel.y, 1, 1);
    dom.grid.appendChild(overlay);
  }
  const module = design[engineIndex];
  const arrow = document.createElement("div");
  arrow.className = `engine-thrust-arrow ${placementValid && engine.valid ? "valid" : "invalid"}`;
  arrow.textContent = engine.thrust.y < 0 ? "↑" : engine.thrust.y > 0 ? "↓" : engine.thrust.x < 0 ? "←" : "→";
  arrow.title = "Thrust direction";
  positionGridOverlay(arrow, module.x, module.y, 1, 1);
  dom.grid.appendChild(arrow);
}

export function refreshBlueprintSelectionPresentation() {
  refreshRotationIndicator();
  renderHoverPreview();
}

export function refreshBlueprintDiscoverabilityUi() {
  refreshBlueprintSelectionPresentation();
  if (dom.emptyGridInstruction) dom.emptyGridInstruction.hidden = !((state.blueprintView === "build" || state.blueprintView === "heat") && state.design.length === 0);
}

function selectedPlacementRotation() {
  if (!state.selectedPart || !isRotatablePart(state.selectedPart)) return null;
  return normalizeRotation(state.previewRotation || 0, PART_STATS[state.selectedPart]?.allowedRotations);
}

function selectedPlacementFlipped() {
  return Boolean(state.selectedPart && isFlippablePart(state.selectedPart) && state.previewFlipped === true);
}

export function refreshRotationIndicator() {
  if (!dom.rotationIndicator) return;
  const rotation = selectedPlacementRotation();
  const flippable = Boolean(state.selectedPart && isFlippablePart(state.selectedPart));
  const show = rotation != null;
  dom.rotationIndicator.hidden = !show;
  // One compact line: the rotation reading it has always shown, plus the mirror
  // state and its shortcut for the components that offer one.
  if (show) {
    dom.rotationIndicator.textContent = `Rotation: ${rotation}° ↻${flippable ? ` · Flip ↔ ${selectedPlacementFlipped() ? "on" : "off"} (F)` : ""}`;
  }
}

// Per catalogue part, the transform most recently used for it. Repeated
// placement keeps the orientation the player chose instead of resetting after
// every copy. Designer/session state only: nothing here is persisted or sent.
export function rememberPartTransform(type, rotation, flipped) {
  if (!type) return;
  state.partTransformMemory = {
    ...(state.partTransformMemory || {}),
    [type]: { rotation: Number(rotation) || 0, flipped: flipped === true }
  };
}

export function recalledPartTransform(type) {
  const remembered = (state.partTransformMemory || {})[type];
  const defaultRotation = PART_STATS[type]?.allowedRotations?.[0] ?? 0;
  if (!remembered) return { rotation: defaultRotation, flipped: false };
  return {
    rotation: isRotatablePart(type) ? normalizeRotation(remembered.rotation, PART_STATS[type]?.allowedRotations) : defaultRotation,
    flipped: isFlippablePart(type) && remembered.flipped === true
  };
}
