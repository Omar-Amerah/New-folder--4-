#!/usr/bin/env node
const assert = require('node:assert/strict');
const { validateDesign } = require('./src/server/shipDesign.js');

(async () => {
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null };
  globalThis.window = globalThis;
  globalThis.EngineExhaustRules = (await import('./public/src/shared/engineExhaust.js')).default || (await import('./public/src/shared/engineExhaust.js'));
  await import('./public/src/shared/wiringRules.js');
  const { validateBlueprint } = await import('./public/src/design/blueprintValidation.js');
  const { normalizeDesignDetailed, defaultDesign } = await import('./public/src/design/blueprintStorage.js');
  const { computeStats } = await import('./public/src/design/componentStats.js');
  const valid = defaultDesign();
  const noEngine = valid.filter(p => p.type !== 'engine');
  const fixtures = [
    ['valid ship', valid],
    ['empty design', []],
    ['missing core', valid.filter(p => p.type !== 'core')],
    ['multiple cores', [...valid, { x: 10, y: 10, type: 'core' }]],
    ['unknown module type', [{ x: 7, y: 7, type: 'core' }, { x: 7, y: 8, type: 'engine' }, { x: 6, y: 7, type: 'nope' }]],
    ['non-numeric coordinate', [{ x: 7, y: 7, type: 'core' }, { x: 'x', y: 8, type: 'engine' }]],
    ['out-of-bounds 1x1', [{ x: 7, y: 7, type: 'core' }, { x: 15, y: 8, type: 'engine' }]],
    ['overlapping 1x1', [{ x: 7, y: 7, type: 'core' }, { x: 7, y: 7, type: 'engine' }]],
    ['disconnected module', [{ x: 7, y: 7, type: 'core' }, { x: 7, y: 8, type: 'engine' }, { x: 0, y: 0, type: 'armor' }]],
    ['multi-cell out-of-bounds footprint', [{ x: 7, y: 7, type: 'core' }, { x: 7, y: 8, type: 'engine' }, { x: 14, y: 7, type: 'reactor' }]],
    ['multi-cell overlap', [{ x: 7, y: 7, type: 'core' }, { x: 7, y: 8, type: 'engine' }, { x: 6, y: 7, type: 'reactor' }]],
    ['valid without engine', noEngine],
    ['valid with engine', valid]
  ];
  for (const [name, design] of fixtures) {
    const detailed = normalizeDesignDetailed(design, { allowEmpty: true });
    const client = validateBlueprint(detailed.modules, { requireThrust: true, stats: computeStats(detailed.modules), normalizationIssues: detailed.issues });
    const server = validateDesign(design);
    assert.equal(client.ok, server.ok, `${name}: validity`);
    assert.equal(client.errors[0] || '', server.reason || '', `${name}: reason`);
  }
  const outOfBounds = fixtures.find(([name]) => name === 'multi-cell out-of-bounds footprint')[1];
  const outDetailed = normalizeDesignDetailed(outOfBounds, { allowEmpty: true });
  const outServer = validateDesign(outOfBounds);
  assert.equal(outDetailed.issues[0]?.code, 'out-of-bounds', 'client reports multi-cell out-of-bounds code');
  assert.equal(outServer.issue?.code, 'out-of-bounds', 'server reports multi-cell out-of-bounds code');
  assert.equal(outDetailed.issues[0]?.message, outServer.reason, 'multi-cell out-of-bounds first message matches');

  const overlap = fixtures.find(([name]) => name === 'multi-cell overlap')[1];
  const overlapDetailed = normalizeDesignDetailed(overlap, { allowEmpty: true });
  const overlapServer = validateDesign(overlap);
  assert.equal(overlapDetailed.issues[0]?.code, 'overlap', 'client reports multi-cell overlap code');
  assert.equal(overlapServer.issue?.code, 'overlap', 'server reports multi-cell overlap code');
  assert.equal(overlapDetailed.issues[0]?.message, overlapServer.reason, 'multi-cell overlap first message matches');

  for (const malformed of [undefined, null, {}, 'text']) {
    const malformedDetailed = normalizeDesignDetailed(malformed, { allowEmpty: true });
    assert.equal(malformedDetailed.issues[0]?.code, 'invalid-blueprint-shape', 'malformed shape reports explicit issue');
    assert.equal(malformedDetailed.modules.length, 0, 'malformed shape does not create default design');
    assert.equal(validateBlueprint(malformedDetailed.modules, { normalizationIssues: malformedDetailed.issues }).ok, false, 'malformed shape is not deployable client-side');
  }

  const invalidThenSurvivors = [{ x: 99, y: 7, type: 'armor' }, ...valid];
  const detailed = normalizeDesignDetailed(invalidThenSurvivors, { allowEmpty: true });
  assert.ok(detailed.modules.length > 0, 'client keeps safe survivors for display');
  assert.equal(validateBlueprint(detailed.modules, { normalizationIssues: detailed.issues }).ok, false, 'client rejects original');
  assert.equal(validateDesign(invalidThenSurvivors).ok, false, 'server rejects original');
  console.log('Blueprint validation parity verification passed');
})();
