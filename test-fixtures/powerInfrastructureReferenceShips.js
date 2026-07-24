"use strict";

// Section 7H — authoritative Power-infrastructure reference ship fixtures.
//
// Deterministic reusable Blueprints for the four intended architecture
// families (central heavy bus, distributed grids, ring bus, hybrid grids with
// Switchgear ties) plus the light interceptor, conventional frigate and cheap
// vulnerable bus baselines. Every fixture is validated at construction: it
// must be a buildable design (validateDesign), its wiring must already be in
// canonical normalised form (normalisation idempotence) and its intended
// baseline Power expectations must hold. Damage variants are runtime
// descriptors only — no runtime damage or overload state is persisted in any
// Blueprint fixture.

const assert = require("assert");
const WiringRules = require("../public/src/shared/wiringRules");
const PowerPolicyRules = require("../public/src/shared/powerPolicyRules");
const { PARTS } = require("../src/server/components");
const { validateDesign } = require("../src/server/shipDesign");

const clone = (value) => JSON.parse(JSON.stringify(value));

function moduleAt(type, x, y, extra = {}) {
  if (!PARTS[type]) throw new Error(`Unknown component type: ${type}`);
  return { type, x, y, rotation: 0, ...extra };
}

function section(a, b, tier) {
  const hosted = new Set([`${a[0]},${a[1]}`, `${b[0]},${b[1]}`]);
  const normalized = WiringRules.normalizeSection({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], tier }, hosted);
  return {
    id: WiringRules.sectionIdFromCells({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }),
    x1: normalized.x1, y1: normalized.y1, x2: normalized.x2, y2: normalized.y2, tier
  };
}

function pathSections(cells, tier) {
  const out = [];
  for (let i = 1; i < cells.length; i += 1) out.push(section(cells[i - 1], cells[i], tier));
  return out;
}

