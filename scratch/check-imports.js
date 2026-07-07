const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "public", "src");

// Standard browser globals / JS globals
const GLOBALS = new Set([
  "console", "window", "document", "localStorage", "performance", "WebSocket",
  "location", "navigator", "fetch", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "Math", "Number", "String", "Array", "Object", "Set", "Map",
  "Date", "JSON", "Error", "Boolean", "URL", "URLSearchParams", "isNaN",
  "parseInt", "parseFloat", "Infinity", "NaN", "undefined", "this", "navigator",
  "location", "history", "requestAnimationFrame"
]);

function getFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFiles(filePath));
    } else if (file.endsWith(".js")) {
      results.push(filePath);
    }
  });
  return results;
}

const files = getFiles(srcDir);

for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  const relPath = path.relative(srcDir, file).replace(/\\/g, "/");

  // Parse imports
  const imports = new Set();
  const importRegex = /import\s+(?:([\w*,{}'\s]+)\s+from\s+)?["']([^"']+)["']/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importClause = match[1];
    if (importClause) {
      // Clean up brackets, spaces, and commas
      const names = importClause.replace(/[{}]/g, " ").split(/\s*,\s*|\s+/).map(n => n.trim()).filter(Boolean);
      names.forEach(n => imports.add(n));
    }
  }

  // Parse local declarations (functions, variables, classes)
  const locals = new Set();

  // function declarations: function name(...) or export function name(...)
  const funcRegex = /(?:export\s+)?function\s+(\w+)\s*\(/g;
  while ((match = funcRegex.exec(content)) !== null) {
    locals.add(match[1]);
  }

  // const/let/var declarations: const x = ..., let x = ...
  const varRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)/g;
  while ((match = varRegex.exec(content)) !== null) {
    locals.add(match[1]);
  }

  // class declarations
  const classRegex = /(?:export\s+)?class\s+(\w+)/g;
  while ((match = classRegex.exec(content)) !== null) {
    locals.add(match[1]);
  }

  // Find all word tokens in the file
  // Filter out keywords, local variable names, imports, and globals
  const words = content.match(/[a-zA-Z_]\w*/g) || [];
  const unresolved = new Set();

  // Simple parser to identify function scopes and block variables would be ideal,
  // but a word check against (locals + imports + globals + common JS keywords) is a very good heuristic.
  const keywords = new Set([
    "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
    "return", "export", "import", "from", "const", "let", "var", "function",
    "class", "extends", "new", "typeof", "instanceof", "in", "of", "try",
    "catch", "finally", "throw", "default", "async", "await", "true", "false",
    "null", "import", "meta", "as", "default", "let"
  ]);

  for (const word of words) {
    if (GLOBALS.has(word)) continue;
    if (keywords.has(word)) continue;
    if (locals.has(word)) continue;
    if (imports.has(word)) continue;

    // Check if it's a property access (like obj.prop, where prop shouldn't count as unresolved)
    // We can do this by checking if the word is preceded by a dot
    const index = content.indexOf(word);
    if (index > 0 && content[index - 1] === ".") {
      continue;
    }

    unresolved.add(word);
  }

  // Print unresolved variables
  if (unresolved.size > 0) {
    console.log(`File: ${relPath}`);
    console.log("  Unresolved words:", Array.from(unresolved).join(", "));
  }
}
