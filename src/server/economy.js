// Handles current-match currency tracking, income calculations, and ship purchases.

const { ECONOMY } = require("./config");
const { usesStationInfrastructure } = require("./rooms");
const { findTeamHomeStation } = require("./stations");
const { clampNumber } = require("./utils");
const { computeStats } = require("./shipStats");
const { createShipBlueprintSnapshot } = require("./shipDesign");
const { spawnShip, applyRallyPoint } = require("./ships");
const { validateBuildShip } = require("./validation");
const { getOrCreateTemplate, canonicalBlueprintSignature } = require("./shipTemplates");
const { recordPurchaseStage } = require("./performanceTelemetry");
const Relationships = require("./relationships");

const PURCHASE_IDEMPOTENCY_TTL_MS = 2 * 60 * 1000;
const MAX_PURCHASE_REQUESTS = 64;

function activeFleetCount(player) {
  return player.ships.filter((ship) => ship.alive).length;
}

function finiteMoney(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function refreshShipSpatialIndex(room, now) {
  if (!room.spatialIndex?.rebuildKind) return;
  const { shipBroadPhaseRadius } = require("./spatialIndex");
  room.spatialIndex.rebuildKind(
    "ships",
    [...room.ships.values()].filter((ship) => ship?.alive),
    shipBroadPhaseRadius,
    now
  );
}

function buyShip(room, player, now, options = {}) {
  if (!player.ready) return null;
  const stats = options.stats || player.stats || computeStats(player.design);
  const blueprint = createShipBlueprintSnapshot(options.design || player.design, options.dataLinks !== undefined ? options.dataLinks : player.dataLinks);
  const { design, dataLinks } = blueprint;
  if (!options.prevalidated) {
    const validation = options.starter
      ? validateBuildShip(room, player, stats)
      : validateBuyShip(room, player, 1, stats);
    if (!validation.ok) {
      if (!options.silent) player.lastBuildError = validation.reason;
      return null;
    }
  }

  const activeCount = activeFleetCount(player);
  const combatStyle = options.combatStyle || player.combatStyle || "hold";
  const {
    getPlannedSpawn, planShipSpawns, createSpawnReservations,
    releaseSpawnReservations, assertNoShipOverlap,
    pushShipsOutOfSpawn, rollbackPushedShips
  } = require("./spawnPlanner");
  const { computeDesignCollisionRadius } = require("./componentGeometry");
  const preferred = getPlannedSpawn(room, player.id);
  const requestId = options.requestId || `single:${player.id}:${room.nextEntityId}`;
  const physicalRadius = computeDesignCollisionRadius(design, stats);
  const original = {
    shipsLength: player.ships.length,
    effectsLength: room.effects.length,
    nextEntityId: room.nextEntityId
  };
  const pushed = pushShipsOutOfSpawn(room, {
    preferredX: preferred.x,
    preferredY: preferred.y,
    physicalRadius,
    ownerId: player.id,
    requestId
  });
  if (pushed.ok && pushed.moved.length) refreshShipSpatialIndex(room, now);
  const plan = planShipSpawns(room, {
    count: 1,
    preferredX: preferred.x,
    preferredY: preferred.y,
    physicalRadius,
    ownerId: player.id,
    requestId,
    spawnAngle: preferred.angle,
    now
  });
  if (!plan.ok) {
    rollbackPushedShips(pushed.moved);
    if (pushed.moved?.length) refreshShipSpatialIndex(room, now);
    if (!options.silent) player.lastBuildError = "No safe launch position is currently available.";
    return null;
  }
  const reservations = createSpawnReservations(room, player.id, requestId, plan.placements, now);
  let ship;
  try {
    ship = spawnShip(room, player, now, activeCount, { stats, design, dataLinks, combatStyle, combatStyleRaw: options.combatStyleRaw, spawnPoint: plan.placements[0], requestId });
    if (process.env.NODE_ENV !== "production") assertNoShipOverlap(room, ship);
    applyRallyPoint(room, player, [ship]);
  } catch (error) {
    for (const added of player.ships.slice(original.shipsLength)) {
      room.spatialIndex?.remove?.("ships", added);
      room.ships.delete(added.id);
    }
    player.ships.length = original.shipsLength;
    room.effects.length = original.effectsLength;
    room.nextEntityId = original.nextEntityId;
    rollbackPushedShips(pushed.moved);
    if (pushed.moved?.length) refreshShipSpatialIndex(room, now);
    releaseSpawnReservations(room, reservations);
    if (!options.silent) player.lastBuildError = error.message;
    return null;
  }
  releaseSpawnReservations(room, reservations);
  player.shipsBuilt = (player.shipsBuilt || 0) + 1;
  player.money = finiteMoney(player.money - stats.unitCost);
  player.spent = finiteMoney(player.spent + stats.unitCost);
  player.deployedFleetCost = finiteMoney(player.deployedFleetCost + stats.unitCost);
  if (!options.starter && !options.silent) {
    const { broadcastRoom } = require("./messages");
    broadcastRoom(room, { type: "notice", message: `${player.name} built a ship for $${stats.unitCost}` });
  }
  return ship;
}

function getPurchaseRequestCache(player) {
  if (!player.purchaseRequests) player.purchaseRequests = new Map();
  return player.purchaseRequests;
}

function prunePurchaseRequestCache(player, now) {
  const cache = getPurchaseRequestCache(player);
  for (const [requestId, entry] of cache) {
    if (now - entry.at > PURCHASE_IDEMPOTENCY_TTL_MS) cache.delete(requestId);
  }
  while (cache.size > MAX_PURCHASE_REQUESTS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function makePurchaseFailure(requestId, code, message) {
  return { type: "purchaseResult", ok: false, requestId, code, message };
}

function executePurchase(room, player, request, now) {
  const purchaseStart = performance.now();
  prunePurchaseRequestCache(player, now);
  const requestId = String(request.requestId || "");
  if (!requestId) {
    return makePurchaseFailure(requestId, "invalid-request", "Invalid purchase request");
  }
  if (!player.client || player.removed) {
    return makePurchaseFailure(requestId, "stale-connection", "This connection is no longer active for that player");
  }

  const validationStart = performance.now();
  const canonicalBlueprint = canonicalBlueprintSignature(request.design, request.dataLinks);
  const signature = JSON.stringify({
    count: request.count,
    combatStyle: request.combatStyle || "",
    blueprint: canonicalBlueprint
  });
  const cache = getPurchaseRequestCache(player);
  const previous = cache.get(requestId);
  if (previous) {
    if (previous.signature === signature) return { ...previous.result, duplicate: true };
    return makePurchaseFailure(requestId, "duplicate-request-conflict", "Purchase request ID was already used");
  }
  recordPurchaseStage("requestValidation", performance.now() - validationStart);

  const designValidationStart = performance.now();
  const validation = validateBuyShip(room, player, request.count, request.stats);
  if (!validation.ok) {
    player.lastBuildError = validation.reason;
    const result = makePurchaseFailure(requestId, validation.code || "invalid-request", validation.reason);
    cache.set(requestId, { at: now, signature, result });
    prunePurchaseRequestCache(player, now);
    recordPurchaseStage("designValidation", performance.now() - designValidationStart);
    return result;
  }
  recordPurchaseStage("designValidation", performance.now() - designValidationStart);

  // Reuse the already-normalised canonical blueprint for the template cache key.
  const templateStart = performance.now();
  const template = getOrCreateTemplate(player.id, request.design, request.dataLinks, validation.shipStats, canonicalBlueprint);
  const combatStyle = request.combatStyle || player.combatStyle || "hold";
  recordPurchaseStage("statCalculation", performance.now() - templateStart);

  if (usesStationInfrastructure(room) && findTeamHomeStation(room, player.team)) {
    const { enqueueStationProduction } = require("./stations");
    const result = enqueueStationProduction(room, player, { template, request, validation }, now);
    cache.set(requestId, { at: now, signature, result });
    prunePurchaseRequestCache(player, now);
    recordPurchaseStage("totalPurchaseTime", performance.now() - purchaseStart);
    return result;
  }

  const {
    getPlannedSpawn, planShipSpawns, createSpawnReservations,
    releaseSpawnReservations, assertNoShipOverlap,
    pushShipsOutOfSpawn, rollbackPushedShips
  } = require("./spawnPlanner");
  const preferred = getPlannedSpawn(room, player.id);
  const { computeDesignCollisionRadius } = require("./componentGeometry");
  const plannedPhysicalRadius = computeDesignCollisionRadius(template.design, validation.shipStats);
  const createdShips = [];
  const original = {
    money: player.money,
    spent: player.spent,
    deployedFleetCost: player.deployedFleetCost,
    shipsBuilt: player.shipsBuilt || 0,
    shipsLength: player.ships.length,
    nextEntityId: room.nextEntityId,
    effectsLength: room.effects.length,
    lastBuildError: player.lastBuildError || ""
  };
  const pushed = pushShipsOutOfSpawn(room, {
    preferredX: preferred.x,
    preferredY: preferred.y,
    physicalRadius: plannedPhysicalRadius,
    ownerId: player.id,
    requestId
  });
  if (pushed.ok && pushed.moved.length) refreshShipSpatialIndex(room, now);
  const spawnPlan = planShipSpawns(room, {
    count: validation.count,
    preferredX: preferred.x,
    preferredY: preferred.y,
    physicalRadius: plannedPhysicalRadius,
    ownerId: player.id,
    requestId,
    spawnAngle: preferred.angle,
    now
  });
  if (!spawnPlan.ok) {
    rollbackPushedShips(pushed.moved);
    if (pushed.moved?.length) refreshShipSpatialIndex(room, now);
    const result = makePurchaseFailure(requestId, "spawn-area-blocked", "No safe launch position is currently available.");
    cache.set(requestId, { at: now, signature, result });
    return result;
  }
  const spawnReservations = createSpawnReservations(room, player.id, requestId, spawnPlan.placements, now);

  try {
    // Capture the active fleet count ONCE before spawning. Recomputing it inside
    // the loop double-counts each freshly spawned ship, producing spread-out
    // spawn indexes (0, 2, 4) instead of consecutive ones (0, 1, 2).
    const initialActiveCount = activeFleetCount(player);
    for (let i = 0; i < validation.count; i += 1) {
      const shipStart = performance.now();
      const index = initialActiveCount + i;
      createdShips.push(spawnShip(room, player, now, index, {
        template,
        combatStyle,
        spawnPoint: spawnPlan.placements[i],
        requestId,
        slotId: spawnReservations[i]?.id
      }));
      recordPurchaseStage("perShipSpawnTime", performance.now() - shipStart);
    }
  } catch (error) {
    // Structured error logging
    console.error(`[Purchase] Spawn failed for request ${requestId}, player ${player.id}, room ${room.code}:`, {
      requestId,
      playerId: player.id,
      roomCode: room.code,
      requestedCount: validation.count,
      completedCount: createdShips.length,
      error: error.message,
      stack: error.stack
    });
    
    for (const ship of player.ships.slice(original.shipsLength)) {
      ship.removed = true;
      ship.alive = false;
      require("./componentGeometry").invalidateShipCollisionGeometry(ship);
      room.spatialIndex?.remove?.("ships", ship);
      room.ships.delete(ship.id);
    }
    player.ships.length = original.shipsLength;
    Relationships.revalidateTelemetryFocusForRoom(room);
    room.nextEntityId = original.nextEntityId;
    room.effects.length = original.effectsLength;
    player.money = original.money;
    player.spent = original.spent;
    player.deployedFleetCost = original.deployedFleetCost;
    player.shipsBuilt = original.shipsBuilt;
    player.lastBuildError = original.lastBuildError;
    rollbackPushedShips(pushed.moved);
    if (pushed.moved?.length) refreshShipSpatialIndex(room, now);
    
    // Assert rollback consistency
    if (process.env.NODE_ENV !== "production") {
      if (player.money !== original.money || 
          player.spent !== original.spent || 
          player.deployedFleetCost !== original.deployedFleetCost ||
          player.ships.length !== original.shipsLength) {
        console.error("[Purchase] Rollback inconsistency detected after spawn failure");
      }
    }
    
    releaseSpawnReservations(room, spawnReservations);
    return makePurchaseFailure(
      requestId,
      error?.code === "no-clear-spawn" ? "spawn-area-blocked" : "spawn-failed",
      error?.code === "no-clear-spawn" ? "No safe launch position is currently available." : "Could not spawn ship"
    );
  }

  try {
    if (process.env.NODE_ENV !== "production") {
      for (const ship of createdShips) assertNoShipOverlap(room, ship);
    }
    applyRallyPoint(room, player, createdShips);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") console.error("[Purchase] Post-spawn placement validation failed:", error);
    for (const ship of createdShips) {
      ship.removed = true;
      ship.alive = false;
      require("./componentGeometry").invalidateShipCollisionGeometry(ship);
      room.spatialIndex?.remove?.("ships", ship);
      room.ships.delete(ship.id);
    }
    player.ships.length = original.shipsLength;
    Relationships.revalidateTelemetryFocusForRoom(room);
    room.nextEntityId = original.nextEntityId;
    room.effects.length = original.effectsLength;
    player.money = original.money;
    player.spent = original.spent;
    player.deployedFleetCost = original.deployedFleetCost;
    player.shipsBuilt = original.shipsBuilt;
    player.lastBuildError = original.lastBuildError;
    rollbackPushedShips(pushed.moved);
    if (pushed.moved?.length) refreshShipSpatialIndex(room, now);
    releaseSpawnReservations(room, spawnReservations);
    return makePurchaseFailure(requestId, "spawn-failed", "Could not complete safe ship placement");
  }
  releaseSpawnReservations(room, spawnReservations);

  player.money = finiteMoney(player.money - validation.totalCost);
  player.spent = finiteMoney(player.spent + validation.totalCost);
  player.deployedFleetCost = finiteMoney(player.deployedFleetCost + validation.totalCost);
  player.shipsBuilt = original.shipsBuilt + createdShips.length;
  player.lastBuildError = "";

  const result = {
    type: "purchaseResult",
    ok: true,
    requestId,
    code: "ok",
    count: createdShips.length,
    unitCost: validation.shipStats.unitCost,
    totalCost: validation.totalCost,
    shipIds: createdShips.map((ship) => ship.id),
    money: Math.floor(player.money),
    activeShips: activeFleetCount(player),
    shipCap: player.shipCap
  };
  cache.set(requestId, { at: now, signature, result });
  prunePurchaseRequestCache(player, now);
  
  recordPurchaseStage("totalPurchaseTime", performance.now() - purchaseStart);
  
  return result;
}

function validateBuyShip(room, player, count = 1, stats = null) {
  if (room.phase !== "active") {
    return { ok: false, code: "invalid-phase", reason: "Ships can only be built after the match starts" };
  }
  if (!player.ready) {
    return { ok: false, code: "invalid-design", reason: "Invalid design: save a blueprint first." };
  }
  const shipStats = stats || player.stats || computeStats(player.design);
  if (shipStats.thrust <= 0) {
    return { ok: false, code: "invalid-design", reason: "Invalid design: add at least one engine." };
  }
  const requestedCount = clampNumber(count, 1, 5);
  const activeCount = activeFleetCount(player);
  if (activeCount + requestedCount > player.shipCap) {
    const remainingSlots = Math.max(0, player.shipCap - activeCount);
    return {
      ok: false,
      code: "fleet-cap",
      reason: requestedCount === 1
        ? `Fleet cap reached: ${activeCount}/${player.shipCap} ships active`
        : `Not enough fleet slots: ${remainingSlots} available, ${requestedCount} requested`
    };
  }
  const totalCost = shipStats.unitCost * requestedCount;
  if (player.money < totalCost) {
    return { ok: false, code: "insufficient-funds", reason: `Not enough money: need $${Math.ceil(totalCost - player.money)} more` };
  }
  return { ok: true, shipStats, count: requestedCount, totalCost };
}

function updateEconomy(room, dt) {
  const ownedRelays = new Map();
  const stationRelays = usesStationInfrastructure(room)
    ? (room.stations || []).filter((station) => station.stationType === "relay")
    : [];
  if (stationRelays.length > 0) {
    // Station relays do not mutate room.points. Their team remains authoritative
    // after destruction handoff, so a captured relay keeps paying rather than
    // silently falling back to base income.
    for (const station of stationRelays) {
      if (!station.team || station.state === "neutral") continue;
      ownedRelays.set(station.team, (ownedRelays.get(station.team) || 0) + 1);
    }
  } else {
    for (const point of room.points || []) {
      if (point.ownerTeam && point.progress >= 0.98) {
        ownedRelays.set(point.ownerTeam, (ownedRelays.get(point.ownerTeam) || 0) + 1);
      }
    }
  }

  for (const player of room.players.values()) {
    if (!player.ready || room.winner) {
      player.income = 0;
      continue;
    }

    const relays = ownedRelays.get(player.team) || 0;
    player.income = ECONOMY.baseIncome + relays * ECONOMY.relayIncome;
    const gained = finiteMoney(player.income * dt);
    player.money = Math.min(player.maxMoney || ECONOMY.maxMoney, player.money + gained);
    player.earned += gained;
  }
}

function getActiveFleetCost(player) {
  return Math.round(player.ships
    .filter((ship) => ship.alive)
    .reduce((total, ship) => total + (ship.cost || ship.stats?.unitCost || 0), 0));
}

module.exports = {
  buyShip,
  executePurchase,
  validateBuyShip,
  updateEconomy,
  getActiveFleetCost,
  activeFleetCount,
  PURCHASE_IDEMPOTENCY_TTL_MS
};
