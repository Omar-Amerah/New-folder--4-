'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const panel = fs.readFileSync(path.join(path.dirname(__dirname), 'public/src/ui/shipDamagePanelUi.js'), 'utf8');

let count = 0;
function check(name, fn) { fn(); count += 1; console.log('  ok ' + count + '. ' + name); }

function fnBody(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, 'marker present: ' + marker);
  let depth = 0;
  let i = source.indexOf('{', start);
  const from = i;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return source.slice(from);
}

check('parse shipDamagePanelUi.js and extract renderPowerSummary', () => {
  const body = fnBody(panel, 'function renderPowerSummary');
  assert(body.includes('summary.innerHTML = `'), 'Power summary HTML is assigned to summary.innerHTML');
});

check('moreIssuesMarkup ternary ends with an empty fallback and preserves open state', () => {
  const body = fnBody(panel, 'function renderPowerSummary');
  assert(body.includes('const moreIssuesMarkup = hiddenIssues.length'), 'moreIssuesMarkup is declared');
  assert(body.includes('""'), 'empty fallback string is present');
  assert(body.includes('moreIssuesOpen'), 'open state is read before rerendering');
  assert(body.includes(' open'), 'details element toggles open attribute');
});

check('Power summary renders healthy no-issues state', () => {
  const body = fnBody(panel, 'function renderPowerSummary');
  assert(body.includes('No Power issues detected'), 'healthy state markup present');
  assert(body.includes('slice(0, 3)'), 'visible issue cap present');
});

check('Power summary renders more than three issues behind a details element', () => {
  const body = fnBody(panel, 'function renderPowerSummary');
  assert(body.includes('power-more-issues'), 'details element class present');
  assert(body.includes('hiddenIssues.map(powerIssueHtml).join'), 'hidden issues are rendered');
});

check('Power summary handles unavailable cable Heat before numeric comparisons', () => {
  const body = fnBody(panel, 'function renderPowerSummary');
  assert(body.includes('cableHeat === null ?'), 'cableHeat null branch present');
  assert(body.includes('Unavailable'), 'unavailable cable Heat label present');
  assert(body.includes('cableHeat !== null && cableHeat > 0'), 'hottest cable guarded by null check');
});

check('Power summary shows stressed and hot cable details', () => {
  const body = fnBody(panel, 'function renderPowerSummary');
  assert(body.includes('Most stressed: ${escapeHtml(mostStressedSectionText(pp))}'), 'most stressed section detail present');
  assert(body.includes('Hottest cable: ${escapeHtml(pt.hottestSectionId)}'), 'hottest cable detail present');
  assert(body.includes('Cable Heat: <strong>'), 'cable heat value row present');
});

check('Power summary shows network, broken and overloaded diagnostics', () => {
  const body = fnBody(panel, 'function renderPowerSummary');
  assert(body.includes('Distribution'), 'distribution heading present');
  assert(body.includes('network'), 'network count present');
  assert(body.includes('broken/disabled'), 'broken/disabled count present');
  assert(body.includes('overloaded'), 'overloaded count present');
});

check('Dynamic IDs and labels are escaped', () => {
  const body = fnBody(panel, 'function renderPowerSummary');
  assert(body.includes('escapeHtml(overall.key)'), 'overall key escaped for class name');
  assert(body.includes('escapeHtml(overall.icon)'), 'overall icon escaped');
  assert(body.includes('escapeHtml(overall.label)'), 'overall label escaped');
  assert(body.includes('escapeHtml(overall.explanation)'), 'overall explanation escaped');
  const issueBody = fnBody(panel, 'function powerIssueHtml');
  assert(issueBody.includes('escapeHtml(issue.sectionId)'), 'section id escaped in locate action');
});

console.log('');
console.log('Power summary source verification passed (' + count + ' checks).');
