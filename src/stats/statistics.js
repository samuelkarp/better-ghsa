'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/dom.js');
  require('../common/chips.js');
  require('../common/cache.js');
  require('../common/crawl.js');
  require('../common/parse-list.js');
  require('../list/table.js');
  require('../done/corpus.js');
  require('../done/stats.js');
  require('../done/csv.js');
  require('../done/view.js');
}

/**
 * Group the corpus into open and completed advisories with crawl progress.
 *
 * @typedef {object} Half
 * @property {string} key
 * @property {string} name The displayed group name.
 * @property {readonly string[]} states The query states included in the group.
 * @property {import('../done/corpus.js').Corpus} corpus
 * @property {boolean} walked Whether a selected state crawl has started. Otherwise this
 *   group contains only visible-page data.
 */

/**
 * @typedef {object} Held
 * @property {{ owner: string, repo: string } | null} ref The repository for both groups, or
 *   null before a successful read.
 * @property {Half[]} halves
 */

(() => {

  const ROOT_ID = 'bghsa-stats';

  const STYLE_ID = 'bghsa-stats-style';

  const MODE = 'statistics';

  const SHOW_STATS = 'Show statistics';

  const SHOW_OPEN = globalThis.bghsa.view.SHOW_OPEN;

  const EXPORT_LABEL = 'Export CSV';

  const EMPTY_TEXT = 'Nothing has been read on this repository';

  const NOTHING_TEXT = 'Nothing counted';

  const READING_TEXT = 'Reading';

  /**
   * Statistics combine open and completed advisories already collected by the
   * list and done views (REQUIREMENTS.md section 10).
   *
   * @type {readonly { key: string, name: string, states: readonly string[] }[]}
   */
  const HALVES = [
    { key: 'open', name: 'Open', states: globalThis.bghsa.parseList.OPEN_STATES },
    { key: 'done', name: 'Done', states: globalThis.bghsa.corpus.DONE_STATES },
  ];

  /**
   * Sort months chronologically and other tallies by frequency.
   * For closure reasons, missing values count as outcomes in the denominator.
   * Other tallies compute shares among supplied values.
   *
   * @type {readonly {
   *   key: string,
   *   name: string,
   *   by: 'count' | 'value',
   *   missingCounts?: boolean,
   * }[]}
   */
  const COUNT_GROUPS = [
    { key: 'reason', name: 'Closure reason', by: 'count', missingCounts: true },
    { key: 'state', name: 'State', by: 'count' },
    { key: 'severity', name: 'Severity', by: 'count' },
    { key: 'month', name: 'Month', by: 'value' },
  ];

  /**
   * @type {readonly { key: 'min' | 'median' | 'mean' | 'max', name: string }[]}
   */
  const SPREAD = [
    { key: 'min', name: 'Min' },
    { key: 'median', name: 'Median' },
    { key: 'mean', name: 'Mean' },
    { key: 'max', name: 'Max' },
  ];

  /**
   * Use width-based columns to pack variable-height lists while keeping each
   * list together.
   */
  const STYLE_TEXT = [
    '.bghsa-stats-over { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    '.bghsa-stats-lists { columns: 20rem; column-gap: 16px; }',
    '.bghsa-stats-list { break-inside: avoid; }',
    '.bghsa-stats-title { gap: 0 8px; }',
    '.bghsa-stats-line { display: flex; align-items: baseline; gap: 4px 12px; }',
    '.bghsa-stats-value { flex: 1 1 auto; }',
    // Use the page text color as the fallback in both themes.
    '.bghsa-stats-count { color: var(--fgColor-muted, currentColor);' +
      ' white-space: nowrap; text-align: right; }',
    '.bghsa-stats-ratio { color: var(--fgColor-muted, currentColor); white-space: nowrap;' +
      ' text-align: right; flex: 0 0 3rem; }',
    '.bghsa-stats-meta { color: var(--fgColor-muted, currentColor); }',
    '.bghsa-stats-empty { color: var(--fgColor-muted, currentColor); }',
    '.bghsa-stats-uncomputed { color: var(--fgColor-muted, currentColor); }',
  ].join('\n');

  /** What the view holds for each document. @type {WeakMap<Document, Held>} */
  const held = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {Held}
   */
  function stateOf(doc) {
    const found = held.get(doc);
    if (found !== undefined) return found;
    /** @type {Held} */
    const fresh = { ref: null, halves: [] };
    held.set(doc, fresh);
    return fresh;
  }

  /**
   * Discard data from the previous repository after GitHub replaces the frame
   * within the same document.
   *
   * @param {Document} doc
   * @returns {Held}
   */
  function current(doc) {
    const state = stateOf(doc);
    if (state.ref === null) return state;
    const table = globalThis.bghsa.table;
    const here = refOf(doc);
    if (here !== null && table.refKey(here) === table.refKey(state.ref)) return state;
    /** @type {Held} */
    const fresh = { ref: null, halves: [] };
    held.set(doc, fresh);
    return fresh;
  }

  const refOf = globalThis.bghsa.table.refOf;

  const element = globalThis.bghsa.dom.element;

  /**
   * @param {string} key
   * @returns {string} A display label derived from a camel-cased key.
   */
  function nameOf(key) {
    const words = key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    return globalThis.bghsa.chips.sentenceCase(words);
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  const MINUTE_MS = 60 * 1000;

  /**
   * @param {number | null} ms
   * @returns {string} The duration in its two largest units, or a dash if unavailable.
   */
  function formatDuration(ms) {
    if (ms === null || !Number.isFinite(ms)) return '—';
    if (ms >= DAY_MS) {
      return `${Math.floor(ms / DAY_MS)}d ${Math.floor((ms % DAY_MS) / HOUR_MS)}h`;
    }
    if (ms >= HOUR_MS) {
      return `${Math.floor(ms / HOUR_MS)}h ${Math.floor((ms % HOUR_MS) / MINUTE_MS)}m`;
    }
    if (ms >= MINUTE_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
    return `${Math.round(ms / 1000)}s`;
  }

  /**
   * @param {number} ratio
   * @returns {string}
   */
  function formatRatio(ratio) {
    return `${Math.round(ratio * 100)}%`;
  }

  /**
   * @param {number} count
   * @returns {string} The sample size.
   */
  function totalTextOf(count) {
    return `${count} total ${count === 1 ? 'advisory' : 'advisories'}`;
  }

  /**
   * Combine cached crawls and detail reads with rows from the visible list page.
   * An uncrawled repository can still contribute its visible rows.
   *
   * @param {Document} doc
   * @returns {Promise<Held>} The corpus groups, with a null repository outside advisory
   *   lists.
   */
  async function read(doc) {
    const crawl = globalThis.bghsa.crawl;
    const parsed = globalThis.bghsa.table.pageOf(doc);
    if (parsed === null || parsed.owner === null || parsed.repo === null) {
      return { ref: null, halves: [] };
    }
    const ref = { owner: parsed.owner, repo: parsed.repo };
    const at = globalThis.bghsa.cache.now();
    const entry = await globalThis.bghsa.cache.getList(ref, { at });
    const list = crawl.listFrom(entry === null ? null : entry.record);
    // Omit a page number to add visible rows without marking a crawl as started.
    crawl.seed(list, parsed, {
      ref,
      at,
      page: null,
      states: Object.keys(globalThis.bghsa.parseList.STATES),
    });

    /** @type {Half[]} */
    const halves = [];
    for (const half of HALVES) {
      halves.push({
        key: half.key,
        name: half.name,
        states: half.states,
        corpus: await globalThis.bghsa.corpus.membersOf(ref, list, {
          states: half.states,
          at,
          expected: globalThis.bghsa.corpus.expectedOf(parsed, half.states),
          complete: half.states.every((state) => crawl.walkOf(list, state).complete),
        }),
        walked: half.states.some((state) => crawl.walkOf(list, state).started),
      });
    }
    return { ref, halves };
  }

  /**
   * @param {readonly Half[]} halves
   * @returns {import('../done/corpus.js').Corpus}
   */
  function whole(halves) {
    /** @type {Record<string, number | null>} */
    const expected = {};
    for (const half of halves) Object.assign(expected, half.corpus.expected);
    return {
      members: halves.flatMap((half) => half.corpus.members),
      unread: halves.flatMap((half) => half.corpus.unread),
      complete: halves.every((half) => half.corpus.complete),
      running: halves.some((half) => half.corpus.running),
      expected,
    };
  }

  /**
   * @param {Record<string, number | null>} expected
   * @returns {number | null} The sum of state-tab counts, or null if any count is unknown.
   */
  function expectedTotal(expected) {
    let total = 0;
    for (const count of Object.values(expected)) {
      if (count === null || count === undefined) return null;
      total += count;
    }
    return total;
  }

  /**
   * @param {Document} doc
   * @returns {boolean} Whether either corpus group is being collected.
   */
  function reading(doc) {
    if (globalThis.bghsa.table.progressOf(doc) !== null) return true;
    return globalThis.bghsa.view.current(doc).reading;
  }

  /**
   * Show coverage for each corpus group before displaying statistics. An
   * uncrawled group covers the visible page; an unfinished crawl covers only
   * part of the repository.
   *
   * @param {Document} doc
   * @param {readonly Half[]} halves
   * @returns {Element}
   */
  function buildOver(doc, halves) {

    const chips = globalThis.bghsa.chips;
    const box = element(doc, 'div', 'Box-body bghsa-stats-over');
    const corpus = whole(halves);
    box.append(chips.buildChip(doc, { text: totalTextOf(corpus.members.length) }));
    for (const half of halves) {
      const size = half.corpus.members.length;
      const node = chips.buildChip(doc, { text: `${size} ${half.name.toLowerCase()}` });
      node.setAttribute('data-bghsa-half', half.key);
      box.append(node);
      if (half.corpus.complete) continue;
      const walked = half.walked ? 'partly crawled' : 'not crawled';
      box.append(chips.buildChip(doc, { text: `${half.name} ${walked}` }));
    }
    if (corpus.unread.length > 0) {
      box.append(chips.buildChip(doc, { text: `${corpus.unread.length} unread` }));
    }
    const total = expectedTotal(corpus.expected);
    if (total !== null && total !== corpus.members.length) {
      box.append(chips.buildChip(doc, { text: `${total} on GitHub` }));
    }
    if (reading(doc)) box.append(chips.buildChip(doc, { text: READING_TEXT }));
    return box;
  }

  /**
   * @param {Document} doc
   * @param {string} value
   * @param {string} count
   * @param {string} ratio
   * @returns {Element}
   */
  function buildLine(doc, value, count, ratio) {
    const line = element(doc, 'li', 'Box-row bghsa-stats-line');
    line.append(element(doc, 'span', 'bghsa-stats-value', value));
    line.append(element(doc, 'span', 'bghsa-stats-count', count));
    line.append(element(doc, 'span', 'bghsa-stats-ratio', ratio));
    return line;
  }

  /**
   * @param {Document} doc
   * @param {string} name
   * @param {string} meta
   * @returns {Element}
   */
  function buildHeader(doc, name, meta) {
    const header = element(doc, 'div', 'Box-header d-flex flex-items-baseline bghsa-stats-title');
    header.append(element(doc, 'strong', 'flex-auto', name));
    header.append(element(doc, 'span', 'text-small bghsa-stats-meta', meta));
    return header;
  }

  /**
   * @param {Document} doc
   * @param {{ key: string, name: string, by: 'count' | 'value', missingCounts?: boolean }} group
   * @param {import('../done/stats.js').Tally} tally
   * @returns {Element}
   */
  function buildTally(doc, group, tally) {
    const box = element(doc, 'div', 'Box mb-3 bghsa-stats-list');
    box.setAttribute('data-bghsa-count', group.key);
    // Include missing values in the denominator only when the group counts
    // them as outcomes.
    const over = group.missingCounts === true ? tally.counted + tally.missing : tally.counted;
    box.append(buildHeader(doc, group.name, `${over} of ${tally.corpus}`));

    const list = element(doc, 'ul', 'bghsa-stats-rows');
    const entries = Object.entries(tally.counts).sort((left, right) =>
      group.by === 'value'
        ? left[0].localeCompare(right[0])
        : right[1] - left[1] || left[0].localeCompare(right[0])
    );
    for (const [value, count] of entries) {
      list.append(
        buildLine(
          doc,
          globalThis.bghsa.chips.sentenceCase(value),
          String(count),
          formatRatio(count / over)
        )
      );
    }
    if (tally.missing > 0) {
      // Display missing values alongside the sample size.
      const line = buildLine(
        doc,
        'None',
        String(tally.missing),
        group.missingCounts === true ? formatRatio(tally.missing / over) : '—'
      );
      line.classList.add('bghsa-stats-missing');
      list.append(line);
    }
    if (entries.length === 0 && tally.missing === 0) {
      list.append(element(doc, 'li', 'Box-row bghsa-stats-empty', NOTHING_TEXT));
    }
    box.append(list);
    return box;
  }

  /**
   * @param {Document} doc
   * @param {{ key: string, name: string, omission: string }} timing
   * @param {import('../done/stats.js').Timing} found
   * @returns {Element}
   */
  function buildTiming(doc, timing, found) {
    const box = element(doc, 'div', 'Box mb-3 bghsa-stats-list');
    box.setAttribute('data-bghsa-timing', timing.key);
    box.append(buildHeader(doc, timing.name, `${found.counted} of ${found.corpus}`));
    const list = element(doc, 'ul', 'bghsa-stats-rows');
    for (const each of SPREAD) {
      list.append(buildLine(doc, each.name, formatDuration(found[each.key]), ''));
    }
    if (found.omitted > 0) {
      // Show the number of omitted durations and the event required to measure them.
      const line = buildLine(doc, timing.omission, String(found.omitted), '');
      line.classList.add('bghsa-stats-omitted');
      list.append(line);
    }
    box.append(list);
    return box;
  }

  /**
   * Display statistics over both corpus groups and reasons for unavailable
   * metrics (REQUIREMENTS.md section 10).
   *
   * @param {Document} doc
   * @param {readonly Half[]} halves
   * @returns {Element[]}
   */
  function buildStats(doc, halves) {
    const summary = globalThis.bghsa.stats.summarize(whole(halves));
    /** @type {Element[]} */
    const parts = [];

    const counts = element(doc, 'div', 'bghsa-stats-lists bghsa-stats-counts');
    for (const group of COUNT_GROUPS) {
      const tally = summary.counts[group.key];
      if (tally === undefined) continue;
      counts.append(buildTally(doc, group, tally));
    }
    parts.push(counts);

    const timings = element(doc, 'div', 'bghsa-stats-lists bghsa-stats-timings');
    for (const timing of globalThis.bghsa.stats.TIMINGS) {
      const found = summary.timings[timing.key];
      if (found === undefined) continue;
      timings.append(buildTiming(doc, timing, found));
    }
    parts.push(timings);

    for (const [key, why] of Object.entries(summary.uncomputed)) {
      const line = element(doc, 'div', 'mb-3 text-small bghsa-stats-uncomputed');
      line.setAttribute('data-bghsa-uncomputed', key);
      line.append(element(doc, 'span', 'text-bold', `${nameOf(key)}: `));
      line.append(element(doc, 'span', '', why));
      parts.push(line);
    }
    return parts;
  }

  /**
   * @param {Document} doc
   * @returns {Element}
   */
  function buildView(doc) {
    const state = current(doc);
    const root = element(doc, 'div', 'bghsa-stats-root');
    root.id = ROOT_ID;
    root.setAttribute('data-bghsa-stats', '1');

    const box = element(doc, 'div', 'Box mb-3 bghsa-stats-head');
    const header = element(
      doc,
      'div',
      'Box-header d-flex flex-items-center flex-justify-between bghsa-stats-header'
    );
    header.append(element(doc, 'strong', '', 'Statistics'));
    const exportControl = element(doc, 'button', 'btn btn-sm bghsa-stats-export', EXPORT_LABEL);
    exportControl.setAttribute('type', 'button');
    const corpus = whole(state.halves);
    if (state.ref === null || corpus.members.length === 0) {
      exportControl.setAttribute('disabled', '');
    }
    exportControl.addEventListener('click', () => {
      exportCsv(doc);
    });
    header.append(exportControl);
    box.append(header);

    if (state.ref === null || corpus.members.length === 0) {
      box.append(element(doc, 'div', 'Box-body bghsa-stats-empty', EMPTY_TEXT));
      root.append(box);
      return root;
    }

    box.append(buildOver(doc, state.halves));
    root.append(box);
    for (const part of buildStats(doc, state.halves)) root.append(part);
    return root;
  }

  /**
   * Download a CSV generated locally from the collected corpus.
   *
   * @param {Document} doc
   * @param {import('../done/csv.js').DownloadOptions} [options]
   * @returns {string | null} The download URL, or null if export is unavailable.
   */
  function exportCsv(doc, options) {
    const state = current(doc);
    if (state.ref === null) return null;
    const corpus = whole(state.halves);
    if (corpus.members.length === 0) return null;
    const csv = globalThis.bghsa.csv;
    const at = globalThis.bghsa.cache.now();
    return csv.download(doc, csv.filenameFor(state.ref, at), csv.toCsv(corpus), options);
  }

  const setHidden = globalThis.bghsa.table.setHidden;

  /**
   * @param {Document} doc
   * @returns {void}
   */
  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID) !== null) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    (doc.head ?? doc.documentElement ?? doc.body)?.append(style);
  }

  /**
   * @param {Document} doc
   * @returns {Element | null} The view, or null if the list surface is absent.
   */
  function draw(doc) {
    const table = globalThis.bghsa.table;
    const surface = doc.getElementById(table.ROOT_ID);
    if (surface === null) return null;
    const root = buildView(doc);
    const existing = doc.getElementById(ROOT_ID);
    if (existing !== null) existing.replaceWith(root);
    else surface.append(root);
    ensureStyle(doc);
    setHidden(root, table.viewMode(doc) !== MODE);
    return root;
  }

  /**
   * @param {Document} doc
   * @returns {Promise<Element | null>}
   */
  async function load(doc) {
    const found = await read(doc);
    // Ignore results for a repository the document has left.
    const table = globalThis.bghsa.table;
    const here = refOf(doc);
    if (found.ref !== null && (here === null || table.refKey(here) !== table.refKey(found.ref))) {
      return draw(doc);
    }
    held.set(doc, found);
    return draw(doc);
  }

  /**
   * @param {Document} doc
   * @returns {Element}
   */
  function buildToggle(doc) {
    const node = element(doc, 'button', 'btn btn-sm bghsa-stats-toggle', SHOW_STATS);
    node.setAttribute('type', 'button');
    node.addEventListener('click', () => {
      toggle(doc);
    });
    return node;
  }

  /**
   * The list surface owns view selection to keep only one view visible.
   *
   * @param {Document} doc
   * @returns {void}
   */
  function toggle(doc) {
    const table = globalThis.bghsa.table;
    const wanted = table.viewMode(doc) === MODE ? table.VIEW_TABLE : MODE;
    table.setViewMode(doc, wanted);
    table.applyVisibility(doc);
  }

  /**
   * Hide extension toggles in GitHub's native view. Refresh visible statistics
   * from the other views' latest crawl data.
   *
   * @param {Document} doc
   * @param {string} mode
   * @returns {void}
   */
  function show(doc, mode) {
    const table = globalThis.bghsa.table;
    const root = draw(doc);
    const toggleNode = doc.querySelector(`#${table.ROOT_ID} .bghsa-stats-toggle`);
    if (toggleNode !== null) {
      toggleNode.textContent = mode === MODE ? SHOW_OPEN : SHOW_STATS;
      setHidden(toggleNode, mode === table.VIEW_NATIVE);
    }
    if (root !== null) setHidden(root, mode !== MODE);
    if (mode === MODE) void load(doc);
  }

  const exported = {
    ROOT_ID,
    STYLE_ID,
    MODE,
    SHOW_STATS,
    SHOW_OPEN,
    EMPTY_TEXT,
    READING_TEXT,
    STYLE_TEXT,
    stateOf,
    current,
    totalTextOf,
    read,
    reading,
    exportCsv,
    ensureStyle,
    draw,
    load,
    show,
  };

  globalThis.bghsa.statistics = exported;

  globalThis.bghsa.table.addSurface({ control: buildToggle, show });

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
