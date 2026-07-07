const fs = require('fs');

const data = JSON.parse(fs.readFileSync('component-balance.json', 'utf8'));

// Remove old pointDefense
const pointDefenseIdx = data.components.findIndex(c => c.id === 'pointDefense');
if (pointDefenseIdx !== -1) {
  data.components.splice(pointDefenseIdx, 1);
}

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
    id: "pointDefenseLaser",
    name: "Point Defence Laser",
    category: "Defence",
    cost: 32,
    mass: 3,
    hp: 35,
    powerGeneration: 0,
    powerUse: 2.4,
    shield: 0,
    shieldRegen: 0,
    thrust: 0,
    turn: 0,
    energy: 0,
    repair: 0,
    weapon: {
      family: "pointDefense",
      damage: 18,
      fireRate: 4.5,
      range: 280,
      projectileSpeed: 1200,
      accuracy: 0.95,
      tracking: 0,
      arc: 360,
      antiMissile: true,
      targetPriority: ["missile", "torpedo", "projectile", "ship"],
      shipDamageMultiplier: 0.25
    },
    rotatable: true,
    description: "Protects nearby ships from missiles and torpedoes. Very weak against normal ships."
  },
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
  {
    id: "ecmModule",
    name: "ECM Module",
    category: "Defence",
    cost: 45,
    mass: 4,
    hp: 30,
    powerGeneration: 0,
    powerUse: 3.5,
    shield: 0,
    shieldRegen: 0,
    thrust: 0,
    turn: 0.01,
    energy: 0,
    repair: 0,
    ecmStrength: 0.25,
    description: "Makes this ship harder for missiles to track. Does not protect against guns, beams, or railguns."
  },
  {
    id: "decoyLauncher",
    name: "Decoy Launcher",
    category: "Defence",
    cost: 38,
    mass: 3,
    hp: 28,
    powerGeneration: 0,
    powerUse: 1.8,
    shield: 0,
    shieldRegen: 0,
    thrust: 0,
    turn: 0,
    energy: 0,
    repair: 0,
    decoyRange: 340,
    decoyCooldown: 7,
    decoyConfuseDuration: 1.2,
    decoyChance: 0.85,
    description: "Confuses incoming missiles before impact. Cooldown-based and useless against guns."
  },
  {
    id: "forwardDeflector",
    name: "Forward Deflector",
    category: "Defence",
    cost: 52,
    mass: 5,
    hp: 36,
    powerGeneration: 0,
    powerUse: 4.2,
    shield: 45,
    shieldRegen: 0.7,
    thrust: 0,
    turn: -0.02,
    energy: 0,
    repair: 0,
    frontDamageReduction: 0.18,
    frontArc: 90,
    description: "Reduces damage from enemies in front of the ship. Weak if flanked or attacked from behind."
  }
];

data.components.push(...newParts);

fs.writeFileSync('component-balance.json', JSON.stringify(data, null, 2) + "\n");