function sortSections(sections) {
  return sections.slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

function makeWiring(powerSections, dataSections = []) {
  return {
    version: WiringRules.WIRING_VERSION,
    power: { sections: sortSections(powerSections), connections: [] },
    data: { sections: sortSections(dataSections), connections: [] },
    powerPolicy: PowerPolicyRules.defaultPolicy()
  };
}

function componentIndexAt(design, x, y) {
  const index = design.findIndex((module) => module.x === x && module.y === y);
  assert(index >= 0, `no component anchored at ${x},${y}`);
  return index;
}

function nominalDemand(design) {
  return design.reduce((sum, module) => sum + (Number(PARTS[module.type].powerUse) || 0), 0);
}
function installedGeneration(design) {
  return design.reduce((sum, module) => sum + (Number(PARTS[module.type].powerGeneration) || 0), 0);
}
function switchgearComponentCost(design) {
  return design.reduce((sum, module) => sum + (module.type === "switchgear" ? (Number(PARTS.switchgear.cost) || 0) : 0), 0);
}

function validateReferenceFixture(fixture) {
  const validation = validateDesign(fixture.design);
  assert(validation.ok, `${fixture.name} must be a valid buildable design: ${validation.reason || "ok"}`);
  const renormalized = WiringRules.normalizeWiring(fixture.wiring, fixture.design, PARTS);
  assert.deepStrictEqual(renormalized.wiring, fixture.wiring, `${fixture.name} wiring normalises idempotently`);
  assert.strictEqual(renormalized.droppedSegments, 0, `${fixture.name} has no invalid wiring segments`);
  for (const kind of ["power", "data"]) {
    const seen = new Set();
    for (const s of fixture.wiring[kind].sections) {
      const canonical = WiringRules.sectionIdFromCells({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
      assert.strictEqual(s.id, canonical, `${fixture.name} ${kind} section id canonical: ${s.id}`);
      assert(!seen.has(canonical), `${fixture.name} duplicate ${kind} section ${canonical}`);
      seen.add(canonical);
    }
  }
  // Runtime damage/overload state must never be persisted in a fixture.
  const persisted = JSON.stringify(fixture.design) + JSON.stringify(fixture.wiring);
  for (const token of ["stress", "cooldown", "retryCount", "tripped", "componentHp"]) {
    assert(!persisted.includes(token), `${fixture.name} Blueprint contains runtime token ${token}`);
  }
  for (const variant of fixture.damageVariants || []) {
    for (const [x, y] of variant.cells) componentIndexAt(fixture.design, x, y); // must resolve
  }
  return fixture;
}

function make(fixture) {
  fixture.expected = {
    ...fixture.expected,
    installedGenerationMw: installedGeneration(fixture.design),
    nominalDemandMw: nominalDemand(fixture.design),
    switchgearComponentCost: switchgearComponentCost(fixture.design)
  };
  return validateReferenceFixture(fixture);
}

// ---------------------------------------------------------------------------
// A. Light interceptor — small hull, short Light routes, no redundancy.
// ---------------------------------------------------------------------------
function lightInterceptor() {
  const design = [
    moduleAt("core", 0, 0),
    moduleAt("auxGenerator", 1, 0),
    moduleAt("engine", 2, 0),
    moduleAt("blaster", 3, 0)
  ];
  const wiring = makeWiring(pathSections([[0, 0], [1, 0], [2, 0], [3, 0]], "light"));
  return make({
    key: "interceptor",
    name: "Reference A — Light interceptor",
    architecture: "light-branch",
    design, wiring,
    expected: { powerNetworkCount: 1, alternatePaths: 0, fullyPoweredAtBaseline: true },
    damageVariants: [
      { key: "generator-destroyed", role: "generator", cells: [[1, 0]], description: "auxiliary generator destroyed" }
    ]
  });
}

// ---------------------------------------------------------------------------
// B. Standard general-purpose frigate — conventional Standard trunk with
// Light final branches; the 5–10% infrastructure-cost reference design.
// ---------------------------------------------------------------------------
function standardFrigate() {
  const design = [
    moduleAt("reactor", 0, 1),
    moduleAt("frame", 2, 1),
    moduleAt("frame", 3, 1),
    moduleAt("frame", 4, 1),
    moduleAt("frame", 5, 1),
    moduleAt("frame", 6, 1),
    moduleAt("core", 7, 1),
    moduleAt("frame", 8, 1),
    moduleAt("engine", 4, 2),
    moduleAt("frame", 5, 0),
    moduleAt("shield", 6, 0),
    moduleAt("radiator", 6, 2),
    moduleAt("pointDefense", 7, 0),
    moduleAt("blaster", 8, 0)
  ];
  const wiring = makeWiring(
    [
      ...pathSections([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1]], "standard"),
      section([4, 1], [4, 2], "light"),
      section([5, 1], [5, 0], "light"),
      section([6, 1], [6, 0], "standard"),
      section([6, 1], [6, 2], "light"),
      section([7, 1], [7, 0], "standard"),
      section([8, 1], [8, 0], "light")
    ],
    pathSections([[5, 0], [6, 0], [7, 0], [8, 0]], "standard")
  );
  return make({
    key: "frigate",
    name: "Reference B — Standard general-purpose frigate",
    architecture: "central-standard-bus",
    design, wiring,
    expected: { powerNetworkCount: 1, alternatePaths: 0, fullyPoweredAtBaseline: true },
    damageVariants: [
      { key: "trunk-host-destroyed", role: "trunk-host", cells: [[3, 1]], description: "central trunk frame destroyed" },
      { key: "branch-host-destroyed", role: "branch-host", cells: [[8, 0]], description: "blaster branch destroyed" },
      { key: "generator-destroyed", role: "generator", cells: [[0, 1]], description: "reactor destroyed" }
    ]
  });
}

// ---------------------------------------------------------------------------
// C. Heavy combat ship — Heavy trunk from a reactor bank into Standard and
// Light final branches; high simultaneous demand.
// ---------------------------------------------------------------------------
function heavyCombat() {
  const design = [
    moduleAt("reactor", 0, 1),
    moduleAt("reactor", 0, 2),
    moduleAt("auxGenerator", 2, 2),
    moduleAt("frame", 2, 1),
    moduleAt("frame", 3, 1),
    moduleAt("frame", 4, 1),
    moduleAt("frame", 5, 1),
    moduleAt("frame", 6, 1),
    moduleAt("frame", 7, 1),
    moduleAt("core", 8, 1),
    moduleAt("engine", 3, 2),
    moduleAt("shield", 4, 0),
    moduleAt("shield", 5, 0),
    moduleAt("blaster", 6, 0),
    moduleAt("blaster", 7, 0),
    moduleAt("pointDefense", 8, 0),
    moduleAt("railgun", 9, 1)
  ];
  const wiring = makeWiring([
    section([1, 2], [1, 1], "heavy"),
    section([2, 2], [2, 1], "standard"),
    ...pathSections([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1]], "heavy"),
    section([8, 1], [9, 1], "standard"),
    section([3, 1], [3, 2], "light"),
    section([4, 1], [4, 0], "standard"),
    section([5, 1], [5, 0], "standard"),
    section([6, 1], [6, 0], "light"),
    section([7, 1], [7, 0], "light"),
    section([8, 1], [8, 0], "standard")
  ]);
  return make({
    key: "heavyCombat",
    name: "Reference C — Heavy combat ship",
    architecture: "central-heavy-bus",
    design, wiring,
    expected: { powerNetworkCount: 1, alternatePaths: 0, fullyPoweredAtBaseline: true },
    damageVariants: [
      { key: "trunk-host-destroyed", role: "trunk-host", cells: [[4, 1]], description: "heavy trunk frame destroyed" },
      { key: "branch-host-destroyed", role: "branch-host", cells: [[6, 0]], description: "one blaster branch destroyed" },
      { key: "generator-destroyed", role: "generator", cells: [[0, 1]], description: "one reactor destroyed" }
    ]
  });
}

// ---------------------------------------------------------------------------
// D. Distributed-grid ship — two independent generator/load islands with
// short local routes and no central trunk (structure joined by unwired
// frames). Generation is deliberately duplicated per island.
// ---------------------------------------------------------------------------
function distributedGrid() {
  const design = [
    moduleAt("core", 0, 0),
    moduleAt("auxGenerator", 1, 0),
    moduleAt("auxGenerator", 1, 1),
    moduleAt("engine", 2, 0),
    moduleAt("blaster", 3, 0),
    moduleAt("frame", 4, 0),
    moduleAt("frame", 5, 0),
    moduleAt("reactor", 6, 0),
    moduleAt("auxGenerator", 6, 1),
    moduleAt("shield", 8, 0),
    moduleAt("pointDefense", 9, 0)
  ];
  const wiring = makeWiring([
    ...pathSections([[0, 0], [1, 0], [2, 0], [3, 0]], "light"),
    section([1, 1], [1, 0], "light"),
    ...pathSections([[6, 0], [7, 0], [8, 0], [9, 0]], "standard"),
    section([6, 1], [6, 0], "standard")
  ]);
  return make({
    key: "distributed",
    name: "Reference D — Distributed-grid ship",
    architecture: "distributed-grids",
    design, wiring,
    expected: { powerNetworkCount: 2, alternatePaths: 0, fullyPoweredAtBaseline: true },
    damageVariants: [
      { key: "island-generator-destroyed", role: "generator", cells: [[6, 0]], description: "second-island reactor destroyed" },
      { key: "island-host-destroyed", role: "branch-host", cells: [[8, 0]], description: "second-island shield destroyed" }
    ]
  });
}

// ---------------------------------------------------------------------------
// E. Ring-bus ship — same loadout class as the frigate, wired as a full
// Standard ring so one broken host still leaves an alternate route.
// ---------------------------------------------------------------------------
function ringBus() {
  const design = [
    moduleAt("reactor", 0, 0),
    moduleAt("frame", 2, 0),
    moduleAt("shield", 3, 0),
    moduleAt("pointDefense", 4, 0),
    moduleAt("blaster", 5, 0),
    moduleAt("frame", 5, 1),
    moduleAt("radiator", 5, 2),
    moduleAt("frame", 4, 2),
    moduleAt("frame", 3, 2),
    moduleAt("engine", 2, 2),
    moduleAt("frame", 1, 2),
    moduleAt("frame", 0, 2),
    moduleAt("core", 0, 1)
  ];
  const ringCells = [
    [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0],
    [5, 1], [5, 2], [4, 2], [3, 2], [2, 2], [1, 2], [0, 2], [0, 1], [0, 0]
  ];
  const wiring = makeWiring(
    pathSections(ringCells, "heavy"),
    pathSections([[5, 2], [5, 1], [5, 0]], "standard")
  );
  return make({
    key: "ring",
    name: "Reference E — Ring-bus ship",
    architecture: "ring-bus",
    design, wiring,
    expected: { powerNetworkCount: 1, alternatePaths: 1, fullyPoweredAtBaseline: true },
    damageVariants: [
      { key: "ring-host-destroyed", role: "ring-host", cells: [[2, 0]], description: "one ring frame destroyed (alternate path survives)" },
      { key: "ring-split", role: "ring-host", cells: [[2, 0], [3, 2]], description: "two strategic ring frames destroyed — splits the ring" }
    ]
  });
}

// ---------------------------------------------------------------------------
// F. Hybrid Switchgear ship — two local grids joined by an Automatic
// Standard bus tie, plus a manual Closed Light Switchgear protecting the
// engine branch. Grid A holds the spare generation; grid B runs a deficit
// that only a priority-safe Automatic transfer can cover.
// ---------------------------------------------------------------------------
function hybridSwitchgear() {
  const design = [
    moduleAt("reactor", 0, 0),
    moduleAt("core", 2, 0),
    moduleAt("blaster", 3, 0),
    moduleAt("switchgear", 4, 0, { switchgearMode: "automatic", switchgearRatingTier: "standard" }),
    moduleAt("auxGenerator", 6, 0),
    moduleAt("shield", 7, 0),
    moduleAt("pointDefense", 8, 0),
    moduleAt("switchgear", 2, 1, { rotation: 90, switchgearMode: "closed", switchgearRatingTier: "light" }),
    moduleAt("engine", 2, 3)
  ];
  const wiring = makeWiring([
    ...pathSections([[1, 0], [2, 0], [3, 0], [4, 0]], "standard"),
    ...pathSections([[5, 0], [6, 0], [7, 0], [8, 0]], "standard"),
    section([2, 0], [2, 1], "light"),
    section([2, 2], [2, 3], "light")
  ]);
  return make({
    key: "hybrid",
    name: "Reference F — Hybrid Switchgear ship",
    architecture: "hybrid-switchgear",
    design, wiring,
    // Two physical grids; the conducting Automatic tie merges them into one
    // runtime Power network at baseline.
    expected: { powerNetworkCount: 1, isolatedGridCount: 2, alternatePaths: 0, fullyPoweredAtBaseline: true },
    damageVariants: [
      { key: "tie-switchgear-destroyed", role: "switchgear", cells: [[4, 0]], description: "Automatic bus-tie Switchgear destroyed" },
      { key: "donor-generator-destroyed", role: "generator", cells: [[0, 0]], description: "donor-grid reactor destroyed" }
    ]
  });
}

// ---------------------------------------------------------------------------
// G. Cheap vulnerable bus — minimum-cost single Light trunk through one
// frame host whose destruction severs every downstream consumer.
// ---------------------------------------------------------------------------
function cheapBus() {
  const design = [
    moduleAt("core", 0, 0),
    moduleAt("auxGenerator", 1, 0),
    moduleAt("frame", 2, 0),
    moduleAt("engine", 3, 0),
    moduleAt("blaster", 4, 0)
  ];
  const wiring = makeWiring(pathSections([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]], "light"));
  return make({
    key: "cheapBus",
    name: "Reference G — Cheap vulnerable bus",
    architecture: "cheap-bus",
    design, wiring,
    expected: { powerNetworkCount: 1, alternatePaths: 0, fullyPoweredAtBaseline: true },
    damageVariants: [
      { key: "trunk-host-destroyed", role: "trunk-host", cells: [[2, 0]], description: "single trunk frame destroyed (severs engine and blaster)" }
    ]
  });
}

