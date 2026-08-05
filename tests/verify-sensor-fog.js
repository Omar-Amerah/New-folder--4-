const assert = require("assert");
const fs = require("fs");
const { createRoom, sanitizeRoomRules, setRoomRules, usesSensorVisibility } = require("../src/server/rooms");
const {
  computeTeamVisibility,
  canTeamTargetEntity,
  getVisibilityState,
  getSensorSourcesForTeam,
  isPointInCoverage,
  invalidateVisibility,
  usesSensorVisibility: usesVis,
  DETECTION_LINGER_MS,
  REMEMBERED_CONTACT_MS
} = require("../src/server/visibility");
const {
  effectiveSensorProfile,
  effectiveSensorRange,
  stackedSensorRangeBonus,
  getHullBaseSensorRange,
  designSensorProfile
} = require("../src/server/sensorCapability");
const { computeStats } = require("../src/server/shipStats");
const { PARTS } = require("../src/server/components");
const { filterSnapshotForPlayer } = require("../src/server/visibilitySnapshots");
const { dropHiddenTargetLocksForShips } = require("../src/server/targetLocks");
const { createMovementRuntime, setMovementCommand } = require("../src/server/movementRuntime");
const RotationRules = require("../public/src/shared/rotationRules");

function testRoomDefaults() {
  const room = createRoom("test");
  assert.strictEqual(room.rules.visibilityMode, "sensors", "default visibilityMode is Sensor Fog");
  assert.strictEqual(usesSensorVisibility(room), true, "usesSensorVisibility true by default");

  room.rules.visibilityMode = "full";
  assert.strictEqual(usesSensorVisibility(room), false, "usesSensorVisibility false for full");
  room.rules.visibilityMode = "sensors";
  assert.strictEqual(usesSensorVisibility(room), true, "usesSensorVisibility true for sensors");
  room.rules.visibilityMode = "dark";
  assert.strictEqual(usesSensorVisibility(room), true, "usesSensorVisibility true for Full Dark");
}

function testSanitizeRoomRules() {
  const rules = sanitizeRoomRules({ visibilityMode: "sensors" });
  assert.strictEqual(rules.visibilityMode, "sensors");
  const fallback = sanitizeRoomRules({ visibilityMode: "invalid" });
  assert.strictEqual(fallback.visibilityMode, "sensors");
  const full = sanitizeRoomRules({ visibilityMode: "full" });
  assert.strictEqual(full.visibilityMode, "full");
  const dark = sanitizeRoomRules({ visibilityMode: "dark" });
  assert.strictEqual(dark.visibilityMode, "dark");
}

function testSensorCapability() {
  const ship = {
    alive: true,
    x: 0,
    y: 0,
    hp: 100,
    design: [{ x: 0, y: 0, type: "sensorArray" }],
    componentHp: [38],
    componentMaxHp: [38],
    componentPower: { byComponentIndex: [{ operationalMultiplier: 1 }] },
    stats: { massClass: "medium", unitCost: 100 }
  };
  const range = effectiveSensorRange(ship);
  assert(range > getHullBaseSensorRange("medium"), "sensor array increases range");

  const room = {
    rules: { visibilityMode: "sensors" },
    _visibilityGeneration: 1
  };
  const cachedRange = effectiveSensorRange(ship, room);
  ship.componentPower.byComponentIndex[0].operationalMultiplier = 0;
  assert.strictEqual(effectiveSensorRange(ship, room), cachedRange, "one visibility generation reuses sensor capability");
  invalidateVisibility(room, "sensor-power-changed");
  assert(effectiveSensorRange(ship, room) < cachedRange, "a new visibility generation refreshes sensor capability");
}

