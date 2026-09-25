'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./cache.js');
  require('./schema.js');
  require('./parse-detail.js');
  require('./write.js');
}

/**
 * Persist progress so another page load can resume an interrupted pass.
 * Refreshes run in content scripts while a GitHub tab is open
 * (REQUIREMENTS.md section 12).
 *
 * @typedef {object} QueueProgress
 * @property {string[]} pending The advisories still to read, in the order they
 *   will be read.
 * @property {string | null} inFlight The advisory a pass has taken from pending and not
 *   yet finished, through the wait before its request.
 * @property {string[]} done Advisories with fetched or fresh cached observations.
 * @property {string[]} failed The advisories whose read failed this pass.
 * @property {number | null} lastRequestAt The last request time in epoch
 *   milliseconds, retained for throttling across page loads.
 * @property {number | null} startedAt When this pass began.
 * @property {number} updatedAt When this record was written.
 */

/**
 * Counts accumulate for the lifetime of the queue. The failure list contains
 * only failures from the returning pass.
 *
 * @typedef {object} QueueSummary
 * @property {number} fetched Advisories read over the network.
 * @property {number} skipped Advisories served from fresh cache entries.
 * @property {string[]} failed The advisories whose read failed in this pass.
 * @property {string[]} remaining Advisories still pending when the pass returned.
 * @property {boolean} complete Whether the queue emptied.
 */

/**
 * @typedef {object} PageRead
 * @property {string | null} body The response body, or null on failure.
 * @property {number | null} status The HTTP status, or null if no response arrived.
 * @property {unknown} reason Why the read failed, and null where it did not.
 * @property {boolean} stopped Whether the queue stopped before sending the
 *   request. Callers must exclude this result from failure counts.
 */

/**
 * @typedef {object} QueueOptions
 * @property {{ owner: string, repo: string }} ref The repository whose
 *   advisories this pass reads.
 * @property {import('./cache.js').CacheStorage | null} [storage]
 * @property {() => number} [now] Returns the current time in epoch milliseconds.
 * @property {(ms: number) => Promise<void>} [wait] Waits between requests for
 *   the specified number of milliseconds.
 * @property {() => number} [random] Returns a fraction in [0, 1) for wait jitter.
 * @property {number} [timeoutMs] The request timeout in milliseconds.
 * @property {import('./write.js').WriteFetch} [fetch]
 * @property {(html: string, ref: import('./parse-detail.js').AdvisoryRef) => unknown} [parse]
 *   Parses fetched HTML into a cache record.
 * @property {(ghsaId: string, entry: import('./cache.js').CacheEntry) => void} [onEntry]
 *   Called for each fetched or fresh cached advisory.
 * @property {(ghsaId: string, reason: unknown) => void} [onFailure]
 */

