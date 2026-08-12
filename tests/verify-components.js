const fs = require('fs');
const assert = require('node:assert/strict');
const { COMPONENT_BALANCE_PATH } = require('../src/server/config');
const { validateComponentBalance } = require('../src/server/componentSchema');

const balance = JSON.parse(fs.readFileSync(COMPONENT_BALANCE_PATH, 'utf8'));
const result = validateComponentBalance(balance, { filePath: COMPONENT_BALANCE_PATH });
if (!result.ok) {
  console.error(result.errors.join('\n'));
  process.exit(1);
}
const fractional = structuredClone(balance);
fractional.components[0].cost += 0.5;
const fractionalResult = validateComponentBalance(fractional, { filePath: COMPONENT_BALANCE_PATH });
assert.equal(fractionalResult.ok, false, 'fractional component costs are rejected');
assert(fractionalResult.errors.some((error) => /cost must be a non-negative integer/.test(error)), 'fractional cost error is explicit');
console.log(`Component schema verification passed (${balance.components.length} components)`);
