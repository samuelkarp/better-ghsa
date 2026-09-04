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
 * One row of the table: what the list markup said, and what the cached read of
 * the advisory adds to it. Every field the default order sorts on is here, so a
 * row is an `OrderEntry` as it stands.
 *
 * @typedef {object} TableRow
 * @property {string | null} ghsaId
 * @property {string | null} href The advisory's path on github.com.
 * @property {string | null} title
 * @property {string | null} state `Triage` or `Draft`, as GitHub names it.
 * @property {string | null} severity The severity, lowercased.
 * @property {string | null} severityLabel The severity as displayed.
 * @property {string | null} severityClass The color GitHub painted this
 *   advisory's own severity chip with, read off whichever page supplied the
 *   level.
 * @property {boolean} severityConfirmed Whether a maintainer confirmed the
 *   scoring the severity comes from.
 * @property {string | null} openedAt
 * @property {string | null} reporter
 * @property {string[]} owners The logins a maintainer put on the advisory.
 * @property {number} observedAt When this row's data was read, epoch
 *   milliseconds. A row no advisory read backs carries the moment the list
 *   markup was read.
 * @property {boolean} read Whether a cached advisory read backs this row. The
 *   chips that stand for read state are absent while this is false, because
 *   nothing has been read to say they hold.
 * @property {boolean} neverReviewed
 * @property {boolean} newActivity
 * @property {string | null} triage
 * @property {string | null} waitingSince
 * @property {boolean} embargo Whether an embargo applies.
 * @property {string | null} embargoLift
 * @property {boolean} embargoOverdue
 * @property {string | null} patch What the private fork says about the patch,
 *   and null on a row nothing has been read on.
 * @property {number} backportTargets How many branches a maintainer asked for.
 * @property {number} backportsDone How many of them carry an open pull request.
 * @property {string | null} cve What the CVE chip reads, and null where the
 *   advisory has no CVE state to show.
 */

/**
 * One value a surface holds about an advisory, as a filter control reads it.
 * Every facet enumerates, so every one of them backs a filter. The row is the
 * surface's own: this table's rows here, and the completed view's there.
 *
 * @template Row
 * @typedef {object} Facet
 * @property {string} key What the control stores.
 * @property {string} label What the filter control reads while it is holding the
 *   table to nothing.
 * @property {readonly string[]} [values] The order its values belong in, for the
 *   ones this reader knows. Anything else follows them alphabetically.
 * @property {(row: Row) => boolean} [applies] Whether the facet says anything
 *   about this row. A row it does not apply to holds none of its values and
 *   matches none of them, {@link NO_VALUE} included.
 * @property {(row: Row) => string[]} valuesOf What this row holds for the
 *   facet. Empty where it holds nothing, which a read can still fill in.
 */

/**
 * One order the sort control offers.
 *
 * @typedef {object} Sort
 * @property {string} key What the control stores.
 * @property {string} label What the control reads while the table is in this
 *   order.
 * @property {((a: TableRow, b: TableRow) => number) | null} compare How it ranks
 *   two rows, and null for the default order, which `order.compare` settles.
 */

/**
 * The view a maintainer chose over the rows the table holds.
 *
 * @typedef {object} ViewState
 * @property {string} sort A facet key, or the key of the default order.
 * @property {Record<string, string>} filters What each filter is holding the
 *   table to, by facet key. A facet with no entry is holding it to nothing.
 */

/**
 * One advisory as a list page showed it, and when that page was read.
 *
 * @typedef {object} RowSource
 * @property {import('../common/parse-list.js').ListRow} row
 * @property {number} seenAt When the markup this row came from was read, epoch
 *   milliseconds. The page being looked at was read now; a row that is on the
 *   table from the crawl alone was read when the walk that found it ran, which
 *   can be days ago.
 */

/**
 * The table as one render assembled it.
 *
 * @typedef {object} TableView
 * @property {TableRow[]} rows In the default order.
 * @property {number} at The moment the render read the page, epoch milliseconds.
 * @property {Map<string, RowSource>} sources What the list markup said about each
 *   advisory and when it said it, by GHSA identifier. A read landing later
 *   rebuilds its row from this and the entry that arrived, so a row is replaced
 *   where it stands and the rest of the table is left alone.
 */

/**
 * @typedef {object} RefreshOptions
 * @property {import('../common/cache.js').CacheStorage | null} [storage]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [wait]
 * @property {import('../common/write.js').WriteFetch} [fetch]
 * @property {import('../common/parse-list.js').ParsedList} [parsed] The page as
 *   it was read, and absent to read it here.
 * @property {string} [href] The URL of the page being looked at, which is what
 *   says whether it is the first page of its state.
 */

/**
 * How far the refresh a document has running has got, which is what the header
 * says while it runs.
 *
 * @typedef {object} RefreshProgress
 * @property {'walking' | 'reading'} phase Whether it is walking the list pages
 *   or reading the advisories they named.
 * @property {number} left How many advisories are still to read. It is nothing
 *   while the walk runs, which says nothing about how many there will be: the
 *   walk is what finds out.
 */

/**
 * What one refresh of the table did.
 *
 * @typedef {object} RefreshSummary
 * @property {import('../common/crawl.js').CrawlResult} crawled
 * @property {import('../common/fetch.js').QueueSummary} read
 */

/**
 * A surface beside the table, on the same page and under the same choice of
 * view: the control it offers on the bar, and what it does once a view has been
 * put into effect.
 *
 * @typedef {object} Surface
 * @property {(doc: Document) => Element | null} control What it puts on the bar,
 *   beside the toggle that restores GitHub's view. It is built again on every
 *   render, because the bar is.
 * @property {(doc: Document) => Element | null} [controls] What it filters with,
 *   which goes on the bar beside the table's own filters, so one strip carries
 *   every control the page has. It is built again on every render, and the
 *   surface holds it out of view while another view is showing.
 * @property {(doc: Document, mode: string) => void} show Told the view the
 *   document is now on, after the table has been placed and hidden or shown.
 * @property {(doc: Document, key: string | null) => void} [left] Told which
 *   repository the page names after every render, as `owner/repo` in lower
 *   case, and null where it names none or is no longer an advisory list. A
 *   surface with work of its own in flight puts down what it started for a
 *   repository this is not.
 */

