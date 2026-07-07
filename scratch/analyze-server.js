const fs = require("fs");
const path = require("path");

const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const lines = serverCode.split(/\r?\n/);

console.log("=== CONSTANTS & GLOBALS ===");
const globalVarRegex = /^(const|let|var)\s+(\w+)\s*=/;
lines.forEach((line, index) => {
  const match = line.match(globalVarRegex);
  if (match) {
    console.log(`Line ${index + 1}: ${match[1]} ${match[2]}`);
  }
});

console.log("\n=== TOP LEVEL FUNCTIONS ===");
const funcRegex = /^function\s+(\w+)\s*\(/;
lines.forEach((line, index) => {
  const match = line.match(funcRegex);
  if (match) {
    console.log(`Line ${index + 1}: function ${match[1]}`);
  }
});
