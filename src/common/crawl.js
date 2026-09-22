'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./schema.js');
  require('./cache.js');
  require('./parse-list.js');
}

/**
 * @typedef {object} CrawledRow
 * @property {import('./parse-list.js').ListRow} row
 * @property {string} state The `?state=` this advisory was found under.
 * @property {number} seenAt When it was last seen there, epoch milliseconds.
 */

/**
 * Persist pagination progress to resume after navigation.
 *
 * @typedef {object} StateWalk
 * @property {string | null} next The next page URL, or null at the end.
 * @property {boolean} started
 * @property {boolean} complete Whether the walk reached the last page.
 * @property {number} startedAt When this walk began, epoch milliseconds.
 * @property {number} completedAt The completion time, or zero while incomplete.
 * @property {number} pages How many pages it has read.
 * @property {number} failures How many times in a row reading {@link next}
 *   failed. A successful read resets it to zero.
 * @property {boolean} stalled Whether repeated failures abandoned this walk.
 *   It remains incomplete and restarts from page one when due.
 * @property {number} abandonedAt The abandonment time, or zero if active.
 */

/**
 * The list cache stores observed rows and pagination progress by state.
 *
 * @typedef {object} CrawledList
 * @property {Record<string, StateWalk>} walks By `?state=` value.
 * @property {Record<string, CrawledRow>} rows By GHSA identifier.
 */

/**
 * @typedef {object} CrawlResult
 * @property {CrawledList} list The updated crawl record.
 * @property {string[]} ids The advisories in the states this crawl covers.
 * @property {number} fetched Pages read over the network.
 * @property {number} failed Pages this pass could not read.
 * @property {boolean} complete Whether every state's walk has reached its last
 *   page.
 */

/**
 * @typedef {object} CrawlOptions
 * @property {{ owner: string, repo: string }} ref The repository being crawled.
 * @property {{ page: (url: string) => Promise<import('./fetch.js').PageRead> }} queue
 *   Shares request scheduling with advisory detail reads.
 * @property {import('./parse-list.js').ParsedList | null} [parsed] The visible
 *   list page. Its rows are available without a request.
 * @property {string} [href] The visible page's URL.
 * @property {import('./cache.js').CacheStorage | null} [storage]
 * @property {() => number} [now]
 * @property {readonly string[]} [states] The states to walk. Defaults to triage and draft.
 * @property {(html: string) => import('./parse-list.js').ParsedList | null} [parse]
 * @property {(list: CrawledList) => void} [onPage] Called after fetched or
 *   visible rows are added.
 * @property {(state: string, url: string, reason: unknown) => void} [onFailure]
 */

