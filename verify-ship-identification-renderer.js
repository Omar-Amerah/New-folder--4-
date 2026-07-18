const assert = require('assert');
const fs = require('fs');

const ships = fs.readFileSync('public/src/game/pixi/pixiShips.js', 'utf8');
const view = fs.readFileSync('public/src/game/pixi/pixiShipView.js', 'utf8');

assert.match(ships, /TEAM_STATUS_BORDER_COLORS[\s\S]*friendly:\s*"#38d5ff"[\s\S]*enemy:\s*"#ef4444"/, 'friendly/enemy status box borders use team colours');
assert.match(ships, /function statusBorderColorForPlayer[\s\S]*relation === "solo"\) return player\?\.color/, 'solo status boxes use the owner player colour');
assert.match(ships, /const borderColor = statusBorderColorForPlayer\(player\)/, 'health/shield HUD frame derives border colour from player/team ownership');
assert.match(ships, /drawPixiHudFrame\(gfx,[^\n]*borderColor/, 'HUD frame receives the computed team/player border colour');
assert.match(ships, /borderWidth = Math\.min\(2\.25, Math\.max\(0\.9, 1\.5 \/ zoom\)\)/, 'status-box border remains readable without becoming excessively thick');

assert.match(view, /const playerHullOutline = new PIXI\.Graphics\(\)/, 'ship views own a persistent player hull outline Graphics');
assert.match(view, /hullContainer\.addChild\(staticHullSprite\);[\s\S]*hullContainer\.addChild\(playerHullOutline\);[\s\S]*hullContainer\.addChild\(staticWeaponMounts\);/s, 'player outline is layered over hull edges but below mounts, damage, effects, and turrets');
assert.match(ships, /function updatePixiPlayerHullOutline[\s\S]*ship\.ownerId !== state\.myId/, 'local-player ships do not show permanent player-colour hull outlines');
assert.match(ships, /const color = shouldShow \? player\.color : null/, 'allied and enemy non-local ships use owner player colour for outlines');
assert.match(ships, /alpha:\s*0\.48/, 'player-colour hull outline stays slightly transparent');
assert.match(ships, /width = Math\.min\(1\.4, Math\.max\(0\.65, 0\.95 \/ zoom\)\)/, 'player-colour hull outline stays thin across zoom levels');
assert.match(ships, /footprintCorners\(place, halfW, halfH\)/, 'outline follows each visible component hull footprint instead of texture bounds');
assert.match(ships, /if \(ratio !== null && ratio <= 0\) continue/, 'destroyed components do not contribute incorrect outline blocks');
assert.doesNotMatch(ships.match(/function updatePixiPlayerHullOutline[\s\S]*?\n}\n/)?.[0] || '', /new\s+(PIXI\.)?(Graphics|Sprite)|Texture|BlurFilter|GlowFilter|filter/i, 'outline update does not allocate Pixi display objects, textures, or filters per frame');
assert.match(ships, /if \(view\.staticKey !== staticKey\)[\s\S]*rebuildPixiShipStatic/, 'hull textures rebuild only through static signature changes');
assert.match(ships, /const staticKey = pixiStaticSignature\(pixiDesignSignature\(design\), player\.color, ship\.radius \|\| 0, env\.bakeScale\)/, 'HP, shield, selection, and player outline state are excluded from hull texture signature');
assert.match(ships, /updatePixiPlayerHullOutline\(view, ship, player, design, zoom\);[\s\S]*updatePixiTurrets[\s\S]*updatePixiComponentDamage[\s\S]*if \(state\.selectedShipIds\.has\(ship\.id\)\) drawPixiSelectionRing/, 'selection/focus remain more prominent than permanent outline and bars');

console.log('ship identification renderer assertions passed');
