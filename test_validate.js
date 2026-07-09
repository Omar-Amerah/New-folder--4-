const makeExpensiveDesign = () => {
  const design = [];
  for (let y = 0; y <= 6; y += 1) {
    for (let x = 0; x <= 6; x += 1) {
      if (x === 3 && y === 3) continue;
      design.push({ x, y, type: "blaster" });
    }
  }
  design.push({ x: 3, y: 3, type: "core" });
  return design;
}
const design = makeExpensiveDesign();
const val = require('./src/server/shipDesign.js').validateDesign(design);
console.log(val.ok);
if (!val.ok) console.log(val.reason);