/**
 * @typedef {object} ViewOptions
 * @property {import('../common/cache.js').CacheStorage | null} [storage]
 * @property {number} [at] The moment the list markup was read, epoch
 *   milliseconds.
 */

(() => {
  /** The id of the sentinel element the extension owns. */
  const ROOT_ID = 'bghsa-list';

  /**
   * The id of the list surface's stylesheet. The detail panel carries a
   * stylesheet of its own under another id, so neither surface can be left
   * holding the other's rules.
   */
  const STYLE_ID = 'bghsa-list-style';

  /** What marks an element the extension is holding out of view. */
  const HIDDEN_CLASS = 'bghsa-hidden';

  /** Every rule the list surface adds to the page. */
  const STYLE_TEXT = [
    // Primer's own display utilities carry `!important`, so holding one of its
    // elements out of view takes the same weight.
    `.${HIDDEN_CLASS} { display: none !important; }`,
    '.bghsa-list-chips { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    '.bghsa-list-status { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    '.bghsa-list-owners { display: flex; flex-wrap: wrap; gap: 2px; align-items: center; }',
    // `currentColor` is what a foreground falls back to: the page's own text
    // color reads in either theme, where a fixed one would be wrong in one.
    '.bghsa-list-observed { color: var(--fgColor-muted, currentColor); white-space: nowrap; }',
    '.bghsa-list-meta { color: var(--fgColor-muted, currentColor); }',
    '.bghsa-list-empty { color: var(--fgColor-muted, currentColor); }',
    ...globalThis.bghsa.chips.TONE_RULES,
    ...globalThis.bghsa.chips.FILL_RULES,
    `.${globalThis.bghsa.chips.DIM_CLASS} { opacity: 0.55; }`,
  ].join('\n');

  /** What the sort control reads while the table is in its default order. */
  const DEFAULT_SORT_LABEL = 'Default';

  /** What the control that goes back to the default order reads. */
  const RESET_LABEL = 'Reset';

  /** What stands in the table where a filter keeps no row. */
  const EMPTY_TEXT = 'No matches';

  /**
   * What the header says while the refresh is walking the list pages. The walk
   * has no count to give: it is finding out how many advisories there are.
   */
  const WALKING_TEXT = 'Loading...';

  /** What names the facet one filter control holds the table to. */
  const FACET_ATTRIBUTE = 'data-bghsa-facet';

  /** What names the value one menu item holds its control to. */
  const VALUE_ATTRIBUTE = 'data-bghsa-value';

  /** What the sort control reads. */
  const SORT_LABEL = 'Sort';

  /** What the item of a filter that holds the table to nothing reads. */
  const ANY_LABEL = 'Any';

  /** The namespace an octicon's elements belong to. */
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * The check GitHub draws on every item of a `SelectMenu`. A checked item and
   * an unchecked one carry the same markup: Primer keys the check on
   * `[aria-checked="true"]`, so every item carries one and the stylesheet says
   * which is shown.
   */
  const CHECK_PATH =
    'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1' +
    ' .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z';

  /** The cross on the button that closes a menu. */
  const CLOSE_PATH =
    'M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1' +
    '-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22' +
    ' 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1' +
    ' 0-1.06Z';

  /** What the toggle reads while the extension's table is showing. */
  const SHOW_GITHUB = "Show GitHub's view";

  /** What the toggle reads while GitHub's own view is showing. */
  const SHOW_TABLE = 'Show Better GHSA';

  /** The view the list page comes up on. */
  const VIEW_TABLE = 'table';

  /** The view that is GitHub's own rows and controls. */
  const VIEW_NATIVE = 'native';

  /**
   * The selectors `parse-list` keys on inside `div#advisories`. Nothing the
   * table inserts may match one of them: the table sits in the element the
   * parser reads, and a row of its own read back as a row of GitHub's would
   * double every advisory on the next pass.
   *
   * @type {readonly string[]}
   */
  const PARSED_SELECTORS = ['div.Box-row--drag-hide', 'segmented-control', 'a[rel="next"]'];

  /** How every surface builds an element. */
  const element = globalThis.bghsa.dom.element;

  /** How every surface cases a stored value. */
  const sentenceCase = globalThis.bghsa.chips.sentenceCase;

  /** What the patch chip reads while the fork holds an open pull request. */
  const PATCH_IN_REVIEW = globalThis.bghsa.chips.PATCH_IN_REVIEW;

  /** What the patch chip reads while the fork holds no pull request. */
  const NO_PATCH = globalThis.bghsa.chips.NO_PATCH;

  /**
   * What the Embargo filter offers for an advisory under one. It is the wording
   * on the editor checkbox that produces the state.
   */
  const EMBARGO_SET_VALUE = 'In force';

  /** What the Patch filter offers for a draft whose fork holds an open pull request. */
  const PATCH_IN_REVIEW_VALUE = 'In review';

  /** What the Patch filter offers for a draft whose fork holds no open pull request. */
  const NO_PATCH_VALUE = 'No patch';

  /** The state GitHub gives an advisory nobody has published or closed yet. */
  const DRAFT_STATE = globalThis.bghsa.chips.DRAFT_STATE;

  /**
   * How far the backports have got: the branches a maintainer asked for that
   * the private fork holds an open pull request against, which is how many
   * backports have been prepared.
   *
   * REQUIREMENTS.md section 6 has the fork deleted when its changes merge, so a
   * merged pull request is never visible here. The fork's pull requests all
   * merge together, so a partial merge is not observable either.
   *
   * @param {import('../common/derive.js').PatchState} patch
   * @param {readonly string[]} backports The branches a maintainer asked for.
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
   * What the CVE chip reads. An assigned CVE reads as the identifier itself,
   * which is the value a maintainer is looking for. An advisory with no CVE
   * state has no chip.
   *
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
   * A row carrying nothing but what the list markup said.
   *
   * @param {import('../common/parse-list.js').ListRow} listRow
   * @param {number} seenAt When the markup this row came from was read, which is
   *   the moment the row stands for.
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
    };
  }

  /**
   * One row, from what the cache holds of that advisory and from the list markup
   * that named it.
   *
   * A row carries one observation time, so what stands under that time is one
   * observation. Where an advisory read backs the row, the read supplies every
   * value it holds and the row is stamped with the moment it was taken, and the
   * list markup fills in only what the read does not hold. The identifier and
   * the path are the advisory's own, and are neither read nor observed.
   *
   * @param {RowSource} source The advisory as a list page showed it.
   * @param {import('../common/cache.js').CacheEntry | null} entry
   * @param {number} at The moment this render is happening, which is what says
   *   whether an embargo has run out.
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
      // The color comes from whichever read supplied the level, so a severity
      // the advisory page has since changed is not painted the old one's color.
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
    };
  }

  /**
   * @param {import('../common/parse-list.js').ListRow} row
   * @param {string | null} selected The `?state=` the page is showing.
   * @returns {string | null} the `?state=` this row belongs to. A row's own chip
   *   names it where the row carries one, and the tab the page is showing names
   *   it where the row does not.
   */
  function stateOfRow(row, selected) {
    return globalThis.bghsa.crawl.stateKeyOf(row.state) ?? selected;
  }

  /**
   * Every open advisory the table shows: the union of `?state=triage` and
   * `?state=draft` as the crawl holds it, and the rows of the page being looked
   * at.
   *
   * The page wins where both name an advisory, because GitHub rendered it now
   * and the crawl's copy is as old as the walk that found it. Each source
   * carries when it was read, which is what its row stands for until an advisory
   * read backs it. A published or closed advisory is not on this table, so a
   * page showing one of those tabs contributes rows to nothing.
   *
   * @param {import('../common/parse-list.js').ParsedList} parsed
   * @param {ViewOptions} [options]
   * @returns {Promise<Map<string, RowSource>>} by GHSA identifier.
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
   * The rows of the table, in the default order, from the crawl of both open
   * states, from the list markup on the page, and from what the cache holds of
   * the advisories they name.
   *
   * Nothing here waits on the network. The table paints from what is already
   * known, and the reads that fill it in arrive afterwards.
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
   * The chips under one row's title, in the order REQUIREMENTS.md section 9
   * lists them.
   *
   * A chip standing for a boolean is there while the condition holds and absent
   * while it does not. Color carries where the work stands, so the row is
   * readable before any of it is read.
   *
   * The scoring confirmation rides on the severity chip, because the scoring
   * track is the severity and its vector, and a second chip beside the severity
   * would say the same thing twice. Where the advisory sets no severity there is
   * no chip to ride, and the confirmation stands on its own. The severity takes
   * GitHub's own color, and takes it dimmed while nobody has confirmed it.
   *
   * @param {TableRow} row
   * @returns {import('../common/chips.js').ChipSpec[]}
   */
  function chipsFor(row) {
    /** @type {import('../common/chips.js').ChipSpec[]} */
    const chips = [];

    // The waiting state is what an advisory read says, so it is absent until one
    // has been read. Nothing on the list page names it.
    if (row.read) chips.push(...globalThis.bghsa.chips.waitingChips(row));

    // The patch chip stands on a draft and on no other. An advisory in triage
    // has not been accepted, so no patch is owed for it yet and its absence
    // says nothing.
    if (row.state === DRAFT_STATE && row.patch !== null) {
      chips.push(globalThis.bghsa.chips.patchChip(row.patch));
    }
    if (row.backportTargets > 0) {
      /** @type {import('../common/chips.js').ChipSpec} */
      const backports = { text: `Backports ${row.backportsDone} of ${row.backportTargets}` };
      if (row.backportsDone < row.backportTargets) backports.tone = 'attention';
      chips.push(backports);
    }
    if (row.cve !== null) chips.push({ text: row.cve });

    // A confirmed severity is the ordinary case and reads as the level alone,
    // filled with the color GitHub painted it. A row nothing has been read on
    // says nothing either way, and its whole row is dim, so the level stands
    // bare there too.
    if (row.severityLabel !== null) {
      const severity = sentenceCase(row.severityLabel);
      chips.push({
        text: row.read && !row.severityConfirmed ? `${severity}, unconfirmed` : severity,
        severityClass: row.severityClass,
        dim: !row.severityConfirmed,
        fill: row.severityConfirmed,
      });
    }

    // A row carries no labels, so each chip names the thing it is about. The
    // three cases are the ones the panel's embargo row shows.
    if (row.embargo || row.embargoOverdue) {
      const lift = row.embargoLift;
      if (lift === null) chips.push({ text: 'Embargo, no lift date', tone: 'attention' });
      else if (row.embargoOverdue) {
        chips.push({ text: `Embargo overdue since ${lift}`, tone: 'danger' });
      } else chips.push({ text: `Embargo lifts ${lift}`, tone: 'attention' });
    }

    return chips;
  }

  /**
   * What a filter offers for a row that holds no value for its facet.
   */
  const NO_VALUE = 'None';

  /**
   * The sort key of the default order. It is the tiering in REQUIREMENTS.md
   * section 9, which is what the table shows until a maintainer picks another
   * value to order by, and what the sort control comes back to.
   */
  const DEFAULT_SORT = 'default';

  /**
   * The last tie-break under every sort, so that no order depends on the order
   * the rows arrived in. It is `order.byId`, reached through the comparator
   * that file holds, so the two sorts settle a row whose identifier went unread
   * the same way: below every row whose identifier is known.
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
   * @returns {number} the severity's rank where its confirmation is the one
   *   asked for, and 0 where it is not. This is the two-key rule the default
   *   order uses: every severity a maintainer confirmed ranks above every
   *   severity nobody has confirmed.
   */
  function severityScore(row, confirmed) {
    if (row.severityConfirmed !== confirmed) return 0;
    return globalThis.bghsa.order.severityRank(row.severity);
  }

  /**
   * @param {TableRow} row
   * @returns {string[]} where the branches a maintainer asked for stand, and
   *   nothing for an advisory nobody asked for a backport on.
   */
  function backportValuesOf(row) {
    if (row.backportTargets === 0) return [];
    return [row.backportsDone >= row.backportTargets ? 'Complete' : 'Outstanding'];
  }

  /**
   * The patch state, without the word the chip repeats, and only on the rows
   * that show a patch chip. The chip stands on a draft and on no other, so a
   * triage advisory holding an open pull request does not filter under a value
   * its row never shows. A state this reader could not judge holds no value
   * either, because `Unknown` is what the row says instead of an answer.
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
   * @returns {string[]} which side the advisory is waiting on, and nothing while
   *   nothing has been read: the waiting state is what an advisory read says,
   *   and a row the extension has not reached yet holds no answer either way.
   */
  function waitingValuesOf(row) {
    if (!row.read) return [];
    return [sentenceCase(globalThis.bghsa.order.waitingStateOf(row))];
  }

  /**
   * Every value a row holds, as the filter controls read it.
   *
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
   * The orders the sort control offers, in the order it offers them. Each puts
   * what a maintainer is looking for at the top: the longest waiting, the
   * highest severity.
   *
   * The default order leads, because it is the tiering in REQUIREMENTS.md
   * section 9 and it is what the table comes up on. A sort exists for looking
   * at the list another way, and the default order is the way it is worked.
   *
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
   * @returns {Facet<TableRow> | null} the facet that key names, and null for a
   *   key this reader does not know.
   */
  function facetFor(key) {
    return FACETS.find((facet) => facet.key === key) ?? null;
  }

  /**
   * @returns {ViewState} the view the table comes up in and the view the reset
   *   goes back to: the default order, filtering nothing.
   */
  function defaultViewState() {
    return { sort: DEFAULT_SORT, filters: {} };
  }

  /**
   * Whether the table is showing what it comes up on: the default order, with
   * every filter holding it to nothing. That is where the reset goes, so from
   * there it has nothing to do.
   *
   * @param {ViewState} state
   * @returns {boolean}
   */
  function isDefaultView(state) {
    if (state.sort !== DEFAULT_SORT) return false;
    return Object.values(state.filters).every((value) => value === '');
  }

  /**
   * Whether one row passes one filter.
   *
   * A row no advisory read backs holds less than one a read does, and a filter
   * does not hide a row over a value nobody has looked up yet: such a row passes
   * every filter over a facet a read supplies, and drops out of the ones it
   * turns out not to match once its read lands. A row a read does back and that
   * holds nothing for the facet passes only {@link NO_VALUE}, and a row the
   * facet says nothing about passes no value of it at all.
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
   * @returns {boolean} whether every filter the view is holding keeps this row.
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
   * The comparator one sort runs: the sort's own, and then the identifier, so
   * that no sort depends on the order the rows arrived in.
   *
   * @param {string} key
   * @returns {((a: TableRow, b: TableRow) => number) | null} null for the
   *   default order, and for a key this reader does not know, both of which
   *   `order.compare` settles.
   */
  function sortFor(key) {
    const held = SORTS.find((sort) => sort.key === key)?.compare ?? null;
    if (held === null) return null;
    return (a, b) => held(a, b) || byGhsaId(a, b);
  }

  /**
   * The view each document is showing. It is held here rather than read off the
   * controls, because a pass takes the table out and puts a new one back, and a
   * maintainer's chosen view has to survive that.
   *
   * @type {WeakMap<Document, ViewState>}
   */
  const viewStates = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {ViewState} the view that document is showing, which is the default
   *   until a control says otherwise.
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
   * The rows a view shows, in the order it puts them in.
   *
   * This is a view over what the table already holds. Nothing is read again and
   * nothing is fetched: filtering and sorting move rows the extension has, and a
   * row it has not read yet is still a row.
   *
   * A sort key this reader does not know leaves the default order, so a view
   * carrying one shows the table as it stands rather than showing nothing.
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
   * The values one filter offers: what the rows hold for that facet, followed by
   * {@link NO_VALUE} where a row a read backs holds none.
   *
   * A value the filter is already holding to stays on offer even after the last
   * row carrying it leaves, so a read landing cannot take the control out from
   * under the view a maintainer is looking at.
   *
   * @template {{ read: boolean }} Row
   * @param {readonly Row[]} rows
   * @param {Facet<Row>} facet
   * @param {string} selected What the filter is holding to, and the empty string
   *   for one holding to nothing.
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
   * The size an owner icon is drawn at.
   * `testdata/published-containerd.html` shows GitHub drawing a collaborator
   * avatar at 20 pixels from a source asked for at `s=40`, so the image is
   * requested at twice the size it is drawn at and reads sharp on a display
   * that doubles pixels.
   */
  const AVATAR_PIXELS = 20;

  /** The size the avatar image is asked for, in pixels. */
  const AVATAR_SOURCE_PIXELS = AVATAR_PIXELS * 2;

  /**
   * The avatar GitHub serves for one login.
   *
   * Every avatar in every capture under `testdata/` is keyed on the account's
   * numeric id, `https://avatars.githubusercontent.com/u/{id}?s=40&v=4`, and an
   * owner login arrives from a state comment with no id beside it. GitHub also
   * serves `https://github.com/{login}.png?size={n}`, which redirects to that
   * id-keyed form: `samuelkarp` answers with
   * `https://avatars.githubusercontent.com/u/737750?s=40&v=4`, verified in a
   * browser on 2026-08-27.
   *
   * A login that names no account and a request that fails both leave the image
   * blank, and the icon falls back to the login in its `alt`. Neither is known
   * here, so every login gets a source and the browser decides what arrives.
   *
   * @param {string} login
   * @returns {string}
   */
  function avatarUrlFor(login) {
    return `https://github.com/${encodeURIComponent(login)}.png?size=${AVATAR_SOURCE_PIXELS}`;
  }

  /**
   * The owners, as the profile icons an issue carries for its assignees: the
   * `img.avatar.avatar-user` inside a link to the profile that GitHub uses for a
   * collaborator.
   *
   * The login travels in `alt` and in `title`, so an owner whose image does not
   * load is still named and the row still renders.
   *
   * An owner login arrives from a state comment, which is text anyone who can
   * comment on the advisory can write, so it is encoded into the profile path
   * the same way it is encoded into the avatar source beside it.
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
   * One row: the title as a link, the line GitHub's row carried, the chips, and
   * then the owners, the state, and when this row's data was read.
   *
   * The three cells are in the order the completed list puts its own three in,
   * so a maintainer moving between the two views finds the state and the
   * observation in the same place.
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
      // The state chip says what state the advisory is in and nothing else, so
      // it is dimmed whatever else the row holds: color never carries a fact a
      // chip's words leave out. A draft with no patch takes a chip of its own
      // beside the title.
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
   * The done view draws the same cell, so it takes the fields the answer is
   * built from rather than a table row.
   *
   * @param {{ read: boolean, observedAt: number | null }} row
   * @returns {string} when this row's data was read. A row no advisory read
   *   backs says so: the moment its list markup was read is when GitHub's own
   *   row was seen, not when the advisory behind it was.
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
   * @returns {Element} one octicon, drawn the size GitHub draws them. An SVG
   *   element takes its class through the attribute, because the property that
   *   carries it is not a string.
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
   * One item of a menu. GitHub's own items are anchors that navigate; picking a
   * value here moves rows the table already holds, so this is a button, it
   * carries no `href`, and the surface handles the press.
   *
   * @param {Document} doc
   * @param {string} value What picking it holds the control to.
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
   * One control, in the shape GitHub builds its own table header menus in:
   * `details` plus `summary` plus `details-menu`, with a `SelectMenu` inside
   * and no `select` and no `option` anywhere, which `testdata/select-menu.html`
   * captures.
   *
   * The surface runs inside the page, so Primer's stylesheet paints this and
   * GitHub's `details-menu` element gives it arrow keys across the items,
   * Escape to close and typeahead. Whether the menu is open rides on the native
   * `details`, so nothing here carries `aria-expanded`.
   *
   * @param {Document} doc
   * @param {string} className What names this control among the others.
   * @param {string} label What the control reads, and what its menu is titled.
   * @param {string} value What it is holding to, which the summary carries after
   *   the label, and the empty string for one holding to nothing.
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

    // The close button is the way out of the menu on a narrow viewport, where
    // Primer draws it as a full screen modal. GitHub's carries a
    // `data-toggle-for` for its own behavior to act on; this one is closed
    // here, so one press has one owner.
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
   * @returns {Element[]} what one filter offers: the item that holds the table
   *   to nothing, then the values the rows hold.
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
   * The controls the table carries: what the rows are ordered by, what each
   * value is holding the table to, and the way back to the default.
   *
   * They take the place GitHub's segmented control and query form are held out
   * of, and they carry none of the classes `parse-list` keys on.
   *
   * The default order is not one sort among others. It is the tiering in
   * REQUIREMENTS.md section 9, it is what the sort control comes up on, and the
   * reset is what gets back to it along with everything the filters are holding.
   *
   * @param {Document} doc
   * @param {readonly TableRow[]} rows What the table holds, which is what the
   *   filters offer the values of.
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
   * Draws the controls again from the view the document is now showing, which
   * is what puts every menu on the item that view names and every summary on
   * the value it is holding to.
   *
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
    // The controls go out of view with the table. A redraw while GitHub's own
    // view is showing must not bring them back.
    if (held.classList.contains(HIDDEN_CLASS)) fresh.classList.add(HIDDEN_CLASS);
    held.replaceWith(fresh);
  }

  /**
   * Puts the values one set of filters offers on what its rows now hold,
   * leaving what each filter is holding to alone. A read landing can turn up an
   * owner or a patch state no row carried before, and the control offers it
   * from then on.
   *
   * Only a menu whose items changed is rebuilt, and the control itself is never
   * replaced, so a read landing neither shuts a menu a maintainer is reading
   * nor moves the one they are pointing at.
   *
   * @param {Element} box The controls to bring up to date.
   * @param {(key: string) => readonly Element[] | null} itemsFor What the menu
   *   of that facet should offer now, and null for a control the caller does
   *   not know.
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
   * The table's own filters, brought up to date. The bar carries another
   * surface's filters beside these, and a facet key means what the surface that
   * drew it says it means, so this reads its own controls and no others.
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
   * @returns {string} what the header says is showing, which names both counts
   *   while a filter is keeping rows out.
   */
  function viewCountText(shown, held) {
    return shown === held ? countTextOf(held) : `${shown} of ${countTextOf(held)}`;
  }

  /**
   * How far the refresh each document has running has got, and absent on a
   * document with none. A render rebuilds the whole table, so what the header
   * says is held here and not only in the node.
   *
   * @type {WeakMap<Document, RefreshProgress>}
   */
  const progresses = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {RefreshProgress | null} how far this document's refresh has got,
   *   and null where it has none running.
   */
  function progressOf(doc) {
    return progresses.get(doc) ?? null;
  }

  /**
   * What the header says the refresh is doing. It is dimmed like every other
   * chip: color is kept for a condition a maintainer has to act on, and a
   * refresh that is running finishes on its own.
   *
   * @param {Document} doc
   * @param {RefreshProgress | null} held
   * @returns {Element | null} the chip, and null where there is nothing to say:
   *   no refresh is running, or one is running with nothing left to read.
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
   * Says what the refresh is doing, in the header of the table this document is
   * showing. The chip is written where it stands, because a refresh reports
   * after every advisory it reads and drawing the table again for each of them
   * would throw away what the reader was looking at.
   *
   * @param {Document} doc
   * @param {RefreshProgress | null} held What it is doing, and null where it
   *   has stopped doing anything.
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
   * The rows the table shows. A filter that keeps nothing says so, so that a
   * table holding rows a filter is hiding does not read as a broken one.
   *
   * @param {Document} doc
   * @param {readonly TableRow[]} shown
   * @param {number} held How many rows the table holds.
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
   * Draws the rows again under the view the document is showing. The controls
   * are left as they are, so changing one does not take the focus off it.
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
   * The extension's surface: a bar carrying the controls and the toggle, which
   * is visible in either view, and the table, which the toggle holds out of
   * view along with the controls that act on it.
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
    // A surface that filters puts its controls here, beside the table's own.
    // One of the sets is in view at a time, and the surface holding it says
    // which.
    for (const surface of [...surfaces]) {
      if (surface.controls === undefined) continue;
      /** @type {Element | null} */
      let filters = null;
      try {
        filters = surface.controls(doc);
      } catch {
        // A surface that cannot build its filters leaves the bar as it is.
      }
      if (filters !== null) bar.append(filters);
    }
    // The toggles are one group. Each of them switches the same thing, which is
    // which view the page shows, and GitHub words a set of buttons over one
    // thing as a `BtnGroup`. A surface's control is made a member of the group
    // here, so the surface has nothing to know about where it lands.
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
        // A surface that cannot build its control leaves the bar as it is.
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
   * The surfaces beside the table.
   *
   * @type {Surface[]}
   */
  const surfaces = [];

  /**
   * @param {Surface} surface
   * @returns {void} takes a surface onto the list page. A module registers once,
   *   when it loads, and the page draws it from then on.
   */
  function addSurface(surface) {
    surfaces.push(surface);
  }

  /**
   * GitHub's own controls, which the table holds out of view while it is
   * showing: the Box carrying the segmented control and the native rows, the
   * query form, and the pagination. The segmented control and the rows are one
   * element, so restoring them is one act and cannot restore half.
   *
   * GitHub keeps its pagination outside that Box, so holding the Box out of
   * view leaves the pagination on screen over rows it did not draw and cannot
   * page. It goes and comes back with the rest of GitHub's controls. The Box
   * stays first in the list, because that is what the table anchors itself
   * above.
   *
   * @param {Element} container The `div#advisories`.
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
   * Which view each document is showing. The table is showing unless a press
   * asked for another, so a fresh page and a re-render after a subtree
   * replacement both come up on it.
   *
   * The three views are one choice held in one place. A surface that showed
   * itself without saying so would leave two tables on the page, and a press on
   * either toggle would have nothing to take the page back from.
   *
   * @type {WeakMap<Document, string>}
   */
  const modes = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {string} the view this document is showing: {@link VIEW_TABLE},
   *   {@link VIEW_NATIVE}, or the mode a surface named.
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
   * @returns {void} holds `node` out of view, or puts it back. Nothing is taken
   *   out of the document: the maintainer gets GitHub's own view back whole.
   */
  function setHidden(node, hidden) {
    if (hidden) node.classList.add(HIDDEN_CLASS);
    else node.classList.remove(HIDDEN_CLASS);
  }

  /**
   * Puts the view the document is on into effect: one of the two tables is
   * showing, the toggle is showing in either, and it reads what pressing it
   * does.
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
    // The controls act on the extension's table, so they go out of view with it.
    const controls = root.querySelector('.bghsa-list-controls');
    if (controls !== null) setHidden(controls, mode !== VIEW_TABLE);
    const toggle = root.querySelector('.bghsa-list-toggle');
    if (toggle !== null) toggle.textContent = mode === VIEW_NATIVE ? SHOW_TABLE : SHOW_GITHUB;
    // The surfaces are told last, so each of them draws into a bar that is
    // already placed and reads a view that is already in effect. One that
    // throws does not keep the next from being told.
    for (const surface of [...surfaces]) {
      try {
        surface.show(doc, mode);
      } catch {
        // A surface that cannot draw itself is not a reason to leave the rest
        // of the page half switched.
      }
    }
  }

  /**
   * Where the table goes: in `div#advisories`, above GitHub's query form and the
   * Box holding its segmented control and its rows, so the toggle sits at the
   * top of the list in either view.
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
   * @returns {void} adds the list surface's stylesheet once.
   */
  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID) !== null) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    (doc.head ?? doc.documentElement ?? doc.body)?.append(style);
  }

  /**
   * Places the table, and holds the view it drew, which is what a read landing
   * and a control changing draw from afterwards. Placement is keyed on the
   * sentinel element, so injecting twice leaves one table and re-injecting after
   * GitHub replaced the subtree puts one back.
   *
   * @param {Document} doc
   * @param {TableView} view
   * @returns {Element | null} the table, or null when the page offers no anchor.
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
   * Whether the document needs the table placed: it carries no sentinel, or it
   * carries one that no longer sits at the anchor because GitHub replaced the
   * subtree under it.
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
   * What the last render of each document assembled. A read landing afterwards
   * rebuilds one row from it, and a control changing draws the rows again from
   * it, so neither goes back to storage or to the page.
   *
   * @type {WeakMap<Document, TableView>}
   */
  const views = new WeakMap();

  /**
   * The page as the last render of each document read it, and null where that
   * render found no advisory list on it.
   *
   * A render reads the page to draw the table, and the refresh that follows
   * needs the same reading to learn which repository the page names. Renders
   * run on every mutation burst GitHub produces and a list page is not small,
   * so the reading is held here and taken back.
   *
   * @type {WeakMap<Document, import('../common/parse-list.js').ParsedList | null>}
   */
  const parses = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {import('../common/parse-list.js').ParsedList | null} the page as
   *   the last render of this document read it, and the page read here where no
   *   render has run on it.
   */
  function pageOf(doc) {
    if (parses.has(doc)) return parses.get(doc) ?? null;
    return globalThis.bghsa.parseList.parseList(doc);
  }

  /**
   * @param {Document} doc
   * @returns {{ owner: string, repo: string } | null} the repository the page
   *   names, and null where it names none. It is the reading the last render
   *   took, so asking costs no second parse of the page.
   */
  function refOf(doc) {
    const parsed = pageOf(doc);
    if (parsed === null || parsed.owner === null || parsed.repo === null) return null;
    return { owner: parsed.owner, repo: parsed.repo };
  }

  /**
   * Reads the page and places the table. Returns null when the document is not
   * an advisory list page, or when it offers no anchor.
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
   * @returns {Element | null} the row standing for that advisory. The identifier
   *   is compared rather than put into a selector, because it is read off a page
   *   GitHub rendered and a selector would have to be escaped to hold it.
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
   * Puts one advisory's read into the table, where its row stands. The rest of
   * the table is left alone: a pass reads one advisory a second, and rebuilding
   * every row for each of them would throw away what the reader was looking at.
   *
   * The row keeps its place and it keeps showing. A read can change the tier the
   * row sorts in and it can turn up a value the filter that is holding the table
   * does not match, and neither moves the row nor takes it away: the sort and the
   * filter a maintainer picked are settled by the render that follows the pass,
   * so a view is not rearranged under whoever is reading it. The values the
   * filters offer take the read in at once, because a control is not a place to
   * be reading a value the table no longer holds.
   *
   * @param {Document} doc
   * @param {string} ghsaId
   * @param {import('../common/cache.js').CacheEntry} entry
   * @param {ViewOptions} [options]
   * @returns {Promise<boolean>} whether a row was replaced. An advisory the
   *   table is not showing has none, and neither has one a filter is holding out
   *   of view, whose row the table still takes in.
   */
  async function applyEntry(doc, ghsaId, entry, options = {}) {
    const view = views.get(doc);
    const source = view?.sources.get(ghsaId);
    if (view === undefined || source === undefined) return false;
    const row = await viewRow(source, entry, options.at ?? globalThis.bghsa.cache.now());
    // The render built a row for every source, and the source was just found,
    // so the view is holding this advisory's row.
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
   * @returns {string} what the nodes the extension owns match: the table and its
   *   stylesheet.
   */
  function ownedSelector() {
    return `#${ROOT_ID}, #${STYLE_ID}`;
  }

  /**
   * A render loop for one document, running one pass at a time. A pass is
   * asynchronous because it reads storage, and two running together would each
   * read the page and then write the table, so the one that finished last would
   * put back what it read first. A request arriving while a pass runs takes a
   * pass of its own after it, and further requests during the same pass fold
   * into that one.
   *
   * @param {Document} doc
   * @param {RefreshOptions} [options] What the refresh a pass starts reads and
   *   waits with.
   * @returns {() => Promise<void>}
   */
  function renderLoop(doc, options = {}) {
    let running = false;
    let again = false;
    return async function pass() {
      if (running) {
        again = true;
        return;
      }
      // The gate the whole extension turns on, asked again on every pass.
      // Starting is gated too, and a started document is not a page: GitHub
      // turns one document into a page on another repository, and a pass driven
      // by that swap arrives with no navigation event of its own.
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
   * The render loop each document runs its passes through.
   *
   * @type {WeakMap<Document, () => Promise<void>>}
   */
  const loops = new WeakMap();

  /**
   * @param {Document} doc
   * @param {RefreshOptions} [options] What the refresh a pass starts reads and
   *   waits with, used when this document has no loop yet.
   * @returns {() => Promise<void>} that document's loop, made on first use.
   */
  function passFor(doc, options = {}) {
    const held = loops.get(doc);
    if (held !== undefined) return held;
    const loop = renderLoop(doc, options);
    loops.set(doc, loop);
    return loop;
  }

  /**
   * One repository's refresh queue, and whoever is listening to what it reads.
   *
   * @typedef {object} QueueHandle
   * @property {ReturnType<typeof globalThis.bghsa.fetch.createQueue>} queue
   * @property {Set<(ghsaId: string, entry: import('../common/cache.js').CacheEntry) => void>} listening
   */

  /**
   * The one queue each repository's requests go through, by `owner/repo`.
   *
   * One throttled serial queue serves a repository. A second instance would
   * hold the rate privately, and the only thing bounding the two would be each
   * of them re-reading the claim the other persisted, so neither the crawl nor a
   * second surface makes one of its own.
   *
   * @type {Map<string, QueueHandle>}
   */
  const queues = new Map();

  /**
   * @param {{ owner: string, repo: string }} ref
   * @returns {string} what names one repository here. GitHub treats an owner and
   *   a repository name case-insensitively, so two spellings of one repository
   *   are one repository.
   */
  function refKey(ref) {
    return `${ref.owner}/${ref.repo}`.toLowerCase();
  }

  /**
   * @param {{ owner: string, repo: string }} ref
   * @param {RefreshOptions} [options] What the queue reads and waits with, used
   *   when this repository has no queue yet.
   * @returns {QueueHandle} this repository's queue, made on first use.
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
            // One surface failing to draw a row is not a reason to keep the
            // read from the next one.
          }
        }
      },
    });
    const handle = { queue, listening };
    queues.set(key, handle);
    return handle;
  }

  /**
   * The refresh each document has running, and the repository it is for, so that
   * a render the refresh itself asked for cannot start a second one beside it.
   *
   * The repository is held beside the promise because GitHub replaces the turbo
   * frame on a soft navigation and keeps the document. One document therefore
   * covers a list of one repository and then a list of another, and a refresh
   * of the first is not a refresh of the second.
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
   * Fills the table in: it walks both open states of the list, then reads the
   * advisories they name, stalest first, at one request per second, with each
   * row updating where it stands as its read lands.
   *
   * Calling it while one is running on the same repository joins that one. A
   * page that has come to name another repository is another refresh.
   *
   * @param {Document} doc
   * @param {RefreshOptions} [options]
   * @returns {Promise<RefreshSummary | null>} null where the page is not an
   *   advisory list, or does not say which repository it belongs to.
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
      // A refresh of another repository may have taken the entry over while
      // this one was finishing, and that one is the one still running.
      if (running.get(doc)?.started === started) running.delete(doc);
    });
    running.set(doc, { key, queue, started });
    return started;
  }

  /**
   * @param {ReturnType<typeof globalThis.bghsa.fetch.createQueue>} queue
   * @returns {number} how many advisories that queue has still to read. The
   *   count comes off the queue rather than off a tally kept here, because the
   *   queue is shared: another surface on this page queues advisories through
   *   it, and a pass an earlier page load left behind is taken back into it.
   */
  function leftToRead(queue) {
    const held = queue.progress();
    return held.pending.length + (held.inFlight === null ? 0 : 1);
  }

  /**
   * One refresh, from the crawl to the last row.
   *
   * A pass an earlier page load left unfinished is taken back before anything
   * is queued, so an advisory that pass had already read is not read again.
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
      const crawled = await globalThis.bghsa.crawl.crawl({
        ref,
        queue,
        parsed,
        href: options.href ?? globalThis.location?.href,
        storage: options.storage,
        now: options.now,
        // A page of the list carries advisories the table was not showing, so
        // the whole table is drawn again rather than one row of it.
        onPage: () => {
          void pass();
        },
      });
      const { queued } = await queue.add(crawled.ids);
      setProgress(doc, { phase: 'reading', left: queued.length });
      const read = await queue.run();
      await Promise.all(updates);
      // The rows are current and each is where it was. This is what puts one
      // whose tier changed back in order.
      await pass();
      return { crawled, read };
    } finally {
      listening.delete(listener);
      setProgress(doc, null);
    }
  }

  /**
   * The repository each document last had a refresh started for, and when.
   *
   * @type {WeakMap<Document, { key: string, at: number }>}
   */
  const refreshed = new WeakMap();

  /**
   * Stops the refresh a document has running for a repository its page no longer
   * names.
   *
   * The rate this extension puts on github.com is one request a second, and the
   * claim the queues hold each other to is written per repository. A pass left
   * running on the repository the page came from holds a claim of its own, so
   * one tab showing one list page sends two requests a second, and half of them
   * read a repository nobody is looking at.
   *
   * The pass stops after the request in flight. What it had left, the advisory
   * that request was for included, stays in the progress entry, and the record
   * of when this document last had a refresh started goes with it: a maintainer
   * who leaves and comes straight back is taking back an unfinished pass, and
   * the threshold that holds off a burst of crawls is not what decides whether
   * they get it.
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
   * Starts the refresh this page's repository is due, where the page is an
   * advisory list and the table is on it, and stops the one its page has left.
   *
   * It hangs off a render rather than off the content script starting, because a
   * list page reached from an advisory with no document load is a render and not
   * a load. That navigation replaces the turbo frame and keeps the document, and
   * the repository the page names changes with it, so what a refresh is
   * remembered against is the repository and not the document alone. A page that
   * came to name another repository, or none at all, is a page whose refresh has
   * nobody left to read for.
   *
   * A refresh running on that repository is left to finish and none is started
   * beside it. One that finished starts again once the staleness threshold has
   * passed: inside it a pass reads nothing, because no entry is stale and no
   * completed walk is due, so a burst of renders costs one refresh and the
   * burst of crawls it could otherwise start is what the threshold holds off.
   *
   * @param {Document} doc
   * @param {RefreshOptions} [options] What the refresh reads and waits with.
   * @returns {void}
   */
  function ensureRefresh(doc, options = {}) {
    const parsed = pageOf(doc);
    const key =
      parsed === null || parsed.owner === null || parsed.repo === null
        ? null
        : refKey({ owner: parsed.owner, repo: parsed.repo });
    // The surfaces are told before the table's own refresh is, and on every
    // pass rather than only on the ones that changed repository: each holds its
    // own work and each decides what this repository means for it. One that
    // throws does not keep the next from hearing.
    for (const surface of [...surfaces]) {
      if (surface.left === undefined) continue;
      try {
        surface.left(doc, key);
      } catch {
        // A surface that cannot put its work down is not a reason to leave the
        // rest of the page running for a repository nobody is looking at.
      }
    }
    const left = running.get(doc);
    if (left !== undefined && left.key !== key) leave(doc, left);
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
   * Watches the document and runs a pass when the list changes, or when the
   * table is gone or has been left behind.
   *
   * Holding GitHub's controls out of view writes a class and nothing else, and
   * the watcher reads children alone, so no pass sees it.
   *
   * @param {Document} doc
   * @param {() => Promise<void>} [pass]
   * @returns {MutationObserver | null} null where the document offers nothing to
   *   watch or no observer to watch it with.
   */
  function observe(doc, pass = renderLoop(doc)) {
    return globalThis.bghsa.dom.watch(doc, { ownedSelector, outOfPlace, pass });
  }

  /**
   * Renders the table into this page and keeps it there. The first pass and
   * every pass the observer asks for run through one loop, so no two of them
   * read and write the document together.
   *
   * @returns {MutationObserver | null} what is watching the page, and null where
   *   the document offers nothing to watch or no observer to watch it with.
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
   * The observer watching each started document, held so that {@link stop} can
   * let it go.
   *
   * @type {WeakMap<Document, MutationObserver | null>}
   */
  const attached = new WeakMap();

  /**
   * Takes the table off a document, which is what a repository leaving the
   * allowlist does to a list page already showing one.
   *
   * The observer is let go first, so removing the table is not itself a reason
   * to draw it again. The refresh this page had running is put down, and every
   * surface beside the table is told the page reads for no repository, which is
   * what stops the reads they hold of their own. GitHub's own view comes back
   * whole, because nothing was ever taken out of the document to hide it.
   *
   * @param {Document} [doc]
   * @returns {void}
   */
  function stop(doc = globalThis.document) {
    attached.get(doc)?.disconnect();
    attached.delete(doc);
    for (const surface of [...surfaces]) {
      if (surface.left === undefined) continue;
      try {
        surface.left(doc, null);
      } catch {
        // A surface that cannot put its work down is not a reason to leave the
        // rest of the page running for a repository nobody listed.
      }
    }
    const held = running.get(doc);
    if (held !== undefined) leave(doc, held);
    const container = doc.querySelector('#advisories');
    if (container !== null) for (const node of nativeControls(container)) setHidden(node, false);
    for (const node of doc.querySelectorAll(ownedSelector())) node.remove();
    // The surfaces beside the table draw inside its root and go out with it.
    // What each leaves behind is a stylesheet in the head, which the root does
    // not carry, and every stylesheet this extension adds is named for it.
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
    refresh,
    ensureRefresh,
    renderLoop,
    passFor,
    observe,
    start,
    stop,
  };

  globalThis.bghsa.table = exported;

  // Nothing starts here. The content script matches every github.com page, so a
  // surface that started as it loaded would connect an observer on every one of
  // them. `src/content.js` loads last and starts this surface on the pages it
  // belongs to, and again when GitHub turns a page into one of those.
  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
