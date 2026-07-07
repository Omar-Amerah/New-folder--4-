const fs = require('fs');
let proj = fs.readFileSync('src/server/projectiles.js', 'utf8');

// Update damageShip calls in projectiles.js
proj = proj.replace(
  /damageShip\(room, ship, bullet\.damage, bullet\.ownerId, now\);/,
  `damageShip(room, ship, bullet.damage, bullet.ownerId, now, bullet.x, bullet.y);`
);

fs.writeFileSync('src/server/projectiles.js', proj);
