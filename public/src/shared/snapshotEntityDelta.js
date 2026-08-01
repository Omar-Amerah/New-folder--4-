(function initSnapshotEntityDelta(root, factory) {
  const schema = factory();
  if (typeof module === "object" && module.exports) module.exports = schema;
  root.MfaSnapshotEntityDelta = schema;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeSnapshotEntityDelta() {
  "use strict";

  // The compact v2 wire schema is intentionally kept in one small, dependency
  // free authority.  The server requires this file and the browser imports it
  // for its side effect before reading globalThis.MfaSnapshotEntityDelta.
  const ENTITY_DELTA_FORMAT_VERSION = 2;

  // Fixed hot-row layout.  The id is part of the row so a decoder never has to
  // rely on array order for entity identity.
  const SHIP_MOTION = Object.freeze({
    ID: 0,
    X: 1,
    Y: 2,
    VX: 3,
    VY: 4,
    ANGLE: 5,
    TURN_ACTIVITY: 6,
    TARGET_X: 7,
    TARGET_Y: 8,
    STRIDE: 9
  });

  // Fields in this list are public but comparatively sparse.  They are sent
  // in a state row only when the row signature changed.  Large static and
  // permissioned values deliberately do not belong here.
  const SHIP_STATE_FIELDS = Object.freeze([
    "ownerId", "team", "designRevision", "componentAliveRevision",
    "componentDamageRevision", "chpVisual", "proximityChargeRevision", "combatStyle",
    "movementToggles", "hp", "maxHp", "shield", "maxShield", "radius", "cost",
    "focusTargetId", "combatTargetId", "weaponAngles", "commandState",
    "emergencyReserveUntil", "alive", "commandAuraActive", "commandAuraReceived",
    "proximityChargeDetonated", "blasterRange", "missileRange", "railgunRange",
    "beamRange", "weaponRanges", "beamRadius", "sensorRange", "sensorCones",
    "respawnIn", "removeIn", "heat", "heatNow", "heatMax", "hot", "overheated",
    "heatRevision", "heatStateRevision", "destructProgress",
    "droneBays", "decoyLaunchers", "engBlocked"
  ]);

  // chpVisual is deliberately omitted on ordinary compact frames and is
  // refreshed by componentDamageRevision when it changes.  Keep it out of the
  // state comparison signature so omission is not mistaken for deletion.
  const SHIP_STATE_SIGNATURE_FIELDS = Object.freeze(
    SHIP_STATE_FIELDS.filter((field) => field !== "chpVisual")
  );

  // Shared privacy authority.  A public/detail downgrade must clear every
  // field here, including fields added by later Power/Heat revisions.
  const PRIVATE_SHIP_FIELDS = Object.freeze([
    "componentPower", "powerStatus", "powerThermal", "powerRevision", "wiringRevision",
    "powerRuntimeRevision", "wiringStatus", "switchgear", "powerProtection",
    "powerProtectionRevision", "powerWiring", "powerWiringRevision", "powerWiringRuntime",
    "chp", "chpD", "componentHeat", "componentHeatD", "storageCharge",
    "componentHeatRevision", "heatTelemetryRevision"
  ]);

  const GENERIC_MOTION_FIELDS = Object.freeze({
    drones: Object.freeze(["x", "y", "vx", "vy", "angle", "stateProgress", "fuelRemainingSeconds"]),
    decoys: Object.freeze(["x", "y", "vx", "vy", "remainingSeconds"]),
    effects: Object.freeze(["age"])
  });

  function cleanNumber(value, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Object.is(number, -0) ? 0 : number;
  }

  function packShipMotion(ship) {
    return [
      ship?.id,
      cleanNumber(ship?.x),
      cleanNumber(ship?.y),
      cleanNumber(ship?.vx),
      cleanNumber(ship?.vy),
      cleanNumber(ship?.angle),
      cleanNumber(ship?.turnActivity),
      cleanNumber(ship?.targetX),
      cleanNumber(ship?.targetY)
    ];
  }

  function unpackShipMotion(row) {
    if (!Array.isArray(row) || row.length !== SHIP_MOTION.STRIDE) return null;
    const id = row[SHIP_MOTION.ID];
    if ((typeof id !== "string" && typeof id !== "number") || !String(id)) return null;
    const values = row.slice(1).map((value) => Number(value));
    if (values.some((value) => !Number.isFinite(value) || Object.is(value, -0))) return null;
    return {
      id,
      x: values[SHIP_MOTION.X - 1],
      y: values[SHIP_MOTION.Y - 1],
      vx: values[SHIP_MOTION.VX - 1],
      vy: values[SHIP_MOTION.VY - 1],
      angle: values[SHIP_MOTION.ANGLE - 1],
      turnActivity: values[SHIP_MOTION.TURN_ACTIVITY - 1],
      targetX: values[SHIP_MOTION.TARGET_X - 1],
      targetY: values[SHIP_MOTION.TARGET_Y - 1]
    };
  }

  return Object.freeze({
    ENTITY_DELTA_FORMAT_VERSION,
    SHIP_MOTION,
    SHIP_MOTION_STRIDE: SHIP_MOTION.STRIDE,
    SHIP_STATE_FIELDS,
    SHIP_STATE_SIGNATURE_FIELDS,
    PRIVATE_SHIP_FIELDS,
    GENERIC_MOTION_FIELDS,
    cleanNumber,
    packShipMotion,
    unpackShipMotion
  });
}));
