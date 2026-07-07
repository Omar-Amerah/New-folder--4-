const fs = require('fs');

function patchStats(file) {
  let content = fs.readFileSync(file, 'utf8');

  // Need to forward weapon stats for pointDefense as well
  content = content.replace(
    /beamReload: weapons\.beam\.reload,\n\s+blasterProjectileSpeed/,
    `beamReload: weapons.beam.reload,
    pointDefenseReload: weapons.pointDefense.reload,
    pointDefenseDamage: weapons.pointDefense.damage,
    pointDefenseRange: weapons.pointDefense.range,
    pointDefenseProjectileSpeed: weapons.pointDefense.projectileSpeed,
    pointDefenseAccuracy: weapons.pointDefense.accuracy,
    blasterProjectileSpeed`
  );

  // also add pointDefenseDps to weaponDps
  content = content.replace(
    /weaponDps: round\(weapons\.blaster\.dps \+ weapons\.missile\.dps \+ weapons\.railgun\.dps \+ weapons\.beam\.dps\),/,
    `weaponDps: round(weapons.blaster.dps + weapons.missile.dps + weapons.railgun.dps + weapons.beam.dps + weapons.pointDefense.dps),`
  );

  fs.writeFileSync(file, content);
}
patchStats('src/server/shipStats.js');
patchStats('public/src/design/componentStats.js');