(() => {
  /**
   * After repeated failures, abandon the stored page and restart from page one
   * when the state is due for refresh. An abandoned walk stays incomplete and
   * preserves existing rows.
   */
  const MAX_FAILURES = 3;

  /**
   * @param {unknown} value
   * @returns {string | null} The nonempty string, or null for other values.
   */
  function textOf(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  /**
   * @param {unknown} value
   * @returns {number} The finite number, or zero for other values.
   */
  function timeOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  /**
   * @param {unknown} value
   * @returns {string | null} The normalized state, or null if unrecognized.
   */
  function stateKeyOf(value) {
    const wanted = String(value ?? '').trim().toLowerCase();
    return Object.hasOwn(globalThis.bghsa.parseList.STATES, wanted) ? wanted : null;
  }

  /**
   * @param {{ owner: string, repo: string }} ref
   * @param {string} state
   * @returns {string} the first page of one state's advisory list.
   */
  function listUrl(ref, state) {
    const owner = encodeURIComponent(ref.owner);
    const repo = encodeURIComponent(ref.repo);
    return `/${owner}/${repo}/security/advisories?state=${encodeURIComponent(state)}`;
  }

  /**
   * Follow pagination only within this repository's advisory list.
   *
   * @param {unknown} href
   * @param {{ owner: string, repo: string }} ref
   * @returns {string | null}
   */
  function advisoriesPath(href, ref) {
    let path = String(href ?? '').trim();
    if (path === '') return null;
    const origin = 'https://github.com';
    if (path.toLowerCase().startsWith(origin)) path = path.slice(origin.length);
    if (!path.startsWith('/')) return null;
    const withoutFragment = /** @type {string} */ (path.split('#')[0] ?? '');
    const base = /** @type {string} */ (withoutFragment.split('?')[0] ?? '');
    const wanted = `/${ref.owner}/${ref.repo}/security/advisories`;
    return base.toLowerCase() === wanted.toLowerCase() ? withoutFragment : null;
  }

  /**
   * @param {string | undefined} href The URL of the page being looked at.
   * @returns {number | null} The page number, or null for an absent URL or invalid
   *   page parameter. An omitted page parameter means page one.
   */
  function pageOf(href) {
    if (href === undefined) return null;
    const query = /** @type {string} */ (href.split('#')[0]?.split('?')[1] ?? '');
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=');
      if ((eq === -1 ? pair : pair.slice(0, eq)) !== 'page') continue;
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      return /^\d+$/.test(value) ? Number(value) : null;
    }
    return 1;
  }

  /**
   * @param {unknown} value
   * @returns {import('./parse-list.js').ListRow | null} The validated cached row.
   */
  function rowFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    const ghsaId = textOf(value.ghsaId);
    if (ghsaId === null) return null;
    return {
      ghsaId,
      owner: textOf(value.owner),
      repo: textOf(value.repo),
      href: textOf(value.href),
      title: textOf(value.title),
      state: textOf(value.state),
      severity: textOf(value.severity),
      severityLabel: textOf(value.severityLabel),
      severityClass: textOf(value.severityClass),
      openedAt: textOf(value.openedAt),
      reporter: textOf(value.reporter),
    };
  }

  /**
   * @param {unknown} value
   * @returns {StateWalk | null}
   */
  function walkFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    return {
      next: textOf(value.next),
      started: value.started === true,
      complete: value.complete === true,
      startedAt: timeOf(value.startedAt),
      completedAt: timeOf(value.completedAt),
      pages: Math.max(0, Math.trunc(timeOf(value.pages))),
      failures: Math.max(0, Math.trunc(timeOf(value.failures))),
      stalled: value.stalled === true,
      abandonedAt: timeOf(value.abandonedAt),
    };
  }

  /**
   * @param {unknown} value The cached list record.
   * @returns {CrawledList} The validated crawl record, or an empty crawl if invalid.
   */
  function listFrom(value) {
    /** @type {CrawledList} */
    const list = { walks: {}, rows: {} };
    if (!globalThis.bghsa.schema.isPlainObject(value)) return list;
    if (globalThis.bghsa.schema.isPlainObject(value.walks)) {
      for (const [state, held] of Object.entries(value.walks)) {
        const key = stateKeyOf(state);
        const walk = walkFrom(held);
        if (key !== null && walk !== null) list.walks[key] = walk;
      }
    }
    if (globalThis.bghsa.schema.isPlainObject(value.rows)) {
      for (const held of Object.values(value.rows)) {
        if (!globalThis.bghsa.schema.isPlainObject(held)) continue;
        const row = rowFrom(held.row);
        const state = stateKeyOf(held.state);
        if (row === null || state === null || row.ghsaId === null) continue;
        list.rows[row.ghsaId] = { row, state, seenAt: timeOf(held.seenAt) };
      }
    }
    return list;
  }

  /**
   * @param {CrawledList} list
   * @param {string} state
   * @returns {StateWalk} The stored walk, or a new unstarted walk if absent.
   */
  function walkOf(list, state) {
    return (
      list.walks[state] ?? {
        next: null,
        started: false,
        complete: false,
        startedAt: 0,
        completedAt: 0,
        pages: 0,
        failures: 0,
        stalled: false,
        abandonedAt: 0,
      }
    );
  }

  /**
   * Associate rows with the requested state, independently of their chip text.
   *
   * @param {CrawledList} list
   * @param {readonly import('./parse-list.js').ListRow[]} rows
   * @param {string} state
   * @param {number} at
   * @returns {void}
   */
  function absorb(list, rows, state, at) {
    for (const row of rows) {
      if (row.ghsaId === null) continue;
      list.rows[row.ghsaId] = { row, state, seenAt: at };
    }
  }

  /**
   * After a complete walk, remove rows not seen since it began. Partial walks
   * preserve previously observed rows.
   *
   * @param {CrawledList} list
   * @param {string} state
   * @param {number} startedAt When the walk that just finished began.
   * @returns {void}
   */
  function prune(list, state, startedAt) {
    for (const [ghsaId, held] of Object.entries(list.rows)) {
      if (held.state === state && held.seenAt < startedAt) delete list.rows[ghsaId];
    }
  }

  /**
   * @param {CrawledList} list
   * @param {readonly string[]} states
   * @returns {import('./parse-list.js').ListRow[]} The cached rows in the requested states.
   */
  function rowsIn(list, states) {
    /** @type {import('./parse-list.js').ListRow[]} */
    const rows = [];
    for (const held of Object.values(list.rows)) {
      if (states.includes(held.state)) rows.push(held.row);
    }
    return rows;
  }

  /**
   * @param {CrawledList} list
   * @param {readonly string[]} states
   * @returns {string[]} the identifiers of those advisories.
   */
  function idsIn(list, states) {
    /** @type {string[]} */
    const ids = [];
    for (const row of rowsIn(list, states)) {
      if (row.ghsaId !== null && !ids.includes(row.ghsaId)) ids.push(row.ghsaId);
    }
    return ids;
  }

  /**
   * Use the state's cache refresh threshold for completed or abandoned walks.
   *
   * @param {CrawledList} list
   * @param {string} state
   * @param {number} at
   * @returns {boolean} Whether to start or resume the walk. Unstarted and
   *   interrupted walks are immediately due.
   */
  function isDue(list, state, at) {
    const threshold = globalThis.bghsa.cache.staleAfter(state);
    // Abandoned walks wait for the refresh threshold before restarting.
    const walk = walkOf(list, state);
    if (walk.stalled) return at - walk.abandonedAt >= threshold;
    if (!walk.started) return true;
    if (!walk.complete) return true;
    return at - walk.completedAt >= threshold;
  }

  /**
   * @param {CrawledList} list
   * @param {string} state
   * @param {number} at
   * @returns {boolean} Whether the failure limit was reached.
   */
  function noteFailure(list, state, at) {
    const walk = walkOf(list, state);
    const failures = walk.failures + 1;
    const stalled = failures >= MAX_FAILURES;
    list.walks[state] = {
      ...walk,
      next: stalled ? null : walk.next,
      failures,
      stalled,
      abandonedAt: stalled ? at : walk.abandonedAt,
    };
    return stalled;
  }

  /**
   * @param {CrawledList} list
   * @param {string} state
   * @returns {boolean} Whether the walk has started and is neither complete nor stalled.
   */
  function inProgress(list, state) {
    const walk = walkOf(list, state);
    return walk.started && !walk.complete && !walk.stalled;
  }

  /**
   * Use the visible page's rows immediately. Start a due walk from a visible
   * first page, but preserve the position of any walk already in progress.
   *
   * @param {CrawledList} list
   * @param {import('./parse-list.js').ParsedList} parsed
   * @param {{ ref: { owner: string, repo: string }, at: number, page: number | null, states: readonly string[] }} where
   * @returns {void}
   */
  function seed(list, parsed, where) {
    const selected = parsed.selectedState === null ? null : stateKeyOf(parsed.selectedState);
    const at = where.at;

    if (
      selected !== null &&
      where.states.includes(selected) &&
      where.page === 1 &&
      !inProgress(list, selected) &&
      isDue(list, selected, at)
    ) {
      const next = advisoriesPath(parsed.next?.href, where.ref);
      list.walks[selected] = {
        next,
        started: true,
        complete: next === null,
        startedAt: at,
        completedAt: next === null ? at : 0,
        pages: 1,
        failures: 0,
        stalled: false,
        abandonedAt: 0,
      };
    }

    for (const row of parsed.rows) {
      if (row.ghsaId === null) continue;
      const state = stateKeyOf(row.state) ?? selected;
      if (state === null || !where.states.includes(state)) continue;
      list.rows[row.ghsaId] = { row, state, seenAt: at };
    }

    if (selected === null) return;
    const walk = list.walks[selected];
    if (walk !== undefined && walk.complete && walk.completedAt === at) {
      prune(list, selected, walk.startedAt);
    }
  }

  /**
   * Walk the requested states, defaulting to triage and draft. Persist rows
   * and pagination progress after each page for display and resumption after
   * navigation.
   *
   * @param {CrawlOptions} options
   * @returns {Promise<CrawlResult>}
   */
  async function crawl(options) {
    const ref = { owner: String(options.ref.owner), repo: String(options.ref.repo) };
    const storage = options.storage ?? null;
    const clock = options.now ?? (() => globalThis.bghsa.cache.now());
    const states = options.states ?? globalThis.bghsa.parseList.OPEN_STATES;
    const parse =
      options.parse ??
      ((html) =>
        globalThis.bghsa.parseList.parseList(new DOMParser().parseFromString(html, 'text/html')));

    /**
     * @returns {Promise<void>} Persists the crawl for resumption after navigation.
     */
    async function persist() {
      await globalThis.bghsa.cache.putList(ref, list, { storage, at: clock() });
    }

    /** @returns {void} Notifies the caller of updated rows. */
    function report() {
      if (options.onPage === undefined) return;
      try {
        options.onPage(list);
      } catch {
        // Continue crawling after a listener failure.
      }
    }

    /**
     * @param {string} state
     * @param {string} url
     * @param {unknown} reason
     * @returns {void}
     */
    function fail(state, url, reason) {
      if (options.onFailure === undefined) return;
      try {
        options.onFailure(state, url, reason);
      } catch {
        // Continue crawling after a listener failure.
      }
    }

    const held = await globalThis.bghsa.cache.getList(ref, { storage, at: clock() });
    const list = listFrom(held === null ? null : held.record);

    if (options.parsed !== undefined && options.parsed !== null) {
      seed(list, options.parsed, {
        ref,
        at: clock(),
        page: pageOf(options.href),
        states,
      });
      await persist();
      report();
    }

    let fetched = 0;
    let failed = 0;
    let stopped = false;

    for (const state of states) {
      if (stopped) break;
      if (!isDue(list, state, clock())) continue;
      const held = walkOf(list, state);
      if (!held.started || held.complete || held.stalled) {
        list.walks[state] = {
          next: listUrl(ref, state),
          started: true,
          complete: false,
          startedAt: clock(),
          completedAt: 0,
          pages: 0,
          failures: 0,
          stalled: false,
          abandonedAt: 0,
        };
        await persist();
      }

      // Detect pagination cycles while allowing any number of distinct pages.
      /** @type {Set<string>} */
      const seen = new Set();

      for (;;) {
        const walk = walkOf(list, state);
        const url = walk.next;
        if (walk.complete || url === null) break;
        if (seen.has(url)) break;
        seen.add(url);

        const answer = await options.queue.page(url);
        if (answer.stopped) {
          // A stopped queue made no request. Preserve the page without counting
          // a failure.
          stopped = true;
          break;
        }
        if (answer.body === null) {
          // Retry this page on the next load unless it reaches MAX_FAILURES.
          failed += 1;
          noteFailure(list, state, clock());
          await persist();
          fail(state, url, answer.reason);
          break;
        }
        fetched += 1;

        const page = parse(answer.body);
        if (page === null) {
          failed += 1;
          noteFailure(list, state, clock());
          await persist();
          fail(state, url, 'The page did not read as an advisory list.');
          break;
        }

        const at = clock();
        absorb(list, page.rows, state, at);
        const next = advisoriesPath(page.next?.href, ref);
        const pages = walk.pages + 1;
        const complete = next === null;
        list.walks[state] = {
          next,
          started: true,
          complete,
          startedAt: walk.startedAt,
          completedAt: complete ? at : 0,
          pages,
          failures: 0,
          stalled: false,
          abandonedAt: 0,
        };
        if (next === null) prune(list, state, walk.startedAt);
        await persist();
        report();
        if (complete) break;
      }
    }

    return {
      list,
      ids: idsIn(list, states),
      fetched,
      failed,
      complete: states.every((state) => walkOf(list, state).complete),
    };
  }

  const exported = {
    stateKeyOf,
    advisoriesPath,
    pageOf,
    listFrom,
    walkOf,
    isDue,
    seed,
    crawl,
  };

  globalThis.bghsa.crawl = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
