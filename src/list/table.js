'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/dom.js');
  require('../common/text.js');
  require('../common/trust.js');
  require('../common/schema.js');
  require('../common/merge.js');
  require('../common/parse-list.js');
  require('../common/record.js');
  require('../common/derive.js');
  require('../common/order.js');
  require('../common/chips.js');
  require('../common/row.js');
  require('../common/cache.js');
  require('../common/fetch.js');
  require('../common/crawl.js');
  require('../detail/tracking.js');
  require('../content.js');
}

/**
 * A table row combines list metadata with cached advisory data and implements
 * the fields required by OrderEntry.
 *
 * @typedef {object} TableRow
 * @property {string | null} ghsaId
 * @property {string | null} href The advisory's path on github.com.
 * @property {string | null} title
 * @property {string | null} state The GitHub state label.
 * @property {string | null} severity The severity, lowercased.
 * @property {string | null} severityLabel The severity as displayed.
 * @property {string | null} severityClass The GitHub severity class from the page
 *   supplying severityLabel.
 * @property {boolean} severityConfirmed Whether the current scoring is confirmed.
 * @property {string | null} openedAt
 * @property {string | null} reporter
 * @property {string[]} owners Assigned maintainer logins.
 * @property {number} observedAt The observation time in epoch milliseconds. Unread
 *   rows use the list observation time.
 * @property {boolean} read Whether this row includes cached advisory data.
 * @property {boolean} neverReviewed
 * @property {boolean} newActivity
 * @property {string | null} triage
 * @property {string | null} waitingSince
 * @property {boolean} embargo Whether an embargo applies.
 * @property {string | null} embargoLift
 * @property {boolean} embargoOverdue
 * @property {string | null} patch The derived patch state, or null for an unread
 *   advisory.
 * @property {number} backportTargets The number of requested backport branches.
 * @property {number} backportsDone The number of targets with an open pull request.
 * @property {string | null} cve The CVE chip text, or null when absent.
 * @property {boolean} cveAssigned Whether the advisory has an assigned CVE.
 */

/**
 * A facet defines the values and applicability of one filter.
 *
 * @template Row
 * @typedef {object} Facet
 * @property {string} key The filter key.
 * @property {string} label The control label.
 * @property {readonly string[]} [values] Known values in display order. Other values
 *   follow alphabetically.
 * @property {(row: Row) => boolean} [applies] Whether the facet applies to the row.
 *   Inapplicable rows fail every value, including NO_VALUE.
 * @property {(row: Row) => string[]} valuesOf The row's values for this facet, or an
 *   empty array.
 */

/**
 * @typedef {object} Sort
 * @property {string} key The sort key.
 * @property {string} label The control label.
 * @property {((a: TableRow, b: TableRow) => number) | null} compare The row
 *   comparator, or null for the default order.
 */

/**
 * @typedef {object} ViewState
 * @property {string} sort The selected sort key.
 * @property {Record<string, string>} filters Selected values by facet key. Missing
 *   entries leave that facet unfiltered.
 */

/**
 * @typedef {object} RowSource
 * @property {import('../common/parse-list.js').ListRow} row
 * @property {number} seenAt The list observation time in epoch milliseconds,
 *   retained for rows from earlier crawls.
 */

/**
 * @typedef {object} TableView
 * @property {TableRow[]} rows In the default order.
 * @property {number} at The render time in epoch milliseconds.
 * @property {Map<string, RowSource>} sources List metadata and observation times by
 *   GHSA identifier, used for subsequent row updates.
 */

/**
 * @typedef {object} RefreshOptions
 * @property {import('../common/cache.js').CacheStorage | null} [storage]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [wait]
 * @property {import('../common/write.js').WriteFetch} [fetch]
 * @property {import('../common/parse-list.js').ParsedList} [parsed] The parsed page,
 *   if already available.
 * @property {string} [href] The current page URL, used to determine its state and
 *   page number.
 */

/**
 * Refresh progress displayed in the table header.
 *
 * @typedef {object} RefreshProgress
 * @property {'walking' | 'reading'} phase Whether the refresh is crawling lists or
 *   reading advisories.
 * @property {number} left The unread advisory count. This is zero during the crawl,
 *   while the total is unknown.
 */

/**
 * @typedef {object} RefreshSummary
 * @property {import('../common/crawl.js').CrawlResult} crawled
 * @property {import('../common/fetch.js').QueueSummary} read The result of refreshing advisory details.
 */

/**
 * A registered surface supplies controls and responds to view and repository
 * changes on the list page.
 *
 * @typedef {object} Surface
 * @property {(doc: Document) => Element | null} control Build the view toggle on
 *   each render.
 * @property {(doc: Document) => Element | null} [controls] Build filter controls on
 *   each render. The surface manages their visibility.
 * @property {(doc: Document, mode: string) => void} show Apply the selected mode
 *   after the table is placed and its visibility is set.
 * @property {(doc: Document, key: string | null) => void} [left] Handle the current
 *   repository after each render, stopping work for other repositories. The key is
 *   lowercase owner/repo, or null outside an identified advisory list.
 */

/**
 * @typedef {object} ViewOptions
 * @property {import('../common/cache.js').CacheStorage | null} [storage]
 * @property {number} [at] The list observation time in epoch milliseconds.
 */