function testStacking() {
  const total = stackedSensorRangeBonus([{ bonus: 400 }, { bonus: 400 }, { bonus: 400 }]);
  assert(total < 900, "diminishing returns");
  assert(total > 600, "first and second give meaningful range");
  const prioritized = stackedSensorRangeBonus([
    { index: 0, role: "omniSmall", bonus: 1000 },
    { index: 1, role: "omniLarge", bonus: 100 }
  ]);
  assert.strictEqual(prioritized, 750, "Large Sensors receive the first stack slot before Small Sensors");
}

function testSensorCatalogue() {
  assert.strictEqual(PARTS.smallSensor.sensorRole, "omniSmall");
  assert.strictEqual(PARTS.largeSensor.sensorRole, "omniLarge");
  assert.strictEqual(PARTS.directedSensor.sensorRole, "directed");
  assert.strictEqual(PARTS.smallDirectedSensor.sensorRole, "directed");
  assert.strictEqual(PARTS.largeDirectedSensor.sensorRole, "directed");
  assert.deepStrictEqual(PARTS.smallSensor.footprint, { width: 1, height: 1 });
  assert.deepStrictEqual(PARTS.largeSensor.footprint, { width: 2, height: 1 });
  assert.deepStrictEqual(PARTS.smallDirectedSensor.footprint, { width: 1, height: 1 });
  assert.deepStrictEqual(PARTS.largeDirectedSensor.footprint, { width: 2, height: 1 });
  assert(PARTS.largeSensor.sensorRangeBonus > PARTS.smallSensor.sensorRangeBonus);
  assert(PARTS.largeDirectedSensor.sensorRangeBonus > PARTS.smallDirectedSensor.sensorRangeBonus);
  assert(PARTS.smallDirectedSensor.sensorRangeBonus > PARTS.largeSensor.sensorRangeBonus);
}

function testDirectedSensorProfileAndCoverage() {
  const largeFootprint = PARTS.largeDirectedSensor.footprint;
  assert.strictEqual(
    RotationRules.directionalFootprintToShipRadians(270, largeFootprint),
    0,
    "a visually forward 2x1 Directed Sensor faces ship-forward"
  );
  assert.strictEqual(
    RotationRules.directionalFootprintToShipRadians(0, largeFootprint),
    Math.PI / 2,
    "a right-facing 2x1 Directed Sensor faces ship-right"
  );
  assert.strictEqual(
    RotationRules.directionalFootprintToShipRadians(0, PARTS.smallDirectedSensor.footprint),
    0,
    "a forward-facing 1x1 Directed Sensor faces ship-forward"
  );
  const design = [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 8, y: 7, type: "smallSensor", rotation: 0 },
    { x: 9, y: 7, type: "largeSensor", rotation: 0 },
    { x: 10, y: 7, type: "largeDirectedSensor", rotation: 270 }
  ];
  const withoutDirected = designSensorProfile(design.slice(0, 3), "medium");
  const withDirected = designSensorProfile(design, "medium");
  assert.strictEqual(withDirected.omniRange, withoutDirected.omniRange, "Directed Sensors do not diminish the omni stack");
  assert(withDirected.directedRange > withDirected.omniRange, "Directed Sensor reaches substantially farther than omni coverage");

  const ship = {
    id: "scanner",
    type: "ship",
    alive: true,
    hp: 100,
    angle: 0,
    design,
    componentHp: [100, 26, 58, 44],
    componentMaxHp: [100, 26, 58, 44],
    componentPower: { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) },
    stats: { massClass: "medium" }
  };
  const profile = effectiveSensorProfile(ship);
  const cone = {
    x: 0,
    y: 0,
    range: profile.directed[0].range,
    shape: "cone",
    angle: profile.directed[0].relativeAngle,
    halfAngle: profile.directed[0].halfAngle
  };
  assert(isPointInCoverage(cone, 1400, 0), "forward target is inside directed coverage");
  assert(!isPointInCoverage(cone, -1400, 0), "rear target is outside directed coverage");
  assert(!isPointInCoverage(cone, 0, 1400), "side target is outside directed coverage");

  const secondDirected = { x: 10, y: 8, type: "smallDirectedSensor", rotation: 0 };
  const doubled = {
    ...ship,
    design: [...design, secondDirected],
    componentHp: [...ship.componentHp, 28],
    componentMaxHp: [...ship.componentMaxHp, 28],
    componentPower: {
      byComponentIndex: [...ship.componentPower.byComponentIndex, { operationalMultiplier: 1 }]
    }
  };
  const doubledProfile = effectiveSensorProfile(doubled);
  assert.strictEqual(doubledProfile.directed.length, 2);
  assert.strictEqual(doubledProfile.directed[0].componentIndex, 3,
    "Large Directed Sensors receive the first directed stack slot");
  const expectedStackedForwardRange = getHullBaseSensorRange("medium")
    + PARTS.largeDirectedSensor.sensorRangeBonus
    + PARTS.smallDirectedSensor.sensorRangeBonus * 0.65;
  assert.strictEqual(
    doubledProfile.directed[0].range,
    expectedStackedForwardRange,
    "aligned Directed Sensors stack their diminished bonuses into the forward cone"
  );
  assert(doubledProfile.directed[0].range > profile.directed[0].range,
    "a second forward Directed Sensor increases forward detection range");

  const doubledDesignProfile = designSensorProfile([...design, secondDirected], "medium");
  assert.strictEqual(
    doubledDesignProfile.directedRange,
    expectedStackedForwardRange,
    "the designer reports the same stacked forward range as runtime"
  );

  const sideFacing = {
    ...doubled,
    design: [...design, { ...secondDirected, rotation: 90 }]
  };
  const sideFacingProfile = effectiveSensorProfile(sideFacing);
  assert.strictEqual(
    sideFacingProfile.directed[0].range,
    profile.directed[0].range,
    "a Directed Sensor aimed elsewhere does not extend the forward cone"
  );
}

