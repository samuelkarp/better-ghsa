'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/dom.js');
  require('../common/order.js');
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
 * @property {import('../done/stats.js').Summary | null} summary Statistics over both groups,
 *   or null before a successful read.
 */

(() => {

  const ROOT_ID = 'bghsa-stats';

  const STYLE_ID = 'bghsa-stats-style';

  const MODE = 'statistics';

  const SHOW_STATS = 'Show statistics';

  const SHOW_OPEN = globalThis.bghsa.view.SHOW_OPEN;

  const EXPORT_LABEL = 'Export CSV';

  const EXPORT_JSON_LABEL = 'Export statistics to JSON';

  const JSON_TYPE = 'application/json;charset=utf-8';

  const EMPTY_TEXT = 'Nothing has been read on this repository';

  const NOTHING_TEXT = 'Nothing counted';

  const READING_TEXT = globalThis.bghsa.view.LOADING_TEXT;

  const UNREAD_TEXT = 'Not loaded yet';

  /**
   * Statistics combine open and completed advisories already collected by the
   * list and done views (REQUIREMENTS.md section 10).
   *
   * @type {readonly { key: string, name: string, states: readonly string[] }[]}
   */
  const HALVES = [
    { key: 'open', name: 'Open', states: globalThis.bghsa.parseList.OPEN_STATES },
    { key: 'done', name: 'Completed', states: globalThis.bghsa.corpus.DONE_STATES },
  ];

  /**
   * Sort severities by level and other tallies by frequency.
   * For closure reasons, missing values count as outcomes in the denominator.
   * Other tallies compute shares among supplied values. A group with
   * `unreadCounts` has unread members outside its tally, shown in their own
   * row and in the header total. A group with `missingOpens` labels its None
   * row with a control that opens the completed view on those advisories.
   *
   * @typedef {{
   *   key: string,
   *   name: string,
   *   by: 'count' | 'level',
   *   missingCounts?: boolean,
   *   unreadCounts?: boolean,
   *   missingOpens?: boolean,
   *   field: string,
   * }} CountGroup
   */

  /**
   * `field` names the group in the exported statistics.
   *
   * @type {readonly CountGroup[]}
   */
  const COUNT_GROUPS = [
    { key: 'outcome', name: 'Outcome', by: 'count', field: 'outcome' },
    {
      key: 'reason',
      field: 'closureReason',
      name: 'Closure reason',
      by: 'count',
      missingCounts: true,
      unreadCounts: true,
      missingOpens: true,
    },
    { key: 'open', name: 'Open', by: 'count', field: 'open' },
    { key: 'severity', name: 'Severity', by: 'level', unreadCounts: true, field: 'severity' },
  ];

  const MONTHS_NAME = 'Reports by month';

  const YEAR_HEADER = 'Year';

  const TOTAL_HEADER = 'Total';

  /** Column headers for January through December. */
  const MONTH_HEADERS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
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
    '.bghsa-stats-exports { display: flex; gap: 8px; }',
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
    '.bghsa-stats-scroll { overflow-x: auto; }',
    '.bghsa-stats-table { width: 100%; border-collapse: collapse;' +
      ' font-variant-numeric: tabular-nums; }',
    '.bghsa-stats-table th, .bghsa-stats-table td { padding: 8px 16px; text-align: right;' +
      ' white-space: nowrap; border-top: 1px solid var(--borderColor-muted, currentColor); }',
    '.bghsa-stats-table thead th { border-top: 0; }',
    '.bghsa-stats-table tfoot th, .bghsa-stats-table tfoot td { font-weight: 600;' +
      ' border-top: 2px solid var(--borderColor-muted, currentColor); }',
    '.bghsa-stats-table th[scope="row"], .bghsa-stats-table thead th:first-child' +
      ' { text-align: left; }',
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
    const fresh = { ref: null, halves: [], summary: null };
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
    const fresh = { ref: null, halves: [], summary: null };
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
      return { ref: null, halves: [], summary: null };
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
    // Take the instant after loading, so every figure on the page uses it.
    const summary = await globalThis.bghsa.stats.summarize(
      whole(halves),
      globalThis.bghsa.cache.now()
    );
    return { ref, halves, summary };
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
      const walked = half.walked ? 'list partly loaded' : 'list not loaded';
      box.append(chips.buildChip(doc, { text: `${half.name} ${walked}` }));
    }
    if (corpus.unread.length > 0) {
      box.append(chips.buildChip(doc, { text: `${corpus.unread.length} not loaded yet` }));
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
   * One row of a count group. `share` is null where the row shows no
   * percentage.
   *
   * @typedef {object} TallyRow
   * @property {'value' | 'missing' | 'unread'} kind
   * @property {string} label
   * @property {number} count
   * @property {number | null} share
   */

  /**
   * A count group's sample size and rows, in display order.
   *
   * @param {CountGroup} group
   * @param {import('../done/stats.js').Tally} tally
   * @returns {{ counted: number, total: number, rows: TallyRow[] }}
   */
  function tallyRowsOf(group, tally) {
    // Include missing values in the denominator only when the group counts
    // them as outcomes.
    const over = group.missingCounts === true ? tally.counted + tally.missing : tally.counted;
    const unread = group.unreadCounts === true ? tally.unread : 0;
    const rank = globalThis.bghsa.order.severityRank;
    const entries = Object.entries(tally.counts).sort(
      (left, right) =>
        (group.by === 'level' ? rank(right[0]) - rank(left[0]) : 0) ||
        right[1] - left[1] ||
        left[0].localeCompare(right[0])
    );
    /** @type {TallyRow[]} */
    const rows = entries.map(([value, count]) => ({
      kind: 'value',
      label: globalThis.bghsa.chips.sentenceCase(value),
      count,
      share: count / over,
    }));
    if (tally.missing > 0) {
      // Display missing values alongside the sample size.
      rows.push({
        kind: 'missing',
        label: 'None',
        count: tally.missing,
        share: group.missingCounts === true ? tally.missing / over : null,
      });
    }
    if (unread > 0) {
      // Unread members have no percentage because their values are unknown.
      rows.push({ kind: 'unread', label: UNREAD_TEXT, count: unread, share: null });
    }
    return { counted: over, total: tally.corpus + unread, rows };
  }

  /**
   * @param {Document} doc
   * @param {CountGroup} group
   * @param {import('../done/stats.js').Tally} tally
   * @returns {Element}
   */
  function buildTally(doc, group, tally) {
    const box = element(doc, 'div', 'Box mb-3 bghsa-stats-list');
    box.setAttribute('data-bghsa-count', group.key);
    const shown = tallyRowsOf(group, tally);
    box.append(buildHeader(doc, group.name, `${shown.counted} of ${shown.total}`));

    const list = element(doc, 'ul', 'bghsa-stats-rows');
    for (const row of shown.rows) {
      const ratio = row.share === null ? '—' : formatRatio(row.share);
      const line = buildLine(doc, row.label, String(row.count), ratio);
      if (row.kind === 'missing') {
        line.classList.add('bghsa-stats-missing');
        if (group.missingOpens === true) {
          const open = element(doc, 'button', 'btn-link bghsa-stats-open', 'None');
          open.setAttribute('type', 'button');
          open.addEventListener('click', () => {
            globalThis.bghsa.view.showUnreasoned(doc);
          });
          line.querySelector('.bghsa-stats-value')?.replaceChildren(open);
        }
      }
      if (row.kind === 'unread') line.classList.add('bghsa-stats-unread');
      list.append(line);
    }
    if (shown.rows.length === 0) {
      list.append(element(doc, 'li', 'Box-row bghsa-stats-empty', NOTHING_TEXT));
    }
    box.append(list);
    return box;
  }

  /**
   * Count reports in a grid of years by months, through the later of the
   * current month and the latest report month. A footer row sums each column.
   *
   * @param {Document} doc
   * @param {import('../done/stats.js').Tally | undefined} tally The month tally.
   * @param {number} at The instant the summary is computed against.
   * @returns {Element}
   */
  function buildMonths(doc, tally, at) {
    const box = element(doc, 'div', 'Box mb-3 bghsa-stats-months');
    box.setAttribute('data-bghsa-months', '1');
    const counted = tally?.counted ?? 0;
    box.append(buildHeader(doc, MONTHS_NAME, `${counted} of ${tally?.corpus ?? 0}`));
    const rows = globalThis.bghsa.stats.yearsOf(tally?.counts ?? {}, at);
    if (rows.length === 0) {
      box.append(element(doc, 'div', 'Box-body bghsa-stats-empty', NOTHING_TEXT));
      return box;
    }
    const grid = element(doc, 'table', 'bghsa-stats-table');
    const head = element(doc, 'thead', '');
    const names = element(doc, 'tr', '');
    for (const name of [YEAR_HEADER, ...MONTH_HEADERS, TOTAL_HEADER]) {
      const cell = element(doc, 'th', '', name);
      cell.setAttribute('scope', 'col');
      names.append(cell);
    }
    head.append(names);
    grid.append(head);
    const body = element(doc, 'tbody', '');
    for (const row of rows) {
      const line = element(doc, 'tr', '');
      const year = element(doc, 'th', '', String(row.year));
      year.setAttribute('scope', 'row');
      line.append(year);
      for (const count of row.months) {
        line.append(element(doc, 'td', '', count === null ? '' : String(count)));
      }
      line.append(element(doc, 'td', 'text-bold', String(row.total)));
      body.append(line);
    }
    grid.append(body);
    const sums = globalThis.bghsa.stats.monthTotalsOf(rows);
    const foot = element(doc, 'tfoot', '');
    const line = element(doc, 'tr', '');
    const label = element(doc, 'th', '', TOTAL_HEADER);
    label.setAttribute('scope', 'row');
    line.append(label);
    for (const count of sums.months) line.append(element(doc, 'td', '', String(count)));
    line.append(element(doc, 'td', 'text-bold', String(sums.total)));
    foot.append(line);
    grid.append(foot);
    const scroll = element(doc, 'div', 'bghsa-stats-scroll');
    scroll.append(grid);
    box.append(scroll);
    return box;
  }

  /**
   * The sample size counts read advisories, and unread ones only as its
   * shortfall. The spread covers measured advisories. The omission row holds
   * the longest current wait of an advisory still waiting for the event.
   *
   * @param {Document} doc
   * @param {{ key: string, name: string, omission?: string }} timing
   * @param {import('../done/stats.js').ReadTiming} found
   * @returns {Element}
   */
  function buildTiming(doc, timing, found) {
    const box = element(doc, 'div', 'Box mb-3 bghsa-stats-list');
    box.setAttribute('data-bghsa-timing', timing.key);
    box.append(buildHeader(doc, timing.name, `${found.read} of ${found.corpus}`));
    const list = element(doc, 'ul', 'bghsa-stats-rows');
    for (const each of SPREAD) {
      list.append(buildLine(doc, each.name, formatDuration(found[each.key]), ''));
    }
    if (found.waiting !== null && timing.omission !== undefined) {
      const line = buildLine(doc, timing.omission, formatDuration(found.waiting), '');
      line.classList.add('bghsa-stats-waiting');
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
   * @param {import('../done/stats.js').Summary} summary
   * @returns {Element[]}
   */
  function buildStats(doc, summary) {
    /** @type {Element[]} */
    const parts = [];

    const counts = element(doc, 'div', 'bghsa-stats-lists bghsa-stats-counts');
    for (const group of COUNT_GROUPS) {
      const tally = summary.counts[group.key];
      if (tally === undefined) continue;
      counts.append(buildTally(doc, group, tally));
    }
    parts.push(counts);

    parts.push(buildMonths(doc, summary.counts.month, summary.at));

    const timings = element(doc, 'div', 'bghsa-stats-lists bghsa-stats-timings');
    for (const timing of globalThis.bghsa.stats.TIMINGS) {
      timings.append(buildTiming(doc, timing, summary.timings[timing.key]));
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
      void exportCsv(doc);
    });
    const jsonControl = element(
      doc,
      'button',
      'btn btn-sm bghsa-stats-export',
      EXPORT_JSON_LABEL
    );
    jsonControl.setAttribute('type', 'button');
    jsonControl.setAttribute('data-bghsa-export', 'json');
    if (state.ref === null || corpus.members.length === 0) {
      jsonControl.setAttribute('disabled', '');
    }
    jsonControl.addEventListener('click', () => {
      exportJson(doc);
    });
    const exports = element(doc, 'div', 'bghsa-stats-exports');
    exports.append(exportControl, jsonControl);
    header.append(exports);
    box.append(header);

    if (state.ref === null || state.summary === null || corpus.members.length === 0) {
      box.append(element(doc, 'div', 'Box-body bghsa-stats-empty', EMPTY_TEXT));
      root.append(box);
      return root;
    }

    box.append(buildOver(doc, state.halves));
    root.append(box);
    for (const part of buildStats(doc, state.summary)) root.append(part);
    return root;
  }

  /**
   * Download a CSV generated locally from the collected corpus.
   *
   * @param {Document} doc
   * @param {import('../done/csv.js').DownloadOptions} [options]
   * @returns {Promise<string | null>} The download URL, or null if export is unavailable.
   */
  async function exportCsv(doc, options) {
    const state = current(doc);
    if (state.ref === null) return null;
    const corpus = whole(state.halves);
    if (corpus.members.length === 0) return null;
    const csv = globalThis.bghsa.csv;
    const at = globalThis.bghsa.cache.now();
    const name = csv.filenameFor(state.ref, at);
    return csv.download(doc, name, await csv.toCsv(corpus), options);
  }

  /** The version of the exported statistics' shape, the file's first key. */
  const SCHEMA_VERSION = 1;

  /**
   * The statistics the page shows, by box. Durations are milliseconds, shares
   * fractions, and an absent value null.
   *
   * @param {{ owner: string, repo: string }} ref
   * @param {readonly Half[]} halves
   * @param {import('../done/stats.js').Summary} summary
   * @returns {Record<string, unknown>}
   */
  function statisticsOf(ref, halves, summary) {
    const open = halves.find((half) => half.key === 'open');
    const done = halves.find((half) => half.key === 'done');
    /** @type {Record<string, unknown>} */
    const out = {
      schemaVersion: SCHEMA_VERSION,
      repository: `${ref.owner}/${ref.repo}`,
      generatedAt: new Date(summary.at).toISOString(),
      coverage: {
        total: summary.corpus,
        open: open?.corpus.members.length ?? 0,
        completed: done?.corpus.members.length ?? 0,
        notLoadedYet: summary.unread,
        openListFullyLoaded: open?.corpus.complete ?? false,
        completedListFullyLoaded: done?.corpus.complete ?? false,
        gitHubTabCounts: { ...summary.expected },
      },
    };
    for (const group of COUNT_GROUPS) {
      const tally = summary.counts[group.key];
      if (tally === undefined) continue;
      const shown = tallyRowsOf(group, tally);
      out[group.field] = {
        counted: shown.counted,
        total: shown.total,
        rows: shown.rows.map((row) => ({ label: row.label, count: row.count, share: row.share })),
      };
    }
    const months = summary.counts.month;
    const years = globalThis.bghsa.stats.yearsOf(months?.counts ?? {}, summary.at);
    const sums = globalThis.bghsa.stats.monthTotalsOf(years);
    out.reportsByMonth = {
      counted: months?.counted ?? 0,
      total: months?.corpus ?? 0,
      years,
      monthTotals: sums.months,
    };
    for (const timing of globalThis.bghsa.stats.TIMINGS) {
      const found = summary.timings[timing.key];
      /** @type {Record<string, number | null>} */
      const box = {
        loaded: found.read,
        total: found.corpus,
        min: found.min,
        median: found.median,
        mean: found.mean,
        max: found.max,
      };
      if (timing.omission !== undefined) box.waiting = found.waiting;
      out[`timeTo${timing.key.charAt(0).toUpperCase()}${timing.key.slice(1)}`] = box;
    }
    return out;
  }

  /**
   * Download the statistics the page shows as JSON, generated locally from
   * the summary the view draws. The file name carries the summary's UTC date.
   *
   * @param {Document} doc
   * @param {import('../done/csv.js').DownloadOptions} [options]
   * @returns {string | null} The download URL, or null if export is unavailable.
   */
  function exportJson(doc, options) {
    const state = current(doc);
    if (state.ref === null || state.summary === null) return null;
    if (whole(state.halves).members.length === 0) return null;
    const csv = globalThis.bghsa.csv;
    const shown = statisticsOf(state.ref, state.halves, state.summary);
    const text = `${JSON.stringify(shown, null, 2)}\n`;
    const name = csv.filenameFor(state.ref, state.summary.at, 'statistics', 'json');
    return csv.download(doc, name, text, { ...options, type: JSON_TYPE });
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
    STYLE_TEXT,
    stateOf,
    current,
    totalTextOf,
    read,
    reading,
    exportCsv,
    statisticsOf,
    exportJson,
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
