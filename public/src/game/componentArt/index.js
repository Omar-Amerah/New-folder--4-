// Component artwork and static-texture drawing for ships and blueprints.
//
// This is the artwork/baking module: every Canvas 2D routine that paints a
// ship component lives here (drawing into the shared `ctx`, which callers may
// temporarily point at an offscreen canvas via withCanvasContext for texture
// baking). The arena frame renderers do not define art; they compose it.
//
// The module exposes an explicit static/dynamic split for weapons:
//   drawStaticComponentBase  - the occupied hull block(s) for a part
//   drawStaticWeaponMount    - the non-directional weapon socket/housing
//   drawRotatingWeaponTop    - ONLY the rotating weapon top (barrels, rails,
//                              launcher/emitter heads), transparent background,
//                              centred pivot, local +x = weapon-forward
// Static hull textures must never contain rotating weapon tops, and rotating
// turret textures must never contain hull blocks or sockets.

import { ctx } from "../../ui/dom.js";
import { PART_STATS } from "../../design/parts.js";
import { qualityShadowBlur } from "../renderSettings.js";
import {
  drawComponentCubeBase,
  drawGenericFootprintMachine,
  drawPlateBody,
  drawRoundSystem,
  getModuleGradient,
  mixColor,
  roundRect
} from "./common.js";
import {
  LEGACY_PARTIAL_SHAPE_PARTS,
  STRUCTURAL_PARTS,
  drawStructureFootprintDetail,
  drawStructureModuleDetail
} from "./structure.js";
import {
  componentArtType,
  drawRotatingWeaponTop,
  drawStaticComponentBase,
  drawStaticWeaponMount,
  WEAPON_ART_TYPES
} from "./weapons/index.js";
import { drawCommandFootprintDetail, drawCommandModuleDetail } from "./command.js";
import { drawPowerFootprintDetail, drawPowerModuleDetail } from "./power.js";
import { drawPropulsionFootprintDetail, drawPropulsionModuleDetail } from "./propulsion.js";
import { drawSensorFootprintDetail, drawSensorModuleDetail } from "./sensors.js";
import { drawSupportFootprintDetail, drawSupportModuleDetail } from "./support.js";
import { drawThermalFootprintDetail, drawThermalModuleDetail } from "./thermal.js";
import { drawSpecialFootprintDetail, drawSpecialModuleDetail } from "./weapons/special.js";

export { drawRoundSystem, mixColor, roundRect } from "./common.js";
export { drawShipStructure, drawStructureLines, STRUCTURAL_PARTS } from "./structure.js";
export {
  drawRotatingWeaponTop,
  drawStaticComponentBase,
  drawStaticWeaponMount,
  drawWeaponBase,
  weaponChargeStage,
  WEAPON_CHARGE_STAGES
} from "./weapons/index.js";
export { drawChargeWarhead } from "./weapons/special.js";

