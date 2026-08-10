// Station rendering for the PixiJS arena renderer (station infrastructure mode).
//
// A station is an authoritative component structure, so every layer here is
// measured from the design the server actually built its collision geometry
// from : never from hand-tuned multiples of some radius:
//
//   shellGfx     the structure itself, drawn as vector art traced around the
//                measured footprint (see stationLocalBounds), including the
//                three hangar recesses cut into a home station's shell
//   turrets      one rotating sprite per weapon module, sitting on that
//                module's own hardpoint : the same point the server fires from
//   shieldGfx    the shield envelope, in the same visual language as a ship's
//   auraGfx      the gameplay radii: a home station's repair envelope, a
//                relay's capture ring and progress sweep, and : for the station
//                being inspected : its weapon range
//   hudGfx/Text  health, shield, the hangar queue, the state badge and the
//                selection bracket
//
// The interior component grid is deliberately never baked or drawn: see the
// shell section. Everything except the turret angles is signature-gated, so an
// idle station costs no draw-call rebuilds.

import { state } from "../../state.js";
import { GENERATED_BALANCE } from "../../generatedBalance.js";
import { TEAM_COLORS, teamColorFor } from "../../shared/teamColors.js";
import { isCircleVisible } from "../viewportCulling.js";
import { createPixiKeyedPool, getPixiBakeGeneration } from "./pixiBake.js";
import { SHIP_SCALE, acquireTurretLease } from "./pixiShipView.js";
import { shipLocalBounds } from "../shipGeometry.js";
import { isRotatingWeaponPart, authoritativeWeaponAngle } from "../weaponAim.js";
import { hullColorForRatio, shieldColorForRatio, brightenShieldColor } from "../shipVitals.js";

const stationBarGradientCache = new Map();
const stationBoundsCache = new WeakMap();

function getPixiBarGradient(env, id, stops, vertical) {
  let gradient = stationBarGradientCache.get(id);
  if (!gradient) {
    gradient = new env.PIXI.FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: vertical ? { x: 0, y: 1 } : { x: 1, y: 0 },
      colorStops: stops,
      textureSpace: "local"
    });
    stationBarGradientCache.set(id, gradient);
  }
  return gradient;
}

const INFRASTRUCTURE = GENERATED_BALANCE?.infrastructure || {};
const HOME_STATION = INFRASTRUCTURE.homeStation || {};
const RELAY_STATION = INFRASTRUCTURE.relayStation || {};

const NEUTRAL_COLOR = "#9fb0c6";
const FRIENDLY_COLOR = TEAM_COLORS.blue;
const ENEMY_COLOR = TEAM_COLORS.red;
const HANGAR_COVER_DEPTH_RATIO = 2 / 3;
const HANGAR_COVER_FILL = "#253747";

let pixiStationPool = null;

function isSoloMode() {
  return state.rules?.gameMode === "solo";
}

// Station colour follows the same friendly/enemy convention as ships so a
// glance at the arena reads the same way for hulls and structures.
export function stationColor(station, players) {
  if (!station) return NEUTRAL_COLOR;
  if (station.state === "neutral" || (!station.team && !station.ownerId)) return NEUTRAL_COLOR;
  if (isSoloMode()) {
    const owner = station.ownerId ? players?.get?.(station.ownerId) : null;
    if (station.ownerId && station.ownerId === state.myId) return FRIENDLY_COLOR;
    return owner?.color || ENEMY_COLOR;
  }
  const owner = station.ownerId ? players?.get?.(station.ownerId) : null;
  const actualTeam = station.team || owner?.team;
  const actualTeamColor = teamColorFor(actualTeam);
  if (actualTeamColor) return actualTeamColor;
  const myTeam = state.mine?.team;
  if (myTeam && station.team && station.team === myTeam) return FRIENDLY_COLOR;
  if (station.ownerId && station.ownerId === state.myId) return FRIENDLY_COLOR;
  return ENEMY_COLOR;
}

// Friendly/enemy colour for a bare team id, using the same convention as
// stationColor so a capture bar reads the same way as the structure it is on.
export function teamColor(team) {
  if (!team) return null;
  if (isSoloMode()) return team === state.mine?.team ? FRIENDLY_COLOR : ENEMY_COLOR;
  const actualTeamColor = teamColorFor(team);
  if (actualTeamColor) return actualTeamColor;
  const myTeam = state.mine?.team;
  if (!myTeam) return team === "blue" ? FRIENDLY_COLOR : ENEMY_COLOR;
  return team === myTeam ? FRIENDLY_COLOR : ENEMY_COLOR;
}

export function stationStateLabel(station) {
  if (!station) return "";
  // An uncaptured relay is not running for anybody, so it reads OFFLINE rather
  // than describing its ownership.
  if (station.state === "neutral") return "OFFLINE";
  if (station.state === "destroyed") return "DESTROYED";
  if (station.state === "recovering") return "RECOVERING";
  if (station.state === "controlled") return "CONTROLLED";
  // A station the sensor snapshot only knows structurally: its condition was
  // withheld, so claiming ONLINE would be asserting something we were not told.
  // Older snapshots used "unknown" for captured relays too; ownership is public,
  // so keep those clients clear of the misleading UNSCANNED label.
  if (station.state === "unknown" && station.stationType === "relay" && (station.team || station.ownerId)) {
    return "CONTROLLED";
  }
  if (station.state === "unknown") return "UNSCANNED";
  return station.stationType === "home" ? "OPERATIONAL" : "ONLINE";
}

// Whether the structure should be drawn lit. A station whose condition the
// sensor snapshot withheld is still a live installation to look at, so it is
// drawn powered : only its readouts are unknown.
function stationIsPowered(state) {
  return state === "operational" || state === "unknown" || state === "controlled";
}

// Stations are authored on the same 15x15 grid ships use, but are drawn at a
// larger module scale (the server sends it as `moduleScale`). The hull texture
// is baked by the shared ship pipeline at SHIP_SCALE and then scaled up, so
// station art needs no second baking path.
function stationScaleRatio(station) {
  const scale = Number(station.moduleScale);
  const fallback = station.stationType === "home" ? 56 : SHIP_SCALE;
  return (Number.isFinite(scale) && scale > 0 ? scale : fallback) / SHIP_SCALE;
}

// The structure's REAL local footprint, in world units, measured from the same
// design the server built its collision rectangles from.
//
// Everything drawn for a station is anchored to this. The previous shell was a
// hand-authored silhouette scaled off `apertureHalfWidth`, which put a home
// station's drawn front face at local x=113 and its stern at x=-479 while the
// solid structure actually spans x=-270..270 : so ships bounced off empty space
// ahead of the art and flew straight through the drawn stern.
function stationLocalBounds(station) {
  const design = station.design;
  const scale = Number(station.moduleScale) || (station.stationType === "home" ? 56 : SHIP_SCALE);
  if (!Array.isArray(design) || design.length === 0) {
    const radius = Math.max(45, Number(station.radius) || 60) / Math.SQRT2;
    return { minX: -radius, maxX: radius, minY: -radius, maxY: radius };
  }
  let byScale = stationBoundsCache.get(design);
  if (!byScale) {
    byScale = new Map();
    stationBoundsCache.set(design, byScale);
  }
  let bounds = byScale.get(scale);
  if (!bounds) {
    bounds = shipLocalBounds(design, scale);
    byScale.set(scale, bounds);
  }
  return bounds;
}

