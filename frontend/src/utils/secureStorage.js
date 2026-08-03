// Encrypts values at rest in localStorage using a non-extractable AES-GCM key
// held in IndexedDB. Only ciphertext ever touches localStorage/disk; the key
// material itself is never exportable to JS, so copying localStorage or the
// profile directory elsewhere yields unreadable data.
//
// Limitation: any script that already runs in this origin (e.g. an XSS
// payload) can still ask the browser to decrypt, the same way the app does.
// This protects against casual/offline inspection (devtools localStorage
// tab, browser-profile copies, non-JS storage scrapers), not against code
// already executing on the page.

const DB_NAME = 'sysaid_secure';
const STORE_NAME = 'keys';
const KEY_ID = 'llm_config_key';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getOrCreateKey() {
  const db = await openDb();
  const existing = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(KEY_ID);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (existing) return existing;

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable: key material can never be read out by JS
    ['encrypt', 'decrypt']
  );
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(key, KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return key;
}

function toB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function fromB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

const cryptoAvailable = () =>
  typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle;

/** Encrypts `value` (any JSON-serializable data) and stores it under `storageKey`. */
export async function secureSet(storageKey, value) {
  if (!cryptoAvailable()) {
    localStorage.setItem(storageKey, JSON.stringify(value));
    return;
  }
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  localStorage.setItem(
    storageKey,
    JSON.stringify({ v: 1, iv: toB64(iv), data: toB64(ciphertext) })
  );
}

/**
 * Reads and decrypts a value previously written by secureSet. Transparently
 * migrates old plaintext entries (returns them as-is; caller should re-save
 * via secureSet to upgrade them to the encrypted format).
 */
export async function secureGet(storageKey, fallback = null) {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }

  if (!parsed || parsed.v !== 1 || !parsed.iv || !parsed.data) {
    // Legacy plaintext written before encryption was added.
    return parsed ?? fallback;
  }

  if (!cryptoAvailable()) return fallback;

  try {
    const key = await getOrCreateKey();
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(parsed.iv) },
      key,
      fromB64(parsed.data)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    // Key unavailable (e.g. IndexedDB cleared independently of localStorage).
    return fallback;
  }
}
