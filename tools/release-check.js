"use strict";
const { spawnSync } = require("child_process");
const steps = [
  ["npm", ["run", "build"]],
  ["npm", ["run", "balance:check"]],
  ["node", ["verify-shared-parity.js"]],
  ["node", ["verify-data-support-balance.js"]],
  ["node", ["verify-data-support-reference-parity.js"]],
  ["node", ["verify-thermal-parity.js"]],
  ["node", ["verify-protocol-schema.js"]],
  ["node", ["verify-deployment-health.js"]],
  ["node", ["verify-production-path.js"]],
  ["node", ["verify-section14-security.js"]],
  ["node", ["verify-lifecycle.js"]]
];
for (const [cmd, args] of steps) {
  console.log(`\n[release:check] ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log("\nrelease:check passed");
