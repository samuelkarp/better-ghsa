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
 * One half of the corpus: the advisories in a set of states, and how much of
 * that set the crawl has been over.
 *
 * @typedef {object} Half
 * @property {string} key
 * @property {string} name What the reader is told this half is.
 * @property {readonly string[]} states The `?state=` values it is the union of.
 * @property {import('../done/corpus.js').Corpus} corpus
 * @property {boolean} walked Whether a walk of any of its states has started.
 *   A half nothing has walked is drawn from the page being looked at alone, so
 *   the numbers over it are over that page.
 */

/**
 * What the statistics view holds for one document.
 *
 * @typedef {object} Held
 * @property {{ owner: string, repo: string } | null} ref The repository the
 *   halves belong to, and null before anything is read.
 * @property {Half[]} halves
 */

(() => {
  /** The id of the element the statistics view owns. */
  const ROOT_ID = 'bghsa-stats';

  /** The id of the statistics view's stylesheet. */
  const STYLE_ID = 'bghsa-stats-style';

  /** The view this surface is, as the list page holds the choice. */
  const MODE = 'statistics';

  /** What the toggle reads while another view is showing. */
  const SHOW_STATS = 'Show statistics';

  /**
   * What it reads while this one is. Both extension views go back to the same
   * place, and the done view is where the label is defined.
   */
  const SHOW_OPEN = globalThis.bghsa.view.SHOW_OPEN;

  /** What the control that writes the file reads. */
  const EXPORT_LABEL = 'Export CSV';

  /** What stands where nothing has been read. */
  const EMPTY_TEXT = 'Nothing has been read on this repository';

  /** What stands in a count nothing carried a value for. */
  const NOTHING_TEXT = 'Nothing counted';

  /** What says a crawl is filling the corpus these numbers are over. */
  const READING_TEXT = 'Reading';

  /**
   * The two halves of the corpus, in the order they are named, and the crawl
   * that fills each.
   *
   * REQUIREMENTS.md section 10 has the statistics over the whole corpus,
   * because they describe active work as much as finished work. The open half
   * is what the list table crawls and the done half is what the done view
   * crawls, so this view reads what those two left behind and asks GitHub for
   * nothing.
   *
   * @type {readonly { key: string, name: string, states: readonly string[] }[]}
   */
  const HALVES = [
    { key: 'open', name: 'Open', states: globalThis.bghsa.parseList.OPEN_STATES },
    { key: 'done', name: 'Done', states: globalThis.bghsa.corpus.DONE_STATES },
  ];

  /**
   * The counts the view draws, in the order it draws them, how each is ordered
   * inside itself, and what the members carrying no value are to it. A month
   * reads in time order; everything else reads commonest first, which is what a
   * ratio is looked at for.
   *
   * `missingCounts` says the members carrying no value are an answer of their
   * own. An advisory closed with nobody giving a reason ended that way, so it
   * is counted with the rest and holds a share of its own. On every other count
   * a member carrying no value stands outside the shares.
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
   * What one timing's spread is drawn as, in the order it is drawn.
   *
   * @type {readonly { key: 'min' | 'median' | 'mean' | 'max', name: string }[]}
   */
  const SPREAD = [
    { key: 'min', name: 'Min' },
    { key: 'median', name: 'Median' },
    { key: 'mean', name: 'Mean' },
    { key: 'max', name: 'Max' },
  ];

  /**
   * Every rule the statistics view adds to the page.
   *
   * Each count is a list of its own, and the lists pack down columns. A list of
   * one row and a list of thirty share no row baseline, so the short one is
   * followed by the next list and not by a column's worth of nothing.
   *
   * The columns are sized by width, so how many there are follows the window
   * and a narrow one gets a single column running the width of the page. A box
   * is never split down the middle by the column it ends at.
   */
  const STYLE_TEXT = [
    '.bghsa-stats-over { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    '.bghsa-stats-lists { columns: 20rem; column-gap: 16px; }',
    '.bghsa-stats-list { break-inside: avoid; }',
    '.bghsa-stats-title { gap: 0 8px; }',
    '.bghsa-stats-line { display: flex; align-items: baseline; gap: 4px 12px; }',
    '.bghsa-stats-value { flex: 1 1 auto; }',
    // `currentColor` is what a foreground falls back to: the page's own text
    // color reads in either theme, where a fixed one would be wrong in one.
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
   * What the view holds for this document, with halves collected on a
   * repository the page no longer names dropped.
   *
   * GitHub replaces the turbo frame on a soft navigation and keeps the
   * document, so one document covers one repository's advisory list and then
   * another's. The numbers are a hundred-odd advisories of one repository and
   * say nothing about the next one.
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

  /** Which repository the list surface says the page is on. */
  const refOf = globalThis.bghsa.table.refOf;

  /** How every surface builds an element. */
  const element = globalThis.bghsa.dom.element;

  /**
   * @param {string} key
   * @returns {string} a camel-cased key as a label. A timing this reader does
   *   not compute is named from its key, so one arriving later is drawn without
   *   anything here being told about it.
   */
  function nameOf(key) {
    const words = key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    return globalThis.bghsa.chips.sentenceCase(words);
  }

  /** How many milliseconds are in each unit a duration is read in. */
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  const MINUTE_MS = 60 * 1000;

  /**
   * @param {number | null} ms
   * @returns {string} a duration in the two largest units it reaches, and a dash
   *   where there is none. A timing with nothing behind it is not a zero.
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
   * @returns {string} how many advisories every number below is over. It is the
   *   whole of what was counted, so it is said as a plain number: `Over 144`
   *   reads as a floor under a number that has none.
   */
  function totalTextOf(count) {
    return `${count} total ${count === 1 ? 'advisory' : 'advisories'}`;
  }

  /**
   * The two halves of one repository's corpus, as the crawl record and the
   * advisory cache already hold them.
   *
   * Nothing is fetched. The rows of the page being looked at are taken in the
   * way the list table takes them in, at no request cost, so a repository
   * nothing has walked still counts what the maintainer can see.
   *
   * @param {Document} doc
   * @returns {Promise<Held>} the halves, and a holding with no repository where
   *   the page is not an advisory list.
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
    // The page is seeded with no page number, so its rows are taken in and no
    // walk is recorded as having started on the strength of it.
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
   * The whole corpus, which is what every number here is over.
   *
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
   * @returns {number | null} how many advisories GitHub's own state tabs
   *   counted, and null where any tab went unread. It is the corpus size before
   *   any crawl, so it is what says whether what is counted here is all of it.
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
   * @returns {boolean} whether a crawl of either half is running. The numbers
   *   are over a corpus that is still being filled while one is.
   */
  function reading(doc) {
    if (globalThis.bghsa.table.progressOf(doc) !== null) return true;
    return globalThis.bghsa.view.current(doc).reading;
  }

  /**
   * What every number below is over, said before any of them is read.
   *
   * A count over a half nobody has crawled is a count over the page the
   * maintainer is looking at, and a count over a walk that stopped part way is
   * over part of a state. Neither is a count over the repository, so each half
   * says which it is.
   *
   * @param {Document} doc
   * @param {readonly Half[]} halves
   * @returns {Element}
   */
  function buildOver(doc, halves) {
    const table = globalThis.bghsa.table;
    // Every chip here is dimmed: color is kept for where the work stands, and
    // what a count is over is not that.
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
   * One line of one list: what it is of, how many, and what share that is.
   *
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
   * One list's header: what the list is, and how much of the corpus it holds.
   *
   * The two sit at either end of one line, and the rule that spaces them keeps
   * them apart where the name runs the width of the box.
   *
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
   * One count, as a list of its own sized to what it holds.
   *
   * @param {Document} doc
   * @param {{ key: string, name: string, by: 'count' | 'value', missingCounts?: boolean }} group
   * @param {import('../done/stats.js').Tally} tally
   * @returns {Element}
   */
  function buildTally(doc, group, tally) {
    const box = element(doc, 'div', 'Box mb-3 bghsa-stats-list');
    box.setAttribute('data-bghsa-count', group.key);
    // What every share below is over. Where the members carrying no value are
    // an answer of their own they are in it, and where they are an absence the
    // shares are over the members that carried a value, which is `tally.ratios`.
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
      // The members carrying no value are counted where the reader can see
      // them, so a ratio over the rest is not read as a ratio over the corpus.
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
   * One timing, as a list of its own.
   *
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
      // Why the rest are not in the numbers above, where the reader is looking
      // at them: the event this timing measures to never happened on them. It
      // is the reason and the count, as a row of the list.
      const line = buildLine(doc, timing.omission, String(found.omitted), '');
      line.classList.add('bghsa-stats-omitted');
      list.append(line);
    }
    box.append(list);
    return box;
  }

  /**
   * The statistics of REQUIREMENTS.md section 10, over the whole corpus. A
   * timing whose event this extension cannot observe is named and left
   * uncomputed, because a reader owed a metric is owed the reason it is absent.
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
   * The statistics view: what the numbers are over, the export, and one list
   * per count and per timing.
   *
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
   * Writes the corpus out as a file the browser takes. It is built here in the
   * page from what the view already holds: nothing is fetched and nothing is
   * sent anywhere.
   *
   * @param {Document} doc
   * @param {import('../done/csv.js').DownloadOptions} [options]
   * @returns {string | null} the blob URL the press went to, and null where
   *   there is nothing to write or no way to hand it over.
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

  /** How the list surface holds a node out of view. */
  const setHidden = globalThis.bghsa.table.setHidden;

  /**
   * @param {Document} doc
   * @returns {void} adds the statistics view's stylesheet once.
   */
  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID) !== null) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    (doc.head ?? doc.documentElement ?? doc.body)?.append(style);
  }

  /**
   * Draws the view into the list surface, under the bar the three toggles sit
   * on.
   *
   * @param {Document} doc
   * @returns {Element | null} the view, and null where the list surface is not
   *   on the page.
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
   * Reads the corpus back out of what the two crawls left behind and draws it.
   *
   * @param {Document} doc
   * @returns {Promise<Element | null>}
   */
  async function load(doc) {
    const found = await read(doc);
    // A read landing after the maintainer has gone to another repository is a
    // read of the one they left.
    const table = globalThis.bghsa.table;
    const here = refOf(doc);
    if (found.ref !== null && (here === null || table.refKey(here) !== table.refKey(found.ref))) {
      return draw(doc);
    }
    held.set(doc, found);
    return draw(doc);
  }

  /**
   * The toggle this surface puts on the bar, beside the one that restores
   * GitHub's view and the one that opens the done view.
   *
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
   * Switches between this view and the table. The list surface holds which of
   * the views the page is on, so a press here cannot leave two showing.
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
   * Draws the view under whichever view the page is on.
   *
   * GitHub's own view carries GitHub's controls. This toggle opens a view of
   * the extension's own, so it goes out of view with the table and comes back
   * with it, leaving one control on the bar there: the one that brings the
   * extension's views back.
   *
   * The numbers are read again whenever this view is the one showing, because
   * the crawls that fill them are the other two surfaces' and land while it is
   * open.
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

  // The list surface holds the choice of view and the bar the toggles sit on,
  // so this one takes its place there as soon as it loads.
  globalThis.bghsa.table.addSurface({ control: buildToggle, show });

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
