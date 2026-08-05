"use strict";
const assert = require("assert");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");
const { initShipHeat, updateShipHeat, rebuildThermalNetworks } = require("../src/server/heat");
const { buildThermalTopology } = require("../src/server/thermalTopology");

function shipFor(design) {
  const hp = design.map((m) => PARTS[m.type]?.hp || 40);
  const ship = {
    alive: true,
    design,
    componentHp: hp.slice(),
    componentMaxHp: hp.slice(),
    stats: { powerUse: 0, powerGeneration: 1 },
    dirtyComponents: new Set()
  };
  initShipHeat(ship);
  ship.componentPower = { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) };
  return ship;
}

function setPower(ship, index, multiplier) {
  ship.componentPower.byComponentIndex[index] = { operationalMultiplier: multiplier };
}

// Catalogue and shared profile
const part = PARTS.closedCycleCooler;
assert(part, "closedCycleCooler exists in PARTS");
assert.strictEqual(part.category, "Heat Components");
assert.strictEqual(part.heatCapacity, 150);
assert.strictEqual(part.heatCooling, 9);
assert.strictEqual(part.heatPassiveCooling, 1);
assert.strictEqual(part.heatConductivity, 1.6);
assert.strictEqual(part.powerUse, 4.5);
assert.strictEqual(part.powerCategory, "coolingSupport");
const profile = HeatRules.profile("closedCycleCooler", part);
assert.deepStrictEqual({
  capacity: profile.capacity,
  cooling: profile.cooling,
  passiveCooling: profile.passiveCooling,
  conductivity: profile.conductivity
}, { capacity: 150, cooling: 9, passiveCooling: 1, conductivity: 1.6 });

// Existing profiles unchanged
assert.strictEqual(HeatRules.profile("heatSink", PARTS.heatSink).capacity, 340);
assert.strictEqual(HeatRules.profile("radiator", PARTS.radiator).cooling, 14);

// Cooling branch: full power, no exposure dependence
const alone = shipFor([{ x: 0, y: 0, type: "closedCycleCooler" }]);
alone.componentHeat = [50];
alone.componentHeatState = [HeatRules.STATE.NORMAL];
alone.hasActiveHeat = true;
setPower(alone, 0, 1);
const before = alone.componentHeat[0];
updateShipHeat(alone, 1);
const fullRemoved = before - alone.componentHeat[0];
assert(fullRemoved > 0, "a powered cooler removes heat");

// Fully enclosed vs exposed gives the same result
const enclosed = shipFor([{ x: 0, y: 0, type: "closedCycleCooler" }]);
enclosed.componentHeat = [50];
enclosed.componentHeatState = [HeatRules.STATE.NORMAL];
enclosed.componentThermals[0].exposedEdges = 0;
enclosed.hasActiveHeat = true;
setPower(enclosed, 0, 1);
updateShipHeat(enclosed, 1);
const enclosedRemoved = 50 - enclosed.componentHeat[0];
assert.strictEqual(enclosedRemoved, fullRemoved, "exposure does not affect closed-cycle cooler output");

// Power scaling: 50% active output
const half = shipFor([{ x: 0, y: 0, type: "closedCycleCooler" }]);
half.componentHeat = [80];
half.componentHeatState = [HeatRules.STATE.NORMAL];
half.hasActiveHeat = true;
setPower(half, 0, 0.5);
updateShipHeat(half, 1);
const halfRemoved = 80 - half.componentHeat[0];
assert(halfRemoved < fullRemoved, "half power removes less than full power");

// No power gives only passive floor
const unpowered = shipFor([{ x: 0, y: 0, type: "closedCycleCooler" }]);
unpowered.componentHeat = [80];
unpowered.componentHeatState = [HeatRules.STATE.NORMAL];
unpowered.hasActiveHeat = true;
setPower(unpowered, 0, 0);
updateShipHeat(unpowered, 1);
const passiveRemoved = 80 - unpowered.componentHeat[0];
assert(passiveRemoved > 0 && passiveRemoved < halfRemoved, "unpowered cooler retains only passive floor");

// State behaviour: OVERHEATED gives no active cooling
const over = shipFor([{ x: 0, y: 0, type: "closedCycleCooler" }]);
over.componentHeat = [80];
over.componentHeatState = [HeatRules.STATE.OVERHEATED];
over.hasActiveHeat = true;
setPower(over, 0, 1);
updateShipHeat(over, 1);
const overRemoved = 80 - over.componentHeat[0];
assert.strictEqual(overRemoved, passiveRemoved, "overheated active cooling is zero; only passive floor remains");

// Destroyed cooler keeps passive floor but no active
const dead = shipFor([{ x: 0, y: 0, type: "closedCycleCooler" }]);
dead.componentHp[0] = 0;
initShipHeat(dead); // re-init after hp change to reflect destroyed state in capacity
dead.componentPower = { byComponentIndex: [{ operationalMultiplier: 1 }] };
dead.componentHeat = [80];
dead.componentHeatState = [HeatRules.STATE.NORMAL];
dead.hasActiveHeat = true;
updateShipHeat(dead, 1);
const deadRemoved = 80 - dead.componentHeat[0];
assert(deadRemoved > 0 && deadRemoved <= passiveRemoved + 1e-9, "destroyed cooler has no active cooling");

