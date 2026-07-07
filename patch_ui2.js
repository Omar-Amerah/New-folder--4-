const fs = require('fs');

let ui = fs.readFileSync('public/src/ui/partInspectorUi.js', 'utf8');

// Also need to add antiMissile and missileHp fields to normal weapons since it only got added to beam in the previous patch

ui = ui.replace(
  /\["Range", formatDistance\(weapon\.range\)\],/,
  `["Range", formatDistance(weapon.range)],
      (weapon.antiMissile ? ["Role", "Anti-missile point defence"] : null),
      (weapon.missileHp ? ["Missile health", weapon.missileHp.toString()] : null),`
);

fs.writeFileSync('public/src/ui/partInspectorUi.js', ui);
