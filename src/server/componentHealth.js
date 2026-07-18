// Per-component health pools, impact-to-component resolution, directional
// armour interception, and event-driven ship stat recalculation.
//
// Runtime state kept on each ship (design itself stays static/shared):
//   ship.componentHp[i]    - remaining hp for design[i]
//   ship.componentMaxHp[i] - max hp for design[i] (scaled so the sum equals ship.maxHp)
//   ship.componentCellIndex - Map of grid cell -> design index (footprint aware)
//   ship.dirtyComponents   - indices whose hp changed since the last broadcast
//
// ship.hp is maintained incrementally as the sum of componentHp; the full sum is
// only rebuilt at creation (and by the dev-mode consistency check).

const { PARTS } = require("./components");
const { getOccupiedCells } = require("./footprint");
const EngineExhaustRules = require("../../public/src/shared/engineExhaust.js");
const HeatRules = require("../../public/src/shared/heatRules");
const { calculateCenterOfMass } = require("../../public/src/shared/movementStats.js");

const MODULE_SCALE = 13;
const GRID_CENTER = 7;
const GRID_SIZE = 15;
// Sampling step (in tiles) for the grid ray march used to find which component
// a hit enters through. 0.4 guarantees no tile along the ray is skipped.
const RAY_STEP = 0.4;

function initComponentState(ship) {
  const design = ship.design || [];
  const rawHp = design.map((module) => Math.max(1, (PARTS[module.type] || PARTS.frame).hp || 1));
  // The core is destroyable but deliberately hard to reach: it sits behind the
  // other components and has its own large, unscaled hp pool that is NOT part of
  // the hull-integrity sum (ship.hp). The ship dies either by losing every other
  // component (ship.hp -> 0) or by a shot penetrating all the way to the core.
  const rawSum = rawHp.reduce((sum, hp, i) => (design[i].type === "core" ? sum : sum + hp), 0) || 1;
  const scale = (ship.stats?.maxHp || rawSum) / rawSum;

  ship.componentMaxHp = rawHp.map((hp) => hp * scale);
  ship.componentHp = ship.componentMaxHp.slice();
  const coreHp = Math.max(320, Math.round((ship.stats?.maxHp || rawSum) * 0.45));
  design.forEach((module, i) => {
    if (module.type === "core") {
      ship.componentMaxHp[i] = coreHp;
      ship.componentHp[i] = coreHp;
    }
  });
  ship.maxHp = ship.stats?.maxHp || rawSum;
  ship.hp = ship.maxHp;
  ship.coreDestroyed = false;
  ship.dirtyComponents = new Set();

  const cellIndex = new Map();
  design.forEach((module, i) => {
    const part = PARTS[module.type] || PARTS.frame;
    const cells = getOccupiedCells(module.x, module.y, part.footprint || { width: 1, height: 1 }, module.rotation || 0);
    for (const cell of cells) cellIndex.set(cell.x * GRID_SIZE + cell.y, i);
  });
  ship.componentCellIndex = cellIndex;
  updateEngineExhaustState(ship);
}

function updateEngineExhaustState(ship) {
  const alive = (ship.design || []).map((_, index) => (ship.componentHp?.[index] ?? 1) > 0);
  const analysis = EngineExhaustRules.analyze(ship.design || [], PARTS, { alive });
  ship.validEngineIndices = analysis.validEngineIndices;
  ship.blockedEngineIndices = analysis.blockedEngineIndices;
  analysis.centerOfMass = calculateCenterOfMass(ship.design || [], PARTS);
  ship.engineExhaustAnalysis = analysis;
  ship.engineExhaustRevision = (ship.engineExhaustRevision || 0) + 1;
  return analysis;
}

function isComponentAlive(ship, index) {
  return !ship.componentHp || ship.componentHp[index] > 0;
}

// World point -> fractional blueprint grid coordinates (inverse of
// moduleLocalPosition + the ship's world rotation).
function worldToGrid(ship, worldX, worldY) {
  const cos = Math.cos(ship.angle);
  const sin = Math.sin(ship.angle);
  const dx = worldX - ship.x;
  const dy = worldY - ship.y;
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  return {
    gx: GRID_CENTER + ly / MODULE_SCALE,
    gy: GRID_CENTER - lx / MODULE_SCALE,
    lx,
    ly
  };
}

