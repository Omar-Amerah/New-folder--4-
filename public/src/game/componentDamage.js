// Client-side component damage feedback derived entirely from the chp/chpD
// component-hp updates the server already sends. No new server state, loops,
// or fields: every flash, penetration trace, feed entry, and core warning here
// is computed by diffing consecutive snapshots and expires on a local timer.

import { state } from "../state.js";
import { PART_STATS } from "../design/parts.js";
import { getOccupiedCells } from "../design/footprint.js";

export const FLASH_DURATION_MS = 450;
export const FLASH_STAGGER_MS = 70; // sequence highlight along a penetration path
export const PATH_DURATION_MS = 500;
export const FEED_TTL_MS = 6000;
export const FEED_MAX = 5;
export const CORE_WARNING_MS = 1800;
export const CRITICAL_RATIO = 0.25;
export const DAMAGED_RATIO = 0.55;

function damageStateFor(shipId) {
  if (!state.componentDamage) state.componentDamage = new Map();
  let entry = state.componentDamage.get(shipId);
  if (!entry) {
    entry = { flashes: [], path: null, feed: [], coreWarning: null, coreExposedShown: false };
    state.componentDamage.set(shipId, entry);
  }
  return entry;
}

export function isArmorType(type) {
  return /armor/i.test(String(type || ""));
}

// "compositeArmor" -> "Composite Armor" (server parts carry no display name).
export function partDisplayName(type) {
  const source = String(type || "component");
  const spaced = source.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function pushFeed(entry, text, tone, now) {
  entry.feed.push({ text, tone, at: now });
  if (entry.feed.length > FEED_MAX) entry.feed.splice(0, entry.feed.length - FEED_MAX);
}

function coreIndexFor(design) {
  for (let i = 0; i < design.length; i += 1) {
    if (design[i].type === "core") return i;
  }
  return -1;
}

// True when the destroyed component sits directly against a core cell — losing
// it opens a shot path to the core from that side.
function destroyedComponentAdjacentToCore(design, destroyedIndex, coreIndex) {
  if (coreIndex < 0 || destroyedIndex === coreIndex) return false;
  const core = design[coreIndex];
  const coreCells = getOccupiedCells(core.x, core.y, PART_STATS.core?.footprint || { width: 1, height: 1 }, core.rotation || 0);
  const part = design[destroyedIndex];
  const footprint = PART_STATS[part.type]?.footprint || { width: 1, height: 1 };
  const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);
  for (const cell of cells) {
    for (const coreCell of coreCells) {
      if (Math.abs(cell.x - coreCell.x) + Math.abs(cell.y - coreCell.y) === 1) return true;
    }
  }
  return false;
}

// Called from the snapshot merge with the previous and next component hp arrays
// for one ship. `ship` is the incoming snapshot entry (design already attached).
export function recordComponentHpChanges(ship, oldChp, newChp) {
  if (!oldChp || !newChp || !ship.design) return;
  const now = performance.now();
  const entry = damageStateFor(ship.id);
  const coreIndex = coreIndexFor(ship.design);
  const damagedIndices = [];

  const length = Math.min(oldChp.length, newChp.length);
  for (let i = 0; i < length; i += 1) {
    const before = oldChp[i];
    const after = newChp[i];
    if (!(before > after)) continue; // repairs handled by the tint fading back
    const damage = before - after;
    const destroyed = after <= 0 && before > 0;
    damagedIndices.push({ index: i, damage, destroyed });
  }
  if (!damagedIndices.length) return;

  // A full-wreck sync (ship killed: every pool zeroed at once) reads as an
  // explosion, not per-component hits — the boom effect already covers it.
  const wholeShipZeroed = !ship.alive && damagedIndices.every((d) => d.destroyed);

  damagedIndices.forEach((hit, order) => {
    const part = ship.design[hit.index];
    const layer = isArmorType(part?.type) ? "armor" : "internal";
    if (!wholeShipZeroed) {
      entry.flashes.push({
        index: hit.index,
        at: now + order * FLASH_STAGGER_MS,
        damage: hit.damage,
        destroyed: hit.destroyed,
        layer
      });
      const name = partDisplayName(part?.type);
      if (hit.destroyed) pushFeed(entry, `${name} destroyed`, "destroyed", now);
      else pushFeed(entry, `${name} — ${Math.round(hit.damage)} damage`, layer, now);
    }

    if (hit.index === coreIndex && !hit.destroyed) {
      entry.coreWarning = { text: "CORE DAMAGED", at: now };
      pushFeed(entry, "Core damaged", "core", now);
    }
    if (hit.destroyed && destroyedComponentAdjacentToCore(ship.design, hit.index, coreIndex) && newChp[coreIndex] > 0) {
      entry.coreWarning = { text: "CORE EXPOSED", at: now };
      pushFeed(entry, "Core exposed", "core", now);
    }
  });

  // Penetration trace: one update damaging several components means a shot
  // (or burst) punched through them in the server's resolution order.
  if (!wholeShipZeroed && damagedIndices.length >= 2) {
    entry.path = { indices: damagedIndices.map((d) => d.index), at: now };
  }

  // Escalate to CORE CRITICAL from live hp (no timer needed to trigger it).
  if (coreIndex >= 0 && newChp[coreIndex] > 0) {
    const coreMax = componentMaxFromShip(ship, coreIndex);
    if (coreMax && newChp[coreIndex] / coreMax <= CRITICAL_RATIO) {
      if (!entry.coreWarning || entry.coreWarning.text !== "CORE CRITICAL" || now - entry.coreWarning.at > CORE_WARNING_MS) {
        entry.coreWarning = { text: "CORE CRITICAL", at: now };
        pushFeed(entry, "Core critical", "core", now);
      }
    }
  }
}