(() => {
  const ROOT_ID = 'bghsa-list';

  const STYLE_ID = 'bghsa-list-style';

  const HIDDEN_CLASS = 'bghsa-hidden';

  const STYLE_TEXT = [
    // Primer display utilities use !important; hiding them needs equal priority.
    `.${HIDDEN_CLASS} { display: none !important; }`,
    '.bghsa-list-chips { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    '.bghsa-list-status { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    '.bghsa-list-owners { display: flex; flex-wrap: wrap; gap: 2px; align-items: center; }',
    // The toggles end the bar in every view, whichever controls beside them are hidden.
    '.bghsa-list-toggles { margin-left: auto; }',
    // Use the page foreground color to support both themes.
    '.bghsa-list-observed { color: var(--fgColor-muted, currentColor); white-space: nowrap; }',
    '.bghsa-list-meta { color: var(--fgColor-muted, currentColor); }',
    '.bghsa-list-empty { color: var(--fgColor-muted, currentColor); }',
    ...globalThis.bghsa.chips.TONE_RULES,
    ...globalThis.bghsa.chips.FILL_RULES,
    `.${globalThis.bghsa.chips.DIM_CLASS} { opacity: 0.55; }`,
  ].join('\n');

  const DEFAULT_SORT_LABEL = 'Default';

  const RESET_LABEL = 'Reset';

  const EMPTY_TEXT = 'No matches';

  /**
   * The advisory count is unknown while list pages are being crawled.
   */
  const WALKING_TEXT = 'Loading...';

  const FACET_ATTRIBUTE = 'data-bghsa-facet';

  const VALUE_ATTRIBUTE = 'data-bghsa-value';

  const SORT_LABEL = 'Sort';

  const ANY_LABEL = 'Any';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * Primer uses aria-checked to show or hide this check icon in each menu item.
   */
  const CHECK_PATH =
    'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1' +
    ' .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z';

  const CLOSE_PATH =
    'M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1' +
    '-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22' +
    ' 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1' +
    ' 0-1.06Z';

  const SHOW_GITHUB = "Show GitHub's view";

  const SHOW_TABLE = 'Show Better GHSA';

  const VIEW_TABLE = 'table';

  const VIEW_NATIVE = 'native';

  /**
   * Extension markup must avoid these selectors because parse-list reads the
   * same container and would count extension rows as GitHub rows.
   *
   * @type {readonly string[]}
   */
  const PARSED_SELECTORS = ['div.Box-row--drag-hide', 'segmented-control', 'a[rel="next"]'];

  const element = globalThis.bghsa.dom.element;

  const sentenceCase = globalThis.bghsa.chips.sentenceCase;

  const PATCH_IN_REVIEW = globalThis.bghsa.chips.PATCH_IN_REVIEW;

  const NO_PATCH = globalThis.bghsa.chips.NO_PATCH;

  /**
   * This filter value matches the editor checkbox label.
   */
  const EMBARGO_SET_VALUE = 'In force';

  const PATCH_IN_REVIEW_VALUE = 'In review';

  const NO_PATCH_VALUE = 'No patch';

  const DRAFT_STATE = globalThis.bghsa.chips.DRAFT_STATE;

  /**
   * Count backport targets with an open pull request in the private fork.
   * Only open pull requests are observable there (REQUIREMENTS.md section 6).
   *
   * @param {import('../common/derive.js').PatchState} patch
   * @param {readonly string[]} backports Requested backport branches.
   * @returns {number} how many of them carry an open pull request.
   */
  function backportsDoneIn(patch, backports) {
    /** @type {Set<string>} */
    const prepared = new Set();
    for (const branch of patch.branches) {
      if (branch.open) prepared.add(branch.branch);
    }
    return backports.filter((branch) => prepared.has(branch)).length;
  }

  /**
   * @param {import('../common/derive.js').CveState} cve
   * @returns {string | null}
   */
  function cveTextOf(cve) {
    if (cve.state === 'assigned') return cve.id;
    if (cve.state === 'requested') return 'CVE requested';
    if (cve.state === 'not applicable') return 'CVE not applicable';
    return null;
  }

  /**
   * Build a row from list metadata before its advisory has been read.
   *
   * @param {import('../common/parse-list.js').ListRow} listRow
   * @param {number} seenAt The list observation time in epoch milliseconds.
   * @returns {TableRow}
   */
  function unreadRow(listRow, seenAt) {
    return {
      ghsaId: listRow.ghsaId,
      href: listRow.href,
      title: listRow.title,
      state: listRow.state,
      severity: listRow.severity,
      severityLabel: listRow.severityLabel,
      severityClass: listRow.severityClass,
      severityConfirmed: false,
      openedAt: listRow.openedAt,
      reporter: listRow.reporter,
      owners: [],
      observedAt: seenAt,
      read: false,
      neverReviewed: false,
      newActivity: false,
      triage: null,
      waitingSince: listRow.openedAt,
      embargo: false,
      embargoLift: null,
      embargoOverdue: false,
      patch: null,
      backportTargets: 0,
      backportsDone: 0,
      cve: null,
      cveAssigned: false,
    };
  }

  /**
   * Combine cached advisory data with list metadata. The cached read supplies
   * the observation time and takes precedence over list metadata for fields
   * it contains. The list supplies the advisory link.
   *
   * @param {RowSource} source List metadata and its observation time.
   * @param {import('../common/cache.js').CacheEntry | null} entry
   * @param {number} at The render time in epoch milliseconds, used to evaluate
   *   embargo expiry.
   * @returns {Promise<TableRow>}
   */
  async function viewRow(source, entry, at) {
    const listRow = source.row;
    const advisory =
      entry === null ? null : globalThis.bghsa.record.advisoryFrom(entry.record);
    if (advisory === null || entry === null) return unreadRow(listRow, source.seenAt);

    const merged = globalThis.bghsa.merge.mergeSnapshots(advisory.comments);
    const tracking = await globalThis.bghsa.tracking.readAdvisory(advisory, merged);
    const derived = globalThis.bghsa.derive.derive(advisory);
    const embargoLift = tracking.embargo ? tracking.embargoLift : null;

    return {
      ghsaId: listRow.ghsaId ?? advisory.ghsaId,
      href: listRow.href,
      title: advisory.title ?? listRow.title,
      state: advisory.state ?? listRow.state,
      severity: advisory.severity ?? listRow.severity,
      severityLabel: advisory.severityLabel ?? listRow.severityLabel,
      // Use the color from the same observation as the severity label.
      severityClass:
        advisory.severityLabel === null ? listRow.severityClass : advisory.severityClass,
      severityConfirmed: tracking.scoring.status === 'confirmed',
      openedAt: advisory.reportedAt ?? listRow.openedAt,
      reporter: advisory.reporter ?? listRow.reporter,
      owners: tracking.owners,
      observedAt: entry.observedAt,
      read: true,
      neverReviewed: derived.neverReviewed,
      newActivity: derived.newActivity,
      triage: tracking.triage,
      waitingSince: tracking.triageSince ?? advisory.reportedAt ?? listRow.openedAt,
      embargo: tracking.embargo,
      embargoLift,
      embargoOverdue: globalThis.bghsa.derive.embargoOverdue(advisory, embargoLift, at),
      patch: globalThis.bghsa.chips.patchStateOf(derived.patch),
      backportTargets: tracking.backports.length,
      backportsDone: backportsDoneIn(derived.patch, tracking.backports),
      cve: cveTextOf(derived.cve),
      cveAssigned: derived.cve.state === 'assigned',
    };
  }

  /**
   * @param {import('../common/parse-list.js').ListRow} row
   * @param {string | null} selected The current tab's state key.
   * @returns {string | null} The row's state key, falling back to the selected tab.
   */
  function stateOfRow(row, selected) {
    return globalThis.bghsa.crawl.stateKeyOf(row.state) ?? selected;
  }

  /**
   * Combine crawled triage and draft rows with the current page. Current-page
   * rows take precedence over cached list rows. Each source retains its own
   * observation time until an advisory read supplies the row data.
   *
   * @param {import('../common/parse-list.js').ParsedList} parsed
   * @param {ViewOptions} [options]
   * @returns {Promise<Map<string, RowSource>>} Sources keyed by GHSA identifier.
   */
  async function listRows(parsed, options = {}) {
    const cache = globalThis.bghsa.cache;
    const open = globalThis.bghsa.parseList.OPEN_STATES;
    const at = options.at ?? cache.now();
    const held = await cache.getList(parsed, { storage: options.storage, at });
    const crawled = globalThis.bghsa.crawl.listFrom(held === null ? null : held.record);

    /** @type {Map<string, RowSource>} */
    const rows = new Map();
    for (const found of Object.values(crawled.rows)) {
      if (!open.includes(found.state) || found.row.ghsaId === null) continue;
      rows.set(found.row.ghsaId, { row: found.row, seenAt: found.seenAt });
    }
    for (const row of parsed.rows) {
      if (row.ghsaId === null) continue;
      const state = stateOfRow(row, parsed.selectedState);
      if (state === null || !open.includes(state)) continue;
      rows.set(row.ghsaId, { row, seenAt: at });
    }
    return rows;
  }

  /**
   * Build the initial table from the page and cache. Network refreshes update
   * the rows afterwards.
   *
   * @param {import('../common/parse-list.js').ParsedList} parsed
   * @param {ViewOptions} [options]
   * @returns {Promise<TableView>}
   */
  async function readView(parsed, options = {}) {
    const cache = globalThis.bghsa.cache;
    const at = options.at ?? cache.now();
    const sources = await listRows(parsed, { ...options, at });
    const ids = [...sources.keys()];
    const entries = await cache.getAdvisories(parsed, ids, { storage: options.storage, at });
    const rows = await Promise.all(
      [...sources.values()].map((source) =>
        viewRow(
          source,
          source.row.ghsaId === null ? null : entries.get(source.row.ghsaId) ?? null,
          at
        )
      )
    );
    return { rows: globalThis.bghsa.order.sort(rows), at, sources };
  }

  /**
   * Build chips in the order specified by REQUIREMENTS.md section 9.
   *
   * @param {TableRow} row
   * @returns {import('../common/chips.js').ChipSpec[]}
   */
  function chipsFor(row) {
    /** @type {import('../common/chips.js').ChipSpec[]} */
    const chips = [];

    // Waiting state requires an advisory read; list markup does not provide it.
    if (row.read) chips.push(...globalThis.bghsa.chips.waitingChips(row));

    // Patches are expected only after an advisory is accepted as a draft.
    if (row.state === DRAFT_STATE && row.patch !== null) {
      chips.push(globalThis.bghsa.chips.patchChip(row.patch));
    }
    if (row.backportTargets > 0) {
      /** @type {import('../common/chips.js').ChipSpec} */
      const backports = { text: `Backports ${row.backportsDone} of ${row.backportTargets}` };
      backports.tone = row.backportsDone < row.backportTargets ? 'attention' : 'success-muted';
      chips.push(backports);
    }
    if (row.cve !== null) {
      /** @type {import('../common/chips.js').ChipSpec} */
      const cve = { text: row.cve };
      if (row.cveAssigned) cve.tone = 'success-muted';
      chips.push(cve);
    }

    // Label scoring as unconfirmed only after reading the advisory.
    if (row.severityLabel !== null) {
      const severity = sentenceCase(row.severityLabel);
      chips.push({
        text: row.read && !row.severityConfirmed ? `${severity}, unconfirmed` : severity,
        severityClass: row.severityClass,
        dim: !row.severityConfirmed,
        fill: row.severityConfirmed,
        subject: globalThis.bghsa.chips.SEVERITY_SUBJECT,
      });
    }

    if (row.embargo || row.embargoOverdue) {
      const lift = row.embargoLift;
      if (lift === null) chips.push({ text: 'Embargo, no lift date', tone: 'attention' });
      else if (row.embargoOverdue) {
        chips.push({ text: `Embargo overdue since ${lift}`, tone: 'danger' });
      } else chips.push({ text: `Embargo lifts ${lift}`, tone: 'attention' });
    }

    return chips;
  }

  const NO_VALUE = 'None';

  /**
   * The default sort follows REQUIREMENTS.md section 9.
   */
  const DEFAULT_SORT = 'default';

  /**
   * Break sort ties by identifier, with unknown identifiers last.
   *
   * @param {TableRow} a
   * @param {TableRow} b
   * @returns {number}
   */
  function byGhsaId(a, b) {
    return globalThis.bghsa.order.compareText(a.ghsaId, b.ghsaId);
  }

  /**
   * @param {TableRow} row
   * @param {boolean} confirmed
   * @returns {number} The severity rank if its confirmation matches the requested
   *   status, otherwise zero.
   */
  function severityScore(row, confirmed) {
    if (row.severityConfirmed !== confirmed) return 0;
    return globalThis.bghsa.order.severityRank(row.severity);
  }

  /**
   * @param {TableRow} row
   * @returns {string[]} The backport status, or an empty array without targets.
   */
  function backportValuesOf(row) {
    if (row.backportTargets === 0) return [];
    return [row.backportsDone >= row.backportTargets ? 'Complete' : 'Outstanding'];
  }

  /**
   * Patch filters apply to drafts with a known patch state.
   *
   * @param {TableRow} row
   * @returns {string[]}
   */
  function patchValuesOf(row) {
    if (row.state !== DRAFT_STATE) return [];
    if (row.patch === PATCH_IN_REVIEW) return [PATCH_IN_REVIEW_VALUE];
    if (row.patch === NO_PATCH) return [NO_PATCH_VALUE];
    return [];
  }

  /**
   * @param {TableRow} row
   * @returns {string[]} The waiting state, or an empty array for an unread advisory.
   */
  function waitingValuesOf(row) {
    if (!row.read) return [];
    return [sentenceCase(globalThis.bghsa.order.waitingStateOf(row))];
  }

  /**
   * @type {readonly Facet<TableRow>[]}
   */
  const FACETS = [
    {
      key: 'waiting',
      label: 'Waiting',
      values: globalThis.bghsa.order.WAITING_STATES.map(sentenceCase),
      valuesOf: waitingValuesOf,
    },
    {
      key: 'severity',
      label: 'Severity',
      values: ['Critical', 'High', 'Moderate', 'Low'],
      valuesOf: (row) => (row.severityLabel === null ? [] : [sentenceCase(row.severityLabel)]),
    },
    {
      key: 'owner',
      label: 'Owner',
      valuesOf: (row) => row.owners.slice(),
    },
    {
      key: 'state',
      label: 'State',
      valuesOf: (row) => (row.state === null ? [] : [row.state]),
    },
    {
      key: 'patch',
      label: 'Patch',
      values: [PATCH_IN_REVIEW_VALUE, NO_PATCH_VALUE],
      valuesOf: patchValuesOf,
    },
    {
      key: 'backports',
      label: 'Backports',
      values: ['Outstanding', 'Complete'],
      valuesOf: backportValuesOf,
    },
    {
      key: 'embargo',
      label: 'Embargo',
      values: ['Overdue', EMBARGO_SET_VALUE],
      valuesOf: (row) =>
        row.embargoOverdue
          ? [EMBARGO_SET_VALUE, 'Overdue']
          : row.embargo
            ? [EMBARGO_SET_VALUE]
            : [],
    },
  ];

  /**
   * @type {readonly Sort[]}
   */
  const SORTS = [
    { key: DEFAULT_SORT, label: DEFAULT_SORT_LABEL, compare: null },
    {
      key: 'severity',
      label: 'Highest severity',
      compare: (a, b) =>
        severityScore(b, true) - severityScore(a, true) ||
        severityScore(b, false) - severityScore(a, false),
    },
    {
      key: 'waiting',
      label: 'Longest waiting',
      compare: (a, b) =>
        globalThis.bghsa.order.compareNumber(
          globalThis.bghsa.text.instantOf(a.waitingSince),
          globalThis.bghsa.text.instantOf(b.waitingSince)
        ),
    },
  ];

  /**
   * @param {string} key
   * @returns {Facet<TableRow> | null} The matching facet, or null for an unknown
   *   key.
   */
  function facetFor(key) {
    return FACETS.find((facet) => facet.key === key) ?? null;
  }

  /**
   * @returns {ViewState} The default sort with every filter cleared.
   */
  function defaultViewState() {
    return { sort: DEFAULT_SORT, filters: {} };
  }

  /**
   * @param {ViewState} state
   * @returns {boolean}
   */
  function isDefaultView(state) {
    if (state.sort !== DEFAULT_SORT) return false;
    return Object.values(state.filters).every((value) => value === '');
  }

  /**
   * Unread rows pass filters whose values are still unknown. Once read, an
   * empty value matches only NO_VALUE. An inapplicable facet never matches.
   *
   * @template {{ read: boolean }} Row
   * @param {Facet<Row>} facet
   * @param {Row} row
   * @param {string} wanted
   * @returns {boolean}
   */
  function matchesFilter(facet, row, wanted) {
    if (facet.applies !== undefined && !facet.applies(row)) return false;
    const held = facet.valuesOf(row);
    if (held.length === 0) return row.read ? wanted === NO_VALUE : true;
    return held.includes(wanted);
  }

  /**
   * @param {TableRow} row
   * @param {ViewState} state
   * @returns {boolean} Whether the row matches every active filter.
   */
  function matchesView(row, state) {
    for (const [key, wanted] of Object.entries(state.filters)) {
      if (wanted === '') continue;
      const facet = facetFor(key);
      if (facet === null) continue;
      if (!matchesFilter(facet, row, wanted)) return false;
    }
    return true;
  }

  /**
   * Use the selected comparator with the identifier as the final tie-breaker.
   *
   * @param {string} key
   * @returns {((a: TableRow, b: TableRow) => number) | null} The comparator, or null
   *   to use the default order.
   */
  function sortFor(key) {
    const held = SORTS.find((sort) => sort.key === key)?.compare ?? null;
    if (held === null) return null;
    return (a, b) => held(a, b) || byGhsaId(a, b);
  }

  /**
   * Store filter and sort choices separately from controls to preserve them
   * when rendering replaces the table.
   *
   * @type {WeakMap<Document, ViewState>}
   */
  const viewStates = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {ViewState} The document's selected filters and sort, defaulting to the
   *   initial state.
   */
  function viewStateOf(doc) {
    return viewStates.get(doc) ?? defaultViewState();
  }

  /**
   * @param {Document} doc
   * @param {ViewState} state
   * @returns {void}
   */
  function setViewState(doc, state) {
    viewStates.set(doc, state);
  }

  /**
   * Filter and sort existing rows. Unknown sort keys use the default order.
   *
   * @param {readonly TableRow[]} rows
   * @param {ViewState} state
   * @returns {TableRow[]}
   */
  function applyView(rows, state) {
    const kept = rows.filter((row) => matchesView(row, state));
    const compare = sortFor(state.sort);
    return compare === null ? globalThis.bghsa.order.sort(kept) : kept.sort(compare);
  }

  /**
   * Offer the values present in applicable rows, plus NO_VALUE for read rows
   * with an empty value. Preserve the selected option even when refreshes
   * remove its last matching row.
   *
   * @template {{ read: boolean }} Row
   * @param {readonly Row[]} rows
   * @param {Facet<Row>} facet
   * @param {string} selected The selected value, or an empty string for no filter.
   * @returns {string[]}
   */
  function filterOptions(rows, facet, selected) {
    /** @type {Set<string>} */
    const held = new Set();
    let absent = false;
    for (const row of rows) {
      if (facet.applies !== undefined && !facet.applies(row)) continue;
      const values = facet.valuesOf(row);
      if (values.length === 0) absent = absent || row.read;
      for (const value of values) held.add(value);
    }
    const known = facet.values ?? [];
    const offered = [...held].sort((a, b) => {
      const left = known.indexOf(a);
      const right = known.indexOf(b);
      if (left !== right) return (left === -1 ? known.length : left) - (right === -1 ? known.length : right);
      return globalThis.bghsa.order.compareText(a, b);
    });
    if (absent) offered.push(NO_VALUE);
    if (selected !== '' && !offered.includes(selected)) offered.push(selected);
    return offered;
  }

  /**
   * Request avatar images at twice their display size for high-density displays.
   */
  const AVATAR_PIXELS = 20;

  /** The size the avatar image is asked for, in pixels. */
  const AVATAR_SOURCE_PIXELS = AVATAR_PIXELS * 2;

  /**
   * State comments supply owner logins without numeric account IDs. GitHub
   * redirects login-based image URLs to avatars.githubusercontent.com.
   *
   * @param {string} login
   * @returns {string}
   */
  function avatarUrlFor(login) {
    return `https://github.com/${encodeURIComponent(login)}.png?size=${AVATAR_SOURCE_PIXELS}`;
  }

  /**
   * Encode owner logins from state comments in profile and avatar URLs.
   * The alt text identifies owners whose avatar fails to load.
   *
   * @param {Document} doc
   * @param {readonly string[]} owners
   * @returns {Element}
   */
  function buildOwners(doc, owners) {
    const box = element(doc, 'div', 'bghsa-list-owners');
    for (const login of owners) {
      const link = element(doc, 'a', 'no-underline bghsa-list-owner');
      link.setAttribute('href', `/${encodeURIComponent(login)}`);
      link.setAttribute('title', login);
      link.setAttribute('aria-label', `Owner ${login}`);
      const avatar = element(doc, 'img', 'avatar avatar-user');
      avatar.setAttribute('src', avatarUrlFor(login));
      avatar.setAttribute('alt', `@${login}`);
      avatar.setAttribute('title', login);
      avatar.setAttribute('width', String(AVATAR_PIXELS));
      avatar.setAttribute('height', String(AVATAR_PIXELS));
      link.append(avatar);
      box.append(link);
    }
    return box;
  }

  /**
   * Align the state and observation cells with those in the completed view.
   *
   * @param {Document} doc
   * @param {TableRow} row
   * @returns {Element}
   */
  function buildRow(doc, row) {
    const built = globalThis.bghsa.row;

    /** @type {Element[]} */
    const cells = [];
    if (row.owners.length > 0) {
      const owners = built.cell(doc, '');
      owners.append(buildOwners(doc, row.owners));
      cells.push(owners);
    }

    const state = built.cell(doc, 'bghsa-list-state');
    if (row.state !== null) {
      // Use a neutral state chip. Patch status has its own chip.
      state.append(globalThis.bghsa.chips.buildChip(doc, { text: row.state }));
    }
    cells.push(state);
    cells.push(built.cell(doc, 'text-small bghsa-list-observed', observedTextOf(row)));

    return built.buildRow(doc, {
      prefix: 'bghsa-list',
      ghsaId: row.ghsaId,
      href: row.href,
      title: row.title ?? row.ghsaId ?? 'Advisory',
      meta: built.metaTextOf(row),
      chips: chipsFor(row),
      cells,
    });
  }

  /**
   * The completed view also uses this observation label.
   *
   * @param {{ read: boolean, observedAt: number | null }} row
   * @returns {string} The advisory observation time, or "Not read" for an unread
   *   advisory.
   */
  function observedTextOf(row) {
    const at = row.read ? globalThis.bghsa.text.formatTime(row.observedAt) : null;
    return at === null ? 'Not read' : `Observed ${at}`;
  }

  /**
   * @param {number} count
   * @returns {string}
   */
  function countTextOf(count) {
    return count === 1 ? '1 advisory' : `${count} advisories`;
  }

  /**
   * @param {Document} doc
   * @param {string} className
   * @param {string} path
   * @returns {Element} A 16x16 SVG icon.
   */
  function octicon(doc, className, path) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `octicon ${className}`);
    svg.setAttribute('height', '16');
    svg.setAttribute('width', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('version', '1.1');
    const drawn = doc.createElementNS(SVG_NS, 'path');
    drawn.setAttribute('d', path);
    svg.append(drawn);
    return svg;
  }

  /**
   * Menu items update the current table through button handlers.
   *
   * @param {Document} doc
   * @param {string} value The selected value.
   * @param {string} label
   * @param {boolean} checked
   * @param {() => void} pressed
   * @returns {Element}
   */
  function menuItem(doc, value, label, checked, pressed) {
    const item = element(doc, 'button', 'SelectMenu-item');
    item.setAttribute('type', 'button');
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', checked ? 'true' : 'false');
    item.setAttribute(VALUE_ATTRIBUTE, value);
    const check = octicon(doc, 'octicon-check SelectMenu-icon SelectMenu-icon--check', CHECK_PATH);
    check.setAttribute('aria-hidden', 'true');
    item.append(check, element(doc, 'span', '', label));
    item.addEventListener('click', pressed);
    return item;
  }

  /**
   * Use GitHub's details-menu structure from testdata/select-menu.html. Primer
   * provides styling; details-menu provides arrow keys, Escape, and typeahead.
   * The native details element manages the expanded state.
   *
   * @param {Document} doc
   * @param {string} className The control's CSS class.
   * @param {string} label The control label and menu title.
   * @param {string} value The selected value.
   * @param {readonly Element[]} items
   * @returns {Element}
   */
  function menu(doc, className, label, value, items) {
    const held = element(
      doc,
      'details',
      `details-reset details-overlay d-inline-block position-relative mr-2 mb-1 ${className}`
    );

    const summary = element(doc, 'summary', 'btn btn-sm');
    summary.setAttribute('role', 'button');
    summary.setAttribute('aria-haspopup', 'menu');
    summary.append(
      doc.createTextNode(label),
      element(doc, 'span', 'bghsa-list-menu-value', value === '' ? '' : `: ${value}`),
      element(doc, 'span', 'dropdown-caret')
    );
    held.append(summary);

    // Primer displays the menu as a full-screen modal on narrow viewports.
    // The close button uses this handler to dismiss it.
    const close = element(doc, 'button', 'SelectMenu-closeButton');
    close.setAttribute('type', 'button');
    const cross = octicon(doc, 'octicon-x', CLOSE_PATH);
    cross.setAttribute('role', 'img');
    cross.setAttribute('aria-label', 'Close menu');
    close.append(cross);
    close.addEventListener('click', () => held.removeAttribute('open'));

    const header = element(doc, 'header', 'SelectMenu-header');
    header.append(element(doc, 'span', 'SelectMenu-title', label), close);

    const list = element(doc, 'div', 'SelectMenu-list');
    list.append(...items);

    const modal = element(doc, 'div', 'SelectMenu-modal');
    modal.append(header, list);

    const body = element(doc, 'details-menu', 'SelectMenu');
    body.setAttribute('role', 'menu');
    body.setAttribute('aria-label', label);
    body.append(modal);
    held.append(body);
    return held;
  }

  /**
   * @param {Document} doc
   * @param {Facet<TableRow>} facet
   * @param {readonly TableRow[]} rows
   * @param {string} selected
   * @returns {Element[]} The unfiltered option followed by the available values.
   */
  function filterItems(doc, facet, rows, selected) {
    /**
     * @param {string} value
     * @returns {() => void}
     */
    const pressing = (value) => () => {
      const view = viewStateOf(doc);
      setViewState(doc, { ...view, filters: { ...view.filters, [facet.key]: value } });
      drawControls(doc);
      refreshBody(doc);
    };
    const items = [menuItem(doc, '', ANY_LABEL, selected === '', pressing(''))];
    for (const value of filterOptions(rows, facet, selected)) {
      items.push(menuItem(doc, value, value, value === selected, pressing(value)));
    }
    return items;
  }

  /**
   * Build the sort, filter, and reset controls.
   *
   * @param {Document} doc
   * @param {readonly TableRow[]} rows The rows supplying filter options.
   * @param {ViewState} state
   * @returns {Element}
   */
  function buildControls(doc, rows, state) {
    const box = element(doc, 'div', 'd-flex flex-wrap flex-items-center bghsa-list-controls');

    const held = SORTS.find((each) => each.key === state.sort) ?? SORTS[0];
    const sorts = SORTS.map((each) =>
      menuItem(doc, each.key, each.label, each.key === held?.key, () => {
        setViewState(doc, { ...viewStateOf(doc), sort: each.key });
        drawControls(doc);
        refreshBody(doc);
      })
    );
    box.append(menu(doc, 'bghsa-list-sort', SORT_LABEL, held?.label ?? '', sorts));

    for (const facet of FACETS) {
      const selected = state.filters[facet.key] ?? '';
      const control = menu(
        doc,
        'bghsa-list-filter',
        facet.label,
        selected,
        filterItems(doc, facet, rows, selected)
      );
      control.setAttribute(FACET_ATTRIBUTE, facet.key);
      box.append(control);
    }

    const reset = element(doc, 'button', 'btn btn-sm mb-1 bghsa-list-reset', RESET_LABEL);
    reset.setAttribute('type', 'button');
    if (isDefaultView(state)) reset.setAttribute('disabled', '');
    reset.addEventListener('click', () => {
      setViewState(doc, defaultViewState());
      drawControls(doc);
      refreshBody(doc);
    });
    box.append(reset);
    return box;
  }

  /**
   * @param {Document} doc
   * @returns {void}
   */
  function drawControls(doc) {
    const root = doc.getElementById(ROOT_ID);
    const view = views.get(doc);
    if (root === null || view === undefined) return;
    const held = root.querySelector('.bghsa-list-controls');
    if (held === null) return;
    const fresh = buildControls(doc, view.rows, viewStateOf(doc));
    // Preserve the controls' visibility when rebuilding them.
    if (held.classList.contains(HIDDEN_CLASS)) fresh.classList.add(HIDDEN_CLASS);
    held.replaceWith(fresh);
  }

  /**
   * Update menu options while preserving selections and the control elements.
   * Replace only changed item lists to keep open menus in place.
   *
   * @param {Element} box The controls to update.
   * @param {(key: string) => readonly Element[] | null} itemsFor The current items
   *   for a facet, or null for an unknown facet.
   * @returns {void}
   */
  function syncMenus(box, itemsFor) {
    for (const control of box.querySelectorAll(`[${FACET_ATTRIBUTE}]`)) {
      const list = control.querySelector('.SelectMenu-list');
      if (list === null) continue;
      const wanted = itemsFor(control.getAttribute(FACET_ATTRIBUTE) ?? '');
      if (wanted === null) continue;
      const shown = [...list.querySelectorAll(`[${VALUE_ATTRIBUTE}]`)];
      const same =
        shown.length === wanted.length &&
        shown.every(
          (each, at) =>
            each.getAttribute(VALUE_ATTRIBUTE) === wanted[at]?.getAttribute(VALUE_ATTRIBUTE)
        );
      if (same) continue;
      while (list.firstChild !== null) list.removeChild(list.firstChild);
      list.append(...wanted);
    }
  }

  /**
   * Facet keys are local to each surface. Update only this table's controls.
   *
   * @param {Document} doc
   * @returns {void}
   */
  function syncFilterOptions(doc) {
    const root = doc.getElementById(ROOT_ID);
    const view = views.get(doc);
    if (root === null || view === undefined) return;
    const box = root.querySelector('.bghsa-list-controls');
    if (box === null) return;
    const state = viewStateOf(doc);
    syncMenus(box, (key) => {
      const facet = facetFor(key);
      if (facet === null) return null;
      return filterItems(doc, facet, view.rows, state.filters[key] ?? '');
    });
  }

  /**
   * @param {number} shown
   * @param {number} held
   * @returns {string} The visible count, including the total when filtered.
   */
  function viewCountText(shown, held) {
    return shown === held ? countTextOf(held) : `${shown} of ${countTextOf(held)}`;
  }

  /**
   * Store refresh progress separately from the DOM to preserve it across renders.
   *
   * @type {WeakMap<Document, RefreshProgress>}
   */
  const progresses = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {RefreshProgress | null} The current refresh progress, or null when
   *   idle.
   */
  function progressOf(doc) {
    return progresses.get(doc) ?? null;
  }

  /**
   * Use a neutral chip for refresh progress because it does not require user action.
   *
   * @param {Document} doc
   * @param {RefreshProgress | null} held
   * @returns {Element | null} The progress chip, or null when idle or finished.
   */
  function progressChip(doc, held) {
    if (held === null) return null;
    if (held.phase === 'walking') {
      return element(doc, 'span', 'Label Label--secondary bghsa-list-progress', WALKING_TEXT);
    }
    if (held.left <= 0) return null;
    return element(
      doc,
      'span',
      'Label Label--secondary bghsa-list-progress',
      `Loading (${held.left} left)...`
    );
  }

  /**
   * Update the progress chip in place to avoid rebuilding the table after
   * every advisory read.
   *
   * @param {Document} doc
   * @param {RefreshProgress | null} held The refresh progress, or null to clear it.
   * @returns {void}
   */
  function setProgress(doc, held) {
    if (held === null) progresses.delete(doc);
    else progresses.set(doc, held);
    const root = doc.getElementById(ROOT_ID);
    const box = root?.querySelector('.bghsa-list-status') ?? null;
    if (box === null) return;
    const shown = box.querySelector('.bghsa-list-progress');
    const wanted = progressChip(doc, held);
    if (shown === null) {
      if (wanted !== null) box.append(wanted);
    } else if (wanted === null) {
      box.removeChild(shown);
    } else {
      shown.replaceWith(wanted);
    }
  }

  /**
   * Show an empty-result message when filters exclude every row.
   *
   * @param {Document} doc
   * @param {readonly TableRow[]} shown
   * @param {number} held The total row count.
   * @returns {Element}
   */
  function buildBody(doc, shown, held) {
    const list = element(doc, 'ul', 'bghsa-list-rows');
    if (shown.length === 0 && held > 0) {
      list.append(element(doc, 'li', 'Box-row bghsa-list-empty', EMPTY_TEXT));
      return list;
    }
    for (const row of shown) list.append(buildRow(doc, row));
    return list;
  }

  /**
   * Redraw rows while preserving the controls and their focus.
   *
   * @param {Document} doc
   * @returns {void}
   */
  function refreshBody(doc) {
    const root = doc.getElementById(ROOT_ID);
    const view = views.get(doc);
    if (root === null || view === undefined) return;
    const box = root.querySelector('.bghsa-list-box');
    if (box === null) return;
    const shown = applyView(view.rows, viewStateOf(doc));
    const count = root.querySelector('.bghsa-list-count');
    if (count !== null) count.textContent = viewCountText(shown.length, view.rows.length);
    const body = buildBody(doc, shown, view.rows.length);
    const held = root.querySelector('.bghsa-list-rows');
    if (held === null) box.append(body);
    else held.replaceWith(body);
  }

  /**
   * Build the shared toolbar and the open-advisory table. Each surface manages
   * the visibility of its controls.
   *
   * @param {Document} doc
   * @param {TableView} view
   * @returns {Element}
   */
  function buildTable(doc, view) {
    const state = viewStateOf(doc);
    const root = element(doc, 'div', 'bghsa-list-root');
    root.id = ROOT_ID;
    root.setAttribute('data-bghsa-list', '1');

    const bar = element(
      doc,
      'div',
      'd-flex flex-wrap flex-items-center flex-justify-between mb-2 bghsa-list-bar'
    );
    bar.append(buildControls(doc, view.rows, state));
    // Each surface manages the visibility of its own filter controls.
    for (const surface of [...surfaces]) {
      if (surface.controls === undefined) continue;
      /** @type {Element | null} */
      let filters = null;
      try {
        filters = surface.controls(doc);
      } catch {
        // Continue building the bar if a surface fails.
      }
      if (filters !== null) bar.append(filters);
    }
    // Group all view toggles using Primer's BtnGroup styling.
    const group = element(doc, 'div', 'BtnGroup bghsa-list-toggles');
    const toggle = element(doc, 'button', 'BtnGroup-item btn btn-sm bghsa-list-toggle', SHOW_GITHUB);
    toggle.setAttribute('type', 'button');
    toggle.addEventListener('click', () => {
      setShowingNative(doc, !showingNative(doc));
      applyVisibility(doc);
    });
    group.append(toggle);
    for (const surface of [...surfaces]) {
      /** @type {Element | null} */
      let node = null;
      try {
        node = surface.control(doc);
      } catch {
        // Continue building the bar if a surface fails.
      }
      if (node !== null) {
        node.classList.add('BtnGroup-item');
        group.append(node);
      }
    }
    bar.append(group);
    root.append(bar);

    const box = element(doc, 'div', 'Box mb-3 bghsa-list-box');
    const header = element(
      doc,
      'div',
      'Box-header d-flex flex-items-center flex-justify-between bghsa-list-header'
    );
    header.append(element(doc, 'strong', '', 'Better GHSA'));
    const shown = applyView(view.rows, state);
    const status = element(doc, 'div', 'bghsa-list-status');
    status.append(
      element(
        doc,
        'span',
        'text-normal bghsa-list-count',
        viewCountText(shown.length, view.rows.length)
      )
    );
    const held = progressChip(doc, progressOf(doc));
    if (held !== null) status.append(held);
    header.append(status);
    box.append(header);
    box.append(buildBody(doc, shown, view.rows.length));
    root.append(box);
    return root;
  }

  /**
   * @type {Surface[]}
   */
  const surfaces = [];

  /**
   * @param {Surface} surface
   * @returns {void}
   */
  function addSurface(surface) {
    surfaces.push(surface);
  }

  /**
   * Return GitHub's rows, state control, query form, and pagination for hiding.
   * Pagination is outside the Box containing the rows. The Box must be first
   * because anchor uses it as a fallback insertion point.
   *
   * @param {Element} container The div#advisories element.
   * @returns {Element[]}
   */
  function nativeControls(container) {
    /** @type {Element[]} */
    const found = [];
    const control = container.querySelector('segmented-control');
    const box =
      control?.closest('div.Box') ??
      container.querySelector('div.Box-row--drag-hide')?.closest('div.Box') ??
      null;
    if (box !== null) found.push(box);
    for (const filter of container.querySelectorAll('repository-advisories-filter')) {
      if (!found.includes(filter)) found.push(filter);
    }
    for (const paging of container.querySelectorAll('.paginate-container')) {
      if (!found.includes(paging)) found.push(paging);
    }
    return found;
  }

  /**
   * Store one active view per document. The open-advisory table is the default.
   *
   * @type {WeakMap<Document, string>}
   */
  const modes = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {string} The selected view mode, defaulting to VIEW_TABLE.
   */
  function viewMode(doc) {
    return modes.get(doc) ?? VIEW_TABLE;
  }

  /**
   * @param {Document} doc
   * @param {string} mode
   * @returns {void}
   */
  function setViewMode(doc, mode) {
    modes.set(doc, mode);
  }

  /**
   * @param {Document} doc
   * @returns {boolean} whether GitHub's own view is showing.
   */
  function showingNative(doc) {
    return viewMode(doc) === VIEW_NATIVE;
  }

  /**
   * @param {Document} doc
   * @param {boolean} value
   * @returns {void}
   */
  function setShowingNative(doc, value) {
    setViewMode(doc, value ? VIEW_NATIVE : VIEW_TABLE);
  }

  /**
   * @param {Element} node
   * @param {boolean} hidden
   * @returns {void}
   */
  function setHidden(node, hidden) {
    if (hidden) node.classList.add(HIDDEN_CLASS);
    else node.classList.remove(HIDDEN_CLASS);
  }

  /**
   * Apply the selected view and update the toggle label.
   *
   * @param {Document} doc
   * @returns {void}
   */
  function applyVisibility(doc) {
    const container = doc.querySelector('#advisories');
    if (container === null) return;
    const mode = viewMode(doc);
    for (const node of nativeControls(container)) setHidden(node, mode !== VIEW_NATIVE);
    const root = doc.getElementById(ROOT_ID);
    if (root === null) return;
    const box = root.querySelector('.bghsa-list-box');
    if (box !== null) setHidden(box, mode !== VIEW_TABLE);
    const controls = root.querySelector('.bghsa-list-controls');
    if (controls !== null) setHidden(controls, mode !== VIEW_TABLE);
    const toggle = root.querySelector('.bghsa-list-toggle');
    if (toggle !== null) toggle.textContent = mode === VIEW_NATIVE ? SHOW_TABLE : SHOW_GITHUB;
    // Notify surfaces after the bar is placed and visibility is set.
    for (const surface of [...surfaces]) {
      try {
        surface.show(doc, mode);
      } catch {
        // Continue switching the remaining surfaces if one fails.
      }
    }
  }

  /**
   * Place the extension above GitHub's query form or native rows.
   *
   * @param {Document} doc
   * @returns {{ parent: Element, before: Element } | null}
   */
  function anchor(doc) {
    const container = doc.querySelector('#advisories');
    if (container === null) return null;
    const filter = container.querySelector('repository-advisories-filter');
    const before = filter ?? nativeControls(container)[0] ?? null;
    if (before === null || before.parentElement === null) return null;
    return { parent: before.parentElement, before };
  }

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
   * Replace the existing table or insert it at the current anchor. Retain its
   * data for subsequent row updates and filter changes.
   *
   * @param {Document} doc
   * @param {TableView} view
   * @returns {Element | null} The table, or null if neither an anchor nor an
   *   existing table is available.
   */
  function injectTable(doc, view) {
    views.set(doc, view);
    const root = buildTable(doc, view);
    const existing = doc.getElementById(ROOT_ID);
    const place = anchor(doc);
    if (place !== null) {
      if (existing !== null) existing.remove();
      place.parent.insertBefore(root, place.before);
    } else if (existing !== null) {
      existing.replaceWith(root);
    } else {
      return null;
    }
    ensureStyle(doc);
    applyVisibility(doc);
    return root;
  }

  /**
   * Check whether the table is missing or displaced after a subtree replacement.
   *
   * @param {Document} doc
   * @returns {boolean}
   */
  function outOfPlace(doc) {
    const root = doc.getElementById(ROOT_ID);
    if (root === null) return true;
    const place = anchor(doc);
    return place !== null && root.nextElementSibling !== place.before;
  }

  /**
   * Retain rendered data for row updates and filter changes.
   *
   * @type {WeakMap<Document, TableView>}
   */
  const views = new WeakMap();

  /**
   * Reuse the last render's parsed list when refreshing. Null records a page
   * that did not contain an advisory list.
   *
   * @type {WeakMap<Document, import('../common/parse-list.js').ParsedList | null>}
   */
  const parses = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {import('../common/parse-list.js').ParsedList | null} The last parsed
   *   page, or a new parse before the first render.
   */
  function pageOf(doc) {
    if (parses.has(doc)) return parses.get(doc) ?? null;
    return globalThis.bghsa.parseList.parseList(doc);
  }

  /**
   * @param {Document} doc
   * @returns {{ owner: string, repo: string } | null} The repository identity, or
   *   null when unavailable.
   */
  function refOf(doc) {
    const parsed = pageOf(doc);
    if (parsed === null || parsed.owner === null || parsed.repo === null) return null;
    return { owner: parsed.owner, repo: parsed.repo };
  }

  /**
   * Parse the page and render its advisory table.
   *
   * @param {Document} doc
   * @param {ViewOptions} [options]
   * @returns {Promise<Element | null>}
   */
  async function render(doc, options = {}) {
    const parsed = globalThis.bghsa.parseList.parseList(doc);
    parses.set(doc, parsed);
    if (parsed === null) return null;
    const view = await readView(parsed, options);
    return injectTable(doc, view);
  }

  /**
   * @param {Document} doc
   * @param {string} ghsaId
   * @returns {Element | null} The advisory's rendered row, or null when absent.
   */
  function rowNode(doc, ghsaId) {
    const root = doc.getElementById(ROOT_ID);
    if (root === null) return null;
    for (const item of root.querySelectorAll('[data-bghsa-ghsa]')) {
      if (item.getAttribute('data-bghsa-ghsa') === ghsaId) return item;
    }
    return null;
  }

  /**
   * Update one row in place. Defer sorting and filtering until the refresh
   * finishes to keep visible rows stable. Update filter options immediately.
   * Hidden rows still receive data updates.
   *
   * @param {Document} doc
   * @param {string} ghsaId
   * @param {import('../common/cache.js').CacheEntry} entry
   * @param {ViewOptions} [options]
   * @returns {Promise<boolean>} Whether a rendered row was replaced.
   */
  async function applyEntry(doc, ghsaId, entry, options = {}) {
    const view = views.get(doc);
    const source = view?.sources.get(ghsaId);
    if (view === undefined || source === undefined) return false;
    const row = await viewRow(source, entry, options.at ?? globalThis.bghsa.cache.now());
    const at = view.rows.findIndex((held) => held.ghsaId === ghsaId);
    if (at === -1) return false;
    view.rows[at] = row;
    syncFilterOptions(doc);
    const item = rowNode(doc, ghsaId);
    if (item === null) return false;
    item.replaceWith(buildRow(doc, row));
    return true;
  }

  /**
   * @returns {string} A selector for the table and its stylesheet.
   */
  function ownedSelector() {
    return `#${ROOT_ID}, #${STYLE_ID}`;
  }

  /**
   * Serialize renders to prevent an older storage read from overwriting a
   * newer render. Requests during a render schedule one additional pass.
   *
   * @param {Document} doc
   * @param {RefreshOptions} [options]
   * @returns {() => Promise<void>}
   */
  function renderLoop(doc, options = {}) {
    let running = false;
    let again = false;
    return async function pass() {
      visit(doc, globalThis.location?.pathname);
      if (running) {
        again = true;
        return;
      }
      // Recheck the allowlist: GitHub can change repositories in this document
      // without a navigation event.
      if (!globalThis.bghsa.content.enabled()) return;
      running = true;
      try {
        do {
          again = false;
          await render(doc);
        } while (again);
      } finally {
        running = false;
      }
      ensureRefresh(doc, options);
    };
  }

  /**
   * @type {WeakMap<Document, () => Promise<void>>}
   */
  const loops = new WeakMap();

  /**
   * @param {Document} doc
   * @param {RefreshOptions} [options]
   * @returns {() => Promise<void>} The document's render loop, created on first use.
   */
  function passFor(doc, options = {}) {
    const held = loops.get(doc);
    if (held !== undefined) return held;
    const loop = renderLoop(doc, options);
    loops.set(doc, loop);
    return loop;
  }

  /**
   * @typedef {object} QueueHandle
   * @property {ReturnType<typeof globalThis.bghsa.fetch.createQueue>} queue
   * @property {Set<(ghsaId: string, entry: import('../common/cache.js').CacheEntry) => void>} listening
   */

  /**
   * Share one serial request queue per repository within this page. This
   * coordinates requests from the crawl and every surface.
   *
   * @type {Map<string, QueueHandle>}
   */
  const queues = new Map();

  /**
   * @param {{ owner: string, repo: string }} ref
   * @returns {string} The lowercase owner/repo key.
   */
  function refKey(ref) {
    return `${ref.owner}/${ref.repo}`.toLowerCase();
  }

  /**
   * @param {{ owner: string, repo: string }} ref
   * @param {RefreshOptions} [options]
   * @returns {QueueHandle} The repository's queue, created on first use.
   */
  function queueFor(ref, options = {}) {
    const key = refKey(ref);
    const held = queues.get(key);
    if (held !== undefined) return held;
    /** @type {QueueHandle['listening']} */
    const listening = new Set();
    const queue = globalThis.bghsa.fetch.createQueue({
      ref,
      storage: options.storage,
      now: options.now,
      wait: options.wait,
      fetch: options.fetch,
      onEntry: (ghsaId, entry) => {
        for (const listener of [...listening]) {
          try {
            listener(ghsaId, entry);
          } catch {
            // Continue notifying the remaining listeners if one fails.
          }
        }
      },
    });
    const handle = { queue, listening };
    queues.set(key, handle);
    return handle;
  }

  /**
   * Track the active refresh by document and repository. Soft navigation can
   * change the repository while preserving the document.
   *
   * @type {WeakMap<
   *   Document,
   *   {
   *     key: string,
   *     queue: ReturnType<typeof globalThis.bghsa.fetch.createQueue>,
   *     started: Promise<RefreshSummary | null>,
   *   }
   * >}
   */
  const running = new WeakMap();

  /**
   * The lists the page-load walk reads, in the order it reads them. The open
   * table, the completed view, and the statistics view all read what it finds.
   *
   * @type {readonly string[]}
   */
  const WALK_STATES = Object.keys(globalThis.bghsa.parseList.STATES);

  /**
   * The page load of each document: the repository whose advisory list it
   * shows, by repository key, and when it first showed that list. Moving
   * between the repository's advisory list and its advisory pages keeps the
   * page load, and showing any other page ends it. The page-load walk walks
   * each list once after the page load begins.
   *
   * @type {WeakMap<Document, { key: string, at: number }>}
   */
  const loads = new WeakMap();

  /**
   * The advisory pages each document's location was in at its last render
   * pass: a repository key, or null for a page outside every repository's
   * advisory pages.
   *
   * @type {WeakMap<Document, string | null>}
   */
  const areas = new WeakMap();

  /**
   * @param {Document} doc
   * @param {{ owner: string, repo: string }} ref
   * @param {number} at The time to record when this call begins the page load.
   * @returns {number} When this document's page load began, epoch
   *   milliseconds.
   */
  function loadedAt(doc, ref, at) {
    const key = refKey(ref);
    const held = loads.get(doc);
    if (held !== undefined && held.key === key) return held.at;
    loads.set(doc, { key, at });
    return at;
  }

  /**
   * End the page load when the document's location leaves the advisory pages
   * of the repository it was in, and stop the work of that page load. The
   * next list the document shows begins a new page load and refreshes at once.
   *
   * @param {Document} doc
   * @param {unknown} pathname The location's path.
   * @returns {void}
   */
  function visit(doc, pathname) {
    const here =
      typeof pathname === 'string' ? globalThis.bghsa.content.locate(pathname) : null;
    const area = here === null ? null : refKey(here);
    const was = areas.get(doc);
    areas.set(doc, area);
    if (was === undefined || was === area) return;
    loads.delete(doc);
    refreshed.delete(doc);
    depart(doc, area);
  }

  /**
   * @typedef {object} WalkWatcher
   * @property {(list: import('../common/crawl.js').CrawledList) => void} [onPage]
   *   Called after each list page adds rows.
   * @property {(state: string, url: string, reason: unknown) => void} [onFailure]
   *   Called for each list page the walk could not read.
   */

  /**
   * The walk in progress for each document. A walk is stopped once the
   * document leaves its repository's list, which stops its queue.
   *
   * @type {WeakMap<
   *   Document,
   *   {
   *     key: string,
   *     stopped: boolean,
   *     started: Promise<import('../common/crawl.js').CrawlResult>,
   *     watchers: Set<WalkWatcher>,
   *   }
   * >}
   */
  const walks = new WeakMap();

  /**
   * The last walk of each repository, by repository key, settled either way.
   * Each walk saves its own copy of the repository's lists, so a walk starts
   * after the one before it settles.
   *
   * @type {Map<string, Promise<unknown>>}
   */
  const walked = new Map();

  /**
   * Walk all four lists once for this page load through the shared queue. A
   * call during a walk joins it, unless the document left the walk's list,
   * which stopped it. Any other call walks only a list whose walk has not
   * finished during this page load.
   *
   * @param {Document} doc
   * @param {import('../common/parse-list.js').ParsedList} parsed The page's list,
   *   naming the repository.
   * @param {RefreshOptions} [options]
   * @param {WalkWatcher} [watcher] Receives the pages and failures of the walk.
   * @returns {Promise<import('../common/crawl.js').CrawlResult>}
   */
  function walk(doc, parsed, options = {}, watcher = {}) {
    const ref = {
      owner: /** @type {string} */ (parsed.owner),
      repo: /** @type {string} */ (parsed.repo),
    };
    const key = refKey(ref);
    const since = loadedAt(doc, ref, options.now?.() ?? globalThis.bghsa.cache.now());
    let held = walks.get(doc);
    if (held === undefined || held.key !== key || held.stopped) {
      const { queue } = queueFor(ref, options);
      const pass = passFor(doc, options);
      /** @type {Set<WalkWatcher>} */
      const watchers = new Set();
      const before = walked.get(key) ?? Promise.resolve();
      const started = before
        .then(() =>
          globalThis.bghsa.crawl.crawl({
            ref,
            queue,
            parsed,
            href: options.href ?? globalThis.location?.href,
            storage: options.storage,
            now: options.now,
            states: WALK_STATES,
            since,
            onPage: (list) => {
              // Redraw the table to include advisories discovered by this page.
              void pass();
              for (const each of [...watchers]) {
                try {
                  each.onPage?.(list);
                } catch {
                  // Continue notifying the remaining watchers if one fails.
                }
              }
            },
            onFailure: (state, url, reason) => {
              for (const each of [...watchers]) {
                try {
                  each.onFailure?.(state, url, reason);
                } catch {
                  // Continue notifying the remaining watchers if one fails.
                }
              }
            },
          })
        )
        .finally(() => {
          if (walks.get(doc)?.started === started) walks.delete(doc);
        });
      walked.set(
        key,
        started.then(
          () => {},
          () => {}
        )
      );
      held = { key, stopped: false, started, watchers };
      walks.set(doc, held);
    }
    const { started, watchers } = held;
    watchers.add(watcher);
    return started.finally(() => {
      watchers.delete(watcher);
    });
  }

  /**
   * Walk the lists, then refresh open advisory data through the shared
   * queue. Concurrent calls for this document and repository share the
   * active refresh.
   *
   * @param {Document} doc
   * @param {RefreshOptions} [options]
   * @returns {Promise<RefreshSummary | null>} The refresh result, or null outside an
   *   identified advisory list.
   */
  function refresh(doc, options = {}) {
    const parsed = options.parsed ?? globalThis.bghsa.parseList.parseList(doc);
    if (parsed === null || parsed.owner === null || parsed.repo === null) {
      return Promise.resolve(null);
    }
    const ref = { owner: parsed.owner, repo: parsed.repo };
    const key = refKey(ref);
    const held = running.get(doc);
    if (held !== undefined && held.key === key) return held.started;
    const { queue } = queueFor(ref, options);
    const started = fill(doc, parsed, options).finally(() => {
      // A newer refresh may have replaced this document's entry.
      if (running.get(doc)?.started === started) running.delete(doc);
    });
    running.set(doc, { key, queue, started });
    return started;
  }

  /**
   * @param {ReturnType<typeof globalThis.bghsa.fetch.createQueue>} queue
   * @returns {number} The pending and in-flight advisory count from the shared
   *   queue.
   */
  function leftToRead(queue) {
    const held = queue.progress();
    return held.pending.length + (held.inFlight === null ? 0 : 1);
  }

  /**
   * Load saved queue progress before adding open advisories the walk found.
   *
   * @param {Document} doc
   * @param {import('../common/parse-list.js').ParsedList} parsed
   * @param {RefreshOptions} options
   * @returns {Promise<RefreshSummary>}
   */
  async function fill(doc, parsed, options) {
    const ref = {
      owner: /** @type {string} */ (parsed.owner),
      repo: /** @type {string} */ (parsed.repo),
    };
    const { queue, listening } = queueFor(ref, options);
    const pass = passFor(doc, options);

    /** @type {Promise<unknown>[]} */
    const updates = [];
    /** @type {(ghsaId: string, entry: import('../common/cache.js').CacheEntry) => void} */
    const listener = (ghsaId, entry) => {
      updates.push(applyEntry(doc, ghsaId, entry, { storage: options.storage }));
      setProgress(doc, { phase: 'reading', left: leftToRead(queue) });
    };
    listening.add(listener);

    try {
      setProgress(doc, { phase: 'walking', left: 0 });
      await queue.load();
      const crawled = await walk(doc, parsed, options);
      const open = globalThis.bghsa.crawl.idsIn(
        crawled.list,
        globalThis.bghsa.parseList.OPEN_STATES
      );
      const { queued } = await queue.add(open);
      setProgress(doc, { phase: 'reading', left: queued.length });
      const read = await queue.run();
      await Promise.all(updates);
      // Reapply sorting and filters after all row updates finish.
      await pass();
      return { crawled, read };
    } finally {
      listening.delete(listener);
      setProgress(doc, null);
    }
  }

  /**
   * @type {WeakMap<Document, { key: string, at: number }>}
   */
  const refreshed = new WeakMap();

  /**
   * Stop requests for a repository the document has left. The queue preserves
   * unfinished work. Clear the refresh timestamp to allow immediate resumption
   * if the user returns.
   *
   * @param {Document} doc
   * @param {NonNullable<ReturnType<typeof running.get>>} held
   * @returns {void}
   */
  function leave(doc, held) {
    void held.queue.stop();
    if (running.get(doc) === held) running.delete(doc);
    refreshed.delete(doc);
  }

  /**
   * Stop the work this document holds for any repository but the one it now
   * shows: each surface's, the refresh's, and the walk's.
   *
   * @param {Document} doc
   * @param {string | null} key The repository the document shows, or null
   *   outside an identified list.
   * @returns {void}
   */
  function depart(doc, key) {
    for (const surface of [...surfaces]) {
      if (surface.left === undefined) continue;
      try {
        surface.left(doc, key);
      } catch {
        // Continue stopping the remaining surfaces if one fails.
      }
    }
    const left = running.get(doc);
    if (left !== undefined && left.key !== key) leave(doc, left);
    const walking = walks.get(doc);
    // Leaving stopped the walk's queue, so a return starts or resumes a walk.
    if (walking !== undefined && walking.key !== key) walking.stopped = true;
  }

  /**
   * Check refresh eligibility after each render to handle soft navigation.
   * Stop work for the previous repository and allow one active refresh for
   * the current repository. Throttle new refreshes with the cache threshold.
   * A refresh after the first rereads stale advisories and continues a list
   * walk that has not finished, and walks no list again.
   *
   * @param {Document} doc
   * @param {RefreshOptions} [options]
   * @returns {void}
   */
  function ensureRefresh(doc, options = {}) {
    const parsed = pageOf(doc);
    const key =
      parsed === null || parsed.owner === null || parsed.repo === null
        ? null
        : refKey({ owner: parsed.owner, repo: parsed.repo });
    // Notify each surface on every pass so it can stop work for other repositories.
    depart(doc, key);
    if (parsed === null || key === null) return;
    if (doc.getElementById(ROOT_ID) === null) return;
    if (running.get(doc)?.key === key) return;
    const at = options.now?.() ?? globalThis.bghsa.cache.now();
    const held = refreshed.get(doc);
    if (held?.key === key && at - held.at < globalThis.bghsa.cache.STALE_MS) return;
    refreshed.set(doc, { key, at });
    void refresh(doc, { ...options, parsed });
  }

  /**
   * Watch child mutations for list changes or a displaced table. Visibility
   * class changes do not trigger a render.
   *
   * @param {Document} doc
   * @param {() => Promise<void>} [pass]
   * @returns {MutationObserver | null} The observer, or null when observation is
   *   unavailable.
   */
  function observe(doc, pass = renderLoop(doc)) {
    return globalThis.bghsa.dom.watch(doc, { ownedSelector, outOfPlace, pass });
  }

  /**
   * Render and observe the page through the shared render loop.
   *
   * @returns {MutationObserver | null} The observer, or null when observation is
   *   unavailable.
   */
  function start() {
    const doc = globalThis.document;
    const pass = passFor(doc);
    void pass();
    const observer = observe(doc, pass);
    attached.set(doc, observer);
    return observer;
  }

  /**
   * Retain observers for disconnection by stop.
   *
   * @type {WeakMap<Document, MutationObserver | null>}
   */
  const attached = new WeakMap();

  /**
   * Disconnect the observer before removing the table. Stop refreshes and
   * notify other surfaces to stop their work, then restore GitHub's controls.
   *
   * @param {Document} [doc]
   * @returns {void}
   */
  function stop(doc = globalThis.document) {
    attached.get(doc)?.disconnect();
    attached.delete(doc);
    depart(doc, null);
    loads.delete(doc);
    refreshed.delete(doc);
    areas.delete(doc);
    const container = doc.querySelector('#advisories');
    if (container !== null) for (const node of nativeControls(container)) setHidden(node, false);
    for (const node of doc.querySelectorAll(ownedSelector())) node.remove();
    // Surface stylesheets are outside the table root and need separate removal.
    for (const node of doc.querySelectorAll('style[id^="bghsa-"]')) node.remove();
    views.delete(doc);
    modes.delete(doc);
  }

  const exported = {
    ROOT_ID,
    STYLE_ID,
    HIDDEN_CLASS,
    setHidden,
    STYLE_TEXT,
    SHOW_GITHUB,
    SHOW_TABLE,
    VIEW_TABLE,
    VIEW_NATIVE,
    PARSED_SELECTORS,
    observedTextOf,
    backportsDoneIn,
    avatarUrlFor,
    unreadRow,
    viewRow,
    readView,
    chipsFor,
    NO_VALUE,
    DEFAULT_SORT,
    menu,
    menuItem,
    syncMenus,
    viewCountText,
    FACETS,
    SORTS,
    facetFor,
    defaultViewState,
    matchesFilter,
    sortFor,
    applyView,
    filterOptions,
    RESET_LABEL,
    EMPTY_TEXT,
    WALKING_TEXT,
    FACET_ATTRIBUTE,
    VALUE_ATTRIBUTE,
    ANY_LABEL,
    setViewState,
    progressOf,
    progressChip,
    buildBody,
    refreshBody,
    countTextOf,
    leftToRead,
    buildOwners,
    nativeControls,
    surfaces,
    addSurface,
    viewMode,
    setViewMode,
    showingNative,
    applyVisibility,
    anchor,
    ensureStyle,
    outOfPlace,
    injectTable,
    pageOf,
    refOf,
    render,
    applyEntry,
    refKey,
    queueFor,
    loadedAt,
    visit,
    walk,
    refresh,
    ensureRefresh,
    renderLoop,
    passFor,
    observe,
    start,
    stop,
  };

  globalThis.bghsa.table = exported;

  // src/content.js starts this surface on allowed advisory pages.
  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