// Ordered list of alive component indices along the incoming damage ray:
// enter the grid from the shooter's side, pass through the impact cell, and
// exit the far side. The first entry is the exterior component the hit lands
// on (armour if armour covers that approach), later entries are what overflow
// damage reaches once the ones in front are destroyed.
function componentsAlongImpactRay(ship, worldX, worldY) {
  const { gx, gy, lx, ly } = worldToGrid(ship, worldX, worldY);

  // Incoming direction (toward the ship centre) expressed in grid axes.
  const len = Math.hypot(lx, ly);
  let dirX = 1;
  let dirY = 0;
  if (len > 0.0001) {
    dirX = -ly / len;
    dirY = lx / len;
  }

  const startX = gx - dirX * GRID_SIZE;
  const startY = gy - dirY * GRID_SIZE;
  const ordered = [];
  const seen = new Set();
  const cellIndex = ship.componentCellIndex;
  const maxT = GRID_SIZE * 2 + 2;

  for (let t = 0; t <= maxT; t += RAY_STEP) {
    const cx = Math.round(startX + dirX * t);
    const cy = Math.round(startY + dirY * t);
    if (cx < 0 || cy < 0 || cx >= GRID_SIZE || cy >= GRID_SIZE) continue;
    const idx = cellIndex.get(cx * GRID_SIZE + cy);
    if (idx === undefined || seen.has(idx)) continue;
    seen.add(idx);
    if (ship.componentHp[idx] > 0) ordered.push(idx);
  }

  if (!ordered.length) {
    const idx = nearestAliveComponent(ship, gx, gy);
    if (idx !== -1) ordered.push(idx);
  }
  return ordered;
}

// Fallback for glancing hits whose ray misses every occupied cell. Runs only on
// such hit events, never per tick.
function nearestAliveComponent(ship, gx, gy) {
  let best = -1;
  let bestDistSq = Infinity;
  const design = ship.design || [];
  for (let i = 0; i < design.length; i += 1) {
    if (ship.componentHp[i] <= 0) continue;
    if (design[i].type === "core") continue; // indestructible, can't soak the fallback hit
    const dx = design[i].x - gx;
    const dy = design[i].y - gy;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = i;
    }
  }
  return best;
}

// Applies already-shield-filtered hull damage to the components along the
// impact ray. Armour components soak damage first when they cover the incoming
// direction and shave off a flat amount per hit; overflow continues to the
// component behind. Returns the damage actually dealt to component hp.
function applyHullDamage(room, ship, damage, now, sourceX, sourceY) {
  if (!ship.componentHp || damage <= 0) {
    ship.hp -= Math.max(0, damage);
    return Math.max(0, damage);
  }

  const chain = componentsAlongImpactRay(ship, sourceX, sourceY);
  let remaining = damage;
  let applied = 0;

  for (const idx of chain) {
    if (remaining <= 0.0001) break;
    // The core can be destroyed once a shot penetrates to it, but it takes damage
    // to its own pool (kept out of the hull sum) rather than to ship.hp, and the
    // shot always stops here. Destroying it flags coreDestroyed -> ship dies.
    if (ship.design[idx].type === "core") {
      const dealt = Math.min(ship.componentHp[idx], remaining);
      if (dealt > 0) {
        ship.componentHp[idx] -= dealt;
        remaining -= dealt;
        applied += dealt;
        ship.dirtyComponents.add(idx);
        if (ship.componentHp[idx] <= 0.0001) {
          ship.componentHp[idx] = 0;
          onComponentDestroyed(room, ship, idx, now);
        }
      }
      break;
    }
    const part = PARTS[ship.design[idx].type] || PARTS.frame;
    if (part.armorFlatReduction > 0) {
      const protection = HeatRules.passiveProtectionForState(ship.componentHeatState?.[idx] || HeatRules.STATE.NORMAL);
      remaining = Math.max(0, remaining - Math.max(0, part.armorFlatReduction * protection));
      if (remaining <= 0) break;
    }
    const passiveStructure = HeatRules.isPassiveStructure(ship.design[idx].type, part);
    const incoming = passiveStructure ? remaining * HeatRules.structuralDamageMultiplierForState(ship.componentHeatState?.[idx] || HeatRules.STATE.NORMAL) : remaining;
    const dealt = Math.min(ship.componentHp[idx], incoming);
    if (dealt <= 0) continue;
    ship.componentHp[idx] -= dealt;
    if (ship.design[idx].type === "heatSink") require("./heat").recalculateEffectiveThermalCapacities(ship, idx);
    ship.hp -= dealt;
    remaining -= dealt;
    applied += dealt;
    ship.dirtyComponents.add(idx);
    if (ship.componentHp[idx] <= 0.0001) {
      ship.componentHp[idx] = 0;
      onComponentDestroyed(room, ship, idx, now);
      if (ship.coreDestroyed) break;
    }
  }

  if (ship.hp < 0) ship.hp = 0;
  return applied;
}

