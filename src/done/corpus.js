'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/cache.js');
  require('../common/parse-list.js');
  require('../common/crawl.js');
  require('../common/record.js');
}

/**
 * Include every advisory found on a list page, including those whose detail
 * pages have not been fetched.
 *
 * @typedef {object} CorpusMember
 * @property {string} ghsaId
 * @property {string} state The query state used to discover the advisory.
 * @property {import('../common/parse-list.js').ListRow} row
 * @property {number} seenAt The list observation time in epoch milliseconds.
 * @property {import('../common/parse-detail.js').ParsedDetail | null} advisory
 *   The fetched detail data, or null if unavailable.
 * @property {number | null} observedAt The detail observation time in epoch milliseconds.
 */

/**
 * A corpus contains advisories from selected repository states and records
 * collection progress. The done view selects published and closed states;
 * statistics also include open states.
 *
 * @typedef {object} Corpus
 * @property {CorpusMember[]} members Collected advisories in the selected states, sorted by
 *   identifier.
 * @property {string[]} unread Identifiers without fetched detail data.
 * @property {boolean} complete Whether every state crawl reached its last page.
 * @property {boolean} running Whether collection is active. An incomplete corpus can be
 *   running or stopped.
 * @property {Record<string, number | null>} expected Counts from GitHub's state tabs, keyed
 *   by query state. Null indicates an unread count.
 */

/**
 * @typedef {object} CorpusOptions
 * @property {{ owner: string, repo: string }} ref
 * @property {{
 *   page: (url: string) => Promise<import('../common/fetch.js').PageRead>,
 *   add: (ghsaIds: readonly string[]) => Promise<unknown>,
 *   run: () => Promise<import('../common/fetch.js').QueueSummary>,
 *   load: () => Promise<unknown>,
 * }} queue The shared repository queue for list and detail requests.
 * @property {import('../common/parse-list.js').ParsedList | null} [parsed] The parsed
 *   current list page.
 * @property {string} [href] The URL of that page.
 * @property {import('../common/cache.js').CacheStorage | null} [storage]
 * @property {() => number} [now]
 * @property {(html: string) => import('../common/parse-list.js').ParsedList | null} [parse]
 * @property {(corpus: Corpus) => void} [onPage] Receives the updated corpus as each list
 *   page arrives.
 * @property {(state: string, url: string, reason: unknown) => void} [onFailure]
 */

(() => {
  /**
   * GitHub state tabs are mutually exclusive. Collect both done states
   * regardless of the currently displayed tab (REQUIREMENTS.md section 10).
   *
   * @type {readonly string[]}
   */
  const DONE_STATES = ['published', 'closed'];

  /**
   * @param {import('../common/parse-list.js').ParsedList | null | undefined} parsed
   * @param {readonly string[]} [states] Selected states; defaults to published and closed.
   * @returns {Record<string, number | null>} State-tab counts keyed by query state. Null
   *   indicates an unknown count.
   */
  function expectedOf(parsed, states = DONE_STATES) {
    /** @type {Record<string, number | null>} */
    const counts = {};
    for (const state of states) {
      const tab = parsed?.tabs?.find((entry) => entry.state === state);
      counts[state] = tab === undefined ? null : tab.count;
    }
    return counts;
  }

  /**
   * Assemble the corpus from the crawl and cached detail pages.
   *
   * @param {{ owner: string, repo: string }} ref
   * @param {import('../common/crawl.js').CrawledList} list The collected list data.
   * @param {{
   *   storage?: import('../common/cache.js').CacheStorage | null,
   *   at?: number,
   *   expected?: Record<string, number | null>,
   *   complete?: boolean,
   *   running?: boolean,
   *   states?: readonly string[],
   * }} [options] Selected query states default to published and closed. Statistics also
   *   select open states.
   * @returns {Promise<Corpus>}
   */
  async function membersOf(ref, list, options = {}) {
    const at = options.at ?? globalThis.bghsa.cache.now();
    const states = options.states ?? DONE_STATES;

    /** @type {{ ghsaId: string, state: string, row: import('../common/parse-list.js').ListRow, seenAt: number }[]} */
    const held = [];
    for (const entry of Object.values(list.rows)) {
      if (!states.includes(entry.state)) continue;
      if (entry.row.ghsaId === null) continue;
      held.push({ ghsaId: entry.row.ghsaId, state: entry.state, row: entry.row, seenAt: entry.seenAt });
    }
    held.sort((left, right) => (left.ghsaId < right.ghsaId ? -1 : left.ghsaId > right.ghsaId ? 1 : 0));

    const entries = await globalThis.bghsa.cache.getAdvisories(
      ref,
      held.map((entry) => entry.ghsaId),
      { storage: options.storage, at }
    );

    /** @type {CorpusMember[]} */
    const members = [];
    /** @type {string[]} */
    const unread = [];
    for (const entry of held) {
      const cached = entries.get(entry.ghsaId) ?? null;
      const advisory = cached === null ? null : globalThis.bghsa.record.advisoryFrom(cached.record);
      if (advisory === null) unread.push(entry.ghsaId);
      members.push({
        ghsaId: entry.ghsaId,
        state: entry.state,
        row: entry.row,
        seenAt: entry.seenAt,
        advisory,
        observedAt: advisory === null || cached === null ? null : cached.observedAt,
      });
    }

    return {
      members,
      unread,
      complete: options.complete === true,
      running: options.running === true,
      expected: options.expected ?? expectedOf(null, states),
    };
  }

  /**
   * Collect published and closed advisories. List and detail requests share
   * the caller's rate-limited queue.
   *
   * @param {CorpusOptions} options
   * @returns {Promise<{
   *   corpus: Corpus,
   *   crawled: import('../common/crawl.js').CrawlResult,
   *   read: import('../common/fetch.js').QueueSummary,
   * }>}
   */
  async function collect(options) {
    const ref = { owner: String(options.ref.owner), repo: String(options.ref.repo) };
    const clock = options.now ?? (() => globalThis.bghsa.cache.now());
    const expected = expectedOf(options.parsed);

    /**
     * @param {import('../common/crawl.js').CrawledList} list
     * @param {boolean} complete
     * @param {boolean} running Whether collection is active.
     * @returns {Promise<Corpus>}
     */
    function assemble(list, complete, running) {
      return membersOf(ref, list, {
        storage: options.storage,
        at: clock(),
        expected,
        complete,
        running,
      });
    }

    // Restore saved progress before adding work to avoid repeating completed reads.
    await options.queue.load();

    const crawled = await globalThis.bghsa.crawl.crawl({
      ref,
      queue: options.queue,
      parsed: options.parsed,
      href: options.href,
      storage: options.storage,
      now: options.now,
      states: DONE_STATES,
      parse: options.parse,
      onFailure: options.onFailure,
      onPage: (list) => {
        if (options.onPage === undefined) return;
        // Display each list page as it arrives.
        void assemble(list, false, true).then(options.onPage, () => {});
      },
    });

    await options.queue.add(crawled.ids);
    const read = await options.queue.run();

    return { corpus: await assemble(crawled.list, crawled.complete, false), crawled, read };
  }

  const exported = { DONE_STATES, expectedOf, membersOf, collect };

  globalThis.bghsa.corpus = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
