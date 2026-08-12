"use strict";

// Client turret math is renderer-neutral in the modular frontend. Exercise the
// authoritative-angle/fallback/warning contract directly instead of loading the
// retired public/client.js bundle in a VM.
const assert = require("assert/strict");
const fs = require("fs");

globalThis.document = { getElementById() { return null; } };

(async () => {
  await import("../public/src/shared/turretRules.js");
  const {
    authoritativeWeaponAngle,
    defaultWeaponRelativeAngle,
    getWeaponTurnRate,
    isRotatingWeaponPart,
    resetMissingWeaponAngleWarnings,
    rotatingWeaponIndices,
    weaponRelativeToWorld
  } = await import("../public/src/game/weaponAim.js");

  const design = [
    { type: "core", rotation: 0 },
    { type: "blaster", rotation: 90 },
    { type: "railgun", rotation: 180 },
    { type: "engine", rotation: 0 }
  ];
  assert.deepStrictEqual(rotatingWeaponIndices(design), [1, 2], "design indexes stay aligned with server weaponAngles");
  assert.equal(isRotatingWeaponPart("blaster"), true);
  assert.equal(isRotatingWeaponPart("engine"), false);

  const live = { id: "live", design, weaponAngles: [0, 0.42, -0.75] };
  assert.equal(authoritativeWeaponAngle(live, 1), 0.42, "live rendering uses the server angle");
  assert(Math.abs(weaponRelativeToWorld(0.5, 0.42) - 0.92) < 1e-12);

  resetMissingWeaponAngleWarnings();
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const stale = { id: "stale", design, weaponAngles: [] };
    const fallback = authoritativeWeaponAngle(stale, 1);
    assert.equal(fallback, defaultWeaponRelativeAngle(design[1]), "a missing angle falls back to blueprint orientation");
    authoritativeWeaponAngle(stale, 1);
  } finally {
    console.warn = previousWarn;
  }
  assert.equal(warnings.length, 1, "missing-authoritative-angle diagnostics deduplicate by ship and design index");
  assert.match(warnings[0], /shipId=stale designIndex=1 partType=blaster/);

  const familyRate = globalThis.TurretRules.turnRateFor("blaster");
  assert.equal(getWeaponTurnRate("blaster"), familyRate, "renderer traverse uses the shared turret rule");
  assert(familyRate > 0);

  const shipsSource = fs.readFileSync("public/src/game/pixi/pixiShips.js", "utf8");
  assert.match(shipsSource, /authoritativeWeaponAngle/, "production Pixi ship views consume authoritative weapon angles");
  const buildSources = fs.readFileSync("public/src/constants.js", "utf8") + fs.readFileSync("public/src/messages.js", "utf8");
  assert.match(buildSources, /__mfaServerBuild/);
  assert.match(buildSources, /__mfaFrontendBuild/, "build identities remain available to turret mismatch diagnostics");

  console.log("Turret client module-boundary verification passed");
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
