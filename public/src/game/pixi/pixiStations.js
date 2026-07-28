// Station rendering for the PixiJS arena renderer (station infrastructure mode).
//
// Stations are authoritative component structures, so their hull art comes from
// exactly the same baked-design pipeline ships use (acquireHullLease); nothing
// about their appearance is re-invented here. Everything else drawn per station
// is state, not geometry: a health/shield bar, the state badge, the home
// station's repair aura and hangar corridor, the relay's capture ring, and the
// build progress of the item currently in the hangar.
//
// Stations never rotate at runtime and have no turret sprites of their own, so
// the whole view is one sprite plus two Graphics and two Text objects. All of
// them are signature-gated: an idle station costs no draw-call rebuilds.

import { state } from "../../state.js";
import { GENERATED_BALANCE } from "../../generatedBalance.js";
import { isCircleVisible } from "../viewportCulling.js";
import { createPixiKeyedPool, getPixiBakeGeneration, swapTextureLease } from "./pixiBake.js";
import { SHIP_SCALE, acquireHullLease, acquireTurretLease } from "./pixiShipView.js";
import { footprintLocalPlacement } from "../shipGeometry.js";
import { isRotatingWeaponPart, authoritativeWeaponAngle } from "../weaponAim.js";

const INFRASTRUCTURE = GENERATED_BALANCE?.infrastructure || {};
const HOME_STATION = INFRASTRUCTURE.homeStation || {};
const RELAY_STATION = INFRASTRUCTURE.relayStation || {};

const NEUTRAL_COLOR = "#9fb0c6";
const FRIENDLY_COLOR = "#38d5ff";
const ENEMY_COLOR = "#ef4444";
const DISABLED_COLOR = "#6b7280";

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
  const myTeam = state.mine?.team;
  if (myTeam && station.team && station.team === myTeam) return FRIENDLY_COLOR;
  if (station.ownerId && station.ownerId === state.myId) return FRIENDLY_COLOR;
  return ENEMY_COLOR;
}

export function stationStateLabel(station) {
  if (!station) return "";
  if (station.state === "neutral") return "UNCLAIMED";
  if (station.state === "disabled") return "DISABLED";
  return station.stationType === "home" ? "OPERATIONAL" : "ONLINE";
}

// Stations are authored on the same 15x15 grid ships use, but are drawn at a
// larger module scale (the server sends it as `moduleScale`). The hull texture
// is baked by the shared ship pipeline at SHIP_SCALE and then scaled up, so
// station art needs no second baking path.
function stationScaleRatio(station) {
  const scale = Number(station.moduleScale);
  return Number.isFinite(scale) && scale > 0 ? scale / SHIP_SCALE : 1;
}

// Bake radius in SHIP_SCALE units — the extent the shared baker must cover
// before the sprite is scaled up.
function stationBakeRadius(station) {
  let maxCell = 0;
  for (const module of station.design || []) {
    maxCell = Math.max(maxCell, Math.abs((Number(module.x) || 0) - 7), Math.abs((Number(module.y) || 0) - 7));
  }
  return (maxCell + 1) * SHIP_SCALE;
}

