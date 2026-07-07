const fs = require('fs');

let ui = fs.readFileSync('public/src/ui/partInspectorUi.js', 'utf8');
// Fix the double insertion and remove nulls in beam array too

ui = ui.replace(
  /return \[\n\s+\["Damage", `\$\{formatDamage\(weapon\.damage\)\}\/s`\],\n\s+\["Range", formatDistance\(weapon\.range\)\],\n\s+\(weapon\.antiMissile \? \["Role", "Anti-missile point defence"\] : null\),\n\s+\(weapon\.missileHp \? \["Missile health", weapon\.missileHp\.toString\(\)\] : null\),\n\s+\["Beam radius", formatDistance\(weapon\.radius \|\| 0\)\],\n\s+\["Tracking", `\$\{Math\.round\(\(weapon\.tracking \|\| 0\) \* 100\)\}% slow aim`\],\n\s+\["Arc", `\$\{weapon\.arc \|\| 360\} deg`\],\n\s+\["Behavior", "Continuous beam"\],\n\s+\["Power use", formatPowerUse\(stat\.powerUse\)\]\n\s+\];/,
  `return [
        ["Damage", \`\${formatDamage(weapon.damage)}/s\`],
        ["Range", formatDistance(weapon.range)],
        (weapon.antiMissile ? ["Role", "Anti-missile point defence"] : null),
        (weapon.missileHp ? ["Missile health", weapon.missileHp.toString()] : null),
        ["Beam radius", formatDistance(weapon.radius || 0)],
        ["Tracking", \`\${Math.round((weapon.tracking || 0) * 100)}% slow aim\`],
        ["Arc", \`\${weapon.arc || 360} deg\`],
        ["Behavior", "Continuous beam"],
        ["Power use", formatPowerUse(stat.powerUse)]
      ].filter(Boolean);`
);

// We need to also filter Boolean for normal weapons if it's not done properly
ui = ui.replace(
  /\]\.filter\(Boolean\);\n\s+\];/,
  `].filter(Boolean);`
);

fs.writeFileSync('public/src/ui/partInspectorUi.js', ui);
