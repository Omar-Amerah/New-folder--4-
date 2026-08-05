import assert from "assert";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

// Mock minimal browser globals for rules importing if needed
if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
}
if (typeof globalThis.document === "undefined") {
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
}

const sharedDir = path.join(process.cwd(), "public", "src", "shared");
const designDir = path.join(process.cwd(), "public", "src", "design");

await import(pathToFileURL(path.join(sharedDir, "dataSupportRules.js")).href);
await import(pathToFileURL(path.join(sharedDir, "powerPolicyRules.js")).href);
await import(pathToFileURL(path.join(sharedDir, "powerDemandRules.js")).href);
await import(pathToFileURL(path.join(sharedDir, "powerAllocationRules.js")).href);
await import(pathToFileURL(path.join(sharedDir, "wiringRules.js")).href);
await import(pathToFileURL(path.join(sharedDir, "powerFlowRules.js")).href);
const { default: PowerDiagnostics } = await import(pathToFileURL(path.join(sharedDir, "powerDiagnostics.js")).href);
globalThis.PowerDiagnostics = PowerDiagnostics;
const { WIRING_INFRASTRUCTURE } = await import(pathToFileURL(path.join(process.cwd(), "public", "src", "constants.js")).href);
const { resolvePowerSummary } = await import(pathToFileURL(path.join(designDir, "shipSummaryModel.js")).href);
const { PART_STATS } = await import(pathToFileURL(path.join(designDir, "parts.js")).href);
const { solveBlueprintPower } = await import(pathToFileURL(path.join(designDir, "powerAllocationAnalysis.js")).href);

const PowerFlowRules = globalThis.PowerFlowRules;
const WiringRules = globalThis.WiringRules;

console.log("Running Power Shortage Diagnostics & Cable Tier Regression Tests...\n");

// Helper to construct a test catalogue
const TEST_CATALOGUE = {
  ...PART_STATS,
  frame: { name: "Frame", mass: 1, cost: 5, footprint: { width: 1, height: 1 } },
  reactor: { name: "Reactor", powerGeneration: 10, mass: 10, cost: 100, footprint: { width: 1, height: 1 } },
  auxGenerator: { name: "Aux Generator", powerGeneration: 2.5, mass: 5, cost: 50, footprint: { width: 1, height: 1 } },
  shield: { name: "Shield Generator", powerUse: 5.0, powerCategory: "shields", mass: 10, cost: 100, footprint: { width: 1, height: 1 } },
  signalAmplifier: { name: "Signal Amplifier", powerUse: 1.2, powerCategory: "coolingSupport", mass: 2, cost: 30, footprint: { width: 1, height: 1 } },
  heavyLaser: { name: "Heavy Laser", powerUse: 4.0, powerCategory: "weapons", mass: 8, cost: 80, footprint: { width: 1, height: 1 } }
};

// ---------------------------------------------------------------------------
// Test 1: Connected low-priority Signal Amplifier load-shed while shields remain powered
// ---------------------------------------------------------------------------
{
  const design = [
    { type: "auxGenerator", x: 1, y: 1 },       // 2.5 MW gen (Aux Generator)
    { type: "shield", x: 1, y: 2 },       // 5.0 MW demand (shields)
    { type: "signalAmplifier", x: 1, y: 3 }   // 1.2 MW demand (cooling & support)
  ];
  let wiring = WiringRules.emptyWiring();
  // Route connecting all 3 components with Heavy Bus cable (no bottleneck)
  wiring = WiringRules.addPathWithTier(wiring, "power", [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }], design, TEST_CATALOGUE, "heavy");

  const flow = solveBlueprintPower(design, wiring, TEST_CATALOGUE, WIRING_INFRASTRUCTURE);

  const shieldEntry = flow.byComponentIndex.find(c => c.componentIndex === 1);
  const sensorEntry = flow.byComponentIndex.find(c => c.componentIndex === 2);
  const net = flow.networks[0];

  const shieldDiag = PowerDiagnostics.classifyPowerDeliveryIssue({ componentEntry: shieldEntry, network: net, flow });
  const sensorDiag = PowerDiagnostics.classifyPowerDeliveryIssue({ componentEntry: sensorEntry, network: net, flow });

  assert.strictEqual(shieldEntry.allocatedMw, 2.5, "Shield receives remaining 2.5 MW");
  assert.strictEqual(sensorEntry.allocatedMw, 0, "Signal Amplifier shed due to priority policy");

  assert.strictEqual(sensorDiag.consequence, "priority-load-shed", "Signal Amplifier consequence is priority load shed");
  assert(sensorDiag.consequenceMessage.includes("shed by the Balanced Power policy"), "Consequence message mentions Balanced policy");

  console.log("✓ Test 1 Passed: Connected low-priority Signal Amplifier load-shed while shields remain powered");
}

