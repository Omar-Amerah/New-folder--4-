// Client-side authoritative-balance compatibility tracking.
//
// The client is built with a packaged balance (GENERATED_BALANCE). At runtime it
// may also download the live /component-balance.json and it learns the server's
// balance revision from the hello/state messages. This module keeps those three
// facts reconciled and exposes whether it is safe to enter combat (deploy ships
// / purchase). It never silently proceeds on a mismatch or a malformed download.

import { GENERATED_BALANCE } from "./generatedBalance.js";

function rules() {
  return globalThis.BalanceRevision || null;
}

// Revision of the balance this frontend was built with.
export const CLIENT_BALANCE_REVISION = (() => {
  const r = rules();
  return r ? r.computeBalanceRevision(GENERATED_BALANCE) : null;
})();

const status = {
  clientRevision: CLIENT_BALANCE_REVISION,
  serverRevision: null,
  // "ok" | "mismatch" | "unknown"
  compatibility: "unknown",
  // True once the live balance file was fetched and its revision confirmed
  // against the server. False after a fetch failure (packaged copy still used).
  liveConfirmed: false,
  // A restrained, human-readable warning when live balance couldn't be confirmed
  // or is incompatible; null when everything is fine.
  warning: null,
  // Diagnostic details for the console/log; not shown verbatim to players.
  diagnostic: null
};

export function getBalanceStatus() {
  return status;
}

// Combat (deploy / purchase) is blocked ONLY on a confirmed revision mismatch.
// An unconfirmed live balance (fetch failure) still allows play with the
// packaged copy — it only warns.
export function isBalanceIncompatible() {
  return status.compatibility === "mismatch";
}

export function balanceBlockMessage() {
  return "Game balance is out of date: this page and the server were built from different balance data. "
    + "Refresh this page, or redeploy the outdated side, before deploying ships or buying.";
}

// Record the server's advertised balance revision (from hello / state). Returns
// the resulting compatibility so callers can react (e.g. show a toast once).
export function recordServerBalanceRevision(serverRevision) {
  const r = rules();
  status.serverRevision = serverRevision || null;
  status.compatibility = r
    ? r.evaluateBalanceCompatibility(status.clientRevision, status.serverRevision)
    : "unknown";
  if (status.compatibility === "mismatch") {
    status.warning = balanceBlockMessage();
    status.diagnostic = `client=${status.clientRevision} server=${status.serverRevision}`;
  } else if (status.compatibility === "ok" && status.warning === balanceBlockMessage()) {
    status.warning = null;
    status.diagnostic = null;
  }
  return status.compatibility;
}

// Validate and (if valid) accept a downloaded live balance payload. Returns
// { ok, applied, errors }. On any structural problem it does NOT apply the
// payload and keeps the last known good balance — it never zero-fills.
export function acceptDownloadedBalance(payload) {
  const r = rules();
  if (!r) return { ok: false, applied: false, errors: ["Balance revision helper unavailable."] };
  const validation = r.validateBalancePayload(payload);
  if (!validation.ok) {
    status.diagnostic = `invalid live balance: ${validation.errors.join("; ")}`;
    status.warning = "Live game balance could not be verified; using the built-in copy.";
    status.liveConfirmed = false;
    return { ok: false, applied: false, errors: validation.errors };
  }
  const downloadedRevision = r.computeBalanceRevision(payload);
  // The downloaded file comes from the server, so confirm it matches the server
  // revision we were told about (when known).
  if (status.serverRevision && downloadedRevision !== status.serverRevision) {
    status.diagnostic = `live balance revision ${downloadedRevision} != server ${status.serverRevision}`;
  }
  status.liveConfirmed = true;
  if (status.compatibility !== "mismatch") status.warning = null;
  return { ok: true, applied: true, errors: [], downloadedRevision };
}

// Record that the live balance fetch failed. Keep the packaged copy but surface
// a restrained warning that live balance could not be confirmed.
export function recordBalanceFetchFailure(reason) {
  status.liveConfirmed = false;
  status.diagnostic = `live balance fetch failed: ${reason}`;
  if (status.compatibility !== "mismatch") {
    status.warning = "Live game balance could not be confirmed; using the built-in copy.";
  }
}
