// Room-scoped reconnect credential storage. These opaque capabilities are only
// for resuming an in-memory room slot; they are not account authentication.

const PREFIX = "modular-fleet-resume-v1:";

export function normalizeRoomCode(roomCode) {
  return String(roomCode || "").trim().toUpperCase().slice(0, 8);
}

function storageKey(roomCode) {
  const code = normalizeRoomCode(roomCode);
  return code ? `${PREFIX}${code}` : "";
}

function getStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    const test = `${PREFIX}test`;
    localStorage.setItem(test, "1");
    localStorage.removeItem(test);
    return localStorage;
  } catch {
    return null;
  }
}

export function saveResumeCredential(roomCode, token) {
  const storage = getStorage();
  const key = storageKey(roomCode);
  if (!storage || !key || typeof token !== "string" || token.length === 0 || token.length > 128) return false;
  try {
    storage.setItem(key, token);
    return true;
  } catch {
    return false;
  }
}

export function getResumeCredential(roomCode) {
  const storage = getStorage();
  const key = storageKey(roomCode);
  if (!storage || !key) return "";
  try {
    const token = storage.getItem(key) || "";
    return typeof token === "string" && token.length <= 128 ? token : "";
  } catch {
    return "";
  }
}

export function clearResumeCredential(roomCode) {
  const storage = getStorage();
  const key = storageKey(roomCode);
  if (!storage || !key) return;
  try { storage.removeItem(key); } catch { /* unavailable */ }
}
