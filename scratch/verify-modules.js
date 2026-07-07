// Verify that all server modules compile and can be loaded.

try {
  console.log("Loading config...");
  const config = require("../src/server/config");

  console.log("Loading utils...");
  const utils = require("../src/server/utils");

  console.log("Loading components...");
  const components = require("../src/server/components");

  console.log("Loading validation...");
  const validation = require("../src/server/validation");

  console.log("Loading rooms...");
  const rooms = require("../src/server/rooms");

  console.log("Loading players...");
  const players = require("../src/server/players");

  console.log("Loading shipDesign...");
  const shipDesign = require("../src/server/shipDesign");

  console.log("Loading shipStats...");
  const shipStats = require("../src/server/shipStats");

  console.log("Loading economy...");
  const economy = require("../src/server/economy");

  console.log("Loading ships...");
  const ships = require("../src/server/ships");

  console.log("Loading movement...");
  const movement = require("../src/server/movement");

  console.log("Loading projectiles...");
  const projectiles = require("../src/server/projectiles");

  console.log("Loading combat...");
  const combat = require("../src/server/combat");

  console.log("Loading objectives...");
  const objectives = require("../src/server/objectives");

  console.log("Loading hazards...");
  const hazards = require("../src/server/hazards");

  console.log("Loading snapshots...");
  const snapshots = require("../src/server/snapshots");

  console.log("Loading messages...");
  const messages = require("../src/server/messages");

  console.log("Loading websocketServer...");
  const websocketServer = require("../src/server/websocketServer");

  console.log("Loading server.js...");
  const server = require("../server");

  console.log("ALL MODULES SUCCESSFULLY VERIFIED!");
} catch (error) {
  console.error("Verification failed:", error);
  process.exit(1);
}
