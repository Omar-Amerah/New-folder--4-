// Explicit Pixi ship scene graph and its static/dynamic texture baking.
//
// Each ship on screen is one persistent PixiShipView with an explicit tree:
//
//   ShipRoot                 - world position (NO rotation)
//     ShieldRing             - shield arc ring (radial; rotation irrelevant)
//     HullContainer          - hull world rotation
//       EffectsBelow         - engine exhaust / maneuver jets (behind hull)
//       StaticHullSprite     - baked hull: structure + static component art
//       StaticWeaponMounts   - baked non-directional weapon sockets/housings
//       DynamicComponents    - animated parts
//         TurretContainer    - one persistent turret sprite per rotating weapon
//         OtherAnimatedComponents
//       DamageOverlay        - persistent damage tints (ship-local)
//       FlashOverlay         - short-lived hit flashes (ship-local)
//       EffectsAbove         - above-hull effects
//     WorldLabels            - HUD bars, names, core warning (screen-aligned)
//
// ShipRoot owns world position. HullContainer owns the hull world rotation, and
// EVERYTHING anchored to the ship body is inside it — engine exhaust, the hull
// sprite, turrets and overlays — so any ship-local drawing rotates with the
// ship (a turned ship's exhaust points the right way; a turret at its
// ship-relative angle ends up at hull+relative in world space). The shield ring
// (radial) and world labels (screen-aligned HUD) deliberately stay at the root,
// outside the hull rotation. Static hull textures never contain rotating weapon
// tops; turret textures contain only the rotating top on a transparent,
// centre-pivoted, +x-forward frame.

import { PART_DEFS, PART_STATS, isRotatablePart } from "../../design/parts.js";
import { moduleRotationToRadians, normalizeRotation } from "../../design/rotation.js";
import { pixiBakeTexture, getPixiBakeGeneration, createPixiTextureCache } from "./pixiBake.js";
import {
  drawShipStructure,
  drawModule,
  drawFootprintComponent,
  drawStaticComponentBase,
  drawStaticWeaponMount,
  drawRotatingWeaponTop
} from "../componentArt.js";
import { moduleLocalPosition, footprintLocalPlacement, shipEngineNozzles } from "../shipGeometry.js";
import { isRotatingWeaponPart } from "../weaponAim.js";

export const SHIP_SCALE = 13;
// Nominal zoom used when baking zoom-compensated line widths into textures.
const BAKE_NOMINAL_ZOOM = 0.6;

// Cache-owned, reference-counted textures. Identical ships share one hull
// texture; identical weapon types share one turret texture; one arrow texture
// is shared by every forced-arrow debug sprite. Views hold LEASES only and must
// never destroy these textures directly.
const hullTextureCache = createPixiTextureCache("shipHull");
const turretTextureCache = createPixiTextureCache("shipTurret");
const arrowTextureCache = createPixiTextureCache("turretArrow");

// Options that guarantee a Sprite.destroy() never destroys a cache-owned
// texture or its source (Pixi v8).
const SPRITE_DESTROY_OPTS = { children: false, texture: false, textureSource: false };

// Hull texture key == the static signature (design + colour + radius bounds +
// bake scale + generation); every field that changes the baked hull is present.
function hullTextureKey(staticKey) {
  return staticKey;
}
// Turret art depends only on part type + bake scale + generation (the rotating
// top uses the part's own colour, not the team colour).
function turretTextureKey(partType, bakeScale) {
  return `${partType}|${bakeScale}|${getPixiBakeGeneration()}`;
}
function arrowTextureKey(bakeScale) {
  return `debug-arrow|${bakeScale}|${getPixiBakeGeneration()}`;
}

// Lease accessors. Consumers store the returned lease and call lease.release()
// exactly once when done; the cache owns destruction.
export function acquireHullLease(env, design, color, radius, staticKey) {
  return hullTextureCache.acquire(hullTextureKey(staticKey), () => bakePixiHullTexture(env, design, color, radius));
}
export function acquireTurretLease(env, partType) {
  return turretTextureCache.acquire(turretTextureKey(partType, env.bakeScale), () => bakePixiTurretTexture(env, partType));
}
export function acquireTurretArrowLease(env) {
  return arrowTextureCache.acquire(arrowTextureKey(env.bakeScale), () => bakePixiTurretArrowTexture(env));
}