// Home-station hangar geometry is static snapshot data. Keep the local shapes
// here, where vector art uses the same width and depth as collision, while
// dynamic ship occupancy remains in station.launches.
function stationHangarBaysLocal(station, bounds) {
  if (station.stationType !== "home") return [];
  const source = Array.isArray(station.hangars) ? station.hangars : [];
  return source.map((bay, index) => {
    const halfWidth = Number(bay?.apertureHalfWidth) || 0;
    const length = Number(bay?.corridorLength || bay?.corridorDepth) || 0;
    if (!(halfWidth > 0) || !(length > 0)) return null;
    const centreY = Number.isFinite(Number(bay?.centreY))
      ? Number(bay.centreY)
      : Number(bay?.localCentre?.y) || 0;
    return {
      id: bay.id || ["left", "central", "right"][index] || `hangar-${index}`,
      index: Number.isInteger(bay?.index) ? bay.index : index,
      halfWidth,
      length,
      centreY,
      mouthX: bounds.maxX,
      rearWallX: bounds.maxX - length
    };
  }).filter(Boolean).sort((a, b) => a.centreY - b.centreY);
}

// A launch is authoritative on the server, but a freshly created hull should
// also read as a hull emerging from the station on the client. The canopy is
// deliberately derived from the same bay records and is not collision or
// gameplay geometry: it covers the rear two-thirds of the corridor and the
// full width of its opening, leaving the approach visible as the ship comes
// out.
function stationHangarCoverGeometry(station, bounds) {
  const scale = Number(station.moduleScale) || (station.stationType === "home" ? 56 : SHIP_SCALE);
  return stationHangarBaysLocal(station, bounds).map((bay) => {
    const coverLength = Math.min(
      bay.length * HANGAR_COVER_DEPTH_RATIO,
      Math.max(0, bay.length - scale)
    );
    const topY = bay.centreY - bay.halfWidth;
    const openingHeight = bay.halfWidth * 2;
    return {
      ...bay,
      coverStartX: bay.rearWallX,
      coverEndX: bay.rearWallX + coverLength,
      coverTopY: topY,
      coverBottomY: topY + openingHeight
    };
  });
}

function createPixiStationView(env) {
  const PIXI = env.PIXI;
  const root = new PIXI.Container();
  root.label = "StationRoot";

  const auraGfx = new PIXI.Graphics();
  auraGfx.label = "StationAura";
  const shellGfx = new PIXI.Graphics();
  shellGfx.label = "StationShell";
  // Above the structure and the turrets: the shield envelope wraps the whole
  // installation, exactly as a ship's does.
  const shieldGfx = new PIXI.Graphics();
  shieldGfx.label = "StationShield";
  const hudGfx = new PIXI.Graphics();
  hudGfx.label = "StationHud";
  const coverGfx = new PIXI.Graphics();
  coverGfx.label = "StationCover";
  env.layers.stationCovers.addChild(coverGfx);

  const makeText = (style) => {
    const text = new PIXI.Text({ text: "", style, resolution: 2 });
    text.anchor.set(0.5);
    return text;
  };
  const stateText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 13, fontWeight: "bold", fill: "#ffffff", stroke: { color: "rgba(0,0,0,0.7)", width: 3 } });
  const queueText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 12, fill: "#cfe3f5", stroke: { color: "rgba(0,0,0,0.7)", width: 3 } });

  const turretContainer = new PIXI.Container();
  turretContainer.label = "StationTurrets";
  turretContainer.position.set(0, 0);
  const turretContainerWorldSpace = Boolean(env.layers.stationWeapons);

  root.addChild(auraGfx);
  root.addChild(shellGfx);
  if (turretContainerWorldSpace) env.layers.stationWeapons.addChild(turretContainer);
  else root.addChild(turretContainer);
  root.addChild(shieldGfx);
  root.addChild(hudGfx);
  root.addChild(stateText);
  root.addChild(queueText);

  return {
    root,
    auraGfx,
    shellGfx,
    turretContainer,
    turretContainerWorldSpace,
    shieldGfx,
    hudGfx,
    stateText,
    queueText,
    coverGfx,
    auraSignature: "",
    shellSignature: "",
    shieldSignature: "",
    hudSignature: "",
    coverSignature: "",
    turretSignature: "",
    turretSprites: [],
    turretsByDesignIndex: new Map(),
    stateLabel: null,
    queueLabel: null,
    release() {
      this.auraSignature = "";
      this.shellSignature = "";
      this.shieldSignature = "";
      this.hudSignature = "";
      this.coverSignature = "";
      this.turretSignature = "";
      this.stateLabel = null;
      this.queueLabel = null;
      this.auraGfx.clear();
      this.shellGfx.clear();
      this.shieldGfx.clear();
      this.hudGfx.clear();
      if (this.coverGfx) this.coverGfx.visible = false;
      this.turretContainer.removeChildren();
      this.turretContainer.visible = false;
      for (const sprite of this.turretSprites) {
        if (sprite.__lease) {
          sprite.__lease.release();
          sprite.__lease = null;
        }
        if (!sprite.destroyed) sprite.destroy({ children: false, texture: false, textureSource: false });
      }
      this.turretSprites = [];
      this.turretsByDesignIndex.clear();
    },
    destroy() {
      if (this.turretContainerWorldSpace) {
        if (this.turretContainer.parent) this.turretContainer.parent.removeChild(this.turretContainer);
        if (!this.turretContainer.destroyed) this.turretContainer.destroy({ children: false });
      }
      if (this.coverGfx) {
        if (this.coverGfx.parent) this.coverGfx.parent.removeChild(this.coverGfx);
        if (!this.coverGfx.destroyed) this.coverGfx.destroy({ children: false, texture: false, textureSource: false });
      }
      if (!this.root.destroyed) this.root.destroy({ children: true, texture: false, textureSource: false });
    }
  };
}

// Persistent rotating turret sprites for station weapon modules.
function rebuildStationTurrets(env, view, station) {
  const design = station.design || [];
  const ratio = stationScaleRatio(station);

  view.turretContainer.removeChildren();
  for (const sprite of view.turretSprites) {
    if (sprite.__lease) {
      sprite.__lease.release();
      sprite.__lease = null;
    }
    if (!sprite.destroyed) sprite.destroy({ children: false, texture: false, textureSource: false });
  }
  view.turretSprites = [];
  view.turretsByDesignIndex.clear();

  for (let i = 0; i < design.length; i += 1) {
    const part = design[i];
    if (!isRotatingWeaponPart(part.type)) continue;
    const hardpoint = station.hardpoints?.[i];
    if (!hardpoint) continue;
    const lease = acquireTurretLease(env, part.type);
    const sprite = new env.PIXI.Sprite(lease.texture);
    sprite.label = `StationTurret[${i}] ${part.type}`;
    sprite.anchor.set(0.5);
    sprite.position.set(hardpoint.x, hardpoint.y);
    sprite.scale.set(ratio / env.bakeScale);
    sprite.__designIndex = i;
    sprite.__partType = part.type;
    sprite.__lease = lease;
    sprite.rotation = authoritativeWeaponAngle(station, i) || 0;
    view.turretContainer.addChild(sprite);
    view.turretSprites.push(sprite);
    view.turretsByDesignIndex.set(i, sprite);
  }
}