function onComponentDestroyed(room, ship, index, now) {
  const module = ship.design[index];
  if (ship.componentMeltdown && (PARTS[module.type]?.powerGeneration || 0) > 0) ship.componentMeltdown[index] = 0;
  if (room) {
    const cos = Math.cos(ship.angle);
    const sin = Math.sin(ship.angle);
    const lx = (GRID_CENTER - module.y) * MODULE_SCALE;
    const ly = (module.x - GRID_CENTER) * MODULE_SCALE;
    room.effects.push({
      type: "burst",
      x: ship.x + lx * cos - ly * sin,
      y: ship.y + lx * sin + ly * cos,
      at: now
    });
  }
  if (module.type === "core") {
    ship.coreDestroyed = true;
    requestComponentLifecycleRefresh(ship, { exposure: true, wiringTopology: true });
    return;
  }
  const heat = require("./heat");
  requestComponentLifecycleRefresh(ship, {
    thermalCapacity: true,
    exposure: true,
    thermalRoutes: heat.isThermalRouteType(module.type),
    wiringTopology: true
  });
}

function beginComponentLifecycleBatch(ship) {
  ship._componentLifecycleDepth = (ship._componentLifecycleDepth || 0) + 1;
}

function requestComponentLifecycleRefresh(ship, flags = {}) {
  ship._componentLifecycleDirty ||= {};
  for (const [flag, value] of Object.entries(flags)) if (value) ship._componentLifecycleDirty[flag] = true;
  if (!ship._componentLifecycleDepth) flushComponentLifecycleRefresh(ship);
}

function flushComponentLifecycleRefresh(ship) {
  const flags = ship._componentLifecycleDirty;
  if (!flags) return;
  ship._componentLifecycleDirty = null;
  const heat = require("./heat");
  if (flags.thermalCapacity) heat.recalculateEffectiveThermalCapacities(ship);
  if (flags.exposure) heat.rebuildRuntimeExposure(ship);
  if (flags.thermalRoutes) heat.rebuildThermalNetworks(ship);
  if (flags.wiringTopology) require("./componentPower").rebuildShipWiringState(ship, "component-lifecycle", { skipRuntimeStats: ship.alive === false });
}

function endComponentLifecycleBatch(ship) {
  ship._componentLifecycleDepth = Math.max(0, (ship._componentLifecycleDepth || 1) - 1);
  if (!ship._componentLifecycleDepth) flushComponentLifecycleRefresh(ship);
}

// Approximate footprint-center of a component in blueprint-grid tiles.
// Averages the rotated occupied cells: 90/180/270-degree footprints extend to
// the negative side of the anchor, so anchor + width/2 would be off by tiles.
function componentGridCenter(ship, index) {
  const module = ship.design[index];
  const footprint = (PARTS[module.type] || PARTS.frame).footprint || { width: 1, height: 1 };
  const cells = getOccupiedCells(module.x, module.y, footprint, module.rotation || 0);
  let x = 0;
  let y = 0;
  for (const cell of cells) {
    x += cell.x;
    y += cell.y;
  }
  return { x: x / cells.length, y: y / cells.length };
}

