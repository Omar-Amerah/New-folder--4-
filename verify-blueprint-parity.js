"use strict";
const assert = require("assert");
const serverStats = require("./src/server/shipStats");
const serverFootprint = require("./src/server/footprint");
const { validateDesign, isConnected, normalizeShipDesignSnapshot, migrateLegacy11DesignSnapshot, createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { DEFAULT_DESIGN, DEFAULT_WIRING, ECONOMY } = require("./src/server/config");
const EngineExhaust = require("./public/src/shared/engineExhaust.js");
const HeatRules = require("./public/src/shared/heatRules.js");
const WiringRules = require("./public/src/shared/wiringRules.js");
const { PARTS } = require("./src/server/components");

const TOLERANCE = 1e-9;
const FIELD_TOLERANCE = { accel: 1, turnRate: 0.01, turnRateLeft: 0.01, turnRateRight: 0.01, maxSpeed: 0.01, effectiveThrust: 1, engineEfficiency: 1e-6 };
const fields = ["cost","unitCost","mass","maxHp","maxShield","shieldRegen","powerGeneration","powerUse","power","efficiency","thrust","effectiveThrust","engineEfficiency","powerEfficiency","powerDebuff","energyStorage","accel","maxSpeed","turnRate","turnRateLeft","turnRateRight","massClass","speedCap","turnCap","thrustRatio","blaster","missile","railgun","beam","repair","repairRate","blasterRange","missileRange","railgunRange","beamRange","captureBonus","accuracyBonus","fireRateBonus","fleetCount","pointDefense"];
const corpus = {
  defaultDesign: [{x:3,y:3,type:"core"},{x:3,y:4,type:"engine"},{x:2,y:3,type:"blaster"},{x:4,y:3,type:"reactor"}],
  minimumValid: [{x:3,y:3,type:"core"}],
  largeValid: [{x:3,y:3,type:"core"},{x:2,y:3,type:"armor"},{x:4,y:3,type:"armor"},{x:3,y:2,type:"shield"},{x:3,y:4,type:"reactor"},{x:2,y:4,type:"engine"},{x:4,y:4,type:"engine"},{x:3,y:1,type:"railgun"},{x:2,y:2,type:"blaster"},{x:4,y:2,type:"missile"},{x:3,y:5,type:"battery"},{x:5,y:3,type:"beam"},{x:1,y:3,type:"repair"}],
  everyWeaponFamily: [{x:3,y:3,type:"core"},{x:3,y:4,type:"engine"},{x:2,y:3,type:"blaster"},{x:4,y:3,type:"missile"},{x:3,y:2,type:"railgun"},{x:5,y:3,type:"beam"},{x:4,y:4,type:"reactor"}],
  rotationsAndEdges: [{x:0,y:0,type:"core"},{x:1,y:0,type:"wingFrame",rotation:0},{x:3,y:0,type:"wingArmor",rotation:90},{x:5,y:1,type:"wingCompositeArmor",rotation:180},{x:7,y:2,type:"engine",rotation:270},{x:0,y:1,type:"reactor"}],
  blockedEngines: [{x:3,y:3,type:"core"},{x:3,y:4,type:"engine"},{x:3,y:5,type:"armor"},{x:4,y:3,type:"reactor"}],
  clearEngines: [{x:3,y:3,type:"core"},{x:3,y:4,type:"engine"},{x:4,y:3,type:"reactor"}],
  underpowered: [{x:3,y:3,type:"core"},{x:2,y:3,type:"shield"},{x:4,y:3,type:"shield"},{x:3,y:2,type:"beam"},{x:3,y:4,type:"engine"}],
  supportCombat: [{x:3,y:3,type:"core"},{x:2,y:3,type:"repair"},{x:4,y:3,type:"shield"},{x:3,y:2,type:"command"},{x:3,y:4,type:"engine"},{x:4,y:4,type:"reactor"},{x:2,y:2,type:"blaster"}]
};
(async () => {
  global.document = { createElement: () => ({ getContext: () => ({ clearRect(){}, fillRect(){}, beginPath(){}, arc(){}, fill(){}, stroke(){}, moveTo(){}, lineTo(){}, closePath(){}, save(){}, restore(){}, translate(){}, rotate(){}, fillText(){}, measureText(){ return { width: 0 }; } }), toDataURL: () => "data:image/png;base64," }), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: { classList: { add(){}, remove(){} } } };
  global.window = { devicePixelRatio: 1 };
  await import("./public/src/shared/engineExhaust.js");
  const parts = await import("./public/src/design/parts.js");
  parts.applyServerParts(require("./src/server/components").PARTS);
  const clientStats = await import("./public/src/design/componentStats.js");
  const storage = await import("./public/src/design/blueprintStorage.js");
  const client = await import("./public/src/design/rotation.js");
  globalThis.EngineExhaustRules = EngineExhaust;
  globalThis.HeatRules = HeatRules;
  // Section 7D-3: Blueprint thermal prediction uses the shared Power/Cable
  // authorities, which register themselves as browser globals when required.
  globalThis.DataSupportRules = require("./public/src/shared/dataSupportRules.js");
  globalThis.PowerPolicyRules = require("./public/src/shared/powerPolicyRules.js");
  globalThis.PowerAllocationRules = require("./public/src/shared/powerAllocationRules.js");
  globalThis.PowerDemandRules = require("./public/src/shared/powerDemandRules.js");
  globalThis.PowerFlowRules = require("./public/src/shared/powerFlowRules.js");
  globalThis.WiringInfrastructureRules = require("./public/src/shared/wiringInfrastructureRules.js");
  globalThis.PowerCableThermalRules = require("./public/src/shared/powerCableThermalRules.js");
  const thermal = await import("./public/src/design/thermalAnalysis.js");
  const clientValidation = await import("./public/src/design/blueprintValidation.js");
  const clientFootprint = await import("./public/src/design/footprint.js");

  const normalize = (design) => design.map((part) => ({ x: part.x, y: part.y, type: part.type, rotation: part.rotation || 0 }));
  assert.deepStrictEqual(normalize(storage.defaultDesign()), normalize(DEFAULT_DESIGN), "server and client stock defaults match after normalization");
  const clientWiringA = storage.defaultWiring();
  const clientWiringB = storage.defaultWiring();
  const serverCanonical = WiringRules.normalizeWiring(DEFAULT_WIRING, DEFAULT_DESIGN, PARTS).wiring;
  const clientCanonical = WiringRules.normalizeWiring(clientWiringA, storage.defaultDesign(), PARTS).wiring;
  assert.deepStrictEqual(clientCanonical, serverCanonical, "client and server default wiring match canonically");
  assert.ok(clientCanonical.power.sections.length > 0, "default Power wiring is non-empty");
  assert.equal(clientCanonical.data.sections.length, 0, "default Data wiring is empty");
  assert.notStrictEqual(clientWiringA, clientWiringB, "defaultWiring returns independent top-level objects");
  assert.notStrictEqual(clientWiringA.power.sections, clientWiringB.power.sections, "defaultWiring returns independent section arrays");

  // Regression coverage: modern designs are never shifted merely because the core is at 3,3.
  const modernCoreAtThree = [{ x: 3, y: 3, type: "core" }, { x: 3, y: 4, type: "engine" }];
  assert.deepStrictEqual(normalizeShipDesignSnapshot(modernCoreAtThree).map((part) => [part.x, part.y]), [[3, 3], [3, 4]], "modern core at 3,3 remains unshifted");
  assert.deepStrictEqual(modernCoreAtThree, [{ x: 3, y: 3, type: "core" }, { x: 3, y: 4, type: "engine" }], "modern snapshot normalization does not mutate modules");
  const modernNearBoundary = [{ x: 3, y: 3, type: "core" }, { x: 3, y: 4, type: "engine" }, { x: 14, y: 14, type: "frame" }];
  assert.deepStrictEqual(normalizeShipDesignSnapshot(modernNearBoundary).map((part) => [part.x, part.y]), [[3, 3], [3, 4], [14, 14]], "modern boundary design is not inferred as legacy or shifted out of bounds");
  assert.deepStrictEqual(normalizeShipDesignSnapshot(DEFAULT_DESIGN), normalize(DEFAULT_DESIGN), "normal default design remains unchanged");
  const legacy11 = [{ x: 3, y: 3, type: "core" }, { x: 3, y: 4, type: "engine" }, { x: 2, y: 3, type: "maneuverThruster", rotation: "invalid" }];
  const legacyBefore = JSON.stringify(legacy11);
  const migratedLegacy = normalizeShipDesignSnapshot(legacy11, { sourceGridSize: 11 });
  assert.deepStrictEqual(migratedLegacy.map((part) => [part.x, part.y]), [[7, 7], [7, 8], [6, 7]], "explicit legacy 11x11 migration shifts exactly +4,+4");
  assert.equal(migratedLegacy[2].rotation, 90, "explicit legacy migration normalizes maneuver rotation using the final shifted x coordinate");
  assert.equal(JSON.stringify(legacy11), legacyBefore, "legacy migration does not mutate input modules");
  assert.throws(() => migrateLegacy11DesignSnapshot([{ x: 3, y: 3, type: "core" }, { x: 10, y: 10, type: "reactor", rotation: 0 }]), /source grid/, "explicit legacy migration rejects footprints outside 0-10");
  const centerlineTwoSided = [{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }, { x: 6, y: 7, type: "blaster", rotation: 90 }, { x: 7, y: 5, type: "maneuverThruster", rotation: 90 }];
  const normalizedCenterline = normalizeShipDesignSnapshot(centerlineTwoSided);
  assert.equal(client.normalizeRotation("invalid", [90, 270], 7), 270, "centreline two-sided fallback uses shared right-facing rule");
  assert.equal(normalizedCenterline[3].rotation, 270, "centreline maneuver thruster uses shared right-facing rule");
  assert.equal(client.normalizeRotation(centerlineTwoSided[2].rotation, PARTS.blaster.allowedRotations, 6), normalizedCenterline[2].rotation, "client/server rotation results match after snapshot creation");
  const generatedBoundaryWiring = createGeneratedPowerWiring(modernNearBoundary);
  assert.ok(generatedBoundaryWiring.power.sections.every((section) => section.x1 >= 0 && section.x1 <= 14 && section.x2 >= 0 && section.x2 <= 14 && section.y1 >= 0 && section.y1 <= 14 && section.y2 >= 0 && section.y2 <= 14), "generated Wiring for modern designs uses original modern coordinates");

  const before = JSON.stringify(clientWiringB); clientWiringA.power.sections.pop();
  assert.equal(JSON.stringify(clientWiringB), before, "mutating one default wiring does not affect another");
  const powerAnalysis = WiringRules.analyzeWiring(DEFAULT_DESIGN, DEFAULT_WIRING, PARTS).power;
  assert.deepStrictEqual(powerAnalysis.disconnectedConsumerIndices, [], "default Power consumers are connected");
  assert.deepStrictEqual(powerAnalysis.underpoweredConsumerIndices, [], "default Power consumers are not underpowered");
  const validation = validateDesign(DEFAULT_DESIGN);
  assert.strictEqual(validation.ok, true, validation.reason || "default design should validate");
  assert.strictEqual(validation.modules.length, DEFAULT_DESIGN.length, "default design should not drop components");
  assert.strictEqual(isConnected(validation.modules), true, "default design components connect to the core");
  const defaultStats = serverStats.computeStats(DEFAULT_DESIGN);
  assert.strictEqual(defaultStats.blockedEngines, 0, "default design engine exhaust is clear");
  assert(defaultStats.powerGeneration >= defaultStats.powerUse, "default design has enough power");
  assert(defaultStats.power > 0, "default design has positive power reserve");
  assert(defaultStats.maxSpeed > 0, "default design can move");
  assert(defaultStats.turnRate > 1, "default design can turn effectively");
  assert(defaultStats.unitCost >= 500 && defaultStats.unitCost <= 560, `default unit cost expected near $500 and below starting money, got ${defaultStats.unitCost}`);
  assert(defaultStats.unitCost <= ECONOMY.startingMoney, "default design is affordable at normal starting money");
  assert.strictEqual(defaultStats.missile, 1, "default design has one missile launcher");
  assert.strictEqual(defaultStats.beam, 0, "default design has no beam emitter");
  assert.strictEqual(defaultStats.cost, 259, "default component cost total matches the defensive stock design");
  const exhaust = EngineExhaust.analyze(DEFAULT_DESIGN, PARTS);
  assert.strictEqual(exhaust.blockedEngineIndices.size, 0, "default engine exhaust has no blockers");
  const occupied = new Map();
  for (let i = 0; i < validation.modules.length; i += 1) {
    const part = validation.modules[i];
    for (const cell of serverFootprint.getOccupiedCells(part.x, part.y, PARTS[part.type].footprint || { width: 1, height: 1 }, part.rotation || 0)) {
      assert(cell.x >= 0 && cell.x <= 14 && cell.y >= 0 && cell.y <= 14, `default occupied cell out of grid: ${cell.x},${cell.y}`);
      const key = `${cell.x},${cell.y}`;
      assert(!occupied.has(key), `default components overlap at ${key}`);
      occupied.set(key, i);
    }
  }
  const heat = thermal.analyzeDesignHeat(DEFAULT_DESIGN, "full");
  assert.strictEqual(heat.analysis.overheatedCount, 0, "default full-load thermal analysis predicts no overheated component");
  assert.strictEqual(heat.analysis.meltdownCount, 0, "default full-load thermal analysis predicts no reactor meltdown");
  assert(heat.analysis.peakPredictedHeat < 1, `default max predicted heat should stay below 100%, got ${heat.analysis.peakPredictedHeat}`);
  const radiatorIndices = DEFAULT_DESIGN.map((part, index) => part.type === "radiator" ? index : -1).filter((index) => index >= 0);
  assert.strictEqual(radiatorIndices.length, 1, "default has one exposed radiator");
  for (const index of radiatorIndices) assert(heat.predictions.get(DEFAULT_DESIGN[index]).exposedEdges > 0, `radiator ${index} should have exposed edges`);

  for (const [name, design] of Object.entries(corpus)) {
    const server = serverStats.computeStats(design);
    const client = clientStats.computeStats(design);
    for (const field of fields) {
      if (!(field in server) && !(field in client)) continue;
      assert.ok(field in server, `${name}: server missing ${field}`);
      assert.ok(field in client, `${name}: client missing ${field}`);
      if (typeof server[field] === "number") assert(Math.abs(server[field] - client[field]) <= (FIELD_TOLERANCE[field] ?? TOLERANCE), `${name}.${field}: ${server[field]} !== ${client[field]}`);
      else assert.deepStrictEqual(client[field], server[field], `${name}.${field}`);
    }
    const normalized = validateDesign(design);
    if (normalized.ok) assert.strictEqual(normalized.modules.length, design.length, `${name}.normalization`);
  }
  for (const r of [0,90,180,270]) {
    assert.deepStrictEqual(clientFootprint.getOccupiedCells(13, 13, {width:2,height:2}, r), serverFootprint.getOccupiedCells(13, 13, {width:2,height:2}, r));
  }
  console.log(`Blueprint parity verification passed (${Object.keys(corpus).length} fixtures, ${fields.length} stat fields, tolerance ${TOLERANCE})`);
})().catch((err) => { console.error(err); process.exit(1); });