function testDesignerSensorRange() {
  const stats = computeStats([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "sensorArray" }]);
  assert(stats.sensorRange > stats.baseSensorRange, "designer reports increased sensor range");
  const mixed = computeStats([
    { x: 7, y: 7, type: "core" },
    { x: 8, y: 7, type: "smallSensor" },
    { x: 9, y: 7, type: "largeSensor" },
    { x: 11, y: 7, type: "largeDirectedSensor", rotation: 0 }
  ]);
  assert(mixed.sensorRange > mixed.baseSensorRange, "designer reports combined omni sensor range");
  assert(mixed.directedSensorRange > mixed.sensorRange, "designer reports the longer directed reach separately");
  assert.strictEqual(mixed.directedSensorCount, 1);
}

function testTeamVisibility() {
  const room = createRoom("v");
  room.rules.visibilityMode = "sensors";
  room.rules.infrastructureMode = "stations";
  room.spatialIndex = {
    dynamicValid: true,
    queryRangeUnordered: (kind, x, y, r, out) => {
      out.length = 0;
      const entities = kind === "ships"
        ? room.ships.values()
        : kind === "drones" ? room.drones.values() : room.stations;
      for (const entity of entities) {
        if (entity && Math.hypot((entity.x || 0) - x, (entity.y || 0) - y) <= r) out.push(entity);
      }
      return out;
    }
  };

  const blue = { id: "p1", team: "blue" };
  const red = { id: "p2", team: "red" };
  room.players.set(blue.id, blue);
  room.players.set(red.id, red);

  const s1 = { id: "s1", ownerId: blue.id, x: 0, y: 0, alive: true, hp: 100, design: [{ x: 7, y: 7, type: "core" }], componentHp: [260], componentMaxHp: [260], componentPower: { byComponentIndex: [{ operationalMultiplier: 1 }] }, stats: { massClass: "medium" }, radius: 32 };
  const s2 = { id: "s2", ownerId: red.id, x: 400, y: 0, alive: true, hp: 100, design: [{ x: 7, y: 7, type: "core" }], componentHp: [260], componentMaxHp: [260], componentPower: { byComponentIndex: [{ operationalMultiplier: 1 }] }, stats: { massClass: "medium" }, radius: 32 };
  const drone = { id: "d1", ownerId: red.id, teamId: "red", x: 300, y: 0, radius: 10, hull: 10, alive: true };
  const station = { id: "st1", ownerId: red.id, team: "red", stationType: "relay", x: 350, y: 0, radius: 40, hp: 100, alive: true, state: "operational" };
  room.ships.set(s1.id, s1);
  room.ships.set(s2.id, s2);
  room.drones.set(drone.id, drone);
  room.stations = [station];

  const now = 1000;
  const state = computeTeamVisibility(room, "blue", now);
  assert(state.visibleEntityIds.has("s1"), "own ship visible");
  assert(state.visibleEntityIds.has("s2"), "enemy within range visible");
  assert(state.visibleEntityIds.has("d1"), "enemy drone within range visible");
  assert(state.visibleEntityIds.has("st1"), "enemy station within range visible");

  s1.focusTargetId = s2.id;
  s1.combatTargetId = s2.id;
  s1.targetX = s2.x;
  s1.targetY = s2.y;
  s1.movement = createMovementRuntime();
  setMovementCommand(s1, {
    id: "attack:s1",
    type: "attack",
    targetId: s2.id
  });
  s1.weaponAimTargetIds = [s2.id];
  s1.weaponFireTargetIds = [s2.id];
  s1.weaponAcquiredTargetIds = [s2.id];
  s1.weaponPendingTargetIds = [s2.id];
  s1.weaponAcquireCompleteAt = [5000];
  s1.weaponComponentTargetIds = [s2.id];
  s1.weaponComponentTargetIndices = [0];
  s1.weaponComponentRetargetAt = [5000];
  s1.weaponBeamContacts = [{ targetShipId: s2.id, contactDuration: 1 }];
  assert.strictEqual(
    dropHiddenTargetLocksForShips(room, [s1], now),
    0,
    "a live visible contact keeps its ship, movement and weapon locks"
  );

  s2.x = 3000;
  const state2 = computeTeamVisibility(room, "blue", now + 100);
  assert(state2.visibleEntityIds.has("s2"), "detection linger keeps a newly lost enemy visible");
  assert(state2.remembered.has("s2"), "enemy becomes remembered");
  assert.strictEqual(getVisibilityState(room, "blue", "s2", now + 100), "visible");

  const rememberedAt = now + 100 + DETECTION_LINGER_MS + 1;
  const state3 = computeTeamVisibility(room, "blue", rememberedAt);
  assert(!state3.visibleEntityIds.has("s2"), "enemy leaves the live set after detection linger");
  assert.strictEqual(getVisibilityState(room, "blue", "s2", rememberedAt), "remembered");
  const later = rememberedAt + 5000;
  const targetable = canTeamTargetEntity(room, "blue", s2, later);
  assert(!targetable, "hidden enemy cannot be targeted");
  assert(dropHiddenTargetLocksForShips(room, [s1], later) > 0,
    "the authoritative visibility boundary drops every retained hidden lock");
  assert.strictEqual(s1.focusTargetId, null, "hidden contact clears explicit focus");
  assert.strictEqual(s1.combatTargetId, null, "hidden contact clears the combat target");
  assert.strictEqual(s1.movement.command, null, "hidden contact cancels pursuit");
  assert.strictEqual(s1.targetX, s1.x, "cancelled pursuit no longer exposes the target position");
  assert.strictEqual(s1.targetY, s1.y, "cancelled pursuit stops at the ship's current position");
  assert.deepStrictEqual(s1.weaponAimTargetIds, [null], "turret aim lock is cleared");
  assert.deepStrictEqual(s1.weaponFireTargetIds, [null], "weapon fire lock is cleared");
  assert.deepStrictEqual(s1.weaponAcquiredTargetIds, [null], "weapon acquisition is forgotten");
  assert.deepStrictEqual(s1.weaponPendingTargetIds, [null], "pending acquisition is forgotten");
  assert.deepStrictEqual(s1.weaponAcquireCompleteAt, [0], "acquisition timer is reset");
  assert.deepStrictEqual(s1.weaponComponentTargetIds, [null], "component aim lock is cleared");
  assert.deepStrictEqual(s1.weaponComponentTargetIndices, [-1], "component aim index is reset");
  assert.deepStrictEqual(s1.weaponComponentRetargetAt, [0], "component retarget timer is reset");
  assert.deepStrictEqual(s1.weaponBeamContacts, [null], "continuous beam contact is cleared");

  const expiredAt = now + 100 + DETECTION_LINGER_MS + REMEMBERED_CONTACT_MS + 1;
  computeTeamVisibility(room, "blue", expiredAt);
  assert.strictEqual(getVisibilityState(room, "blue", "s2", expiredAt), "hidden", "remembered contacts expire");
}

