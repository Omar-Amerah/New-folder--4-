const assert = require('assert');
const fs = require('fs');

const ships = fs.readFileSync('public/src/game/pixi/pixiShips.js', 'utf8');
const view = fs.readFileSync('public/src/game/pixi/pixiShipView.js', 'utf8');
const outline = ships.match(/function updatePixiPlayerHullOutline[\s\S]*?\n}\n/)?.[0] || '';

assert.match(ships, /TEAM_STATUS_BORDER_COLORS[\s\S]*friendly:\s*"#38d5ff"[\s\S]*enemy:\s*"#ef4444"/, 'friendly/enemy status box borders use team colours');
assert.match(ships, /function statusBorderColorForPlayer[\s\S]*relation === "solo"\) return player\?\.color/, 'solo status boxes use the owner player colour');
assert.match(ships, /const borderColor = statusBorderColorForPlayer\(player\)/, 'health/shield HUD frame derives border colour from player/team ownership');
assert.match(ships, /drawPixiHudFrame\(gfx,[^\n]*borderColor/, 'HUD frame receives the computed team/player border colour');
assert.match(ships, /borderWidth = Math\.min\(2\.25, Math\.max\(0\.9, 1\.5 \/ zoom\)\)/, 'status-box border remains readable without becoming excessively thick');

assert.match(view, /const playerHullOutline = new PIXI\.Graphics\(\)/, 'ship views own a persistent player hull outline Graphics');
assert.match(view, /hullContainer\.addChild\(staticHullSprite\);[\s\S]*hullContainer\.addChild\(playerHullOutline\);[\s\S]*hullContainer\.addChild\(staticWeaponMounts\);/s, 'player outline is layered over hull edges but below mounts, damage, effects, and turrets');
assert.match(ships, /import \{ buildExteriorHullEdges \} from "\.\.\/shipHullOutline\.js";/, 'renderer imports the pure exterior hull outline helper');
assert.match(outline, /ship\.ownerId !== state\.myId/, 'local-player ships do not show permanent player-colour hull outlines');
assert.match(outline, /const color = shouldShow \? player\.color : null/, 'allied and enemy non-local ships use owner player colour for outlines');
assert.match(outline, /buildExteriorHullEdges\(design, \{ scale: SHIP_SCALE, isLive \}\)/, 'player outline geometry comes from the exterior hull helper');
assert.doesNotMatch(outline, /tracePoly\([^)]*footprintCorners|footprintCorners\(place, halfW, halfH\)/, 'outline no longer traces every component footprint polygon');
assert.match(outline, /alpha:\s*0\.48/, 'player-colour hull outline stays slightly transparent');
assert.match(outline, /const width =\s*\n?\s*Math\.min\(1\.4, Math\.max\(0\.65, 0\.95 \/ zoom\)\)/, 'player-colour hull outline width formula is unchanged');
assert.match(outline, /const isLive = \(index\) => \{[\s\S]*componentHealthRatio\(ship, index\)[\s\S]*ratio === null \|\| ratio > 0[\s\S]*\}/, 'destroyed components are represented through the shared live-mask callback');
assert.match(outline, /const liveMask = shouldShow \? design\.map\(\(_, index\) => isLive\(index\) \? "1" : "0"\)\.join\(""\) : ""/, 'outline cache uses a live/dead mask instead of raw HP values');
assert.match(outline, /pixiDesignSignature\(design\)/, 'outline cache includes the design signature for pooled ship views');
assert.match(outline, /gfx\.clear\(\)[\s\S]*gfx\.moveTo\(edge\.x1, edge\.y1\)[\s\S]*gfx\.lineTo\(edge\.x2, edge\.y2\)[\s\S]*gfx\.stroke/, 'persistent Graphics object is reused for returned edge paths');
assert.doesNotMatch(outline, /new\s+(PIXI\.)?(Graphics|Sprite)|Texture|BlurFilter|GlowFilter|filter/i, 'outline update does not allocate Pixi display objects, textures, or filters per frame');
assert.match(ships, /if \(view\.staticKey !== staticKey\)[\s\S]*rebuildPixiShipStatic/, 'hull textures rebuild only through static signature changes');
assert.match(ships, /const staticKey = pixiStaticSignature\(pixiDesignSignature\(design\), player\.color, ship\.radius \|\| 0, env\.bakeScale\)/, 'HP, shield, selection, and player outline state are excluded from hull texture signature');
assert.match(ships, /updatePixiPlayerHullOutline\(view, ship, player, design, zoom\);[\s\S]*updatePixiTurrets[\s\S]*updatePixiComponentDamage[\s\S]*if \(state\.selectedShipIds\.has\(ship\.id\)\) drawPixiSelectionRing/, 'selection/focus remain more prominent than permanent outline and bars');

console.log('ship identification renderer assertions passed');
