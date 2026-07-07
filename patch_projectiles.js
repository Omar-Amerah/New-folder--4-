const fs = require('fs');
let content = fs.readFileSync('src/server/projectiles.js', 'utf8');

// Now implement projectile hitting interceptables in updateBullets.
// First, add logic for pdShot.

content = content.replace(
  /const rockHit = projectileMapImpact\(room, previousX, previousY, bullet\);/,
  `
    if (bullet.type === "pdShot") {
       if (bullet.pdTargetType === "projectile") {
          const target = room.bullets.find(b => b.id === bullet.pdTargetId);
          if (target && target.interceptable && target.life > 0) {
             const dx = target.x - bullet.x;
             const dy = target.y - bullet.y;
             if (dx * dx + dy * dy <= 400) { // 20 radius
                target.hp -= bullet.damage;
                bullet.life = 0;
                room.effects.push({ type: "spark", x: bullet.x, y: bullet.y, at: now });
                if (target.hp <= 0) {
                   target.life = 0;
                   room.effects.push({ type: "burst", x: target.x, y: target.y, at: now });
                }
                continue;
             }
          }
       }
    }

    const rockHit = projectileMapImpact(room, previousX, previousY, bullet);`
);

content = content.replace(
  /room\.effects\.push\(\{ type: bullet\.type === "missile" \? "burst" : bullet\.type === "rail" \? "railhit" : "spark", x: bullet\.x, y: bullet\.y, at: now \}\);/,
  `room.effects.push({ type: (bullet.type === "missile" || bullet.type === "torpedo") ? "burst" : bullet.type === "rail" ? "railhit" : "spark", x: bullet.x, y: bullet.y, at: now });`
);


fs.writeFileSync('src/server/projectiles.js', content);
