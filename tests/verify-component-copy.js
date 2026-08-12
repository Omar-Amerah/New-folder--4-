"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(__dirname);
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const { PARTS } = require("../src/server/components");

const CANONICAL_DESCRIPTIONS = Object.freeze({
  core: "Required primary command core with strong durability and light built-in Power generation.",
  backupCore: "Redundant command centre that takes control if the main Core is destroyed. While active, weapon accuracy, turn rate and drone command range operate at 85%. Also projects a command aura that improves nearby allied weapon accuracy and tracking.",
  fireControlCommandCentre: "Coordinates nearby allied weapon fire, improving accuracy, tracking and turret aim speed.",
  fleetDefenceCoordinator: "Improves nearby allied Point Defence and Flak tracking.",
  armor: "Heavy armour with high hull durability and strong flat damage reduction, at the cost of mass and turn rate.",
  compositeArmor: "Lighter armour with good hull durability and moderate flat damage reduction, trading protection for lower mass and turn penalty.",
  halfFrameDiagonal: "Triangular structural piece for tapered ship edges. Occupies one cell with reduced durability and mass compared with a full Frame.",
  refractoryArmor: "Heat-resistant armour with high thermal capacity and moderate physical protection. It absorbs large amounts of Heat and completely blocks Thermal Induction Lance coupling through the plate.",
  battery: "Efficient emergency Power reserve. Charges from spare generation and automatically supports the ship during Power shortages.",
  engine: "Main propulsion module that provides thrust for speed and acceleration. Always faces forward and exhausts rearward. Provides modest turning assistance; add Maneuver Thrusters for stronger control.",
  maneuverThruster: "Directional control thruster that provides strong turning torque. Turning effectiveness increases when placed farther from the ship's centre of mass.",
  aegisProjector: "High-Power shield projector built around rapid regeneration. Provides a strong defensive field and restores it far faster than a standard Shield, but consumes much more Power and space.",
  autocannon: "Rapid-fire close-range kinetic weapon. High fire rate and spread make it effective against exposed hull and light targets, but it performs poorly against shields.",
  beamEmitter: "Sustained beam that excels against shields and heats the component it strikes. Continuous contact ramps its damage, and excess damage can carry through one destroyed component.",
  thermalInductionLance: "Targeting Priority: Prioritises functioning Power generators when available, then other active systems. The Lance is designed to overload critical powered systems rather than choose targets like an ordinary weapon. Zero-damage induction beam that injects Heat into a target component and nearby components. Sustained contact increases Heat transfer; shields reduce coupling, while Refractory Armour can block the beam.",
  missile: "Guided missile launcher with long reach, moderate tracking and a slow reload. Missiles can be intercepted before impact.",
  railgun: "Long-range precision kinetic weapon with heavy hull damage, excellent accuracy and a narrow firing arc.",
  plasmaCannon: "Fires a slow plasma projectile that deals direct damage and injects substantial Heat into the component it strikes. Powerful against thermal-sensitive systems, but easier to dodge at long range.",
  fragmentationCannon: "Impact shell that combines a modest direct hit with an area fragmentation burst. Effective against exposed components and clustered light ships, but weak against shields.",
  scatterCannon: "Short-range spread weapon that fires six low-damage pellets per shot. Strong against lightly protected hull, but flat armour reduction applies separately to every pellet.",
  spinalAccelerator: "Capital-scale spinal kinetic weapon limited to one per ship. Charges visibly before firing a devastating penetrating shot, while gradually restricting weapon traverse and hull turning.",
  swarmMissile: "Rapid guided-missile pod that fires frequent lightweight missiles with strong tracking. Pressures point defence through sustained volume rather than heavy individual hits.",
  torpedo: "Heavy long-range missile with poor tracking and very high hull damage. Slow and vulnerable to interception, but dangerous against large or sluggish ships.",
  heatPipe: "Rapidly transfers Heat between components on the same coolant network. It provides no cooling and stores almost no Heat. Pipes connect automatically to orthogonal neighbours and need no rotation.",
  heatSink: "Stores large amounts of Heat for buffering thermal spikes. It provides very little cooling, and its capacity belongs only to the sink itself. Connect it to hot systems with Heat Pipes.",
  heatVent: "Cheap passive Heat rejection that requires an exposed edge. Much weaker than a Radiator, but compact, lightweight and requires no Power.",
  radiator: "Strong passive external Heat rejection. Requires an exposed edge for full output and falls to 25% cooling when fully enclosed.",
  closedCycleCooler: "Powered internal cooling that removes Heat without requiring hull exposure. Reliable anywhere in the ship, but Power-hungry and weaker than a fully exposed Radiator.",
  burstCooler: "Cryogenic accumulator for sudden Heat spikes. Automatically dumps stored Heat when it reaches its trigger threshold, then provides only weak cooling while it recharges.",
  droneBay: "Launches and rebuilds a selected squad of Fighter, Defence or Repair drones. When alive and not Overheated, any positive Power keeps the bay operational; production and launch cadence scale linearly with allocated Power, while 0 Power stops both. Squad size, fuel duration and rebuild time depend on the selected drone type. Requires one completely exposed two-cell launch edge.",
  repairBeam: "Directional support beam that projects hull repair onto a damaged allied ship in range.",
  propulsionCommandRelay: "Improves the acceleration and turn rate of nearby allied ships. Does not increase top speed.",
  demolitionCharge: "Compact kamikaze charge for attack swarms. Armed by default, it detonates when an enemy enters its trigger radius, damages a limited number of components and does not damage friendly ships.",
  electronicWarfareCommandCentre: "Improves nearby allied sensor range, resistance to missile tracking and the ability of weapons to retain precise component targeting."
});

