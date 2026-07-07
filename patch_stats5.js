const fs = require('fs');

function patchStats(file) {
  let content = fs.readFileSync(file, 'utf8');

  // Insert logic into computeStats loop
  content = content.replace(
    /captureBonus \+= part\.captureBonus \|\| 0;/,
    `captureBonus += part.captureBonus || 0;
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

  // Make sure to init the new weapons totals properly if they are not there
  // weaponTotals doesn't have pointDefense yet, let's add it
  content = content.replace(
    /beam: weaponAccumulator\(\)/,
    `beam: weaponAccumulator(),
    pointDefense: weaponAccumulator()`
  );

  fs.writeFileSync(file, content);
}
patchStats('src/server/shipStats.js');
patchStats('public/src/design/componentStats.js');