const MODULE_DETAIL_DRAWERS = Object.freeze({
  frame: drawStructureModuleDetail,
  halfFrameDiagonal: drawStructureModuleDetail,
  halfArmorDiagonal: drawStructureModuleDetail,
  halfCompositeArmorDiagonal: drawStructureModuleDetail,
  halfAblativeArmorDiagonal: drawStructureModuleDetail,
  halfRefractoryArmorDiagonal: drawStructureModuleDetail,
  wingFrame: drawStructureModuleDetail,
  wingArmor: drawStructureModuleDetail,
  wingCompositeArmor: drawStructureModuleDetail,
  wingAblativeArmor: drawStructureModuleDetail,
  wingRefractoryArmor: drawStructureModuleDetail,
  refractoryArmor: drawStructureModuleDetail,
  ablativeArmor: drawStructureModuleDetail,
  bevelFrame: drawStructureModuleDetail,
  bevelArmor: drawStructureModuleDetail,
  bevelCompositeArmor: drawStructureModuleDetail,
  bevelAblativeArmor: drawStructureModuleDetail,
  bevelRefractoryArmor: drawStructureModuleDetail,
  roundedFrame: drawStructureModuleDetail,
  roundedArmor: drawStructureModuleDetail,
  roundedCompositeArmor: drawStructureModuleDetail,
  roundedAblativeArmor: drawStructureModuleDetail,
  roundedRefractoryArmor: drawStructureModuleDetail,
  armor: drawStructureModuleDetail,
  compositeArmor: drawStructureModuleDetail,
  engine: drawPropulsionModuleDetail,
  compactEngine: drawPropulsionModuleDetail,
  gyroscope: drawPropulsionModuleDetail,
  maneuverThruster: drawPropulsionModuleDetail,
  weaponMount: drawSupportModuleDetail,
  shield: drawSupportModuleDetail,
  decoyLauncher: drawSupportModuleDetail,
  repair: drawSupportModuleDetail,
  signalAmplifier: drawSupportModuleDetail,
  stabilizerNode: drawSupportModuleDetail,
  smallSensor: drawSensorModuleDetail,
  largeSensor: drawSensorModuleDetail,
  smallDirectedSensor: drawSensorModuleDetail,
  largeDirectedSensor: drawSensorModuleDetail,
  targetingComputer: drawSensorModuleDetail,
  fireControl: drawSensorModuleDetail,
  reactor: drawPowerModuleDetail,
  battery: drawPowerModuleDetail,
  capacitor: drawPowerModuleDetail,
  auxGenerator: drawPowerModuleDetail,
  nuclearReactor: drawPowerModuleDetail,
  heatSink: drawThermalModuleDetail,
  closedCycleCooler: drawThermalModuleDetail,
  heatPipe: drawThermalModuleDetail,
  heatVent: drawThermalModuleDetail,
  radiator: drawThermalModuleDetail,
  core: drawCommandModuleDetail,
  backupCore: drawCommandModuleDetail,
  proximityDemolitionCharge: drawSpecialModuleDetail,
  demolitionCharge: drawSpecialModuleDetail
});

const FOOTPRINT_DETAIL_DRAWERS = Object.freeze({
  engine: drawPropulsionFootprintDetail,
  heavyEngine: drawPropulsionFootprintDetail,
  burstCooler: drawThermalFootprintDetail,
  overclockedRepair: drawSupportFootprintDetail,
  droneBay: drawSupportFootprintDetail,
  reactor: drawPowerFootprintDetail,
  capacitor: drawPowerFootprintDetail,
  nuclearReactor: drawPowerFootprintDetail,
  largeSensor: drawSensorFootprintDetail,
  largeDirectedSensor: drawSensorFootprintDetail,
  backupCore: drawCommandFootprintDetail,
  proximityDemolitionCharge: drawSpecialFootprintDetail,
  demolitionCharge: drawSpecialFootprintDetail,
  longWedgeFrame: drawStructureFootprintDetail,
  longWedgeArmor: drawStructureFootprintDetail,
  longWedgeCompositeArmor: drawStructureFootprintDetail,
  longWedgeAblativeArmor: drawStructureFootprintDetail,
  longWedgeRefractoryArmor: drawStructureFootprintDetail,
  fireControlCommandCentre: drawCommandFootprintDetail,
  fleetDefenceCoordinator: drawCommandFootprintDetail,
  shieldCommandRelay: drawCommandFootprintDetail,
  engineeringCommandCentre: drawCommandFootprintDetail,
  propulsionCommandRelay: drawCommandFootprintDetail,
  electronicWarfareCommandCentre: drawCommandFootprintDetail
});

// --- Professional single-cell detail ------------------------------------------

function drawProfessionalModuleDetail(type, size, color, visualState = "active", rotation = 0, flipped = false, connectionMask = 0) {
  type = componentArtType(type);

  // Weapons keep the explicit static mount plus rotating top split.
  if (WEAPON_ART_TYPES.has(type)) {
    drawStaticWeaponMount({ type, unit: size, color });
    drawRotatingWeaponTop({ type, unit: size, color });
    return true;
  }

  const drawFamilyDetail = MODULE_DETAIL_DRAWERS[type];
  return drawFamilyDetail
    ? drawFamilyDetail(type, size, color, visualState, rotation, flipped, connectionMask)
    : false;
}

