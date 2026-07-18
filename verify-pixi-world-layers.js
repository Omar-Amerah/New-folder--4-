const assert = require('assert');

function makeCtx() {
  return {
    setTransform() {}, translate() {}, scale() {}, save() {}, restore() {}, rotate() {}, beginPath() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {}, arc() {}, rect() {}, clearRect() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; }
  };
}

function makeElement() {
  return {
    getContext: () => makeCtx(),
    cloneNode: () => makeElement(),
    parentNode: null,
    addEventListener() {},
    removeEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    dataset: {},
    appendChild() {},
    replaceChildren() {},
    querySelector: () => makeElement(),
    querySelectorAll: () => []
  };
}

global.document = {
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => makeElement(),
  querySelector: () => makeElement(),
  querySelectorAll: () => [],
  createElement: () => ({ width: 0, height: 0, getContext: () => makeCtx() })
};
global.window = { addEventListener() {}, removeEventListener() {} };

class Container {
  constructor() { this.children = []; this.parent = null; this.visible = true; this.destroyed = false; this.position = { set: (x, y) => { this.x = x; this.y = y; } }; }
  addChild(child) { if (child.parent) child.parent.removeChild(child); child.parent = this; this.children.push(child); return child; }
  removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); if (child.parent === this) child.parent = null; return child; }
  getChildIndex(child) { return this.children.indexOf(child); }
  destroy() { this.destroyed = true; }
}
class Graphics extends Container { clear() {} circle() {} fill() {} moveTo() {} lineTo() {} arc() {} stroke() {} rect() {} }
class Sprite extends Container {
  constructor() { super(); this.anchor = { set: () => {} }; this.scale = { set: (v) => { this.scaleValue = v; } }; this.texture = null; this.rotation = 0; }
}
let madeTextures = 0; let destroyedTextures = 0;
const PIXI = { Container, Graphics, Sprite, Text: class extends Container {}, Texture: { from: () => ({ id: ++madeTextures, destroy: () => { destroyedTextures += 1; } }) } };

