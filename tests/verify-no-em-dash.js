"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_ROOT = path.join(ROOT, "public");
const BALANCE_FILE = path.join(ROOT, "component-balance.json");
const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".svg"]);
const SKIPPED_DIRECTORIES = new Set(["audio", "vendor"]);
const FORBIDDEN_TOKENS = [
  { token: String.fromCodePoint(0x2014), label: "U+2014" },
  { token: "\\u2014", label: "escaped U+2014" },
  { token: "\\u{2014}", label: "escaped U+2014" }
];

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

function textFilesUnder(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
      files.push(...textFilesUnder(path.join(directory, entry.name)));
      continue;
    }
    if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

const files = [...textFilesUnder(PUBLIC_ROOT), BALANCE_FILE];
const violations = [];

for (const file of files) {
  const contents = fs.readFileSync(file, "utf8");
  for (const { token, label } of FORBIDDEN_TOKENS) {
    let offset = contents.indexOf(token);
    while (offset !== -1) {
      violations.push(`${relative(file)}:${lineNumberAt(contents, offset)} contains ${label}`);
      offset = contents.indexOf(token, offset + token.length);
    }
  }
}

if (violations.length > 0) {
  console.error("No-em-dash verification failed:");
  for (const violation of violations) console.error(` - ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`No-em-dash verification passed (${files.length} files scanned).`);
}
