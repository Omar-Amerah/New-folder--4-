(function initTurretRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.TurretRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeTurretRules() {
  "use strict";

  // Turret traverse rates in rad/s, shared by the server aim simulation
  // (combat.js) and the client turret sprites so what players see is exactly
  // what the server aims. Rates are deliberately slow enough that a turret
  // visibly sweeps onto its target instead of snapping there within one server
  // tick (the old 12 rad/s blaster crossed a full 120-degree arc in ~0.17s).
  const TURN_RATES = Object.freeze({
    blaster: 3.4,
    autocannon: 4.6,
    missile: 2.4,
    railgun: 1.5,
    beam: 1.65,
    emp: 0.9,
    pointDefense: 7.5, // fast by design: it has to swat crossing missiles
    flak: 4.5,
    default: 3.0
  });

  // Non-beam weapons may fire only when their turret has effectively reached
  // the current firing solution. This is a numerical guard, not a gameplay
  // cone: aim speed controls how quickly the solution is reached, while
  // accuracy controls the shot's post-fire spread.
  const FIRING_ALIGNMENT_TOLERANCE = 0.001;

  function turnRateFor(weapon) {
    if (!weapon) return TURN_RATES.default;
    if (typeof weapon === "string") return TURN_RATES[weapon] ?? TURN_RATES.default;
    // Overrides must be positive finite numbers. A zero/null aimSpeed (e.g.
    // from a serialization round trip that turned undefined into null/0) must
    // never freeze the traverse : fall through to the family table instead.
    if (Number.isFinite(weapon.aimSpeed) && weapon.aimSpeed > 0) return weapon.aimSpeed;
    if (Number.isFinite(weapon.turretTurnRate) && weapon.turretTurnRate > 0) return weapon.turretTurnRate;
    const family = weapon.type || weapon.family;
    return TURN_RATES[family] ?? TURN_RATES.default;
  }

  // Distance from the turret pivot to the barrel tip, in tiles, so projectiles
  // spawn at the visible muzzle. Single-tile fractions mirror the barrel art in
  // renderer.js (drawModule / drawProfessionalModuleDetail); keep them in sync
  // when the art changes. Multi-tile weapons draw their barrels out to the
  // forward footprint edge, so the muzzle sits just inside that edge.
  const MUZZLE_TIP_TILES = Object.freeze({
    blaster: 0.56,
    lightBlaster: 0.56,
    heavyBlaster: 0.56,
    autocannon: 0.62,
    missile: 0.4,
    lightMissile: 0.4,
    railgun: 0.68,
    lightRailgun: 0.68,
    heavyRailgun: 0.68,
    torpedo: 0.72,
    swarmMissile: 0.52,
    beamEmitter: 0.66,
    thermalInductionLance: 0.66,
    repairBeam: 0.66,
    scatterCannon: 0.54,
    plasmaCannon: 0.6,
    fragmentationCannon: 0.6,
    empCannon: 0.44,
    pointDefense: 0.62,
    pointDefenseLaser: 0.62,
    flakCannon: 0.45,
    flak: 0.45,
    interceptorPod: 0.44,
    default: 0.6
  });

  function muzzleTiles(type, family, longTiles) {
    if ((longTiles || 1) > 1) return longTiles * 0.5 - 0.04;
    return MUZZLE_TIP_TILES[type] ?? MUZZLE_TIP_TILES[family] ?? MUZZLE_TIP_TILES.default;
  }

  // Weapons whose art has more than one visible barrel. `count` barrels sit
  // evenly spaced across `spreadTiles` on either side of the turret pivot,
  // measured perpendicular to the barrel axis in tiles, so rounds leave the
  // tube the player is looking at instead of the pivot between them. The
  // autocannon pair mirrors the +/- size * 0.17 barrel centres drawn in
  // componentArt.js (drawProfessionalModuleDetail) : move both together.
  const BARRELS = Object.freeze({
    autocannon: Object.freeze({ count: 2, spreadTiles: 0.17 }),
    // Three visible muzzles across the cluster head drawn in componentArt.js
    // (drawProfessionalModuleDetail, scatterCannon) : move both together.
    scatterCannon: Object.freeze({ count: 3, spreadTiles: 0.15 })
  });

  function barrelCount(type) {
    return BARRELS[type]?.count ?? 1;
  }

  // Lateral offset of one barrel from the pivot, in tiles. Positive is to the
  // turret's right (local +y). Single-barrel weapons always return 0, so
  // callers can pass a shot counter unconditionally.
  function barrelLateralTiles(type, barrelIndex) {
    const spec = BARRELS[type];
    if (!spec || spec.count < 2) return 0;
    const index = ((Math.trunc(barrelIndex) || 0) % spec.count + spec.count) % spec.count;
    const step = (spec.spreadTiles * 2) / (spec.count - 1);
    return -spec.spreadTiles + step * index;
  }

  return Object.freeze({
    TURN_RATES,
    FIRING_ALIGNMENT_TOLERANCE,
    MUZZLE_TIP_TILES,
    BARRELS,
    turnRateFor,
    muzzleTiles,
    barrelCount,
    barrelLateralTiles
  });
}));
