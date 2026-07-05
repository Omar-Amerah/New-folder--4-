"use strict";

const fs = require("fs");
const path = require("path");

const requiredFiles = [
  path.join(__dirname, "public", "index.html"),
  path.join(__dirname, "public", "client.js"),
  path.join(__dirname, "public", "styles.css"),
  path.join(__dirname, "public", "blueprint-fix.js")
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing required Netlify asset: ${file}`);
  }
}

const serverPath = path.join(__dirname, "server.js");
let server = fs.readFileSync(serverPath, "utf8");

server = server.replace("startingMoney: 420,", "startingMoney: 700,");

const readyBudgetCheck = `  const activeFleetCost = getActiveFleetCost(player);
  if (activeFleetCost + shipStats.unitCost > player.deploymentBudget) {
    return { ok: false, reason: \`Starting fleet limit exceeded by $\${activeFleetCost + shipStats.unitCost - player.deploymentBudget}.\` };
  }
`;
server = server.replace(readyBudgetCheck, "");

const buyShipValidator = "const validation = validateBuyShip(client.room, client.player, count);";
const buyShipValidatorPatch = `const incomingDesign = Array.isArray(message.design) ? validateDesign(message.design) : null;
    if (incomingDesign) {
      client.player.design = incomingDesign.modules;
      client.player.stats = incomingDesign.stats;
    }
    const validation = validateBuyShip(client.room, client.player, count, incomingDesign?.stats || null);`;
server = server.replace(buyShipValidator, buyShipValidatorPatch);

fs.writeFileSync(serverPath, server);
console.log("Netlify static assets are ready in public/ and server blueprint rules are patched.");