// The area-of-effect rings a station projects: a home station's repair radius
// and a relay's capture radius. Both are gameplay boundaries the player has to
// steer against, so unlike the old build they are drawn in normal play; the
// launch-corridor approach guides stay behind the geometry debug flag.
//
// The aura is drawn UNROTATED (it is radially symmetric) and rebuilt only when
// type, state, colour, capture progress or zoom change.
function rebuildStationAura(view, station, color, zoom, debug, captureStep, selected) {
  const gfx = view.auraGfx;
  gfx.clear();
  const thin = 1 / zoom;

  // Weapon envelope for the station being inspected, on every station type.
  if (selected) drawStationRangeRing(gfx, station, zoom);

  if (station.stationType === "home") {
    const repairRadius = Number(HOME_STATION.repairRadius) || 0;
    const friendly = color === FRIENDLY_COLOR;
    // Only the side that benefits needs the repair envelope; on an enemy home
    // station it would be noise.
    if (repairRadius > 0 && friendly && station.state === "operational") {
      gfx.circle(0, 0, repairRadius);
      gfx.stroke({ width: 1.5 * thin, color, alpha: 0.22 });
      gfx.circle(0, 0, repairRadius - 6 * thin);
      gfx.stroke({ width: thin, color, alpha: 0.1 });
    }
    if (debug) {
      const bounds = stationLocalBounds(station);
      const bays = stationHangarBaysLocal(station, bounds);
      for (const bay of bays) {
        gfx.rect(bay.rearWallX, bay.centreY - bay.halfWidth, bay.length, bay.halfWidth * 2);
        gfx.stroke({ width: thin, color: "#ffd166", alpha: 0.8 });
      }
      if (bays.length) {
        gfx.rect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
        gfx.stroke({ width: thin, color: "#ff6b6b", alpha: 0.8 });
      }
    }
    return;
  }

  const captureRadius = Number(RELAY_STATION.captureRadius) || 0;
  if (captureRadius <= 0) return;
  const neutral = station.state === "neutral";
  gfx.circle(0, 0, captureRadius);
  gfx.fill({ color, alpha: neutral ? 0.045 : 0.07 });
  gfx.stroke({ width: 1.5 * thin, color, alpha: neutral ? 0.3 : 0.42 });
  // Progress is a sweep around the capture ring rather than another bar: it
  // reads at a glance from across the arena, where the HUD bars do not. It is
  // drawn in the capturing side's colour, so you can tell at a glance whether
  // a relay is being taken from you or for you.
  const progress = Math.max(0, Math.min(1, captureStep / 100));
  const captureColor = teamColor(station.captureTeam) || color;
  if (progress > 0) {
    // moveTo the arc's start point first. Pixi's arc() continues the CURRENT
    // path, so without this it draws a straight line from the graphics origin
    // out to the start of the sweep : a stray spoke from the relay's centre to
    // the top of its ring.
    const start = -Math.PI / 2;
    gfx.moveTo(Math.cos(start) * captureRadius, Math.sin(start) * captureRadius);
    gfx.arc(0, 0, captureRadius, start, start + progress * Math.PI * 2);
    gfx.stroke({ width: 5 * thin, color: captureColor, alpha: 0.95 });
  }
  if (station.captureContested) {
    gfx.circle(0, 0, captureRadius - 8 * thin);
    gfx.stroke({ width: 2 * thin, color: "#ffc861", alpha: 0.5 });
  }
}

function isStationDebugEnabled() {
  return typeof window !== "undefined" && window.__mfaDebugStationGeometry === true;
}

// The radius a shield envelope sits at: the structure's circumradius plus a
// margin, so it clears the corners of a square station rather than cutting
// through them.
function stationShieldRadius(bounds, station) {
  const authoritative = Number(station?.shieldRadius);
  if (Number.isFinite(authoritative) && authoritative > 0) return authoritative;
  const corner = Math.hypot(
    Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX)),
    Math.max(Math.abs(bounds.minY), Math.abs(bounds.maxY))
  );
  return corner * 1.06;
}

// The station's shield envelope. Same visual language as a ship's : a faint
// field, a continuous ring whose opacity and thickness carry strength, and a
// fixed highlight arc for dimensionality : just wrapped around a structure.
function rebuildStationShield(view, station, bounds) {
  const gfx = view.shieldGfx;
  gfx.clear();
  const maxShield = Math.max(0, Number(station.maxShield) || 0);
  const ratio = maxShield > 0 ? Math.max(0, Math.min(1, (Number(station.shield) || 0) / maxShield)) : 0;
  if (ratio <= 0) {
    gfx.visible = false;
    return;
  }
  gfx.visible = true;

  const radius = stationShieldRadius(bounds, station);
  const color = shieldColorForRatio(ratio);
  const highlight = brightenShieldColor(color);
  const lineWidth = 4.5 * (0.72 + ratio * 0.28);
  const ringAlpha = 0.22 + ratio * 0.4;

  gfx.circle(0, 0, radius);
  gfx.fill({ color, alpha: 0.015 + ratio * 0.045 });
  gfx.circle(0, 0, radius);
  gfx.stroke({ width: lineWidth, color, alpha: ringAlpha });

  // Fixed highlight arc : a station never rotates, so a stable bearing reads
  // as a facet of the field rather than as flicker.
  const phase = -Math.PI * 0.75;
  gfx.moveTo(Math.cos(phase) * radius, Math.sin(phase) * radius);
  gfx.arc(0, 0, radius, phase, phase + Math.PI * 0.42);
  gfx.stroke({ width: Math.max(1, lineWidth * 0.48), color: highlight, alpha: Math.min(0.9, ringAlpha + 0.18) });
}

// The station's engagement envelope, drawn with the same dashed ring ships use
// for their maximum weapon range so the two read as the same piece of
// information. Only shown for the station being inspected : seven of these on
// screen at once would be unreadable.
function drawStationRangeRing(gfx, station, zoom) {
  const range = Number(station.weaponRange) || 0;
  if (range <= 0) return;
  const dashLen = 6 / zoom;
  const gapLen = 10 / zoom;
  const circumference = Math.PI * 2 * range;
  const dashCount = Math.min(160, Math.max(8, Math.floor(circumference / (dashLen + gapLen))));
  const dashAngle = (Math.PI * 2) / dashCount;
  const dashArc = dashAngle * (dashLen / (dashLen + gapLen));
  for (let i = 0; i < dashCount; i += 1) {
    const startAngle = i * dashAngle;
    gfx.moveTo(Math.cos(startAngle) * range, Math.sin(startAngle) * range);
    gfx.arc(0, 0, range, startAngle, startAngle + dashArc);
  }
  gfx.stroke({ width: 1.25 / zoom, color: "rgba(255,202,87,0.22)" });
}

// --- Exterior shell ----------------------------------------------------------
// This IS the station: the whole structure is drawn as vector art, traced
// around the footprint measured from the authored design (stationLocalBounds),
// so it can never drift away from the collision geometry the server built.
//
// The baked component grid is deliberately NOT drawn. 176 designer-coloured
// module tiles blown up to 2.8x read as an enormous blueprint rather than a
// building, and none of that interior detail is actionable : a station is not
// a ship you refit. Only the weapons keep their real component art, on their
// real hardpoints, because those are the parts a player has to read and shoot.

