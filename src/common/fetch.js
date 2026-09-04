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
 * How far one pass has got. It is held in the cache, so a pass a navigation
 * interrupted resumes on the next page load. REQUIREMENTS.md section 12 leaves
 * the extension no background script, so nothing refreshes unless a `github.com`
 * tab is open and a pass has to survive the tab it started in going somewhere
 * else.
 *
 * @typedef {object} QueueProgress
 * @property {string[]} pending The advisories still to read, in the order they
 *   will be read.
 * @property {string | null} inFlight The advisory a request went out for and
 *   whose answer has not been taken into the cache.
 * @property {string[]} done The advisories this pass holds current data for,
 *   whether it fetched them or found them fresh.
 * @property {string[]} failed The advisories whose read failed this pass.
 * @property {number | null} lastRequestAt When the last request went out, epoch
 *   milliseconds. It outlives the page so a reload cannot spend a request
 *   sooner than one second after the one before it.
 * @property {number | null} startedAt When this pass began.
 * @property {number} updatedAt When this record was written.
 */

/**
 * The counts are what this queue has done since it was created, which is one
 * page load's worth of work. `failed` names the advisories the pass that
 * returned it could not read, and only those: a pass a page going away stopped
 * leaves its own failures for the next page load to read again.
 *
 * @typedef {object} QueueSummary
 * @property {number} fetched Advisories read over the network.
 * @property {number} skipped Advisories the cache already held within the
 *   staleness threshold, whether they were dropped when they were queued or
 *   when their turn came.
 * @property {string[]} failed The advisories whose read failed in this pass.
 * @property {string[]} remaining Advisories left when the pass returned, which
 *   is empty unless it was stopped.
 * @property {boolean} complete Whether the queue emptied.
 */

/**
 * One page of GitHub HTML, as a caller outside this file asked for it.
 *
 * @typedef {object} PageRead
 * @property {string | null} body What GitHub answered with, and null where the
 *   read failed.
 * @property {number | null} status What GitHub answered, and null where nothing
 *   answered at all.
 * @property {unknown} reason Why the read failed, and null where it did not.
 * @property {boolean} stopped Whether the queue was stopped before the request
 *   went out, in which case nothing was asked of GitHub and nothing is known
 *   about the page. It is the work being taken back, and a caller counting how
 *   often a page would not answer counts none of it.
 */

/**
 * @typedef {object} QueueOptions
 * @property {{ owner: string, repo: string }} ref The repository whose
 *   advisories this pass reads.
 * @property {import('./cache.js').CacheStorage | null} [storage]
 * @property {() => number} [now] The clock, epoch milliseconds. Injected, so a
 *   test moves time without spending it.
 * @property {(ms: number) => Promise<void>} [wait] What the queue waits with
 *   between requests. Injected for the same reason.
 * @property {() => number} [random] Where the spread on a wait is drawn from,
 *   as a fraction in [0, 1). Injected so a test can name the draw.
 * @property {number} [timeoutMs] How long one request may go unanswered before
 *   it counts as a failed read. Injected so a test does not spend the bound.
 * @property {import('./write.js').WriteFetch} [fetch]
 * @property {(html: string, ref: import('./parse-detail.js').AdvisoryRef) => unknown} [parse]
 *   What turns a fetched page into the record the cache holds.
 * @property {(ghsaId: string, entry: import('./cache.js').CacheEntry) => void} [onEntry]
 *   Called for each advisory the pass has current data for, which is what
 *   updates a row in place.
 * @property {(ghsaId: string, reason: unknown) => void} [onFailure]
 */

