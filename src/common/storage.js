'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

(() => {
  /**
   * Prefer Firefox's `browser` API when both names are available.
   */
  const NAMES = ['browser', 'chrome'];

  /**
   * Callers require get and set. Cache eviction also requires remove.
   */
  const REQUIRED = ['get', 'set'];

  /**
   * Select the first API with all required storage methods.
   *
   * @param {readonly string[]} [required] Required storage methods.
   * @returns {Record<string, any> | undefined} The API, or undefined if unavailable.
   */
  function api(required = REQUIRED) {
    const global = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));
    for (const name of NAMES) {
      const found = global[name];
      const local = found?.storage?.local;
      if (local === undefined || local === null) continue;
      if (required.every((method) => typeof local[method] === 'function')) return found;
    }
    return undefined;
  }

  /**
   * Callers cast the store to the storage interface they use.
   *
   * @param {readonly string[]} [required] Required storage methods.
   * @returns {Record<string, any> | null} The store, or null if unavailable.
   */
  function local(required = REQUIRED) {
    return api(required)?.storage?.local ?? null;
  }

  const exported = {
    api,
    local,
  };

  globalThis.bghsa.storage = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