const HULL_BASE = "#0e131a";      // sealed interior decking : the darkest mass
const BELT_FILL = "#232c39";      // outer armour belt, a clear step lighter
const PLATE_FILL = "#323d4c";     // raised plating: bastions, housings, doors
const METAL = "#4a5769";          // exposed structure: ribs, radiator fins
const SEAM = "rgba(255,255,255,0.09)";
const RECESS_FILL = "#020710";    // open space: the three launch corridors
const GUN_WELL = "#0b0f15";       // the socket a battery sits in

// The solid outline of a station: the footprint rectangle with chamfered
// corners and one recessed notch for each authored launch corridor.
function shellOutline(bounds, bays, chamfer) {
  const { minX, maxX, minY, maxY } = bounds;
  const points = [];
  for (const bay of [...(bays || [])].sort((a, b) => a.centreY - b.centreY)) {
    points.push({ x: maxX, y: bay.centreY - bay.halfWidth });
    points.push({ x: bay.rearWallX, y: bay.centreY - bay.halfWidth });
    points.push({ x: bay.rearWallX, y: bay.centreY + bay.halfWidth });
    points.push({ x: maxX, y: bay.centreY + bay.halfWidth });
  }
  points.push({ x: maxX, y: maxY - chamfer });
  points.push({ x: maxX - chamfer, y: maxY });
  points.push({ x: minX + chamfer, y: maxY });
  points.push({ x: minX, y: maxY - chamfer });
  points.push({ x: minX, y: minY + chamfer });
  points.push({ x: minX + chamfer, y: minY });
  points.push({ x: maxX - chamfer, y: minY });
  points.push({ x: maxX, y: minY + chamfer });
  return points;
}

function tracePolygon(gfx, points) {
  gfx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) gfx.lineTo(points[i].x, points[i].y);
  gfx.closePath();
}

function insetBounds(bounds, inset) {
  return {
    minX: bounds.minX + inset,
    maxX: bounds.maxX - inset,
    minY: bounds.minY + inset,
    maxY: bounds.maxY - inset
  };
}

function regularPolygon(radius, sides, rotation = 0) {
  const points = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = rotation + (i / sides) * Math.PI * 2;
    points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return points;
}

function stationLocalToWorld(station, point) {
  const angle = Number(station?.angle) || 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: (Number(station?.x) || 0) + point.x * cos - point.y * sin,
    y: (Number(station?.y) || 0) + point.x * sin + point.y * cos
  };
}

function drawStationCoverPolygon(gfx, station, points) {
  if (!gfx || points.length === 0) return;
  const first = stationLocalToWorld(station, points[0]);
  gfx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i += 1) {
    const point = stationLocalToWorld(station, points[i]);
    gfx.lineTo(point.x, point.y);
  }
  gfx.closePath();
}

function drawStationHangarCovers(gfx, station, bounds, accent) {
  if (!gfx || station?.stationType !== "home") return;
  const scale = Number(station.moduleScale) || 56;
  const lit = trimAlpha(station.state, 1);
  const covers = stationHangarCoverGeometry(station, bounds);
  for (const cover of covers) {
    if (!(cover.coverEndX > cover.coverStartX)) continue;
    const lip = scale * 0.38;
    const points = [
      { x: cover.coverStartX, y: cover.coverTopY },
      { x: cover.coverEndX - lip, y: cover.coverTopY },
      { x: cover.coverEndX, y: cover.coverTopY + scale * 0.24 },
      { x: cover.coverEndX, y: cover.coverBottomY },
      { x: cover.coverEndX - lip, y: cover.coverBottomY },
      { x: cover.coverStartX, y: cover.coverBottomY }
    ];
    drawStationCoverPolygon(gfx, station, points);
    gfx.fill({ color: HANGAR_COVER_FILL, alpha: 1 });
    gfx.stroke({ width: scale * 0.09, color: accent, alpha: lit * 0.72 });

    // Short ribs sell the canopy as a physical overhang while keeping the
    // cover visibly cosmetic over the ship underneath.
    for (const ratio of [0.34, 0.67]) {
      const x = cover.coverStartX + (cover.coverEndX - cover.coverStartX) * ratio;
      const top = stationLocalToWorld(station, { x, y: cover.coverTopY + scale * 0.12 });
      const bottom = stationLocalToWorld(station, { x, y: cover.coverBottomY - scale * 0.06 });
      gfx.moveTo(top.x, top.y);
      gfx.lineTo(bottom.x, bottom.y);
    }
    gfx.stroke({ width: scale * 0.06, color: accent, alpha: lit * 0.38 });

    const frontTop = stationLocalToWorld(station, { x: cover.coverEndX, y: cover.coverTopY + scale * 0.24 });
    const frontBottom = stationLocalToWorld(station, { x: cover.coverEndX, y: cover.coverBottomY });
    gfx.moveTo(frontTop.x, frontTop.y);
    gfx.lineTo(frontBottom.x, frontBottom.y);
    gfx.stroke({ width: scale * 0.13, color: accent, alpha: lit * 0.72 });
  }
}

// A destroyed hull is unlit and a neutral one has no allegiance to advertise,
// so the accent trim carries the station's state without a second colour scheme.
function trimAlpha(state, lit) {
  if (state === "destroyed") return lit * 0.25;
  // An uncaptured relay is unlit: nobody is running it.
  if (state === "neutral") return lit * 0.55;
  return lit;
}

// The socket each battery sits in. The turret sprites are drawn on top of these
// at exactly the same hardpoints, so every gun reads as mounted rather than
// floating on the plating.
function drawGunMounts(gfx, station, accent, alpha, radius) {
  const hardpoints = station.hardpoints;
  if (!Array.isArray(hardpoints)) return;
  for (let i = 0; i < hardpoints.length; i += 1) {
    const mount = hardpoints[i];
    if (!mount) continue;
    const destroyed = station.componentHp?.[i] <= 0;
    gfx.circle(mount.x, mount.y, radius);
    gfx.fill(PLATE_FILL);
    gfx.stroke({ width: radius * 0.16, color: accent, alpha: destroyed ? alpha * 0.3 : alpha });
    gfx.circle(mount.x, mount.y, radius * 0.66);
    gfx.fill(GUN_WELL);
  }
}

// Evenly spaced lights along a straight edge.
function drawEdgeLights(gfx, from, to, count, size, color, alpha) {
  for (let i = 1; i <= count; i += 1) {
    const t = i / (count + 1);
    gfx.circle(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, size);
    gfx.fill({ color, alpha });
  }
}

