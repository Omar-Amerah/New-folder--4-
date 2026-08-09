const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { PARTS } = require('../src/server/components');
const serverFootprint = require('../src/server/footprint');
const { validateDesign } = require('../src/server/shipDesign');
const { initComponentState, applyHullDamage } = require('../src/server/componentHealth');
const { BALANCE } = require('../src/server/balanceConfig');
const { generateBalanceArtifacts } = require('../tools/generate-balance');

generateBalanceArtifacts();

const EPS = 1e-9;
function close(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) <= EPS, `${msg}: expected ${expected}, got ${actual}`);
}

function room() {
  return { nextEntityId: 1, bullets: [], effects: [], map: { asteroids: [] }, world: { width: 2000, height: 2000 }, rules: { gameMode: 'team' }, players: new Map([[1, { id: 1, team: 'a' }], [2, { id: 2, team: 'b' }]]), ships: new Map(), combatRandom: () => 0.5 };
}

function target(type) {
  const ship = { id: `t${Math.random()}`, ownerId: 2, x: 500, y: 500, vx: 0, vy: 0, angle: 0, radius: 35, alive: true, shield: 0, maxShield: 0, stats: { maxHp: 10000, frontDamageReduction: 0, frontArc: 0 }, design: [{ type, x: 7, y: 6, rotation: 0 }, { type: 'core', x: 7, y: 7, rotation: 0 }] };
  initComponentState(ship);
  ship.componentHp[0] = 9000;
  ship.componentMaxHp[0] = 9000;
  ship.hp = 9000;
  return ship;
}

function damageOnce(type, dmg) {
  const t = target(type);
  const r = room();
  r.ships.set(t.id, t);
  const before = t.hp;
  applyHullDamage(r, t, dmg, 0, t.x + 13, t.y, { armorInteractionSeconds: 1 });
  return before - t.hp;
}

const newComponents = {
  ablativeArmor: { cost: 13, mass: 8, hull: 380, armorFlatReduction: 0, turn: -0.03, shapeType: null, statScale: 1, footprint: { width: 1, height: 1 }, rotatable: false },
  halfAblativeArmorDiagonal: { cost: 6.5, mass: 4, hull: 190, armorFlatReduction: 0, turn: -0.015, shapeType: 'halfDiagonal', statScale: 0.5, footprint: { width: 1, height: 1 }, rotatable: true },
  wingAblativeArmor: { cost: 10.4, mass: 6.4, hull: 304, armorFlatReduction: 0, turn: -0.024, shapeType: 'wing', statScale: 0.8, footprint: { width: 1, height: 1 }, rotatable: true },
  bevelAblativeArmor: { cost: 9.75, mass: 6, hull: 285, armorFlatReduction: 0, turn: -0.0225, shapeType: 'bevel', statScale: 0.75, footprint: { width: 1, height: 1 }, rotatable: true },
  roundedAblativeArmor: { cost: 10.4, mass: 6.4, hull: 304, armorFlatReduction: 0, turn: -0.024, shapeType: 'roundedCorner', statScale: 0.8, footprint: { width: 1, height: 1 }, rotatable: true },
  longWedgeAblativeArmor: { cost: 19.5, mass: 12, hull: 570, armorFlatReduction: 0, turn: -0.045, shapeType: 'longWedge', statScale: 1.5, footprint: { width: 2, height: 1 }, rotatable: true },
  bevelArmor: { cost: 9, mass: 8.25, hull: 180, armorFlatReduction: 3.75, turn: -0.045, shapeType: 'bevel', statScale: 0.75, footprint: { width: 1, height: 1 }, rotatable: true },
  bevelCompositeArmor: { cost: 11.7, mass: 4.5, hull: 142.5, armorFlatReduction: 2.625, turn: -0.015, shapeType: 'bevel', statScale: 0.75, footprint: { width: 1, height: 1 }, rotatable: true },
  bevelFrame: { cost: 2.7, mass: 2.7, hull: 30, armorFlatReduction: 0, turn: 0, shapeType: 'bevel', statScale: 0.75, footprint: { width: 1, height: 1 }, rotatable: true },
  roundedArmor: { cost: 9.6, mass: 8.8, hull: 192, armorFlatReduction: 4, turn: -0.048, shapeType: 'roundedCorner', statScale: 0.8, footprint: { width: 1, height: 1 }, rotatable: true },
  roundedCompositeArmor: { cost: 12.48, mass: 4.8, hull: 152, armorFlatReduction: 2.8, turn: -0.016, shapeType: 'roundedCorner', statScale: 0.8, footprint: { width: 1, height: 1 }, rotatable: true },
  roundedFrame: { cost: 2.88, mass: 2.88, hull: 32, armorFlatReduction: 0, turn: 0, shapeType: 'roundedCorner', statScale: 0.8, footprint: { width: 1, height: 1 }, rotatable: true },
  longWedgeArmor: { cost: 18, mass: 16.5, hull: 360, armorFlatReduction: 5, turn: -0.09, shapeType: 'longWedge', statScale: 1.5, footprint: { width: 2, height: 1 }, rotatable: true },
  longWedgeCompositeArmor: { cost: 23.4, mass: 9, hull: 285, armorFlatReduction: 3.5, turn: -0.03, shapeType: 'longWedge', statScale: 1.5, footprint: { width: 2, height: 1 }, rotatable: true },
  longWedgeFrame: { cost: 5.4, mass: 5.4, hull: 60, armorFlatReduction: 0, turn: 0, shapeType: 'longWedge', statScale: 1.5, footprint: { width: 2, height: 1 }, rotatable: true }
};

