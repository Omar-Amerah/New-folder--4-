#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { loadBalance } = require('../src/server/balanceConfig');
const root = path.join(__dirname, '..');
const balancePath = path.join(root, 'component-balance.json');
const publicPath = path.join(root, 'public', 'component-balance.json');
const required = ['metadata','components','shipPricing','economy','rewards','match','movement','projectiles','missileGuidance','fleetLimits','capture','repair'];
const balance = loadBalance(balancePath);
for (const key of required) if (balance[key] === undefined) throw new Error(`Missing required balance section: ${key}`);
if (fs.existsSync(publicPath) && fs.readFileSync(publicPath,'utf8') !== fs.readFileSync(balancePath,'utf8')) throw new Error('public/component-balance.json does not match root component-balance.json; run npm run build.');
const forbidden = [];
for (const file of ['src/server/components.js','public/src/design/parts.js','public/src/constants.js']) {
  const text = fs.readFileSync(path.join(root,file),'utf8');
  if (/FALLBACK_PARTS\s*=\s*Object\.freeze\(\{\s*[a-zA-Z]/.test(text) || /FALLBACK_PART_STATS\s*=\s*\{\s*[a-zA-Z]/.test(text)) forbidden.push(file);
  if (file.endsWith('constants.js') && /baseShipCost:\s*\d/.test(text)) forbidden.push(file);
}
if (forbidden.length) throw new Error(`Duplicated authoritative balance constants found in: ${forbidden.join(', ')}`);
console.log(`Balance check passed: ${balance.components.length} components, ${required.length} required sections.`);