function drawHomeShell(gfx, station, bounds, accent, state) {
  const scale = Number(station.moduleScale) || 56;
  const bays = stationHangarBaysLocal(station, bounds);
  const chamfer = scale * 1.7;
  const beltWidth = scale * 1.5;
  const lit = trimAlpha(state, 1);

  // 1. Hull silhouette : the armour belt colour, since the belt is the edge.
  const outline = shellOutline(bounds, bays, chamfer);
  tracePolygon(gfx, outline);
  gfx.fill(BELT_FILL);
  gfx.stroke({ width: scale * 0.16, color: accent, alpha: lit * 0.9 });

  // 2. Sealed interior decking inside the belt. Keep a small, even frame around
  //    each notch without swallowing the single-cell dividing walls.
  const deckBounds = insetBounds(bounds, beltWidth);
  let wallGap = Infinity;
  for (let i = 1; i < bays.length; i += 1) {
    wallGap = Math.min(wallGap, (bays[i].centreY - bays[i].halfWidth)
      - (bays[i - 1].centreY + bays[i - 1].halfWidth));
  }
  const bayBelt = Math.min(beltWidth, Number.isFinite(wallGap) ? wallGap * 0.35 : beltWidth);
  const deckBays = bays.map((bay) => ({
    ...bay,
    halfWidth: bay.halfWidth + bayBelt,
    rearWallX: bay.rearWallX + beltWidth
  }));
  tracePolygon(gfx, shellOutline(deckBounds, deckBays, chamfer * 0.7));
  gfx.fill(HULL_BASE);
  gfx.stroke({ width: scale * 0.07, color: METAL, alpha: 0.35 });

  // Panel-line grid across the decking, so it is plated rather than empty.
  for (let x = deckBounds.minX + scale * 2; x < deckBounds.maxX; x += scale * 2) {
    gfx.moveTo(x, deckBounds.minY);
    gfx.lineTo(x, deckBounds.maxY);
  }
  for (let y = deckBounds.minY + scale * 2; y < deckBounds.maxY; y += scale * 2) {
    gfx.moveTo(deckBounds.minX, y);
    gfx.lineTo(deckBounds.maxX, y);
  }
  gfx.stroke({ width: scale * 0.04, color: METAL, alpha: 0.18 });

  // 3. Plate seams cut across the belt so it reads as bolted sections rather
  //    than one extruded ring.
  const seamCount = 7;
  for (let i = 1; i < seamCount; i += 1) {
    const t = i / seamCount;
    const y = bounds.minY + (bounds.maxY - bounds.minY) * t;
    gfx.moveTo(bounds.minX, y);
    gfx.lineTo(bounds.minX + beltWidth, y);
    gfx.moveTo(bounds.maxX, y);
    gfx.lineTo(bounds.maxX - beltWidth, y);
    const x = bounds.minX + (bounds.maxX - bounds.minX) * t;
    gfx.moveTo(x, bounds.minY);
    gfx.lineTo(x, bounds.minY + beltWidth);
    gfx.moveTo(x, bounds.maxY);
    gfx.lineTo(x, bounds.maxY - beltWidth);
  }
  gfx.stroke({ width: scale * 0.06, color: SEAM, alpha: 1 });

  // 4. Structural spine in the rear body. It stops at the authored rear walls,
  // leaving each launch corridor visibly recessed rather than connected to
  // empty space.
  const centreBay = bays[Math.floor(bays.length / 2)];
  const spineY = centreBay ? centreBay.halfWidth + scale * 0.55 : (bounds.maxY - bounds.minY) * 0.25;
  const spineEnd = centreBay ? centreBay.rearWallX : bounds.maxX - beltWidth;
  for (const sy of [-1, 1]) {
    gfx.rect(deckBounds.minX, sy * spineY - scale * 0.16, spineEnd - deckBounds.minX, scale * 0.32);
  }
  gfx.fill(METAL);
  for (let i = 1; i <= 4; i += 1) {
    const x = deckBounds.minX + (spineEnd - deckBounds.minX) * (i / 5);
    gfx.moveTo(x, -spineY);
    gfx.lineTo(x, spineY);
  }
  gfx.stroke({ width: scale * 0.1, color: METAL, alpha: 0.45 });

  // 5. A restrained set of radiator banks along both flanks. Drawn as fin
  //    stacks: cold metal ribs with a warm glow between them.
  for (const sy of [-1, 1]) {
    const y = sy * (bounds.maxY - beltWidth * 0.5);
    for (let bank = 0; bank < 3; bank += 1) {
      const x0 = bounds.minX + chamfer + (deckBounds.maxX - bounds.minX - chamfer) * (bank / 3);
      gfx.rect(x0, y - scale * 0.3, scale * 1.6, scale * 0.6);
      gfx.fill(HULL_BASE);
      for (let fin = 0; fin < 5; fin += 1) {
        const fx = x0 + scale * 0.16 + fin * scale * 0.32;
        gfx.moveTo(fx, y - scale * 0.24);
        gfx.lineTo(fx, y + scale * 0.24);
      }
      gfx.stroke({ width: scale * 0.11, color: METAL, alpha: 0.9 });
    }
  }

  // 6. Corner bastions: the heavy blocks the outboard batteries stand on.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const cx = sx > 0 ? bounds.maxX - chamfer * 0.6 : bounds.minX + chamfer * 0.6;
      const cy = sy > 0 ? bounds.maxY - chamfer * 0.6 : bounds.minY + chamfer * 0.6;
      gfx.regularPoly(cx, cy, chamfer * 0.55, 6, Math.PI / 6);
      gfx.fill(PLATE_FILL);
      gfx.stroke({ width: scale * 0.08, color: accent, alpha: lit * 0.7 });
    }
  }

  // 7. Reactor housing over the authored core, at the rear centreline: an
  //    armoured drum with cooling vanes and a small lit aperture. Kept modest :
  //    a big saturated disc here reads as a bullseye from across the arena.
  const reactorX = bounds.minX * 0.4;
  const reactorR = scale * 1.35;
  gfx.circle(reactorX, 0, reactorR);
  gfx.fill(PLATE_FILL);
  gfx.stroke({ width: scale * 0.09, color: accent, alpha: lit * 0.65 });
  for (let i = 0; i < 10; i += 1) {
    const angle = (i / 10) * Math.PI * 2 + Math.PI / 20;
    gfx.moveTo(reactorX + Math.cos(angle) * reactorR * 0.5, Math.sin(angle) * reactorR * 0.5);
    gfx.lineTo(reactorX + Math.cos(angle) * reactorR * 0.95, Math.sin(angle) * reactorR * 0.95);
  }
  gfx.stroke({ width: scale * 0.08, color: METAL, alpha: 0.55 });
  gfx.circle(reactorX, 0, reactorR * 0.38);
  gfx.fill(HULL_BASE);
  gfx.circle(reactorX, 0, reactorR * 0.24);
  gfx.fill({ color: accent, alpha: stationIsPowered(state) ? 0.85 : 0.2 });

  // 8. Running lights along the outer edge.
  const lightSize = scale * 0.13;
  drawEdgeLights(gfx, { x: bounds.minX + chamfer, y: bounds.minY }, { x: bounds.maxX - chamfer, y: bounds.minY }, 5, lightSize, accent, lit * 0.9);
  drawEdgeLights(gfx, { x: bounds.minX + chamfer, y: bounds.maxY }, { x: bounds.maxX - chamfer, y: bounds.maxY }, 5, lightSize, accent, lit * 0.9);
  drawEdgeLights(gfx, { x: bounds.minX, y: bounds.minY + chamfer }, { x: bounds.minX, y: bounds.maxY - chamfer }, 4, lightSize, accent, lit * 0.9);

  // 9. Three genuine launch voids. Each corridor has one straight pair of
  // guide strips, a centreline and outward-pointing approach chevrons, plus
  // one complete rear-body tile.
  for (const bay of bays) {
    const lane = {
      halfWidth: bay.halfWidth,
      rampDepth: Math.min(bay.length * 0.4, scale * 2.5),
      centreY: bay.centreY,
      mouthX: bay.mouthX,
      innerX: bay.rearWallX
    };
    gfx.rect(lane.innerX, lane.centreY - lane.halfWidth, bay.length, lane.halfWidth * 2);
    gfx.fill(RECESS_FILL);

    const rampStartX = lane.mouthX - lane.rampDepth;
    const rampEndX = lane.mouthX - scale * 0.45;
    for (const side of [-1, 1]) {
      const y = lane.centreY + side * (lane.halfWidth - scale * 0.3);
      gfx.moveTo(rampStartX, y);
      gfx.lineTo(rampEndX, y);
    }
    gfx.stroke({ width: scale * 0.18, color: accent, alpha: stationIsPowered(state) ? 0.9 : 0.25 });

    gfx.moveTo(rampStartX, lane.centreY + scale * 0.04);
    gfx.lineTo(rampEndX, lane.centreY + scale * 0.04);
    gfx.stroke({ width: scale * 0.12, color: accent, alpha: stationIsPowered(state) ? 0.45 : 0.12 });

    // Approach arrows on the corridor floor, pointing out through the mouth.
    // Keep the historical three markers for every authored bay.
    for (let i = 0; i < 3; i += 1) {
      const x = lane.innerX + bay.length * (0.3 + i * 0.2);
      gfx.moveTo(x, lane.centreY - lane.halfWidth * 0.34);
      gfx.lineTo(x + scale * 0.7, lane.centreY);
      gfx.lineTo(x, lane.centreY + lane.halfWidth * 0.34);
    }
    gfx.stroke({ width: scale * 0.12, color: accent, alpha: lit * 0.3 });

    // One complete rear-body tile closes the corridor visually. It is the same
    // scale-wide solid tile represented by the server's rear collision piece.
    gfx.rect(lane.innerX - scale, lane.centreY - lane.halfWidth, scale, lane.halfWidth * 2);
    gfx.fill(PLATE_FILL);
    gfx.stroke({ width: scale * 0.07, color: accent, alpha: lit * 0.8 });

    const doorX = lane.mouthX - scale * 0.55;
    gfx.moveTo(doorX, lane.centreY + lane.halfWidth);
    gfx.lineTo(doorX, lane.centreY - lane.halfWidth);
    gfx.stroke({ width: scale * 0.42, color: PLATE_FILL, alpha: lit });
  }

  // 10. Gun sockets, drawn last so nothing overlaps them.
  drawGunMounts(gfx, station, accent, lit, scale * 0.62);
}