(async () => {
  // --- Catalogue tests ---
  for (const [id, expected] of Object.entries(newComponents)) {
    assert.ok(PARTS[id], `${id} exists in server PARTS`);
    const p = PARTS[id];
    close(p.cost, expected.cost, `${id} cost`);
    close(p.mass, expected.mass, `${id} mass`);
    close(p.hp, expected.hull, `${id} hp`);
    close(p.turn, expected.turn, `${id} turn`);
    close(p.armorFlatReduction, expected.armorFlatReduction, `${id} armorFlatReduction`);
    assert.strictEqual(p.rotatable, expected.rotatable, `${id} rotatable`);
    if (expected.shapeType) {
      assert.strictEqual(p.shapeType, expected.shapeType, `${id} shapeType`);
      close(p.statScale, expected.statScale, `${id} statScale`);
    }
    assert.deepStrictEqual(p.footprint, expected.footprint, `${id} footprint`);
  }

  // --- Ablative flat-reduction regression ---
  const ablativeFamily = [
    'ablativeArmor', 'halfAblativeArmorDiagonal', 'wingAblativeArmor',
    'bevelAblativeArmor', 'roundedAblativeArmor', 'longWedgeAblativeArmor'
  ];
  for (const id of ablativeFamily) {
    assert.strictEqual(PARTS[id].armorFlatReduction, 0, `${id} receives exactly 0 flat reduction on the server`);
    assert.strictEqual(PARTS[id].category, 'Structure', `${id} stays in the Structure category`);
  }
  const ablativeLoss = damageOnce('ablativeArmor', 20);
  const armorLoss = damageOnce('armor', 20);
  assert.ok(ablativeLoss > armorLoss, 'Ablative Plating loses more HP per hit than standard Armour because it has no flat reduction');
  close(ablativeLoss, 20, 'ablative takes full 20 damage');
  close(armorLoss, 15, 'standard armour reduces 20 damage to 15');
  assert.ok(PARTS.ablativeArmor.hp > PARTS.armor.hp, 'Ablative Plating has more raw hull than standard Armour');

  // Every shaped ablative variant is the base block scaled by its statScale, the
  // same rule the bevel/rounded/long-wedge armour families follow.
  for (const id of ablativeFamily.filter((n) => n !== 'ablativeArmor')) {
    const scale = PARTS[id].statScale;
    close(PARTS[id].hp, PARTS.ablativeArmor.hp * scale, `${id} hull is the base block scaled by statScale`);
    close(PARTS[id].cost, PARTS.ablativeArmor.cost * scale, `${id} cost is the base block scaled by statScale`);
    close(PARTS[id].mass, PARTS.ablativeArmor.mass * scale, `${id} mass is the base block scaled by statScale`);
  }

  // The buff has to leave the identity intact: ablative must still lose to rapid
  // low-damage fire and win against heavy single hits, per cell of hull.
  const effective = (part, dmg) => part.hp * (dmg / Math.max(0.0001, dmg - part.armorFlatReduction));
  assert.ok(effective(PARTS.ablativeArmor, 8) < effective(PARTS.armor, 8),
    'Ablative Plating is still worse than Armour against rapid 8-damage autocannon fire');
  assert.ok(effective(PARTS.ablativeArmor, 120) > effective(PARTS.armor, 120),
    'Ablative Plating beats Armour against a 120-damage railgun hit');

  // --- Client catalogue ---
  global.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, getContext: () => null })
  };
  global.window = { devicePixelRatio: 1 };

  const parts = await import('../public/src/design/parts.js');
  parts.applyServerParts(PARTS);

  for (const [id, expected] of Object.entries(newComponents)) {
    const stat = parts.PART_STATS[id];
    assert.ok(stat, `${id} exists in client PART_STATS`);
    close(stat.hp, expected.hull, `${id} client hp`);
    close(stat.armorFlatReduction, expected.armorFlatReduction, `${id} client armorFlatReduction`);
    assert.strictEqual(stat.rotatable, expected.rotatable, `${id} client rotatable`);
    assert.deepStrictEqual(stat.footprint, expected.footprint, `${id} client footprint`);
    if (expected.shapeType) {
      assert.strictEqual(stat.shapeType, expected.shapeType, `${id} client shapeType`);
      close(stat.statScale, expected.statScale, `${id} client statScale`);
    }
    assert.ok(parts.isRotatablePart(id) === expected.rotatable, `${id} rotatable flag matches isRotatablePart`);
  }

  // --- Footprint and rotation parity ---
  const clientFootprint = await import('../public/src/design/footprint.js');
  for (const id of Object.keys(newComponents)) {
    const footprint = PARTS[id].footprint;
    for (const rot of [0, 90, 180, 270]) {
      const serverCells = serverFootprint.getOccupiedCells(7, 7, footprint, rot).map(c => `${c.x},${c.y}`).sort();
      const clientCells = clientFootprint.getOccupiedCells(7, 7, footprint, rot).map(c => `${c.x},${c.y}`).sort();
      assert.deepStrictEqual(clientCells, serverCells, `${id} rotation ${rot} cells match`);
    }
  }

  const longWedgeExpected = {
    0: [[7, 7], [8, 7]],
    90: [[7, 7], [7, 8]],
    180: [[7, 7], [6, 7]],
    270: [[7, 7], [7, 6]]
  };
  for (const [rot, expected] of Object.entries(longWedgeExpected)) {
    const cells = serverFootprint.getOccupiedCells(7, 7, PARTS.longWedgeArmor.footprint, Number(rot));
    assert.deepStrictEqual(cells, expected.map(([x, y]) => ({ x, y })), `longWedge rotation ${rot}`);
  }

  // --- Bounds and overlap ---
  const edge = [{ x: 14, y: 7, type: 'longWedgeArmor', rotation: 0 }, { x: 13, y: 7, type: 'core', rotation: 0 }];
  assert.strictEqual(validateDesign(edge).ok, false, 'rotated long wedge crossing grid edge is rejected');

  const overlapping = [{ x: 7, y: 7, type: 'core', rotation: 0 }, { x: 7, y: 7, type: 'longWedgeArmor', rotation: 0 }];
  assert.strictEqual(validateDesign(overlapping).ok, false, 'long wedge second cell overlap is detected');

  const connected = [{ x: 7, y: 7, type: 'core', rotation: 0 }, { x: 8, y: 7, type: 'longWedgeArmor', rotation: 0 }];
  assert.strictEqual(validateDesign(connected).ok, true, 'long wedge connects as a structure');

  // --- Rendering no-throw ---
  const { buildExteriorHullEdges } = await import('../public/src/game/shipHullOutline.js');
  const design = [
    { x: 7, y: 7, type: 'core', rotation: 0 },
    { x: 8, y: 7, type: 'longWedgeArmor', rotation: 0 },
    { x: 6, y: 7, type: 'ablativeArmor', rotation: 0 },
    { x: 7, y: 6, type: 'bevelArmor', rotation: 90 },
    { x: 7, y: 8, type: 'roundedArmor', rotation: 180 },
    { x: 5, y: 7, type: 'longWedgeAblativeArmor', rotation: 180 },
    { x: 6, y: 6, type: 'bevelAblativeArmor', rotation: 90 },
    { x: 6, y: 8, type: 'roundedAblativeArmor', rotation: 180 },
    { x: 5, y: 6, type: 'wingAblativeArmor', rotation: 270 },
    { x: 5, y: 8, type: 'halfAblativeArmorDiagonal', rotation: 180 }
  ];
  const edges = buildExteriorHullEdges(design, { scale: 13, isLive: () => true });
  assert.ok(edges.length > 0, 'hull outline produces edges');
  assert.ok(edges.every(e => Number.isFinite(e.x1) && Number.isFinite(e.y1) && Number.isFinite(e.x2) && Number.isFinite(e.y2)), 'hull outline edges are finite');

  // --- Generated-data parity ---
  const generatedJson = fs.readFileSync(path.join(__dirname, '..', 'public', 'component-balance.generated.json'), 'utf8');
  const rootJson = fs.readFileSync(path.join(__dirname, '..', 'component-balance.json'), 'utf8');
  assert.strictEqual(generatedJson, rootJson, 'generated balance matches authoritative root balance');

  // --- Blueprint lifecycle ---
  const serverCanonical = validateDesign(design);
  assert.strictEqual(serverCanonical.ok, true, 'design with new types validates');
  assert.deepStrictEqual(serverCanonical.modules.map(p => ({ x: p.x, y: p.y, type: p.type, rotation: p.rotation })), design, 'design IDs, anchors and rotations are preserved');

  console.log('verify-ablative-and-shapes passed');
})().catch((err) => { console.error(err); process.exit(1); });