// --- Single-cell module composition --------------------------------------------

export function drawModule({ x, y, size, color, type, trim, drawBase = true, drawDetail = true, visualState = "active", rotation = 0, flipped = false, connectionMask = 0 }) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Dark local edge instead of a bright team-coloured outline; a soft glow is
  // reserved for genuine energy parts so the ship reads clean, not noisy.
  ctx.lineWidth = Math.max(0.9, size * 0.08);
  ctx.strokeStyle = "rgba(3,6,12,0.72)";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  // Structural parts carry a restrained team tint so friend/foe stays readable
  // on the hull without every module glowing in the team colour.
  const bodyColor = trim && STRUCTURAL_PARTS.has(type) ? mixColor(color, trim, 0.24) : color;
  ctx.fillStyle = getModuleGradient(size, bodyColor);

  // A cut-away silhouette draws its own body clipped to its outline, so a full
  // cube base behind it would fill the part of the cell the shape deliberately
  // gives up. The catalogue's `shapeType` is the authority: this used to be a
  // hand-listed set of every silhouette id, which silently reverted each new
  // structural material to a square block until someone remembered to add its
  // five variants.
  const keepsPartialShape = Boolean(PART_STATS[type]?.shapeType) || LEGACY_PARTIAL_SHAPE_PARTS.has(type);
  if (!keepsPartialShape && drawBase) {
    drawComponentCubeBase(size, bodyColor);
    // The base helper owns its canvas state; restore the component's intended
    // fill for the existing detail drawing below.
    ctx.fillStyle = getModuleGradient(size, bodyColor);
  }

  if (!drawDetail) {
    ctx.restore();
    return;
  }

  // All currently selectable parts use the unified professional detail set.
  // Legacy branches remain below as compatibility art for any old/custom part
  // ids loaded from storage.
  if (drawProfessionalModuleDetail(type, size, bodyColor, visualState, rotation, flipped, connectionMask)) {
    ctx.restore();
    return;
  }

  if (type === "core") {
    drawPlateBody(size, 0.48, size * 0.18);
    // Housed reactor well: dark socket, bright controlled core, containment ring.
    ctx.save();
    ctx.fillStyle = "rgba(6,12,20,0.9)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "#8fe6ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#f4fdff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.19, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(110,231,255,0.75)";
    ctx.lineWidth = Math.max(1, size * 0.05);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  } else if (type === "frame") {
    drawPlateBody(size, 0.46, size * 0.1);
    // Simple internal support bracing, kept dark/industrial rather than a bright cross.
    ctx.save();
    ctx.strokeStyle = "rgba(10,16,26,0.5)";
    ctx.lineWidth = Math.max(1, size * 0.07);
    ctx.beginPath();
    ctx.moveTo(-size * 0.26, -size * 0.26);
    ctx.lineTo(size * 0.26, size * 0.26);
    ctx.moveTo(size * 0.26, -size * 0.26);
    ctx.lineTo(-size * 0.26, size * 0.26);
    ctx.stroke();
    ctx.strokeStyle = "rgba(210,222,240,0.24)";
    ctx.lineWidth = Math.max(0.7, size * 0.035);
    ctx.beginPath();
    ctx.moveTo(-size * 0.26, -size * 0.26);
    ctx.lineTo(size * 0.26, size * 0.26);
    ctx.stroke();
    ctx.fillStyle = "rgba(214,226,244,0.32)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (type === "halfFrameDiagonal" || type === "halfArmorDiagonal" || type === "halfCompositeArmorDiagonal") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.46, -size * 0.46);
    ctx.lineTo(size * 0.46, -size * 0.46);
    ctx.lineTo(-size * 0.46, size * 0.46);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (type === "halfFrameDiagonal") {
      ctx.strokeStyle = "rgba(255,255,255,0.42)";
      ctx.lineWidth = Math.max(1, size * 0.08);
      ctx.beginPath();
      ctx.moveTo(-size * 0.2, -size * 0.2);
      ctx.lineTo(size * 0.1, -size * 0.2);
      ctx.moveTo(-size * 0.2, size * 0.1);
      ctx.lineTo(-size * 0.2, -size * 0.2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "rgba(255,244,220,0.38)";
      ctx.beginPath();
      ctx.moveTo(-size * 0.2, -size * 0.2);
      ctx.lineTo(size * 0.1, -size * 0.2);
      ctx.stroke();
    }
  } else if (type === "wingFrame" || type === "wingArmor" || type === "wingCompositeArmor") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.46, -size * 0.46);
    ctx.lineTo(size * 0.46, 0);
    ctx.lineTo(-size * 0.46, size * 0.46);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (type === "wingFrame") {
      ctx.strokeStyle = "rgba(255,255,255,0.42)";
      ctx.lineWidth = Math.max(1, size * 0.08);
      ctx.beginPath();
      ctx.moveTo(-size * 0.2, -size * 0.2);
      ctx.lineTo(size * 0.1, 0);
      ctx.lineTo(-size * 0.2, size * 0.2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "rgba(255,244,220,0.38)";
      ctx.beginPath();
      ctx.moveTo(-size * 0.2, -size * 0.2);
      ctx.lineTo(size * 0.1, 0);
      ctx.stroke();
    }
  } else if (type === "armor") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, -size * 0.24);
    ctx.lineTo(-size * 0.18, -size * 0.48);
    ctx.lineTo(size * 0.42, -size * 0.34);
    ctx.lineTo(size * 0.48, size * 0.2);
    ctx.lineTo(size * 0.18, size * 0.48);
    ctx.lineTo(-size * 0.48, size * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,244,220,0.38)";
    ctx.beginPath();
    ctx.moveTo(-size * 0.18, -size * 0.34);
    ctx.lineTo(size * 0.24, size * 0.28);
    ctx.stroke();
  } else if (type === "engine") {
    // Propulsion housing (wider at the mount, tapering toward the nozzle at -x).
    ctx.beginPath();
    ctx.moveTo(-size * 0.36, -size * 0.4);
    ctx.lineTo(size * 0.46, -size * 0.26);
    ctx.lineTo(size * 0.46, size * 0.26);
    ctx.lineTo(-size * 0.36, size * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Panel seam across the housing.
    ctx.save();
    ctx.strokeStyle = "rgba(210,222,240,0.2)";
    ctx.lineWidth = Math.max(0.7, size * 0.045);
    ctx.beginPath();
    ctx.moveTo(size * 0.16, -size * 0.24);
    ctx.lineTo(size * 0.16, size * 0.24);
    ctx.stroke();
    ctx.restore();
    // Exhaust nozzle: dark bell around a hot cyan throat, pointing -x.
    ctx.save();
    ctx.fillStyle = "#0a2732";
    ctx.beginPath();
    ctx.moveTo(-size * 0.36, -size * 0.24);
    ctx.lineTo(-size * 0.58, -size * 0.2);
    ctx.lineTo(-size * 0.58, size * 0.2);
    ctx.lineTo(-size * 0.36, size * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#9ff6ff";
    ctx.beginPath();
    ctx.moveTo(-size * 0.4, -size * 0.12);
    ctx.lineTo(-size * 0.56, 0);
    ctx.lineTo(-size * 0.4, size * 0.12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (type === "backupCore") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#c4b5fd";
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.beginPath();
    ctx.moveTo(-size * 0.28, 0); ctx.lineTo(size * 0.28, 0);
    ctx.moveTo(0, -size * 0.28); ctx.lineTo(0, size * 0.28);
    ctx.stroke();
    ctx.fillStyle = "#ede9fe";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.1, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "reactor" || type === "nuclearReactor") {
    drawRoundSystem(size);
    ctx.fillStyle = type === "nuclearReactor" ? "#fef08a" : "#fff7b3";
    ctx.beginPath();
    ctx.arc(0, 0, size * (type === "nuclearReactor" ? 0.24 : 0.2), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = type === "nuclearReactor" ? "#c2410c" : "#6b4b12";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.36, 0, Math.PI * 2);
    ctx.stroke();
  } else if (type === "battery") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#d5fbff";
    for (let i = 0; i < 3; i += 1) {
      ctx.fillRect(-size * 0.25, -size * 0.28 + i * size * 0.21, size * 0.5, size * 0.09);
    }
  } else if (type === "shield") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#b9ffd0";
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.34, Math.PI * 0.15, Math.PI * 1.85);
    ctx.stroke();
  } else if (type === "repair") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#d7ffe2";
    ctx.lineWidth = Math.max(1.4, size * 0.12);
    ctx.beginPath();
    ctx.moveTo(-size * 0.24, 0);
    ctx.lineTo(size * 0.24, 0);
    ctx.moveTo(0, -size * 0.24);
    ctx.lineTo(0, size * 0.24);
    ctx.stroke();
  } else if (type === "gyroscope") {
    drawRoundSystem(size);
    ctx.strokeStyle = "rgba(255,255,255,0.48)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.28, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#a78bfa";
    ctx.fillRect(-size * 0.06, -size * 0.38, size * 0.12, size * 0.76);
    ctx.fillRect(-size * 0.38, -size * 0.06, size * 0.76, size * 0.12);
  } else if (type === "auxGenerator") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fef08a";
    ctx.fillRect(-size * 0.14, -size * 0.28, size * 0.28, size * 0.56);
    ctx.strokeStyle = "#ca8a04";
    ctx.strokeRect(-size * 0.14, -size * 0.28, size * 0.28, size * 0.56);
  } else if (type === "capacitor") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.10 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#38bdf8";
    ctx.fillRect(-size * 0.28, -size * 0.3, size * 0.2, size * 0.6);
    ctx.fillRect(size * 0.08, -size * 0.3, size * 0.2, size * 0.6);
  } else if (type === "maneuverThruster") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.35, -size * 0.35);
    ctx.lineTo(size * 0.35, -size * 0.15);
    ctx.lineTo(size * 0.35, size * 0.15);
    ctx.lineTo(-size * 0.35, size * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#60a5fa";
    ctx.fillRect(-size * 0.48, -size * 0.12, size * 0.15, size * 0.24);
  } else if (type === "targetingComputer") {
    roundRect(ctx, { x: -size * 0.44, y: -size * 0.44, width: size * 0.88, height: size * 0.88, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(0, 255, 100, 0.08)";
    ctx.fillRect(-size * 0.28, -size * 0.28, size * 0.56, size * 0.56);
    ctx.strokeStyle = "#22c55e";
    ctx.strokeRect(-size * 0.28, -size * 0.28, size * 0.56, size * 0.56);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.14, 0, Math.PI * 2);
    ctx.moveTo(-size * 0.22, 0);
    ctx.lineTo(size * 0.22, 0);
    ctx.moveTo(0, -size * 0.22);
    ctx.lineTo(0, size * 0.22);
    ctx.stroke();
  } else if (type === "fireControl") {
    roundRect(ctx, { x: -size * 0.44, y: -size * 0.44, width: size * 0.88, height: size * 0.88, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#ef4444";
    ctx.beginPath();
    ctx.moveTo(-size * 0.24, -size * 0.24);
    ctx.lineTo(size * 0.24, size * 0.24);
    ctx.moveTo(size * 0.24, -size * 0.24);
    ctx.lineTo(-size * 0.24, size * 0.24);
    ctx.stroke();
  } else if (type === "heatSink") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.10 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(239, 68, 68, 0.45)";
    for (let i = 0; i < 4; i += 1) {
      ctx.fillRect(-size * 0.28 + i * size * 0.16, -size * 0.26, size * 0.08, size * 0.52);
    }
  } else if (type === "closedCycleCooler") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#06b6d4";
    ctx.beginPath();
    for (let i = 0; i < 4; i += 1) {
      const a = (i * Math.PI) / 2;
      ctx.moveTo(Math.cos(a) * size * 0.08, Math.sin(a) * size * 0.08);
      ctx.lineTo(Math.cos(a) * size * 0.22, Math.sin(a) * size * 0.22);
    }
    ctx.stroke();
  } else if (type === "signalAmplifier") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#a855f7";
    ctx.fillRect(-size * 0.06, -size * 0.28, size * 0.12, size * 0.56);
    ctx.strokeStyle = "#d8b4fe";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.22, -Math.PI * 0.6, -Math.PI * 0.4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.34, -Math.PI * 0.6, -Math.PI * 0.4);
    ctx.stroke();
  } else if (type === "stabilizerNode") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#0284c7";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.12, 0, Math.PI * 2);
    ctx.fill();
  } else {
    roundRect(ctx, { x: -size * 0.44, y: -size * 0.44, width: size * 0.88, height: size * 0.88, radius: size * 0.1 });
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

// --- Footprint-aware (multi-cell) component art --------------------------------

function drawProfessionalFootprintDetail(type, unit, tilesLong, tilesCross, color, hl, hc, visualState, rotation = 0, flipped = false) {
  type = componentArtType(type);

  // Weapons keep the explicit static mount plus rotating top split.
  if (WEAPON_ART_TYPES.has(type)) {
    drawStaticWeaponMount({ type, unit, tilesLong, tilesCross, color });
    drawRotatingWeaponTop({ type, unit, tilesLong, tilesCross, color });
    return true;
  }

  const drawFamilyDetail = FOOTPRINT_DETAIL_DRAWERS[type];
  if (drawFamilyDetail) {
    return drawFamilyDetail(type, unit, tilesLong, tilesCross, color, hl, hc, visualState, rotation, flipped);
  }
  return drawGenericFootprintMachine(type, unit, tilesLong, color, hl, hc);
}

// Draws a multi-tile component as one purpose-built object spanning its whole
// footprint, in a canonical frame where +x is "forward" (barrel / long axis)
// and the body is centred on the origin. Shared by the arena ship renderer and
// the designer icon baker so blueprint and in-game visuals match. 1x1 parts
// keep using drawModule(); this only handles the elongated/multi-cell types.
export function drawFootprintComponent({ type, unit, tilesLong, tilesCross, color, trim, drawBase = true, drawDetail = true, visualState = "safed", rotation = 0, flipped = false }) {
  const hl = (tilesLong * unit) / 2; // half length along +x
  const hc = (tilesCross * unit) / 2; // half width along y
  const edge = "rgba(3,6,12,0.72)";

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.9, unit * 0.08);
  ctx.strokeStyle = edge;

  const structural = STRUCTURAL_PARTS.has(type);
  const bodyColor = trim && structural ? mixColor(color, trim, 0.24) : color;
  const bodyFill = getModuleGradient(unit, bodyColor);
  ctx.fillStyle = bodyFill;

  // Multi-cell modules use one continuous, footprint-filling cube base. This is
  // especially important for weapons: their barrels and launchers sit on top of
  // occupied blocks instead of visually floating through empty blueprint cells.
  if (drawBase && !type.startsWith("wing") && !type.startsWith("half") && !type.startsWith("longWedge")) {
    drawStaticComponentBase({ type, unit, tilesLong, tilesCross, color, trim });
    ctx.fillStyle = bodyFill;
  }

  if (!drawDetail) {
    ctx.restore();
    return;
  }

  if (drawProfessionalFootprintDetail(type, unit, tilesLong, tilesCross, bodyColor, hl, hc, visualState, rotation, flipped)) {
    ctx.restore();
    return;
  }

  // Long rounded chassis used as the base body for most elongated parts.
  const chassis = (padCross = 0.72, radius = unit * 0.22) => {
    roundRect(ctx, { x: -hl, y: -hc * padCross, width: hl * 2, height: hc * padCross * 2, radius });
    ctx.fill();
    ctx.stroke();
  };
  const panelSeams = (count) => {
    ctx.save();
    ctx.strokeStyle = "rgba(210,222,240,0.18)";
    ctx.lineWidth = Math.max(0.6, unit * 0.04);
    for (let i = 1; i < count; i += 1) {
      const x = -hl + (hl * 2 * i) / count;
      ctx.beginPath();
      ctx.moveTo(x, -hc * 0.6);
      ctx.lineTo(x, hc * 0.6);
      ctx.stroke();
    }
    ctx.restore();
  };

  if (type === "engine") {
    // Long propulsion block, nozzle bell + hot throat at the rear (-x).
    roundRect(ctx, { x: -hl + unit * 0.34, y: -hc * 0.8, width: hl * 2 - unit * 0.34, height: hc * 1.6, radius: unit * 0.16 });
    ctx.fill();
    ctx.stroke();
    panelSeams(tilesLong);
    ctx.fillStyle = "#0a2732";
    ctx.beginPath();
    ctx.moveTo(-hl + unit * 0.34, -hc * 0.5);
    ctx.lineTo(-hl, -hc * 0.42);
    ctx.lineTo(-hl, hc * 0.42);
    ctx.lineTo(-hl + unit * 0.34, hc * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#9ff6ff";
    ctx.beginPath();
    ctx.moveTo(-hl + unit * 0.28, -hc * 0.26);
    ctx.lineTo(-hl - unit * 0.02, 0);
    ctx.lineTo(-hl + unit * 0.28, hc * 0.26);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (type === "reactor") {
    // Elongated capsule housing with glowing core band.
    roundRect(ctx, { x: -hl, y: -hc * 0.86, width: hl * 2, height: hc * 1.72, radius: hc * 0.7 });
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = "#ffe07a";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#fff7b3";
    roundRect(ctx, { x: -hl * 0.62, y: -hc * 0.3, width: hl * 1.24, height: hc * 0.6, radius: hc * 0.3 });
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "#6b4b12";
    ctx.beginPath();
    ctx.arc(-hl * 0.5, 0, hc * 0.34, 0, Math.PI * 2);
    ctx.arc(hl * 0.5, 0, hc * 0.34, 0, Math.PI * 2);
    ctx.stroke();
  } else if (type === "capacitor") {
    // Long block of charge cells.
    roundRect(ctx, { x: -hl, y: -hc * 0.84, width: hl * 2, height: hc * 1.68, radius: unit * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#38bdf8";
    const cols = Math.max(2, tilesLong + 1);
    for (let c = 0; c < cols; c += 1) {
      const cx = -hl + unit * 0.24 + (hl * 2 - unit * 0.48) * (c / (cols - 1 || 1));
      ctx.fillRect(cx - unit * 0.06, -hc * 0.5, unit * 0.12, hc);
    }
  } else if (structural) {
    // Armour/frame/wings: one plate covering the whole footprint with seams.
    roundRect(ctx, { x: -hl, y: -hc, width: hl * 2, height: hc * 2, radius: unit * 0.14 });
    ctx.fill();
    ctx.stroke();
    panelSeams(tilesLong);
    if (type.startsWith("wing")) {
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.beginPath();
      ctx.moveTo(-hl * 0.7, -hc * 0.5);
      ctx.lineTo(hl * 0.7, 0);
      ctx.lineTo(-hl * 0.7, hc * 0.5);
      ctx.stroke();
    }
  } else {
    // Unknown multi-tile type: fall back to a scaled single module.
    ctx.restore();
    drawModule({ x: 0, y: 0, size: Math.min(hl, hc) * 2 * 0.92, color, type, trim });
    return;
  }

  ctx.restore();
}