function testDirectedTeamVisibility() {
  const room = createRoom("directed");
  room.rules.visibilityMode = "dark";
  room.rules.infrastructureMode = "stations";
  const blue = { id: "blue-directed", team: "blue" };
  const red = { id: "red-directed", team: "red" };
  room.players.set(blue.id, blue);
  room.players.set(red.id, red);
  const source = {
    id: "directed-source",
    ownerId: blue.id,
    type: "ship",
    x: 0,
    y: 0,
    angle: 0,
    radius: 25,
    alive: true,
    hp: 100,
    design: [
      { x: 7, y: 7, type: "core", rotation: 0 },
      { x: 8, y: 7, type: "largeDirectedSensor", rotation: 270 }
    ],
    componentHp: [100, 44],
    componentMaxHp: [100, 44],
    componentPower: { byComponentIndex: [{ operationalMultiplier: 1 }, { operationalMultiplier: 1 }] },
    stats: { massClass: "medium" }
  };
  const forward = { id: "forward", ownerId: red.id, x: 1400, y: 0, radius: 25, alive: true, hp: 100, design: [], stats: { massClass: "medium" } };
  const rear = { id: "rear", ownerId: red.id, x: -1400, y: 0, radius: 25, alive: true, hp: 100, design: [], stats: { massClass: "medium" } };
  room.ships.set(source.id, source);
  room.ships.set(forward.id, forward);
  room.ships.set(rear.id, rear);
  room.spatialIndex = null;

  const state = computeTeamVisibility(room, "blue", 1000);
  assert(state.visibleEntityIds.has(forward.id), "forward enemy is detected by the directed cone");
  assert(!state.visibleEntityIds.has(rear.id), "equally distant rear enemy remains hidden");
  assert(state.coverage.some((entry) => entry.shape === "cone"), "authoritative coverage contains a cone source");
}