function drawRelayShell(gfx, station, bounds, accent, state) {
  const scale = Number(station.moduleScale) || 20;
  const half = Math.max(bounds.maxX, bounds.maxY);
  const chamfer = scale * 1.7;
  const beltWidth = scale * 1.3;
  const lit = trimAlpha(state, 1);

  // Antenna masts on the diagonals, reaching clear of the corners. Drawn first
  // so the armoured body sits on top of them.
  for (const point of regularPolygon(half * 1.95, 4, Math.PI / 4)) {
    gfx.moveTo(point.x * 0.42, point.y * 0.42);
    gfx.lineTo(point.x, point.y);
    gfx.stroke({ width: scale * 0.22, color: METAL, alpha: 1 });
    gfx.moveTo(point.x - point.y * 0.18, point.y + point.x * 0.18);
    gfx.lineTo(point.x + point.y * 0.18, point.y - point.x * 0.18);
    gfx.stroke({ width: scale * 0.16, color: accent, alpha: lit * 0.8 });
    gfx.circle(point.x, point.y, scale * 0.24);
    gfx.fill({ color: accent, alpha: stationIsPowered(state) ? 0.95 : 0.3 });
  }

  // Hull: armour belt, then sealed decking inside it.
  tracePolygon(gfx, shellOutline(bounds, null, chamfer));
  gfx.fill(BELT_FILL);
  gfx.stroke({ width: scale * 0.26, color: accent, alpha: lit * 0.9 });
  const relayDeck = insetBounds(bounds, beltWidth);
  tracePolygon(gfx, shellOutline(relayDeck, null, chamfer * 0.7));
  gfx.fill(HULL_BASE);
  gfx.stroke({ width: scale * 0.1, color: METAL, alpha: 0.35 });

  // Panel lines on the decking.
  for (let x = relayDeck.minX + scale * 1.6; x < relayDeck.maxX; x += scale * 1.6) {
    gfx.moveTo(x, relayDeck.minY);
    gfx.lineTo(x, relayDeck.maxY);
  }
  for (let y = relayDeck.minY + scale * 1.6; y < relayDeck.maxY; y += scale * 1.6) {
    gfx.moveTo(relayDeck.minX, y);
    gfx.lineTo(relayDeck.maxX, y);
  }
  gfx.stroke({ width: scale * 0.06, color: METAL, alpha: 0.2 });

  // Belt seams.
  for (let i = 1; i < 4; i += 1) {
    const t = i / 4;
    const y = bounds.minY + (bounds.maxY - bounds.minY) * t;
    gfx.moveTo(bounds.minX, y);
    gfx.lineTo(bounds.minX + beltWidth, y);
    gfx.moveTo(bounds.maxX, y);
    gfx.lineTo(bounds.maxX - beltWidth, y);
    const x = bounds.minX + (bounds.maxX - bounds.minX) * t;
    gfx.moveTo(x, bounds.minY);
    gfx.lineTo(x, bounds.minY + beltWidth);
    gfx.moveTo(x, bounds.maxY);
    gfx.lineTo(x, bounds.maxY - beltWidth);
  }
  gfx.stroke({ width: scale * 0.1, color: SEAM, alpha: 1 });

  // The transmitter this whole structure exists to hold.
  gfx.circle(0, 0, half * 0.4);
  gfx.fill(PLATE_FILL);
  gfx.stroke({ width: scale * 0.14, color: accent, alpha: lit * 0.85 });
  gfx.circle(0, 0, half * 0.24);
  gfx.fill({ color: accent, alpha: stationIsPowered(state) ? 0.8 : 0.16 });
  // Dish sweep, so the relay has a readable front even though it never turns.
  gfx.arc(0, 0, half * 0.32, -Math.PI * 0.38, Math.PI * 0.38);
  gfx.stroke({ width: scale * 0.2, color: accent, alpha: lit * 0.9 });

  drawGunMounts(gfx, station, accent, lit, scale * 0.62);
}

// Dispatch: both station kinds draw from their own measured footprint, so the
// shell can never disagree with the collision geometry the server built.
function rebuildStationShell(view, station, color) {
  const gfx = view.shellGfx;
  gfx.clear();
  const accent = color || NEUTRAL_COLOR;
  const bounds = stationLocalBounds(station);
  if (station.stationType === "home") drawHomeShell(gfx, station, bounds, accent, station.state);
  else drawRelayShell(gfx, station, bounds, accent, station.state);
}

