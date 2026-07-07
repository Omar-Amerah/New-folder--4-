const fs = require('fs');

const file = 'public/src/design/parts.js';
let content = fs.readFileSync(file, 'utf8');

// Modify makeWeapon to include pointDefense props and missileHp
content = content.replace(
  /type,\n\s+damage,\n\s+fireRate,\n\s+reload: Number\(\(1 \/ fireRate\)\.toFixed\(2\)\),\n\s+range: stats.range,\n\s+radius: Number\(stats.radius\) \|\| 0,\n\s+projectileSpeed: stats.projectileSpeed,\n\s+accuracy: stats.accuracy,\n\s+tracking: stats.tracking \|\| 0,\n\s+trackTime: Number\(stats.trackTime\) \|\| 0,\n\s+arc: Number\(stats.arc\) \|\| 360,\n\s+dps: Number\(\(damage \* fireRate\)\.toFixed\(1\)\)/,
  `type,\n    damage,\n    fireRate,\n    reload: Number((1 / fireRate).toFixed(2)),\n    range: stats.range,\n    radius: Number(stats.radius) || 0,\n    projectileSpeed: stats.projectileSpeed,\n    accuracy: stats.accuracy,\n    tracking: stats.tracking || 0,\n    trackTime: Number(stats.trackTime) || 0,\n    arc: Number(stats.arc) || 360,\n    dps: Number((damage * fireRate).toFixed(1)),\n    missileHp: Number(stats.missileHp) || 0,\n    antiMissile: Boolean(stats.antiMissile),\n    shipDamageMultiplier: Number(stats.shipDamageMultiplier) || 1,\n    targetPriority: stats.targetPriority || []`
);

// Add decoy, ECM, and deflector props to normalize functions
content = content.replace(
  /heat: numberOr\(part\.heat, 0\),\n\s+rotationRequired: Boolean\(part\.rotationRequired \|\| part\.rotatable\)/g,
  `heat: numberOr(part.heat, 0),\n    rotationRequired: Boolean(part.rotationRequired || part.rotatable),\n    ecmStrength: numberOr(part.ecmStrength, 0),\n    decoyRange: numberOr(part.decoyRange, 0),\n    decoyCooldown: numberOr(part.decoyCooldown, 0),\n    decoyConfuseDuration: numberOr(part.decoyConfuseDuration, 0),\n    decoyChance: numberOr(part.decoyChance, 0),\n    frontDamageReduction: numberOr(part.frontDamageReduction, 0),\n    frontArc: numberOr(part.frontArc, 0)`
);

content = content.replace(
  /heat: numberOr\(component\.heat, 0\),\n\s+rotationRequired: Boolean\(component\.rotationRequired \|\| component\.rotatable\)/g,
  `heat: numberOr(component.heat, 0),\n    rotationRequired: Boolean(component.rotationRequired || component.rotatable),\n    ecmStrength: numberOr(component.ecmStrength, 0),\n    decoyRange: numberOr(component.decoyRange, 0),\n    decoyCooldown: numberOr(component.decoyCooldown, 0),\n    decoyConfuseDuration: numberOr(component.decoyConfuseDuration, 0),\n    decoyChance: numberOr(component.decoyChance, 0),\n    frontDamageReduction: numberOr(component.frontDamageReduction, 0),\n    frontArc: numberOr(component.frontArc, 0)`
);

// Update families logic to include pointDefense
content = content.replace(
  /for \(const family of \["blaster", "missile", "railgun", "beam"\]\)/g,
  `for (const family of ["blaster", "missile", "railgun", "beam", "pointDefense"])`
);

// Add missing new parts to PART_DEFS in public/src/design/parts.js
// We will look for pointDefense and replace it, then add the rest
content = content.replace(
  /pointDefense: { name: "Point Defence", color: "#fda4af", glyph: "radial-gradient\\(circle, #fff1f2 0 18%, #fb7185 30% 56%, #881337 62%\\)" },/,
  `pointDefenseLaser: { name: "Point Defence Laser", color: "#fda4af", glyph: "radial-gradient(circle, #fff1f2 0 18%, #fb7185 30% 56%, #881337 62%)" },
  flakCannon: { name: "Flak Cannon", color: "#fda4af", glyph: "radial-gradient(circle, #fecdd3 0 25%, #f43f5e 35% 56%, #881337 62%)" },
  interceptorPod: { name: "Interceptor Pod", color: "#fda4af", glyph: "radial-gradient(circle, #ffe4e6 0 22%, #e11d48 30% 60%, #4c0519 65%)" },
  ecmModule: { name: "ECM Module", color: "#fef08a", glyph: "linear-gradient(135deg, #fef08a 20%, #ca8a04 50%, #713f12 80%)" },
  decoyLauncher: { name: "Decoy Launcher", color: "#fef08a", glyph: "radial-gradient(circle, #fef08a 0 20%, #d97706 40% 60%, #78350f 70%)" },
  forwardDeflector: { name: "Forward Deflector", color: "#60a5fa", glyph: "linear-gradient(0deg, #1e3a8a 0%, #3b82f6 40%, #bfdbfe 80%)" },`
);


fs.writeFileSync(file, content);
