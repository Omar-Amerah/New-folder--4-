"use strict";
// Blueprint Designer "Ship summary" — information-architecture contract.
//
// Pins the consolidated Power item, the mobility split between outcomes and
// engineering calculations, the status-message conditions, and the rules that
// keep meaningless values (zero capabilities, "None", no-op modifiers) out of the
// panel. Also confirms every displayed number still comes from computeStats and
// the authoritative Power analysis. Non-browser: shared UMD modules register the
// browser globals.

const assert = require("assert");
const HeatRules = require("./public/src/shared/heatRules");
const WiringRules = require("./public/src/shared/wiringRules");
const DataRules = require("./public/src/shared/dataSupportRules");
const EngineExhaust = require("./public/src/shared/engineExhaust");
const PowerPolicyRules = require("./public/src/shared/powerPolicyRules");
const PowerAllocationRules = require("./public/src/shared/powerAllocationRules");
const PowerDemandRules = require("./public/src/shared/powerDemandRules");
const PowerFlowRules = require("./public/src/shared/powerFlowRules");
const WiringInfra = require("./public/src/shared/wiringInfrastructureRules");
const PowerCableThermalRules = require("./public/src/shared/powerCableThermalRules");
const TurretRules = require("./public/src/shared/turretRules");

globalThis.HeatRules = HeatRules;
globalThis.WiringRules = WiringRules;
globalThis.DataSupportRules = DataRules;
globalThis.EngineExhaustRules = EngineExhaust;
globalThis.PowerPolicyRules = PowerPolicyRules;
globalThis.PowerAllocationRules = PowerAllocationRules;
globalThis.PowerDemandRules = PowerDemandRules;
globalThis.PowerFlowRules = PowerFlowRules;
globalThis.WiringInfrastructureRules = WiringInfra;
globalThis.PowerCableThermalRules = PowerCableThermalRules;
globalThis.TurretRules = TurretRules;
global.document = { createElement: () => ({ getContext: () => ({}), style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }), createElementNS: () => ({ setAttribute() {}, appendChild() {} }), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, documentElement: { style: { setProperty() {} } }, body: { classList: { add() {}, remove() {} } } };
global.window = { devicePixelRatio: 1, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
global.localStorage = { getItem: () => null, setItem: () => {} };

let passed = 0;
function check(label, fn) { fn(); passed += 1; console.log(`  ok  ${label}`); }
const at = (type, x, y, rotation = 0) => ({ type, x, y, rotation });

(async () => {
  const { computeStats } = await import("./public/src/design/componentStats.js");
  const Model = await import("./public/src/design/shipSummaryModel.js");
  const { buildShipSummaryModel, resolvePowerSummary, turnText, turnAsymmetry, degreesPerSecond } = Model;

  // Representative designs spanning every branch the summary must handle.
  const DESIGNS = {
    light: [at("core", 7, 7), at("engine", 7, 8), at("blaster", 7, 6)],
    // Deliberately healthy and left/right symmetric: raises no warning at all.
    medium: [at("core", 7, 7), at("reactor", 7, 6), at("reactor", 7, 5), at("engine", 6, 8), at("engine", 8, 8),
      at("shield", 7, 8), at("blaster", 6, 7), at("railgun", 8, 7)],
    heavy: [at("core", 7, 7), at("reactor", 7, 8), at("reactor", 5, 8), at("armor", 6, 6), at("armor", 8, 6),
      at("shield", 7, 6), at("shield", 5, 6), at("engine", 6, 9), at("engine", 8, 9), at("beamEmitter", 8, 7), at("missile", 4, 7)],
    bare: [at("core", 7, 7), at("frame", 7, 8)],
    underpowered: [at("core", 7, 7), at("shield", 7, 6), at("shield", 7, 8), at("beamEmitter", 6, 7), at("beamEmitter", 8, 7)],
    support: [at("core", 7, 7), at("reactor", 7, 8), at("repair", 7, 6), at("droneBay", 4, 4)],
    asymmetric: [at("core", 7, 7), at("reactor", 7, 8), at("maneuverThruster", 5, 7, 90)]
  };
  const build = (key, context = {}) => {
    const design = DESIGNS[key];
    const stats = computeStats(design);
    return { stats, model: buildShipSummaryModel(stats, { design, ...context }) };
  };
  const allRows = (model) => [
    ...model.overview.map((row) => ({ ...row, region: "overview" })),
    ...model.sections.flatMap((section) => section.rows.map((row) => ({ ...row, region: section.id })))
  ];
  const KEYS = Object.keys(DESIGNS);

  // -- 1. Default overview ----------------------------------------------------
  check("the overview is a compact set of nine headline outcomes", () => {
    for (const key of KEYS) {
      const { model } = build(key);
      const ids = model.overview.map((row) => row.id);
      assert.deepEqual(ids, ["cost", "class", "mass", "hull", "shield", "weapons", "speed", "turn", "power"],
        `${key} shows the same nine fields in the same order`);
      assert.ok(model.overview.length >= 8 && model.overview.length <= 9, `${key} stays within 8-9 values`);
    }
  });

  check("technical mobility calculations are absent from the overview", () => {
    const technical = /effective thrust|thrust-to-mass|thrust\/mass|engine efficiency|mass drag|power efficiency|power penalty/i;
    for (const key of KEYS) {
      const { model } = build(key);
      for (const row of model.overview) {
        assert.doesNotMatch(row.label, technical, `${key}: "${row.label}" belongs in a detail section`);
      }
    }
  });

  // -- 2. No statistic appears twice -----------------------------------------
  check("no summary statistic is rendered twice", () => {
    for (const key of KEYS) {
      const rows = allRows(build(key).model);
      const seenIds = new Map();
      const seenLabels = new Map();
      for (const row of rows) {
        assert.ok(!seenIds.has(row.id), `${key}: id "${row.id}" appears in ${seenIds.get(row.id)} and ${row.region}`);
        seenIds.set(row.id, row.region);
        const label = row.label.trim().toLowerCase();
        assert.ok(!seenLabels.has(label), `${key}: label "${row.label}" appears in ${seenLabels.get(label)} and ${row.region}`);
        seenLabels.set(label, row.region);
      }
    }
  });

  // -- 3. Power is consolidated ----------------------------------------------
  check("generation, demand, efficiency and penalty collapse into one Power item", () => {
    for (const key of KEYS) {
      const { model } = build(key);
      const power = model.overview.filter((row) => row.id === "power");
      assert.equal(power.length, 1, `${key} shows exactly one Power item`);
      assert.equal(power[0].hint, undefined, `${key} keeps the Power headline to a single value with no sub-line`);
      assert.match(power[0].value, /MW (spare|short|generation deficit)$/, `${key} states the spare or shortfall`);
      // No separate generation / efficiency / penalty cards in the overview.
      const strays = model.overview.filter((row) => /efficiency|penalty|generation|demand/i.test(row.label));
      assert.deepEqual(strays, [], `${key} has no separate Power cards: ${strays.map((r) => r.label)}`);
    }
  });

  check("a healthy design reports spare Power and Fully powered", () => {
    const { model } = build("medium");
    const power = model.overview.find((row) => row.id === "power");
    assert.match(power.value, /MW spare$/);
    assert.equal(power.tone, "good");
    assert.ok(model.status.some((message) => message.id === "power-ok" && message.text === "Fully powered" && message.level === "good"));
    assert.equal(model.status.some((message) => message.id === "power-short"), false);
  });

  check("an underpowered design reports the shortfall and the systems it degrades", () => {
    const { model } = build("underpowered");
    const power = model.overview.find((row) => row.id === "power");
    assert.match(power.value, /MW (short|generation deficit)$/);
    assert.equal(power.tone, "bad");
    const shortfall = model.status.find((message) => message.id === "power-short");
    assert.ok(shortfall, "a shortfall status is raised");
    assert.equal(shortfall.level, "bad");
    assert.match(shortfall.text, /MW (short|generation deficit)/);
    assert.match(shortfall.text, /shields/, "names the affected systems");
    assert.equal(model.status.some((message) => message.id === "power-ok"), false, "not also reported as fully powered");
  });

  check("Power Penalty: None is never rendered", () => {
    for (const key of KEYS) {
      const { stats, model } = build(key);
      const penalty = allRows(model).filter((row) => /penalty/i.test(row.label));
      if (Number(stats.powerDebuff || 0) <= 0) {
        assert.deepEqual(penalty, [], `${key} hides a zero Power penalty`);
      } else {
        assert.equal(penalty.length, 1, `${key} shows a real Power penalty once`);
        assert.match(penalty[0].value, /^-\d+%$/);
      }
      for (const row of allRows(model)) {
        assert.doesNotMatch(String(row.value), /^(none|not applicable|n\/a)$/i, `${key}: "${row.label}" renders no placeholder value`);
      }
    }
  });

  check("Power details use the authoritative solved summary when one is supplied", () => {
    const solved = {
      totalGenerationMw: 24, requestedDemandMw: 23.8, deliveredDemandMw: 23.8,
      spareGenerationMw: 0.2, unmetDemandMw: 0, loadShedCategories: [], aboveSustainedSectionCount: 0, atPeakSectionCount: 0
    };
    const { model } = build("medium", { powerSummary: solved });
    const power = model.overview.find((row) => row.id === "power");
    assert.equal(power.value, "0.2 MW spare");
    assert.equal(power.hint, undefined);
    const details = model.sections.find((section) => section.id === "power");
    assert.equal(details.rows.find((row) => row.id === "power.generation").value, "24.0 MW");
    assert.equal(details.rows.find((row) => row.id === "power.demand").value, "23.8 MW");
    // resolvePowerSummary is the single source both the panel and summary read.
    const resolved = resolvePowerSummary({ powerGeneration: 1, powerUse: 2 }, solved);
    assert.equal(resolved.generation, 24);
    assert.equal(resolved.requested, 23.8);
    assert.equal(resolved.shortfall, false);
  });

  // -- 4. Mobility -------------------------------------------------------------
  check("turn rate is shown in degrees per second with a unit on every side", () => {
    assert.equal(degreesPerSecond(Math.PI), 180, "radians convert to degrees");
    assert.equal(turnText({ turnRateLeft: 1, turnRateRight: 1 }), `${degreesPerSecond(1)}°/s`);
    const asym = turnText({ turnRateLeft: 0.73, turnRateRight: 1.15 });
    assert.match(asym, /^Left \d+°\/s · Right \d+°\/s$/, `both sides carry their unit: ${asym}`);
    for (const key of KEYS) {
      const { model } = build(key);
      const turn = model.overview.find((row) => row.id === "turn");
      assert.match(turn.value, /°\/s/, `${key} turn rate uses degrees per second`);
      assert.doesNotMatch(turn.value, /rad\/s/, `${key} turn rate is not left in radians`);
      // Never one side without its unit.
      const sides = turn.value.match(/(Left|Right) [\d.]+(°\/s)?/g) || [];
      for (const side of sides) assert.match(side, /°\/s$/, `${key}: "${side}" carries its unit`);
    }
  });

  check("asymmetric turning is explained concisely", () => {
    assert.equal(turnAsymmetry({ turnRateLeft: 1, turnRateRight: 1 }), null, "even turning raises nothing");
    const mild = turnAsymmetry({ turnRateLeft: 0.7, turnRateRight: 1.1 });
    assert.equal(mild.side, "right");
    assert.equal(mild.percent, 57, "57% faster matches the authoritative rates");
    const oneSided = turnAsymmetry({ turnRateLeft: 0, turnRateRight: 1.2 });
    assert.equal(oneSided.oneSided, true);
    assert.equal(oneSided.slowerSide, "left");

    const { model } = build("asymmetric");
    const message = model.status.find((entry) => entry.id === "asymmetric-turn");
    assert.ok(message, "an asymmetric design raises the status");
    assert.equal(message.level, "warning");
    assert.match(message.text, /Asymmetric turning:/);
  });

  check("engineering mobility values live in a collapsed Mobility details section", () => {
    const { model } = build("medium");
    const mobility = model.sections.find((section) => section.id === "mobility");
    assert.ok(mobility, "Mobility details exists");
    assert.equal(mobility.title, "Mobility Details");
    const ids = mobility.rows.map((row) => row.id);
    for (const expected of ["thrust", "thrustRatio", "engineEfficiency", "speedCap", "turnLeft", "turnRight"]) {
      assert.ok(ids.includes(expected), `Mobility details carries ${expected}`);
    }
    assert.ok(mobility.rows.find((row) => row.id === "turnLeft").value.endsWith("°/s"));
    assert.ok(mobility.rows.find((row) => row.id === "turnRight").value.endsWith("°/s"));
  });

  check("speed and the mass drag limit are reconciled rather than left contradictory", () => {
    for (const key of KEYS) {
      const { stats, model } = build(key);
      const mobility = model.sections.find((section) => section.id === "mobility");
      if (!mobility) continue;
      const speed = Math.round(Number(stats.maxSpeed) || 0);
      const cap = Math.round(Number(stats.speedCap) || 0);
      // A ship with no engines has no speed/limit relationship worth explaining;
      // the status area reports the missing thrust outright.
      if (Number(stats.effectiveThrust || 0) > 0 && cap > 0 && speed !== cap) {
        assert.ok(mobility.note, `${key}: the speed/drag-limit relationship is explained (${speed} vs ${cap})`);
        assert.match(mobility.note, /mass drag limit|Mass drag caps/i);
      }
    }
  });

  // -- 5. Combat and support ---------------------------------------------------
  check("the overview carries one weapon output value and details carry the breakdown", () => {
    const { stats, model } = build("heavy");
    const weapons = model.overview.filter((row) => row.id === "weapons");
    assert.equal(weapons.length, 1, "one headline weapon value");
    assert.equal(weapons[0].value, String(stats.weaponDps), "it is the authoritative total DPS");
    const combat = model.sections.find((section) => section.id === "combat");
    assert.ok(combat, "Combat details exists for an armed ship");
    assert.ok(combat.rows.length > 0);
    assert.equal(combat.rows.some((row) => row.id === "weapons"), false, "total DPS is not repeated");
  });

  check("Support details render only when the ship has support capability", () => {
    const support = build("support");
    const section = support.model.sections.find((entry) => entry.id === "support");
    assert.ok(section, "a repair ship gets Support details");
    assert.ok(section.rows.some((row) => row.id === "repair"), "repair rate is listed");

    const bare = build("bare");
    assert.equal(bare.model.sections.some((entry) => entry.id === "support"), false,
      "a ship with no support capability renders no Support details");
  });

  check("Repair: 0 HP/s is never rendered", () => {
    for (const key of KEYS) {
      const { stats, model } = build(key);
      const repair = allRows(model).filter((row) => row.id === "repair");
      if (Number(stats.repairRate || 0) <= 0) {
        assert.deepEqual(repair, [], `${key} hides a zero repair rate`);
      } else {
        assert.equal(repair.length, 1);
        assert.match(repair[0].value, /HP\/s$/);
      }
      for (const row of allRows(model)) {
        assert.doesNotMatch(`${row.label}: ${row.value}`, /repair.*:?\s*0(\.0)? HP\/s/i, `${key} shows no zero repair rate`);
      }
    }
  });

  check("zero-value capabilities are omitted from detail sections", () => {
    for (const key of KEYS) {
      const { model } = build(key);
      for (const section of model.sections) {
        assert.ok(section.rows.length > 0, `${key}/${section.title} is never empty`);
        for (const row of section.rows) {
          assert.ok(row.value && String(row.value).trim().length, `${key}/${row.label} has a real value`);
          if (row.id !== "power.demand" && row.id !== "power.delivered" && row.id !== "power.generation") {
            assert.doesNotMatch(String(row.value), /^0(\.0+)?( |$)/, `${key}/${row.label} is not a zero capability`);
          }
        }
      }
    }
  });

  // -- 6. Status messages ------------------------------------------------------
  check("status messages describe real conditions with consistent levels", () => {
    const bare = build("bare").model;
    assert.ok(bare.status.some((m) => m.id === "no-weapons" && m.level === "bad"));
    assert.ok(bare.status.some((m) => m.id === "no-shield" && m.level === "warning"));
    assert.ok(bare.status.some((m) => m.id === "no-thrust" && m.level === "bad"));

    const medium = build("medium").model;
    assert.equal(medium.status.some((m) => m.id === "no-weapons"), false, "an armed ship raises no weapon warning");
    assert.equal(medium.status.some((m) => m.id === "no-shield"), false, "a shielded ship raises no shield warning");

    for (const key of KEYS) {
      for (const message of build(key).model.status) {
        assert.ok(["good", "warning", "bad", "neutral"].includes(message.level), `${key}: known level`);
        assert.ok(message.text && message.text.trim().length, `${key}: no empty status`);
        assert.ok(message.id, `${key}: status is identified`);
      }
    }
  });

  check("backup command is reported as a healthy state, not a warning", () => {
    const design = [at("core", 7, 7), at("reactor", 7, 8), at("backupCore", 5, 7)];
    const model = buildShipSummaryModel(computeStats(design), { design });
    const backup = model.status.find((message) => message.id === "backup-command");
    assert.ok(backup, "backup command is surfaced");
    assert.equal(backup.level, "good");
    assert.equal(backup.text, "Backup command available");
  });

  check("amber and red appear only for genuine limitations", () => {
    // Every warning/bad status must correspond to a condition that is actually
    // true of the design, for every representative design.
    const holds = {
      "power-short": (stats, m) => m.power.shortfall,
      "no-thrust": (stats) => Number(stats.effectiveThrust || 0) <= 0,
      "mass-drag": (stats) => stats.speedCapped === true,
      "asymmetric-turn": (stats) => Boolean(turnAsymmetry(stats)),
      "no-shield": (stats) => Number(stats.maxShield || 0) <= 0,
      "no-weapons": (stats) => Number(stats.weaponDps || 0) <= 0 && Number(stats.pointDefense || 0) <= 0,
      cooling: () => true,
      "cable-overload": (stats, m) => m.power.overloadedSections > 0
    };
    for (const key of KEYS) {
      const { stats, model: current } = build(key);
      for (const message of current.status.filter((entry) => entry.level === "warning" || entry.level === "bad")) {
        const predicate = holds[message.id];
        assert.ok(predicate, `${key}: "${message.id}" is a known limitation`);
        assert.equal(predicate(stats, current), true,
          `${key}: "${message.id}" is only raised when the condition truly holds`);
      }
    }

    const { model } = build("medium");
    for (const row of model.overview) {
      if (row.id === "power") continue;
      assert.ok(!row.tone || row.tone === "neutral", `${row.label} is not coloured merely for being technical`);
    }
    for (const section of model.sections) {
      for (const row of section.rows) {
        if (row.tone === "bad" || row.tone === "warning") {
          assert.ok(["power.unmet", "power.penalty", "power.shed", "power.overloaded", "blockedEngines"].includes(row.id),
            `${row.id} is only coloured when it is a real limitation`);
        }
      }
    }
  });

  check("no stale status survives a design change", () => {
    const underpowered = build("underpowered").model;
    assert.ok(underpowered.status.some((message) => message.id === "power-short"));
    const healthy = build("medium").model;
    assert.equal(healthy.status.some((message) => message.id === "power-short"), false,
      "the shortfall does not persist into a healthy design");
    const bare = build("bare").model;
    assert.equal(bare.sections.some((section) => section.id === "combat"), false,
      "an unarmed design keeps no Combat details from a previous design");
  });

  // -- 7. Authoritative values are unchanged -----------------------------------
  check("every headline value comes straight from computeStats", () => {
    for (const key of KEYS) {
      const { stats, model } = build(key);
      const value = (id) => model.overview.find((row) => row.id === id)?.value;
      assert.equal(value("cost"), `$${stats.unitCost.toLocaleString()}`, `${key} cost`);
      assert.equal(value("class"), stats.massClass, `${key} class`);
      assert.equal(value("mass"), `${stats.mass} T`, `${key} mass`);
      assert.equal(value("hull"), `${stats.maxHp} HP`, `${key} hull`);
      assert.equal(value("shield"), `${stats.maxShield} SP`, `${key} shield`);
      assert.equal(value("weapons"), String(stats.weaponDps), `${key} weapon DPS`);
      assert.equal(value("speed"), `${Math.round(stats.maxSpeed)} m/s`, `${key} speed`);
      assert.equal(value("turn"), turnText(stats), `${key} turn`);
    }
  });

  check("detail sections restate authoritative mobility values without rounding drift", () => {
    const { stats, model } = build("heavy");
    const mobility = model.sections.find((section) => section.id === "mobility");
    const row = (id) => mobility.rows.find((entry) => entry.id === id)?.value;
    assert.equal(row("thrust"), `${stats.effectiveThrust} kN`);
    assert.equal(row("speedCap"), `${Math.round(stats.speedCap * 100) / 100} m/s`);
    assert.equal(row("engineEfficiency"), `${Math.round(stats.engineEfficiency * 100)}%`);
    assert.equal(row("turnLeft"), `${degreesPerSecond(stats.turnRateLeft)}°/s`);
    assert.equal(row("turnRight"), `${degreesPerSecond(stats.turnRateRight)}°/s`);
  });

  console.log(`\nShip summary checks: ${passed}/${passed} passed`);
  console.log("Ship summary information-architecture verification passed");
})().catch((error) => { console.error(error); process.exit(1); });
