'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') require('./storage.js');

/**
 * The allowlist loads before the cache and declares its storage interface here.
 *
 * @typedef {object} AllowlistStorage
 * @property {(keys: string | string[] | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 */

(() => {
  /**
   * A fresh install has an empty allowlist. The extension runs only on listed
   * repositories (REQUIREMENTS.md section 12).
   */
  const STORAGE_KEY = 'allowlist';

  /**
   * Entries use `owner/repo`. Owners allow alphanumerics and interior hyphens.
   * Repository names also allow dots and underscores.
   */
  const OWNER = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d]))*$/;
  const REPO = /^[a-z\d._-]+$/;

  const MAX_OWNER = 39;
  const MAX_REPO = 100;

  /**
   * {@link isAllowed} returns false until storage supplies the allowlist.
   *
   * @type {readonly string[] | null}
   */
  let entries = null;

  /**
   * Concurrent callers share the pending storage read.
   *
   * @type {Promise<readonly string[]> | null}
   */
  let reading = null;

  /** @type {AllowlistStorage | null} */
  let injected = null;

  /**
   * Subscribers include `src/content.js`, which stops the extension when the
   * current repository is removed from the allowlist.
   *
   * @type {Set<(entries: readonly string[]) => void>}
   */
  const listeners = new Set();

  let watching = false;

  /**
   * @returns {AllowlistStorage | null} `storage.local`, or null if unavailable.
   */
  function browserStorage() {
    return /** @type {AllowlistStorage | null} */ (globalThis.bghsa.storage.local());
  }

  /** @returns {AllowlistStorage | null} The active storage provider. */
  function storageOf() {
    return injected ?? browserStorage();
  }

  /**
   * @param {AllowlistStorage | null} storage The storage provider, or null for browser storage.
   * @returns {void} Resets the cached allowlist.
   */
  function setStorage(storage) {
    injected = storage;
    entries = null;
    reading = null;
  }

  /**
   * @param {unknown} value
   * @returns {string} The trimmed, lowercase entry.
   */
  function normalize(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  /**
   * Validate the repository name syntax without checking whether it exists.
   *
   * @param {unknown} value
   * @returns {boolean}
   */
  function isValid(value) {
    const entry = normalize(value);
    const parts = entry.split('/');
    if (parts.length !== 2) return false;
    const [owner, repo] = parts;
    if (owner === undefined || repo === undefined) return false;
    if (owner.length === 0 || owner.length > MAX_OWNER) return false;
    if (repo.length === 0 || repo.length > MAX_REPO) return false;
    if (repo === '.' || repo === '..') return false;
    return OWNER.test(owner) && REPO.test(repo);
  }

  /**
   * @param {unknown} value The stored allowlist.
   * @returns {readonly string[]} The normalized, valid, deduplicated entries.
   */
  function sanitize(value) {
    if (!Array.isArray(value)) return [];
    /** @type {string[]} */
    const kept = [];
    for (const item of value) {
      if (!isValid(item)) continue;
      const entry = normalize(item);
      if (!kept.includes(entry)) kept.push(entry);
    }
    return kept;
  }

  /** @returns {readonly string[]} The allowlist, or an empty list before loading. */
  function current() {
    return entries ?? [];
  }

  /** @returns {boolean} Whether the allowlist has loaded. */
  function loaded() {
    return entries !== null;
  }

  /**
   * @param {readonly string[]} next
   * @returns {void} Notifies listeners when the allowlist changes.
   */
  function adopt(next) {
    const before = entries;
    entries = next;
    if (before !== null && before.length === next.length && before.every((e, i) => e === next[i])) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // Notify the remaining listeners even if one throws.
      }
    }
  }

  /**
   * Load the allowlist once. A storage failure produces an empty allowlist.
   *
   * @returns {Promise<readonly string[]>}
   */
  function load() {
    if (entries !== null) return Promise.resolve(entries);
    if (reading !== null) return reading;
    const storage = storageOf();
    reading = (async () => {
      if (storage === null) return [];
      try {
        const held = await storage.get(STORAGE_KEY);
        return sanitize(held?.[STORAGE_KEY]);
      } catch {
        return [];
      }
    })().then((next) => {
      reading = null;
      adopt(next);
      return next;
    });
    return reading;
  }

  /**
   * Return whether the repository is allowed, using a case-insensitive match.
   * The extension stays disabled until the allowlist loads (REQUIREMENTS.md
   * section 12).
   *
   * @param {string} nameWithOwner `owner/repo`
   * @returns {boolean}
   */
  function isAllowed(nameWithOwner) {
    if (entries === null) return false;
    const wanted = normalize(nameWithOwner);
    if (wanted === '') return false;
    return entries.includes(wanted);
  }

  /**
   * @param {readonly unknown[]} next The entries to validate, normalize, and deduplicate.
   * @returns {Promise<readonly string[]>} The stored entries.
   */
  async function save(next) {
    const kept = sanitize(next);
    const storage = storageOf();
    if (storage !== null) await storage.set({ [STORAGE_KEY]: [...kept] });
    adopt(kept);
    return kept;
  }

  /**
   * @param {unknown} value A repository as a maintainer typed it.
   * @returns {Promise<{ ok: boolean, entry: string, reason: string | null }>}
   *   The entry and, on failure, the reason it was rejected.
   */
  async function add(value) {
    const entry = normalize(value);
    if (entry === '') return { ok: false, entry, reason: 'empty' };
    if (!isValid(entry)) return { ok: false, entry, reason: 'malformed' };
    const held = await load();
    if (held.includes(entry)) return { ok: false, entry, reason: 'duplicate' };
    await save([...held, entry]);
    return { ok: true, entry, reason: null };
  }

  /**
   * @param {unknown} value
   * @returns {Promise<readonly string[]>} the list without that repository.
   */
  async function remove(value) {
    const entry = normalize(value);
    const held = await load();
    return save(held.filter((held_) => held_ !== entry));
  }

  /**
   * @param {(entries: readonly string[]) => void} listener
   * @returns {() => void} Unsubscribes the listener.
   */
  function subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Apply changes from other extension pages without reloading this page.
   *
   * @returns {boolean} Whether this call subscribed.
   */
  function watch() {
    if (watching) return false;
    // Subscribe through the same API used for storage reads.
    const onChanged = globalThis.bghsa.storage.api()?.storage?.onChanged;
    if (typeof onChanged?.addListener !== 'function') return false;
    watching = true;
    onChanged.addListener(
      /**
       * @param {Record<string, { newValue?: unknown }>} changes
       * @param {string} [area]
       * @returns {void}
       */
      (changes, area) => {
        if (area !== undefined && area !== 'local') return;
        if (changes === null || typeof changes !== 'object') return;
        if (!Object.hasOwn(changes, STORAGE_KEY)) return;
        adopt(sanitize(changes[STORAGE_KEY]?.newValue));
      }
    );
    return true;
  }

  const exported = {
    STORAGE_KEY,
    normalize,
    isValid,
    current,
    loaded,
    load,
    isAllowed,
    save,
    add,
    remove,
    subscribe,
    watch,
    setStorage,
    storageOf,
  };

  globalThis.bghsa.allowlist = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