// --- Static hull texture ------------------------------------------------------
// The hull carries the structural spine plus every component's STATIC art:
// non-weapon modules in full, and for rotating weapons only their occupied
// block and non-directional mount. Rotating weapon tops are excluded — they
// live on their own turret sprites.
export function bakePixiHullTexture(env, design, color, radius) {
  let maxAbsX = radius + 12;
  let maxAbsY = radius + 12;
  for (const part of design) {
    const { x, y } = moduleLocalPosition(part, SHIP_SCALE);
    maxAbsX = Math.max(maxAbsX, Math.abs(x));
    maxAbsY = Math.max(maxAbsY, Math.abs(y));
  }
  // Extra pad so multi-tile non-rotatable parts (engine/reactor/capacitor) that
  // extend a tile beyond their anchor cell are not clipped by the bake bounds.
  const pad = SHIP_SCALE * 1.6 + 16;
  const halfW = maxAbsX + pad;
  const halfH = maxAbsY + pad;

  return pixiBakeTexture(env, halfW * 2, halfH * 2, (bctx) => {
    drawShipStructure(design, SHIP_SCALE, color);
    for (const part of design) {
      const def = PART_DEFS[part.type] || PART_DEFS.frame;
      const place = footprintLocalPlacement(part, SHIP_SCALE);
      const rotatable = isRotatablePart(part.type);
      const weapon = Boolean(PART_STATS[part.type]?.weapon);
      // Structural rotatables (wings, diagonals) show direction through their
      // own silhouette; they are not turrets and stay part of the hull.
      if (rotatable && !weapon) {
        drawStaticRotatableHull(bctx, part, place, def, color);
        continue;
      }
      if (weapon) {
        // Static half of a rotating weapon: occupied block + non-directional
        // mount, at the blueprint (long-axis) orientation. No rotating top.
        bctx.save();
        bctx.translate(place.cx, place.cy);
        if (place.multi) bctx.rotate(place.longAxisAngle);
        drawStaticComponentBase({ type: part.type, unit: SHIP_SCALE, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim: color });
        drawStaticWeaponMount({ type: part.type, unit: SHIP_SCALE, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color });
        bctx.restore();
        continue;
      }
      // Ordinary (non-weapon) component: full static art.
      if (place.multi) {
        bctx.save();
        bctx.translate(place.cx, place.cy);
        bctx.rotate(place.longAxisAngle);
        drawFootprintComponent({ type: part.type, unit: SHIP_SCALE, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim: color });
        bctx.restore();
      } else if (part.type === "maneuverThruster") {
        bctx.save();
        bctx.translate(place.cx, place.cy);
        bctx.rotate(moduleRotationToRadians(normalizeRotation(part.rotation)));
        drawModule({ x: 0, y: 0, size: SHIP_SCALE, color: def.color, type: part.type, trim: color });
        bctx.restore();
      } else {
        drawModule({ x: place.cx, y: place.cy, size: SHIP_SCALE, color: def.color, type: part.type, trim: color });
      }
    }
    // Forward direction indicator (the ship's nose arrowhead).
    bctx.strokeStyle = color;
    bctx.lineWidth = 2.5 / BAKE_NOMINAL_ZOOM;
    bctx.beginPath();
    bctx.moveTo(radius + 8, 0);
    bctx.lineTo(radius - 8, -7);
    bctx.lineTo(radius - 8, 7);
    bctx.closePath();
    bctx.stroke();
  });
}

// Structural rotatable silhouettes (wings, diagonal halves) baked at their
// blueprint rotation as static hull art.
function drawStaticRotatableHull(bctx, part, place, def, color) {
  bctx.save();
  bctx.translate(place.cx, place.cy);
  if (place.multi) {
    bctx.rotate(place.longAxisAngle);
    drawFootprintComponent({ type: part.type, unit: SHIP_SCALE, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim: color });
  } else {
    bctx.rotate(moduleRotationToRadians(normalizeRotation(part.rotation)));
    drawModule({ x: 0, y: 0, size: SHIP_SCALE, color: def.color, type: part.type, trim: color });
  }
  bctx.restore();
}

