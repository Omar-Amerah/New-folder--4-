const fs = require('fs');

const data = JSON.parse(fs.readFileSync('component-balance.json', 'utf8'));


// Update missiles with HP
for (const comp of data.components) {
  if (comp.id === 'missile') {
    comp.weapon.missileHp = 18;
  }
  if (comp.id === 'swarmMissile') {
    comp.weapon.missileHp = 8;
  }
  if (comp.id === 'torpedo') {
    comp.weapon.missileHp = 45;
  }
}

// Add new defence parts
const newParts = [
  {
    id: "flakCannon",
    name: "Flak Cannon",
    category: "Defence",
    cost: 38,
    mass: 5,
    hp: 42,
    powerGeneration: 0,
    powerUse: 3.0,
    shield: 0,
    shieldRegen: 0,
    thrust: 0,
    turn: -0.01,
    energy: 0,
    repair: 0,
    weapon: {
      family: "pointDefense",
      damage: 8,
      fireRate: 2.5,
      range: 220,
      projectileSpeed: 800,
      accuracy: 0.7,
      tracking: 0,
      arc: 360,
      antiMissile: true,
      targetPriority: ["missile", "torpedo", "projectile", "ship"],
      shipDamageMultiplier: 0.15
    },
    rotatable: true,
    description: "Short-range anti-missile and anti-swarm defence. Poor range and weak direct damage."
  },
  {
    id: "interceptorPod",
    name: "Interceptor Pod",
    category: "Defence",
    cost: 55,
    mass: 6,
    hp: 48,
    powerGeneration: 0,
    powerUse: 4.2,
    shield: 0,
    shieldRegen: 0,
    thrust: 0,
    turn: -0.02,
    energy: 0,
    repair: 0,
    weapon: {
      family: "pointDefense",
      damage: 40,
      fireRate: 1.2,
      range: 450,
      projectileSpeed: 1600,
      accuracy: 0.9,
      tracking: 0,
      arc: 360,
      antiMissile: true,
      targetPriority: ["torpedo", "missile", "projectile", "ship"],
      shipDamageMultiplier: 0.1
    },
    rotatable: true,
    description: "Longer-range missile interception. Expensive and weak against ships."
  },

];

data.components.push(...newParts);

fs.writeFileSync('component-balance.json', JSON.stringify(data, null, 2) + "\n");
