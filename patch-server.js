"use strict";

const fs = require("fs");
const path = require("path");

const serverPath = path.join(__dirname, "server.js");
let source = fs.readFileSync(serverPath, "utf8");

source = source.replace("startingMoney: 420,", "startingMoney: 700,");

const oldValidateBuildShip = `function validateBuildShip(room, player, stats = null) {
  if (!player.ready && room.phase === "active") {
    return { ok: false, reason: "Invalid design: save a blueprint first." };
  }
  const shipStats = stats || player.stats || computeStats(player.design);
  const activeCount = player.ships.filter((ship) => !ship.removed && ship.alive).length;
  if (activeCount >= player.shipCap) {
    return { ok: false, reason: "Ship limit reached for this match." };
  }
  const activeFleetCost = getActiveFleetCost(player);
  if (activeFleetCost + shipStats.unitCost > player.deploymentBudget) {
    return { ok: false, reason: \`Starting fleet limit exceeded by $\${activeFleetCost + shipStats.unitCost - player.deploymentBudget}.\` };
  }
  if (shipStats.unitCost > player.money) {
    return { ok: false, reason: \`Cannot build ship. Need $\${shipStats.unitCost - Math.floor(player.money)} more.\` };
  }
  return { ok: true, shipCost: shipStats.unitCost, shipStats };
}`;

const newValidateBuildShip = `function validateBuildShip(room, player, stats = null) {
  if (!player.ready && room.phase === "active") {
    return { ok: false, reason: "Invalid design: ready a starting design first." };
  }
  const shipStats = stats || player.stats || computeStats(player.design);
  const activeCount = player.ships.filter((ship) => !ship.removed && ship.alive).length;
  if (activeCount >= player.shipCap) {
    return { ok: false, reason: "Ship limit reached for this match." };
  }
  if (shipStats.unitCost > player.money) {
    return { ok: false, reason: \`Cannot ready design. Need $\${shipStats.unitCost - Math.floor(player.money)} more.\` };
  }
  return { ok: true, shipCost: shipStats.unitCost, shipStats };
}`;

source = source.replace(oldValidateBuildShip, newValidateBuildShip);

const buyShipBlockPattern = /  if \(message\.type === "buyShip"\) \{[\s\S]*?    return;\n  \}/;
const newBuyShipBlock = `  if (message.type === "buyShip") {
    if (client.room.phase !== "active") {
      send(client, { type: "error", message: "Ships can only be built after the match starts" });
      return;
    }
    const count = clampNumber(message.count, 1, 5);
    const designSource = Array.isArray(message.design) ? message.design : client.player.design;
    const design = validateDesign(designSource);
    client.player.design = design.modules;
    client.player.stats = design.stats;
    const validation = validateBuyShip(client.room, client.player, count, design.stats);
    if (!validation.ok) {
      client.player.lastBuildError = validation.reason;
      send(client, { type: "error", message: validation.reason });
      return;
    }
    for (let i = 0; i < validation.count; i += 1) {
      buyShip(client.room, client.player, performanceNow(), { prevalidated: true });
    }
    return;
  }`;

source = source.replace(buyShipBlockPattern, newBuyShipBlock);

fs.writeFileSync(serverPath, source);
console.log("Applied editor blueprint build patch.");