// --- Turret texture -----------------------------------------------------------
// Only the rotating weapon top, on a transparent background, centred on the
// pivot, with local +x as weapon-forward.
export function bakePixiTurretTexture(env, partType) {
  const def = PART_DEFS[partType] || PART_DEFS.frame;
  const footprint = PART_STATS[partType]?.footprint || { width: 1, height: 1 };
  const tilesLong = Math.max(footprint.width || 1, footprint.height || 1);
  const tilesCross = Math.min(footprint.width || 1, footprint.height || 1);
  const multi = tilesLong > 1 || tilesCross > 1;
  // Extent must cover the elongated barrel (canonical art spans ±tilesLong/2).
  const halfExtent = SHIP_SCALE * (multi ? tilesLong * 0.62 + 1.0 : 2.1);
  return pixiBakeTexture(env, halfExtent * 2, halfExtent * 2, () => {
    drawRotatingWeaponTop({ type: partType, unit: SHIP_SCALE, tilesLong, tilesCross, color: def.color });
  });
}

// A long, unmistakable arrow pointing local +x, used by forced-arrow debug mode
// to separate transform bugs from artwork bugs.
export function bakePixiTurretArrowTexture(env) {
  const len = SHIP_SCALE * 3.4;
  const half = len + SHIP_SCALE;
  return pixiBakeTexture(env, half * 2, half * 2, (bctx) => {
    bctx.strokeStyle = "#ff3bd0";
    bctx.fillStyle = "#ff3bd0";
    bctx.lineWidth = 4;
    bctx.beginPath();
    bctx.moveTo(0, 0);
    bctx.lineTo(len, 0);
    bctx.stroke();
    bctx.beginPath();
    bctx.moveTo(len, 0);
    bctx.lineTo(len - 9, -6);
    bctx.lineTo(len - 9, 6);
    bctx.closePath();
    bctx.fill();
    // Pivot dot so the rotation centre is obvious.
    bctx.fillStyle = "#ffe600";
    bctx.beginPath();
    bctx.arc(0, 0, 3.5, 0, Math.PI * 2);
    bctx.fill();
  });
}

