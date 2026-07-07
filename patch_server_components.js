const fs = require('fs');

const file = 'src/server/components.js';
let content = fs.readFileSync(file, 'utf8');

// Modify makeWeapon to include pointDefense props and missileHp
content = content.replace(
  /type,\n\s+damage,\n\s+fireRate,\n\s+reload: Number\(\(1 \/ fireRate\)\.toFixed\(2\)\),\n\s+range: stats.range,\n\s+radius: Number\(stats.radius\) \|\| 0,\n\s+projectileSpeed: stats.projectileSpeed,\n\s+accuracy: stats.accuracy,\n\s+tracking: stats.tracking \|\| 0,\n\s+trackTime: Number\(stats.trackTime\) \|\| 0,\n\s+arc: Number\(stats.arc\) \|\| 360,\n\s+dps: Number\(\(damage \* fireRate\)\.toFixed\(1\)\)/,
  `type,\n    damage,\n    fireRate,\n    reload: Number((1 / fireRate).toFixed(2)),\n    range: stats.range,\n    radius: Number(stats.radius) || 0,\n    projectileSpeed: stats.projectileSpeed,\n    accuracy: stats.accuracy,\n    tracking: stats.tracking || 0,\n    trackTime: Number(stats.trackTime) || 0,\n    arc: Number(stats.arc) || 360,\n    dps: Number((damage * fireRate).toFixed(1)),\n    missileHp: Number(stats.missileHp) || 0,\n    antiMissile: Boolean(stats.antiMissile),\n    shipDamageMultiplier: Number(stats.shipDamageMultiplier) || 1,\n    targetPriority: stats.targetPriority || []`
);

// Add decoy, ECM, and deflector props to normalizeBalanceComponent
content = content.replace(
  /heat: toNumber\(component\.heat, 0\),\n\s+rotationRequired: Boolean\(component\.rotationRequired \|\| component\.rotatable\)/g,
  `heat: toNumber(component.heat, 0),\n    rotationRequired: Boolean(component.rotationRequired || component.rotatable),\n    ecmStrength: toNumber(component.ecmStrength, 0),\n    decoyRange: toNumber(component.decoyRange, 0),\n    decoyCooldown: toNumber(component.decoyCooldown, 0),\n    decoyConfuseDuration: toNumber(component.decoyConfuseDuration, 0),\n    decoyChance: toNumber(component.decoyChance, 0),\n    frontDamageReduction: toNumber(component.frontDamageReduction, 0),\n    frontArc: toNumber(component.frontArc, 0)`
);


// Update families logic to include pointDefense
content = content.replace(
  /for \(const family of \["blaster", "missile", "railgun", "beam"\]\)/g,
  `for (const family of ["blaster", "missile", "railgun", "beam", "pointDefense"])`
);

fs.writeFileSync(file, content);
