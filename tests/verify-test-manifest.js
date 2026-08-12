"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { TEST_MANIFEST, SMOKE_TESTS } = require("../tools/test-manifest");

const ROOT = path.join(__dirname, "..");
const EXPECTED_CATEGORIES = [
  "unit",
  "integration",
  "protocol",
  "browser",
  "server-soak",
  "renderer-soak",
  "helper"
];

assert.deepStrictEqual(Object.keys(TEST_MANIFEST), EXPECTED_CATEGORIES, "test manifest categories changed without updating the registration contract");

const registered = [];
for (const [category, scripts] of Object.entries(TEST_MANIFEST)) {
  assert(Object.isFrozen(scripts), `${category} classification must be frozen`);
  for (const script of scripts) {
    assert.match(script, /^tests\/verify-[a-z0-9-]+\.js$/, `${script} is not a verify script path`);
    assert(fs.existsSync(path.join(ROOT, script)), `${script} is registered but missing`);
    registered.push(script);
  }
}

const duplicates = registered.filter((script, index) => registered.indexOf(script) !== index);
assert.deepStrictEqual([...new Set(duplicates)], [], `verify scripts classified more than once: ${duplicates.join(", ")}`);

const discovered = fs.readdirSync(path.join(ROOT, "tests"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && /^verify-.*\.js$/.test(entry.name))
  .map((entry) => `tests/${entry.name}`)
  .sort();
assert.deepStrictEqual(registered.slice().sort(), discovered, "every tests/verify-*.js file must be classified exactly once in tools/test-manifest.js");

for (const script of SMOKE_TESTS) {
  assert(TEST_MANIFEST.integration.includes(script), `${script} smoke test must be classified as integration`);
}

assert(Object.isFrozen(TEST_MANIFEST), "test manifest must be frozen");
console.log(`test manifest verification passed (${discovered.length} files; ${TEST_MANIFEST.helper.length} helpers)`);