// --- Scene graph --------------------------------------------------------------
export function createPixiShipView(env) {
  const PIXI = env.PIXI;

  const root = new PIXI.Container();
  root.label = "ShipRoot";

  const effectsBelow = new PIXI.Graphics();
  effectsBelow.label = "EffectsBelow";
  const shieldRing = new PIXI.Graphics();
  shieldRing.label = "ShieldRing";

  const hullContainer = new PIXI.Container();
  hullContainer.label = "HullContainer";
  const staticHullSprite = new PIXI.Sprite();
  staticHullSprite.label = "StaticHullSprite";
  staticHullSprite.anchor.set(0.5);
  const staticWeaponMounts = new PIXI.Container();
  staticWeaponMounts.label = "StaticWeaponMounts";
  const dynamicComponents = new PIXI.Container();
  dynamicComponents.label = "DynamicComponents";
  const turretContainer = new PIXI.Container();
  turretContainer.label = "TurretContainer";
  const otherAnimated = new PIXI.Container();
  otherAnimated.label = "OtherAnimatedComponents";
  const damageOverlay = new PIXI.Graphics();
  damageOverlay.label = "DamageOverlay";
  const flashOverlay = new PIXI.Graphics();
  flashOverlay.label = "FlashOverlay";

  const effectsAbove = new PIXI.Graphics();
  effectsAbove.label = "EffectsAbove";
  const worldLabels = new PIXI.Container();
  worldLabels.label = "WorldLabels";

  // Everything that is anchored to the ship body lives INSIDE HullContainer so
  // it inherits the hull's world rotation: engine exhaust (drawn behind the
  // hull), the static hull sprite + weapon mounts, the rotating turrets, the
  // damage/flash overlays, and any above-hull effects. Because they are all in
  // the hull frame, a ship-local drawing (an exhaust plume pointing along the
  // engine's local axis, a turret at its ship-relative angle) rotates with the
  // ship automatically — no per-layer rotation bookkeeping.
  dynamicComponents.addChild(turretContainer);
  dynamicComponents.addChild(otherAnimated);
  hullContainer.addChild(effectsBelow);      // engine exhaust / maneuver jets (behind hull)
  hullContainer.addChild(staticHullSprite);
  hullContainer.addChild(staticWeaponMounts);
  hullContainer.addChild(dynamicComponents);
  hullContainer.addChild(damageOverlay);
  hullContainer.addChild(flashOverlay);
  hullContainer.addChild(effectsAbove);      // above-hull effects

  const hudGfx = new PIXI.Graphics();
  const makeText = (style) => {
    const text = new PIXI.Text({ text: "", style, resolution: 2 });
    text.anchor.set(0.5);
    text.visible = false;
    return text;
  };
  const coreWarnText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 13, fontWeight: "900", fill: "#ff5f5f", stroke: { color: "rgba(10,4,4,0.8)", width: 3 } });
  const shieldText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 12, fontWeight: "900", fill: "#ffffff", stroke: { color: "rgba(0,0,0,0.65)", width: 2 } });
  const hullText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 12, fontWeight: "900", fill: "#ffffff", stroke: { color: "rgba(0,0,0,0.65)", width: 2 } });
  const hudName = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 13, fontWeight: "bold", fill: "#ffffff" });
  const idleName = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 13, fill: "rgba(237,244,255,0.5)" });
  const lostText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 14, fill: "rgba(237,244,255,0.7)" });
  const debugText = makeText({ fontFamily: "monospace", fontSize: 9, fill: "#8affc1", stroke: { color: "rgba(0,0,0,0.85)", width: 2 }, align: "left" });
  debugText.anchor.set(0, 0);
  worldLabels.addChild(hudGfx);
  worldLabels.addChild(shieldText);
  worldLabels.addChild(hullText);
  worldLabels.addChild(hudName);
  worldLabels.addChild(idleName);
  worldLabels.addChild(lostText);
  worldLabels.addChild(coreWarnText);
  worldLabels.addChild(debugText);

  // ShipRoot owns world position. The shield ring is radial (rotation is
  // irrelevant) and world labels are screen-aligned HUD, so both stay at the
  // root — outside the hull rotation.
  root.addChild(shieldRing);
  root.addChild(hullContainer);
  root.addChild(worldLabels);

  return {
    root,
    // Effects
    effectsBelow,
    effectsAbove,
    shieldGfx: shieldRing,
    engineGfx: effectsBelow,
    engines: [],
    // Hull frame
    hullContainer,
    staticHullSprite,
    staticWeaponMounts,
    dynamicComponents,
    turretContainer,
    otherAnimated,
    damageOverlay,
    flashOverlay,
    // Turret bookkeeping (persistent, keyed by ORIGINAL design index)
    turretSprites: [],
    turretsByDesignIndex: new Map(),
    visualTurretAngles: new Map(),
    forcedArrowActive: false,
    // Texture leases (non-owning). Released on rebuild / recycle / destroy.
    hullLease: null,
    arrowLease: null,
    // Labels / HUD
    hudGfx,
    shieldText,
    hullText,
    hudName,
    idleName,
    lostText,
    coreWarnText,
    debugText,
    names: { hud: null, idle: null },
    // Rebuild signature + per-view state
    staticKey: null,
    boundShipId: null,
    damageSig: null,
    turretDebugLastAt: 0,
    // Pool reset: wipe every scrap of per-ship visual state.
    release() {
      resetPixiShipView(this);
    }
  };
}

// Sets the hull-frame rotation. DynamicComponents, DamageOverlay and
// FlashOverlay are children of HullContainer, so they inherit this rotation and
// must NOT be rotated again. Each turret sprite keeps its own ship-relative
// rotation on top of the hull frame, so a turret's world direction is exactly
// (hull rotation + turret local rotation).
export function setHullFrameRotation(view, angle) {
  view.hullContainer.rotation = angle;
}

// Releases every texture lease this view holds (hull, per-turret, arrow) and
// clears the turret sprites. Safe to call more than once. Sprites are destroyed
// WITHOUT destroying their cache-owned textures.
function releaseShipViewLeases(view) {
  for (const sprite of view.turretSprites) {
    if (sprite.__lease) {
      sprite.__lease.release();
      sprite.__lease = null;
    }
    sprite.__baseTexture = null;
    if (!sprite.destroyed) sprite.destroy(SPRITE_DESTROY_OPTS);
  }
  view.turretSprites = [];
  view.turretsByDesignIndex.clear();
  view.turretContainer.removeChildren();
  if (view.arrowLease) {
    view.arrowLease.release();
    view.arrowLease = null;
  }
  if (view.hullLease) {
    view.hullLease.release();
    view.hullLease = null;
  }
  // The hull sprite's texture is cache-owned; drop the reference without
  // destroying it.
  view.staticHullSprite.texture = null;
}

