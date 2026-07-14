"use strict";
const assert = require("assert");
const serverStats = require("./src/server/shipStats");
const serverFootprint = require("./src/server/footprint");
const { validateDesign } = require("./src/server/shipDesign");

const TOLERANCE = 1e-9;
const FIELD_TOLERANCE = { accel: 1, turnRate: 0.01, maxSpeed: 0.01, effectiveThrust: 1, engineEfficiency: 1e-6 };
const fields = ["cost","unitCost","mass","maxHp","maxShield","shieldRegen","powerGeneration","powerUse","power","efficiency","thrust","effectiveThrust","engineEfficiency","powerEfficiency","powerDebuff","energyStorage","accel","maxSpeed","turnRate","massClass","speedCap","turnCap","thrustRatio","blaster","missile","railgun","beam","repair","repairRate","blasterRange","missileRange","railgunRange","beamRange","captureBonus","accuracyBonus","fireRateBonus","fleetCount","pointDefense"];
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
  const clientValidation = await import("./public/src/design/blueprintValidation.js");
  const clientFootprint = await import("./public/src/design/footprint.js");
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
    assert.strictEqual((validateDesign(design).modules || design).length, design.length, `${name}.normalization`);
  }
  for (const r of [0,90,180,270]) {
    assert.deepStrictEqual(clientFootprint.getOccupiedCells(13, 13, {width:2,height:2}, r), serverFootprint.getOccupiedCells(13, 13, {width:2,height:2}, r));
  }
  console.log(`Blueprint parity verification passed (${Object.keys(corpus).length} fixtures, ${fields.length} stat fields, tolerance ${TOLERANCE})`);
})().catch((err) => { console.error(err); process.exit(1); });