// Health and shield bars plus the selection ring.
function rebuildStationHud(env, view, station, color, zoom, selected, barY) {
  const gfx = view.hudGfx;
  gfx.clear();
  const bounds = stationLocalBounds(station);
  // Bars span the structure they belong to, so a home station's readout is not
  // the same width as a relay's.
  const width = Math.max(70, (bounds.maxX - bounds.minX) * 0.75);
  const height = Math.max(5, 6 / zoom);
  const shieldHeight = 3.5 / zoom;
  const gap = 2 / zoom;
  const shieldY = barY - shieldHeight - gap;
  const left = -width / 2;

  // A station whose condition the sensor snapshot withheld has no hp/maxHp at
  // all. Drawing the bars anyway would render a permanently empty red bar and
  // report an enemy station as nearly dead, so the readout is omitted instead.
  const conditionKnown = Number(station.maxHp) > 0;
  const hpRatio = conditionKnown ? Math.max(0, Math.min(1, station.hp / station.maxHp)) : 0;
  const shieldRatio = station.maxShield > 0 ? Math.max(0, Math.min(1, station.shield / station.maxShield)) : 0;

  if (!conditionKnown) {
    drawSelectionBracket(gfx, station, bounds, zoom, selected);
    return;
  }

  // HP bar with ship-style gradient; shield bar above with a small gap.
  gfx.rect(left, barY, width, height);
  gfx.fill("rgba(2,10,18,0.85)");
  if (hpRatio > 0) {
    const hpColor = hullColorForRatio(hpRatio);
    const hpGradient = getPixiBarGradient(env, `station-hp-${hpColor.start}-${hpColor.end}`, [{ offset: 0, color: hpColor.start }, { offset: 1, color: hpColor.end }], false);
    gfx.rect(left, barY, width * hpRatio, height);
    gfx.fill(hpGradient);
    gfx.rect(left, barY, width * hpRatio, height * 0.45);
    gfx.fill("rgba(255,255,255,0.14)");
  }
  if (shieldRatio > 0) {
    gfx.rect(left, shieldY, width * shieldRatio, shieldHeight);
    gfx.fill("#22d3ee");
  }
  gfx.rect(left, barY, width, height);
  gfx.stroke({ width: 1 / zoom, color: "rgba(255,255,255,0.35)" });
  if (shieldRatio > 0) {
    gfx.rect(left, shieldY, width, shieldHeight);
    gfx.stroke({ width: 1 / zoom, color: "rgba(125,211,252,0.35)" });
  }

  drawSelectionBracket(gfx, station, bounds, zoom, selected);
}

// A bracket around the real footprint rather than a circle around the
// broad-phase radius, which on a square station sits 40% too far out.
// The HUD layer is world-aligned, so the corners are rotated by hand.
function drawSelectionBracket(gfx, station, bounds, zoom, selected) {
  if (!selected) return;
  const angle = Number(station.angle) || 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const at = (x, y) => ({ x: x * cos - y * sin, y: x * sin + y * cos });
  const pad = 14 / zoom;
  const arm = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.22;
  const left = bounds.minX - pad;
  const right = bounds.maxX + pad;
  const top = bounds.minY - pad;
  const bottom = bounds.maxY + pad;
  for (const [cx, cy, dx, dy] of [[left, top, 1, 1], [right, top, -1, 1], [right, bottom, -1, -1], [left, bottom, 1, -1]]) {
    const start = at(cx + dx * arm, cy);
    const corner = at(cx, cy);
    const end = at(cx, cy + dy * arm);
    gfx.moveTo(start.x, start.y);
    gfx.lineTo(corner.x, corner.y);
    gfx.lineTo(end.x, end.y);
  }
  gfx.stroke({ width: 3 / zoom, color: "#ffffff", alpha: 0.8 });
}

// The oldest queued purchase, if any. The label stays generic and exposes only
// the number of hulls waiting for a hangar.
function launchQueueSummary(station) {
  const queue = station.productionQueue;
  if (!Array.isArray(queue) || queue.length === 0) return { label: "" };
  const item = queue[0];
  const remaining = Math.max(1, Number(item.quantityRemaining) || 1);
  const queueSuffix = queue.length > 1 ? ` (+${queue.length - 1})` : "";
  const countSuffix = remaining > 1 ? ` x${remaining}` : "";
  return { label: `WAITING FOR HANGAR${countSuffix}${queueSuffix}` };
}

function hangarGeometrySignature(station) {
  const bays = Array.isArray(station?.hangars) ? station.hangars : [];
  return bays.map((bay, index) => [
    bay?.id || index,
    Math.round(Number(bay?.centreY ?? bay?.localCentre?.y) || 0),
    Math.round(Number(bay?.apertureHalfWidth) || 0),
    Math.round(Number(bay?.corridorLength || bay?.corridorDepth) || 0),
    Number(bay?.localNormal?.x) || 0,
    Number(bay?.localNormal?.y) || 0
  ].join(":")).join(",");
}

// Quantise zoom so small changes do not rebuild station aura / HUD geometry.
const ZOOM_BUCKET_STEPS = 40;
function zoomBucketFor(zoom) { return Math.round(zoom * ZOOM_BUCKET_STEPS) / ZOOM_BUCKET_STEPS; }

