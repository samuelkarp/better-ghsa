'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') {
  require('./storage.js');
  require('./schema.js');
}

/**
 * @typedef {object} BranchStorage
 * @property {(key: string) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 */

/**
 * @typedef {object} RepositoryRef
 * @property {string} owner
 * @property {string} repo
 */

(() => {
  /**
   * Release branches are shared by a repository's advisories and persist
   * independently of the advisory cache.
   */
  const BRANCHES_KEY = 'branches';

  const RELEASE_PREFIX = 'release/';

  /**
   * Version components are dot-separated digits with an optional leading `v`.
   */
  const VERSION_PATTERN = /^v?(\d+(?:\.\d+)*)$/;

  /**
   * Repository keys are case-insensitive. Branch names are case-sensitive.
   *
   * @type {Map<string, Set<string>>}
   */
  const seen = new Map();

  /** @type {BranchStorage | null} */
  let injected = null;

  /**
   * @returns {BranchStorage | null} `storage.local`, or null if unavailable.
   */
  function browserStorage() {
    return /** @type {BranchStorage | null} */ (globalThis.bghsa.storage.local());
  }

  /**
   * @param {BranchStorage | null} storage The storage provider, or null for browser storage.
   * @returns {void}
   */
  function setStorage(storage) {
    injected = storage;
  }

  /** @returns {BranchStorage | null} The active storage provider. */
  function storageOf() {
    return injected ?? browserStorage();
  }

  /**
   * @param {RepositoryRef | null | undefined} ref
   * @returns {string | null} The lowercase repository key, or null if incomplete.
   */
  function keyOf(ref) {
    if (ref === null || ref === undefined) return null;
    const owner = String(ref.owner ?? '').trim().toLowerCase();
    const repo = String(ref.repo ?? '').trim().toLowerCase();
    return owner === '' || repo === '' ? null : `${owner}/${repo}`;
  }

  /**
   * @param {unknown} name
   * @returns {boolean} whether this is the name of a release branch.
   */
  function isRelease(name) {
    return (
      typeof name === 'string' &&
      name.startsWith(RELEASE_PREFIX) &&
      name.length > RELEASE_PREFIX.length
    );
  }

  /**
   * @param {string} branch
   * @returns {number[] | null} The numeric version components, or null if invalid.
   *   Optional `release/` and `v` prefixes are removed.
   */
  function versionOf(branch) {
    const tail = branch.startsWith(RELEASE_PREFIX) ? branch.slice(RELEASE_PREFIX.length) : branch;
    const match = VERSION_PATTERN.exec(tail);
    if (match === null) return null;
    return /** @type {string} */ (match[1]).split('.').map(Number);
  }

  /**
   * Sort versions in descending order. Missing components sort below present
   * components: `release/2.10.1` precedes `release/2.10`. Non-version names
   * follow version names and sort lexicographically.
   *
   * @param {string} left
   * @param {string} right
   * @returns {number} Negative when `left` sorts first.
   */
  function compare(left, right) {
    const first = versionOf(left);
    const second = versionOf(right);
    if (first === null || second === null) {
      if (first !== null) return -1;
      if (second !== null) return 1;
    } else {
      for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
        const one = first[index] ?? -1;
        const two = second[index] ?? -1;
        if (one !== two) return two - one;
      }
    }
    return left < right ? -1 : left > right ? 1 : 0;
  }

  /**
   * @param {readonly string[]} names
   * @returns {string[]} The sorted branch names.
   */
  function order(names) {
    return [...names].sort(compare);
  }

  /**
   * @param {string} key
   * @param {readonly unknown[]} names
   * @returns {boolean} Whether any entries were added.
   */
  function take(key, names) {
    let grew = false;
    for (const name of names) {
      if (typeof name !== 'string') continue;
      const branch = name.trim();
      if (!isRelease(branch)) continue;
      let held = seen.get(key);
      if (held === undefined) {
        held = new Set();
        seen.set(key, held);
      }
      if (held.has(branch)) continue;
      held.add(branch);
      grew = true;
    }
    return grew;
  }

  /**
   * Record release branches synchronously for use during rendering. The panel
   * offers only release branches as backport targets (REQUIREMENTS.md section 6).
   *
   * @param {RepositoryRef | null | undefined} ref The repository the names
   *   belong to.
   * @param {readonly unknown[]} names
   * @returns {boolean} Whether any entries were added.
   */
  function remember(ref, names) {
    const key = keyOf(ref);
    return key === null ? false : take(key, names);
  }

  /**
   * @param {RepositoryRef | null | undefined} ref
   * @returns {string[]} The repository's observed release branches, sorted.
   */
  function known(ref) {
    const key = keyOf(ref);
    const held = key === null ? undefined : seen.get(key);
    return held === undefined ? [] : order([...held]);
  }

  /** @returns {void} Clears in-memory observations. */
  function clear() {
    seen.clear();
  }

  /**
   * @param {unknown} value The stored entry.
   * @returns {Map<string, string[]>} Stored branches by repository, excluding
   *   malformed entries.
   */
  function repositoriesOf(value) {
    /** @type {Map<string, string[]>} */
    const held = new Map();
    if (!globalThis.bghsa.schema.isPlainObject(value)) return held;
    for (const [key, names] of Object.entries(value)) {
      if (!Array.isArray(names)) continue;
      held.set(
        key,
        names.filter((name) => typeof name === 'string' && name.trim() !== '')
      );
    }
    return held;
  }

  /**
   * @returns {Record<string, string[]>} The observations serialized for storage.
   */
  function entry() {
    /** @type {Record<string, string[]>} */
    const held = {};
    for (const [key, names] of seen) held[key] = [...names];
    return held;
  }

  /**
   * @param {Map<string, string[]>} stored
   * @returns {boolean} Whether this session has observations missing from storage.
   */
  function ahead(stored) {
    for (const [key, names] of seen) {
      const held = stored.get(key);
      if (held === undefined) return true;
      const stock = new Set(held);
      for (const name of names) if (!stock.has(name)) return true;
    }
    return false;
  }

  /**
   * Merge stored branches with this session's observations and persist additions.
   * Storage failures leave the session's observations available.
   *
   * @param {BranchStorage | null} [storage]
   * @returns {Promise<boolean>} Whether storage added a branch to this session.
   */
  async function sync(storage = storageOf()) {
    if (storage === null) return false;
    /** @type {Map<string, string[]>} */
    let stored;
    try {
      stored = repositoriesOf((await storage.get(BRANCHES_KEY))[BRANCHES_KEY]);
    } catch {
      return false;
    }
    let grew = false;
    for (const [key, names] of stored) grew = take(key, names) || grew;
    if (!ahead(stored)) return grew;
    try {
      await storage.set({ [BRANCHES_KEY]: entry() });
    } catch {
      return grew;
    }
    return grew;
  }

  const exported = {
    BRANCHES_KEY,
    setStorage,
    storageOf,
    keyOf,
    isRelease,
    versionOf,
    compare,
    order,
    remember,
    known,
    clear,
    sync,
  };

  globalThis.bghsa.branches = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