(() => {
  /**
   * The shortest time between two requests. Every read on a repository goes
   * through one serial queue, so this is the rate for the repository and not the
   * rate for one caller.
   */
  const RATE_MS = 1000;

  /**
   * How much longer than the interval it owes a wait may last.
   *
   * `browser.storage.local` offers no compare-and-set, so the claim every queue
   * on a repository shares is read, decided on, and only then written. Two
   * queues that read the same claim compute the same moment to send at, and
   * from then on they stay in step: each wakes inside the other's storage
   * latency, neither sees the other's claim, and the repository takes two
   * requests a second with every advisory fetched twice.
   *
   * Drawing the tail of each wait at random is what stops two queues computing
   * the same wake. The one that wakes second reads the claim the first wrote
   * and waits out a fresh interval from it.
   *
   * This is a spread and not mutual exclusion: two queues can still draw close
   * enough to send inside one interval, and nothing here can rule that out. A
   * quarter of a second is far longer than a storage round trip, so a collision
   * needs the two draws themselves to land within it. A wait is never shorter
   * than the interval it owes, so the spread costs a fraction of a second and
   * never buys a request sooner.
   */
  const SPREAD_MS = 250;

  /**
   * What GitHub answers for an advisory it will not serve. Enough of these in a
   * row take the advisory's entry out; `cache.js` counts them and says how
   * many.
   */
  const MISSING_STATUS = 404;

  /**
   * How long one request may go unanswered before the pass gives up on it.
   *
   * An advisory detail page is one HTML document from a logged-in session, and
   * it answers in well under a second; fifteen seconds is fifteen of this
   * queue's own intervals and covers a slow network several times over. It is
   * also short against what it prevents: without a bound, one request that
   * never settles leaves the pass unfinished, `stop` unable to reach it, and
   * the table unrefreshed for as long as the page is open.
   */
  const REQUEST_TIMEOUT_MS = 15 * 1000;

  /**
   * @param {unknown} countdown A timer that has not fired.
   * @returns {void} takes it out of the work the platform waits on before it
   *   exits, where the platform counts it that way. Node does; a page counts
   *   nothing that way, and a countdown on one request is no reason to hold
   *   either open.
   */
  function release(countdown) {
    const handle = /** @type {{ unref?: () => void }} */ (countdown);
    if (typeof handle?.unref === 'function') handle.unref();
  }

  /**
   * @param {unknown} value
   * @returns {boolean} whether this names an advisory.
   */
  function isGhsaId(value) {
    return typeof value === 'string' && value.trim() !== '';
  }

  /**
   * @param {unknown} value
   * @returns {string[]} the advisory identifiers the value holds, once each and
   *   in the order they were given.
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
   * @param {unknown} value The progress as the cache handed it back.
   * @returns {QueueProgress | null} the progress it holds, and null where it
   *   holds something else. The record is data an older version of this
   *   extension wrote, so its shape is checked and never assumed.
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
   * The order a pass reads advisories in, and the ones it does not read at all.
   *
   * Stalest first: an advisory this extension has never read comes before every
   * advisory it has, and older observations come before newer ones. Two
   * advisories observed at the same moment are ordered by identifier, so a pass
   * planned twice is planned the same way.
   *
   * An advisory observed within the staleness threshold is not read. That
   * threshold is five minutes and is not entry life: a six-day-old triage entry
   * is read again, and the table paints from it while that happens.
   *
   * @param {readonly string[]} ghsaIds
   * @param {Map<string, import('./cache.js').CacheEntry>} entries What the cache
   *   holds for those advisories.
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
   * One serial refresh queue for one repository, at one request per second,
   * stalest first, with its progress held in the cache.
   *
   * The queue is created by a content script and runs while that page is open.
   * A page that goes away takes the pass with it; the next page load reads the
   * progress back and carries on.
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
     * What this queue has been asked to do, in the order it was asked. One
     * queue sends one request at a time, and it has two callers: a crawl
     * reading a list page, and the refresh pass reading advisories.
     *
     * @type {Promise<unknown>}
     */
    let queued = Promise.resolve();

    /**
     * @template T
     * @param {() => Promise<T>} work
     * @returns {Promise<T>} what `work` answered, run after everything already
     *   handed to this queue. A caller that failed does not stop the next one:
     *   the failure belongs to whoever asked for that work.
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
     * @returns {number} the tail of one wait, drawn fresh each time. A draw
     *   outside [0, 1) is no tail at all, which is the shortest wait the
     *   interval allows and never a shorter one.
     */
    function spread() {
      const fraction = draw();
      if (!(typeof fraction === 'number' && fraction >= 0 && fraction < 1)) return 0;
      return Math.round(fraction * SPREAD_MS);
    }

    /** @returns {QueueProgress} how far this pass has got. */
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
     * @returns {Promise<number | null>} the last request time the progress
     *   entry names, and null where it names none or holds something else. Any
     *   queue on this repository writes that entry, so it is where a queue
     *   reads a request it did not send itself.
     */
    async function claimedAt() {
      const held = progressFrom(
        await globalThis.bghsa.cache.getProgress(ref, { storage, at: clock() })
      );
      return held === null ? null : held.lastRequestAt;
    }

    /**
     * @returns {Promise<void>} takes on a request time later than the one this
     *   queue holds, which is a request another queue sent.
     */
    async function adopt() {
      const claimed = await claimedAt();
      if (claimed !== null && (lastRequestAt === null || claimed > lastRequestAt)) {
        lastRequestAt = claimed;
      }
    }

    /**
     * @returns {Promise<void>} holds the progress where the next page reads it.
     *   A request time later than this queue's is taken on before the write, so
     *   the write never lowers what another queue claimed: that entry is the
     *   only thing bounding two queues that know nothing about each other.
     */
    async function persist() {
      await adopt();
      await globalThis.bghsa.cache.putProgress(ref, progress(), { storage, at: clock() });
    }

    /**
     * @param {string} ghsaId
     * @param {unknown} reason
     * @returns {void} tells the caller one read failed. A listener that throws
     *   is a defect on the page's side of the boundary and takes the advisory
     *   it was called for with it, and nothing else: the rest of the pass is
     *   other advisories' data, and the caller is told about those.
     */
    function fail(ghsaId, reason) {
      if (options.onFailure === undefined) return;
      try {
        options.onFailure(ghsaId, reason);
      } catch {
        // Nothing is left to tell: the listener that would hear it is the one
        // that threw.
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
     * Reads what an earlier page left and carries on from it.
     *
     * The advisory that was in flight when that page went away is the one whose
     * request went out and whose answer never reached the cache. It goes back at
     * the head of the queue, so the pass loses no work. It is not counted done,
     * so nothing is double counted either, and where the answer did land before
     * the page went away the cache holds it and the staleness check takes it out
     * of the queue without spending a second request.
     *
     * Taking a pass back is what starts a stopped queue again: a page that came
     * back to a repository it had left asks for the pass it left there. The take
     * runs through this queue's slot, so it waits out whatever the queue is
     * still finishing and never reads the pass back from under a pass that is
     * still running.
     *
     * @returns {Promise<QueueProgress | null>} what was resumed, and null where
     *   there was nothing to resume.
     */
    function load() {
      return serially(async () => {
        stopped = false;
        const held = progressFrom(
          await globalThis.bghsa.cache.getProgress(ref, { storage, at: clock() })
        );
        if (held === null) return null;
        pending = idsOf(held.inFlight === null ? held.pending : [held.inFlight, ...held.pending]);
        inFlight = null;
        done = [...held.done];
        failed = [...held.failed];
        lastRequestAt = held.lastRequestAt;
        startedAt = held.startedAt;
        return held;
      });
    }

    /**
     * Puts advisories in the queue, ordering everything queued stalest first and
     * dropping what the cache holds within the staleness threshold.
     *
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
     * Bounds one request in time. A request that has not answered by the
     * deadline is aborted, which lets the browser drop the connection, and the
     * read fails: it has spent its slot in the queue and the pass carries on to
     * the next advisory.
     *
     * The race is what bounds the wait, and the abort is what ends the work. A
     * request that answers nothing and honors no signal is still given up on.
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
     * Sends one request and reads what came back, inside the bound.
     *
     * @param {string} url
     * @returns {Promise<{ status: number, body: string }>} what GitHub
     *   answered, with an empty body where the status is not a success.
     */
    function request(url) {
      return within(async (signal) => {
        const response = await send(url, { ...globalThis.bghsa.write.DETAIL_INIT, signal });
        if (!(response.status >= 200 && response.status < 300)) {
          return { status: response.status, body: '' };
        }
        // The body is read inside the bound as well: a page that starts
        // arriving and stops is as unanswered as one that never came.
        return { status: response.status, body: await response.text() };
      });
    }

    /**
     * Fetches one advisory's detail page and holds what it says. Every derived
     * value comes from that one page, so one advisory costs one request.
     *
     * @param {string} ghsaId
     * @returns {Promise<import('./cache.js').CacheEntry | null>} what the page
     *   said, and null where the read failed. The entry comes back whether or
     *   not the cache took it.
     */
    async function read(ghsaId) {
      const advisory = { owner: ref.owner, repo: ref.repo, ghsaId };
      try {
        const answered = await request(globalThis.bghsa.write.detailUrl(advisory));
        if (!(answered.status >= 200 && answered.status < 300)) {
          // The status is the typed thing this branches on. A read that never
          // reached GitHub throws and lands in the catch below with no status
          // at all, and a 5xx is GitHub having a bad minute: neither says the
          // advisory is gone, and neither counts against it.
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
        // The page that answered is authoritative and the cache is a
        // convenience: REQUIREMENTS.md section 2 has it never authoritative and
        // always rederivable. A quota or a storage failure therefore costs the
        // caching and nothing else, and the read is the success it was.
        return held ?? { record, observedAt: at, state: globalThis.bghsa.cache.stateOf(record) };
      } catch (error) {
        fail(ghsaId, error);
        return null;
      }
    }

    /**
     * Waits out whatever is left of the second since the last request on this
     * repository, whichever queue sent it.
     *
     * The time is read back from the progress entry every time round, so a
     * queue is bounded by requests it never saw: the one in another tab, and
     * the one a turbo re-injection left behind on this page. The rate of one
     * request per second belongs to the repository and not to a queue, so the
     * bound holds wherever a queue runs.
     *
     * The wait repeats only while the entry names a request later than the one
     * already waited out. A queue therefore yields to a request that lands
     * during its wait, and a time that does not move costs one wait.
     *
     * Every wait carries a spread, the one in {@link SPREAD_MS}, and a queue
     * that owes no interval at all still spends it. Two queues that wake on the
     * same claim would otherwise both find nothing owed and send together,
     * which is the head of a pass and the common way two tabs lock into step.
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
        // A time later than the clock reads, which a clock moved backwards
        // leaves behind, is one interval of wait and not the difference.
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
     * @returns {Promise<boolean>} whether the cache holds this advisory within
     *   the staleness threshold, in which case the pass reports it from there
     *   and spends no request. Opening a detail page refreshes an entry from
     *   the live DOM, and another queue's pass refreshes it from a fetch;
     *   either costs this pass nothing.
     */
    async function fresh(ghsaId) {
      const at = clock();
      const held = await globalThis.bghsa.cache.getAdvisory({ ...ref, ghsaId }, { storage, at });
      if (held === null || globalThis.bghsa.cache.isStale(held, at)) return false;
      if (!done.includes(ghsaId)) done.push(ghsaId);
      skipped += 1;
      report(ghsaId, held);
      await persist();
      return true;
    }

    /**
     * Reads one page of GitHub HTML through this queue's slot. A crawl of the
     * advisory list walks its pages this way.
     *
     * A list page costs a request exactly as an advisory read does, and the
     * rate limit counts requests, so the two spend one slot between them: the
     * same wait, the same claim written where every queue on this repository
     * reads it, and the same bound on how long one request may go unanswered.
     * A crawl that walked pages on a limit of its own would double the rate the
     * extension can produce.
     *
     * A read a stop reaches first sends nothing and comes back marked stopped,
     * which is what tells a caller its work was put down and not that GitHub
     * would not serve the page.
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

    /** @returns {Promise<QueueSummary>} */
    async function pass() {
      // What this pass could not read, which is what it answers with. The
      // queue's own list outlives a pass a page going away stopped, and an
      // advisory on it is one the next pass reads again.
      /** @type {string[]} */
      const failures = [];
      while (!stopped) {
        const ghsaId = pending.shift();
        if (ghsaId === undefined) break;

        // The cache is read again here and not only when the advisory was
        // queued: opening its detail page refreshes the entry from the live DOM,
        // and that costs no request while this one would.
        if (await fresh(ghsaId)) continue;

        await throttle();
        // A stop that lands during the wait is a stop with nothing in flight,
        // so nothing is left to finish and the advisory goes back at the head
        // of the queue for the next page load.
        if (stopped) {
          pending.unshift(ghsaId);
          await persist();
          break;
        }
        // The wait lasts a second, and an advisory can reach the cache during
        // it: another queue fetches it, or a maintainer opens its page.
        if (await fresh(ghsaId)) continue;
        // The advisory is in flight before the request goes out, so a page that
        // goes away mid-flight leaves a record naming what was asked for.
        inFlight = ghsaId;
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
      }

      const complete = pending.length === 0 && inFlight === null;
      if (complete) {
        // A finished pass leaves nothing to resume and one thing to obey: the
        // moment the last request went out. The next page load reads it and
        // waits out the rest of that second before spending a request of its
        // own.
        done = [];
        failed = [];
        startedAt = null;
        await persist();
      }
      return { fetched, skipped, failed: failures, remaining: [...pending], complete };
    }

    /**
     * Runs the queue down. Calling it while a pass is running joins that pass
     * rather than starting a second one: the queue is serial.
     *
     * A stopped queue stays stopped, and this pass reads nothing and reports
     * what is left. `load` is what takes a pass back and starts the queue
     * again. The two halves of a collection are a walk of the list pages and
     * then the reads the walk named, and the stop that put the walk down is the
     * page going away: taking the reads up here would spend the hundred
     * requests the stop was for.
     *
     * @returns {Promise<QueueSummary>}
     */
    function run() {
      if (running !== null) return running;
      if (startedAt === null) startedAt = clock();
      running = serially(async () => {
        try {
          return await pass();
        } finally {
          running = null;
        }
      });
      return running;
    }

    /**
     * @returns {Promise<void>} stops the pass after the request in flight, and
     *   at once where none is: a stop during the wait between requests sends no
     *   further request. What is left, the advisory that was waiting included,
     *   stays in the progress entry for the next page load. The promise settles
     *   when the work already handed to this queue has wound down, which is what
     *   a caller waits on to know no further request will go out.
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
      stop,
      persist,
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