function allReferenceShips() {
  return [lightInterceptor(), standardFrigate(), heavyCombat(), distributedGrid(), ringBus(), hybridSwitchgear(), cheapBus()].map(clone);
}

// Deterministic reversed-order equivalent of a fixture: the design array is
// reversed (a correct remapping — wiring references coordinates, never
// component indices), so all physical behaviour must be identical.
function reorderedFixture(fixture) {
  const copy = clone(fixture);
  copy.design = copy.design.slice().reverse();
  return copy;
}

// Re-tier every Power section of a fixture (analysis-only variant used to
// compare tier economics; never a persisted Blueprint change).
function withUniformPowerTier(fixture, tier) {
  const copy = clone(fixture);
  copy.key = `${fixture.key}-${tier}-everywhere`;
  copy.wiring.power.sections = copy.wiring.power.sections.map((s) => ({ ...s, tier }));
  copy.wiring = WiringRules.normalizeWiring(copy.wiring, copy.design, PARTS).wiring;
  return copy;
}

module.exports = {
  lightInterceptor,
  standardFrigate,
  heavyCombat,
  distributedGrid,
  ringBus,
  hybridSwitchgear,
  cheapBus,
  allReferenceShips,
  reorderedFixture,
  withUniformPowerTier,
  componentIndexAt,
  validateReferenceFixture,
  cloneReferenceFixture: clone
};
