"use strict";

function roomCombatRandom(room) {
  return typeof room?.combatRandom === "function" ? room.combatRandom : Math.random;
}

module.exports = { roomCombatRandom };
