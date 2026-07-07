const { computeStats } = require('./src/server/shipStats.js');
const { PARTS } = require('./src/server/components.js');

const stats = computeStats([{ type: 'core', x: 3, y: 3 }, { type: 'ecmModule', x: 4, y: 3 }, { type: 'pointDefenseLaser', x: 2, y: 3}]);
console.log(stats.ecmStrength, stats.pointDefense, stats.warnings);