// Cooling comparison: exposed radiator > cooler > enclosed radiator
const cooler80 = shipFor([{ x: 0, y: 0, type: "closedCycleCooler" }]);
cooler80.componentHeat = [80];
cooler80.componentHeatState = [HeatRules.STATE.NORMAL];
cooler80.hasActiveHeat = true;
setPower(cooler80, 0, 1);
updateShipHeat(cooler80, 1);
const cooler80Removed = 80 - cooler80.componentHeat[0];

const exposedRad = shipFor([{ x: 0, y: 0, type: "radiator" }]);
exposedRad.componentHeat = [80];
exposedRad.componentHeatState = [HeatRules.STATE.NORMAL];
exposedRad.hasActiveHeat = true;
setPower(exposedRad, 0, 1);
updateShipHeat(exposedRad, 1);
const exposedRadRemoved = 80 - exposedRad.componentHeat[0];

const enclosedRad = shipFor([{ x: 0, y: 0, type: "radiator" }]);
enclosedRad.componentHeat = [80];
enclosedRad.componentHeatState = [HeatRules.STATE.NORMAL];
enclosedRad.componentThermals[0].exposedEdges = 0;
enclosedRad.hasActiveHeat = true;
setPower(enclosedRad, 0, 1);
updateShipHeat(enclosedRad, 1);
const enclosedRadRemoved = 80 - enclosedRad.componentHeat[0];

assert(exposedRadRemoved > cooler80Removed, "exposed radiator cools more than closed-cycle cooler");
assert(cooler80Removed > enclosedRadRemoved, "closed-cycle cooler cools more than enclosed radiator");

// Capacity comparison
assert.strictEqual(HeatRules.profile("heatSink", PARTS.heatSink).capacity, 340);
assert.strictEqual(profile.capacity, 150);
assert(340 > 150, "heat sink has much larger thermal capacity");

// Power comparison
assert(PARTS.radiator.powerUse < part.powerUse, "cooler uses more power than radiator");

// Topology: closed-cycle coolers are tracked separately and as cooling endpoints
const top = buildThermalTopology([{ x: 0, y: 0, type: "frame" }, { x: 1, y: 0, type: "closedCycleCooler" }]);
assert(top.closedCycleCoolerIndices.includes(1), "closedCycleCooler appears in topology list");
assert(!top.thermalRouteIndices.includes(1), "closedCycleCooler is not a thermal route");

const netShip = shipFor([{ x: 0, y: 0, type: "frame" }, { x: 1, y: 0, type: "closedCycleCooler" }]);
netShip.componentHeat = [0, 80];
netShip.componentHeatState = [HeatRules.STATE.NORMAL, HeatRules.STATE.NORMAL];
netShip.hasActiveHeat = true;
setPower(netShip, 1, 1);
updateShipHeat(netShip, 1);
const net = netShip.thermalNetworks[0];
assert(net.closedCycleCoolers.includes(1), "closedCycleCooler is attached to thermal network");
assert.strictEqual(net.totalCoolingCapacity, 9, "network cooling capacity counts cooler base");

// Heat Pipe transfer multiplier: pipe -> cooler
const pipeShip = shipFor([{ x: 0, y: 0, type: "heatPipe" }, { x: 1, y: 0, type: "closedCycleCooler" }]);
pipeShip.componentHeat = [80, 0];
pipeShip.componentHeatState = [HeatRules.STATE.NORMAL, HeatRules.STATE.NORMAL];
pipeShip.hasActiveHeat = true;
setPower(pipeShip, 1, 1);
updateShipHeat(pipeShip, 1);
assert(pipeShip.componentHeatCooled[1] > 0, "cooler removed heat transferred from pipe");

// Telemetry: cooler counts as componentHeatCooled but not radiated
const telemetryShip = shipFor([{ x: 0, y: 0, type: "closedCycleCooler" }]);
telemetryShip.componentHeat = [80];
telemetryShip.componentHeatState = [HeatRules.STATE.NORMAL];
telemetryShip.hasActiveHeat = true;
setPower(telemetryShip, 0, 1);
updateShipHeat(telemetryShip, 1);
assert(telemetryShip.componentHeatCooled[0] > 0, "cooler increments componentHeatCooled");
assert(telemetryShip.componentHeatRemoved[0] >= telemetryShip.componentHeatCooled[0], "cooler increments componentHeatRemoved");
assert.strictEqual(telemetryShip.componentHeatRadiated[0], 0, "cooler does not increment componentHeatRadiated");

// Local transfer: disconnected hot component gets no benefit
const isolated = shipFor([{ x: 0, y: 0, type: "closedCycleCooler" }, { x: 5, y: 0, type: "blaster" }]);
isolated.componentHeat = [0, 80];
isolated.componentHeatState = [HeatRules.STATE.NORMAL, HeatRules.STATE.NORMAL];
isolated.hasActiveHeat = true;
setPower(isolated, 0, 1);
updateShipHeat(isolated, 1);
assert.strictEqual(isolated.componentHeatCooled[0], 0, "cooler with no stored heat does not cool");
assert.strictEqual(isolated.componentHeatTransferredOut[1], 0, "disconnected hot component transfers no heat");
assert.strictEqual(isolated.componentHeatCooled[1] > 0 && isolated.componentHeatCooled[1] < 5, true, "disconnected component cools only by its own passive rate");

console.log("Closed-Cycle Cooler verification passed");