function testGenerationCache() {
  const room = createRoom("cache");
  room.rules.visibilityMode = "sensors";
  const blue = { id: "p1", team: "blue" };
  const red = { id: "p2", team: "red" };
  room.players.set(blue.id, blue);
  room.players.set(red.id, red);
  const source = { id: "source", ownerId: blue.id, x: 0, y: 0, alive: true, hp: 100, design: [], stats: { massClass: "medium" } };
  const target = { id: "target", ownerId: red.id, x: 100, y: 0, alive: true, hp: 100, design: [], stats: { massClass: "medium" } };
  room.ships.set(source.id, source);
  room.ships.set(target.id, target);
  let queries = 0;
  room.spatialIndex = {
    dynamicValid: true,
    queryRangeUnordered(_kind, _x, _y, _range, out) {
      queries += 1;
      out.length = 0;
      out.push(source, target);
      return out;
    }
  };

  invalidateVisibility(room, "test");
  assert(canTeamTargetEntity(room, "blue", target, 10));
  assert(canTeamTargetEntity(room, "blue", target, 10.125));
  assert(canTeamTargetEntity(room, "blue", target, 10.75));
  assert.strictEqual(room._visibilityComputeCount, 1, "fractional timestamps reuse one visibility generation");
  invalidateVisibility(room, "moved");
  source.focusTargetId = target.id;
  source.combatTargetId = target.id;
  assert.strictEqual(dropHiddenTargetLocksForShips(room, [source], 11), 0,
    "visible target-lock validation preserves the contact");
  assert.strictEqual(room._visibilityComputeCount, 2, "target-lock validation computes the new team generation once");
  assert(canTeamTargetEntity(room, "blue", target, 11));
  assert.strictEqual(room._visibilityComputeCount, 2, "combat reuses the generation computed by target-lock validation");
}

