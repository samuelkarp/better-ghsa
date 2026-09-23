'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') {
  require('./storage.js');
  require('./schema.js');
}

/**
 * @typedef {object} MemberStorage
 * @property {(key: string) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 */

/**
 * @typedef {object} OrganizationRef
 * @property {string} owner
 */

(() => {
  /**
   * Observed membership persists by organization, independently of the
   * advisory cache.
   */
  const MEMBERS_KEY = 'members';

  /**
   * Organization and login keys are case-insensitive. Preserve the first
   * observed spelling of each login for display.
   *
   * @type {Map<string, Map<string, string>>}
   */
  const seen = new Map();

  /** @type {MemberStorage | null} */
  let injected = null;

  /**
   * @returns {MemberStorage | null} `storage.local`, or null if unavailable.
   */
  function browserStorage() {
    return /** @type {MemberStorage | null} */ (globalThis.bghsa.storage.local());
  }

  /**
   * @param {MemberStorage | null} storage The storage provider, or null for browser storage.
   * @returns {void}
   */
  function setStorage(storage) {
    injected = storage;
  }

  /** @returns {MemberStorage | null} The active storage provider. */
  function storageOf() {
    return injected ?? browserStorage();
  }

  /**
   * @param {OrganizationRef | null | undefined} ref
   * @returns {string | null} The lowercase organization key, or null if missing.
   */
  function keyOf(ref) {
    if (ref === null || ref === undefined) return null;
    const owner = String(ref.owner ?? '').trim().toLowerCase();
    return owner === '' ? null : owner;
  }

  /**
   * @param {string} key
   * @param {readonly unknown[]} logins
   * @returns {boolean} Whether any entries were added.
   */
  function take(key, logins) {
    let grew = false;
    for (const login of logins) {
      if (typeof login !== 'string') continue;
      const name = login.trim();
      if (name === '') continue;
      const fold = name.toLowerCase();
      let held = seen.get(key);
      if (held === undefined) {
        held = new Map();
        seen.set(key, held);
      }
      if (held.has(fold)) continue;
      held.set(fold, name);
      grew = true;
    }
    return grew;
  }

  /**
   * Record members synchronously for use during rendering.
   *
   * @param {OrganizationRef | null | undefined} ref The organization the logins
   *   carry a member badge on.
   * @param {readonly unknown[]} logins
   * @returns {boolean} Whether any entries were added.
   */
  function remember(ref, logins) {
    const key = keyOf(ref);
    return key === null ? false : take(key, logins);
  }

  /**
   * @param {OrganizationRef | null | undefined} ref
   * @returns {string[]} Observed members of the organization, in observation order.
   */
  function known(ref) {
    const key = keyOf(ref);
    const held = key === null ? undefined : seen.get(key);
    return held === undefined ? [] : [...held.values()];
  }

  /**
   * @param {OrganizationRef | null | undefined} ref
   * @param {string | null | undefined} login
   * @returns {boolean} whether this login has been seen carrying a member badge
   *   on this organization.
   */
  function isKnown(ref, login) {
    if (typeof login !== 'string') return false;
    const key = keyOf(ref);
    const held = key === null ? undefined : seen.get(key);
    return held === undefined ? false : held.has(login.trim().toLowerCase());
  }

  /** @returns {void} Clears in-memory observations. */
  function clear() {
    seen.clear();
  }

  /**
   * @param {unknown} value The stored entry.
   * @returns {Map<string, string[]>} Stored logins by organization. Discard
   *   malformed entries, including unscoped arrays of logins.
   */
  function organizationsOf(value) {
    /** @type {Map<string, string[]>} */
    const held = new Map();
    if (!globalThis.bghsa.schema.isPlainObject(value)) return held;
    for (const [key, logins] of Object.entries(value)) {
      if (!Array.isArray(logins)) continue;
      held.set(
        key,
        logins.filter((login) => typeof login === 'string' && login.trim() !== '')
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
    for (const [key, logins] of seen) held[key] = [...logins.values()];
    return held;
  }

  /**
   * @param {Map<string, string[]>} stored
   * @returns {boolean} Whether this session has observations missing from storage.
   */
  function ahead(stored) {
    for (const [key, logins] of seen) {
      const held = stored.get(key);
      if (held === undefined) return true;
      const stock = new Set(held.map((login) => login.trim().toLowerCase()));
      for (const fold of logins.keys()) if (!stock.has(fold)) return true;
    }
    return false;
  }

  /**
   * Merge stored members with this session's observations and persist additions.
   * Storage failures leave the session's observations available.
   *
   * @param {MemberStorage | null} [storage]
   * @returns {Promise<boolean>} Whether storage added a login to this session.
   */
  async function sync(storage = storageOf()) {
    if (storage === null) return false;
    /** @type {Map<string, string[]>} */
    let stored;
    try {
      stored = organizationsOf((await storage.get(MEMBERS_KEY))[MEMBERS_KEY]);
    } catch {
      return false;
    }
    let grew = false;
    for (const [key, logins] of stored) grew = take(key, logins) || grew;
    if (!ahead(stored)) return grew;
    try {
      await storage.set({ [MEMBERS_KEY]: entry() });
    } catch {
      return grew;
    }
    return grew;
  }

  const exported = {
    MEMBERS_KEY,
    setStorage,
    storageOf,
    keyOf,
    known,
    isKnown,
    remember,
    clear,
    sync,
  };

  globalThis.bghsa.members = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
