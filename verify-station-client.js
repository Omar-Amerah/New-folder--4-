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
await import('./public/src/shared/featureFlags.js');

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
const { mergeCachedStationFields, mergeSnapshotTransaction } = await import('./public/src/snapshotMerge.js');
const { buildEntityDeltaSnapshot, buildStateFromSnapshot } = await import('./src/server/snapshotEntityDelta.js');

const previousStations = [{
  id: 'st1',
  stationType: 'home',
  design: [{ x: 0, y: 0, type: 'core' }, { x: 1, y: 0, type: 'laser' }],
  hangars: [
    { id: 'left', index: 0, centreY: -224, localCentre: { x: 224, y: -224 }, localNormal: { x: 1, y: 0 }, apertureHalfWidth: 84, apertureWidth: 168, corridorLength: 392 },
    { id: 'central', index: 1, centreY: 0, localCentre: { x: 224, y: 0 }, localNormal: { x: 1, y: 0 }, apertureHalfWidth: 84, apertureWidth: 168, corridorLength: 392 },
    { id: 'right', index: 2, centreY: 224, localCentre: { x: 224, y: 224 }, localNormal: { x: 1, y: 0 }, apertureHalfWidth: 84, apertureWidth: 168, corridorLength: 392 }
  ],
  hardpoints: [null, { x: 36, y: 0 }],
  moduleScale: 56,
  shieldRadius: 630,
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
assert.deepEqual(merged[0].hangars, previousStations[0].hangars, 'compact station inherits all cached launch hangar geometry');
assert.equal(merged[0].hangar, undefined, 'compact station never inherits a singular hangar field');
assert.deepEqual(merged[0].hardpoints, previousStations[0].hardpoints, 'compact station inherits cached hardpoints');
assert.equal(merged[0].moduleScale, 56, 'compact station inherits cached module scale');
assert.equal(merged[0].shieldRadius, 630, 'compact station inherits the authoritative shield hit radius');
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

const fullWire = {
  type: 'state', stateEpoch: 1, snapshotSeq: 1, snapshotKind: 'full', snapshotFormatVersion: 2,
  staticRevision: 1, players: [], ships: [], stations: previousStations,
  drones: [], decoys: [], points: [], effects: [], bullets: []
};
const fullMerge = mergeSnapshotTransaction(null, { stateEpoch: 0, snapshotSeq: 0, staticRevision: 0, hasFullBaseline: false }, fullWire);
assert(fullMerge.ok, 'entity-delta baseline merge with stations succeeds');
const compactWire = buildEntityDeltaSnapshot({
  ...fullWire, snapshotSeq: 2, snapshotKind: 'compact', baseSnapshotSeq: 1,
  stations: compactStations
}, buildStateFromSnapshot(fullWire, 1)).snapshot;
const compactMerge = mergeSnapshotTransaction(fullMerge.snapshot, fullMerge.networkState, compactWire);
assert(compactMerge.ok, compactMerge.reason);
assert.deepEqual(compactMerge.snapshot.stations[0].design, previousStations[0].design, 'entity-delta merge carries station geometry forward');
assert.equal(compactMerge.snapshot.stations[0].hangar, undefined, 'entity-delta merge retains no singular compatibility hangar');

const classicFull = { ...fullWire, stations: [] };
const classicBaseline = mergeSnapshotTransaction(null, { stateEpoch: 0, snapshotSeq: 0, staticRevision: 0, hasFullBaseline: false }, classicFull);
assert(classicBaseline.ok, 'classic entity-delta baseline merge succeeds');
assert.deepEqual(classicBaseline.snapshot.stations, [], 'classic snapshots stay free of station entities');

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
assert(dom.stationPanelBody.innerHTML.includes('Launch Hangars'), 'the default panel shows the three launch hangars');

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
assert(dom.stationPanelBody.innerHTML.includes('Building'), 'the panel shows what the launch hangars are building');
assert(dom.stationPanelBody.innerHTML.includes('50%'), 'the panel shows build progress');
assert(dom.stationPanelBody.innerHTML.includes('You'), 'the panel attributes the build to its owner');
assert(dom.stationPanelBody.innerHTML.includes('--station-meter-start:#062f17'), 'healthy station hulls use the green ship-hull palette');
assert(dom.stationPanelBody.innerHTML.includes('--station-meter-start:#fbbf24'), 'half-strength station shields use the amber ship-shield palette');
assert(!dom.stationPanelBody.innerHTML.includes('Everything you buy'), 'the home-station description is removed');

selection.selectAt({ x: 1200, y: 600 }, false);
renderStationPanel();
assert.equal(dom.stationPanelKind.textContent, 'Relay Station', 'relay stations are labelled as such');
assert(dom.stationPanelBody.innerHTML.includes('Unclaimed'), 'a neutral relay reads as unclaimed');
assert(!dom.stationPanelBody.innerHTML.includes('Central Hangar'), 'relays have no hangar section');
assert(!dom.stationPanelBody.innerHTML.includes('Bring ships inside'), 'the relay description is removed');

state.rules = { ...state.rules, infrastructureMode: 'classic' };
renderStationPanel();
assert.equal(dom.stationPanel.hidden, true, 'the panel never appears in a classic room');

// --- Renderer ----------------------------------------------------------------
const {
  stationColor,
  stationStateLabel,
  stationLocalBoundsForTest,
  stationHangarLocalForTest,
  stationHangarCoverLocalForTest,
  stationShellOutlineForTest
} = await import('./public/src/game/pixi/pixiStations.js');

resetState();
const [home, relay] = state.snapshot.stations;
const players = new Map(state.snapshot.players.map((p) => [p.id, p]));
assert.equal(stationColor(home, players), '#38d5ff', 'an allied station renders friendly');
assert.equal(stationColor({ ...home, team: 'red', ownerId: 'p2' }, players), '#ff5f7e', 'a red-team station renders the red team colour');
assert.equal(stationColor({ ...home, team: 'blue', ownerId: 'p2' }, players), '#38d5ff', 'a blue-team enemy station keeps the blue team colour');
assert.equal(stationColor(relay, players), '#9fb0c6', 'a neutral relay renders unclaimed');
assert.equal(stationStateLabel(home), 'OPERATIONAL', 'operational home stations are labelled');
assert.equal(stationStateLabel({ ...home, state: 'destroyed' }), 'DESTROYED', 'destroyed home stations are labelled');
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

// Renderer pixel-bounds proof: a full authored 15-cell station design is 840
// world units at scale 56, including when a legacy-incomplete station record
// omits moduleScale and has to use the home-station default.
const fullStationDesign = [];
for (let y = 0; y < 15; y += 1) for (let x = 0; x < 15; x += 1) fullStationDesign.push({ x, y, type: 'frame' });
const fallbackBounds = stationLocalBoundsForTest({ stationType: 'home', design: fullStationDesign });
const explicitBounds = stationLocalBoundsForTest({ stationType: 'home', moduleScale: 56, design: fullStationDesign });
assert.equal(fallbackBounds.maxX - fallbackBounds.minX, 840, 'home renderer fallback measures an 840-unit frontage');
assert.equal(fallbackBounds.maxY - fallbackBounds.minY, 840, 'home renderer fallback measures an 840-unit height');
assert.deepEqual(fallbackBounds, explicitBounds, 'home renderer fallback is identical to explicit scale 56');
const stationRendererJs = fs.readFileSync('public/src/game/pixi/pixiStations.js', 'utf8');
assert(stationRendererJs.includes('station.stationType === "home" ? 56'), 'home renderer fallback is explicitly scale 56');

const rendererStation = {
  stationType: 'home',
  moduleScale: 56,
  design: fullStationDesign,
  hangars: previousStations[0].hangars
};
const localHangar = stationHangarLocalForTest(rendererStation);
assert.equal(localHangar.length, 3, 'renderer reconstructs all three static hangars');
assert.deepEqual(localHangar.map((bay) => bay.id), ['left', 'central', 'right'], 'renderer preserves stable hangar ids');
assert.deepEqual(localHangar.map((bay) => bay.centreY), [-224, 0, 224], 'renderer preserves the three launch centrelines');
assert.equal(localHangar[0].halfWidth, 84, 'renderer preserves each three-cell aperture half-width');
assert.equal(localHangar[0].length, 392, 'renderer preserves each seven-cell corridor depth');
const hangarCovers = stationHangarCoverLocalForTest(rendererStation);
assert.equal(hangarCovers.length, 3, 'renderer creates one cosmetic cover per hangar');
for (const cover of hangarCovers) {
  assert(Math.abs((cover.coverEndX - cover.coverStartX) - cover.length * (2 / 3)) < 0.001, 'hangar cover spans the rear two-thirds of its corridor');
  assert(Math.abs((cover.coverBottomY - cover.coverTopY) - cover.halfWidth * 2) < 0.001, 'hangar cover spans the full hangar aperture width');
}
const outline = stationShellOutlineForTest(rendererStation);
const outlineBounds = outline.reduce((bounds, point) => ({
  minX: Math.min(bounds.minX, point.x),
  maxX: Math.max(bounds.maxX, point.x),
  minY: Math.min(bounds.minY, point.y),
  maxY: Math.max(bounds.maxY, point.y)
}), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
assert.equal(outlineBounds.maxX - outlineBounds.minX, 840, 'renderer shell bounds are exactly 840 units wide');
assert.equal(outlineBounds.maxY - outlineBounds.minY, 840, 'renderer shell bounds are exactly 840 units high');
assert(outline.some((point) => Math.abs(point.x - 28) < 0.001), 'each forward opening is recessed into the shell');
assert(outline.filter((point) => Math.abs(point.x - 28) < 0.001).length >= 6, 'three openings have rear walls and straight sides');

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
assert(rendererJs.includes('worldRoot.addChild(layers.friendlyShipBodies)'), 'friendly ships have a dedicated world layer');
assert(rendererJs.indexOf('worldRoot.addChild(layers.stations)') < rendererJs.indexOf('worldRoot.addChild(layers.friendlyShipBodies)'), 'stations draw beneath friendly ships');
assert(rendererJs.includes('updatePixiStations'), 'stations are updated every frame');
assert(rendererJs.includes('destroyPixiStations'), 'the station pool is torn down with the renderer');

console.log('Station infrastructure client verification passed');
