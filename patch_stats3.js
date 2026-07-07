const fs = require('fs');
function patchStats(file) {
  let content = fs.readFileSync(file, 'utf8');

  // Let's add the accumulation correctly.
  content = content.replace(
    /if \(part\.captureBonus\) captureBonus \+= part\.captureBonus;/,
    `if (part.captureBonus) captureBonus += part.captureBonus;
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

  // also track weapon type
  content = content.replace(
    /beam \+= part\.beam \|\| 0;/,
    `beam += part.beam || 0;\n    pointDefense += part.pointDefense || 0;`
  );

  fs.writeFileSync(file, content);
}

patchStats('src/server/shipStats.js');
patchStats('public/src/design/componentStats.js');
