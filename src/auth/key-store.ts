import fs from "fs";
import path from "path";
import crypto from "crypto";
import { logger } from "../logger.js";

export type Scope = "exec" | "admin" | "metrics";

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scopes: Scope[];
  rateLimit: number;
  createdAt: number;
  lastUsedAt: number;
  expiresAt?: number | undefined;
  enabled: boolean;
}

export interface ResolvedKey {
  id: string;
  name: string;
  scopes: Scope[];
  rateLimit: number;
}

export function getKeysPath(): string {
  return process.env.AUTH_KEYS_PATH ?? "/var/lib/agent-sandbox/keys.json";
}

let keys: ApiKeyRecord[] = [];
let loaded = false;
// Tracks whether this process has made changes that are not yet on disk. Without
// it, a process holding a stale snapshot (e.g. one that loaded an empty store,
// then had keys added by the CLI) would overwrite the file on shutdown.
let dirty = false;

export function loadKeys(): ApiKeyRecord[] {
  const keysPath = getKeysPath();
  try {
    if (fs.existsSync(keysPath)) {
      keys = JSON.parse(fs.readFileSync(keysPath, "utf-8"));
      loaded = true;
      return keys;
    }
  } catch (err) {
    logger.warn({ err, path: keysPath }, "failed to load API keys");
  }
  keys = [];
  loaded = true;
  return keys;
}

export function saveKeys(): boolean {
  const keysPath = getKeysPath();
  try {
    const dir = path.dirname(keysPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = keysPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(keys, null, 2));
    fs.renameSync(tmp, keysPath);
    dirty = false;
    return true;
  } catch (err) {
    logger.warn({ err, path: keysPath }, "failed to save API keys");
    return false;
  }
}

export function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export function createKey(
  name: string,
  scopes: Scope[] = ["exec"],
  rateLimit: number = 0,
  expiresAt?: number,
): { record: ApiKeyRecord; rawKey: string } {
  if (!loaded) loadKeys();

  const id = crypto.randomBytes(4).toString("hex");
  const randomPart = crypto.randomBytes(16).toString("hex");
  const prefix = process.env.AUTH_KEY_PREFIX ?? "sk_test_";
  const rawKey = `${prefix}${randomPart}`;
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.substring(0, 12);

  const record: ApiKeyRecord = {
    id,
    name,
    keyHash,
    keyPrefix,
    scopes,
    rateLimit,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    enabled: true,
  };

  keys.push(record);
  dirty = true;
  saveKeys();

  return { record, rawKey };
}

export function verifyKey(rawKey: string): ResolvedKey | null {
  if (!loaded) loadKeys();
  if (!rawKey) return null;

  const keyHash = hashKey(rawKey);
  const record = keys.find((k) => k.keyHash === keyHash);

  if (!record || !record.enabled) return null;
  if (record.expiresAt && Date.now() > record.expiresAt) return null;

  return {
    id: record.id,
    name: record.name,
    scopes: [...record.scopes],
    rateLimit: record.rateLimit,
  };
}

let saveTimer: NodeJS.Timeout | undefined;

export function flushKeys(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  // Nothing changed here, so the on-disk copy is at least as fresh as ours.
  // Writing anyway would clobber keys another process added since we loaded.
  if (!dirty) return;
  saveKeys();
}

export function touchKey(id: string): void {
  if (!loaded) loadKeys();
  const record = keys.find((k) => k.id === id);
  if (record) {
    record.lastUsedAt = Date.now();
    dirty = true;
    if (!saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = undefined;
        saveKeys();
      }, 5000);
      saveTimer.unref?.();
    }
  }
}

export function revokeKey(id: string): boolean {
  if (!loaded) loadKeys();
  const record = keys.find((k) => k.id === id);
  if (!record) return false;
  record.enabled = false;
  dirty = true;
  saveKeys();
  return true;
}

export function deleteKey(id: string): boolean {
  if (!loaded) loadKeys();
  const initialLength = keys.length;
  keys = keys.filter((k) => k.id !== id);
  if (keys.length !== initialLength) {
    dirty = true;
    saveKeys();
    return true;
  }
  return false;
}

export function listKeys(): Omit<ApiKeyRecord, "keyHash">[] {
  if (!loaded) loadKeys();
  return keys.map(({ keyHash, ...rest }) => rest);
}

export function rotateKey(id: string): { record: ApiKeyRecord; rawKey: string } | null {
  if (!loaded) loadKeys();
  const old = keys.find((k) => k.id === id);
  if (!old) return null;

  old.enabled = false;
  dirty = true;
  const newKey = createKey(old.name, old.scopes, old.rateLimit, old.expiresAt);
  saveKeys();
  return newKey;
}

export function clearKeysStore(): void {
  keys = [];
  loaded = false;
  dirty = false;
}
