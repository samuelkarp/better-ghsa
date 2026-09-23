'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') {
  require('./storage.js');
  require('./schema.js');
}

/**
 * `get(null)` returns all stored entries so clearing can select cache keys.
 *
 * @typedef {object} CacheStorage
 * @property {(keys: string | string[] | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 */

/**
 * Cache records may contain advisories, lists, or refresh progress. Readers
 * validate their shape because storage can contain data from other versions.
 *
 * @typedef {object} CacheEntry
 * @property {unknown} record
 * @property {number} observedAt Epoch milliseconds.
 * @property {string | null} state The lowercase advisory state for refresh
 *   scheduling, or null for unknown states and non-advisory entries.
 * @property {number} [jitterMs] Additional refresh delay in milliseconds,
 *   chosen when the entry is written. Defaults to zero.
 * @property {number} [misses] The consecutive 404 count. Defaults to zero.
 */

/**
 * @typedef {object} CacheOptions
 * @property {CacheStorage | null} [storage] The storage provider. Defaults to {@link storageOf}.
 * @property {number} [at] The observation time in epoch milliseconds.
 *   Defaults to the current time.
 */

(() => {
  const ADVISORY_PREFIX = 'adv:';

  const LIST_PREFIX = 'list:';

  const PROGRESS_PREFIX = 'queue:';

  /**
   * Clearing removes only these keys. Members and branches accumulate across
   * advisories and have separate stores.
   *
   * @type {readonly string[]}
   */
  const CACHE_PREFIXES = [ADVISORY_PREFIX, LIST_PREFIX, PROGRESS_PREFIX];

  const MINUTE_MS = 60 * 1000;
  const DAY_MS = 24 * 60 * MINUTE_MS;

  /**
   * This refresh threshold applies to entries with an unknown state.
   * Stale entries remain available for display during refresh.
   */
  const STALE_MS = 5 * MINUTE_MS;

  /**
   * Refresh frequency depends on advisory state.
   *
   * @type {Readonly<Record<string, number>>}
   */
  const STALE_MS_BY_STATE = {
    triage: 5 * MINUTE_MS,
    draft: 5 * MINUTE_MS,
    closed: 7 * DAY_MS,
    published: 30 * DAY_MS,
    withdrawn: 30 * DAY_MS,
  };

  /**
   * Spread refreshes across several days for entries initially fetched together.
   */
  const JITTER_MS = 5 * DAY_MS;

  /**
   * Apply jitter to states with the thirty-day refresh threshold.
   *
   * @type {ReadonlySet<string>}
   */
  const JITTERED_STATES = new Set(['published', 'withdrawn']);

  /**
   * Evict after repeated 404 responses (REQUIREMENTS.md section 2). A single
   * 404 can reflect lost access or a transient failure. Successful reads reset
   * the count. `crawl.js` uses the same limit independently to avoid a dependency
   * cycle.
   */
  const MAX_MISSES = 3;

  /** @type {CacheStorage | null} */
  let injected = null;

  /** @type {(() => number) | null} */
  let injectedClock = null;

  /** @type {(() => number) | null} */
  let injectedRandom = null;

  /**
   * @returns {CacheStorage | null} Browser storage with get, set, and remove
   *   methods, or null if unavailable.
   */
  function browserStorage() {
    return /** @type {CacheStorage | null} */ (
      globalThis.bghsa.storage.local(['get', 'set', 'remove'])
    );
  }

  /**
   * @param {CacheStorage | null} storage The storage provider, or null for browser storage.
   * @returns {void}
   */
  function setStorage(storage) {
    injected = storage;
  }

  /** @returns {CacheStorage | null} The active storage provider. */
  function storageOf() {
    return injected ?? browserStorage();
  }

  /**
   * @param {(() => number) | null} clock The clock, or null for Date.now.
   * @returns {void}
   */
  function setClock(clock) {
    injectedClock = clock;
  }

  /** @returns {number} The current time in epoch milliseconds. */
  function now() {
    return injectedClock === null ? Date.now() : injectedClock();
  }

  /**
   * @param {(() => number) | null} source Returns a fraction in [0, 1).
   *   Null restores Math.random.
   * @returns {void}
   */
  function setRandom(source) {
    injectedRandom = source;
  }

  /** @returns {number} a fraction in [0, 1). */
  function random() {
    return injectedRandom === null ? Math.random() : injectedRandom();
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @returns {string | null} The lowercase `owner/repo`, or null if incomplete.
   */
  function repositoryOf(ref) {
    if (ref === null || ref === undefined) return null;
    const owner = String(ref.owner ?? '').trim().toLowerCase();
    const repo = String(ref.repo ?? '').trim().toLowerCase();
    return owner === '' || repo === '' ? null : `${owner}/${repo}`;
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown, ghsaId?: unknown } | null | undefined} ref
   * @returns {string | null} The lowercase `adv:{owner}/{repo}:{ghsa}` key,
   *   or null if incomplete.
   */
  function advisoryKey(ref) {
    const repository = repositoryOf(ref);
    const ghsa = String(ref?.ghsaId ?? '').trim().toLowerCase();
    return repository === null || ghsa === '' ? null : `${ADVISORY_PREFIX}${repository}:${ghsa}`;
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @returns {string | null} The repository's list cache key.
   */
  function listKey(ref) {
    const repository = repositoryOf(ref);
    return repository === null ? null : `${LIST_PREFIX}${repository}`;
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @returns {string | null} The repository's refresh progress key.
   */
  function progressKey(ref) {
    const repository = repositoryOf(ref);
    return repository === null ? null : `${PROGRESS_PREFIX}${repository}`;
  }

  /**
   * @param {unknown} key
   * @returns {boolean} whether this storage key belongs to the cache. The
   *   `members` and `branches` entries do not.
   */
  function isCacheKey(key) {
    return typeof key === 'string' && CACHE_PREFIXES.some((prefix) => key.startsWith(prefix));
  }

  /**
   * @param {unknown} value
   * @returns {string | null} The trimmed, lowercase state, or null if empty.
   */
  function normalizeState(value) {
    if (typeof value !== 'string') return null;
    const state = value.trim().toLowerCase();
    return state === '' ? null : state;
  }

  /**
   * @param {unknown} record
   * @returns {string | null} The record's normalized state.
   */
  function stateOf(record) {
    if (!globalThis.bghsa.schema.isPlainObject(record)) return null;
    return normalizeState(record.state);
  }

  /**
   * @param {string | null} state The entry's state, already normalized.
   * @param {unknown} value The stored jitter.
   * @returns {number} The bounded refresh delay in milliseconds. Invalid
   *   values and states without jitter use zero.
   */
  function jitterOf(state, value) {
    if (state === null || !JITTERED_STATES.has(state)) return 0;
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.min(Math.max(0, value), JITTER_MS);
  }

  /**
   * @param {string | null} state The entry's state, already normalized.
   * @returns {number} Jitter chosen once per write to give each entry a
   *   stable refresh deadline.
   */
  function drawJitter(state) {
    return Math.floor(jitterOf(state, random() * JITTER_MS));
  }

  /**
   * @param {string | null | undefined} state
   * @param {number} [jitterMs] Additional refresh delay. Defaults to zero.
   * @returns {number} The refresh threshold in milliseconds, including jitter.
   *   Unknown states use STALE_MS.
   */
  function staleAfter(state, jitterMs) {
    const key = normalizeState(state);
    const held = key === null ? undefined : STALE_MS_BY_STATE[key];
    return (held === undefined ? STALE_MS : held) + jitterOf(key, jitterMs);
  }

  /**
   * @param {CacheEntry} entry
   * @param {number} at The comparison time in epoch milliseconds.
   * @returns {number} The entry's age in milliseconds, clamped to zero for
   *   observations later than `at`.
   */
  function ageOf(entry, at) {
    return Math.max(0, at - entry.observedAt);
  }

  /**
   * @param {CacheEntry} entry
   * @param {number} at The comparison time in epoch milliseconds.
   * @returns {boolean} Whether the entry has reached its refresh threshold.
   */
  function isStale(entry, at) {
    return ageOf(entry, at) >= staleAfter(entry.state, entry.jitterMs);
  }

  /**
   * @param {unknown} value The stored miss count.
   * @returns {number} The nonnegative integer miss count, or zero if invalid.
   */
  function missesOf(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.trunc(value));
  }

  /**
   * @param {unknown} value The stored entry.
   * @returns {CacheEntry | null} The validated cache entry, or null if malformed.
   */
  function entryFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    const observedAt = value.observedAt;
    if (typeof observedAt !== 'number' || !Number.isFinite(observedAt)) return null;
    const state = normalizeState(value.state);
    return {
      record: value.record,
      observedAt,
      state,
      jitterMs: jitterOf(state, value.jitterMs),
      misses: missesOf(value.misses),
    };
  }

  /**
   * Ignore storage removal failures; cached data can be fetched again.
   *
   * @param {CacheStorage} storage
   * @param {string[]} keys
   * @returns {Promise<void>}
   */
  async function discard(storage, keys) {
    if (keys.length === 0) return;
    try {
      await storage.remove(keys);
    } catch {
      // Leave the entry for a later removal attempt.
    }
  }

  /**
   * Return stale entries for display during refresh. Storage failures return
   * null so callers can fetch the data again.
   *
   * @param {string | null} key
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>}
   */
  async function getEntry(key, options = {}) {
    const storage = options.storage ?? storageOf();
    if (storage === null || key === null) return null;
    /** @type {unknown} */
    let held;
    try {
      held = (await storage.get(key))[key];
    } catch {
      return null;
    }
    return entryFrom(held);
  }

  /**
   * @param {readonly (string | null)[]} keys
   * @param {CacheOptions} [options]
   * @returns {Promise<Map<string, CacheEntry>>} Available entries, indexed by key.
   */
  async function getEntries(keys, options = {}) {
    const storage = options.storage ?? storageOf();
    /** @type {Map<string, CacheEntry>} */
    const found = new Map();
    const wanted = [...new Set(keys.filter((key) => typeof key === 'string'))];
    if (storage === null || wanted.length === 0) return found;
    /** @type {Record<string, unknown>} */
    let held;
    try {
      held = await storage.get(wanted);
    } catch {
      return found;
    }
    for (const key of wanted) {
      const entry = entryFrom(held[key]);
      if (entry !== null) found.set(key, entry);
    }
    return found;
  }

  /**
   * A successful observation replaces the entry and clears its 404 count.
   *
   * @param {string | null} key
   * @param {unknown} record
   * @param {string | null} state The advisory state for refresh scheduling.
   *   List and progress entries use null.
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>} The stored entry, or null if storage failed
   *   or the key or storage provider was missing.
   */
  async function putEntry(key, record, state, options = {}) {
    const storage = options.storage ?? storageOf();
    if (storage === null || key === null) return null;
    /** @type {CacheEntry} */
    const entry = {
      record,
      observedAt: options.at ?? now(),
      state,
      jitterMs: drawJitter(state),
    };
    try {
      await storage.set({ [key]: entry });
    } catch {
      return null;
    }
    return entry;
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown, ghsaId?: unknown } | null | undefined} ref
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>} The cached advisory observation.
   */
  function getAdvisory(ref, options = {}) {
    return getEntry(advisoryKey(ref), options);
  }

  /**
   * Cache both fetched advisories and observations from the live detail page.
   *
   * @param {{ owner?: unknown, repo?: unknown, ghsaId?: unknown } | null | undefined} ref
   * @param {unknown} record The parsed advisory.
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>}
   */
  function putAdvisory(ref, record, options = {}) {
    return putEntry(advisoryKey(ref), record, stateOf(record), options);
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref The
   *   repository the advisories are on.
   * @param {readonly string[]} ghsaIds
   * @param {CacheOptions} [options]
   * @returns {Promise<Map<string, CacheEntry>>} Cached advisories keyed by the
   *   caller's GHSA identifier spelling.
   */
  async function getAdvisories(ref, ghsaIds, options = {}) {
    /** @type {Map<string, string>} */
    const byKey = new Map();
    for (const ghsaId of ghsaIds) {
      const key = advisoryKey({ ...(ref ?? {}), ghsaId });
      if (key !== null && !byKey.has(key)) byKey.set(key, ghsaId);
    }
    const entries = await getEntries([...byKey.keys()], options);
    /** @type {Map<string, CacheEntry>} */
    const found = new Map();
    for (const [key, entry] of entries) {
      const ghsaId = byKey.get(key);
      if (ghsaId !== undefined) found.set(ghsaId, entry);
    }
    return found;
  }

  /**
   * Count consecutive 404 responses and evict at MAX_MISSES. Preserve the
   * observation time because a failed read does not refresh the advisory.
   * Callers must exclude timeouts, connection errors, other statuses, and stops.
   *
   * @param {{ owner?: unknown, repo?: unknown, ghsaId?: unknown } | null | undefined} ref
   * @param {CacheOptions} [options]
   * @returns {Promise<{ misses: number, evicted: boolean }>} The consecutive
   *   404 count and eviction result. An absent entry returns zero misses.
   */
  async function noteMissing(ref, options = {}) {
    const storage = options.storage ?? storageOf();
    const key = advisoryKey(ref);
    if (storage === null || key === null) return { misses: 0, evicted: false };
    /** @type {unknown} */
    let held;
    try {
      held = (await storage.get(key))[key];
    } catch {
      return { misses: 0, evicted: false };
    }
    const entry = entryFrom(held);
    if (entry === null) return { misses: 0, evicted: false };
    const misses = missesOf(entry.misses) + 1;
    if (misses >= MAX_MISSES) {
      await discard(storage, [key]);
      return { misses, evicted: true };
    }
    try {
      await storage.set({ [key]: { ...entry, misses } });
    } catch {
      // A failed count update delays eviction until a later pass.
      return { misses, evicted: false };
    }
    return { misses, evicted: false };
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>} The repository's cached list.
   */
  function getList(ref, options = {}) {
    return getEntry(listKey(ref), options);
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @param {unknown} record The parsed list.
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>}
   */
  function putList(ref, record, options = {}) {
    return putEntry(listKey(ref), record, null, options);
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @param {CacheOptions} [options]
   * @returns {Promise<unknown>} The cached refresh progress, or null if absent.
   *   The caller validates the record.
   */
  async function getProgress(ref, options = {}) {
    const entry = await getEntry(progressKey(ref), options);
    return entry === null ? null : entry.record;
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @param {unknown} progress
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>}
   */
  function putProgress(ref, progress, options = {}) {
    return putEntry(progressKey(ref), progress, null, options);
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @param {CacheOptions} [options]
   * @returns {Promise<void>} Removes the cached progress entry.
   */
  async function clearProgress(ref, options = {}) {
    const storage = options.storage ?? storageOf();
    const key = progressKey(ref);
    if (storage === null || key === null) return;
    await discard(storage, [key]);
  }

  /**
   * Clear cached observations and progress. Preserve members and branches,
   * which accumulate across advisories and sessions.
   *
   * @param {CacheOptions} [options]
   * @returns {Promise<number>} The number of entries removed.
   */
  async function clear(options = {}) {
    const storage = options.storage ?? storageOf();
    if (storage === null) return 0;
    /** @type {Record<string, unknown>} */
    let all;
    try {
      all = await storage.get(null);
    } catch {
      return 0;
    }
    const keys = Object.keys(all).filter(isCacheKey);
    if (keys.length === 0) return 0;
    try {
      await storage.remove(keys);
    } catch {
      return 0;
    }
    return keys.length;
  }

  const exported = {
    ADVISORY_PREFIX,
    LIST_PREFIX,
    PROGRESS_PREFIX,
    STALE_MS,
    setStorage,
    storageOf,
    setClock,
    now,
    setRandom,
    advisoryKey,
    listKey,
    progressKey,
    isCacheKey,
    stateOf,
    staleAfter,
    isStale,
    entryFrom,
    getEntry,
    getAdvisory,
    putAdvisory,
    getAdvisories,
    noteMissing,
    getList,
    putList,
    getProgress,
    putProgress,
    clearProgress,
    clear,
  };

  globalThis.bghsa.cache = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