// Component max hp mirror (same scaling the renderers use): the indestructible
// core is excluded from the damageable sum but keeps its own display pool.
export function componentMaxFromShip(ship, index) {
  const design = ship.design;
  if (!design) return 0;
  let sum = 0;
  for (const part of design) {
    if (part.type === "core") continue;
    sum += Math.max(1, Number(PART_STATS[part.type]?.hp) || 1);
  }
  if (!sum) return 0;
  const raw = Math.max(1, Number(PART_STATS[design[index].type]?.hp) || 1);
  return raw * ((Number(ship.maxHp) || sum) / sum);
}

// Active flash strength (0..1) for a component, or 0 when idle.
export function componentFlash(shipId, index, now) {
  const entry = state.componentDamage ? state.componentDamage.get(shipId) : null;
  if (!entry || !entry.flashes.length) return null;
  let best = null;
  for (const flash of entry.flashes) {
    if (flash.index !== index) continue;
    const age = now - flash.at;
    if (age < 0 || age > FLASH_DURATION_MS) continue;
    const strength = 1 - age / FLASH_DURATION_MS;
    if (!best || strength > best.strength) best = { strength, layer: flash.layer, destroyed: flash.destroyed };
  }
  return best;
}

export function activePenetrationPath(shipId, now) {
  const entry = state.componentDamage ? state.componentDamage.get(shipId) : null;
  if (!entry || !entry.path) return null;
  const age = now - entry.path.at;
  if (age > PATH_DURATION_MS) return null;
  return { indices: entry.path.indices, strength: 1 - age / PATH_DURATION_MS };
}

export function activeCoreWarning(shipId, now) {
  const entry = state.componentDamage ? state.componentDamage.get(shipId) : null;
  if (!entry || !entry.coreWarning) return null;
  const age = now - entry.coreWarning.at;
  if (age > CORE_WARNING_MS) return null;
  return { text: entry.coreWarning.text, strength: 1 - age / CORE_WARNING_MS };
}

export function recentDamageFeed(shipId, now) {
  const entry = state.componentDamage ? state.componentDamage.get(shipId) : null;
  if (!entry) return [];
  return entry.feed.filter((item) => now - item.at < FEED_TTL_MS);
}

// True when the ship has any live visual to draw this frame (renderers use it
// to skip per-frame flash redraws for untouched ships).
export function hasActiveDamageVisuals(shipId, now) {
  const entry = state.componentDamage ? state.componentDamage.get(shipId) : null;
  if (!entry) return false;
  if (entry.path && now - entry.path.at <= PATH_DURATION_MS) return true;
  if (entry.coreWarning && now - entry.coreWarning.at <= CORE_WARNING_MS) return true;
  for (const flash of entry.flashes) {
    if (now - flash.at <= FLASH_DURATION_MS) return true;
  }
  return false;
}

// Periodic cleanup: drop expired flashes and entries for ships no longer in
// the snapshot. Called from the render loop alongside the other per-ship caches.
export function pruneComponentDamage(visibleShipIds, now) {
  if (!state.componentDamage) return;
  for (const [shipId, entry] of state.componentDamage) {
    if (visibleShipIds && !visibleShipIds.has(shipId)) {
      state.componentDamage.delete(shipId);
      continue;
    }
    if (entry.flashes.length) {
      entry.flashes = entry.flashes.filter((flash) => now - flash.at <= FLASH_DURATION_MS);
    }
    if (entry.path && now - entry.path.at > PATH_DURATION_MS) entry.path = null;
    if (entry.feed.length && now - entry.feed[entry.feed.length - 1].at > FEED_TTL_MS * 2) entry.feed = [];
  }
}
