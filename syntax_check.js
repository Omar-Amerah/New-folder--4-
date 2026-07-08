const fs = require('fs');
const file = 'public/src/game/renderer.js';
const content = fs.readFileSync(file, 'utf8');
try {
  new Function(content);
} catch (e) {
  console.log(e.toString());
}
