"use strict";

const assert = require("assert");
global.WiringRules = require("./public/src/shared/wiringRules");
global.PowerFlowRules = require("./public/src/shared/powerFlowRules");
global.ShieldRules = require("./public/src/shared/shieldRules");
global.HeatRules = require("./public/src/shared/heatRules");

const { createImmutableShipTemplate } = require("./src/server/shipTemplates");
const { spawnShip } = require("./src/server/ships");
const { computeStats } = require("./src/server/shipStats");
const { PARTS } = require("./src/server/components");

const design = [
  { type: "core", x: 0, y: 0, rotation: 0 },
  { type: "reactor", x: 1, y: 0, rotation: 0 },
  { type: "shield", x: 2, y: 0, rotation: 0 },
  { type: "engine", x: -1, y: 0, rotation: 0 }
];
let wiring = global.WiringRules.emptyWiring();
wiring = global.WiringRules.addConnection(wiring, "power", 1, 2, [{ x: 1, y: 0 }, { x: 2, y: 0 }], design, PARTS);
const template = createImmutableShipTemplate(design, wiring, computeStats(design, wiring));
const player = {
  id: "p1", team: "blue", shipCap: 5, ships: [], design, wiring,
  stats: template.stats, rallyPoint: null
};
const room = {
  nextEntityId: 1, mapSeed: 1, world: { width: 2000, height: 1600 },
  map: { asteroids: [], safeZones: [] }, players: new Map([["p1", player]]),
  ships: new Map(), effects: []
};
const ships = Array.from({ length: 5 }, (_, index) => spawnShip(room, player, 1000, index, { template }));

function mutableCollections(value, path = "root", seen = new Set(), out = []) {
  if (!value || typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value) || value instanceof Map || value instanceof Set || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) out.push([path, value]);
  if (value instanceof Map) for (const [key, item] of value) mutableCollections(item, `${path}.map(${String(key)})`, seen, out);
  else if (value instanceof Set) for (const item of value) mutableCollections(item, `${path}.set`, seen, out);
  else for (const key of Object.keys(value)) mutableCollections(value[key], `${path}.${key}`, seen, out);
  return out;
}

const templateCollections = new Set(mutableCollections(template.prebuiltShipState).map(([, value]) => value));
for (let a = 0; a < ships.length; a += 1) {
  const collections = mutableCollections(ships[a]);
  for (const [path, value] of collections) {
    if (path.includes(".design") || path.includes(".wiring") || path.includes(".stats")) continue;
    assert(!templateCollections.has(value), `${path} is shared with immutable template`);
    for (let b = a + 1; b < ships.length; b += 1) {
      const otherValues = new Set(mutableCollections(ships[b]).map(([, item]) => item));
      assert(!otherValues.has(value), `${path} is shared by ships ${a} and ${b}`);
    }
  }
}

ships[0].componentHp[0] = 0;
ships[0].dirtyComponents.add(0);
ships[0]._powerDemandActivity = new Float64Array([1, 2, 3, 4]);
assert.notStrictEqual(ships[1].componentHp[0], 0, "HP mutation leaked to another ship");
assert(!ships[1].dirtyComponents.has(0), "Set mutation leaked to another ship");
assert.notStrictEqual(template.prebuiltShipState.componentHp[0], 0, "HP mutation leaked to template");
console.log("Template mutable-state isolation verification passed for five identical ships.");