function testClassicRelayAndDestroyedStation() {
  const room = createRoom("relay");
  room.rules.visibilityMode = "sensors";
  room.rules.infrastructureMode = "classic";
  room.points = [{ id: "r1", x: 10, y: 20, ownerTeam: "blue" }];
  const sources = getSensorSourcesForTeam(room, "blue");
  assert(sources.some((source) => source.entity.id === "r1"), "owned classic relay is a sensor source");
  assert.strictEqual(
    effectiveSensorRange({ stationType: "home", state: "destroyed", alive: false }),
    0,
    "destroyed stations do not keep revealing fog"
  );
}

function testSnapshotFiltering() {
  const room = createRoom("filter");
  room.rules.visibilityMode = "sensors";
  room.rules.infrastructureMode = "stations";
  const blue = { id: "blue-player", team: "blue" };
  const red = { id: "red-player", team: "red" };
  room.players.set(blue.id, blue);
  room.players.set(red.id, red);
  const source = { id: "blue-ship", ownerId: blue.id, x: 0, y: 0, alive: true, hp: 100, design: [], stats: { massClass: "medium" } };
  const nearDrone = { id: "near-drone", ownerId: red.id, teamId: "red", x: 100, y: 0, radius: 10 };
  const farDrone = { id: "far-drone", ownerId: red.id, teamId: "red", x: 2000, y: 0, radius: 10 };
  room.ships.set(source.id, source);
  room.drones.set(nearDrone.id, nearDrone);
  room.drones.set(farDrone.id, farDrone);
  room.spatialIndex = null;
  invalidateVisibility(room, "snapshot");

  const filtered = filterSnapshotForPlayer(room, blue, {
    ships: [{ id: source.id }],
    drones: [{ id: nearDrone.id }, { id: farDrone.id }],
    decoys: [],
    stations: [],
    bullets: [
      { id: "friendly", ownerId: blue.id, x: 2000, y: 0 },
      { id: "near-enemy", ownerId: red.id, x: 100, y: 0 },
      { id: "far-enemy", ownerId: red.id, x: 2000, y: 0 }
    ],
    effects: []
  }, 50);
  assert.deepStrictEqual(filtered.drones.map((entry) => entry.id), ["near-drone"]);
  assert.deepStrictEqual(filtered.bullets.map((entry) => entry.id), ["friendly", "near-enemy"]);
}