(() => {
  /**
   * List and advisory requests share this interval within a queue.
   */
  const RATE_MS = 1000;

  /**
   * Storage lacks compare-and-set. Random delay reduces collisions between
   * queues reading the same request timestamp, but concurrent queues can still
   * send within one interval. The delay only extends the required wait.
   */
  const SPREAD_MS = 250;

  /**
   * Repeated 404 responses trigger eviction through `cache.noteMissing`.
   */
  const MISSING_STATUS = 404;

  /**
   * Bound requests so an unresponsive connection cannot block the queue indefinitely.
   */
  const REQUEST_TIMEOUT_MS = 15 * 1000;

  /**
   * @param {unknown} countdown A timer that has not fired.
   * @returns {void} Allows Node to exit while the timer is pending.
   */
  function release(countdown) {
    const handle = /** @type {{ unref?: () => void }} */ (countdown);
    if (typeof handle?.unref === 'function') handle.unref();
  }

  /**
   * @param {unknown} value
   * @returns {boolean} Whether the value is a nonempty string.
   */
  function isGhsaId(value) {
    return typeof value === 'string' && value.trim() !== '';
  }

  /**
   * @param {unknown} value
   * @returns {string[]} Unique, nonempty advisory identifiers in input order.
   */
  function idsOf(value) {
    /** @type {string[]} */
    const ids = [];
    if (!Array.isArray(value)) return ids;
    for (const id of value) {
      if (!isGhsaId(id)) continue;
      const ghsaId = /** @type {string} */ (id).trim();
      if (!ids.includes(ghsaId)) ids.push(ghsaId);
    }
    return ids;
  }

  /**
   * @param {unknown} value
   * @returns {number | null}
   */
  function timeOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  /**
   * @param {unknown} value The cached progress record.
   * @returns {QueueProgress | null} The validated progress record.
   */
  function progressFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    const inFlight = isGhsaId(value.inFlight) ? /** @type {string} */ (value.inFlight).trim() : null;
    return {
      pending: idsOf(value.pending),
      inFlight,
      done: idsOf(value.done),
      failed: idsOf(value.failed),
      lastRequestAt: timeOf(value.lastRequestAt),
      startedAt: timeOf(value.startedAt),
      updatedAt: timeOf(value.updatedAt) ?? 0,
    };
  }

  /**
   * Fetch uncached advisories first, then stale observations from oldest to
   * newest. Break ties by identifier. Fresh entries are skipped.
   *
   * @param {readonly string[]} ghsaIds
   * @param {Map<string, import('./cache.js').CacheEntry>} entries Cached advisory entries.
   * @param {number} at
   * @returns {{ order: string[], fresh: string[] }}
   */
  function plan(ghsaIds, entries, at) {
    /** @type {string[]} */
    const order = [];
    /** @type {string[]} */
    const fresh = [];
    for (const ghsaId of idsOf([...ghsaIds])) {
      const entry = entries.get(ghsaId);
      if (entry !== undefined && !globalThis.bghsa.cache.isStale(entry, at)) {
        fresh.push(ghsaId);
        continue;
      }
      order.push(ghsaId);
    }
    order.sort((left, right) => {
      const first = entries.get(left);
      const second = entries.get(right);
      const one = first === undefined ? Number.NEGATIVE_INFINITY : first.observedAt;
      const two = second === undefined ? Number.NEGATIVE_INFINITY : second.observedAt;
      if (one !== two) return one - two;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    return { order, fresh };
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Create a serial refresh queue for one repository. Persist progress for
   * resumption after navigation.
   *
   * @param {QueueOptions} options
   */
  function createQueue(options) {
    const ref = { owner: String(options.ref.owner), repo: String(options.ref.repo) };
    const storage = options.storage;
    const clock = options.now ?? (() => globalThis.bghsa.cache.now());
    const wait = options.wait ?? sleep;
    const draw = options.random ?? Math.random;
    const timeout = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const send =
      options.fetch ??
      /** @type {import('./write.js').WriteFetch} */ (globalThis.fetch.bind(globalThis));
    const parse =
      options.parse ??
      ((html) =>
        globalThis.bghsa.parseDetail.parseDetail(
          new DOMParser().parseFromString(html, 'text/html')
        ));

    /** @type {string[]} */
    let pending = [];
    /** @type {string | null} */
    let inFlight = null;
    /** @type {string[]} */
    let done = [];
    /** @type {string[]} */
    let failed = [];
    /** @type {number | null} */
    let lastRequestAt = null;
    /** @type {number | null} */
    let startedAt = null;
    /** @type {Promise<QueueSummary> | null} */
    let running = null;
    let stopped = false;
    let fetched = 0;
    let skipped = 0;

    /**
     * Serialize list-page and advisory requests through the same queue.
     *
     * @type {Promise<unknown>}
     */
    let queued = Promise.resolve();

    /**
     * @template T
     * @param {() => Promise<T>} work
     * @returns {Promise<T>} The work's result after prior work settles, including
     *   rejected work.
     */
    function serially(work) {
      const next = queued.then(work, work);
      queued = next.then(
        () => {},
        () => {}
      );
      return next;
    }

    /**
     * @returns {number} Additional wait in milliseconds. Invalid random values
     *   produce zero.
     */
    function spread() {
      const fraction = draw();
      if (!(typeof fraction === 'number' && fraction >= 0 && fraction < 1)) return 0;
      return Math.round(fraction * SPREAD_MS);
    }

    /** @returns {QueueProgress} The current progress record. */
    function progress() {
      return {
        pending: [...pending],
        inFlight,
        done: [...done],
        failed: [...failed],
        lastRequestAt,
        startedAt,
        updatedAt: clock(),
      };
    }

    /**
     * @returns {Promise<number | null>} The request timestamp shared by this
     *   repository's queues.
     */
    async function claimedAt() {
      const held = progressFrom(
        await globalThis.bghsa.cache.getProgress(ref, { storage, at: clock() })
      );
      return held === null ? null : held.lastRequestAt;
    }

    /**
     * @returns {Promise<void>} Adopts a later stored request timestamp.
     */
    async function adopt() {
      const claimed = await claimedAt();
      if (claimed !== null && (lastRequestAt === null || claimed > lastRequestAt)) {
        lastRequestAt = claimed;
      }
    }

    /**
     * @returns {Promise<void>} Persists progress after adopting any later stored
     *   request timestamp.
     */
    async function persist() {
      await adopt();
      await globalThis.bghsa.cache.putProgress(ref, progress(), { storage, at: clock() });
    }

    /**
     * @param {string} ghsaId
     * @param {unknown} reason
     * @returns {void} Reports the failure without interrupting the remaining work.
     */
    function fail(ghsaId, reason) {
      if (options.onFailure === undefined) return;
      try {
        options.onFailure(ghsaId, reason);
      } catch {
        // Continue processing other advisories after a listener failure.
      }
    }

    /**
     * @param {string} ghsaId
     * @param {import('./cache.js').CacheEntry} entry
     * @returns {void}
     */
    function report(ghsaId, entry) {
      if (options.onEntry === undefined) return;
      try {
        options.onEntry(ghsaId, entry);
      } catch (error) {
        fail(ghsaId, error);
      }
    }

    /**
     * Resume persisted progress after existing work settles. Requeue the
     * previous in-flight advisory; the freshness check skips it if its response
     * was already cached. Loading also restarts a stopped queue.
     *
     * The stored pending advisories join the ones this queue holds, after
     * them. A load keeps every advisory queued since the last save: one
     * whose save is still under way, one whose save failed, or one another
     * page's save left out of the stored record.
     *
     * @returns {Promise<QueueProgress | null>} The restored progress, or null if absent.
     */
    function load() {
      return serially(async () => {
        stopped = false;
        const held = progressFrom(
          await globalThis.bghsa.cache.getProgress(ref, { storage, at: clock() })
        );
        if (held === null) return null;
        const stored = held.inFlight === null ? held.pending : [held.inFlight, ...held.pending];
        pending = idsOf([...pending, ...stored]);
        inFlight = null;
        done = [...held.done];
        failed = [...held.failed];
        lastRequestAt = held.lastRequestAt;
        startedAt = held.startedAt;
        return held;
      });
    }

    /**
     * @param {readonly string[]} ghsaIds
     * @returns {Promise<{ queued: string[], fresh: string[] }>}
     */
    async function add(ghsaIds) {
      const at = clock();
      const wanted = idsOf([...pending, ...ghsaIds]).filter((ghsaId) => ghsaId !== inFlight);
      const entries = await globalThis.bghsa.cache.getAdvisories(ref, wanted, { storage, at });
      const { order, fresh } = plan(wanted, entries, at);
      pending = order;
      for (const ghsaId of fresh) {
        if (done.includes(ghsaId)) continue;
        done.push(ghsaId);
        skipped += 1;
        const entry = entries.get(ghsaId);
        if (entry !== undefined) report(ghsaId, entry);
      }
      if (startedAt === null) startedAt = at;
      await persist();
      return { queued: [...pending], fresh };
    }

    /**
     * Abort at the deadline and reject the race even if the request ignores
     * the abort signal.
     *
     * @template T
     * @param {(signal: AbortSignal) => Promise<T>} attempt
     * @returns {Promise<T>}
     */
    function within(attempt) {
      const controller = new AbortController();
      /** @type {(reason: Error) => void} */
      let expired = () => {};
      /** @type {Promise<never>} */
      const expiry = new Promise((_resolve, reject) => {
        expired = reject;
      });
      const countdown = setTimeout(() => {
        controller.abort();
        expired(new Error(`GitHub did not answer within ${timeout} ms.`));
      }, timeout);
      release(countdown);
      return Promise.race([attempt(controller.signal), expiry]).finally(() => {
        clearTimeout(countdown);
      });
    }

    /**
     * @param {string} url
     * @returns {Promise<{ status: number, body: string }>} The HTTP response.
     *   Non-success responses have an empty body.
     */
    function request(url) {
      return within(async (signal) => {
        const response = await send(url, { ...globalThis.bghsa.write.DETAIL_INIT, signal });
        if (!(response.status >= 200 && response.status < 300)) {
          return { status: response.status, body: '' };
        }
        // Apply the deadline to body reads as well as response headers.
        return { status: response.status, body: await response.text() };
      });
    }

    /**
     * @param {string} ghsaId
     * @returns {Promise<import('./cache.js').CacheEntry | null>} The observation,
     *   or null on read failure. Storage failures still return the observation.
     */
    async function read(ghsaId) {
      const advisory = { owner: ref.owner, repo: ref.repo, ghsaId };
      try {
        const answered = await request(globalThis.bghsa.write.detailUrl(advisory));
        if (!(answered.status >= 200 && answered.status < 300)) {
          // Only 404 responses count toward eviction.
          if (answered.status === MISSING_STATUS) {
            await globalThis.bghsa.cache.noteMissing(advisory, { storage, at: clock() });
          }
          fail(ghsaId, `GitHub answered ${answered.status}.`);
          return null;
        }
        const record = parse(answered.body, advisory);
        if (record === null || record === undefined) {
          fail(ghsaId, 'The page did not read as an advisory.');
          return null;
        }
        const at = clock();
        const held = await globalThis.bghsa.cache.putAdvisory(advisory, record, { storage, at });
        // A storage failure still leaves a successful observation to display.
        return held ?? { record, observedAt: at, state: globalThis.bghsa.cache.stateOf(record) };
      } catch (error) {
        fail(ghsaId, error);
        return null;
      }
    }

    /**
     * Read the shared request timestamp before waiting. Repeat if another queue
     * advances it during the wait. Add random delay even when no interval is
     * owed to reduce simultaneous sends from idle queues.
     *
     * @returns {Promise<void>}
     */
    async function throttle() {
      let waited = false;
      while (!stopped) {
        const claimed = await claimedAt();
        if (claimed !== null && (lastRequestAt === null || claimed > lastRequestAt)) {
          lastRequestAt = claimed;
        } else if (waited) {
          return;
        }
        // A backward clock adjustment waits at most one interval before jitter.
        const since = lastRequestAt === null ? RATE_MS : Math.max(0, clock() - lastRequestAt);
        const owed = since >= RATE_MS ? 0 : RATE_MS - since;
        const delay = owed + spread();
        if (delay === 0) return;
        await wait(delay);
        waited = true;
      }
    }

    /**
     * @param {string} ghsaId
     * @returns {Promise<boolean>} Whether a fresh cache entry was reported
     *   without fetching the advisory.
     */
    async function fresh(ghsaId) {
      const at = clock();
      const held = await globalThis.bghsa.cache.getAdvisory({ ...ref, ghsaId }, { storage, at });
      if (held === null || globalThis.bghsa.cache.isStale(held, at)) return false;
      inFlight = null;
      if (!done.includes(ghsaId)) done.push(ghsaId);
      skipped += 1;
      report(ghsaId, held);
      await persist();
      return true;
    }

    /**
     * List pages share serialization, throttling, and timeouts with advisory
     * reads. A stopped result means the request was never sent.
     *
     * @param {string} url
     * @returns {Promise<PageRead>}
     */
    function page(url) {
      return serially(async () => {
        await throttle();
        if (stopped) {
          return { body: null, status: null, reason: 'The queue was stopped.', stopped: true };
        }
        lastRequestAt = clock();
        await persist();
        try {
          const answered = await request(url);
          if (!(answered.status >= 200 && answered.status < 300)) {
            return {
              body: null,
              status: answered.status,
              reason: `GitHub answered ${answered.status}.`,
              stopped: false,
            };
          }
          return { body: answered.body, status: answered.status, reason: null, stopped: false };
        } catch (error) {
          return { body: null, status: null, reason: error, stopped: false };
        }
      });
    }

    /**
     * @param {((ghsaId: string) => boolean) | null} wanted Reads only the
     *   pending advisories it accepts, in pending order, and ends once one
     *   request is sent. Null reads every pending advisory.
     * @returns {Promise<QueueSummary>}
     */
    async function pass(wanted) {
      // Report only failures from this pass.
      /** @type {string[]} */
      const failures = [];
      while (!stopped) {
        const at = wanted === null ? 0 : pending.findIndex(wanted);
        if (at === -1) break;
        const ghsaId = pending.splice(at, 1)[0];
        if (ghsaId === undefined) break;
        // The advisory is in flight from the moment it leaves pending, through
        // the wait before its request.
        inFlight = ghsaId;

        // Another page may have refreshed the entry since it was queued.
        if (await fresh(ghsaId)) continue;

        await throttle();
        // Preserve the unsent request for the next page load.
        if (stopped) {
          inFlight = null;
          pending.unshift(ghsaId);
          await persist();
          break;
        }
        // The entry may have been refreshed during the wait.
        if (await fresh(ghsaId)) continue;
        lastRequestAt = clock();
        await persist();

        const entry = await read(ghsaId);
        inFlight = null;
        if (entry === null) {
          if (!failed.includes(ghsaId)) failed.push(ghsaId);
          if (!failures.includes(ghsaId)) failures.push(ghsaId);
        } else {
          if (!done.includes(ghsaId)) done.push(ghsaId);
          fetched += 1;
          report(ghsaId, entry);
        }
        await persist();
        if (wanted !== null) break;
      }

      const complete = pending.length === 0 && inFlight === null;
      if (complete) {
        // Preserve the request timestamp for throttling across page loads.
        done = [];
        failed = [];
        startedAt = null;
        await persist();
      }
      return { fetched, skipped, failed: failures, remaining: [...pending], complete };
    }

    /**
     * Concurrent calls share the current pass. Only `load` restarts a stopped
     * queue; `run` preserves the stop from an interrupted list crawl.
     *
     * @returns {Promise<QueueSummary>}
     */
    function run() {
      if (running !== null) return running;
      if (startedAt === null) startedAt = clock();
      running = serially(async () => {
        try {
          return await pass(null);
        } finally {
          running = null;
        }
      });
      return running;
    }

    /**
     * Read pending advisories the predicate accepts, stalest first, until one
     * request is sent, after the work queued before it settles. Fresh entries
     * it passes on the way are reported without a request.
     *
     * @param {(ghsaId: string) => boolean} wanted
     * @returns {Promise<QueueSummary>}
     */
    function readNext(wanted) {
      if (startedAt === null) startedAt = clock();
      return serially(() => pass(wanted));
    }

    /**
     * @returns {Promise<void>} Resolves after queued work settles. An in-flight
     *   request finishes; unsent advisories remain in persisted progress.
     */
    function stop() {
      stopped = true;
      return queued.then(() => {});
    }

    return {
      ref,
      progress,
      load,
      add,
      page,
      run,
      readNext,
      stop,
      persist,
      /** @returns {boolean} whether the queue is stopped. */
      isStopped: () => stopped,
      /** @returns {boolean} whether a pass is running. */
      isRunning: () => running !== null,
    };
  }

  const exported = {
    RATE_MS,
    progressFrom,
    plan,
    createQueue,
  };

  globalThis.bghsa.fetch = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