(async () => {
  const { state } = await import('./public/src/state.js');
  const { updatePixiWorld, destroyPixiWorld } = await import('./public/src/game/pixi/pixiWorld.js');
  const { pixiTextureDiagnostics, flushAllPixiTextureCaches } = await import('./public/src/game/pixi/pixiBake.js');

  const mapLayer = new PIXI.Container();
  const env = { PIXI, bakeScale: 1, layers: { grid: new PIXI.Graphics(), map: mapLayer, relays: new PIXI.Container(), effects: new PIXI.Container(), overlay: new PIXI.Graphics(), bullets: new PIXI.Container(), ships: new PIXI.Container(), command: new PIXI.Graphics(), enemyBullets: new PIXI.Container(), friendlyBullets: new PIXI.Container(), effectText: new PIXI.Container(), engineSmoke: new PIXI.Graphics() } };
  const cloudA = { id: 'n1', x: 100, y: 100, rx: 80, ry: 80, rotation: 0 };
  const cloudB = { id: 'n2', x: 105, y: 100, rx: 70, ry: 70, rotation: 0 };
  const asteroidA = { id: 'a1', x: 100, y: 100, radius: 60, rotation: 0.2, spin: 0.5 };
  const asteroidB = { id: 'a2', x: 108, y: 100, radius: 55, rotation: 0, spin: 0 };
  state.world = { width: 1000, height: 1000 };
  state.camera = { zoom: 1 };
  state.snapshot = null;
  state.map = { safeZones: [{ x: 10, y: 10, radius: 20 }], clouds: [cloudA, cloudB], asteroids: [asteroidA, asteroidB] };

  const refs = () => {
    const zones = mapLayer.children[0];
    const feature = mapLayer.children[1];
    return { zones, feature, nebulaLayer: feature.children[0], asteroidLayer: feature.children[1] };
  };
  const assertStable = (label, cloud = cloudA, asteroid = asteroidA) => {
    const { feature, nebulaLayer, asteroidLayer } = refs();
    assert.strictEqual(feature.getChildIndex(nebulaLayer), 0, `${label}: nebula layer remains below asteroid layer`);
    assert.strictEqual(feature.getChildIndex(asteroidLayer), 1, `${label}: asteroid layer remains above nebula layer`);
    const nebula = nebulaLayer.children.find((s) => s.x === cloud.x && s.y === cloud.y && s.visible);
    const asteroidView = asteroidLayer.children.find((s) => s.x === asteroid.x && s.y === asteroid.y && s.visible);
    assert(nebula, `${label}: nebula remains in nebulaLayer`);
    assert(asteroidView, `${label}: asteroid remains in asteroidLayer`);
    assert(nebulaLayer.children.every((n) => n.parent === nebulaLayer), `${label}: all nebulas parented to nebulaLayer`);
    assert(asteroidLayer.children.every((a) => a.parent === asteroidLayer), `${label}: all asteroids parented to asteroidLayer`);
    return asteroidView.rotation;
  };
  const liveRefs = () => pixiTextureDiagnostics().caches.filter((c) => c.name === 'nebula' || c.name === 'asteroid').reduce((sum, c) => sum + c.refs, 0);

  updatePixiWorld(env, 1000, new Map(), null);
  const createdAfterFirst = madeTextures;
  const firstRotation = assertStable('initial');
  assert.strictEqual(liveRefs(), 4, 'each visible nebula/asteroid has one live texture lease');

  updatePixiWorld(env, 1100, new Map(), { left: 500, top: 500, right: 600, bottom: 600 });
  assert.strictEqual(liveRefs(), 0, 'culled world features release leases');
  updatePixiWorld(env, 1200, new Map(), null);
  assertStable('restore after full cull');

  state.map = { safeZones: state.map.safeZones, clouds: [], asteroids: [asteroidA, asteroidB] };
  updatePixiWorld(env, 1300, new Map(), null);
  state.map = { safeZones: state.map.safeZones, clouds: [cloudA, cloudB], asteroids: [asteroidA, asteroidB] };
  updatePixiWorld(env, 1400, new Map(), null);
  assertStable('restore nebulas');

  state.map = { safeZones: state.map.safeZones, clouds: [cloudA, cloudB], asteroids: [] };
  updatePixiWorld(env, 1500, new Map(), null);
  state.map = { safeZones: state.map.safeZones, clouds: [cloudA, cloudB], asteroids: [asteroidA, asteroidB] };
  updatePixiWorld(env, 1600, new Map(), null);
  const laterRotation = assertStable('restore asteroids');
  assert.notStrictEqual(laterRotation, firstRotation, 'asteroid rotation continues updating');

  const clonedCloud = { ...cloudA };
  const clonedAsteroid = { ...asteroidA };
  state.map = { safeZones: state.map.safeZones.map((z) => ({ ...z })), clouds: [clonedCloud, { ...cloudB }], asteroids: [clonedAsteroid, { ...asteroidB }] };
  for (let i = 0; i < 5; i += 1) {
    updatePixiWorld(env, 1700 + i * 16, new Map(), null);
    assertStable(`cloned frame ${i}`, clonedCloud, clonedAsteroid);
  }
  assert.strictEqual(madeTextures, createdAfterFirst + 4, 'only cloned map objects create new textures; draw order does not');

  const destroyedLayerRefs = refs();
  destroyPixiWorld();
  assert.strictEqual(liveRefs(), 0, 'destroyPixiWorld releases map feature leases');
  assert(destroyedLayerRefs.nebulaLayer.destroyed && destroyedLayerRefs.asteroidLayer.destroyed, 'fixed sublayers are destroyed safely');
  flushAllPixiTextureCaches();
  assert.strictEqual(destroyedTextures, madeTextures, 'all created test textures can be flushed after leases release');
  updatePixiWorld(env, 2000, new Map(), null);
  assertStable('reinitialized', clonedCloud, clonedAsteroid);
  destroyPixiWorld();
  flushAllPixiTextureCaches();
  console.log('pixi world layer ordering verification passed');
})();
