const { computeStats } = require('./src/server/shipStats.js');
const { PARTS } = require('./src/server/components.js');

const stats = computeStats([{ type: 'core', x: 3, y: 3 }, { type: 'shield', x: 4, y: 3 }, { type: 'flakCannon', x: 2, y: 3}]);
console.log(stats.maxShield, stats.pointDefense, stats.warnings);