function textFilesUnder(directory) {
  const extensions = new Set([".css", ".html", ".js", ".json"]);
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...textFilesUnder(fullPath));
    else if (extensions.has(path.extname(entry.name).toLowerCase())) result.push(fullPath);
  }
  return result;
}

const balance = JSON.parse(read("component-balance.json"));
const components = new Map((balance.components || []).map((component) => [component.id, component]));

for (const [id, description] of Object.entries(CANONICAL_DESCRIPTIONS)) {
  assert.strictEqual(components.get(id)?.description, description, `${id} description must remain canonical balance copy`);
}
assert.strictEqual(balance.movement?.authority, "public/src/shared/movementStats.js",
  "the catalogue movement note must point to the shared movement authority");
for (const obsolete of ["requiresThrust", "noEngineMaxSpeed", "noEngineAcceleration", "effectiveThrust", "effectiveTurn", "powerEfficiency", "turnScaling", "evasion", "softSpeedCap", "softTurnCap", "propulsionCapacitor", "movementStyles"]) {
  assert.strictEqual(Object.hasOwn(balance.movement || {}, obsolete), false,
    `movement catalogue must not carry derived or removed field ${obsolete}`);
}
for (const obsolete of ["lateralThrust", "brakingThrust", "reverseThrust"]) {
  assert.strictEqual(Object.hasOwn(components.get("maneuverThruster") || {}, obsolete), false,
    `Maneuver Thruster must not carry removed movement field ${obsolete}`);
}
assert.doesNotMatch(balance.movement?.effectiveThrust || "", /falloff|100%|96%/i,
  "the catalogue must not duplicate numerical engine falloff prose");
assert.doesNotMatch(balance.movement?.effectiveTurn || "", /100%|92%|85%/i,
  "the catalogue must not duplicate numerical turn stacking prose");
assert.strictEqual(balance.movement?.propulsionCapacitor, undefined,
  "obsolete propulsion-capacitor tuning is absent from the catalogue");
assert.strictEqual(balance.movement?.movementStyles, undefined,
  "obsolete capacitor movement styles are absent from the catalogue");
for (const id of ["core", "auxGenerator", "reactor", "nuclearReactor"]) {
  assert.strictEqual(Object.hasOwn(components.get(id) || {}, "energy"), false,
    `${id} does not expose dead generator Energy metadata`);
}
assert.strictEqual(components.get("battery")?.energyCapacity, 80, "Battery storage capacity remains authoritative");
assert.strictEqual(components.get("capacitor")?.energyCapacity, 160, "Capacitor storage capacity remains authoritative");
assert.strictEqual(components.get("sensorArray"), undefined, "legacy Sensor Array is absent from the authoritative catalogue");
assert.strictEqual(components.get("directedSensor"), undefined, "legacy Directed Sensor is absent from the authoritative catalogue");
assert.strictEqual(components.get("droneBay")?.category, "Command", "Drone Bay catalogue category is Command");
for (const id of ["core", "auxGenerator", "reactor", "nuclearReactor"]) {
  assert.strictEqual(PARTS[id].energyStorage, 0, `${id} has no server-side fake Energy Storage`);
  assert.strictEqual(PARTS[id].energyCapacity, 0, `${id} has no server-side fake Energy Capacity`);
}
assert.strictEqual(PARTS.battery.energyCapacity, 80, "server Battery storage remains available");
assert.strictEqual(PARTS.capacitor.energyCapacity, 160, "server Capacitor storage remains available");

