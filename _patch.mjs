import fs from "node:fs";
const p = "public/src/game/componentArt.js";
let s = fs.readFileSync(p, "utf8");
const crlf = s.includes("\r\n");
const fix = (t) => (crlf ? t.replace(/\n/g, "\r\n") : t);
export function apply(subs) {
  for (const [a, b] of subs) {
    const A = fix(a), B = fix(b);
    if (!s.includes(A)) { console.error("MISS:", JSON.stringify(a.slice(0, 70))); process.exit(1); }
    s = s.replace(A, B);
  }
  fs.writeFileSync(p, s);
  console.log("ok");
}
apply([
  ['    const pale = "#fdba74";\n', ''],
  ['    ctx.fillStyle = mixColor(color, "#05070c", 0.42);\n    ctx.strokeStyle = "rgba(3,6,12,0.78)";\n    ctx.lineWidth = Math.max(0.7, size * 0.045);',
   '    ctx.fillStyle = M.housing;\n    ctx.strokeStyle = "rgba(3,6,12,0.78)";\n    ctx.lineWidth = weaponFine(size);'],
  ['      ctx.lineWidth = Math.max(0.7, size * 0.05);\n      ctx.fillStyle = getTubeGradient(half, pale);',
   '      ctx.lineWidth = weaponLine(size) * 0.85;\n      ctx.fillStyle = getTubeGradient(half, M.shell);'],
  ['      ctx.fillStyle = "rgba(4,7,13,0.95)";\n      roundRect(ctx, {\n        x: tip - size * 0.1,',
   '      ctx.fillStyle = M.bore;\n      roundRect(ctx, {\n        x: tip - size * 0.1,'],
  ['      ctx.fillStyle = "rgba(255,230,196,0.72)";\n      ctx.fillRect(tip - size * 0.088',
   '      ctx.fillStyle = M.hot;\n      ctx.fillRect(tip - size * 0.088'],
]);
