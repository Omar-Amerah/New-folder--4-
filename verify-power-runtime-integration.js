"use strict";

// Section 7C-3 — Authoritative Runtime Power-Flow Integration.
//
// Verifies that the server's runtime Power allocator is the shared 7C-2
// capacity-and-priority solver (PowerFlowRules.solvePowerFlow) and nothing else:
// there is no uniform per-network generation/demand multiplier and no legacy
// second pass. Covers the solver-result projection onto ship.componentPower,
// the compat + rich per-component fields, saved-policy priority routing, static
// nominal demand, damage/overheat driven reallocation, the fixed-point
// revision signature, and event-driven (never per-tick) solve invocation.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const WiringRules = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { STATE } = require("./src/server/heat");
const {
  initializeComponentPower, rebuildShipWiringState, reallocateShipPower,
  getComponentPowerMultiplier, effectiveShieldStats
} = require("./src/server/componentPower");

const at = (type, x, y) => ({ type, x, y, rotation: 0 });
function wire(design, routes, policy) {
  let wiring = WiringRules.emptyWiring();
  for (const [source, target, cells] of routes) wiring = WiringRules.addConnection(wiring, "power", source, target, cells, design, PARTS);
  if (policy) wiring.powerPolicy = policy;
  return wiring;
}
function shipFor(design, wiring) {
  const ship = { id: "integration-test", alive: true, design, wiring, stats: { ...computeStats(design) }, shield: 0 };
  initComponentState(ship);
  initializeComponentPower(ship);
  return ship;
}

let checks = 0;
function check(label, condition) {
  assert(condition, label);
  checks += 1;
}

// ---------------------------------------------------------------------------
// Ship A — ample generation. A reactor easily powers one engine.
// ---------------------------------------------------------------------------
const ampleDesign = [at("reactor", 0, 0), at("engine", 1, 0), at("frame", 2, 0)];
const ample = shipFor(ampleDesign, wire(ampleDesign, [[0, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }]]]));

check("runtime stores the shared solver result on ship.powerFlow",
  ample.powerFlow && Array.isArray(ample.powerFlow.byComponentIndex) && Array.isArray(ample.powerFlow.networks) && Array.isArray(ample.powerFlow.sectionFlows));
check("ship.powerAnalysis is the same solver result reference as ship.powerFlow",
  ample.powerAnalysis === ample.powerFlow);
check("runtimeWiring.powerNetworks is the solver's networks array",
  ample.runtimeWiring.powerNetworks === ample.powerFlow.networks);

const engine = ample.componentPower.byComponentIndex[1];
check("per-component entry keeps the compat fields {state, networkId, availableEfficiency, operationalMultiplier}",
  ["state", "networkId", "availableEfficiency", "operationalMultiplier"].every((k) => k in engine));
check("per-component entry keeps the rich solver fields",
  ["role", "powerCategory", "priorityBand", "networkIds", "requestedMw", "allocatedMw", "unmetMw", "generationAvailableMw", "generationUsedMw"].every((k) => k in engine));
check("networkId is networkIds[0] (or null)",
  engine.networkId === (engine.networkIds[0] ?? null) && engine.networkId != null);
check("availableEfficiency equals operationalMultiplier, clamped to 0..1",
  engine.availableEfficiency === engine.operationalMultiplier && engine.availableEfficiency >= 0 && engine.availableEfficiency <= 1);
check("ample generation fully powers the consumer (multiplier 1)",
  engine.state === "powered" && getComponentPowerMultiplier(ample, 1) === 1);
check("consumer demand is the static nominal powerUse, not activity demand",
  engine.requestedMw === PARTS.engine.powerUse);

// The old uniform per-network allocator (analyzeShipPower) must be gone.
const source = fs.readFileSync(path.join(__dirname, "src", "server", "componentPower.js"), "utf8");
check("componentPower.js allocates via the shared solver and no longer imports the legacy analyzeShipPower allocator",
  /PowerFlowRules\.solvePowerFlow/.test(source) && !/analyzeShipPower/.test(source) && !/require\(["'][.\/]*shipDesign["']\)/.test(source));

// ---------------------------------------------------------------------------
// Ship B — scarce generation, one tied Balanced band -> proportional sharing.
// ---------------------------------------------------------------------------
const scarceDesign = [at("auxGenerator", 0, 0), at("engine", 1, 0), at("gyroscope", 2, 0)];
const scarce = shipFor(scarceDesign, wire(scarceDesign, [
  [0, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }]],
  [0, 2, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]
]));
const scEngine = getComponentPowerMultiplier(scarce, 1);
const scGyro = getComponentPowerMultiplier(scarce, 2);
const scarceNet = scarce.runtimeWiring.powerNetworks[0];
check("scarce Balanced network shares a single proportional ratio, using all generation with none stranded",
  scEngine < 1 && scGyro < 1 && Math.abs(scEngine - scGyro) < 2e-3
    && Math.abs(scarceNet.usedGenerationMw - scarceNet.availableGenerationMw) < 1e-6 && scarceNet.strandedGenerationMw < 1e-6);

// ---------------------------------------------------------------------------
// Ship C — saved Power policy drives priority routing over identical physical
// wiring. Defensive starves weapons; Balanced shares proportionally.
// ---------------------------------------------------------------------------
const policyDesign = [at("auxGenerator", 0, 0), at("shield", 1, 0), at("blaster", 0, 1)];
const policyRoutes = [
  [0, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }]],
  [0, 2, [{ x: 0, y: 0 }, { x: 0, y: 1 }]]
];
const defensive = shipFor(policyDesign, wire(policyDesign, policyRoutes, { preset: "defensive" }));
const balanced = shipFor(policyDesign, wire(policyDesign, policyRoutes, { preset: "balanced" }));

