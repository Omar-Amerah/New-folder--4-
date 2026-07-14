// Identifies this server build for frontend/backend skew detection. The
// frontend (Netlify) and the WebSocket backend deploy separately, so both the
// hello message and state snapshots carry the protocol version and build SHA.

const { PROTOCOL_VERSION } = require("../../public/src/shared/protocolVersion");

function resolveBuildSha() {
  const fromEnv = process.env.MFA_BUILD_SHA || process.env.COMMIT_REF || process.env.SOURCE_VERSION || "";
  if (fromEnv) return String(fromEnv).trim();
  try {
    const { execSync } = require("child_process");
    const sha = execSync("git rev-parse HEAD", {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"]
    }).toString().trim();
    if (sha) return sha;
  } catch {
    // Not a git checkout (e.g. a bare deploy) — fall through.
  }
  return "dev";
}

const SERVER_BUILD_SHA = resolveBuildSha();

module.exports = { SERVER_BUILD_SHA, PROTOCOL_VERSION };
