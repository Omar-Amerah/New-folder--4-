"use strict";

const { PARTS } = require("../components");
const { fastHypot } = require("../utils");
const {
  getShipCollisionGeometry,
  getShipComponentCellWorldCoords,
  invalidateShipCollisionGeometry,
  COMPONENT_CELL_COLLISION_RADIUS
} = require("../componentGeometry");
const { removeProjectileRuntime } = require("../projectiles");
const { isComponentAlive, zeroAllComponents } = require("../componentHealth");
const Relationships = require("../relationships");
const { segmentStationHullHit, nearestStationHullPoint } = require("../stationCollision");
const { getShipComponentIndexes } = require("../componentIndexes");
const { STRUCTURAL_COMPONENT_TYPES } = require("./componentTargeting");

function createDemolitionRuntime({
  componentAimWorldPosition,
  isComponentExposed,
  applyDirectComponentDamage,
  destroyShip,
  areEnemies
}) {
  const DEMOLITION_TRIGGER_RANGE = 50;
  
  const DEMOLITION_DIAGNOSTICS = Boolean(process.env.MFA_DEMOLITION_DIAGNOSTICS);
  
  
  
  function getProximityChargeConfig(ship, index) {
  
    const part = PARTS[ship.design?.[index]?.type];
  
    return part?.proximityCharge || null;
  
  }
  
  
  
  function armedProximityChargeRanges(ship) {
  
    let armed = false;
  
    let count = 0;
  
    const indexes = getShipComponentIndexes(ship).proximityChargeIndices;
  
    for (const i of indexes) {
  
      if (!isComponentAlive(ship, i)) continue;
  
      if (ship.proximityChargeDetonated?.[i]) continue;
  
      if (!getProximityChargeConfig(ship, i)) continue;
  
      armed = true;
  
      count += 1;
  
    }
  
    return { armed, count, minTrigger: 0 };
  
  }
  
  
  
  function shipHasOperationalDemolitionCharge(ship) {
  
    return armedProximityChargeRanges(ship).armed;
  
  }
  
  
  
  function proximityChargeWorldPosition(ship, index) {
  
    return componentAimWorldPosition(ship, index);
  
  }
  
  
  
  function getShipCellPoints(ship) {
  
    const geometry = getShipCollisionGeometry(ship);
  
    const cells = [];
  
    for (const i of geometry.liveComponentIndices) {
  
      const compCells = geometry.worldCells[i];
  
      if (!compCells) continue;
  
      const prevAngle = Number(ship._prevAngle || ship.angle || 0);
  
      const cos0 = Math.cos(prevAngle);
  
      const sin0 = Math.sin(prevAngle);
  
      const prevX = Number(ship._prevX || ship.x || 0);
  
      const prevY = Number(ship._prevY || ship.y || 0);
  
      const local = geometry.localCells[i];
  
      for (let c = 0; c < compCells.length; c += 1) {
  
        const world = compCells[c];
  
        const lc = local[c];
  
        cells.push({
  
          x: world.x, y: world.y,
  
          prevX: prevX + lc.x * cos0 - lc.y * sin0,
  
          prevY: prevY + lc.x * sin0 + lc.y * cos0
  
        });
  
      }
  
    }
  
    return cells;
  
  }
  
  
  
  function aabbOverlap(aMinX, aMinY, aMaxX, aMaxY, bMinX, bMinY, bMaxX, bMaxY) {
  
    return aMinX <= bMaxX && aMaxX >= bMinX && aMinY <= bMaxY && aMaxY >= bMinY;
  
  }
  
  function stationDemolitionContact(ship, station) {
    if (!station?.collisionPieces?.length) return null;
    const cells = getShipCellPoints(ship);
    if (!cells.length) return null;
    const threshold = COMPONENT_CELL_COLLISION_RADIUS + DEMOLITION_TRIGGER_RANGE;
    let best = null;
    for (const cell of cells) {
      const hit = segmentStationHullHit(
        station,
        cell.prevX,
        cell.prevY,
        cell.x,
        cell.y,
        threshold
      );
      if (hit && (!best || hit.t < best.t)) best = { ...hit, geometry: "station" };
    }
    return best;
  }
  
  
  
  function segmentPairContact(a0x, a0y, a1x, a1y, b0x, b0y, b1x, b1y, threshold) {
  
    const r0x = a0x - b0x;
  
    const r0y = a0y - b0y;
  
    const ddx = (a1x - a0x) - (b1x - b0x);
  
    const ddy = (a1y - a0y) - (b1y - b0y);
  
    const len2 = ddx * ddx + ddy * ddy;
  
    if (len2 < 1e-12) {
  
      if (r0x * r0x + r0y * r0y < threshold * threshold) return 1;
  
      return -1;
  
    }
  
    let raw = -(r0x * ddx + r0y * ddy) / len2;
  
    if (raw < 0) raw = 0;
  
    else if (raw > 1) raw = 1;
  
    const rx = r0x + ddx * raw;
  
    const ry = r0y + ddy * raw;
  
    if (rx * rx + ry * ry < threshold * threshold) return raw;
  
    return -1;
  
  }
  
  
  
  function shipsDemolitionContact(a, b) {
  
    const aCells = getShipCellPoints(a);
  
    const bCells = getShipCellPoints(b);
  
    if (!aCells.length || !bCells.length) return null;
  
    let aMinX = Infinity, aMinY = Infinity, aMaxX = -Infinity, aMaxY = -Infinity;
  
    for (const c of aCells) {
  
      if (c.x < aMinX) aMinX = c.x;
  
      if (c.y < aMinY) aMinY = c.y;
  
      if (c.x > aMaxX) aMaxX = c.x;
  
      if (c.y > aMaxY) aMaxY = c.y;
  
    }
  
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
  
    for (const c of bCells) {
  
      if (c.x < bMinX) bMinX = c.x;
  
      if (c.y < bMinY) bMinY = c.y;
  
      if (c.x > bMaxX) bMaxX = c.x;
  
      if (c.y > bMaxY) bMaxY = c.y;
  
    }
  
    const threshold = COMPONENT_CELL_COLLISION_RADIUS * 2 + DEMOLITION_TRIGGER_RANGE;
  
    if (!aabbOverlap(aMinX - threshold, aMinY - threshold, aMaxX + threshold, aMaxY + threshold,
  
                     bMinX - threshold, bMinY - threshold, bMaxX + threshold, bMaxY + threshold)) {
  
      return null;
  
    }
  
    let bestT = Infinity;
  
    let bestAx = a.x;
  
    let bestAy = a.y;
  
    let bestBx = b.x;
  
    let bestBy = b.y;
  
    for (const ca of aCells) {
  
      for (const cb of bCells) {
  
        const t = segmentPairContact(ca.prevX, ca.prevY, ca.x, ca.y, cb.prevX, cb.prevY, cb.x, cb.y, threshold);
  
        if (t >= 0 && t < bestT) {
  
          bestT = t;
  
          const ta = 1 - t;
  
          bestAx = ca.prevX * ta + ca.x * t;
  
          bestAy = ca.prevY * ta + ca.y * t;
  
          bestBx = cb.prevX * ta + cb.x * t;
  
          bestBy = cb.prevY * ta + cb.y * t;
  
        }
  
      }
  
    }
  
    if (bestT === Infinity) return null;
  
    return {
  
      t: bestT,
  
      x: (bestAx + bestBx) * 0.5,
  
      y: (bestAy + bestBy) * 0.5,
  
      geometry: "cell"
  
    };
  
  }
  
  
  
  function canDetonateDemolitionCharge(ship) {
  
    if (!ship || !ship.alive || ship.destroyFinalizedAt) return false;
  
    const indexes = getShipComponentIndexes(ship).proximityChargeIndices;
  
    for (const i of indexes) {
  
      if (!isComponentAlive(ship, i)) continue;
  
      if (ship.proximityChargeDetonated?.[i]) continue;
  
      if (getProximityChargeConfig(ship, i)) return true;
  
    }
  
    return false;
  
  }
  
  
  
  function getFirstOperationalProximityChargeIndex(ship) {
  
    const indexes = getShipComponentIndexes(ship).proximityChargeIndices;
  
    for (const i of indexes) {
  
      if (!isComponentAlive(ship, i)) continue;
  
      if (ship.proximityChargeDetonated?.[i]) continue;
  
      if (getProximityChargeConfig(ship, i)) return i;
  
    }
  
    return -1;
  
  }
  
  
  
  function nearestDemolitionTargetPoint(ship, target) {
  
    if (!target || !target.alive) return { x: target?.x ?? ship.x, y: target?.y ?? ship.y };
  
    if (target.entityType === "station") {
      return nearestStationHullPoint(ship.x, ship.y, target);
    }
  
    const geometry = getShipCollisionGeometry(target);
  
    let best = null;
  
    let bestDist = Infinity;
  
    for (const i of geometry.liveComponentIndices) {
  
      const cells = geometry.worldCells[i];
  
      if (!cells) continue;
  
      for (const c of cells) {
  
        const dx = c.x - ship.x;
  
        const dy = c.y - ship.y;
  
        const distSq = dx * dx + dy * dy;
  
        if (distSq < bestDist) {
  
          bestDist = distSq;
  
          best = c;
  
        }
  
      }
  
    }
  
    if (best) return { x: best.x, y: best.y };
  
    return { x: target.x, y: target.y };
  
  }
  
  
  function shipCoarseRadius(ship) {
    const geom = getShipCollisionGeometry(ship);
    let maxR = 0;
    for (const i of geom.liveComponentIndices) {
      const cells = geom.worldCells[i];
      if (!cells) continue;
      for (const c of cells) {
        const dx = Math.abs(c.x - ship.x);
        const dy = Math.abs(c.y - ship.y);
        const r = Math.max(dx, dy);
        if (r > maxR) maxR = r;
      }
    }
    return maxR;
  }
  
  
  function resolveDemolitionContacts(room, ships, now) {
    if (!room || !Array.isArray(ships)) return;
    const spatial = room.disableSpatialIndex ? null : (room.spatialIndex?.dynamicValid ? room.spatialIndex : null);
    const scratch = room._demolitionScratch || (room._demolitionScratch = []);
    let maxShipRadius = 0;
    for (const ship of ships) {
      if (!ship.alive) continue;
      const r = shipCoarseRadius(ship);
      if (r > maxShipRadius) maxShipRadius = r;
    }
    const processedPairs = new Set();
    for (const a of ships) {
      if (!a.alive || a.launchPhase || !canDetonateDemolitionCharge(a)) continue;
      const aRadius = shipCoarseRadius(a);
      const aMovement = fastHypot((a.x - (a._prevX || a.x)), (a.y - (a._prevY || a.y)));
      const searchR = aRadius + maxShipRadius + aMovement + COMPONENT_CELL_COLLISION_RADIUS * 2 + DEMOLITION_TRIGGER_RANGE;
      let candidates;
      if (spatial) {
        spatial.queryRangeUnordered("ships", a.x, a.y, searchR, scratch);
        candidates = scratch;
      } else {
        candidates = ships;
      }
      for (const b of candidates) {
        if (a === b || !b || !b.alive || b.launchPhase) continue;
        if (!areEnemies(room, a.ownerId, b.ownerId)) continue;
        const ids = [String(a.id), String(b.id)].sort();
        const pairKey = `${ids[0]}|${ids[1]}`;
        if (processedPairs.has(pairKey)) continue;
        processedPairs.add(pairKey);
        const contact = shipsDemolitionContact(a, b);
        if (!contact) continue;
        if (canDetonateDemolitionCharge(a)) {
          detonateProximityCharge(room, a, getFirstOperationalProximityChargeIndex(a), now, true, b, contact);
        }
        if (b.alive && canDetonateDemolitionCharge(b)) {
          detonateProximityCharge(room, b, getFirstOperationalProximityChargeIndex(b), now, true, a, contact);
        }
      }
      if (!a.alive) continue;
      for (const station of room.stations || []) {
        if (!station || station.alive === false || station.state === "destroyed") continue;
        if (!Relationships.areEntityEnemies(room, a.ownerId, station)) continue;
        const dx = station.x - a.x;
        const dy = station.y - a.y;
        const broadRadius = aRadius + (Number(station.radius) || 0) + aMovement + DEMOLITION_TRIGGER_RANGE;
        if (dx * dx + dy * dy > broadRadius * broadRadius) continue;
        const contact = stationDemolitionContact(a, station);
        if (!contact) continue;
        detonateProximityCharge(room, a, getFirstOperationalProximityChargeIndex(a), now, true, station, contact);
        break;
      }
    }
  }
  
  
  
  function updateProximityCharges(room, ships, dt, now) {
  
    resolveDemolitionContacts(room, ships, now);
  
  }
  
  
  
  function blastDamageFor(edge, blastR, centre, exp) {
  
    if (edge >= blastR) return 0;
  
    const ratio = Math.max(0, 1 - edge / blastR);
  
    return centre * Math.pow(ratio, exp);
  
  }
  
  function applyBlastDamageToStation(room, station, origin, cfg, damageMultiplier, contactTarget, attackerId, now) {
    if (!station || station.alive === false || station.state === "destroyed") return 0;
    const isContact = contactTarget && station.id === contactTarget.id;
    const nearest = nearestStationHullPoint(origin.x, origin.y, station);
    const distance = fastHypot(nearest.x - origin.x, nearest.y - origin.y);
    const blastR = cfg.blastRadius;
    if (!isContact && distance >= blastR) return 0;
    const centreDamage = cfg.centreDamage ?? cfg.splashCentreDamage ?? 0;
    const directContactMultiplier = cfg.directContactMultiplier ?? 1.5;
    const directContactHullDamage = cfg.directContactHullDamage ?? (centreDamage * directContactMultiplier);
    const falloff = isContact
      ? 1
      : Math.pow(Math.max(0, 1 - distance / blastR), Math.max(0, cfg.falloffExponent));
    const hullDamage = (isContact ? directContactHullDamage : centreDamage) * falloff * damageMultiplier;
    if (hullDamage <= 0) return 0;
    // Demolition charges bypass ship shields, so station shields follow the same
    // rule. Station combat still owns component HP and victory state.
    return require("../stationCombat").damageStation(
      room,
      station,
      hullDamage,
      attackerId,
      now,
      origin.x,
      origin.y,
      { shieldDamageMultiplier: 0 }
    );
  }
  
  
  
  function applyBlastDamageToShip(room, target, origin, cfg, damageMultiplier, contactTargetShip, attackerId, now) {
    if (!target || !target.alive) return 0;
    const isContact = contactTargetShip && target.id === contactTargetShip.id;
    const blastR = cfg.blastRadius;
    const exp = Math.max(0, cfg.falloffExponent);
    const worldCells = getShipComponentCellWorldCoords(target);
    let nearestDist = Infinity;
    for (let i = 0; i < (target.design || []).length; i += 1) {
      if ((target.componentHp?.[i] ?? 1) <= 0) continue;
      const cells = worldCells[i];
      if (!cells || !cells.length) continue;
      for (const cell of cells) {
        const dx = cell.x - origin.x;
        const dy = cell.y - origin.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < nearestDist) nearestDist = distSq;
      }
    }
    if (nearestDist >= blastR * blastR) return 0;
    const distance = Math.sqrt(nearestDist);
  
    const centreDamage = cfg.centreDamage ?? cfg.splashCentreDamage ?? 0;
    const directContactMultiplier = cfg.directContactMultiplier ?? 1.5;
    const directContactHullDamage = cfg.directContactHullDamage ?? (centreDamage * directContactMultiplier);
    const contactMaxAffected = cfg.contactMaxAffectedComponents === null
      ? null
      : (cfg.contactMaxAffectedComponents ?? cfg.maxAffectedComponents ?? 6);
    const splashMaxAffected = cfg.splashMaxAffectedComponents === null
      ? null
      : (cfg.splashMaxAffectedComponents ?? cfg.maxAffectedComponents ?? 6);
    const contactInternalReduction = cfg.contactInternalDamageReduction ?? cfg.internalDamageReduction ?? 0.7;
    const splashInternalReduction = cfg.splashInternalDamageReduction ?? cfg.internalDamageReduction ?? 0.7;
  
    const falloff = isContact ? 1 : Math.pow(Math.max(0, 1 - distance / blastR), exp);
    const base = isContact ? directContactHullDamage : centreDamage;
    const hullBudget = base * falloff * damageMultiplier;
    if (hullBudget <= 0) return 0;
  
    const maxComponents = isContact ? contactMaxAffected : splashMaxAffected;
    const internalReduction = isContact ? contactInternalReduction : splashInternalReduction;
  
    const candidates = [];
    for (let i = 0; i < (target.design || []).length; i += 1) {
      if (!isComponentAlive(target, i)) continue;
      const pos = componentAimWorldPosition(target, i);
      if (!pos) continue;
      const cdx = pos.x - origin.x;
      const cdy = pos.y - origin.y;
      const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
      const exposed = isComponentExposed(target, i);
      const part = PARTS[target.design[i].type] || PARTS.frame;
      const isArmour = (part.armorFlatReduction || 0) > 0 || STRUCTURAL_COMPONENT_TYPES.has(target.design[i].type);
      candidates.push({ index: i, distance: cdist, exposed, isArmour });
    }
    if (!candidates.length) return 0;
    candidates.sort((a, b) => {
      if (Math.abs(a.distance - b.distance) > 1e-6) return a.distance - b.distance;
      if (a.exposed !== b.exposed) return a.exposed ? -1 : 1;
      if (a.isArmour !== b.isArmour) return a.isArmour ? -1 : 1;
      return a.index - b.index;
    });
  
    const affected = Number.isFinite(maxComponents)
      ? candidates.slice(0, Math.max(1, Math.round(maxComponents)))
      : candidates;
    let totalRemoved = 0;
  
    // Ripple: nearest component takes the largest share, each further one takes half as much.
    let fracTotal = 0;
    const fractions = [];
    for (let k = 0; k < affected.length; k += 1) {
      const frac = Math.pow(0.65, k);
      fractions.push(frac);
      fracTotal += frac;
    }
  
    for (let k = 0; k < affected.length; k += 1) {
      const c = affected[k];
      let dmg = (hullBudget * fractions[k]) / fracTotal;
      if (!c.exposed && !c.isArmour) dmg *= (1 - internalReduction);
      if (dmg > 0) {
        const dealt = applyDirectComponentDamage(room, target, c.index, dmg, attackerId, now);
        totalRemoved += dealt;
      }
    }
  
    if (target.hp <= 0.001) destroyShip(room, target, attackerId, now);
    return totalRemoved;
  }
  
  
  
  function calculateLinearChargeMultiplier(armedCount) {
    return Math.max(0, Number(armedCount) || 0);
  }
  
  
  
  function detonateProximityCharge(room, ship, index, now, markDetonated = true, contactTargetShip = null, contactPoint = null) {
  
    if (!room || !ship || ship.alive === false || ship.destroyFinalizedAt) return;
  
    if (index < 0 || !Array.isArray(ship.proximityChargeDetonated)) return;
  
    const cfg = getProximityChargeConfig(ship, index);
  
    if (!cfg) return;
  
    if (ship.proximityChargeDetonated[index]) return;
  
  
  
    const indexes = getShipComponentIndexes(ship).proximityChargeIndices;
  
    const armedIndexes = [];
  
    for (const i of indexes) {
  
      if (ship.proximityChargeDetonated?.[i]) continue;
  
      armedIndexes.push(i);
  
    }
  
    if (armedIndexes.length === 0) return;
  
  
  
    if (markDetonated) {
  
      for (const i of indexes) ship.proximityChargeDetonated[i] = 1;
  
    }
  
    ship.proximityChargeRevision = (ship.proximityChargeRevision || 0) + 1;
  
  
  
    const origin = (contactPoint && Number.isFinite(contactPoint.x) && Number.isFinite(contactPoint.y))
  
      ? { x: contactPoint.x, y: contactPoint.y }
  
      : proximityChargeWorldPosition(ship, armedIndexes[0]);
  
    if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return;
  
  
  
    const blastR = cfg.blastRadius;
  
    const exp = Math.max(0, cfg.falloffExponent);
  
    const damageMultiplier = calculateLinearChargeMultiplier(armedIndexes.length);
  
    const attackerId = ship.ownerId;
  
  
  
    const diagnostics = {
  
      carrierId: ship.id,
  
      triggerEnemyId: contactTargetShip ? contactTargetShip.id : null,
  
      contactPoint: { x: origin.x, y: origin.y },
  
      collisionGeometry: contactPoint ? contactPoint.geometry : "component",
  
      sweptContact: contactPoint && contactPoint.t !== undefined ? contactPoint.t < 1 : false,
  
      sweptT: contactPoint ? contactPoint.t : 1,
  
      chargeCount: armedIndexes.length,
  
      combinedMultiplier: damageMultiplier,
  
      directTargetId: contactTargetShip ? contactTargetShip.id : null,
  
      allocations: [],
  
      hpRemoved: 0,
  
      carrierDestroyed: false,
  
      duplicateReason: null
  
    };
  
  
  
    room.effects.push({ type: "text", text: "DEMOLITION CHARGE DETONATED", x: origin.x, y: origin.y - 18, at: now });
  
    room.effects.push({ type: "flakburst", x: origin.x, y: origin.y, at: now, radius: blastR });
  
  
  
    const spatial = room.disableSpatialIndex ? null : (room.spatialIndex?.dynamicValid ? room.spatialIndex : null);
  
    const scratch = room._demolitionBlastScratch || (room._demolitionBlastScratch = { ships: [], drones: [], projectiles: [] });
  
  
  
    for (const kind of ["ships", "drones", "projectiles"]) {
  
      const out = scratch[kind];
  
      out.length = 0;
  
      if (spatial) {
  
        const key = kind === "projectiles" ? "interceptableProjectiles" : kind;
  
        spatial.queryRangeUnordered(key, origin.x, origin.y, blastR, out);
  
      } else if (kind === "ships") {
  
        for (const s of room.ships?.values?.() || []) if (s?.alive) out.push(s);
  
      } else if (kind === "drones") {
  
        for (const d of room.drones?.values?.() || []) if (d && !d.destroyed && !d.removed) out.push(d);
  
      } else if (kind === "projectiles") {
  
        for (const b of room.bullets || []) if (b && b.life > 0 && b.interceptable) out.push(b);
  
      }
  
      for (const entity of out) {
  
        if (entity === ship) continue;
  
        if (kind === "ships") {
  
          if (!entity.alive) continue;
          if (cfg.damagesFriendlyShips === false && !areEnemies(room, attackerId, entity.ownerId)) continue;
  
          const removed = applyBlastDamageToShip(room, entity, origin, cfg, damageMultiplier, contactTargetShip, attackerId, now);
  
          diagnostics.hpRemoved += removed;
  
        } else if (kind === "drones") {
  
          if (entity.destroyed || entity.removed) continue;
  
          const dx = entity.x - origin.x;
  
          const dy = entity.y - origin.y;
  
          const edge = Math.max(0, fastHypot(dx, dy) - (entity.radius || 6));
  
          if (edge >= blastR) continue;
  
          const damage = blastDamageFor(edge, blastR, (cfg.centreDamage ?? cfg.splashCentreDamage), exp) * damageMultiplier;
  
          if (damage > 0) require("../drones").damageDrone(room, entity, damage, attackerId, now);
  
        } else if (kind === "projectiles") {
  
          if (entity.life <= 0 || !entity.interceptable) continue;
  
          const dx = entity.x - origin.x;
  
          const dy = entity.y - origin.y;
  
          const edge = Math.max(0, fastHypot(dx, dy) - 2);
  
          if (edge >= blastR) continue;
  
          const damage = blastDamageFor(edge, blastR, (cfg.centreDamage ?? cfg.splashCentreDamage), exp) * damageMultiplier;
  
          if (damage <= 0.001) continue;
  
          entity.hp = (entity.hp ?? (entity.damage || 20)) - damage;
  
          if (entity.hp <= 0.001) {
  
            removeProjectileRuntime(room, entity, "intercepted", entity.x, entity.y);
  
            room.effects.push({ type: "spark", x: entity.x, y: entity.y, at: now });
  
          }
  
        }
  
      }
  
    }
  
    for (const station of room.stations || []) {
      if (!station || station.alive === false || station.state === "destroyed") continue;
      if (cfg.damagesFriendlyShips === false && !Relationships.areEntityEnemies(room, attackerId, station)) continue;
      diagnostics.hpRemoved += applyBlastDamageToStation(
        room,
        station,
        origin,
        cfg,
        damageMultiplier,
        contactTargetShip,
        attackerId,
        now
      );
    }
  
  
  
    ship.shield = 0;
  
    zeroAllComponents(ship);
  
    ship.hp = 0;
  
    ship.focusTargetId = null;
  
    ship.combatTargetId = null;
  
    ship.repairTargetId = null;
    const movementRuntime = require("../movementRuntime");
    movementRuntime.setMovementCommand(ship, null);
    movementRuntime.syncMovementTarget(ship);
  
    ship.commandAuraActive = false;
  
    ship.commandAuraReceived = false;
  
    invalidateShipCollisionGeometry(ship);
  
  
  
    diagnostics.carrierDestroyed = true;
  
    if (DEMOLITION_DIAGNOSTICS) {
  
      if (!room._demolitionDiagnostics) room._demolitionDiagnostics = [];
  
      room._demolitionDiagnostics.push(diagnostics);
  
    }
  
  
  
    destroyShip(room, ship, attackerId, now);
  
  }
  
  
  
  function proximityChargeDestroyedShip(room, ship, now) {
  
    if (!ship || !ship.alive) return;
  
    const indexes = getShipComponentIndexes(ship).proximityChargeIndices;
  
    for (const i of indexes) {
  
      if (!isComponentAlive(ship, i)) continue;
  
      if (ship.proximityChargeDetonated?.[i]) continue;
  
      detonateProximityCharge(room, ship, i, now, true);
  
    }
  
  }

  return {
    armedProximityChargeRanges,
    resolveDemolitionContacts,
    updateProximityCharges,
    detonateProximityCharge,
    proximityChargeDestroyedShip,
    nearestDemolitionTargetPoint,
    shipHasOperationalDemolitionCharge
  };
}

module.exports = { createDemolitionRuntime };