check("Defensive policy powers shields ahead of weapons under scarcity",
  getComponentPowerMultiplier(defensive, 1) > 0.9 && getComponentPowerMultiplier(defensive, 2) === 0);
check("Balanced policy shares the same scarce generation proportionally across shields and weapons",
  getComponentPowerMultiplier(balanced, 1) > 0 && getComponentPowerMultiplier(balanced, 2) > 0
    && Math.abs(getComponentPowerMultiplier(balanced, 1) - getComponentPowerMultiplier(balanced, 2)) < 2e-3);
check("saved Power policy — not persisted connections — is the flow authority (same wiring, different allocation)",
  getComponentPowerMultiplier(defensive, 2) !== getComponentPowerMultiplier(balanced, 2));
check("runtime power policy is a clone of the immutable Blueprint policy",
  defensive._runtimePowerWiring.powerPolicy !== defensive.wiring.powerPolicy
    && defensive._runtimePowerWiring.powerPolicy.preset === "defensive");
// Recalc ordering: systems read the fresh per-component multiplier after solve.
const defShieldMult = getComponentPowerMultiplier(defensive, 1);
check("effective ship stats reflect the fresh solver multiplier (recalc ordering preserved)",
  Math.abs(effectiveShieldStats(defensive).capacity - PARTS.shield.shield * defShieldMult) < 1e-6);

// ---------------------------------------------------------------------------
// Ship D — damage / overheat driven reallocation, blueprint immutability,
// revision signature, and event-driven solve counting.
// ---------------------------------------------------------------------------
global.__mfaDataSupportPerf = {};
const dmgDesign = [at("reactor", 0, 0), at("auxGenerator", 2, 0), at("engine", 1, 0)];
const dmg = shipFor(dmgDesign, wire(dmgDesign, [
  [0, 2, [{ x: 0, y: 0 }, { x: 1, y: 0 }]],
  [1, 2, [{ x: 2, y: 0 }, { x: 1, y: 0 }]]
]));
const blueprintJson = JSON.stringify(dmg.wiring);
check("initialization performs exactly one solver invocation",
  global.__mfaDataSupportPerf.powerFlowSolveCount === 1);

const genBefore = dmg.runtimeWiring.powerNetworks[0].availableGenerationMw;
const revisionBefore = dmg.powerRevision;
reallocateShipPower(dmg, "no-op");
check("an identical re-solve does not bump powerRevision (fixed-point signature is stable)",
  dmg.powerRevision === revisionBefore);
check("each reallocation is one event-driven solver invocation (not per-tick)",
  global.__mfaDataSupportPerf.powerFlowSolveCount === 2);

// Destroy the reactor: its live generation drops to zero and the network loses
// that contribution. This is a meaningful change, so the revision advances.
dmg.componentHp[0] = 0;
reallocateShipPower(dmg, "source-destroyed");
check("destroying a source removes its generation from the network",
  dmg.runtimeWiring.powerNetworks[0].availableGenerationMw < genBefore);
check("a meaningful allocation change bumps powerRevision and marks power dirty",
  dmg.powerRevision > revisionBefore && dmg.dirtyPower === true);
check("a destroyed component reports multiplier 0 and destroyed role/state",
  getComponentPowerMultiplier(dmg, 0) === 0 && dmg.componentPower.byComponentIndex[0].state === "destroyed");
check("runtime damage never mutates the immutable Blueprint wiring",
  JSON.stringify(dmg.wiring) === blueprintJson);

// Overheating the surviving source zeroes its generation without topology work.
dmg.componentHp[0] = dmg.componentMaxHp[0];
rebuildShipWiringState(dmg, "repair");
const genRepaired = dmg.runtimeWiring.powerNetworks[0].availableGenerationMw;
dmg.componentHeatState = dmg.design.map(() => STATE.NORMAL);
dmg.componentHeatState[1] = STATE.OVERHEATED;
reallocateShipPower(dmg, "overheat");
check("an overheated source contributes zero generation at runtime",
  dmg.runtimeWiring.powerNetworks[0].availableGenerationMw < genRepaired);

assert.strictEqual(checks, 24, `expected 24 integration checks, ran ${checks}`);
console.log(`Power runtime integration verification passed (${checks} checks).`);