// ---------------------------------------------------------------------------
// Test 2: Genuine generation shortage vs Cable bottleneck vs Isolated generator
// ---------------------------------------------------------------------------
{
  // 2a: Genuine generation shortage
  const designGenShort = [
    { type: "auxGenerator", x: 1, y: 1 }, // 2.5 MW gen
    { type: "frame", x: 1, y: 2 },
    { type: "frame", x: 1, y: 3 },
    { type: "heavyLaser", x: 1, y: 4 }   // 4.0 MW demand (exceeds 2.5 MW gen)
  ];
  let wiringGenShort = WiringRules.emptyWiring();
  wiringGenShort = WiringRules.addPathWithTier(wiringGenShort, "power", [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }, { x: 1, y: 4 }], designGenShort, TEST_CATALOGUE, "heavy");

  const flowGenShort = solveBlueprintPower(designGenShort, wiringGenShort, TEST_CATALOGUE, WIRING_INFRASTRUCTURE);

  const sensorEntryGen = flowGenShort.byComponentIndex.find(c => c.componentIndex === 3);
  const netGen = flowGenShort.networks[0];
  const diagGen = PowerDiagnostics.classifyPowerDeliveryIssue({ componentEntry: sensorEntryGen, network: netGen, flow: flowGenShort });

  assert.strictEqual(diagGen.cause, "generation-shortage", "Root cause is generation shortage");
  assert(diagGen.causeMessage.includes("needs 1.5 MW more generation"), "Cause message specifies 1.5 MW more generation needed");

  // 2b: Genuine cable bottleneck
  // Gen = 10 MW (Reactor), demand = 5 MW (Shield), connected by Light cable (sustained 4 MW, peak 7 MW)
  const designBneck = [
    { type: "reactor", x: 1, y: 1 },    // 10 MW gen (occupies 1..2, 1..2)
    { type: "frame", x: 1, y: 2 },
    { type: "frame", x: 1, y: 3 },
    { type: "heavyLaser", x: 1, y: 4 }, // 4 MW demand (occupies 1..2, 4..5)
    { type: "frame", x: 1, y: 5 },
    { type: "frame", x: 1, y: 6 },
    { type: "heavyLaser", x: 1, y: 7 }  // 4 MW demand (occupies 1..2, 7..8)
  ];
  let wiringBneck = WiringRules.emptyWiring();
  wiringBneck = WiringRules.addPathWithTier(wiringBneck, "power", [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }, { x: 1, y: 4 }, { x: 1, y: 5 }, { x: 1, y: 6 }, { x: 1, y: 7 }], designBneck, TEST_CATALOGUE, "light");

  const flowBneck = solveBlueprintPower(designBneck, wiringBneck, TEST_CATALOGUE, WIRING_INFRASTRUCTURE);

  const laserEntry = flowBneck.byComponentIndex.find(c => c.componentIndex === 3);
  const netBneck = flowBneck.networks[0];
  const diagBneck = PowerDiagnostics.classifyPowerDeliveryIssue({ componentEntry: laserEntry, network: netBneck, flow: flowBneck });

  assert.strictEqual(diagBneck.cause, "cable-bottleneck", "Root cause is cable bottleneck when network gen >= demand but route limits flow");

  // 2c: Isolated generator becoming reachable after adding a cable
  const designIso = [
    { type: "reactor", x: 1, y: 1 },      // 10 MW gen (isolated on net 1)
    { type: "auxGenerator", x: 5, y: 1 }, // 2.5 MW gen (isolated on net 2)
    { type: "frame", x: 5, y: 2 },
    { type: "frame", x: 5, y: 3 },
    { type: "heavyLaser", x: 5, y: 4 }   // 4.0 MW demand (isolated on net 2)
  ];
  let wiringIso = WiringRules.emptyWiring();
  // Connect auxGenerator (0.5 MW) to signalAmplifier (1.2 MW)
  wiringIso = WiringRules.addPathWithTier(wiringIso, "power", [{ x: 5, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }, { x: 5, y: 4 }], designIso, TEST_CATALOGUE, "heavy");

  const flowIso = solveBlueprintPower(designIso, wiringIso, TEST_CATALOGUE, WIRING_INFRASTRUCTURE);

  const sensorEntryIso = flowIso.byComponentIndex.find(c => c.componentIndex === 4);
  const netIso = flowIso.networks.find(n => n.consumerIndices.includes(4));
  const diagIso = PowerDiagnostics.classifyPowerDeliveryIssue({ componentEntry: sensorEntryIso, network: netIso, flow: flowIso });

  assert.strictEqual(diagIso.cause, "isolated-generator", "Identifies isolated generator elsewhere on ship");
  assert(diagIso.causeMessage.includes("exists elsewhere on the ship but is not connected"), "Explains isolated generator");

  console.log("✓ Test 2 Passed: Genuine generation shortage vs Cable bottleneck vs Isolated generator");
}