function createPixiStationView(env) {
  const PIXI = env.PIXI;
  const root = new PIXI.Container();
  root.label = "StationRoot";

  const auraGfx = new PIXI.Graphics();
  auraGfx.label = "StationAura";
  const hullSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
  hullSprite.label = "StationHull";
  hullSprite.anchor.set(0.5);
  const hudGfx = new PIXI.Graphics();
  hudGfx.label = "StationHud";

  const makeText = (style) => {
    const text = new PIXI.Text({ text: "", style, resolution: 2 });
    text.anchor.set(0.5);
    return text;
  };
  const stateText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 13, fontWeight: "bold", fill: "#ffffff", stroke: { color: "rgba(0,0,0,0.7)", width: 3 } });
  const productionText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 12, fill: "#cfe3f5", stroke: { color: "rgba(0,0,0,0.7)", width: 3 } });

  const turretContainer = new PIXI.Container();
  turretContainer.label = "StationTurrets";
  turretContainer.position.set(0, 0);

  root.addChild(auraGfx);
  root.addChild(hullSprite);
  root.addChild(turretContainer);
  root.addChild(hudGfx);
  root.addChild(stateText);
  root.addChild(productionText);

  return {
    root,
    auraGfx,
    hullSprite,
    turretContainer,
    hudGfx,
    stateText,
    productionText,
    // Texture lease bookkeeping for swapTextureLease(): non-owning.
    lease: null,
    textureKey: null,
    auraSignature: "",
    hudSignature: "",
    turretSignature: "",
    turretSprites: [],
    turretsByDesignIndex: new Map(),
    stateLabel: null,
    productionLabel: null,
    release() {
      this.hullSprite.texture = env.PIXI.Texture.EMPTY;
      if (this.lease) {
        this.lease.release();
        this.lease = null;
      }
      this.textureKey = null;
      this.auraSignature = "";
      this.hudSignature = "";
      this.turretSignature = "";
      this.stateLabel = null;
      this.productionLabel = null;
      this.auraGfx.clear();
      this.hudGfx.clear();
      this.turretContainer.removeChildren();
      for (const sprite of this.turretSprites) {
        if (sprite.__lease) {
          sprite.__lease.release();
          sprite.__lease = null;
        }
        if (!sprite.destroyed) sprite.destroy({ children: false, texture: false, textureSource: false });
      }
      this.turretSprites = [];
      this.turretsByDesignIndex.clear();
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
    const place = footprintLocalPlacement(part, SHIP_SCALE);
    const lease = acquireTurretLease(env, part.type);
    const sprite = new env.PIXI.Sprite(lease.texture);
    sprite.label = `StationTurret[${i}] ${part.type}`;
    sprite.anchor.set(0.5);
    sprite.position.set(place.cx * ratio, place.cy * ratio);
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

// The repair aura / capture ring / hangar corridor. Purely a function of
// station type, colour, state and zoom, so it is rebuilt only when those change.
function rebuildStationAura(view, station, color, zoom) {
  const gfx = view.auraGfx;
  gfx.clear();
  const operational = station.state === "operational";
  if (station.stationType === "home") {
    const hangar = station.hangar || {};
    const corridorLength = Number(hangar.corridorLength) || Number(HOME_STATION.hangarCorridorLength) || 0;
    const halfWidth = Number(hangar.apertureHalfWidth) || Math.max(40, (Number(station.radius) || 0) * 0.45);
    if (corridorLength > 0 && halfWidth > 0) {
      // Recessed bay floor visible through the open hangar mouth.
      gfx.rect(0, -halfWidth, corridorLength, halfWidth * 2);
      gfx.fill({ color, alpha: 0.08 });
      // Door/wall edges with a rounded mouth frame.
      gfx.moveTo(0, -halfWidth);
      gfx.lineTo(corridorLength, -halfWidth);
      gfx.moveTo(0, halfWidth);
      gfx.lineTo(corridorLength, halfWidth);
      gfx.stroke({ width: 3 / zoom, color, alpha: operational ? 0.55 : 0.22 });
      gfx.arc(corridorLength, 0, halfWidth, -Math.PI / 2, Math.PI / 2);
      gfx.stroke({ width: 3 / zoom, color, alpha: operational ? 0.5 : 0.2 });
    }
    return;
  }
  const captureRadius = Number(RELAY_STATION.captureRadius) || 0;
  if (captureRadius > 0) {
    gfx.circle(0, 0, captureRadius);
    gfx.fill({ color, alpha: station.state === "neutral" ? 0.05 : 0.08 });
    gfx.stroke({ width: 2 / zoom, color, alpha: 0.42 });
  }
}

// Health + shield bars, the selection ring, and the build progress bar.
function rebuildStationHud(view, station, color, zoom, selected, barY, progress) {
  const gfx = view.hudGfx;
  gfx.clear();
  const width = Math.max(90, (Number(station.radius) || 60) * 1.4);
  const height = Math.max(6, 7 / zoom);
  const left = -width / 2;

  const hpRatio = station.maxHp > 0 ? Math.max(0, Math.min(1, station.hp / station.maxHp)) : 0;
  gfx.rect(left, barY, width, height);
  gfx.fill("rgba(8,12,20,0.78)");
  if (hpRatio > 0) {
    gfx.rect(left, barY, width * hpRatio, height);
    gfx.fill(station.state === "disabled" ? DISABLED_COLOR : color);
  }
  gfx.rect(left, barY, width, height);
  gfx.stroke({ width: 1 / zoom, color: "rgba(255,255,255,0.35)" });

  if (station.maxShield > 0) {
    const shieldRatio = Math.max(0, Math.min(1, station.shield / station.maxShield));
    const shieldY = barY - height - 2 / zoom;
    gfx.rect(left, shieldY, width, height * 0.6);
    gfx.fill("rgba(8,12,20,0.7)");
    if (shieldRatio > 0) {
      gfx.rect(left, shieldY, width * shieldRatio, height * 0.6);
      gfx.fill("#7cc4ff");
    }
  }

  if (progress > 0) {
    const progressY = barY + height + 3 / zoom;
    gfx.rect(left, progressY, width, height * 0.6);
    gfx.fill("rgba(8,12,20,0.7)");
    gfx.rect(left, progressY, width * progress, height * 0.6);
    gfx.fill("#ffc861");
  }

  if (selected) {
    const ring = Math.max(40, (Number(station.radius) || 60) + 18);
    gfx.circle(0, 0, ring);
    gfx.stroke({ width: 3 / zoom, color: "#ffffff", alpha: 0.75 });
  }
}

// The item currently occupying the hangar, if any. Only the owner's own builds
// are labelled; an enemy station shows that it is producing, not what.
function activeProductionSummary(station) {
  const queue = station.productionQueue;
  if (!Array.isArray(queue) || queue.length === 0) return { label: "", progress: 0 };
  const item = queue[0];
  const progress = Math.max(0, Math.min(1, Number(item.progress) || 0));
  const mine = item.playerId === state.myId;
  const remaining = Math.max(1, Number(item.quantityRemaining) || 1);
  if (item.state === "complete-waiting-launch") {
    return { label: mine ? "LAUNCHING" : "LAUNCHING", progress: 1 };
  }
  const queueSuffix = queue.length > 1 ? ` (+${queue.length - 1})` : "";
  const countSuffix = remaining > 1 ? ` x${remaining}` : "";
  return {
    label: mine
      ? `BUILDING ${Math.round(progress * 100)}%${countSuffix}${queueSuffix}`
      : `BUILDING${queueSuffix}`,
    progress
  };
}

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
  const zoomKey = zoom.toFixed(3);
  for (const station of stations) {
    // Culling uses the aura extent, not the hull: a home station's repair ring
    // is meaningful long before the structure itself is on screen.
    const auraRadius = station.stationType === "home"
      ? Math.max(
          Number(station.radius) || 0,
          (Number(station.hangar?.corridorLength) || 0) + (Number(station.hangar?.apertureHalfWidth) || 0)
        )
      : Math.max(Number(RELAY_STATION.captureRadius) || 0, Number(station.radius) || 0);
    if (bounds && !isCircleVisible(station.x, station.y, auraRadius, bounds)) continue;

    const view = pixiStationPool.acquire(station.id);
    const color = stationColor(station, players);
    view.root.position.set(station.x, station.y);
    view.auraGfx.rotation = Number(station.angle) || 0;
    view.hullSprite.rotation = Number(station.angle) || 0;
    view.turretContainer.rotation = Number(station.angle) || 0;

    // Static hull art. Absent design (a compact snapshot received before any
    // full one) leaves the sprite empty rather than baking a placeholder.
    const design = station.design;
    if (Array.isArray(design) && design.length > 0) {
      const radius = stationBakeRadius(station);
      const ratio = stationScaleRatio(station);
      const key = `station|${station.stationType}|${design.length}|${color}|${Math.round(radius)}|${env.bakeScale}|${getPixiBakeGeneration()}`;
      if (view.textureKey !== key) {
        const lease = acquireHullLease(env, design, color, radius, key);
        swapTextureLease(view, lease, key, (texture) => {
          view.hullSprite.texture = texture;
          view.hullSprite.scale.set(ratio / env.bakeScale);
        });
      } else {
        view.hullSprite.scale.set(ratio / env.bakeScale);
      }
      const turretSignature = `${station.stationType}|${design.length}|${env.bakeScale}|${getPixiBakeGeneration()}`;
      if (view.turretSignature !== turretSignature) {
        view.turretSignature = turretSignature;
        rebuildStationTurrets(env, view, station);
      }
      for (const sprite of view.turretSprites) {
        sprite.rotation = authoritativeWeaponAngle(station, sprite.__designIndex) || 0;
      }
    }
    view.hullSprite.alpha = station.state === "disabled" ? 0.55 : 1;

    const auraSignature = `${station.stationType}|${station.state}|${color}|${zoomKey}|${Math.round(station.radius || 0)}|${Math.round(station.hangar?.apertureHalfWidth || 0)}|${Math.round(station.hangar?.corridorLength || 0)}`;
    if (view.auraSignature !== auraSignature) {
      view.auraSignature = auraSignature;
      rebuildStationAura(view, station, color, zoom);
    }

    const production = station.stationType === "home" ? activeProductionSummary(station) : { label: "", progress: 0 };
    const selected = state.selectedStationId === station.id;
    const barY = Math.max(48, (Number(station.radius) || 60) + 24 / zoom);
    const hudSignature = [
      zoomKey, color, station.state, selected ? 1 : 0,
      Math.round(station.hp), Math.round(station.maxHp),
      Math.round(station.shield), Math.round(station.maxShield),
      Math.round(production.progress * 100), Math.round(barY)
    ].join("|");
    if (view.hudSignature !== hudSignature) {
      view.hudSignature = hudSignature;
      rebuildStationHud(view, station, color, zoom, selected, barY, production.progress);
    }

    const labelScale = Math.max(1, 1 / zoom);
    const stateLabel = stationStateLabel(station);
    if (view.stateLabel !== stateLabel) {
      view.stateLabel = stateLabel;
      view.stateText.text = stateLabel;
    }
    const stateFill = station.state === "disabled" ? "#ffb4b4" : "#ffffff";
    if (view.stateText.style.fill !== stateFill) view.stateText.style.fill = stateFill;
    view.stateText.scale.set(labelScale);
    view.stateText.position.set(0, barY + 22 / zoom);

    if (view.productionLabel !== production.label) {
      view.productionLabel = production.label;
      view.productionText.text = production.label;
    }
    view.productionText.visible = production.label.length > 0;
    view.productionText.scale.set(labelScale);
    view.productionText.position.set(0, barY + 40 / zoom);
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
export function peekPixiStationView(stationId) {
  return pixiStationPool ? pixiStationPool.peek(stationId) : null;
}
