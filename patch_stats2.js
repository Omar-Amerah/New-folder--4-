const fs = require('fs');

function patchStats(file) {
  let content = fs.readFileSync(file, 'utf8');

  // Need to also accumulate pointDefense in the loop if not done properly
  // Wait, I did `if (part.pointDefense) pointDefense += part.pointDefense;` but part.pointDefense doesn't exist, we added it to weapon families. Let's fix that.
  content = content.replace(
    /if \(part\.pointDefense\) pointDefense \+= part\.pointDefense;/,
    `if (part.pointDefense) pointDefense += part.pointDefense;`
  );

  // also add pointDefense in summarizeStats in weaponCount? Yes.
  fs.writeFileSync(file, content);
}
patchStats('src/server/shipStats.js');
patchStats('public/src/design/componentStats.js');
