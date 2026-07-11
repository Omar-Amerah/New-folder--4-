// Handles currency tracking, income calculations, ship purchases, and post-match reward distribution.

const { ECONOMY, REWARDS } = require("./config");
const { clampNumber, round } = require("./utils");
const { computeStats } = require("./shipStats");
const { normalizeShipDesignSnapshot } = require("./shipDesign");
const { spawnShip } = require("./ships");
const { validateBuildShip } = require("./validation");

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

  player.money -= stats.unitCost;
  player.spent += stats.unitCost;
  player.deployedFleetCost += stats.unitCost;
  player.shipsBuilt = (player.shipsBuilt || 0) + 1;
  const activeCount = player.ships.filter((ship) => ship.alive).length;
  const combatStyle = options.combatStyle || player.combatStyle || "charge";
  const ship = spawnShip(room, player, now, activeCount, { stats, design, combatStyle });
  if (!options.starter && !options.silent) {
    const { broadcastRoom } = require("./messages");
    broadcastRoom(room, { type: "notice", message: `${player.name} built a ship for $${stats.unitCost}` });
  }
  return ship;
}

function validateBuyShip(room, player, count = 1, stats = null) {
  if (room.phase !== "active") {
    return { ok: false, reason: "Ships can only be built after the match starts" };
  }
  if (!player.ready) {
    return { ok: false, reason: "Invalid design: save a blueprint first." };
  }
  const shipStats = stats || player.stats || computeStats(player.design);
  if (shipStats.thrust <= 0) {
    return { ok: false, reason: "Invalid design: add at least one engine." };
  }
  const requestedCount = clampNumber(count, 1, 5);
  const activeCount = player.ships.filter((ship) => ship.alive).length;
  if (activeCount + requestedCount > player.shipCap) {
    const remainingSlots = Math.max(0, player.shipCap - activeCount);
    return {
      ok: false,
      reason: requestedCount === 1
        ? `Fleet cap reached: ${activeCount}/${player.shipCap} ships active`
        : `Not enough fleet slots: ${remainingSlots} available, ${requestedCount} requested`
    };
  }
  const totalCost = shipStats.unitCost * requestedCount;
  if (player.money < totalCost) {
    return { ok: false, reason: `Not enough money: need $${totalCost - Math.floor(player.money)} more` };
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
    const gained = player.income * dt;
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
  validateBuyShip,
  updateEconomy,
  finalizeMatchRewards,
  calculateBattleReward,
  getActiveFleetCost
};