// Detonates a component (e.g. a reactor that reached overheat failure): destroys
// it and deals direct hp damage to nearby components within `radius` tiles, with
// linear falloff. Damage (not heat) is dealt to neighbours so a blast cannot
// instantly overheat and chain-detonate an adjacent reactor; a controlled radius
// and moderate damage keep healthy neighbours alive. Returns true if it fired.
function detonateComponent(room, ship, index, radius, damage, now) {
  if (!ship.componentHp || ship.componentHp[index] <= 0) return false;
  const center = componentGridCenter(ship, index);

  const applyToComponent = (i, dmg) => {
    if (dmg <= 0 || ship.componentHp[i] <= 0) return;
    const isCore = ship.design[i].type === "core";
    const dealt = Math.min(ship.componentHp[i], dmg);
    ship.componentHp[i] -= dealt;
    if (ship.design[i].type === "heatSink") require("./heat").recalculateEffectiveThermalCapacities(ship, i);
    if (!isCore) ship.hp -= dealt; // the core is kept out of the hull sum
    ship.dirtyComponents.add(i);
    if (ship.componentHp[i] <= 0.0001) {
      ship.componentHp[i] = 0;
      onComponentDestroyed(room, ship, i, now);
    }
  };

  beginComponentLifecycleBatch(ship);
  // The reactor is destroyed outright.
  applyToComponent(index, ship.componentHp[index]);

  for (let i = 0; i < ship.design.length; i += 1) {
    if (i === index || ship.componentHp[i] <= 0) continue;
    const other = componentGridCenter(ship, i);
    const dist = Math.hypot(other.x - center.x, other.y - center.y);
    if (dist > radius) continue;
    applyToComponent(i, damage * (1 - dist / radius));
  }

  if (ship.hp < 0) ship.hp = 0;
  endComponentLifecycleBatch(ship);
  if (room) {
    const cos = Math.cos(ship.angle);
    const sin = Math.sin(ship.angle);
    const lx = (GRID_CENTER - center.y) * MODULE_SCALE;
    const ly = (center.x - GRID_CENTER) * MODULE_SCALE;
    room.effects.push({ type: "boom", x: ship.x + lx * cos - ly * sin, y: ship.y + lx * sin + ly * cos, at: now });
  }
  return true;
}

// Stat fields that depend on which components are still functional. Static
// identity fields (unitCost, radius, maxHp, fleetCount, ...) are intentionally
// excluded so the ship keeps its footprint and price.
const EFFECTIVE_STAT_KEYS = [
  "mass", "shieldRegen", "powerGeneration", "powerUse", "power", "efficiency",
  "thrust", "effectiveThrust", "engineEfficiency", "thrustRatio", "energyStorage",
  "accel", "maxSpeed", "turnRate", "turnRateLeft", "turnRateRight", "massClass", "speedCap", "turnCap",
  "powerEfficiency", "powerDebuff",
  "blaster", "missile", "railgun", "beam", "pointDefense",
  "repair", "repairRate", "repairRange",
  "coolingBonus", "captureBonus", "ecmStrength",
  "decoyRange", "decoyCooldown", "decoyConfuseDuration", "decoyChance",
  "frontDamageReduction", "frontArc",
  "blasterRange", "missileRange", "railgunRange", "beamRange", "beamRadius"
];

// Recomputes power/movement/weapon/shield/repair stats from the components that
// are still alive. Called only when a component crosses the alive/destroyed
// boundary (either direction), never per tick. ship.stats must be a per-ship
// clone (spawnShip guarantees this).
function recalcEffectiveStats(ship) {
  if (!ship.componentHp || !ship.design) return;
  const { computeStats } = require("./shipStats");
  const alive = ship.design.filter((module, i) => ship.componentHp[i] > 0);
  if (!alive.length) return;
  const next = computeStats(alive);
  for (const key of EFFECTIVE_STAT_KEYS) ship.stats[key] = next[key];
  const { effectiveShieldStats } = require("./componentPower");
  ship.maxShield = effectiveShieldStats(ship).capacity;
  if (ship.shield > ship.maxShield) ship.shield = ship.maxShield;
  updateEngineExhaustState(ship);
}