// ---------------------------------------------------------------------------
// Test 3: Hover text and Ship Summary use the same authoritative cause
// ---------------------------------------------------------------------------
{
  const design = [
    { type: "auxGenerator", x: 1, y: 1 }, // 2.5 MW gen
    { type: "frame", x: 1, y: 2 },
    { type: "frame", x: 1, y: 3 },
    { type: "heavyLaser", x: 1, y: 4 }   // 4.0 MW demand (exceeds 2.5 MW gen)
  ];
  let wiring = WiringRules.emptyWiring();
  wiring = WiringRules.addPathWithTier(wiring, "power", [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }, { x: 1, y: 4 }], design, TEST_CATALOGUE, "heavy");

  const flow = solveBlueprintPower(design, wiring, TEST_CATALOGUE, WIRING_INFRASTRUCTURE);

  const stats = { powerGeneration: 2.5, powerUse: 4.0, maxShield: 100 };
  const summary = resolvePowerSummary(stats, flow);
  const shipDiag = PowerDiagnostics.classifyShipPowerSummary(flow, stats);
  const componentEntry = flow.byComponentIndex.find(c => c.componentIndex === 3);
  const compDiag = PowerDiagnostics.classifyPowerDeliveryIssue({ componentEntry, network: flow.networks[0], flow });

  assert.strictEqual(shipDiag.cause, "generation-shortage", "Ship summary cause is generation-shortage");
  assert.strictEqual(compDiag.cause, "generation-shortage", "Component hover cause is generation-shortage");
  assert.strictEqual(summary.shortfall, true, "Ship summary reports shortfall");
  // A generation shortage is stated as a deficit, never as a negative surplus
  // and never as a bare "short" that could be mistaken for spare Power.
  assert.strictEqual(summary.overviewText, "1.5 MW generation deficit", "Ship summary overview states the generation deficit");
  assert.strictEqual(summary.generationDeficit, true, "Ship summary flags the deficit as a generation shortage");

  console.log("✓ Test 3 Passed: Hover text and Ship Summary use the same authoritative cause");
}

