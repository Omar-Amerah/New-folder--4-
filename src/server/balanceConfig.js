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

// Authoritative gameplay-balance revision advertised to clients so a frontend
// built from different balance data can detect the mismatch and refuse combat.
const { computeBalanceRevision } = require("../../public/src/shared/balanceRevision");
const BALANCE_REVISION = computeBalanceRevision(BALANCE);

module.exports = { COMPONENT_BALANCE_PATH, BALANCE, BALANCE_REVISION, loadBalance };
