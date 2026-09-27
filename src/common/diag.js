'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') require('./storage.js');

/**
 * @typedef {object} DiagStorage
 * @property {(keys: string | string[] | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 */

(() => {
  /**
   * The setting that turns the diagnostic lines on. A fresh install has it
   * off.
   */
  const STORAGE_KEY = 'diagnostics';

  const PREFIX = '[better-ghsa] diag';

  /**
   * Whether the stored setting is on. Off until storage answers.
   */
  let on = false;

  /** @type {DiagStorage | null} */
  let injected = null;

  /** @type {Set<(on: boolean) => void>} */
  const listeners = new Set();

  let watching = false;

  /** @returns {DiagStorage | null} The active storage provider. */
  function storageOf() {
    return (
      injected ?? /** @type {DiagStorage | null} */ (globalThis.bghsa.storage.local())
    );
  }

  /**
   * @param {DiagStorage | null} storage The storage provider, or null for browser storage.
   * @returns {void} Turns the lines off until the setting is read from it.
   */
  function setStorage(storage) {
    injected = storage;
    on = false;
  }

  /**
   * Under Node, BGHSA_DIAG in the environment turns the lines on for a test run.
   *
   * @returns {boolean} Whether the lines print.
   */
  function enabled() {
    if (on) return true;
    return typeof process !== 'undefined' && Boolean(process.env?.['BGHSA_DIAG']);
  }

  /**
   * @param {boolean} next
   * @returns {void} Notifies listeners when the setting changes.
   */
  function adopt(next) {
    if (on === next) return;
    on = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // Notify the remaining listeners even if one throws.
      }
    }
  }

  /**
   * Read the setting. A storage failure reads as off.
   *
   * @returns {Promise<boolean>}
   */
  async function load() {
    const storage = storageOf();
    let next = false;
    if (storage !== null) {
      try {
        next = (await storage.get(STORAGE_KEY))?.[STORAGE_KEY] === true;
      } catch {
        next = false;
      }
    }
    adopt(next);
    return next;
  }

  /**
   * @param {boolean} next
   * @returns {Promise<boolean>} The stored setting.
   */
  async function save(next) {
    const value = next === true;
    const storage = storageOf();
    if (storage !== null) await storage.set({ [STORAGE_KEY]: value });
    adopt(value);
    return value;
  }

  /**
   * @param {(on: boolean) => void} listener
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
        adopt(changes[STORAGE_KEY]?.newValue === true);
      }
    );
    return true;
  }

  /**
   * Print one diagnostic line while the setting is on. A function is called
   * for its text only then.
   *
   * @param {string | (() => string)} text
   * @returns {void}
   */
  function log(text) {
    if (!enabled()) return;
    console.info(`${PREFIX} ${typeof text === 'function' ? text() : text}`);
  }

  /**
   * Print an error the caller goes on past, while the setting is on.
   *
   * @param {string} where
   * @param {unknown} error
   * @returns {void}
   */
  function caught(where, error) {
    if (!enabled()) return;
    const stack = error instanceof Error ? error.stack : undefined;
    console.info(`${PREFIX} caught`, where, String(error), stack);
  }

  /**
   * Print the promise's rejection while the setting is on. The returned
   * promise settles as the given one does, and with the setting off it is
   * the given one. The caller puts the returned promise wherever the given
   * one would have gone. The code that would have handled a rejection of the
   * given promise then handles it, at the same point.
   *
   * @template T
   * @param {string} where
   * @param {Promise<T>} promise
   * @returns {Promise<T>}
   */
  function rejection(where, promise) {
    if (!enabled()) return promise;
    return promise.then(undefined, (error) => {
      caught(where, error);
      throw error;
    });
  }

  const exported = {
    STORAGE_KEY,
    PREFIX,
    enabled,
    load,
    save,
    subscribe,
    watch,
    setStorage,
    log,
    caught,
    rejection,
  };

  globalThis.bghsa.diag = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
