// Loads and validates the authoritative gameplay balance file.

const fs = require("fs");
const path = require("path");
const { assertValidComponentBalance } = require("./componentSchema");

const COMPONENT_BALANCE_PATH = path.join(__dirname, "..", "..", "component-balance.json");

function loadRawBalance(filePath = COMPONENT_BALANCE_PATH) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to load component-balance.json from ${filePath}: ${error.message}`);
  }
}

function loadBalance(filePath = COMPONENT_BALANCE_PATH) {
  return assertValidComponentBalance(loadRawBalance(filePath), { filePath });
}

const BALANCE = loadBalance();

module.exports = { COMPONENT_BALANCE_PATH, BALANCE, loadBalance };
