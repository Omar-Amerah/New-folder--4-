"use strict";
// Blueprint "Selected Component" inspector — information-architecture contract.
//
// These checks pin the *presentation rules* (no duplicated statistic, no empty or
// no-op value, explicit Power direction, context-specific headings, warnings kept
// out of ordinary stat cards) and confirm that every value still comes from the
// authoritative component catalogue. Non-browser: shared UMD modules register the
// browser globals the model reads.

const assert = require("assert");
const HeatRules = require("../public/src/shared/heatRules");
const TurretRules = require("../public/src/shared/turretRules");

globalThis.HeatRules = HeatRules;
globalThis.TurretRules = TurretRules;
global.document = { createElement: () => ({ getContext: () => ({}), style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }), createElementNS: () => ({ setAttribute() {}, appendChild() {} }), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, documentElement: { style: { setProperty() {} } }, body: { classList: { add() {}, remove() {} } } };
global.window = { devicePixelRatio: 1, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
global.localStorage = { getItem: () => null, setItem: () => {} };

let passed = 0;
function check(label, fn) { fn(); passed += 1; console.log(`  ok  ${label}`); }

(async () => {
  const { PART_STATS, PART_DEFS, partCategory, partDescription } = await import("../public/src/design/parts.js");
  const Model = await import("../public/src/design/componentInspectorModel.js");
  const { buildComponentInspectorModel, statRow, StatLedger, categoryBadge, componentFamily, isMeaningfulValue } = Model;

  const build = (type, context = {}) => {
    const stat = PART_STATS[type];
    assert.ok(stat, `catalogue has ${type}`);
    return buildComponentInspectorModel(type, stat, {
      name: (PART_DEFS[type] || PART_DEFS.frame).name,
      description: partDescription(type, stat),
      category: partCategory(type),
      effectiveCost: `$${stat.cost}`,
      prediction: null,
      ...context
    });
  };

  // Every row the inspector renders, flattened with the region it came from.
  const allRows = (model) => [
    ...model.core.map((row) => ({ ...row, region: "core" })),
    ...model.capability.map((row) => ({ ...row, region: "capability" })),
    ...model.thermalSummary.map((row) => ({ ...row, region: "thermal-summary" })),
    ...model.sections.flatMap((section) => section.rows.map((row) => ({ ...row, region: section.id })))
  ];

  const REPRESENTATIVE = ["frame", "reactor", "blaster", "signalAmplifier", "shield", "droneBay", "heatSink", "core", "backupCore",
    "armor", "pointDefense", "radiator", "engine", "heatPipe", "capacitor", "repair", "missile", "railgun", "beamEmitter", "battery"];

  // -- 1. No statistic ever appears twice in one inspector --------------------
  check("no canonical statistic is rendered twice in a single inspector", () => {
    for (const type of REPRESENTATIVE) {
      const rows = allRows(build(type, { droneType: "fighter" }));
      const byId = new Map();
      for (const row of rows) {
        assert.ok(!byId.has(row.id), `${type}: stat "${row.id}" appears twice (${byId.get(row.id)} and ${row.region})`);
        byId.set(row.id, row.region);
      }
    }
  });

  check("no two rows in one inspector share the same visible label", () => {
    for (const type of REPRESENTATIVE) {
      const rows = allRows(build(type, { droneType: "fighter" }));
      const seen = new Map();
      for (const row of rows) {
        const key = row.label.trim().toLowerCase();
        assert.ok(!seen.has(key), `${type}: label "${row.label}" appears in both ${seen.get(key)} and ${row.region}`);
        seen.set(key, row.region);
      }
    }
  });

  // -- 2. Zero, None and no-op 100% values are hidden -------------------------
  check("zero bonuses, no-op 100% modifiers and None values are dropped", () => {
    assert.equal(statRow("bonus.accuracy", "Accuracy bonus", "+0%", { kind: "bonus", raw: 0 }), null);
    assert.equal(statRow("weapon.vsHull", "Vs hull", "100%", { kind: "modifier", raw: 1 }), null);
    assert.ok(statRow("weapon.vsShields", "Vs shields", "155%", { kind: "modifier", raw: 1.55 }));
    assert.ok(statRow("bonus.range", "Range bonus", "+40 m", { kind: "bonus", raw: 40 }));
    for (const empty of [null, undefined, "", "None", "none", "N/A", "Not applicable", "  "]) {
      assert.equal(isMeaningfulValue(empty), false, `"${empty}" is treated as absent`);
      assert.equal(statRow("x", "X", empty), null, `"${empty}" renders no row`);
    }
  });

  check("Signal Amplifier never shows an empty Accuracy bonus", () => {
    const rows = allRows(build("signalAmplifier"));
    const accuracy = rows.find((row) => row.id === "bonus.accuracy");
    assert.equal(accuracy, undefined, "no Accuracy bonus row when the catalogue value is zero");
    assert.equal(PART_STATS.signalAmplifier.accuracyBonus, 0, "fixture assumption: Signal Amplifier has no accuracy bonus");
    for (const row of rows) assert.doesNotMatch(row.value, /\bnone\b/i, `no "None" value survives: ${row.label}`);
  });

  check("no rendered value is an empty or placeholder string", () => {
    for (const type of REPRESENTATIVE) {
      for (const row of allRows(build(type, { droneType: "fighter" }))) {
        assert.ok(row.value && row.value.trim().length, `${type}/${row.label} has a real value`);
        assert.equal(isMeaningfulValue(row.value), true, `${type}/${row.label} is meaningful`);
      }
    }
  });

  // -- 3. Power direction is explicit ----------------------------------------
  check("consumers show Power draw and generators show Power output", () => {
    const blaster = build("blaster").core.find((row) => row.id === "power");
    assert.equal(blaster.label, "Power draw", "a consumer is labelled Power draw");
    assert.equal(blaster.value, `${PART_STATS.blaster.powerUse} MW`, "draw uses the authoritative value");
    assert.equal(blaster.tone, "demand");
    assert.doesNotMatch(blaster.value, /^[-+]/, "no ambiguous +/- sign");

    const reactor = build("reactor").core.find((row) => row.id === "power");
    assert.equal(reactor.label, "Power output", "a generator is labelled Power output");
    assert.equal(reactor.value, `${PART_STATS.reactor.powerGeneration} MW`, "output uses the authoritative value");
    assert.equal(reactor.tone, "supply");
    assert.doesNotMatch(reactor.value, /^[-+]/, "no ambiguous +/- sign");

    assert.equal(build("frame").core.some((row) => row.id === "power"), false, "an unpowered component shows no Power cell");
  });

  check("Power appears in the core row and nowhere else", () => {
    for (const type of ["reactor", "blaster", "shield", "core", "backupCore", "engine"]) {
      const rows = allRows(build(type));
      const power = rows.filter((row) => row.id === "power");
      assert.equal(power.length, 1, `${type} states Power exactly once`);
      assert.equal(power[0].region, "core", `${type} states Power in the core specification row`);
    }
  });

  // -- 4. Core specification row is consistent -------------------------------
  check("every component shows the same three core specifications with consistent labels", () => {
    for (const type of REPRESENTATIVE) {
      const core = build(type).core;
      const labels = core.map((row) => row.label);
      assert.deepEqual(labels.slice(0, 3), ["Build cost", "Mass", "Durability"], `${type} leads with cost, mass, durability`);
      assert.ok(core.length <= 4, `${type} core row stays within four cells`);
      assert.match(core[1].value, / T$/, `${type} mass uses a consistent unit`);
      assert.match(core[2].value, /HP$/, `${type} durability uses a consistent unit`);
    }
  });

  // -- 5. Header badge --------------------------------------------------------
  check("category badge is compact and never repeats the word Footprint", () => {
    assert.equal(categoryBadge("Weapons", { width: 1, height: 1 }), "WEAPON · 1×1");
    assert.equal(categoryBadge("Power", { width: 2, height: 1 }), "POWER · 2×1");
    assert.equal(categoryBadge("Structure", { width: 1, height: 1 }), "STRUCTURE · 1×1");
    for (const type of REPRESENTATIVE) {
      const badge = build(type).header.badge;
      assert.doesNotMatch(badge, /footprint/i, `${type} badge omits the word Footprint`);
      assert.match(badge, /^[A-Z ]+ · \d+×\d+$/, `${type} badge is CATEGORY · W×H`);
    }
  });

  // -- 6. Blaster overview ----------------------------------------------------
  check("Blaster overview shows DPS, range, accuracy and arc without weapon-detail repeats", () => {
    const model = build("blaster");
    const capability = model.capability.map((row) => row.id);
    assert.deepEqual(capability, ["weapon.dps", "weapon.range", "weapon.accuracy", "weapon.arc"]);

    const weaponSection = model.sections.find((section) => section.id === "weapon");
    assert.ok(weaponSection, "Blaster has a Weapon details section");
    const detailIds = weaponSection.rows.map((row) => row.id);
    for (const repeated of ["weapon.dps", "weapon.range", "weapon.accuracy", "weapon.arc"]) {
      assert.ok(!detailIds.includes(repeated), `Weapon details does not repeat ${repeated}`);
    }
    assert.ok(detailIds.includes("weapon.damage"), "damage per shot lives in Weapon details");
    assert.ok(detailIds.includes("weapon.traverse"), "turret traverse lives in Weapon details");
  });

  check("no weapon shows both a fire rate and a reload row", () => {
    for (const type of ["blaster", "railgun", "missile", "autocannon", "pointDefense", "torpedo"]) {
      const rows = allRows(build(type));
      const rate = rows.filter((row) => /fire rate|reload/i.test(row.label));
      assert.ok(rate.length <= 1, `${type} states cadence once, not as both fire rate and reload (${rate.map((r) => r.label)})`);
    }
  });

  check("shield and hull damage multipliers are shown for all weapons including 100%", () => {
    const blasterRows = allRows(build("blaster"));
    assert.ok(blasterRows.some((row) => row.id === "weapon.vsHull" && row.value === "100%"), "Vs hull 100% is shown for blaster");
    assert.ok(blasterRows.some((row) => row.id === "weapon.vsShields"), "Vs shields is shown for blaster");

    const beamRows = allRows(build("beamEmitter"));
    assert.ok(beamRows.some((row) => row.id === "weapon.vsShields"), "a meaningful shield modifier is shown for beam");
    assert.ok(beamRows.some((row) => row.id === "weapon.vsHull"), "Vs hull is shown for beam");
  });

  check("damage is stated exactly once per weapon", () => {
    for (const type of ["blaster", "railgun", "missile", "beamEmitter", "pointDefense"]) {
      const damage = allRows(build(type)).filter((row) => /^damage/i.test(row.label));
      assert.equal(damage.length, 1, `${type} states damage once (${damage.map((r) => r.label)})`);
    }
  });

  // -- 7. Heat presentation ---------------------------------------------------
  check("Frame has a Thermal details block but no thermal summary", () => {
    const frame = build("frame");
    assert.ok(frame.sections.some((section) => section.id === "thermal"), "a Frame now renders a Thermal details section");
    assert.equal(frame.thermalSummary.length, 0, "a bare Frame renders no thermal summary");
    assert.equal(frame.capability.length, 0, "a bare Frame renders no capability grid");
    assert.equal(Model.hasThermalRelevance("frame", PART_STATS.frame), true);
  });

  check("thermal components summarise their role compactly", () => {
    const summaryOf = (type) => build(type).thermalSummary.map((row) => `${row.label} — ${row.value}`);
    // Every thermal part states its role, so transport/storage/rejection cannot
    // be confused with one another in the inspector.
    assert.deepEqual(summaryOf("heatSink"), [
      `Heat storage — Stores ${HeatRules.profile("heatSink", PART_STATS.heatSink).capacity} H`,
      "Needs a coolant path — Heat must reach the sink directly or through Heat Pipes; adjacent components do not share its capacity.",
      "Thermal role — Buffers temporary Heat spikes; it does not remove Heat."
    ]);
    assert.deepEqual(summaryOf("radiator"), [
      `Cooling — Removes ${HeatRules.profile("radiator", PART_STATS.radiator).cooling.toFixed(1)} H/s`,
      `Needs an exposed edge — Fully enclosed radiators operate at ${Math.round(HeatRules.RADIATOR_ENCLOSED_MULTIPLIER * 100)}% of rated cooling output.`,
      "Thermal role — Strong sustained external heat rejection."
    ]);
    assert.deepEqual(summaryOf("heatVent"), [
      `Cooling — Removes ${HeatRules.profile("heatVent", PART_STATS.heatVent).cooling.toFixed(1)} H/s while exposed`,
      "Needs an exposed edge — Fully enclosed vents provide very little cooling.",
      "Thermal role — Cheap low-output external cooling for compact ships."
    ]);
    assert.deepEqual(summaryOf("heatPipe"), [
      "Thermal role — Routes Heat between separated systems; it provides no storage or cooling."
    ]);
    assert.match(summaryOf("reactor")[0], /^Heat — Produces [\d.]+ H\/s at power load$/);
  });

  check("component callouts follow capability, condition, cost, role, severe hierarchy", () => {
    const rank = { capability: 0, condition: 1, cost: 2, role: 3, severe: 4 };
    for (const type of Object.keys(PART_STATS)) {
      const model = build(type, { droneType: "fighter" });
      const actual = model.callouts.map((callout) => rank[callout.category]);
      assert.deepEqual(actual, [...actual].sort((a, b) => a - b), `${type} callouts follow semantic order`);
      assert.ok(model.callouts.every((callout) => Number.isInteger(rank[callout.category])), `${type} uses known categories`);
    }
    assert.deepEqual(build("radiator").callouts.map((callout) => callout.category),
      ["capability", "condition", "role"]);
    assert.deepEqual(build("reactor").callouts.map((callout) => callout.category), ["cost", "severe"]);
    assert.deepEqual(build("backupCore").callouts.map((callout) => callout.category),
      ["capability", "condition", "condition", "severe"]);
  });

  check("thermal callouts use H and H/s terminology and avoid duplicate role requirements", () => {
    for (const type of Object.keys(PART_STATS)) {
      const model = build(type, { droneType: "fighter" });
      for (const row of model.thermalSummary) {
        assert.doesNotMatch(`${row.label} ${row.value}`, /\bHeat\/s\b/i, `${type}/${row.id} avoids Heat/s`);
      }
    }
    for (const type of ["radiator", "heatVent"]) {
      const model = build(type);
      const role = model.thermalSummary.find((row) => row.id === "heat.role");
      assert.doesNotMatch(role.value, /expos|enclos/i, `${type} role does not repeat its exposure condition`);
      assert.doesNotMatch(model.header.description, /expos|enclos/i, `${type} description does not repeat its exposure condition`);
      assert.equal(model.callouts.filter((callout) => callout.id === "exposure" || callout.id === "heat.exposure").length, 1,
        `${type} presents exposure once as a condition`);
    }
    for (const type of ["reactor", "nuclearReactor"]) {
      assert.doesNotMatch(build(type).header.description, /melt|explod/i, `${type} description leaves danger to the severe warning`);
    }
  });

  check("reactors omit non-storage energy capacity from the inspector", () => {
    const reactor = build("reactor");
    const rows = allRows(reactor);
    assert.equal(rows.some((row) => row.id === "power.storage"), false, "Reactor has no Energy Storage row");
    assert.equal(reactor.capability.length, 0, "Reactor needs no empty Primary capability section");
  });

  check("heat generation is never stated twice", () => {
    for (const type of ["reactor", "blaster", "engine", "shield", "droneBay"]) {
      const rows = allRows(build(type));
      assert.equal(rows.filter((row) => row.id === "heat.production").length, 1, `${type} states heat production once`);
      for (const id of ["heat.production", "heat.perShot"]) {
        assert.ok(rows.filter((row) => row.id === id).length <= 1, `${type} has no duplicate ${id} row`);
      }
    }
  });

  // -- 8. Warnings ------------------------------------------------------------
  check("Reactor meltdown is one consolidated warning, not stat cards", () => {
    const model = build("reactor");
    const meltdown = model.warnings.filter((warning) => warning.id === "meltdown");
    assert.equal(meltdown.length, 1, "exactly one meltdown warning");
    assert.equal(meltdown[0].title, "Meltdown risk");
    assert.match(meltdown[0].body, new RegExp(`${HeatRules.REACTOR_MELTDOWN_SECONDS} seconds`), "uses the authoritative meltdown delay");
    assert.match(meltdown[0].body, new RegExp(`${HeatRules.REACTOR_EXPLOSION_DAMAGE} damage`), "uses the authoritative blast damage");
    assert.match(meltdown[0].body, new RegExp(`${HeatRules.REACTOR_EXPLOSION_RADIUS} tiles`), "uses the authoritative blast radius");
    // The risk must not also appear as ordinary rows.
    for (const row of allRows(model)) {
      assert.doesNotMatch(row.label, /meltdown/i, "meltdown is not an ordinary stat card");
    }
  });

  check("command capability, placement conditions and severe risks remain distinct", () => {
    const backup = build("backupCore");
    const ids = backup.warnings.map((warning) => warning.id);
    assert.equal(backup.warnings.find((warning) => warning.id === "backup-command").calloutCategory, "capability");
    assert.equal(backup.warnings.find((warning) => warning.id === "one-per-ship").calloutCategory, "condition");
    assert.equal(backup.warnings.find((warning) => warning.id === "backup-power-loss").calloutCategory, "severe");
    const effectiveness = allRows(backup).find((row) => row.id === "command.effectiveness");
    assert.equal(effectiveness?.label, "Backup Effectiveness");
    assert.match(effectiveness?.value || "", /85%.*weapon accuracy.*turn rate.*drone command range/i,
      "Backup Core presents the shared rule and every affected system together");
    assert.equal(PART_STATS.backupCore.maxPerShip, 1, "restriction comes from the authoritative catalogue");
    assert.ok(build("core").warnings.some((warning) => warning.id === "command-loss"), "Main Core warns about command loss");
    assert.ok(build("radiator").callouts.some((callout) => callout.id === "heat.exposure" && callout.category === "condition"),
      "Radiator presents enclosure as a normal condition");
    assert.ok(build("droneBay").warnings.some((warning) => warning.id === "launch-edge"), "Drone Bay warns about its launch edge");
    assert.equal(build("frame").warnings.length, 0, "a Frame raises no warnings");
  });

  check("Power and Data dependencies are requirements, not warning callouts", () => {
    for (const type of ["blaster", "shield", "engine", "radiator", "signalAmplifier"]) {
      const ids = build(type).warnings.map((warning) => warning.id);
      assert.ok(!ids.includes("power-dependency"), `${type} raises no Power warning callout`);
      assert.ok(!ids.includes("data-dependency"), `${type} raises no Data warning callout`);
      for (const warning of build(type).warnings) {
        assert.doesNotMatch(warning.title, /^requires (power|a data link)$/i, `${type} has no "Requires ..." callout`);
      }
    }
  });

  // -- Requirements row -------------------------------------------------------
  check("requirements cover Power only, Data only, both, and neither", () => {
    const ids = (type, context) => build(type, context).requirements.map((requirement) => requirement.id);
    assert.deepEqual(ids("blaster"), ["power"], "a powered weapon requires Power only");
    assert.deepEqual(ids("signalAmplifier"), ["power", "data"], "a powered Data source requires both");
    assert.deepEqual(ids("frame"), [], "a passive Frame requires neither");
    assert.deepEqual(ids("heatSink"), [], "an unpowered utility requires neither");
    // A Data source with no power draw requires Data only.
    const dataOnly = buildComponentInspectorModel("signalAmplifier", { ...PART_STATS.signalAmplifier, powerUse: 0 }, {
      name: "Signal Amplifier", description: "", category: "Support", effectiveCost: "$10"
    });
    assert.deepEqual(dataOnly.requirements.map((r) => r.id), ["data"], "a Data source without a draw requires Data only");
  });

  check("every requirement carries an icon, a visible text label and an explanation", () => {
    for (const type of REPRESENTATIVE) {
      for (const requirement of build(type).requirements) {
        assert.ok(requirement.icon, `${type}/${requirement.id} has an icon`);
        assert.ok(requirement.label && /[A-Za-z]/.test(requirement.label), `${type}/${requirement.id} has a text label`);
        assert.ok(requirement.summary, `${type}/${requirement.id} has a compact summary`);
        assert.ok(requirement.detail.length > 20, `${type}/${requirement.id} explains the rule`);
      }
    }
    const power = build("blaster").requirements[0];
    assert.equal(power.label, "Power");
    assert.equal(power.summary, `${PART_STATS.blaster.powerUse} MW`, "the draw comes from the catalogue");
  });

  check("requirement status is unplaced for palette components and unmet only on real failures", () => {
    assert.equal(build("blaster").requirements[0].status, "unplaced", "an unplaced component reports no failure");
    const unmet = build("blaster", { requirementStatus: { power: { state: "unmet", reason: "Connected, but receiving no Power." } } });
    assert.equal(unmet.requirements[0].status, "unmet");
    assert.equal(unmet.requirements[0].failureText, "Connected, but receiving no Power.", "the failure is carried as visible text");
    const met = build("blaster", { requirementStatus: { power: { state: "met", reason: null } } });
    assert.equal(met.requirements[0].status, "met");
  });

  check("Blueprint solver states map onto requirement status", () => {
    assert.deepEqual(Model.powerRequirementState(null), { state: "unplaced", reason: null });
    assert.equal(Model.powerRequirementState({ state: "powered" }).state, "met");
    assert.equal(Model.powerRequirementState({ state: "passive" }).state, "met");
    assert.equal(Model.powerRequirementState({ state: "disconnected" }).state, "unmet");
    assert.match(Model.powerRequirementState({ state: "disconnected" }).reason, /not connected/i);
    assert.equal(Model.powerRequirementState({ state: "unpowered" }).state, "unmet");
    const partial = Model.powerRequirementState({ state: "underpowered", allocatedMw: 1.2, requestedMw: 3.5 });
    assert.equal(partial.state, "unmet");
    assert.match(partial.reason, /1\.2 MW of 3\.5 MW/);

    assert.deepEqual(Model.dataRequirementState(null), { state: "unplaced", reason: null });
    assert.equal(Model.dataRequirementState({ status: "active", recipientCount: 2 }).state, "met");
    assert.equal(Model.dataRequirementState({ status: "active", recipientCount: 0 }).state, "unmet");
    assert.match(Model.dataRequirementState({ status: "active", recipientCount: 0 }).reason, /no weapon is connected/i);
    assert.equal(Model.dataRequirementState({ status: "unpowered", recipientCount: 1, statusReason: "No Power." }).state, "unmet");
  });

  // -- 9. Context-specific accordion headings ---------------------------------
  check("advanced sections use context-specific headings, never generic Combat details", () => {
    const titles = (type) => build(type, { droneType: "fighter" }).sections.map((section) => section.title);
    assert.ok(titles("blaster").includes("Weapon Details"));
    assert.ok(titles("shield").includes("Shield Details"));
    assert.ok(titles("droneBay").includes("Drone Details"));
    assert.ok(titles("repair").includes("Repair Details"));
    assert.ok(titles("signalAmplifier").includes("Sensor Details"));
    assert.ok(titles("targetingComputer").includes("Targeting Details"));
    assert.equal(titles("targetingComputer").includes("Sensor Details"), false);
    assert.ok(titles("backupCore").includes("Command Details"));
    assert.ok(titles("reactor").includes("Thermal Details"));
    for (const type of REPRESENTATIVE) {
      for (const title of titles(type)) {
        assert.notEqual(title, "Combat Details", `${type} uses no generic Combat details heading`);
        assert.notEqual(title, "Heat Details", `${type} uses the Thermal details heading`);
        assert.notEqual(title, "Key stats", `${type} replaces the Key stats card grid`);
      }
    }
  });

  check("Thermal Induction Lance exposes its specialist targeting priority", () => {
    const model = build("thermalInductionLance");
    const targeting = allRows(model).find((row) => row.id === "weapon.componentSelection");
    assert.ok(targeting, "Thermal Induction Lance has a targeting-priority row");
    assert.equal(targeting.label, "Targeting Priority");
    assert.match(targeting.value, /functioning Power generators/);
    assert.match(PART_STATS.thermalInductionLance.description, /designed to overload critical powered systems/);
  });

  check("no advanced section is rendered empty", () => {
    for (const type of REPRESENTATIVE) {
      for (const section of build(type, { droneType: "fighter" }).sections) {
        assert.ok(section.rows.length > 0, `${type}/${section.title} has content`);
        assert.ok(section.id && section.title, `${type} section is fully identified`);
      }
    }
  });

  // -- 10. Family presentation rules ------------------------------------------
  check("components map onto the documented presentation families", () => {
    assert.equal(componentFamily("frame", PART_STATS.frame), "structure");
    assert.equal(componentFamily("reactor", PART_STATS.reactor), "power");
    assert.equal(componentFamily("engine", PART_STATS.engine), "propulsion");
    assert.equal(componentFamily("blaster", PART_STATS.blaster), "weapon");
    assert.equal(componentFamily("shield", PART_STATS.shield), "defence");
    assert.equal(componentFamily("core", PART_STATS.core), "command");
    assert.equal(componentFamily("backupCore", PART_STATS.backupCore), "command");
    assert.equal(componentFamily("signalAmplifier", PART_STATS.signalAmplifier), "utility");
    for (const type of Object.keys(PART_STATS)) {
      assert.ok(Model.FAMILIES.includes(componentFamily(type, PART_STATS[type])), `${type} has a known family`);
    }
  });

  check("every catalogue component builds a complete, well-formed model", () => {
    for (const type of Object.keys(PART_STATS)) {
      const stat = PART_STATS[type];
      const model = buildComponentInspectorModel(type, stat, {
        name: (PART_DEFS[type] || PART_DEFS.frame).name,
        description: partDescription(type, stat),
        category: partCategory(type),
        effectiveCost: `$${stat.cost}`
      });
      assert.ok(model.header.name, `${type} has a name`);
      assert.ok(model.header.badge, `${type} has a badge`);
      assert.ok(Array.isArray(model.core) && model.core.length >= 3, `${type} has a core row`);
      const ids = allRows(model).map((row) => row.id);
      assert.equal(new Set(ids).size, ids.length, `${type} has no duplicate stat ids`);
    }
  });

  // -- 11. Authoritative values are unchanged ---------------------------------
  check("rendered values come straight from the authoritative catalogue", () => {
    const stat = PART_STATS.blaster;
    const rows = allRows(build("blaster"));
    const value = (id) => rows.find((row) => row.id === id)?.value;
    assert.equal(value("mass"), `${stat.mass} T`);
    assert.equal(value("durability"), `${stat.hp} HP`);
    assert.equal(value("power"), `${stat.powerUse} MW`);
    assert.equal(value("weapon.dps"), stat.weapon.dps.toFixed(1));
    assert.equal(value("weapon.range"), `${stat.weapon.range} m`);
    assert.equal(value("weapon.damage"), `${stat.weapon.damage} dmg`);
    assert.equal(value("weapon.fireRate"), `${stat.weapon.fireRate} shots/s`);
    assert.equal(value("weapon.arc"), `${stat.weapon.arc}°`);

    const shield = allRows(build("shield"));
    assert.equal(shield.find((row) => row.id === "shield.capacity").value, `${PART_STATS.shield.shield} SP`);
    assert.equal(shield.find((row) => row.id === "shield.regen").value, `${PART_STATS.shield.shieldRegen} SP/s`);

    const armorReduction = allRows(build("armor")).find((row) => row.id === "armor.reduction");
    assert.equal(armorReduction.value, `${PART_STATS.armor.armorFlatReduction} per hit`);
  });

  check("a cannot-miss weapon states its guarantee instead of a bare 100%", () => {
    assert.equal(PART_STATS.pointDefense.weapon.accuracy, 1, "fixture assumption: Point Defence cannot miss");
    const accuracy = build("pointDefense").capability.find((row) => row.id === "weapon.accuracy");
    assert.equal(accuracy.value, "Cannot miss");
  });

  // -- 12. Ledger primitive ---------------------------------------------------
  check("StatLedger drops repeats and keeps first occurrences", () => {
    const ledger = new StatLedger();
    const first = ledger.take([statRow("a", "A", "1"), statRow("b", "B", "2"), null]);
    assert.deepEqual(first.map((row) => row.id), ["a", "b"]);
    const second = ledger.take([statRow("b", "B again", "3"), statRow("c", "C", "4")]);
    assert.deepEqual(second.map((row) => row.id), ["c"], "an already-seen id is dropped");
    assert.equal(ledger.has("a"), true);
    assert.equal(ledger.has("z"), false);
  });

  console.log(`\nComponent inspector checks: ${passed}/${passed} passed`);
  console.log("Component inspector information-architecture verification passed");
})().catch((error) => { console.error(error); process.exit(1); });
