"use strict";
const fs = require("fs");
const { spawnSync } = require("child_process");
const path = require("path");
const fixture = path.join(__dirname, "public", "src", "__missing_import_fixture__.js");
try {
  const ok = spawnSync(process.execPath, ["verify-module-boundaries.js"], { cwd: __dirname, encoding: "utf8" });
  if (ok.status !== 0) throw new Error(ok.stdout + ok.stderr);
  fs.writeFileSync(fixture, "import './does-not-exist.js';\n", "utf8");
  const bad = spawnSync(process.execPath, ["verify-module-boundaries.js"], { cwd: __dirname, encoding: "utf8" });
  if (bad.status === 0 || !/imports missing \.\/does-not-exist\.js/.test(bad.stderr + bad.stdout)) {
    throw new Error(`Missing-import regression did not fail as expected:\n${bad.stdout}\n${bad.stderr}`);
  }
  console.log("Module import verification passed");
} finally {
  fs.rmSync(fixture, { force: true });
}