function testTeamSnapshotCacheInvalidation() {
  const room = createRoom("team-cache");
  room.rules.visibilityMode = "sensors";
  room.rules.infrastructureMode = "stations";
  const blue = { id: "blue", team: "blue" };
  const blueAlly = { id: "blue-ally", team: "blue" };
  const red = { id: "red", team: "red" };
  room.players.set(blue.id, blue);
  room.players.set(blueAlly.id, blueAlly);
  room.players.set(red.id, red);
  const blueSource = { id: "blue-source", ownerId: blue.id, x: 0, y: 0, alive: true, hp: 100, design: [], stats: { massClass: "medium" } };
  const redSource = { id: "red-source", ownerId: red.id, x: 2000, y: 0, alive: true, hp: 100, design: [], stats: { massClass: "medium" } };
  room.ships.set(blueSource.id, blueSource);
  room.ships.set(redSource.id, redSource);
  room.spatialIndex = null;
  const snapshot = {
    ships: [{ id: blueSource.id }, { id: redSource.id }],
    drones: [],
    decoys: [],
    stations: [],
    bullets: [
      { id: "blue-area", ownerId: red.id, x: 100, y: 0 },
      { id: "red-area", ownerId: blue.id, x: 1900, y: 0 }
    ],
    effects: []
  };

  invalidateVisibility(room, "cache-start");
  const firstBlue = filterSnapshotForPlayer(room, blue, snapshot, 10);
  const alliedBlue = filterSnapshotForPlayer(room, blueAlly, snapshot, 10);
  const firstRed = filterSnapshotForPlayer(room, red, snapshot, 10);
  assert.strictEqual(firstBlue.bullets, alliedBlue.bullets, "teammates reuse one filtered tactical array");
  assert.deepStrictEqual(firstBlue.bullets.map((entry) => entry.id), ["blue-area", "red-area"]);
  assert.notStrictEqual(firstBlue.bullets, firstRed.bullets, "opposing teams never share filtered arrays");

  blueSource.x = 4000;
  invalidateVisibility(room, "cache-source-moved");
  const movedBlue = filterSnapshotForPlayer(room, blue, snapshot, 20);
  assert.notStrictEqual(movedBlue.bullets, firstBlue.bullets, "visibility generation invalidates the team snapshot cache");
  assert.deepStrictEqual(movedBlue.bullets.map((entry) => entry.id), ["red-area"], "moved coverage is reflected immediately");
}

function testRendererUsesRasterMask() {
  const source = fs.readFileSync("./public/src/game/pixi/pixiFog.js", "utf8");
  const minimapSource = fs.readFileSync("./public/src/game/pixi/pixiScreenUi.js", "utf8");
  assert(!source.includes(".cut("), "fog renderer no longer rebuilds cut polygons");
  assert(source.includes("destination-out"), "fog renderer cuts soft holes in a canvas mask");
  assert(source.includes("source?.update"), "fog texture updates in place instead of reallocating every frame");
  assert(source.includes("FULL_DARK_COLOR"), "Full Dark uses an explicit opaque-black fog style");
  assert(source.includes('source.shape === "cone"'), "fog renderer cuts directed sensor cones");
  assert(source.includes("export function getPixiFogTexture()"),
    "the arena exposes its existing raster mask for zero-copy minimap reuse");
  assert(minimapSource.includes('state.rules?.visibilityMode === "dark" ? getPixiFogTexture() : null'),
    "Full Dark masks the minimap with the authoritative arena coverage");
  assert(minimapSource.indexOf("content.addChild(dots)") < minimapSource.indexOf("content.addChild(fullDarkFog)"),
    "the Full Dark mask covers minimap terrain, objectives and entity dots");
  assert(minimapSource.indexOf("content.addChild(fullDarkFog)") < minimapSource.indexOf("content.addChild(overlay)"),
    "camera and rally UI remain legible above the minimap fog");
}

function main() {
  testRoomDefaults();
  testSanitizeRoomRules();
  testSensorCapability();
  testSensorCatalogue();
  testStacking();
  testDirectedSensorProfileAndCoverage();
  testDesignerSensorRange();
  testTeamVisibility();
  testDirectedTeamVisibility();
  testGenerationCache();
  testClassicRelayAndDestroyedStation();
  testSnapshotFiltering();
  testTeamSnapshotCacheInvalidation();
  testRendererUsesRasterMask();
  console.log("verify-sensor-fog: all passed");
}

main();
