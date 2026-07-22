const fs = require('fs');
const assert = require('assert');
const index = fs.readFileSync('public/index.html','utf8');
const parts = fs.readFileSync('public/src/design/parts.js','utf8');
const inspector = fs.readFileSync('public/src/ui/partInspectorUi.js','utf8');
assert(index.includes('switchgearRules.js'), 'browser loads shared Switchgear rules');
assert(parts.includes('switchgear: { name: "Switchgear"'), 'palette has Switchgear definition');
assert(parts.includes('Power switchgear'), 'Switchgear has discoverable description');
assert(inspector.includes('data-switchgear-config') && inspector.includes('blueprint-switchgear-config'), 'inspector exposes interactive mode/rating controls');
assert(inspector.includes('Default mode') && inspector.includes('Terminal orientation') && inspector.includes('Data wiring'), 'inspector documents mode, orientation and data isolation');
console.log('verify-switchgear-ui-browser passed');

const designer = fs.readFileSync('public/src/ui/designerUi.js','utf8');
assert(designer.includes('configureSelectedSwitchgear') && designer.includes('switchgearMode') && designer.includes('switchgearRatingTier'), 'designer commits Switchgear controls through Blueprint edit path');

const merge = fs.readFileSync('public/src/snapshotMerge.js','utf8');
assert(merge.includes('\"switchgear\"'), 'snapshot merge preserves Switchgear diagnostics when compact deltas omit them');
const damagePanel = fs.readFileSync('public/src/ui/shipDamagePanelUi.js','utf8');
assert(damagePanel.includes('switchgearSummaryText') && damagePanel.includes('ship.switchgear'), 'selected-ship diagnostics render Switchgear summaries');
