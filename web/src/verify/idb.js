/**
 * A minimal IndexedDB key-value store for verification state (replay snapshots and results).
 * Works in pages and in workers. Every call fails soft: private windows and blocked storage
 * reject, and callers treat that as "nothing saved".
 *
 * API
 *   kvGet(key) -> Promise<value | undefined>
 *   kvSet(key, value) -> Promise<void>
 *   kvDel(key) -> Promise<void>
 */
import { STORAGE_PREFIX } from "../config.js";

const DB = `${STORAGE_PREFIX}.verify`;
const STORE = "kv";
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is not available"));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  }).catch((e) => {
    dbp = null;
    throw e;
  });
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error ?? new Error("IndexedDB transaction failed"));
    t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export const kvGet = (key) => tx("readonly", (s) => s.get(key));
export const kvSet = (key, value) => tx("readwrite", (s) => s.put(value, key)).then(() => undefined);
export const kvDel = (key) => tx("readwrite", (s) => s.delete(key)).then(() => undefined);
