"use strict";

const fs = require("fs");

const packageJsonPath = "package.json";
const source = fs.readFileSync(packageJsonPath, "utf8");

function fail(message) {
  console.error(`package.json verification failed: ${message}`);
  process.exit(1);
}

function readJsonString(text, index) {
  let value = "";
  let escaped = false;
  for (let i = index + 1; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') return { value, end: i };
    value += char;
  }
  fail("unterminated string while scanning scripts object");
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  fail("unterminated scripts object");
}

function extractScriptsObjectText(text) {
  const scriptsKey = text.match(/"scripts"\s*:/);
  if (!scriptsKey) fail("missing top-level scripts object");
  const openIndex = text.indexOf("{", scriptsKey.index + scriptsKey[0].length);
  if (openIndex === -1) fail("scripts is not an object");
  const closeIndex = findMatchingBrace(text, openIndex);
  return text.slice(openIndex + 1, closeIndex);
}

function scanScriptKeys(scriptsText) {
  const keys = [];
  let depth = 0;
  let expectingKey = true;
  for (let i = 0; i < scriptsText.length; i += 1) {
    const char = scriptsText[i];
    if (char === '"') {
      const parsed = readJsonString(scriptsText, i);
      if (depth === 0 && expectingKey) {
        let j = parsed.end + 1;
        while (/\s/.test(scriptsText[j] || "")) j += 1;
        if (scriptsText[j] === ":") {
          keys.push(parsed.value);
          expectingKey = false;
          i = j;
          continue;
        }
      }
      i = parsed.end;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (depth === 0 && char === ",") expectingKey = true;
  }
  return keys;
}

const scriptKeys = scanScriptKeys(extractScriptsObjectText(source));
const duplicates = [...new Set(scriptKeys.filter((key, index) => scriptKeys.indexOf(key) !== index))];
if (duplicates.length > 0) fail(`duplicate script key(s): ${duplicates.join(", ")}`);

let packageJson;
try {
  packageJson = JSON.parse(source);
} catch (error) {
  fail(`invalid JSON: ${error.message}`);
}

if (!packageJson.scripts || typeof packageJson.scripts !== "object" || Array.isArray(packageJson.scripts)) {
  fail("scripts must be an object");
}

const allNonBrowserCount = scriptKeys.filter((key) => key === "test:all-non-browser").length;
if (allNonBrowserCount !== 1) fail(`expected exactly one test:all-non-browser script, found ${allNonBrowserCount}`);

const requiredAllNonBrowserParts = [
  "npm run test:shield-impact-heat",
  "npm run test:support-semantics",
  "npm run test:armor-delivery",
  "node tools/run-tests.js all-non-browser",
  "npm run test:ship-hull-outline"
];
const allNonBrowser = packageJson.scripts["test:all-non-browser"];
for (const part of requiredAllNonBrowserParts) {
  if (!allNonBrowser.includes(part)) fail(`test:all-non-browser is missing ${part}`);
}

const requiredScripts = [
  "test:shield-impact-heat",
  "test:support-semantics",
  "test:armor-delivery",
  "test:ship-hull-outline"
];
for (const script of requiredScripts) {
  if (!Object.prototype.hasOwnProperty.call(packageJson.scripts, script)) fail(`missing script ${script}`);
}

console.log("package.json verification passed");