const partsSource = read("public/src/design/parts.js");
const serverPartsSource = read("src/server/components.js");
const schemaSource = read("src/server/componentSchema.js");
const inspectorSource = read("public/src/ui/partInspectorUi.js");
const inspectorModelSource = read("public/src/design/componentInspectorModel.js");
assert.match(partsSource, /PART_DESCRIPTIONS = Object\.freeze\(\{\s*default:/,
  "parts.js must expose only a generic fallback description");
assert.doesNotMatch(partsSource, /Command heart|Redundant command centre|three configurable/,
  "parts.js must not carry detailed catalogue copy");
assert.doesNotMatch(inspectorSource, /enrichDescription/,
  "the inspector must not rewrite catalogue descriptions");
assert.match(inspectorSource, /description: partDescription\(type, stat\)/,
  "the inspector must render the canonical part description directly");
assert.doesNotMatch(inspectorModelSource, /Enemy within 50 m/,
  "the inspector must not hardcode the demolition trigger distance");
assert.match(inspectorModelSource, /cfg\.triggerRadius/,
  "the inspector trigger row must use catalogue proximity-charge data");
assert.doesNotMatch(inspectorModelSource, /lateralThrust|Lateral Thrust/,
  "the inspector must not expose removed lateral-thrust mechanics");
assert.doesNotMatch(partsSource, /type === ["']droneBay["']\) return ["']Command["']/,
  "the UI must read Drone Bay category from the catalogue");
assert.doesNotMatch(serverPartsSource, /propulsionCapacitor/,
  "server component normalization has no propulsion-capacitor passthrough");
assert.doesNotMatch(partsSource, /propulsionCapacitor/,
  "client component normalization has no propulsion-capacitor passthrough");
assert.doesNotMatch(schemaSource, /propulsionCapacitor/,
  "component schema has no obsolete propulsion-capacitor validator");

const shippedTextFiles = [
  ...textFilesUnder(path.join(ROOT, "public")),
  path.join(ROOT, "component-balance.json")
];
for (const file of shippedTextFiles) {
  const contents = fs.readFileSync(file, "utf8");
  assert.ok(!contents.includes("\u2014"), `shipped copy contains an em dash: ${path.relative(ROOT, file)}`);
}

global.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, getContext: () => null })
};
global.window = { devicePixelRatio: 1 };
globalThis.HeatRules = require("../public/src/shared/heatRules");

(async () => {
  const parts = await import("../public/src/design/parts.js");
  assert.strictEqual(parts.partDescription("core", parts.PART_STATS.core), CANONICAL_DESCRIPTIONS.core,
    "partDescription must return the catalogue description");
  assert.strictEqual(parts.partDescription("unknown", {}), "General-purpose ship component.",
    "unknown components must use only the generic fallback");
  assert.strictEqual(parts.PART_STATS.demolitionCharge.proximityCharge.triggerRadius, 75,
    "demolition trigger metadata must flow from the catalogue into the inspector stats");
  assert.strictEqual(parts.PART_STATS.droneBay.category, "Command");
  assert.strictEqual(parts.partCategory("droneBay"), "Command");
  for (const id of ["core", "auxGenerator", "reactor", "nuclearReactor"]) {
    assert.strictEqual(parts.PART_STATS[id].energyStorage, 0, `${id} has no derived fake Energy Storage`);
  }
  assert.strictEqual(parts.PART_STATS.battery.energyCapacity, 80);
  assert.strictEqual(parts.PART_STATS.capacitor.energyCapacity, 160);

  const ledger = await import("../public/src/ledger/ledgerContent.js");
  const articleText = (id) => {
    const article = ledger.getArticleById(id);
    assert.ok(article, `missing Ledger article ${id}`);
    return JSON.stringify(article);
  };
  const engineText = articleText("component:engine");
  const movementText = articleText("movement");
  const repairText = articleText("repair-mechanics");
  const nuclearText = articleText("component:nuclearReactor");
  const droneText = articleText("component:droneBay");
  const missileText = articleText("component:missile");
  const flakText = articleText("component:flakCannon");

  assert.match(engineText, /Linear/);
  assert.match(movementText, /Linear per live component/);
  assert.doesNotMatch(movementText, /diminishing returns|falloff|96%|92%|85%/i);
  assert.match(repairText, /Local Repair modules use diminishing returns/i);
  assert.match(repairText, /additional source contributes 80%/i);
  assert.match(repairText, /Repair beams[^.]*separately from the local Repair stack/i);
  assert.match(nuclearText, /1500 damage/);
  assert.match(nuclearText, /2\.5 tiles/);
  assert.match(droneText, /Fighter 3/);
  assert.match(droneText, /Defence 4/);
  assert.match(droneText, /Repair 2/);
  assert.match(droneText, /20s/);
  assert.match(droneText, /15s/);
  assert.match(droneText, /10s/);
  assert.match(droneText, /Fighter: Yes, up to \+30% speed while dodging/);
  assert.match(droneText, /Defence: Yes, up to \+25% speed while dodging/);
  assert.match(droneText, /Repair: None/);
  assert.match(droneText, /Fighter can briefly reach 130% of listed speed/);
  assert.match(droneText, /Defence can briefly reach 125% of listed speed/);
  assert.doesNotMatch(missileText, /Splash Damage/);
  assert.match(flakText, /1[×x] ship damage multiplier/);
  assert.doesNotMatch(flakText, /Negligible Ship Damage/);
  assert.match(flakText, /weak against ships because its base damage is low/);

  console.log("Component copy and authoritative Ledger verification passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
