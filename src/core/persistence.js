import { SAVE_KEYS, SAVE_SCHEMA_VERSION } from "./config.js";
import { deepClone } from "./utils.js";

const SLOT_ORDER = ["slot1", "slot2", "slot3"];

function getStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasMinimalStateShape(payload) {
  if (!isPlainObject(payload)) {
    return false;
  }

  return (
    isPlainObject(payload.meta) &&
    isPlainObject(payload.run) &&
    isPlainObject(payload.resources) &&
    isPlainObject(payload.project) &&
    isPlainObject(payload.entropy) &&
    isPlainObject(payload.market) &&
    isPlainObject(payload.plan) &&
    Array.isArray(payload.history)
  );
}

function migrateSavePayload(payload) {
  const copy = deepClone(payload);

  if (!copy.meta || typeof copy.meta !== "object") {
    return null;
  }

  const version = Number(copy.meta.schemaVersion ?? 0);

  if (!Number.isFinite(version) || version <= 0) {
    return null;
  }

  if (version > SAVE_SCHEMA_VERSION) {
    return null;
  }

  if (version === SAVE_SCHEMA_VERSION) {
    return copy;
  }

  // Placeholder for future migration steps.
  copy.meta.schemaVersion = SAVE_SCHEMA_VERSION;
  return copy;
}

function ensureSaveKey(saveKey) {
  if (typeof saveKey === "string" && saveKey.length > 0) {
    return saveKey;
  }

  return SAVE_KEYS.autosave;
}

export function saveGameState(saveKey, gameState) {
  const storage = getStorage();

  if (!storage) {
    return {
      ok: false,
      error: "Local storage is not available in this runtime.",
    };
  }

  if (!hasMinimalStateShape(gameState)) {
    return {
      ok: false,
      error: "Game state cannot be saved due to invalid shape.",
    };
  }

  const key = ensureSaveKey(saveKey);

  try {
    const serialized = JSON.stringify(gameState);
    storage.setItem(key, serialized);

    return {
      ok: true,
      key,
      bytes: serialized.length,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to save state.",
    };
  }
}

export function loadGameState(saveKey) {
  const storage = getStorage();

  if (!storage) {
    return {
      ok: false,
      error: "Local storage is not available in this runtime.",
      state: null,
    };
  }

  const key = ensureSaveKey(saveKey);

  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return {
        ok: true,
        key,
        state: null,
      };
    }

    const parsed = JSON.parse(raw);
    const migrated = migrateSavePayload(parsed);

    if (!hasMinimalStateShape(migrated)) {
      return {
        ok: false,
        key,
        error: "Stored payload does not match expected save schema.",
        state: null,
      };
    }

    return {
      ok: true,
      key,
      state: migrated,
    };
  } catch (error) {
    return {
      ok: false,
      key,
      error: error instanceof Error ? error.message : "Failed to load save state.",
      state: null,
    };
  }
}

export function deleteSaveState(saveKey) {
  const storage = getStorage();

  if (!storage) {
    return {
      ok: false,
      error: "Local storage is not available in this runtime.",
    };
  }

  const key = ensureSaveKey(saveKey);

  try {
    storage.removeItem(key);
    return {
      ok: true,
      key,
    };
  } catch (error) {
    return {
      ok: false,
      key,
      error: error instanceof Error ? error.message : "Failed to delete save state.",
    };
  }
}

export function listSaveSlots() {
  const storage = getStorage();
  const slots = [];

  for (const keyName of SLOT_ORDER) {
    const storageKey = SAVE_KEYS[keyName];
    if (!storage) {
      slots.push({
        id: keyName,
        storageKey,
        exists: false,
        updatedAtIso: null,
      });
      continue;
    }

    const payload = loadGameState(storageKey);
    const state = payload.ok ? payload.state : null;

    slots.push({
      id: keyName,
      storageKey,
      exists: Boolean(state),
      week: state?.run?.week ?? null,
      status: state?.run?.status ?? null,
      updatedAtIso: state?.meta?.updatedAtIso ?? null,
    });
  }

  return slots;
}

