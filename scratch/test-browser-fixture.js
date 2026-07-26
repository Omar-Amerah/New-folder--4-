"use strict";

const DataSupportRules = require("../public/src/shared/dataSupportRules");
const WiringRules = require("../public/src/shared/wiringRules");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");

globalThis.DataSupportRules = DataSupportRules;
globalThis.WiringRules = WiringRules;
globalThis.HeatRules = HeatRules;

const { analyzeDesignDataSupport, getCachedDataVulnerabilities } = require("../public/src/design/dataSupportAnalysis");

// Recreate the fixture from verify-data-support-browser.js lines 245-252
const mod = (type, x, y, rotation = 0) => ({ type, x, y, rotation });

const design = [
  mod("reactor", 0, 2),
  mod("fireControl", 0, 1),
  mod("signalAmplifier", 0, 0),
  mod("frame", 1, 0),
  mod("frame", 1, 1),
  mod("frame", 2, 1),
  mod("railgun", 2, 0),
  mod("frame", 3, 1),
  mod("reactor", 6, 2),
  mod("targetingComputer", 6, 1),
  mod("missile", 6, 0),
  mod("frame", 7, 0),
  mod("frame", 8, 0),
  mod("frame", 7, 1),
  mod("frame", 8, 1),
  mod("pointDefense", 9, 0)
];

let R = WiringRules;
let w = R.emptyWiring();
w = R.addPath(w, "power", [{x:0,y:2},{x:0,y:1},{x:0,y:0}], design, PARTS);
w = R.addPath(w, "power", [{x:6,y:2},{x:6,y:1},{x:6,y:0}], design, PARTS);
w = R.addPath(w, "data", [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:2,y:1},{x:2,y:0}], design, PARTS);
w = R.addPath(w, "data", [{x:0,y:1},{x:1,y:1},{x:2,y:1},{x:3,y:1}], design, PARTS);
w = R.addPath(w, "data", [{x:6,y:0},{x:7,y:0},{x:8,y:0},{x:9,y:0}], design, PARTS);
w = R.addPath(w, "data", [{x:6,y:0},{x:6,y:1},{x:7,y:1},{x:8,y:1},{x:8,y:0},{x:9,y:0}], design, PARTS);

const wiring = R.normalizeWiring(w, design, PARTS).wiring;

const analysis = analyzeDesignDataSupport(design, wiring, PARTS, { thermalLoadMode: "idle" });
const vulns = getCachedDataVulnerabilities(design, wiring, PARTS, analysis);

const sectionVulns = vulns.filter(v => v.kind === "section");
console.log("ALL SECTION VULNS:", JSON.stringify(sectionVulns, null, 2));