// Repairs component hp directly (most damaged first), keeping ship.hp in sync.
// Restoring a destroyed component above zero re-enables it and recalculates the
// affected ship systems. Returns the amount actually restored.
function repairShipComponents(room, ship, amount, now) {
  if (amount <= 0) return 0;
  if (!ship.componentHp) {
    const healed = Math.min(ship.maxHp - ship.hp, amount);
    ship.hp += healed;
    return healed;
  }

  let healed = 0;
  let remaining = amount;
  beginComponentLifecycleBatch(ship);
  while (remaining > 0.0001) {
    let idx = -1;
    let worstMissing = 0.0001;
    for (let i = 0; i < ship.componentHp.length; i += 1) {
      const missing = ship.componentMaxHp[i] - ship.componentHp[i];
      if (missing > worstMissing) {
        worstMissing = missing;
        idx = i;
      }
    }
    if (idx === -1) break;

    const wasDestroyed = ship.componentHp[idx] <= 0;
    const heal = Math.min(remaining, worstMissing);
    const isCore = ship.design[idx].type === "core";
    ship.componentHp[idx] += heal;
    if (ship.design[idx].type === "heatSink") require("./heat").recalculateEffectiveThermalCapacities(ship, idx);
    // The core has a separate durability pool and is intentionally excluded
    // from ship.hp, so repairing core damage must not inflate hull integrity.
    if (!isCore) ship.hp = Math.min(ship.maxHp, ship.hp + heal);
    ship.dirtyComponents.add(idx);
    remaining -= heal;
    healed += heal;
    if (wasDestroyed && ship.componentHp[idx] > 0) {
      if (ship.design[idx].type === "core") ship.coreDestroyed = false;
      const heat = require("./heat");
      requestComponentLifecycleRefresh(ship, { thermalCapacity: true,
        exposure: true, thermalRoutes: heat.isThermalRouteType(ship.design[idx].type), wiringTopology: true });
    }
  }
  endComponentLifecycleBatch(ship);
  return healed;
}

// Zeroes every component pool (ship destroyed) so componentHp stays consistent
// with ship.hp === 0 and clients render the whole wreck as knocked out.
function zeroAllComponents(ship) {
  if (!ship.componentHp) return;
  beginComponentLifecycleBatch(ship);
  for (let i = 0; i < ship.componentHp.length; i += 1) {
    if (ship.componentHp[i] !== 0) {
      ship.componentHp[i] = 0;
      ship.dirtyComponents.add(i);
    }
  }
  if (ship.componentMeltdown) ship.componentMeltdown.fill(0);
  ship.hp = 0;
  requestComponentLifecycleRefresh(ship, { thermalCapacity: true, exposure: true, thermalRoutes: true, wiringTopology: true });
  endComponentLifecycleBatch(ship);
}

// Dev-only consistency check: ship.hp must equal the non-core component sum
// (the indestructible core keeps a pool for collision/display but is excluded
// from the damageable total).
function assertComponentHpConsistency(ship) {
  if (process.env.NODE_ENV === "production" || !ship.componentHp) return;
  const sum = ship.componentHp.reduce((total, hp, i) => (ship.design[i].type === "core" ? total : total + hp), 0);
  if (Math.abs(sum - ship.hp) > 0.5) {
    console.warn(`[componentHealth] ship ${ship.id} hp drift: ship.hp=${ship.hp.toFixed(2)} sum=${sum.toFixed(2)}`);
    ship.hp = sum;
  }
}

module.exports = {
  initComponentState,
  isComponentAlive,
  worldToGrid,
  componentsAlongImpactRay,
  applyHullDamage,
  detonateComponent,
  zeroAllComponents,
  recalcEffectiveStats,
  updateEngineExhaustState,
  repairShipComponents,
  assertComponentHpConsistency
  ,beginComponentLifecycleBatch, requestComponentLifecycleRefresh, endComponentLifecycleBatch, flushComponentLifecycleRefresh
};
