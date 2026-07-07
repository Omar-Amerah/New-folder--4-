const fs = require('fs');
function patchStats(file) {
  let content = fs.readFileSync(file, 'utf8');

  // ecmStrength accumulation
  content = content.replace(
    /if \(part\.ecmStrength\) ecmStrength \+= part\.ecmStrength;/,
    `if (part.ecmStrength) ecmStrength += part.ecmStrength;`
  );

  // Need to verify why ecmStrength is 0. Ah, we replaced `if (part.captureBonus) captureBonus += part.captureBonus;` earlier, maybe it got duplicated or missed.
  fs.writeFileSync(file, content);
}
patchStats('src/server/shipStats.js');
