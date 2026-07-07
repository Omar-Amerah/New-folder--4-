const fs = require('fs');

let ui = fs.readFileSync('public/src/ui/partInspectorUi.js', 'utf8');

// Need to add detailed properties for new parts
ui = ui.replace(
  /if \(stat\.utilityEffect \|\| stat\.rangeBonus \|\| stat\.accuracyBonus \|\| stat\.fireRateBonus \|\| stat\.captureBonus \|\| stat\.heat\) \{/,
  `if (type === "ecmModule") {
    return [
      ["ECM Strength", \`-\${Math.round((stat.ecmStrength || 0) * 100)}% missile tracking\`],
      ["Power use", formatPowerUse(stat.powerUse)],
      ["Mass", formatMass(stat.mass)]
    ];
  }

  if (type === "decoyLauncher") {
    return [
      ["Decoy range", formatDistance(stat.decoyRange)],
      ["Cooldown", \`\${stat.decoyCooldown || 0}s\`],
      ["Confusion duration", \`\${stat.decoyConfuseDuration || 0}s\`],
      ["Success chance", formatPercent(stat.decoyChance || 0)],
      ["Power use", formatPowerUse(stat.powerUse)]
    ];
  }

  if (type === "forwardDeflector") {
    return [
      ["Frontal reduction", \`\${Math.round((stat.frontDamageReduction || 0) * 100)}%\`],
      ["Front arc", \`\${stat.frontArc || 0} deg\`],
      ["Shield amount", formatShield(stat.shield)],
      ["Recharge rate", \`\${stat.shieldRegen}/s\`],
      ["Power draw", formatPowerUse(stat.powerUse)]
    ];
  }

  if (stat.utilityEffect || stat.rangeBonus || stat.accuracyBonus || stat.fireRateBonus || stat.captureBonus || stat.heat) {`
);

// We should also update weapon section to show pointDefense and anti-missile stats and missile HP
ui = ui.replace(
  /\["Range", formatDistance\(weapon\.range\)\],/,
  `["Range", formatDistance(weapon.range)],
      (weapon.antiMissile ? ["Role", "Anti-missile point defence"] : null),
      (weapon.missileHp ? ["Missile health", weapon.missileHp.toString()] : null),`
);

// Also need to filter out nulls in the array
ui = ui.replace(
  /return \[([^\]]+)\];/g,
  function(match, p1) {
    if (p1.includes('["Damage"')) {
      return `return [\n${p1}\n    ].filter(Boolean);`;
    }
    return match;
  }
);

fs.writeFileSync('public/src/ui/partInspectorUi.js', ui);