// Full per-ship visual reset, used when a pooled view is handed to another ship
// and when a view is recycled. Removes stale turrets, clears index maps, angle
// state, damage signatures, effects, visibility/alpha, and releases all leases.
export function resetPixiShipView(view) {
  view.staticKey = null;
  view.boundShipId = null;
  view.damageSig = null;
  view.turretDebugLastAt = 0;
  view.forcedArrowActive = false;
  releaseShipViewLeases(view);
  view.visualTurretAngles.clear();
  view.otherAnimated.removeChildren();
  view.engines = [];
  view.damageOverlay.clear();
  view.flashOverlay.clear();
  view.effectsBelow.clear();
  view.effectsAbove.clear();
  view.shieldGfx.clear();
  view.hullContainer.rotation = 0;
  view.hullContainer.alpha = 1;
  view.names.hud = null;
  view.names.idle = null;
  view.debugText.visible = false;
}

// Full teardown for pool destruction: release leases, then destroy every
// display object (never its cache-owned textures) and detach the root.
export function destroyPixiShipView(view) {
  releaseShipViewLeases(view);
  view.visualTurretAngles.clear();
  if (view.root) {
    if (view.root.parent) view.root.parent.removeChild(view.root);
    view.root.destroy({ children: true, texture: false, textureSource: false });
  }
}

// (Re)build the static hull sprite and the persistent turret sprites for a
// design. Called only when the static signature changes — never on ordinary
// snapshot/position/angle/weaponAngle updates.
export function rebuildPixiShipStatic(env, view, design, color, radius, staticKey) {
  // Static hull: acquire the replacement lease FIRST, assign its texture, then
  // release the old one — so no frame ever references a destroyed texture and
  // an identical re-acquire keeps a positive refcount throughout.
  const previousHullLease = view.hullLease;
  const hullLease = acquireHullLease(env, design, color, radius, staticKey);
  view.hullLease = hullLease;
  view.staticHullSprite.texture = hullLease.texture;
  view.staticHullSprite.scale.set(1 / env.bakeScale);
  if (previousHullLease) previousHullLease.release();

  // Persistent turrets: exactly one per rotating weapon, keyed by ORIGINAL
  // design index (never a compressed weapon-list index). Release the old turret
  // leases/sprites, then acquire fresh shared leases so identical weapon types
  // reference the exact same Texture object.
  for (const sprite of view.turretSprites) {
    if (sprite.__lease) sprite.__lease.release();
    sprite.__lease = null;
    sprite.__baseTexture = null;
    if (!sprite.destroyed) sprite.destroy(SPRITE_DESTROY_OPTS);
  }
  view.turretSprites = [];
  view.turretsByDesignIndex.clear();
  view.turretContainer.removeChildren();
  view.forcedArrowActive = false;
  if (view.arrowLease) {
    view.arrowLease.release();
    view.arrowLease = null;
  }

  design.forEach((part, i) => {
    if (!isRotatingWeaponPart(part.type)) return;
    const lease = acquireTurretLease(env, part.type);
    const sprite = new env.PIXI.Sprite(lease.texture);
    sprite.label = `Turret[${i}] ${part.type}`;
    sprite.anchor.set(0.5);
    sprite.scale.set(1 / env.bakeScale);
    // Multi-tile weapons pivot at their footprint centre, not the anchor cell.
    const place = footprintLocalPlacement(part, SHIP_SCALE);
    sprite.position.set(place.cx, place.cy);
    sprite.__designIndex = i;
    sprite.__partType = part.type;
    sprite.__weaponStat = PART_STATS[part.type]?.weapon || null;
    sprite.__lease = lease;
    sprite.__baseTexture = lease.texture;
    sprite.rotation = defaultTurretAngle(part);
    sprite.visible = true;
    view.turretContainer.addChild(sprite);
    view.turretSprites.push(sprite);
    view.turretsByDesignIndex.set(i, sprite);
  });

  view.engines = shipEngineNozzles(design, SHIP_SCALE);
  view.damageSig = null;
  view.staticKey = staticKey;
}

function defaultTurretAngle(part) {
  return moduleRotationToRadians(normalizeRotation(part?.rotation));
}

// Signature that determines when the static content must be rebuilt: design,
// team colour, radius-dependent bounds, and the bake generation (quality).
// Deliberately excludes position, hull angle, weaponAngles, hp, shield, heat.
export function pixiStaticSignature(designSignature, color, radius, bakeScale) {
  return `${designSignature}|${color}|${Math.round(radius || 0)}|${bakeScale}|${getPixiBakeGeneration()}`;
}
