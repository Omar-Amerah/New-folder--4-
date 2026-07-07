const fs = require('fs');

function patchStats(file) {
  let content = fs.readFileSync(file, 'utf8');

  // Add new vars in computeStats
  content = content.replace(
    /let captureBonus = 0;/,
    `let captureBonus = 0;
  let ecmStrength = 0;
  let decoyRange = 0;
  let decoyCooldown = 0;
  let decoyConfuseDuration = 0;
  let decoyChance = 0;
  let frontDamageReduction = 0;
  let frontArc = 0;
  let pointDefense = 0;`
  );

  // Accumulate new vars inside the loop
  content = content.replace(
    /if \(part\.fireRateBonus\) fireRateBonus \+= part\.fireRateBonus;\n\s+if \(part\.coolingBonus\) coolingBonus \+= part\.coolingBonus;\n\s+if \(part\.captureBonus\) captureBonus \+= part\.captureBonus;/,
    `if (part.fireRateBonus) fireRateBonus += part.fireRateBonus;
    if (part.coolingBonus) coolingBonus += part.coolingBonus;
    if (part.captureBonus) captureBonus += part.captureBonus;
    if (part.pointDefense) pointDefense += part.pointDefense;
    if (part.ecmStrength) ecmStrength += part.ecmStrength;
    if (part.decoyRange > decoyRange) decoyRange = part.decoyRange;
    if (part.decoyCooldown > decoyCooldown) decoyCooldown = part.decoyCooldown;
    if (part.decoyConfuseDuration > decoyConfuseDuration) decoyConfuseDuration = part.decoyConfuseDuration;
    if (part.decoyChance > decoyChance) decoyChance = part.decoyChance;
    if (part.frontDamageReduction) {
      frontDamageReduction += part.frontDamageReduction;
      if (part.frontArc > frontArc) frontArc = part.frontArc;
    }`
  );

  // Add caps and return values
  content = content.replace(
    /const costBreakdown = calculateCostBreakdown/,
    `ecmStrength = Math.min(ecmStrength, 0.55);
  frontDamageReduction = Math.min(frontDamageReduction, 0.35);
  const costBreakdown = calculateCostBreakdown`
  );

  content = content.replace(
    /captureBonus: round\(captureBonus\),/,
    `captureBonus: round(captureBonus),
    pointDefense,
    ecmStrength: round(ecmStrength),
    decoyRange,
    decoyCooldown,
    decoyConfuseDuration,
    decoyChance,
    frontDamageReduction: round(frontDamageReduction),
    frontArc,`
  );

  // Update ship warnings to consider PD as weapons if weapons=0 ? Not necessarily, but we'll include it.
  content = content.replace(
    /const weaponCount = stats\.blaster \+ stats\.missile \+ stats\.railgun \+ \(stats\.beam \|\| 0\);/,
    `const weaponCount = stats.blaster + stats.missile + stats.railgun + (stats.beam || 0) + (stats.pointDefense || 0);`
  );

  // In summarizeStats
  content = content.replace(
    /captureBonus: stats\.captureBonus,/,
    `captureBonus: stats.captureBonus,
    pointDefense: stats.pointDefense,
    ecmStrength: stats.ecmStrength,
    decoyRange: stats.decoyRange,
    decoyCooldown: stats.decoyCooldown,
    decoyConfuseDuration: stats.decoyConfuseDuration,
    decoyChance: stats.decoyChance,
    frontDamageReduction: stats.frontDamageReduction,
    frontArc: stats.frontArc,`
  );

  fs.writeFileSync(file, content);
}

patchStats('src/server/shipStats.js');
patchStats('public/src/design/componentStats.js');
