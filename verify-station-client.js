// Client-side verification for station infrastructure mode: lobby control,
// snapshot merge of static station geometry, station selection, the inspection
// panel, and the renderer's station colour/label rules. Classic rooms must show
// no station affordances at all.

import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.localStorage = globalThis.localStorage || { getItem() { return null; }, setItem() {}, removeItem() {} };

// A DOM stub rich enough for the station panel: it only needs id lookup,
// hidden, textContent and innerHTML.
const elements = new Map();
const fakeElement = (id) => ({
  id,
  textContent: '',
  innerHTML: '',
  hidden: false,
  style: { setProperty() {} },
  classList: { add() {}, remove() {}, toggle() {} },
  replaceChildren() {}, append() {}, addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; }
});
globalThis.document = globalThis.document || {
  getElementById: (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  body: null,
  addEventListener() {}, removeEventListener() {},
  activeElement: null,
  visibilityState: 'visible'
};
globalThis.window = globalThis.window || { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };

// --- Lobby control -----------------------------------------------------------
const html = fs.readFileSync('public/index.html', 'utf8');
const lobbyJs = fs.readFileSync('public/src/ui/lobbyUi.js', 'utf8');
const mainJs = fs.readFileSync('public/src/main.js', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');

assert(html.includes('<label for="infrastructureModeSelect">'), 'Infrastructure selector has an associated <label>');
assert(html.includes('<option value="classic">Classic</option>'), 'Classic infrastructure option exists');
assert(html.includes('<option value="stations" selected>Stations</option>'), 'Stations infrastructure option exists and is selected by default');
assert(html.includes('id="stationPanel"'), 'Station inspection panel exists in the arena markup');
assert(html.includes('id="stationPanelBody"'), 'Station panel has a body container');
assert(html.includes('id="stationPanelFocus"'), 'Station panel can centre the view on its station');
assert(mainJs.includes('dom.stationPanelFocus?.addEventListener'), 'Focus button is wired');
assert(css.includes('.station-panel'), 'Station panel is styled');
assert(css.includes('.station-queue'), 'Station production queue is styled');
assert(lobbyJs.includes('infrastructureMode'), 'Lobby rules payload carries infrastructureMode');
assert(lobbyJs.includes('<dt>Infrastructure</dt>'), 'Read-only rules show the infrastructure mode');
assert(mainJs.includes('dom.infrastructureModeSelect?.addEventListener'), 'Infrastructure selector pushes rule updates');

const { dom } = await import('./public/src/ui/dom.js');
assert(dom.infrastructureModeSelect, 'Infrastructure selector is registered in the DOM map');
assert(dom.stationPanel && dom.stationPanelBody && dom.stationPanelKind, 'Station panel elements are registered');

// --- Snapshot merge ----------------------------------------------------------
const { mergeCachedStationFields, mergeCompactSnapshot } = await import('./public/src/snapshotMerge.js');

const previousStations = [{
  id: 'st1',
  stationType: 'home',
  design: [{ x: 0, y: 0, type: 'core' }, { x: 1, y: 0, type: 'laser' }],
  hangar: { x: 1, y: 2 },
  hardpoints: [null, { x: 36, y: 0 }],
  moduleScale: 36,
  weaponAngles: [0, 0],
  componentHp: [100, 50],
  hp: 100
}];
const compactStations = [{
  id: 'st1',
  stationType: 'home',
  hp: 80,
  healthRevision: 2,
  weaponAnglePairs: [1, 0.75],
  productionQueue: []
}];
const merged = mergeCachedStationFields(previousStations, compactStations);
assert.deepEqual(merged[0].design, previousStations[0].design, 'compact station inherits the cached design');
assert.deepEqual(merged[0].hangar, previousStations[0].hangar, 'compact station inherits the cached hangar');
assert.deepEqual(merged[0].hardpoints, previousStations[0].hardpoints, 'compact station inherits cached hardpoints');
assert.equal(merged[0].moduleScale, 36, 'compact station inherits cached module scale');
assert.deepEqual(merged[0].weaponAngles, [0, 0.75], 'compact station applies sparse authoritative turret bearings');
assert.deepEqual(merged[0].componentHp, previousStations[0].componentHp, 'unchanged station health inherits its baseline');
assert.equal(merged[0].weaponAnglePairs, undefined, 'wire-only sparse bearing data is removed after merge');
assert.equal(merged[0].hp, 80, 'live station fields come from the compact snapshot');

const damaged = mergeCachedStationFields(previousStations, [{
  ...compactStations[0],
  componentHp: [80, 0]
}]);
assert.deepEqual(damaged[0].componentHp, [80, 0], 'a changed health revision replaces cached component health');

const redacted = mergeCachedStationFields(previousStations, [{
  ...compactStations[0],
  conditionKnown: false
}]);
assert.equal(redacted[0].componentHp, undefined, 'fog redaction clears cached station condition');
assert.deepEqual(redacted[0].design, previousStations[0].design, 'fog redaction retains public station geometry');

const unknown = mergeCachedStationFields(previousStations, [{ id: 'st2', stationType: 'relay', hp: 50 }]);
assert.equal(unknown[0].design, undefined, 'a station with no baseline gains no invented geometry');

const compactMerge = mergeCompactSnapshot(
  { players: [], ships: [], stations: previousStations, world: {}, map: {}, rules: {}, mapSizeLabel: 'Duel' },
  { type: 'state', snapshotKind: 'compact', players: [], ships: [], stations: compactStations }
);
assert(compactMerge.ok, 'compact merge with stations succeeds');
assert.deepEqual(compactMerge.snapshot.stations[0].design, previousStations[0].design, 'merged snapshot carries station geometry forward');

const classicMerge = mergeCompactSnapshot(
  { players: [], ships: [], world: {}, map: {}, rules: {}, mapSizeLabel: 'Duel' },
  { type: 'state', snapshotKind: 'compact', players: [], ships: [] }
);
assert.equal(classicMerge.snapshot.stations, undefined, 'classic snapshots stay free of a stations field');

// --- Selection ---------------------------------------------------------------
const { state } = await import('./public/src/state.js');
const selection = await import('./public/src/game/selection.js');

function resetState() {
  state.myId = 'p1';
  state.selectedShipIds = new Set();
  state.selectedStationId = null;
  state.activeShipGroup = null;
  state.visualShips = new Map();
  state.rules = { ...state.rules, infrastructureMode: 'stations', gameMode: 'teams' };
  state.mine = { id: 'p1', team: 'blue' };
  state.snapshot = {
    players: [{ id: 'p1', name: 'Me', team: 'blue' }, { id: 'p2', name: 'Foe', team: 'red' }],
    points: [],
    ships: [{ id: 'own-a', ownerId: 'p1', alive: true, x: 100, y: 100, radius: 20 }],
    stations: [
      {
        id: 'st-home', stationType: 'home', team: 'blue', ownerId: 'p1', state: 'operational',
        x: 600, y: 600, angle: 0, radius: 120, hp: 900, maxHp: 1000, shield: 40, maxShield: 80,
        productionQueue: [{ id: 'q1', playerId: 'p1', state: 'building', quantityRemaining: 2, progress: 0.5 }]
      },
      {
        id: 'st-relay', stationType: 'relay', team: null, ownerId: null, state: 'neutral',
        x: 1200, y: 600, angle: 0, radius: 60, hp: 400, maxHp: 400, shield: 0, maxShield: 0
      }
    ]
  };
}

assert.equal(state.rules.infrastructureMode !== undefined, true, 'client rules default carries an infrastructure mode');

const { commandTargetAt } = await import('./public/src/game/commands.js');
resetState();
state.snapshot.stations[1] = {
  ...state.snapshot.stations[1],
  ownerId: 'p2',
  team: 'red',
  state: 'controlled'
};
const relayCommandTarget = commandTargetAt({ x: 1200, y: 600 }, ['own-a']);
assert.equal(relayCommandTarget.entity?.id, 'st-relay', 'right-click targeting resolves a hostile relay station');
assert.equal(relayCommandTarget.kind, 'hostile', 'a hostile relay receives the attack command marker');

resetState();
assert.equal(selection.findStationAt(600, 600)?.id, 'st-home', 'a click inside the station radius finds it');
assert.equal(selection.findStationAt(4000, 4000), null, 'a click in empty space finds no station');

selection.selectAt({ x: 600, y: 600 }, false);
assert.equal(state.selectedStationId, 'st-home', 'clicking a station inspects it');
assert.deepEqual([...state.selectedShipIds], [], 'a station never joins the commandable ship selection');

selection.selectAt({ x: 600, y: 600 }, true);
assert.equal(state.selectedStationId, null, 'shift-clicking the inspected station clears it');

selection.selectAt({ x: 1200, y: 600 }, false);
assert.equal(state.selectedStationId, 'st-relay', 'relays are inspectable too');
selection.selectAt({ x: 4000, y: 4000 }, false);
assert.equal(state.selectedStationId, null, 'clicking empty space clears the station selection');

resetState();
state.visualShips.set('own-a', { x: 100, y: 100, angle: 0 });
state.snapshot.stations[0].x = 100;
state.snapshot.stations[0].y = 100;
selection.selectAt({ x: 100, y: 100 }, false);
assert.deepEqual([...state.selectedShipIds], ['own-a'], 'an overlapping own ship wins the click');
assert.equal(state.selectedStationId, null, 'a ship click does not also inspect the station beneath it');

resetState();
selection.selectAt({ x: 600, y: 600 }, false);
selection.selectBox({ x: 0, y: 0 }, { x: 50, y: 50 }, false);
assert.equal(state.selectedStationId, null, 'a fresh drag-select clears the inspected station');

resetState();
selection.selectAt({ x: 600, y: 600 }, false);
state.snapshot = { ...state.snapshot, stations: [] };
assert.equal(selection.pruneStationSelection(), true, 'a vanished station is pruned');
assert.equal(state.selectedStationId, null, 'pruning clears the inspected station');

resetState();
selection.selectAt({ x: 600, y: 600 }, false);
selection.resetSelectionForEpoch();
assert.equal(state.selectedStationId, null, 'an epoch reset clears the inspected station');

// --- Inspection panel --------------------------------------------------------
const { renderStationPanel, panelStation, ownHomeStation } = await import('./public/src/ui/stationPanelUi.js');

resetState();
renderStationPanel();
assert.equal(dom.stationPanel.hidden, false, 'the panel defaults to your own home station with nothing selected');
assert.equal(panelStation()?.id, 'st-home', 'the default subject is your home station');
assert.equal(ownHomeStation()?.id, 'st-home', 'your home station is resolved by team');
assert.equal(dom.stationPanelKind.textContent, 'Your Home Station', 'the default subject is labelled as yours');
assert(dom.stationPanelBody.innerHTML.includes('Hangar'), 'the default panel shows the hangar');

resetState();
state.snapshot = { ...state.snapshot, stations: state.snapshot.stations.filter((s) => s.stationType === 'relay') };
renderStationPanel();
assert.equal(dom.stationPanel.hidden, true, 'the panel hides when you have no home station and nothing is selected');

resetState();
selection.selectAt({ x: 600, y: 600 }, false);
renderStationPanel();
assert.equal(dom.stationPanel.hidden, false, 'selecting a station reveals the panel');
assert.equal(dom.stationPanelKind.textContent, 'Your Home Station', 'the panel names the station type');
assert(dom.stationPanelBody.innerHTML.includes('Operational'), 'the panel shows the operational state');
assert(dom.stationPanelBody.innerHTML.includes('<strong>900</strong><small>/ 1000</small>'), 'the panel shows hull vitals');
assert(dom.stationPanelBody.innerHTML.includes('<strong>40</strong><small>/ 80</small>'), 'the panel shows shield vitals');
assert(dom.stationPanelBody.innerHTML.includes('Building'), 'the panel shows what the hangar is building');
assert(dom.stationPanelBody.innerHTML.includes('50%'), 'the panel shows build progress');
assert(dom.stationPanelBody.innerHTML.includes('You'), 'the panel attributes the build to its owner');
assert(dom.stationPanelBody.innerHTML.includes('--station-meter-start:#062f17'), 'healthy station hulls use the green ship-hull palette');
assert(dom.stationPanelBody.innerHTML.includes('--station-meter-start:#fbbf24'), 'half-strength station shields use the amber ship-shield palette');
assert(!dom.stationPanelBody.innerHTML.includes('Everything you buy'), 'the home-station description is removed');

selection.selectAt({ x: 1200, y: 600 }, false);
renderStationPanel();
assert.equal(dom.stationPanelKind.textContent, 'Relay Station', 'relay stations are labelled as such');
assert(dom.stationPanelBody.innerHTML.includes('Unclaimed'), 'a neutral relay reads as unclaimed');
assert(!dom.stationPanelBody.innerHTML.includes('Hangar'), 'relays have no hangar section');
assert(!dom.stationPanelBody.innerHTML.includes('Bring ships inside'), 'the relay description is removed');

state.rules = { ...state.rules, infrastructureMode: 'classic' };
renderStationPanel();
assert.equal(dom.stationPanel.hidden, true, 'the panel never appears in a classic room');

// --- Renderer ----------------------------------------------------------------
const { stationColor, stationStateLabel } = await import('./public/src/game/pixi/pixiStations.js');

resetState();
const [home, relay] = state.snapshot.stations;
const players = new Map(state.snapshot.players.map((p) => [p.id, p]));
assert.equal(stationColor(home, players), '#38d5ff', 'an allied station renders friendly');
assert.equal(stationColor({ ...home, team: 'red', ownerId: 'p2' }, players), '#ef4444', 'an enemy station renders hostile');
assert.equal(stationColor(relay, players), '#9fb0c6', 'a neutral relay renders unclaimed');
assert.equal(stationStateLabel(home), 'OPERATIONAL', 'operational home stations are labelled');
assert.equal(stationStateLabel({ ...home, state: 'disabled' }), 'DISABLED', 'disabled stations are labelled');
// An uncaptured relay is not running for anybody, so it reads OFFLINE rather
// than describing its ownership.
assert.equal(stationStateLabel(relay), 'OFFLINE', 'neutral relays read as offline');
// A station the sensor snapshot only knows structurally must not claim ONLINE:
// its condition was deliberately withheld.
assert.equal(stationStateLabel({ ...relay, state: 'unknown' }), 'UNSCANNED', 'sensor-stub stations do not claim a condition');
assert.equal(
  stationStateLabel({ ...relay, state: 'controlled', team: 'red', ownerId: 'p2' }),
  'CONTROLLED',
  'a hidden captured relay reports public control instead of unscanned'
);
assert.equal(
  stationStateLabel({ ...relay, state: 'unknown', team: 'red', ownerId: 'p2' }),
  'CONTROLLED',
  'legacy hidden captured relay snapshots also avoid the unscanned label'
);

// The hangar build bar. Builds are sub-second for a light hull, so this is
// checked by driving the drawing directly rather than trying to photograph it.
{
  const { drawProductionBar } = await import('./public/src/game/pixi/pixiStations.js');
  const record = () => {
    const calls = [];
    const gfx = {};
    for (const method of ['rect', 'moveTo', 'lineTo', 'fill', 'stroke', 'circle', 'arc', 'closePath', 'regularPoly']) {
      gfx[method] = (...args) => { calls.push({ method, args }); return gfx; };
    }
    return { gfx, calls };
  };

  const idle = record();
  drawProductionBar(idle.gfx, -50, 0, 100, 8, 1, 0);
  assert.equal(idle.calls.length, 0, 'an idle hangar draws no build bar at all');

  const mid = record();
  drawProductionBar(mid.gfx, -50, 0, 100, 8, 1, 0.42);
  const rects = mid.calls.filter((c) => c.method === 'rect');
  assert(rects.length >= 4, 'a running build draws a track, a fill, a run-up and a leading edge');
  const track = rects[0];
  assert.equal(track.args[2], 100, 'the track spans the full bar width');
  const fill = rects[1];
  assert(Math.abs(fill.args[2] - 42) < 0.001, 'the fill width follows progress');
  assert(mid.calls.some((c) => c.method === 'moveTo'), 'segment ticks are drawn for the fill to travel past');

  // At 100% there is no leading edge to draw — the bar is simply full.
  const done = record();
  drawProductionBar(done.gfx, -50, 0, 100, 8, 1, 1);
  const doneRects = done.calls.filter((c) => c.method === 'rect');
  assert(doneRects.length < rects.length, 'a finished build drops the leading edge');
  assert(Math.abs(doneRects[1].args[2] - 100) < 0.001, 'a finished build fills the bar');
}

const rendererJs = fs.readFileSync('public/src/game/pixi/pixiRenderer.js', 'utf8');
assert(rendererJs.includes('stations: new PIXI.Container()'), 'the renderer owns a dedicated stations layer');
assert(rendererJs.includes('worldRoot.addChild(layers.stations)'), 'the stations layer is in the world draw order');
assert(rendererJs.indexOf('worldRoot.addChild(layers.stations)') < rendererJs.indexOf('worldRoot.addChild(layers.ships)'), 'stations draw beneath ships');
assert(rendererJs.includes('updatePixiStations'), 'stations are updated every frame');
assert(rendererJs.includes('destroyPixiStations'), 'the station pool is torn down with the renderer');

console.log('Station infrastructure client verification passed');