export function updatePixiStations(env, now, players, bounds) {
  const stations = state.snapshot?.stations;
  if (!Array.isArray(stations) || stations.length === 0) {
    if (pixiStationPool) {
      pixiStationPool.frameStart();
      pixiStationPool.frameEnd();
    }
    return;
  }
  if (!pixiStationPool) pixiStationPool = createPixiKeyedPool(env.layers.stations, () => createPixiStationView(env));
  pixiStationPool.frameStart();

  const zoom = state.camera.zoom;
  const zoomKey = zoomBucketFor(zoom);
  for (const station of stations) {
    // Culling uses the aura extent, not the hull: a home station's repair ring
    // and a relay's capture ring are meaningful long before the structure
    // itself is on screen.
    const auraRadius = station.stationType === "home"
      ? Math.max(Number(station.radius) || 0, Number(HOME_STATION.repairRadius) || 0)
      : Math.max(Number(RELAY_STATION.captureRadius) || 0, Number(station.radius) || 0);
    if (bounds && !isCircleVisible(station.x, station.y, auraRadius, bounds)) continue;

    const view = pixiStationPool.acquire(station.id);
    const color = stationColor(station, players);
    const selected = state.selectedStationId === station.id;

    view.root.position.set(station.x, station.y);
    view.auraGfx.rotation = Number(station.angle) || 0;
    view.auraGfx.visible = true;
    view.root.visible = true;

    const stationDebug = isStationDebugEnabled();
    const captureStep = Math.round((station.captureProgress || 0) * 100);
    const auraSignature = `${station.stationType}|${station.state}|${color}|${zoomKey}|${stationDebug ? 1 : 0}|${captureStep}|${station.captureTeam || ""}|${station.captureContested ? 1 : 0}|${selected ? 1 : 0}|${Math.round(station.weaponRange || 0)}`;
    if (view.auraSignature !== auraSignature) {
      view.auraSignature = auraSignature;
      rebuildStationAura(view, station, color, zoom, stationDebug, captureStep, selected);
    }

    const localBounds = stationLocalBounds(station);
    const cornerReach = Math.hypot(
      Math.max(Math.abs(localBounds.minX), Math.abs(localBounds.maxX)),
      Math.max(Math.abs(localBounds.minY), Math.abs(localBounds.maxY))
    );
    const bodyVisible = !bounds || isCircleVisible(station.x, station.y, cornerReach, bounds);

    view.shellGfx.visible = bodyVisible;
    view.shieldGfx.visible = bodyVisible;
    view.hudGfx.visible = bodyVisible;
    view.turretContainer.visible = bodyVisible;
    view.stateText.visible = bodyVisible;
    view.queueText.visible = false;
    if (view.coverGfx) view.coverGfx.visible = false;

    if (bodyVisible) {
      view.shellGfx.rotation = Number(station.angle) || 0;
      if (view.turretContainerWorldSpace) view.turretContainer.position.set(station.x, station.y);
      else view.turretContainer.position.set(0, 0);
      view.turretContainer.rotation = Number(station.angle) || 0;

      // Weapon art only. The station's interior components are never baked or
      // drawn : see the shell section : so the only sprites here are the turrets,
      // on the hardpoints the server fires from. Absent design (a compact
      // snapshot received before any full one) leaves the view empty rather than
      // inventing a placeholder.
      const design = station.design;
      if (Array.isArray(design) && design.length > 0) {
        const turretSignature = `${station.stationType}|${design.length}|${env.bakeScale}|${getPixiBakeGeneration()}|${station.hardpoints ? 1 : 0}`;
        if (view.turretSignature !== turretSignature) {
          view.turretSignature = turretSignature;
          rebuildStationTurrets(env, view, station);
        }
        // A destroyed battery keeps its barrel on the structure : it is wreckage,
        // not a hole : but stops tracking and goes dark. `componentHp` is rounded
        // to a tenth in the snapshot, so only a true zero counts as destroyed.
        for (const sprite of view.turretSprites) {
          const hp = station.componentHp?.[sprite.__designIndex];
          const dead = hp !== undefined && hp <= 0;
          const operational = stationIsPowered(station.state);
          sprite.rotation = authoritativeWeaponAngle(station, sprite.__designIndex) || 0;
          sprite.visible = true;
          sprite.alpha = dead ? 0.28 : (operational ? 1 : 0.45);
        }
      }
      view.turretContainer.visible = true;
      view.turretContainer.alpha = 1;
      view.shellGfx.alpha = 1;

      // The shell draws a socket per battery, so it has to rebuild when a battery
      // is destroyed. Only the weapon indices matter, not all 176 components.
      if (
        view.destroyedMountComponentRevision !== station.componentDamageRevision
        || view.destroyedMountHardpoints !== station.hardpoints
      ) {
        let destroyedMounts = "";
        if (Array.isArray(station.hardpoints)) {
          for (let i = 0; i < station.hardpoints.length; i += 1) {
            if (station.hardpoints[i] && station.componentHp?.[i] <= 0) destroyedMounts += `${i},`;
          }
        }
        view.destroyedMounts = destroyedMounts;
        view.destroyedMountComponentRevision = station.componentDamageRevision;
        view.destroyedMountHardpoints = station.hardpoints;
      }
      const destroyedMounts = view.destroyedMounts || "";
      const shellSignature = `${station.stationType}|${color}|${station.state}|${station.design?.length || 0}|${Math.round(station.moduleScale || 0)}|${hangarGeometrySignature(station)}|${destroyedMounts}`;
      if (view.shellSignature !== shellSignature) {
        view.shellSignature = shellSignature;
        rebuildStationShell(view, station, color);
      }

      if (view.coverGfx) {
        view.coverGfx.visible = station.stationType === "home";
        const coverSignature = `${station.x.toFixed(1)}|${station.y.toFixed(1)}|${(station.angle || 0).toFixed(3)}|${color}|${station.state}|${hangarGeometrySignature(station)}`;
        if (view.coverSignature !== coverSignature) {
          view.coverSignature = coverSignature;
          view.coverGfx.clear();
          drawStationHangarCovers(view.coverGfx, station, localBounds, color);
        }
      }

      // Quantised so a regenerating shield does not rebuild the ring every frame.
      const shieldSignature = `${Math.round((station.maxShield > 0 ? station.shield / station.maxShield : 0) * 200)}|${Math.round(localBounds.maxX)}|${Math.round(Number(station.shieldRadius) || 0)}`;
      if (view.shieldSignature !== shieldSignature) {
        view.shieldSignature = shieldSignature;
        rebuildStationShield(view, station, localBounds);
      }

      const queue = station.stationType === "home" ? launchQueueSummary(station) : { label: "" };

      // The HUD is world-aligned while the structure is rotated, so the bars have
      // to clear the station's circumscribed extent, not its local height.
      const barY = Math.max(36, cornerReach + 14 / zoom);
      const hudSignature = [
        zoomKey, color, station.state, selected ? 1 : 0,
        Math.round(station.hp), Math.round(station.maxHp),
        Math.round(station.shield), Math.round(station.maxShield), Math.round(barY)
      ].join("|");
      if (view.hudSignature !== hudSignature) {
        view.hudSignature = hudSignature;
        rebuildStationHud(env, view, station, color, zoom, selected, barY);
      }

      const labelScale = Math.max(1, 1 / zoom);
      let stateLabel = stationStateLabel(station);
      if (station.ownerId && station.ownerId !== state.myId) {
        const owner = players?.get?.(station.ownerId);
        if (owner) stateLabel += ` : ${owner.name || owner.team || ""}`;
      } else if (station.team) {
        stateLabel += ` : ${station.team === "blue" ? "Blue" : station.team === "red" ? "Red" : station.team}`;
      }
      if (station.stationType === "relay" && !selected && (station.captureProgress || 0) > 0) {
        stateLabel += ` (${Math.round((station.captureProgress || 0) * 100)}%)`;
      }
      if (station.stationType === "relay" && station.state === "recovering") {
        stateLabel += ` (${Math.round(((station.hp || 0) / Math.max(1, station.maxHp || 0)) * 100)}%)`;
      }
      if (view.stateLabel !== stateLabel) {
        view.stateLabel = stateLabel;
        view.stateText.text = stateLabel;
      }
      const stateFill = station.state === "destroyed" ? "#ffb4b4" : "#ffffff";
      if (view.stateText.style.fill !== stateFill) view.stateText.style.fill = stateFill;
      view.stateText.scale.set(labelScale);
      view.stateText.position.set(0, barY + 18 / zoom);
      view.stateText.visible = true;

      if (view.queueLabel !== queue.label) {
        view.queueLabel = queue.label;
        view.queueText.text = queue.label;
      }
      view.queueText.visible = queue.label.length > 0;
      view.queueText.scale.set(labelScale);
      view.queueText.position.set(0, barY + 32 / zoom);
    }
  }

  pixiStationPool.frameEnd();
}

export function destroyPixiStations() {
  if (pixiStationPool) {
    pixiStationPool.destroy();
    pixiStationPool = null;
  }
}

export function pixiStationViewCount() {
  return pixiStationPool ? pixiStationPool.activeCount() : 0;
}

// Read-only view lookup for renderer diagnostics and browser tests.
export function stationLocalBoundsForTest(station) {
  return stationLocalBounds(station);
}

export function stationHangarLocalForTest(station) {
  return stationHangarBaysLocal(station, stationLocalBounds(station));
}

export function stationHangarCoverLocalForTest(station) {
  return stationHangarCoverGeometry(station, stationLocalBounds(station));
}

export function stationShellOutlineForTest(station) {
  const bounds = stationLocalBounds(station);
  const bays = stationHangarBaysLocal(station, bounds);
  const scale = Number(station.moduleScale) || (station.stationType === "home" ? 56 : SHIP_SCALE);
  return shellOutline(bounds, bays, scale * 1.7);
}

export function peekPixiStationView(stationId) {
  return pixiStationPool ? pixiStationPool.peek(stationId) : null;
}
