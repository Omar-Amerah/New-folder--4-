"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const CLIENT_ROOT = path.join(ROOT, "public", "src");
const SERVER_ROOT = path.join(ROOT, "src", "server");
const ALLOWED_CLIENT_ESCAPES = new Set([path.join(ROOT, "component-balance.json")]);
const ALLOWED_SERVER_ESCAPES = [path.join(ROOT, "public", "src", "shared")];
const warnings = [];

function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (/\.js$/.test(ent.name)) out.push(full);
  }
  return out;
}
function strip(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
function importsFor(file, kind) {
  const code = strip(fs.readFileSync(file, "utf8"));
  const deps = [];
  if (kind === "client") {
    for (const m of code.matchAll(/\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)) deps.push({ spec: m[1], dynamic: false });
    for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) deps.push({ spec: m[1], dynamic: true });
  } else {
    for (const m of code.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) deps.push({ spec: m[1], dynamic: false });
  }
  return deps;
}
function resolveRelative(from, spec) {
  const base = path.resolve(path.dirname(from), spec.split(/[?#]/)[0]);
  const tries = [base, `${base}.js`, path.join(base, "index.js"), `${base}.json`];
  return tries.find((p) => fs.existsSync(p));
}
function isSourceFile(file) { return file.endsWith(".js"); }

const errors = [];
function fail(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

function checkRoot(files, root, kind) {
  const graph = new Map();
  const set = new Set(files);
  for (const file of files) {
    const deps = [];
    for (const dep of importsFor(file, kind)) {
      if (!dep.spec.startsWith(".")) continue;
      const resolved = resolveRelative(file, dep.spec);
      if (!resolved) { fail(`${rel(file)} imports missing ${dep.spec}`); continue; }
      const resolvedReal = path.resolve(resolved);
      const inside = resolvedReal.startsWith(root + path.sep);
      if (!inside) {
        if (!((kind === "client" && ALLOWED_CLIENT_ESCAPES.has(resolvedReal)) || (kind === "server" && ALLOWED_SERVER_ESCAPES.some((p) => resolvedReal.startsWith(p + path.sep))))) {
          fail(`${rel(file)} imports ${dep.spec}, escaping ${rel(root)} to ${rel(resolvedReal)}`);
        }
      }
      if (isSourceFile(resolvedReal) && set.has(resolvedReal)) deps.push(resolvedReal);
      if (kind === "client" && rel(resolvedReal) === "public/client.js") fail(`${rel(file)} relies on obsolete generated global bundle`);
    }
    graph.set(file, deps);
  }
  const visiting = new Set(), seen = new Set(), stack = [];
  function dfs(node) {
    visiting.add(node); stack.push(node);
    for (const dep of graph.get(node) || []) {
      if (!seen.has(dep) && visiting.has(dep)) {
        const i = stack.indexOf(dep);
        warn(`direct/static cycle: ${stack.slice(i).concat(dep).map(rel).join(" -> ")}`);
      } else if (!seen.has(dep)) dfs(dep);
    }
    visiting.delete(node); seen.add(node); stack.pop();
  }
  for (const f of files) if (!seen.has(f)) dfs(f);
  return graph;
}

function checkFrontendPath(clientFiles) {
  const index = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  if (!/type=["']module["'][^>]+src=["']\/src\/main\.js/.test(index)) fail("public/index.html must load /src/main.js as the module entry point");
  if (/client\.js/.test(index)) fail("public/index.html must not load obsolete public/client.js");
  if (fs.existsSync(path.join(ROOT, "public", "client.js"))) fail("public/client.js exists; remove generated classic bundle before checking");
  const build = fs.readFileSync(path.join(ROOT, "netlify-build.js"), "utf8");
  if (/clientJsPath|Strip imports|bundledCode|public\/client\.js|public",\s*"client\.js/.test(build)) fail("netlify-build.js still contains client.js concatenation logic");
  const reachable = new Set();
  const graph = checkRoot(clientFiles, CLIENT_ROOT, "client");
  function visit(file) { if (reachable.has(file)) return; reachable.add(file); for (const dep of graph.get(file) || []) visit(dep); }
  visit(path.join(CLIENT_ROOT, "main.js"));
  for (const file of clientFiles) {
    if (!reachable.has(file)) warn(`${rel(file)} is not statically reachable from public/src/main.js (script tag/shared or dynamic/test-only module)`);
  }
}

const clientFiles = walk(CLIENT_ROOT);
const serverFiles = walk(SERVER_ROOT);
checkFrontendPath(clientFiles);
checkRoot(serverFiles, SERVER_ROOT, "server");

if (warnings.length) {
  console.warn("Module boundary verification warnings:");
  for (const w of [...new Set(warnings)]) console.warn(` - ${w}`);
}
if (errors.length) {
  console.error("Module boundary verification failed:");
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log(`Module boundary verification passed (${clientFiles.length} client modules, ${serverFiles.length} server modules).`);
