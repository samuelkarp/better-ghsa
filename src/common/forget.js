'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The page's own script tags order these; under Node the dependencies are named
// here.
if (typeof require === 'function') {
  require('./schema.js');
  require('./allowlist.js');
  require('./members.js');
  require('./branches.js');
  require('./cache.js');
}

/**
 * `get(null)` returns all stored entries for selective removal.
 *
 * @typedef {object} ForgetStorage
 * @property {(keys: string | string[] | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 */

/**
 * @typedef {object} ForgetOptions
 * @property {ForgetStorage | null} [storage] The storage provider. Defaults to the cache's provider.
 */

/**
 * @typedef {object} ForgetOutcome
 * @property {number} taken How many whole storage keys were removed.
 * @property {boolean} branches Whether the branches entry changed.
 * @property {boolean} members Whether the members entry changed.
 */

(() => {
  /**
   * @returns {ForgetStorage | null} The cache's storage provider.
   */
  function storageOf() {
    return /** @type {ForgetStorage | null} */ (
      /** @type {unknown} */ (globalThis.bghsa.cache.storageOf())
    );
  }

  /**
   * @param {unknown} value A repository as `owner/repo`.
   * @returns {string} The lowercase owner, or an empty string if invalid.
   */
  function ownerOf(value) {
    const entry = globalThis.bghsa.allowlist.normalize(value);
    const cut = entry.indexOf('/');
    return cut <= 0 ? '' : entry.slice(0, cut);
  }

  /**
   * The trailing colon in `adv:{owner}/{repo}:` delimits the repository name
   * and prevents matching another repository with the same prefix.
   *
   * @param {unknown} repository The repository, as `owner/repo`.
   * @param {readonly string[]} keys Every key storage holds.
   * @returns {string[]} The repository's cache keys, or an empty list if invalid.
   */
  function keysFor(repository, keys) {
    const entry = globalThis.bghsa.allowlist.normalize(repository);
    if (ownerOf(entry) === '') return [];
    const cache = globalThis.bghsa.cache;
    const advisories = `${cache.ADVISORY_PREFIX}${entry}:`;
    const list = `${cache.LIST_PREFIX}${entry}`;
    const progress = `${cache.PROGRESS_PREFIX}${entry}`;
    return keys.filter((key) => key === list || key === progress || key.startsWith(advisories));
  }

  /**
   * A failed storage read leaves existing entries untouched.
   *
   * @param {ForgetStorage} storage
   * @returns {Promise<Record<string, unknown>>}
   */
  async function held(storage) {
    try {
      return await storage.get(null);
    } catch {
      return {};
    }
  }

  /**
   * Storage removal failures return zero.
   *
   * @param {ForgetStorage} storage
   * @param {readonly string[]} keys
   * @returns {Promise<number>} The number of removed keys, or zero on failure.
   */
  async function discard(storage, keys) {
    if (keys.length === 0) return 0;
    try {
      await storage.remove([...keys]);
    } catch {
      return 0;
    }
    return keys.length;
  }

  /**
   * Remove a repository or organization from a stored map. Remove the storage
   * entry when the map becomes empty. Leave malformed entries untouched.
   *
   * @param {ForgetStorage} storage
   * @param {string} key The entry's key.
   * @param {string} member The repository or organization to drop, lowercased.
   * @returns {Promise<boolean>} whether the entry changed.
   */
  async function prune(storage, key, member) {
    if (member === '') return false;
    /** @type {unknown} */
    let value;
    try {
      value = (await storage.get(key))[key];
    } catch {
      return false;
    }
    if (!globalThis.bghsa.schema.isPlainObject(value)) return false;
    /** @type {Record<string, unknown>} */
    const kept = {};
    let dropped = false;
    for (const [name, entry] of Object.entries(value)) {
      if (name.trim().toLowerCase() === member) dropped = true;
      else kept[name] = entry;
    }
    if (!dropped) return false;
    try {
      if (Object.keys(kept).length === 0) await storage.remove(key);
      else await storage.set({ [key]: kept });
    } catch {
      return false;
    }
    return true;
  }

  /**
   * @param {unknown} repository The repository being taken off the list.
   * @param {readonly unknown[]} remaining The remaining allowed repositories.
   * @returns {boolean} Whether the allowlist still needs this organization's
   *   cached members (REQUIREMENTS.md section 2).
   */
  function organizationListed(repository, remaining) {
    const owner = ownerOf(repository);
    if (owner === '') return false;
    return remaining.some((entry) => ownerOf(entry) === owner);
  }

  /**
   * Clear observed data while preserving the allowlist (REQUIREMENTS.md section 2).
   *
   * @param {ForgetOptions} [options]
   * @returns {Promise<ForgetOutcome>}
   */
  async function everything(options = {}) {
    globalThis.bghsa.members.clear();
    globalThis.bghsa.branches.clear();
    const storage = options.storage ?? storageOf();
    if (storage === null) return { taken: 0, branches: false, members: false };
    const cache = globalThis.bghsa.cache;
    const keys = Object.keys(await held(storage));
    const members = keys.includes(globalThis.bghsa.members.MEMBERS_KEY);
    const branches = keys.includes(globalThis.bghsa.branches.BRANCHES_KEY);
    const wanted = keys.filter(
      (key) =>
        cache.isCacheKey(key) ||
        key === globalThis.bghsa.members.MEMBERS_KEY ||
        key === globalThis.bghsa.branches.BRANCHES_KEY
    );
    const taken = await discard(storage, wanted);
    return { taken, branches: branches && taken > 0, members: members && taken > 0 };
  }

  /**
   * Clear a repository's cache and observed release branches. Remove its
   * organization's members only when the allowlist contains no other repository
   * from that organization (REQUIREMENTS.md section 2).
   *
   * @param {unknown} entry The repository, as `owner/repo`.
   * @param {readonly unknown[]} [remaining] The repositories still on the list.
   * @param {ForgetOptions} [options]
   * @returns {Promise<ForgetOutcome>}
   */
  async function repository(entry, remaining = [], options = {}) {
    const wanted = globalThis.bghsa.allowlist.normalize(entry);
    const storage = options.storage ?? storageOf();
    if (storage === null || ownerOf(wanted) === '') {
      return { taken: 0, branches: false, members: false };
    }
    const taken = await discard(storage, keysFor(wanted, Object.keys(await held(storage))));
    const branches = await prune(storage, globalThis.bghsa.branches.BRANCHES_KEY, wanted);
    const members = organizationListed(wanted, remaining)
      ? false
      : await prune(storage, globalThis.bghsa.members.MEMBERS_KEY, ownerOf(wanted));
    return { taken, branches, members };
  }

  const exported = {
    storageOf,
    keysFor,
    everything,
    repository,
  };

  globalThis.bghsa.forget = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
