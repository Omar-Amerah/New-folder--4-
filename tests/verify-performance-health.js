#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createGameServer } = require("../server");

(async () => {
  const server = createGameServer({ port: 0, host: "127.0.0.1" });
  await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(response.status, 200);
    const health = await response.json();
    const performance = health.performance;
    assert.ok(performance?.subsystems, "health exposes subsystem timing telemetry");
    for (const name of [
      "botsEconomyLifecycle", "movementSeparationMap",
      "support", "drones", "weapons", "projectiles", "heat", "objectives"
    ]) {
      const summary = performance.subsystems[name];
      assert.ok(summary, `health exposes ${name}`);
      for (const field of ["p50", "p95", "max", "latest"]) assert.equal(typeof summary[field], "number");
    }
    for (const entity of ["ships", "drones", "bullets", "effects"]) {
      const summary = performance.entities[entity];
      for (const field of ["p50", "p95", "max", "latest"]) assert.equal(typeof summary[field], "number");
    }
    for (const field of ["buildMs", "constructionMs", "encodingMs"]) {
      assert.equal(typeof performance.snapshot[field].latest, "number");
    }
    console.log("Performance /health telemetry verification passed");
  } finally {
    await server.stop();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
