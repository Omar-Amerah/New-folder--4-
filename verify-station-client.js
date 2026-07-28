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
assert(html.includes('<option value="stations">Stations</option>'), 'Stations infrastructure option exists');
assert(html.includes('id="stationPanel"'), 'Station inspection panel exists in the arena markup');
assert(html.includes('id="stationPanelBody"'), 'Station panel has a body container');
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

const previousStations = [{ id: 'st1', stationType: 'home', design: [{ x: 0, y: 0, type: 'core' }], hangar: { x: 1, y: 2 }, hp: 100 }];
const compactStations = [{ id: 'st1', stationType: 'home', hp: 80, productionQueue: [] }];
const merged = mergeCachedStationFields(previousStations, compactStations);
assert.deepEqual(merged[0].design, previousStations[0].design, 'compact station inherits the cached design');
assert.deepEqual(merged[0].hangar, previousStations[0].hangar, 'compact station inherits the cached hangar');
assert.equal(merged[0].hp, 80, 'live station fields come from the compact snapshot');

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
const { renderStationPanel } = await import('./public/src/ui/stationPanelUi.js');

resetState();
renderStationPanel();
assert.equal(dom.stationPanel.hidden, true, 'the panel stays hidden with nothing selected');

selection.selectAt({ x: 600, y: 600 }, false);
renderStationPanel();
assert.equal(dom.stationPanel.hidden, false, 'selecting a station reveals the panel');
assert.equal(dom.stationPanelKind.textContent, 'Home Station', 'the panel names the station type');
assert(dom.stationPanelBody.innerHTML.includes('Operational'), 'the panel shows the operational state');
assert(dom.stationPanelBody.innerHTML.includes('900 / 1000'), 'the panel shows hull vitals');
assert(dom.stationPanelBody.innerHTML.includes('40 / 80'), 'the panel shows shield vitals');
assert(dom.stationPanelBody.innerHTML.includes('Building'), 'the panel shows what the hangar is building');
assert(dom.stationPanelBody.innerHTML.includes('50%'), 'the panel shows build progress');
assert(dom.stationPanelBody.innerHTML.includes('You'), 'the panel attributes the build to its owner');

selection.selectAt({ x: 1200, y: 600 }, false);
renderStationPanel();
assert.equal(dom.stationPanelKind.textContent, 'Relay Station', 'relay stations are labelled as such');
assert(dom.stationPanelBody.innerHTML.includes('Unclaimed'), 'a neutral relay reads as unclaimed');
assert(!dom.stationPanelBody.innerHTML.includes('Production'), 'relays have no production section');

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
assert.equal(stationStateLabel(relay), 'UNCLAIMED', 'neutral relays are labelled');

const rendererJs = fs.readFileSync('public/src/game/pixi/pixiRenderer.js', 'utf8');
assert(rendererJs.includes('stations: new PIXI.Container()'), 'the renderer owns a dedicated stations layer');
assert(rendererJs.includes('worldRoot.addChild(layers.stations)'), 'the stations layer is in the world draw order');
assert(rendererJs.indexOf('worldRoot.addChild(layers.stations)') < rendererJs.indexOf('worldRoot.addChild(layers.ships)'), 'stations draw beneath ships');
assert(rendererJs.includes('updatePixiStations'), 'stations are updated every frame');
assert(rendererJs.includes('destroyPixiStations'), 'the station pool is torn down with the renderer');

console.log('Station infrastructure client verification passed');
