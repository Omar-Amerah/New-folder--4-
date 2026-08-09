"use strict";
const { spawnSync } = require("child_process");
const steps = [
  ["node", ["tests/verify-package-json.js"]],
  ["npm", ["run", "build"]],
  ["npm", ["run", "balance:check"]],
  ["node", ["tests/verify-shared-parity.js"]],
  ["node", ["tests/verify-data-support-balance.js"]],
  ["node", ["tests/verify-shield-impact-heat.js"]],
  ["node", ["tests/verify-rotation-parity.js"]],
  ["node", ["tests/verify-protocol-schema.js"]],
  ["node", ["tests/verify-deployment-health.js"]],
  ["node", ["tests/verify-production-path.js"]],
  ["node", ["tests/verify-armor-delivery.js"]],
  ["node", ["tests/verify-support-and-weapon-semantics.js"]],
  ["node", ["tests/verify-section14-security.js"]],
  ["node", ["tests/verify-lifecycle.js"]]
];
for (const [cmd, args] of steps) {
  console.log(`\n[release:check] ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log("\nrelease:check passed");
