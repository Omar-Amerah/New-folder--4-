// Handles currency tracking, income calculations, ship purchases, and post-match reward distribution.

const { ECONOMY, REWARDS } = require("./config");
const { clampNumber, round } = require("./utils");
const { computeStats } = require("./shipStats");
const { normalizeShipDesignSnapshot } = require("./shipDesign");
const { spawnShip } = require("./ships");
const { validateBuildShip } = require("./validation");

const PURCHASE_IDEMPOTENCY_TTL_MS = 2 * 60 * 1000;
const MAX_PURCHASE_REQUESTS = 64;

function activeFleetCount(player) {
  return player.ships.filter((ship) => ship.alive).length;
}

function finiteMoney(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function buyShip(room, player, now, options = {}) {
  if (!player.ready) return null;
  const stats = options.stats || player.stats || computeStats(player.design);
  const design = normalizeShipDesignSnapshot(options.design || player.design);
  if (!options.prevalidated) {
    const validation = options.starter
      ? validateBuildShip(room, player, stats)
      : validateBuyShip(room, player, 1, stats);
    if (!validation.ok) {
      if (!options.silent) player.lastBuildError = validation.reason;
      return null;
    }
  }

  player.shipsBuilt = (player.shipsBuilt || 0) + 1;
  const activeCount = activeFleetCount(player);
  const combatStyle = options.combatStyle || player.combatStyle || "sentry";
  const ship = spawnShip(room, player, now, activeCount, { stats, design, combatStyle });
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

function stablePayloadSignature(payload) {
  return JSON.stringify({
    count: payload.count,
    combatStyle: payload.combatStyle || "",
    design: (payload.design || []).map((part) => ({
      x: part.x,
      y: part.y,
      type: part.type,
      rotation: part.rotation || 0
    }))
  });
}

function makePurchaseFailure(requestId, code, message) {
  return { type: "purchaseResult", ok: false, requestId, code, message };
}

function executePurchase(room, player, request, now) {
  prunePurchaseRequestCache(player, now);
  const requestId = String(request.requestId || "");
  if (!requestId) {
    return makePurchaseFailure(requestId, "invalid-request", "Invalid purchase request");
  }
  if (!player.client || player.removed) {
    return makePurchaseFailure(requestId, "stale-connection", "This connection is no longer active for that player");
  }

  const signature = stablePayloadSignature(request);
  const cache = getPurchaseRequestCache(player);
  const previous = cache.get(requestId);
  if (previous) {
    if (previous.signature === signature) return { ...previous.result, duplicate: true };
    return makePurchaseFailure(requestId, "duplicate-request-conflict", "Purchase request ID was already used");
  }

  const validation = validateBuyShip(room, player, request.count, request.stats);
  if (!validation.ok) {
    player.lastBuildError = validation.reason;
    const result = makePurchaseFailure(requestId, validation.code || "invalid-request", validation.reason);
    cache.set(requestId, { at: now, signature, result });
    prunePurchaseRequestCache(player, now);
    return result;
  }

  const design = normalizeShipDesignSnapshot(request.design);
  const combatStyle = request.combatStyle || player.combatStyle || "sentry";
  const createdShips = [];
  const original = {
    money: player.money,
    spent: player.spent,
    deployedFleetCost: player.deployedFleetCost,
    shipsBuilt: player.shipsBuilt || 0,
    shipsLength: player.ships.length,
    nextEntityId: room.nextEntityId
  };

  try {
    for (let i = 0; i < validation.count; i += 1) {
      const index = activeFleetCount(player) + i;
      createdShips.push(spawnShip(room, player, now, index, {
        stats: validation.shipStats,
        design,
        combatStyle
      }));
    }
  } catch {
    for (const ship of createdShips) {
      ship.removed = true;
      room.ships.delete(ship.id);
    }
    player.ships.length = original.shipsLength;
    room.nextEntityId = original.nextEntityId;
    return makePurchaseFailure(requestId, "spawn-failed", "Could not spawn ship");
  }

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
  for (const point of room.points) {
    if (point.ownerTeam && point.progress >= 0.98) {
      ownedRelays.set(point.ownerTeam, (ownedRelays.get(point.ownerTeam) || 0) + 1);
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

function finalizeMatchRewards(room) {
  if (!room.winner) return;
  const players = [...room.players.values()];
  for (const player of players) {
    const didWin = player.team === room.winner.team;
    const enemyFleetCost = players
      .filter((other) => other.team !== player.team)
      .reduce((total, other) => total + Math.max(other.deployedFleetCost, getActiveFleetCost(other)), 0);
    const playerFleetCost = Math.max(player.deployedFleetCost, player.spent, getActiveFleetCost(player), 1);
    const survivingFriendlyShips = player.ships.filter((ship) => ship.alive).length;
    const reward = calculateBattleReward({
      didWin,
      destroyedEnemyCost: player.destroyedEnemyCost,
      enemyFleetCost,
      playerFleetCost,
      survivingFriendlyShips
    });
    player.money = Math.min(player.maxMoney || ECONOMY.maxMoney, player.money + reward.total);
    player.bank = player.money;
    player.earned += reward.total;
    player.lastReward = reward;
  }
}

function calculateBattleReward({ didWin, destroyedEnemyCost, enemyFleetCost, playerFleetCost, survivingFriendlyShips }) {
  const destroyedReward = Math.min(
    destroyedEnemyCost * REWARDS.destroyedEnemyCostMultiplier,
    REWARDS.maxDestroyedReward
  );

  if (!didWin) {
    const lossDestroyed = destroyedEnemyCost * REWARDS.lossDestroyedMultiplier;
    const total = Math.max(REWARDS.minimumLossReward, REWARDS.lossSupport + lossDestroyed);
    return {
      didWin,
      base: 0,
      lossSupport: REWARDS.lossSupport,
      destroyed: Math.round(lossDestroyed),
      victory: 0,
      survival: 0,
      efficiency: 0,
      overpowerMultiplier: 1,
      total: Math.round(total)
    };
  }

  const survivalBonus = survivingFriendlyShips * REWARDS.survivalBonusPerShip;
  let efficiencyBonus = 0;
  if (enemyFleetCost > playerFleetCost) {
    const efficiencyRatio = enemyFleetCost / Math.max(playerFleetCost, 1);
    efficiencyBonus = Math.min((efficiencyRatio - 1) * REWARDS.efficiencyBonusScale, REWARDS.maxEfficiencyBonus);
  }

  let victoryBonus = REWARDS.victoryBonus;
  let overpowerMultiplier = 1;
  if (playerFleetCost > enemyFleetCost * 1.4) {
    const overpowerRatio = playerFleetCost / Math.max(enemyFleetCost, 1);
    overpowerMultiplier = Math.max(REWARDS.minimumOverpowerRewardMultiplier, 1 - ((overpowerRatio - 1.4) * 0.25));
    victoryBonus *= overpowerMultiplier;
  }

  const total = REWARDS.baseReward + destroyedReward + victoryBonus + survivalBonus + efficiencyBonus;
  return {
    didWin,
    base: REWARDS.baseReward,
    destroyed: Math.round(destroyedReward),
    victory: Math.round(victoryBonus),
    survival: Math.round(survivalBonus),
    efficiency: Math.round(efficiencyBonus),
    overpowerMultiplier: round(overpowerMultiplier),
    total: Math.max(REWARDS.minimumWinReward, Math.round(total))
  };
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
  finalizeMatchRewards,
  calculateBattleReward,
  getActiveFleetCost,
  activeFleetCount,
  PURCHASE_IDEMPOTENCY_TTL_MS
};
