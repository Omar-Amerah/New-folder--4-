"use strict";

const assert = require("assert");
const fs = require("fs");
const ShieldRules = require("../public/src/shared/shieldRules");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState } = require("../src/server/componentHealth");
const { initShipHeat } = require("../src/server/heat");
const { initializeComponentPower, effectiveShieldStats } = require("../src/server/componentPower");
const {
  SHIELD_RESTART_DELAY_MS,
  effectiveShieldRestartDelayMs,
  updateRuntimeShield
} = require("../src/server/runtimeShield");
const {
  getCommandAuraMultiplier,
  updateCommandAuras
} = require("../src/server/commandAuras");

const at = (type, x, y) => ({ type, x, y, rotation: 0 });
const SHIELD_RESTART_DELAY_SECONDS = ShieldRules.SHIELD_RESTART_DELAY_MS / 1000;
const RELAY_AURA = PARTS.shieldCommandRelay.aura;
const SHIELD_COMMAND_RELAY_EFFECTIVE_DELAY_TEXT = `${(ShieldRules.getShieldRestartDelayMs(RELAY_AURA.shieldRestartDelayMultiplier) / 1000).toFixed(1)} seconds`;
const close = (actual, expected, message, tolerance = 1e-9) => {
  assert(Math.abs(Number(actual) - Number(expected)) <= tolerance, `${message}: ${actual} !== ${expected}`);
};

function makeRuntimeShip(id = "shield-runtime") {
  const design = [at("reactor", 7, 7), at("shield", 7, 8)];
  const ship = {
    id,
    ownerId: "p1",
    x: 0,
    y: 0,
    alive: true,
    design,
    dataLinks: [],
    stats: computeStats(design, { dataLinks: [] }),
    shield: 0,
    commandAurasReceived: {},
    commandAuraMultipliers: {}
  };
  initComponentState(ship);
  initShipHeat(ship);
  initializeComponentPower(ship);
  return ship;
}

function makeAuraShip(id, x, design, operationalMultiplier = 1) {
  return {
    id,
    ownerId: "p1",
    team: "blue",
    x,
    y: 0,
    alive: true,
    design,
    componentHp: design.map(() => 1),
    componentPower: { byComponentIndex: design.map(() => ({ operationalMultiplier })) },
    componentHeatState: design.map(() => HeatRules.STATE.NORMAL),
    commandAurasReceived: {},
    commandAuraMultipliers: {}
  };
}

function auraRoom(ships) {
  return {
    phase: "active",
    ships: new Map(ships.map((ship) => [ship.id, ship])),
    players: new Map([
      ["p1", { id: "p1", team: "blue" }],
      ["p2", { id: "p2", team: "red" }]
    ])
  };
}

function runtimeRoom() {
  return { _roomTelemetry: null };
}

function beginDepletion(ship, now, multiplier = 1, room = runtimeRoom()) {
  ship.commandAuraMultipliers = multiplier === 1 ? {} : { shieldRestartDelayMultiplier: multiplier };
  ship.shield = 0;
  ship._shieldDepletedAt = null;
  updateRuntimeShield(ship, 0, now, room);
}

