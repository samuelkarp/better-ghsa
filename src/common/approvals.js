'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./storage.js');
  require('./allowlist.js');
}

/**
 * @typedef {object} ApprovalsStorage
 * @property {(keys: string | string[] | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 */

(() => {
  /**
   * Maps a lowercase `owner/repo` to the number of approvals a private-fork
   * pull request needs for readiness (REQUIREMENTS.md section 12).
   */
  const STORAGE_KEY = 'approvals';

  /** A repository without an entry needs this many approvals. */
  const DEFAULT = 2;

  /** @type {Readonly<Record<string, number>>} */
  let held = {};

  let loaded = false;

  /**
   * Concurrent callers share the pending storage read.
   *
   * @type {Promise<Readonly<Record<string, number>>> | null}
   */
  let reading = null;

  /** @type {ApprovalsStorage | null} */
  let injected = null;

  /** @type {Set<(held: Readonly<Record<string, number>>) => void>} */
  const listeners = new Set();

  let watching = false;

  /** @returns {ApprovalsStorage | null} The active storage provider. */
  function storageOf() {
    return injected ?? /** @type {ApprovalsStorage | null} */ (globalThis.bghsa.storage.local());
  }

  /**
   * @param {ApprovalsStorage | null} storage The storage provider, or null for browser storage.
   * @returns {void} Forgets the settings read from the previous provider.
   */
  function setStorage(storage) {
    injected = storage;
    held = {};
    loaded = false;
    reading = null;
  }

  /**
   * @param {unknown} value
   * @returns {boolean} Whether the value is a whole number, 0 or more.
   */
  function isValid(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }

  /**
   * @param {unknown} value The stored map.
   * @returns {Readonly<Record<string, number>>} The entries naming a
   *   repository with a valid count, keyed in lowercase.
   */
  function sanitize(value) {
    /** @type {Record<string, number>} */
    const kept = {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return kept;
    const allowlist = globalThis.bghsa.allowlist;
    for (const [name, count] of Object.entries(value)) {
      if (!allowlist.isValid(name) || !isValid(count)) continue;
      kept[allowlist.normalize(name)] = count;
    }
    return kept;
  }

  /**
   * @param {Readonly<Record<string, number>>} next
   * @returns {void} Notifies listeners when a setting changes.
   */
  function adopt(next) {
    const before = held;
    held = next;
    loaded = true;
    const names = new Set([...Object.keys(before), ...Object.keys(next)]);
    if ([...names].every((name) => before[name] === next[name])) return;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // Notify the remaining listeners even if one throws.
      }
    }
  }

  /**
   * Read the settings once. A storage failure reads as empty settings.
   *
   * @returns {Promise<Readonly<Record<string, number>>>}
   */
  function load() {
    if (loaded) return Promise.resolve(held);
    if (reading !== null) return reading;
    const storage = storageOf();
    reading = (async () => {
      if (storage === null) return {};
      try {
        return sanitize((await storage.get(STORAGE_KEY))?.[STORAGE_KEY]);
      } catch {
        return {};
      }
    })().then((next) => {
      reading = null;
      adopt(next);
      return next;
    });
    return reading;
  }

  /**
   * Read the settings again, for a page that changed storage around this
   * module.
   *
   * @returns {Promise<Readonly<Record<string, number>>>}
   */
  function reload() {
    loaded = false;
    reading = null;
    return load();
  }

  /**
   * @param {string} nameWithOwner `owner/repo`
   * @returns {number} The approvals the repository's pull requests need.
   */
  function requiredFor(nameWithOwner) {
    const count = held[globalThis.bghsa.allowlist.normalize(nameWithOwner)];
    return count === undefined ? DEFAULT : count;
  }

  /**
   * @param {string} nameWithOwner `owner/repo`
   * @param {unknown} count
   * @returns {Promise<boolean>} Whether the count was valid and stored.
   */
  async function save(nameWithOwner, count) {
    const allowlist = globalThis.bghsa.allowlist;
    if (!allowlist.isValid(nameWithOwner) || !isValid(count)) return false;
    const storage = storageOf();
    /** @type {Record<string, number>} */
    let next = { ...held };
    if (storage !== null) {
      next = { ...sanitize((await storage.get(STORAGE_KEY))?.[STORAGE_KEY]) };
      next[allowlist.normalize(nameWithOwner)] = /** @type {number} */ (count);
      await storage.set({ [STORAGE_KEY]: next });
    } else {
      next[allowlist.normalize(nameWithOwner)] = /** @type {number} */ (count);
    }
    adopt(next);
    return true;
  }

  /**
   * @param {(held: Readonly<Record<string, number>>) => void} listener
   * @returns {() => void} Unsubscribes the listener.
   */
  function subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Apply changes from the settings page to open pages without reloading.
   *
   * @returns {boolean} Whether this call subscribed.
   */
  function watch() {
    if (watching) return false;
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
    isValid,
    load,
    reload,
    requiredFor,
    save,
    subscribe,
    watch,
    setStorage,
  };

  globalThis.bghsa.approvals = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
