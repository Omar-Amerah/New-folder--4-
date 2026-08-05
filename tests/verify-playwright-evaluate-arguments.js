const fs = require('fs');
const path = require('path');
const files = process.argv.slice(2);
if (!files.length) throw new Error('usage: node verify-playwright-evaluate-arguments.js <files...>');
function findCalls(source) {
  const bad=[]; let i=0;
  while ((i=source.indexOf('.evaluate(', i)) !== -1) {
    const start=i+'.evaluate('.length; let depth=0, args=1, quote=null, templateDepth=0;
    for (let j=start;j<source.length;j++) {
      const ch=source[j], prev=source[j-1];
      if (quote) { if (ch===quote && prev!=='\\') quote=null; continue; }
      if (ch==='"'||ch==="'"||ch==='`') { quote=ch; continue; }
      if (ch==='('||ch==='['||ch==='{') depth++;
      else if (ch===')') { if(depth===0){ if(args>2) bad.push({ index:i, args }); i=j+1; break; } depth--; }
      else if (ch===']'||ch==='}') depth--;
      else if (ch===',' && depth===0) args++;
    }
  }
  return bad;
}
let failed=false;
for (const file of files) {
  const source=fs.readFileSync(file,'utf8');
  for (const call of findCalls(source)) {
    const line=source.slice(0,call.index).split('\n').length;
    console.error(`${file}:${line}: page.evaluate accepts at most one serializable argument; found ${call.args-1}`);
    failed=true;
  }
}
if (failed) process.exit(1);
console.log(`Playwright evaluate argument verifier passed for ${files.length} file(s)`);
