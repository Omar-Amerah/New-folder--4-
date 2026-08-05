const fs = require('fs');
const { COMPONENT_BALANCE_PATH } = require('./src/server/config');
const { validateComponentBalance } = require('./src/server/componentSchema');

const balance = JSON.parse(fs.readFileSync(COMPONENT_BALANCE_PATH, 'utf8'));
const result = validateComponentBalance(balance, { filePath: COMPONENT_BALANCE_PATH });
if (!result.ok) {
  console.error(result.errors.join('\n'));
  process.exit(1);
}
console.log(`Component schema verification passed (${balance.components.length} components)`);
