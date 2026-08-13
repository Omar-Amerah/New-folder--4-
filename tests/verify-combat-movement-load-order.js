"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

function loadInOrder(first, second) {
  const firstPath = path.resolve(__dirname, "..", "src", "server", `${first}.js`);
  const secondPath = path.resolve(__dirname, "..", "src", "server", `${second}.js`);
  const code = `require(${JSON.stringify(firstPath)}); require(${JSON.stringify(secondPath)});`;
  const result = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Load order ${first} -> ${second} failed:\n${result.stderr || ""}`);
  }
}

loadInOrder("movement", "combat");
loadInOrder("combat", "movement");
console.log("Combat/movement load-order verification passed");
