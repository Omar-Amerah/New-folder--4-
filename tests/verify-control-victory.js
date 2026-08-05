"use strict";

const assert = require("assert");
const { ECONOMY } = require("../src/server/config");
const { updateEconomy } = require("../src/server/economy");
const { updateCapturePoints, updateControlVictory } = require("../src/server/objectives");

function makePlayer(id, team) {
  return {
    id,
    name: id.toUpperCase(),
    team,
    captures: 0,
    money: 0,
    bank: 0,
    earned: 0,
    spent: 0,
    maxMoney: 99999,
    destroyedEnemyCost: 0,
    deployedFleetCost: 0,
    ready: true,
    ships: []
  };
}

function makeRoom(mode = "teams", pointCount = 2) {
  const blueTeam = mode === "solo" ? "a" : "blue";
  const redTeam = mode === "solo" ? "b" : "red";
  return {
    code: "CONTROL",
    clients: new Set(),
    phase: "active",
    rules: { gameMode: mode },
    players: new Map([
      ["a", makePlayer("a", blueTeam)],
      ["b", makePlayer("b", redTeam)]
    ]),
    points: Array.from({ length: pointCount }, (_, index) => ({
      id: `R${index + 1}`,
      x: index * 200,
      y: 0,
      radius: 80,
      ownerId: null,
      ownerTeam: null,
      progress: 0,
      contested: false
    })),
    winner: null,
    winnerAt: 0,
    rewardsFinalizedForWinner: null,
    controlVictory: {
      team: null,
      playerId: null,
      startedAt: null,
      remaining: null,
      requiredSeconds: 20
    }
  };
}

function ownAllRelays(room, ownerId, ownerTeam) {
  for (const point of room.points) {
    point.ownerId = ownerId;
    point.ownerTeam = ownerTeam;
    point.progress = 1;
    point.contested = false;
  }
}

(function teamsRequireContinuousTwentySecondHold() {
  const room = makeRoom("teams");
  ownAllRelays(room, "a", "blue");
  updateControlVictory(room, 1000);
  assert.strictEqual(room.controlVictory.team, "blue");
  assert.strictEqual(room.controlVictory.remaining, 20);
  assert.strictEqual(room.winner, null);

  updateControlVictory(room, 20999);
  assert.strictEqual(room.winner, null, "a hold shorter than 20 seconds must not win");
  updateControlVictory(room, 21000);
  assert.strictEqual(room.phase, "ended");
  assert.strictEqual(room.winner.team, "blue");
  assert.strictEqual(room.winner.reason, "control");
})();

(function interruptedControlRestartsTheClock() {
  const room = makeRoom("teams");
  ownAllRelays(room, "a", "blue");
  updateControlVictory(room, 1000);
  updateControlVictory(room, 11000);
  room.points[0].contested = true;
  updateControlVictory(room, 12000);
  assert.strictEqual(room.controlVictory.team, null);
  assert.strictEqual(room.controlVictory.remaining, null);

  room.points[0].contested = false;
  updateControlVictory(room, 13000);
  assert.strictEqual(room.controlVictory.startedAt, 13000, "regaining control must start a fresh hold");
  updateControlVictory(room, 32999);
  assert.strictEqual(room.winner, null);
  updateControlVictory(room, 33000);
  assert.strictEqual(room.winner.team, "blue");
})();

(function soloUsesTheSameTwentySecondRule() {
  const room = makeRoom("solo");
  ownAllRelays(room, "a", "a");
  updateControlVictory(room, 500);
  assert.strictEqual(room.controlVictory.playerId, "a");
  assert.strictEqual(room.winner, null);
  updateControlVictory(room, 20499);
  assert.strictEqual(room.winner, null);
  updateControlVictory(room, 20500);
  assert.strictEqual(room.winner.id, "a");
  assert.strictEqual(room.winner.reason, "control");
})();

(function capturesAndRelayIncomeRetainEconomyRewards() {
  const room = makeRoom("teams", 1);
  const blue = room.players.get("a");
  updateCapturePoints(room, [{ ownerId: "a", x: 0, y: 0, alive: true, stats: {}, design: [] }], 10);
  assert.strictEqual(blue.captures, 1);
  assert.strictEqual(blue.money, ECONOMY.captureBonus);
  assert.strictEqual(blue.earned, ECONOMY.captureBonus);

  room.points[0].progress = 1;
  updateEconomy(room, 1);
  assert.strictEqual(blue.income, ECONOMY.baseIncome + ECONOMY.relayIncome);
  assert.strictEqual(blue.money, ECONOMY.captureBonus + ECONOMY.baseIncome + ECONOMY.relayIncome);
})();

console.log("Control victory and relay economy checks passed");