// ---------------------------------------------------------------------------
// Test 4: No case reporting 'spare Power' while required demand remains undelivered
// ---------------------------------------------------------------------------
{
  const design = [
    { type: "auxGenerator", x: 1, y: 1 }, // 2.5 MW gen
    { type: "heavyLaser", x: 1, y: 4 }   // 4.0 MW demand
  ];
  let wiring = WiringRules.emptyWiring(); // Disconnected
  const flow = solveBlueprintPower(design, wiring, TEST_CATALOGUE, WIRING_INFRASTRUCTURE);

  const stats = { powerGeneration: 2.5, powerUse: 4.0 };
  const summary = resolvePowerSummary(stats, flow);

  assert.strictEqual(summary.shortfall, true, "Unmet demand is flagged as shortfall");
  assert(!summary.statusMessageText.includes("Fully powered"), "Never reports Fully powered when required demand is unpowered");

  console.log("✓ Test 4 Passed: No case reporting 'spare Power' while demand remains undelivered");
}

// ---------------------------------------------------------------------------
// Test 5: Existing Light, Standard, and Heavy sections retain tier stroke class
// ---------------------------------------------------------------------------
{
  let wiring = WiringRules.emptyWiring();
  const design = [
    { type: "frame", x: 1, y: 1 }, { type: "frame", x: 1, y: 2 },
    { type: "frame", x: 2, y: 1 }, { type: "frame", x: 2, y: 2 },
    { type: "frame", x: 3, y: 1 }, { type: "frame", x: 3, y: 2 },
    { type: "frame", x: 4, y: 1 }, { type: "frame", x: 4, y: 2 }
  ];

  wiring = WiringRules.addPathWithTier(wiring, "power", [{ x: 1, y: 1 }, { x: 1, y: 2 }], design, TEST_CATALOGUE, "light");
  wiring = WiringRules.addPathWithTier(wiring, "power", [{ x: 2, y: 1 }, { x: 2, y: 2 }], design, TEST_CATALOGUE, "standard");
  wiring = WiringRules.addPathWithTier(wiring, "power", [{ x: 3, y: 1 }, { x: 3, y: 2 }], design, TEST_CATALOGUE, "heavy");

  const lightSec = wiring.power.sections.find(s => s.x1 === 1 && s.y1 === 1 && s.x2 === 1 && s.y2 === 2);
  const stdSec = wiring.power.sections.find(s => s.x1 === 2 && s.y1 === 1 && s.x2 === 2 && s.y2 === 2);
  const heavySec = wiring.power.sections.find(s => s.x1 === 3 && s.y1 === 1 && s.x2 === 3 && s.y2 === 2);

  assert.strictEqual(lightSec.tier, "light", "Light section retains light tier");
  assert.strictEqual(stdSec.tier, "standard", "Standard section retains standard tier");
  assert.strictEqual(heavySec.tier, "heavy", "Heavy section retains heavy tier");

  // Add a new route elsewhere with heavy tier
  const wiring2 = WiringRules.addPathWithTier(wiring, "power", [{ x: 4, y: 1 }, { x: 4, y: 2 }], design, TEST_CATALOGUE, "heavy");

  const lightSec2 = wiring2.power.sections.find(s => s.x1 === 1 && s.y1 === 1);
  const stdSec2 = wiring2.power.sections.find(s => s.x1 === 2 && s.y1 === 1);
  assert.strictEqual(lightSec2.tier, "light", "Adding unrelated route preserves light tier");
  assert.strictEqual(stdSec2.tier, "standard", "Adding unrelated route preserves standard tier");

  // Explicit tier upgrade
  const upgraded = WiringRules.setSectionTier(wiring2, "power", WiringRules.segmentKey(lightSec2), "heavy", design, TEST_CATALOGUE);
  assert.strictEqual(upgraded.changed, true, "Explicit upgrade changes tier");
  const upgradedSec = upgraded.wiring.power.sections.find(s => s.x1 === 1 && s.y1 === 1);
  assert.strictEqual(upgradedSec.tier, "heavy", "Section tier updated to heavy");

  console.log("✓ Test 5 Passed: Existing Light, Standard, and Heavy sections retain tier stroke class");
}

console.log("\nAll Power Shortage Diagnostics & Cable Tier Regression Tests Passed Successfully!");

console.log("\nALL POWER SHORTAGE DIAGNOSTICS & CABLE TIER REGRESSION TESTS PASSED!");