async function run() {
  assert.strictEqual(ShieldRules.SHIELD_RESTART_DELAY_MS, 3000, "shared base Shield restart delay remains 3000 ms");
  assert.strictEqual(SHIELD_RESTART_DELAY_MS, ShieldRules.SHIELD_RESTART_DELAY_MS, "runtime uses the shared base delay");

  const room = runtimeRoom();
  const healthy = makeRuntimeShip("healthy-shield");
  const capacity = effectiveShieldStats(healthy).capacity;
  healthy.shield = capacity * 0.5;
  const before = healthy.shield;
  updateRuntimeShield(healthy, 0.1, 0, room);
  assert(healthy.shield > before, "a Shield above 0 regenerates without a depletion delay");

  const depleted = makeRuntimeShip("depleted-shield");
  beginDepletion(depleted, 1000);
  assert.strictEqual(depleted.shield, 0, "a newly depleted Shield remains at 0 during the delay");
  assert.strictEqual(depleted._shieldDepletedAt, 1000, "depletion timestamp is recorded once");
  updateRuntimeShield(depleted, 0.1, 2000, room);
  assert.strictEqual(depleted._shieldDepletedAt, 1000, "remaining at 0 does not restart the timer");
  assert.strictEqual(depleted.shield, 0, "Shield does not regenerate before the base delay expires");
  updateRuntimeShield(depleted, 0.1, 3999, room);
  assert.strictEqual(depleted.shield, 0, "Shield remains disabled just before the base restart time");
  updateRuntimeShield(depleted, 0.1, 4000, room);
  assert(depleted.shield > 0, "Shield regeneration resumes after the base delay");

  const redepleted = makeRuntimeShip("redepleted-shield");
  beginDepletion(redepleted, 5000);
  updateRuntimeShield(redepleted, 0.1, 7999, room);
  assert.strictEqual(redepleted.shield, 0, "a later depletion has its own restart delay");
  updateRuntimeShield(redepleted, 0.1, 8000, room);
  assert(redepleted.shield > 0, "a later depletion resumes after a new delay");
  assert.strictEqual(redepleted._shieldDepletedAt, null, "regrowth clears the completed depletion episode");
  redepleted.shield = 0;
  updateRuntimeShield(redepleted, 0.1, 8001, room);
  assert.strictEqual(redepleted._shieldDepletedAt, 8001, "a new depletion after regrowth starts a new timer");
  updateRuntimeShield(redepleted, 0.1, 11000, room);
  assert.strictEqual(redepleted.shield, 0, "the new depletion remains locked for a fresh base delay");
  updateRuntimeShield(redepleted, 0.1, 11001, room);
  assert(redepleted.shield > 0, "the fresh depletion delay expires independently");

  const fullyBuffed = makeRuntimeShip("fully-buffed-shield");
  beginDepletion(fullyBuffed, 10000, 0.9, room);
  close(fullyBuffed.shieldRestartDelayMs, ShieldRules.getShieldRestartDelayMs(0.9), "fully effective aura delay");
  close(effectiveShieldRestartDelayMs(fullyBuffed), 2700, "fully effective aura is applied once");
  updateRuntimeShield(fullyBuffed, 0.1, 12699, room);
  assert.strictEqual(fullyBuffed.shield, 0, "0.90 aura does not restart early");
  updateRuntimeShield(fullyBuffed, 0.1, 12700, room);
  assert(fullyBuffed.shield > 0, "0.90 aura reduces the base delay to 2.7 seconds");

  const partiallyBuffed = makeRuntimeShip("partially-buffed-shield");
  beginDepletion(partiallyBuffed, 20000, 0.95, room);
  close(partiallyBuffed.shieldRestartDelayMs, 2850, "partial aura uses the supplied effective multiplier");
  updateRuntimeShield(partiallyBuffed, 0.1, 22849, room);
  assert.strictEqual(partiallyBuffed.shield, 0, "partial aura does not use the fully effective delay");
  updateRuntimeShield(partiallyBuffed, 0.1, 22850, room);
  assert(partiallyBuffed.shield > 0, "partial aura resumes at its actual effective delay");

  const relay = makeAuraShip("relay-1", 0, [at("shieldCommandRelay", 0, 0)]);
  const recipient = makeAuraShip("recipient-1", 50, [at("frame", 1, 0)]);
  const relayRoom = auraRoom([relay, recipient]);
  updateCommandAuras(relayRoom, [relay, recipient], 0);
  close(getCommandAuraMultiplier(recipient, "shieldRestartDelayMultiplier"), 0.9, "Relay publishes the delay multiplier");

  const weakRelay = makeAuraShip("weak-relay", 0, [at("shieldCommandRelay", 0, 0)], 0.5);
  const weakRecipient = makeAuraShip("weak-recipient", 50, [at("frame", 1, 0)]);
  const weakRoom = auraRoom([weakRelay, weakRecipient]);
  updateCommandAuras(weakRoom, [weakRelay, weakRecipient], 0);
  close(getCommandAuraMultiplier(weakRecipient, "shieldRestartDelayMultiplier"), 0.95, "Power-weakened Relay publishes its actual effective multiplier");

  const secondRelay = makeAuraShip("relay-2", 100, [at("shieldCommandRelay", 0, 0)]);
  const stackedRecipient = makeAuraShip("recipient-2", 50, [at("frame", 1, 0)]);
  const stackedRoom = auraRoom([relay, secondRelay, stackedRecipient]);
  updateCommandAuras(stackedRoom, [relay, secondRelay, stackedRecipient], 0);
  close(getCommandAuraMultiplier(stackedRecipient, "shieldRestartDelayMultiplier"), 0.9, "same-type Relay sources do not stack");

  const outsideRecipient = makeAuraShip("outside-recipient", 900, [at("frame", 1, 0)]);
  const outsideRoom = auraRoom([relay, outsideRecipient]);
  updateCommandAuras(outsideRoom, [relay, outsideRecipient], 0);
  close(getCommandAuraMultiplier(outsideRecipient, "shieldRestartDelayMultiplier"), 1, "outside ships keep the base multiplier");

  const relaySourceText = fs.readFileSync("./public/src/ui/shipDamagePanelUi.js", "utf8");
  assert(relaySourceText.includes("shieldRestartDelayMs"), "Shield inspector reads the effective restart delay");
  assert(!/SHIELD_RESTART_DELAY_MS\s*=\s*3000/.test(relaySourceText), "Shield inspector does not duplicate the base delay");

  global.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, getContext: () => null })
  };
  global.window = { devicePixelRatio: 1 };
  const ledger = await import("../public/src/ledger/ledgerContent.js");
  const defence = ledger.getArticleById("defence");
  const defenceText = JSON.stringify(defence);
  assert(defenceText.includes("Shield Depletion:") && defenceText.includes("Shield Restart:") && defenceText.includes("Shield Command Relay:"), "Ledger teaches all Shield restart rules");
  assert(defenceText.includes(`${SHIELD_RESTART_DELAY_SECONDS.toFixed(1)} seconds`), "Ledger derives the base delay from ShieldRules");
  const relayArticleText = JSON.stringify(ledger.getArticleById("component:shieldCommandRelay"));
  assert(relayArticleText.includes(`Shield Regeneration`) && relayArticleText.includes(`Shield Restart Delay`), "Relay Ledger article names both aura effects");
  assert(relayArticleText.includes(SHIELD_COMMAND_RELAY_EFFECTIVE_DELAY_TEXT), "Relay Ledger article derives the fully effective delay");
  assert(PARTS.shieldCommandRelay.description.includes("Shield regeneration") && PARTS.shieldCommandRelay.description.includes("reduces the restart delay"), "Relay description names both Shield effects");
  const parts = await import("../public/src/design/parts.js");
  const inspector = await import("../public/src/design/componentInspectorModel.js");
  const relayModel = inspector.buildComponentInspectorModel("shieldCommandRelay", parts.PART_STATS.shieldCommandRelay, {
    name: "Shield Command Relay",
    category: "Command",
    description: parts.PART_STATS.shieldCommandRelay.description
  });
  const relayRows = relayModel.commandAura?.rows || [];
  assert(relayRows.some((row) => row.label === "Shield Regeneration" && row.value === "+10%"), "Relay inspector shows Shield regeneration aura");
  assert(relayRows.some((row) => row.label === "Shield Restart Delay" && row.value === "10% shorter"), "Relay inspector shows restart-delay aura");

  console.log("Shield restart verification passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
