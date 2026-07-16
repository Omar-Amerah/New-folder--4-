import { LOCAL_DESIGN_KEY, LOCAL_DESIGN_BACKUP_KEY, LOCAL_SAVED_DESIGNS_KEY, LOCAL_LOADOUTS_KEY, LOCAL_ACTIVE_ROOM_KEY } from "./constants.js";
import { LOCAL_PREFERENCES_KEY, getStorage } from "./localPreferences.js";
import { clearResumeCredential, normalizeRoomCode } from "./reconnectStorage.js";

export function categoryPresence(storage = getStorage()) {
  const has = (key) => { try { return Boolean(storage?.getItem(key)); } catch { return false; } };
  return {
    settings: has(LOCAL_PREFERENCES_KEY),
    currentBlueprint: has(LOCAL_DESIGN_KEY) || has(LOCAL_DESIGN_BACKUP_KEY),
    savedBlueprints: has(LOCAL_SAVED_DESIGNS_KEY),
    loadouts: has(LOCAL_LOADOUTS_KEY),
    recoverableRoom: has(LOCAL_ACTIVE_ROOM_KEY)
  };
}
export function removeKey(key, storage = getStorage()) { try { storage?.removeItem(key); return true; } catch { return false; } }
export function clearCurrentBlueprint() { return removeKey(LOCAL_DESIGN_KEY) && removeKey(LOCAL_DESIGN_BACKUP_KEY); }
export function clearSavedBlueprintsAndLoadouts() { return removeKey(LOCAL_SAVED_DESIGNS_KEY) && removeKey(LOCAL_LOADOUTS_KEY); }
export function forgetRecoverableRoom(storage = getStorage()) {
  const room = normalizeRoomCode(storage?.getItem?.(LOCAL_ACTIVE_ROOM_KEY));
  if (room) clearResumeCredential(room);
  return removeKey(LOCAL_ACTIVE_ROOM_KEY, storage);
}
