"use strict";

const assert = require("assert");
const { createRoom } = require("../src/server/rooms");
const { DEFAULT_DESIGN } = require("../src/server/config");
const { computeStats } = require("../src/server/shipStats");
const {
  AI_BLUEPRINTS,
  ROLE_LABELS
} = require("../src/server/aiBlueprints");
const {
  addBot,
  updateBots,
  refreshBotDesigns,
  buildBotBattlefieldContext
} = require("../src/server/ships");
const { buyShip } = require("../src/server/economy");

function makeHuman(id = "human", team = "blue") {
  const design = DEFAULT_DESIGN.map((part) => ({ ...part }));
  return {
    id,
    name: id,
    team,
    ready: true,
    design,
    dataLinks: [],
    stats: computeStats(design),
    ships: [],
    money: 5000,
    spent: 0,
    earned: 5000,
    deployedFleetCost: 0,
    shipCap: 8,
    maxMoney: 99999,
    connected: true,
    client: {},
    purchaseRequests: new Map()
  };
}

function setup(mode = "better", visibilityMode = "full") {
  const room = createRoom(`AI${mode}${visibilityMode}`.slice(0, 8));
  room.phase = "active";
  room.mapSeed = 24680;
  room.rules = {
    ...room.rules,
    aiDesignMode: mode,
    infrastructureMode: "classic",
    visibilityMode
  };
  room.players.clear();
  room.ships.clear();
  room.points = [];
  const human = makeHuman();
  room.players.set(human.id, human);
  addBot(room, human);
  const bot = [...room.players.values()].find((player) => player.isBot);
  bot.ready = true;
  bot.money = 5000;
  bot.shipCap = 8;
  return { room, human, bot };
}

assert(AI_BLUEPRINTS.length >= 8, "the Better AI pool contains multiple validated blueprints");
assert(AI_BLUEPRINTS.every((blueprint) => ROLE_LABELS[blueprint.role]), "every AI blueprint has a tactical role");
assert(AI_BLUEPRINTS.every((blueprint) => blueprint.stats.thrust > 0), "every AI blueprint can move");
assert(AI_BLUEPRINTS.every((blueprint) => blueprint.name && !/^Design \d+$/i.test(blueprint.name)), "AI blueprints have readable tactical names");

{
  const standard = setup("standard");
  assert.deepStrictEqual(standard.bot.design, DEFAULT_DESIGN.map((part) => ({ ...part })), "Standard mode keeps the stock bot design");

  const better = setup("better");
  assert.strictEqual(better.bot.ai.designMode, "better", "Better mode is stored on the bot AI state");
  assert.notDeepStrictEqual(better.bot.design, DEFAULT_DESIGN.map((part) => ({ ...part })), "Better mode assigns an exported AI blueprint");

  better.room.phase = "lobby";
  refreshBotDesigns(better.room);
  assert.strictEqual(better.bot.ai.designMode, "better", "refreshing the lobby keeps Better mode active");
}

{
  const { room, bot } = setup("better");
  const point = { id: "A", x: 3000, y: 1800, radius: 280, ownerId: null, ownerTeam: null, progress: 0 };
  room.points = [point];
  updateBots(room, 1000);
  assert(bot.ships.length > 0, "Better AI buys a ship when it has money");
  assert(bot.ships.some((ship) => ship.aiRole === "capture"), "Better AI selects a capture role for an unclaimed point");
  const captureShip = bot.ships.find((ship) => ship.aiRole === "capture");
  assert.strictEqual(Math.round(captureShip.targetX), point.x, "capture ships drive directly into the capture radius");
  assert.strictEqual(Math.round(captureShip.targetY), point.y, "capture ships hold the point centre instead of circling outside it");

  point.ownerTeam = bot.team;
  point.ownerId = bot.id;
  point.progress = 1;
  const human = [...room.players.values()].find((player) => !player.isBot);
  const enemy = buyShip(room, human, 1000, { silent: true });
  assert(enemy, "the combat fixture creates a visible enemy ship");
  enemy.x = captureShip.x + 240;
  enemy.y = captureShip.y;
  updateBots(room, bot.ai.nextThinkAt + 1);
  assert(bot.ships.some((ship) => ship.focusTargetId === enemy.id), "the AI switches from point-taking to a visible combat target");
}

{
  const { room, bot, human } = setup("better", "sensors");
  const enemy = buyShip(room, human, 1000, { silent: true });
  enemy.x = bot.ships[0]?.x + 2400 || 2400;
  enemy.y = bot.ships[0]?.y || 1800;
  const before = buildBotBattlefieldContext(room, bot, [], 1000, false);
  assert.strictEqual(before.visibleEnemies.length, 0, "sensor fog hides the distant enemy from bot targeting");
  assert(before.hiddenEnemyCount > 0, "the bot still knows that an unscanned enemy may exist");
  updateBots(room, 1000);
  const after = buildBotBattlefieldContext(room, bot, bot.ships.filter((ship) => ship.alive), 1000, false);
  const visibleIds = new Set(after.visibleEnemies.map((ship) => ship.id));
  assert(bot.ships.every((ship) => !ship.focusTargetId || visibleIds.has(ship.focusTargetId)), "sensor-aware AI only focuses enemies visible after its new sensor ships deploy");
}

console.log("AI blueprint, role selection, objective, and sensor checks passed");
