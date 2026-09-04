'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/dom.js');
  require('../common/text.js');
  require('../common/schema.js');
  require('../common/write.js');
  require('../common/merge.js');
  require('../common/parse-list.js');
  require('../common/cache.js');
  require('../common/record.js');
  require('../common/derive.js');
  require('../common/chips.js');
  require('../common/row.js');
  require('../common/duplicate.js');
  require('../detail/tracking.js');
  require('../detail/edit.js');
  require('../list/table.js');
  require('./corpus.js');
  require('./stats.js');
}

/**
 * One published or closed advisory, as the view draws it.
 *
 * @typedef {object} DoneRow
 * @property {string} ghsaId
 * @property {string | null} href
 * @property {string | null} title
 * @property {string | null} state As GitHub names it.
 * @property {string | null} severityLabel
 * @property {string | null} severityClass The color GitHub painted this
 *   advisory's own severity chip with, read off whichever page supplied the
 *   level.
 * @property {string | null} openedAt
 * @property {string | null} reporter
 * @property {string | null} closureReason The stored reason, and null where the
 *   advisory carries none or nothing has read it.
 * @property {string | null} closureDuplicateOf What the advisory duplicates, as
 *   the maintainer who set the reason wrote it.
 * @property {boolean} read Whether an advisory read backs this row.
 * @property {number | null} observedAt When that read was taken.
 * @property {boolean} writable Whether a reason can be set from here, which
 *   needs a read that says which advisory this is.
 */

/**
 * What the view holds for one document.
 *
 * @typedef {object} Held
 * @property {import('./corpus.js').Corpus | null} corpus What the crawl and the
 *   reads hold, and null before the first page lands.
 * @property {boolean} reading Whether a collection is running.
 * @property {{ owner: string, repo: string } | null} ref
 * @property {string[]} failures What the last collection could not read, in the
 *   order it found out, each named once.
 */

/**
 * What a write from this view goes out with. The page's own fetch is what a
 * maintainer's press uses; a caller hands its own in.
 *
 * @typedef {object} WriteOptions
 * @property {import('../common/write.js').WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 */

/**
 * @typedef {object} CollectOptions
 * @property {import('../common/cache.js').CacheStorage | null} [storage]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [wait]
 * @property {import('../common/write.js').WriteFetch} [fetch]
 * @property {import('../common/parse-list.js').ParsedList} [parsed]
 * @property {string} [href]
 */

(() => {
  /** The id of the element the done view owns. */
  const ROOT_ID = 'bghsa-done';

  /** The id of the done view's stylesheet. */
  const STYLE_ID = 'bghsa-done-style';

  /** The view this surface is, as the list page holds the choice. */
  const MODE = 'done';

  /** What the toggle reads while another view is showing. */
  const SHOW_DONE = 'Show completed';

  /** What it reads while this one is. The statistics use it for the way back. */
  const SHOW_OPEN = 'Show open';

  /** What the Box this view draws is headed. */
  const HEADING_TEXT = 'Completed';

  /** What the control that writes one closure reason reads. */
  const SAVE_LABEL = 'Save';

  /** What the closure control and the filter over it are labeled. */
  const REASON_LABEL = 'Closure reason';

  /** What the filter over the two endings reads, as the open list names it. */
  const STATE_LABEL = 'State';

  /** The state GitHub gives an advisory that was published, as it names it. */
  const PUBLISHED = 'Published';

  /** The state GitHub gives an advisory that was closed, as it names it. */
  const CLOSED = 'Closed';

  /** What stands where the crawl has found no done advisory. */
  const EMPTY_TEXT = 'Not found';

  /** What says a collection is filling the list. */
  const LOADING_TEXT = 'Loading...';

  /**
   * The verb every failure on this surface carries: the header's own, the line
   * for a list page the walk could not take, and the line counting the
   * advisories no read landed for.
   */
  const FAILED_PREFIX = 'Failed to load';

  /**
   * What says the list is short of the two states and nothing further is
   * coming: the walk ended on pages GitHub would not serve.
   */
  const FAILED_TEXT = `${FAILED_PREFIX} all advisories`;

  /** What the view says where a reason cannot be written from here. */
  const UNREADABLE_MESSAGE = 'Error: cannot set reason';

  /** Every rule the done view adds to the page. */
  const STYLE_TEXT = [
    '.bghsa-done-chips { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    // `currentColor` is what a foreground falls back to: the page's own text
    // color reads in either theme, where a fixed one would be wrong in one.
    '.bghsa-done-meta { color: var(--fgColor-muted, currentColor); }',
    '.bghsa-done-observed { color: var(--fgColor-muted, currentColor); white-space: nowrap; }',
    // The closure reason select carries the longest reason and a Save button
    // beside it, so the control is wider than this line. A value longer than
    // the line wraps inside it, and a value with no break in it breaks
    // anywhere, so the control stays the widest thing in the cell.
    '.bghsa-done-duplicate-line { color: var(--fgColor-muted, currentColor);' +
      ' max-width: 12rem; overflow-wrap: anywhere; }',
    '.bghsa-done-empty { color: var(--fgColor-muted, currentColor); }',
    '.bghsa-done-count { color: var(--fgColor-muted, currentColor); }',
    '.bghsa-done-header { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    ...globalThis.bghsa.chips.TONE_RULES,
    ...globalThis.bghsa.chips.FILL_RULES,
  ].join('\n');

  /** What the view holds for each document. @type {WeakMap<Document, Held>} */
  const held = new WeakMap();

  /**
   * The collection each document has running, the repository it is for, and the
   * queue its requests go through.
   *
   * @type {WeakMap<
   *   Document,
   *   {
   *     key: string,
   *     queue: ReturnType<typeof globalThis.bghsa.fetch.createQueue>,
   *     started: Promise<unknown>,
   *   }
   * >}
   */
  const running = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {Held}
   */
  function stateOf(doc) {
    const found = held.get(doc);
    if (found !== undefined) return found;
    /** @type {Held} */
    const fresh = { corpus: null, reading: false, ref: null, failures: [] };
    held.set(doc, fresh);
    return fresh;
  }

  /**
   * @param {Document} doc
   * @param {Partial<Held>} patch
   * @returns {Held}
   */
  function setState(doc, patch) {
    const next = { ...stateOf(doc), ...patch };
    held.set(doc, next);
    return next;
  }

  /** Which repository the list surface says the page is on. */
  const refOf = globalThis.bghsa.table.refOf;

  /**
   * @param {Document} doc
   * @param {{ owner: string, repo: string }} ref
   * @returns {boolean} whether the page still names that repository.
   */
  function names(doc, ref) {
    const table = globalThis.bghsa.table;
    const here = refOf(doc);
    return here !== null && table.refKey(here) === table.refKey(ref);
  }

  /**
   * What the view holds for this document, with a corpus collected on a
   * repository the page no longer names dropped.
   *
   * GitHub replaces the turbo frame on a soft navigation and keeps the
   * document, so one document covers one repository's advisory list and then
   * another's. A corpus is a hundred-odd advisories of one repository, and the
   * rows built from it say nothing about the next one. What the view holds is
   * therefore keyed to the repository, as the list surface's refresh is.
   *
   * @param {Document} doc
   * @returns {Held}
   */
  function current(doc) {
    const state = stateOf(doc);
    if (state.ref === null || names(doc, state.ref)) return state;
    return setState(doc, { corpus: null, ref: null, failures: [] });
  }

  /** How every surface builds an element. */
  const element = globalThis.bghsa.dom.element;

  /**
   * The stored closure of one advisory, its reason and what it duplicates, with
   * a write this page has made standing over the advisory the write was made
   * on.
   *
   * The corpus holds each advisory as the crawl read it, and a save from here
   * writes to GitHub and to the cache without reading the page again, so the
   * advisory in hand is a page from before the write. `edit.preferred` is the
   * state the detail panel draws from after one, which is the write's own until
   * a read catches up with it, so a row here shows the reason a save landed the
   * way the panel does.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail | null} advisory
   * @returns {{ reason: string | null, duplicateOf: string | null }}
   */
  function closureOf(advisory) {
    if (advisory === null) return { reason: null, duplicateOf: null };
    const edit = globalThis.bghsa.edit;
    const merged = edit.preferred(
      edit.keyOf(advisory),
      globalThis.bghsa.merge.mergeSnapshots(advisory.comments)
    );
    const held = globalThis.bghsa.tracking.read(
      merged.state,
      globalThis.bghsa.stats.NO_FINGERPRINTS
    );
    return { reason: held.closureReason, duplicateOf: held.closureDuplicateOf };
  }

  /**
   * One row per corpus member, in the order the corpus holds them.
   *
   * @param {import('./corpus.js').Corpus | null} corpus
   * @returns {DoneRow[]}
   */
  function rowsOf(corpus) {
    if (corpus === null) return [];
    return corpus.members.map((member) => {
      const advisory = member.advisory;
      const closure = closureOf(advisory);
      const state = advisory?.state ?? member.row.state ?? member.state;
      // The color comes from whichever read supplied the level, so a severity
      // the advisory page has since changed is not painted the old one's color.
      const read = advisory?.severityLabel ?? advisory?.severity ?? null;
      return {
        ghsaId: member.ghsaId,
        href: member.row.href,
        title: advisory?.title ?? member.row.title,
        state,
        severityLabel: read ?? member.row.severityLabel ?? member.row.severity,
        severityClass: read === null ? member.row.severityClass : advisory?.severityClass ?? null,
        openedAt: advisory?.reportedAt ?? member.row.openedAt,
        reporter: advisory?.reporter ?? member.row.reporter,
        closureReason: closure.reason,
        closureDuplicateOf: closure.duplicateOf,
        read: advisory !== null,
        observedAt: member.observedAt,
        writable: advisory !== null && advisory.ref !== null,
      };
    });
  }

  /**
   * @param {import('./corpus.js').Corpus} corpus
   * @param {string} ghsaId
   * @returns {import('./corpus.js').CorpusMember | null}
   */
  function memberOf(corpus, ghsaId) {
    return corpus.members.find((member) => member.ghsaId === ghsaId) ?? null;
  }

  /**
   * The state one row is in, as the view reads it. The crawl names a state in
   * the `?state=` value and the advisory's own page names it as GitHub displays
   * it, so the two differ in case and the chip, the filter and the rules below
   * read the one form.
   *
   * @param {DoneRow} row
   * @returns {string | null}
   */
  function stateNameOf(row) {
    return row.state === null ? null : globalThis.bghsa.chips.sentenceCase(row.state);
  }

  /**
   * How the state chip is colored: purple for a closed advisory and green for a
   * published one, which is the pair GitHub colors the two endings with. A state
   * that is neither takes no tone.
   *
   * @param {string} state What {@link stateNameOf} read.
   * @returns {import('../common/chips.js').Chip['tone']}
   */
  function stateToneOf(state) {
    if (state === CLOSED) return 'done';
    if (state === PUBLISHED) return 'success';
    return undefined;
  }

  /**
   * What the two filters offer, in the order they offer them.
   *
   * The reason is a closed advisory's. A published advisory holds none and
   * carries no control for one, so it stands in the list while that filter is
   * holding it to nothing and falls out of every value of it, the `None` value
   * included. `None` is what a backfill works from: the closed advisories a
   * read backs and no reason has been set on.
   *
   * @type {readonly import('../list/table.js').Facet<DoneRow>[]}
   */
  const FACETS = [
    {
      key: 'state',
      label: STATE_LABEL,
      values: [PUBLISHED, CLOSED],
      valuesOf: (row) => {
        const state = stateNameOf(row);
        return state === null ? [] : [state];
      },
    },
    {
      key: 'reason',
      label: REASON_LABEL,
      values: globalThis.bghsa.schema.CLOSURE_REASONS.map(globalThis.bghsa.chips.sentenceCase),
      applies: (row) => stateNameOf(row) === CLOSED,
      valuesOf: (row) =>
        row.closureReason === null ? [] : [globalThis.bghsa.chips.sentenceCase(row.closureReason)],
    },
  ];

  /**
   * What each filter is holding one document's list to, by facet key. It is held
   * here rather than read off the controls, because a draw takes the view out
   * and puts a new one back, and what a maintainer picked has to survive that.
   *
   * @type {WeakMap<Document, Record<string, string>>}
   */
  const filters = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {Record<string, string>} what each filter is holding the list to,
   *   which is nothing until a control says otherwise.
   */
  function filtersOf(doc) {
    return filters.get(doc) ?? {};
  }

  /**
   * @param {Document} doc
   * @returns {boolean} whether any filter is holding the list to a value. From
   *   there the reset has nothing to do, and an empty list is empty because the
   *   crawl found nothing rather than because a filter kept nothing.
   */
  function filtering(doc) {
    return Object.values(filtersOf(doc)).some((value) => value !== '');
  }

  /**
   * The rows the filters keep, in the order they were in. Nothing is read again
   * and nothing is fetched: this is a view over the rows the corpus already
   * holds, and a row it has not read yet is still a row.
   *
   * @param {readonly DoneRow[]} rows
   * @param {Record<string, string>} held
   * @returns {DoneRow[]}
   */
  function applyFilters(rows, held) {
    const table = globalThis.bghsa.table;
    return rows.filter((row) =>
      FACETS.every((facet) => {
        const wanted = held[facet.key] ?? '';
        return wanted === '' || table.matchesFilter(facet, row, wanted);
      })
    );
  }

  /**
   * The stored state of one advisory, and everything a save from here needs. It
   * is `edit.contextFor`, which is what the panel builds from on the advisory's
   * own page, with the render pass this surface runs. The advisory it reads is
   * the one the crawl read and the cache holds, so the members and the branches
   * this page has seen reach the pickers the same way the panel's do.
   *
   * @param {Document} doc
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {WriteOptions} [options]
   * @returns {Promise<import('../detail/edit.js').EditorContext>}
   */
  function contextFor(doc, advisory, options = {}) {
    return globalThis.bghsa.edit.contextFor(advisory, {
      rerender: () => {
        draw(doc);
      },
      ...options,
    });
  }

  /**
   * Writes a closure reason onto one advisory from here.
   *
   * REQUIREMENTS.md section 10 has the reason settable retroactively, and it
   * goes out through the same store and the same writer every other stored track
   * uses: the value is staged against the advisory, and the save fetches the
   * advisory page, merges onto the state that page carries, and refuses on a
   * rival claim. Nothing here writes a comment of its own.
   *
   * @param {Document} doc
   * @param {string} ghsaId
   * @param {string | null} reason
   * @param {WriteOptions} [options]
   * @returns {Promise<import('../detail/state.js').StateWriteResult | null>} null
   *   where the view holds no read of that advisory.
   */
  async function setReason(doc, ghsaId, reason, options) {
    const corpus = current(doc).corpus;
    const advisory = corpus === null ? null : (memberOf(corpus, ghsaId)?.advisory ?? null);
    if (advisory === null || advisory.ref === null) {
      notes.set(ghsaId, { ok: false, message: UNREADABLE_MESSAGE });
      draw(doc);
      return null;
    }
    // The controls are disabled for the flight, so a second press is not one a
    // maintainer can make. A caller that asks anyway is refused here rather
    // than reaching the write with a sequence number the first save has not
    // landed on yet.
    if (saving.has(ghsaId)) return null;
    notes.delete(ghsaId);
    const edit = globalThis.bghsa.edit;
    saving.add(ghsaId);
    draw(doc);
    try {
      const context = await contextFor(doc, advisory, options);
      edit.stage(edit.keyOf(advisory), context.tracking, { closureReason: reason });
      return await edit.save(context);
    } finally {
      saving.delete(ghsaId);
      draw(doc);
    }
  }

  /**
   * What the view says about the last press on one advisory, where the editing
   * store holds nothing to say. It holds what a save reports; this holds the
   * refusals that never reach one.
   *
   * @type {Map<string, { ok: boolean, message: string }>}
   */
  const notes = new Map();

  /**
   * The advisories a save started from this view is out for, by GHSA
   * identifier. REQUIREMENTS.md section 3: the controls that fed a save are
   * held still until it settles, so the values written are the values on
   * screen and no second press lands on the write in flight.
   *
   * @type {Set<string>}
   */
  const saving = new Set();

  /**
   * @param {DoneRow} row
   * @param {import('./corpus.js').Corpus | null} corpus
   * @returns {{ ok: boolean, message: string } | null} what the row says about
   *   the last press on it.
   */
  function noteFor(row, corpus) {
    if (saving.has(row.ghsaId)) {
      return { ok: true, message: globalThis.bghsa.write.SAVING_MESSAGE };
    }
    const own = notes.get(row.ghsaId);
    if (own !== undefined) return own;
    const advisory = corpus === null ? null : (memberOf(corpus, row.ghsaId)?.advisory ?? null);
    if (advisory === null) return null;
    const edit = globalThis.bghsa.edit;
    const held = edit.results.get(edit.keyOf(advisory)) ?? null;
    // A result with nothing to say draws no line, so the row carries no empty
    // one where a save reported by saying nothing.
    return held === null || held.message === '' ? null : held;
  }

  /**
   * The closure control on one row: what the advisory carries, or what a press
   * on this page has staged and not yet written.
   *
   * @param {Document} doc
   * @param {DoneRow} row
   * @param {import('./corpus.js').Corpus | null} corpus
   * @param {{ owner: string, repo: string } | null} ref The repository the list
   *   is of, which is the one a duplicate names an advisory of.
   * @returns {Element}
   */
  function buildClosure(doc, row, corpus, ref) {
    const box = element(doc, 'div', 'bghsa-done-closure');
    const controls = element(doc, 'div', 'd-flex flex-items-center bghsa-done-closure-controls');
    const edit = globalThis.bghsa.edit;
    const advisory = corpus === null ? null : (memberOf(corpus, row.ghsaId)?.advisory ?? null);
    const staged =
      advisory === null ? undefined : edit.editsFor(edit.keyOf(advisory)).closureReason;
    const current = staged === undefined ? row.closureReason : staged;

    // The option for an advisory carrying no reason reads blank, so a row with
    // one set is the row that has words in the control. The control is named
    // for a reader who cannot see that.
    const control = edit.selectControl(
      doc,
      'mr-1 bghsa-done-reason',
      globalThis.bghsa.schema.CLOSURE_REASONS,
      current,
      '',
      { label: globalThis.bghsa.chips.sentenceCase, ariaLabel: REASON_LABEL }
    );

    const save = element(doc, 'button', 'btn btn-sm bghsa-done-save', SAVE_LABEL);
    save.setAttribute('type', 'button');

    /**
     * What the two controls are offered for.
     *
     * Both fed the save that is out, and both are held still until it settles:
     * what the write carries is what the row shows. Save is offered only once
     * the select has moved, which is the gate the panel's Save carries. The
     * store prunes a pick equal to the advisory's stored reason, so a select
     * put back where it started leaves nothing staged and nothing to press.
     *
     * @returns {void}
     */
    const update = () => {
      const flight = saving.has(row.ghsaId);
      const moved =
        advisory !== null && edit.editsFor(edit.keyOf(advisory)).closureReason !== undefined;
      edit.setDisabled(control, flight);
      edit.setDisabled(save, flight || !row.writable || !moved);
    };
    update();

    control.addEventListener('change', () => {
      if (advisory === null) return;
      const picked = /** @type {{ value?: unknown }} */ (/** @type {unknown} */ (control)).value;
      const value = typeof picked === 'string' ? picked : '';
      // The reason is staged against the advisory's stored state, which is what
      // decides whether this pick is a change at all, and reading it hashes the
      // values the confirmations bind to. The press that writes stages the
      // value it reads off this control, so a pick still landing here when it
      // comes is not a pick that press can miss.
      void (async () => {
        const context = await contextFor(doc, advisory);
        const reason = value === '' ? null : value;
        edit.stage(edit.keyOf(advisory), context.tracking, { closureReason: reason });
        update();
      })();
    });
    save.addEventListener('click', () => {
      const picked = /** @type {{ value?: unknown }} */ (/** @type {unknown} */ (control)).value;
      const value = typeof picked === 'string' ? picked : '';
      void setReason(doc, row.ghsaId, value === '' ? null : value);
    });

    controls.append(control);
    controls.append(save);
    box.append(controls);

    // What the advisory duplicates stands under the control, on a line held to
    // a width the control is wider than. The cell holds every row's control in
    // one column, and a line the control is wider than leaves that column where
    // it stands whatever a maintainer typed.
    if (row.closureDuplicateOf !== null) {
      const line = element(doc, 'div', 'mt-1 text-small bghsa-done-duplicate-line');
      line.append(
        globalThis.bghsa.duplicate.buildDuplicate(
          doc,
          'bghsa-done-duplicate',
          row.closureDuplicateOf,
          ref
        )
      );
      box.append(line);
    }
    return box;
  }

  /**
   * One row: the title, the line under it, the severity, and then the reason,
   * the state, and when this row's data was read.
   *
   * The three cells are in the order the open list puts its own three in, so a
   * maintainer moving between the two views finds the state and the observation
   * in the same place. The state chip stands in a cell of its own carrying the
   * color of the ending the advisory came to.
   *
   * @param {Document} doc
   * @param {DoneRow} row
   * @param {Held} state What the view holds: the corpus a row reads its note
   *   from, and the repository a duplicate names an advisory of.
   * @returns {Element}
   */
  function buildRow(doc, row, state) {
    const built = globalThis.bghsa.row;
    const corpus = state.corpus;
    const ending = stateNameOf(row);

    /** @type {import('../common/chips.js').ChipSpec[]} */
    const chips = [];
    // REQUIREMENTS.md section 10: the severity stands on a published advisory
    // and a closed one carries none. Publishing an advisory settles its
    // severity, so the chip is filled there as a confirmed one is on the open
    // list. Nothing is read or stored to decide it: the state is the whole rule.
    if (row.severityLabel !== null && ending !== CLOSED) {
      chips.push({
        text: globalThis.bghsa.chips.sentenceCase(row.severityLabel),
        severityClass: row.severityClass,
        fill: ending === PUBLISHED,
      });
    }

    /** @type {Element[]} */
    const lines = [];
    const note = noteFor(row, corpus);
    if (note !== null) {
      lines.push(element(doc, 'div', 'mt-1 text-small bghsa-done-note', note.message));
    }

    /** @type {Element[]} */
    const cells = [];
    // REQUIREMENTS.md section 10: the reason is a closed advisory's, so a
    // published row carries no control for one.
    if (ending !== PUBLISHED) {
      const closure = built.cell(doc, '');
      closure.append(buildClosure(doc, row, corpus, state.ref));
      cells.push(closure);
    }

    const stateCell = built.cell(doc, 'bghsa-done-state');
    if (ending !== null) {
      stateCell.append(
        globalThis.bghsa.chips.buildChip(doc, { text: ending, tone: stateToneOf(ending) })
      );
    }
    cells.push(stateCell);
    cells.push(
      built.cell(
        doc,
        'text-small bghsa-done-observed',
        globalThis.bghsa.table.observedTextOf(row)
      )
    );

    return built.buildRow(doc, {
      prefix: 'bghsa-done',
      ghsaId: row.ghsaId,
      href: row.href,
      title: row.title ?? row.ghsaId,
      meta: built.metaTextOf(row),
      chips,
      lines,
      cells,
    });
  }

  /**
   * What one filter offers: the item that holds the list to nothing, then the
   * values the rows hold.
   *
   * @param {Document} doc
   * @param {import('../list/table.js').Facet<DoneRow>} facet
   * @param {readonly DoneRow[]} rows Every row the corpus holds, so the values
   *   come off the whole list and not off what the filters have left of it.
   * @param {string} selected
   * @returns {Element[]}
   */
  function filterItems(doc, facet, rows, selected) {
    const table = globalThis.bghsa.table;
    /**
     * @param {string} value
     * @returns {() => void}
     */
    const pressing = (value) => () => {
      filters.set(doc, { ...filtersOf(doc), [facet.key]: value });
      drawControls(doc);
      draw(doc);
    };
    const items = [table.menuItem(doc, '', table.ANY_LABEL, selected === '', pressing(''))];
    for (const value of table.filterOptions(rows, facet, selected)) {
      items.push(table.menuItem(doc, value, value, value === selected, pressing(value)));
    }
    return items;
  }

  /**
   * The filters this surface puts on the bar, beside the open list's, and the
   * way back to the list unfiltered.
   *
   * They sit on the bar the toggles sit on, which is where the open list's own
   * filters are, so both views are worked from one strip. The bar stands
   * outside the view a draw replaces, so a read landing draws the rows and
   * leaves the control a maintainer is pointing at where it is.
   *
   * @param {Document} doc
   * @returns {Element}
   */
  function buildControls(doc) {
    const table = globalThis.bghsa.table;
    const rows = rowsOf(current(doc).corpus);
    const held = filtersOf(doc);
    const box = element(doc, 'div', 'd-flex flex-wrap flex-items-center bghsa-done-controls');
    for (const facet of FACETS) {
      const selected = held[facet.key] ?? '';
      const control = table.menu(
        doc,
        'bghsa-done-filter',
        facet.label,
        selected,
        filterItems(doc, facet, rows, selected)
      );
      control.setAttribute(table.FACET_ATTRIBUTE, facet.key);
      box.append(control);
    }

    const reset = element(doc, 'button', 'btn btn-sm mb-1 bghsa-done-reset', table.RESET_LABEL);
    reset.setAttribute('type', 'button');
    if (!filtering(doc)) reset.setAttribute('disabled', '');
    reset.addEventListener('click', () => {
      filters.set(doc, {});
      drawControls(doc);
      draw(doc);
    });
    box.append(reset);
    return box;
  }

  /**
   * @param {Document} doc
   * @returns {Element | null} the filters on the bar, and null before the list
   *   surface has drawn one.
   */
  function controlsIn(doc) {
    return doc.querySelector(`#${globalThis.bghsa.table.ROOT_ID} .bghsa-done-controls`);
  }

  /**
   * Draws the filters again from what they are now holding the list to, which
   * is what puts every menu on the item that view names and every summary on
   * the value it is holding to. A press is what asks for this; a read landing
   * asks for {@link syncControls}.
   *
   * @param {Document} doc
   * @returns {void}
   */
  function drawControls(doc) {
    const held = controlsIn(doc);
    if (held === null) return;
    const fresh = buildControls(doc);
    if (held.classList.contains(globalThis.bghsa.table.HIDDEN_CLASS)) {
      fresh.classList.add(globalThis.bghsa.table.HIDDEN_CLASS);
    }
    held.replaceWith(fresh);
  }

  /**
   * Puts the values the filters offer on what the corpus now holds. A read
   * landing can turn up a closure reason no row carried before, and the control
   * offers it from then on.
   *
   * @param {Document} doc
   * @returns {void}
   */
  function syncControls(doc) {
    const box = controlsIn(doc);
    if (box === null) return;
    const rows = rowsOf(current(doc).corpus);
    const held = filtersOf(doc);
    globalThis.bghsa.table.syncMenus(box, (key) => {
      const facet = FACETS.find((each) => each.key === key) ?? null;
      if (facet === null) return null;
      return filterItems(doc, facet, rows, held[key] ?? '');
    });
  }

  /**
   * What the view says when a page of the walk or an advisory read failed.
   * REQUIREMENTS.md section 11 displays what it can, marks the result
   * incomplete, and shows a banner. The banner is the
   * failures themselves; nothing stands above them saying that some of this
   * could not be read, because each line already says it.
   *
   * The header's own progress chip is not that banner. A walk that has not
   * reached its last page is one a navigation stopped as readily as one GitHub
   * refused, and a read that failed leaves a row standing as unread, which is
   * also what a row nothing has got to yet looks like.
   *
   * @param {Document} doc
   * @param {readonly string[]} failures
   * @returns {Element | null} the banner, and null where nothing failed.
   */
  function buildBanner(doc, failures) {
    if (failures.length === 0) return null;
    const box = element(doc, 'div', 'flash flash-warn m-3 bghsa-done-banner');
    for (const failure of failures) {
      box.append(element(doc, 'div', 'mt-1 text-small bghsa-done-failure', failure));
    }
    return box;
  }

  /**
   * How the list is standing: filling, short of the states with nothing further
   * coming, or whole.
   *
   * A collection running says so from the view, which knows one is out, and
   * from the corpus, which is assembled inside the walk that fills it. A
   * corpus a finished pass left short of the states is one the walk gave up on,
   * and no more of it is coming until a page load takes the work back.
   *
   * @param {Held} state
   * @returns {string | null} what the header says about the list, and null
   *   where there is nothing to say.
   */
  function statusTextOf(state) {
    if (state.reading || state.corpus?.running === true) return LOADING_TEXT;
    if (state.corpus !== null && !state.corpus.complete) return FAILED_TEXT;
    return null;
  }

  /**
   * What the header says about the collection: what it is doing now, or that the
   * list is short of the two states with nothing further coming.
   *
   * What it reports is the collection this document holds. A collection can be
   * put down under the view, which is what the list surface asks for when a
   * render finds no advisory list on the page, and a corpus the walk assembled
   * goes on saying it is being filled after the collection filling it has gone.
   * Read off the entry, the header says a collection is running while one is,
   * and says nothing once none is.
   *
   * The chip is the open list's own, read off the same queue, so a maintainer
   * looking at either surface is told the same thing the same way. A walk that
   * has queued nothing yet says it is loading, because the walk is what finds
   * out how many there are; a pass reading the advisories the walk found counts
   * what it has still to read, which is what tells a crawl that is working from
   * one that has stopped.
   *
   * @param {Document} doc
   * @param {Held} state
   * @returns {Element | null} the chip, and null where there is nothing to say.
   */
  function buildStatus(doc, state) {
    const table = globalThis.bghsa.table;
    const collecting = running.get(doc);
    if (collecting !== undefined) {
      const left = table.leftToRead(collecting.queue);
      return table.progressChip(
        doc,
        left > 0 ? { phase: 'reading', left } : { phase: 'walking', left: 0 }
      );
    }
    if (state.corpus !== null && !state.corpus.complete) {
      return globalThis.bghsa.chips.buildChip(doc, { text: FAILED_TEXT });
    }
    return null;
  }

  /**
   * Writes what the collection is doing where it stands.
   *
   * The queue serves the open list as well, and a read of theirs moves what it
   * has left without moving a row here, so the header is written on its own
   * and the rows are left as they are. It is how the open list's own header
   * keeps up with its refresh.
   *
   * @param {Document} doc
   * @returns {void}
   */
  function drawStatus(doc) {
    const header = doc.querySelector(`#${ROOT_ID} .bghsa-done-header`);
    if (header === null) return;
    const shown = header.querySelector('span.Label');
    const wanted = buildStatus(doc, current(doc));
    if (shown === null) {
      if (wanted !== null) header.append(wanted);
      return;
    }
    if (wanted === null) shown.remove();
    else shown.replaceWith(wanted);
  }

  /**
   * The rows, and what stands where there are none. Reaching the done view
   * starts the collection, so a view with no corpus yet is one whose first page
   * has not landed.
   *
   * @param {Document} doc
   * @param {readonly DoneRow[]} rows
   * @param {Held} state
   * @returns {Element}
   */
  function buildBody(doc, rows, state) {
    const list = element(doc, 'ul', 'bghsa-done-rows');
    if (rows.length === 0) {
      // A list the filters emptied is not a repository with nothing on it, and
      // the table already has words for both.
      let empty = EMPTY_TEXT;
      if (state.corpus === null) empty = statusTextOf(state) ?? EMPTY_TEXT;
      else if (filtering(doc)) empty = globalThis.bghsa.table.EMPTY_TEXT;
      list.append(element(doc, 'li', 'Box-row bghsa-done-empty', empty));
      return list;
    }
    for (const row of rows) list.append(buildRow(doc, row, state));
    return list;
  }

  /**
   * The done view: a Box carrying the count and the advisories.
   *
   * It carries no statistics. REQUIREMENTS.md section 10 gives them a view of
   * their own: they are not a property of the done list, and they are over the
   * open half of the corpus as well.
   *
   * @param {Document} doc
   * @returns {Element}
   */
  function buildView(doc) {
    const state = current(doc);
    const root = element(doc, 'div', 'Box mb-3 bghsa-done-box');
    root.id = ROOT_ID;
    root.setAttribute('data-bghsa-done', '1');

    const header = element(doc, 'div', 'Box-header bghsa-done-header');
    header.append(element(doc, 'strong', '', HEADING_TEXT));
    const rows = rowsOf(state.corpus);
    const shown = applyFilters(rows, filtersOf(doc));
    const countText = globalThis.bghsa.table.viewCountText(shown.length, rows.length);
    header.append(element(doc, 'span', 'ml-2 text-normal bghsa-done-count', countText));
    // What the list is of, which is not a statistic: a maintainer reading a row
    // has to be able to tell whether more are on their way, and whether the
    // ones that are missing are coming at all.
    const status = buildStatus(doc, state);
    if (status !== null) header.append(status);
    root.append(header);

    const banner = buildBanner(doc, state.failures);
    if (banner !== null) root.append(banner);

    root.append(buildBody(doc, shown, state));
    return root;
  }

  /** How the list surface holds a node out of view. */
  const setHidden = globalThis.bghsa.table.setHidden;

  /**
   * @param {Document} doc
   * @returns {void} adds the done view's stylesheet once.
   */
  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID) !== null) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    (doc.head ?? doc.documentElement ?? doc.body)?.append(style);
  }

  /**
   * Draws the view into the list surface, under the bar both toggles sit on.
   *
   * The view is rebuilt whole. What a maintainer picked and has not written is
   * in the editing store and not in the control, so a rebuilt control comes back
   * holding it.
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
    // The filters stand on the bar, which this draw does not touch. What a read
    // landing changes there is the values they offer.
    syncControls(doc);
    return root;
  }

  /**
   * The toggle this surface puts on the bar, beside the one that restores
   * GitHub's view.
   *
   * @param {Document} doc
   * @returns {Element}
   */
  function buildToggle(doc) {
    const node = element(doc, 'button', 'btn btn-sm bghsa-done-toggle', SHOW_DONE);
    node.setAttribute('type', 'button');
    node.addEventListener('click', () => {
      toggle(doc);
    });
    return node;
  }

  /**
   * Switches between this view and the table. The list surface holds which of
   * the three views the page is on, so a press here cannot leave two showing.
   *
   * @param {Document} doc
   * @returns {void}
   */
  function toggle(doc) {
    const table = globalThis.bghsa.table;
    const wanted = table.viewMode(doc) === MODE ? table.VIEW_TABLE : MODE;
    table.setViewMode(doc, wanted);
    table.applyVisibility(doc);
    if (wanted === MODE) void collect(doc);
  }

  /**
   * Draws the view under whichever of the three views the page is on.
   *
   * GitHub's own view carries GitHub's controls. This toggle opens a view of
   * the extension's own, so it goes out of view with the table and comes back
   * with it, leaving one control on the bar there: the one that brings the
   * extension's views back.
   *
   * @param {Document} doc
   * @param {string} mode
   * @returns {void}
   */
  function show(doc, mode) {
    const table = globalThis.bghsa.table;
    const root = draw(doc);
    const toggleNode = doc.querySelector(`#${table.ROOT_ID} .bghsa-done-toggle`);
    if (toggleNode !== null) {
      toggleNode.textContent = mode === MODE ? SHOW_OPEN : SHOW_DONE;
      setHidden(toggleNode, mode === table.VIEW_NATIVE);
    }
    if (root !== null) setHidden(root, mode !== MODE);
    const controls = controlsIn(doc);
    if (controls !== null) setHidden(controls, mode !== MODE);
  }

  /**
   * Walks the done states and reads the advisories they name.
   *
   * The crawl is a hundred-odd reads on a repository like `containerd/containerd`
   * and it goes through the queue the list surface already holds for this
   * repository, taken from `table.queueFor`. One throttled serial queue serves a
   * repository: a second instance would hold the rate privately, so both
   * surfaces spend the same one request a second and the same persisted claim.
   *
   * It starts when the view is first asked for, not when the page loads, because
   * it is a hundred requests and nobody has asked for them yet.
   *
   * @param {Document} doc
   * @param {CollectOptions} [options]
   * @returns {Promise<import('./corpus.js').Corpus | null>} null where the page
   *   is not an advisory list, or does not say which repository it belongs to.
   */
  function collect(doc, options = {}) {
    const table = globalThis.bghsa.table;
    const parsed = options.parsed ?? globalThis.bghsa.parseList.parseList(doc);
    if (parsed === null || parsed.owner === null || parsed.repo === null) {
      return Promise.resolve(null);
    }
    const ref = { owner: parsed.owner, repo: parsed.repo };
    const key = table.refKey(ref);
    const already = running.get(doc);
    if (already !== undefined && already.key === key) {
      return /** @type {Promise<import('./corpus.js').Corpus | null>} */ (already.started);
    }
    const { queue, listening } = table.queueFor(ref, options);

    /** @type {(ghsaId: string, entry: import('../common/cache.js').CacheEntry) => void} */
    const listener = (ghsaId, entry) => {
      // A read landing fills one member in where it stands, so the corpus grows
      // current under the reader rather than in one jump at the end.
      if (!names(doc, ref)) return;
      const corpus = stateOf(doc).corpus;
      const member = corpus === null ? null : memberOf(corpus, ghsaId);
      const advisory = member === null ? null : globalThis.bghsa.record.advisoryFrom(entry.record);
      if (corpus === null || member === null || advisory === null) {
        // Nothing here to fill a row with: the view holds no corpus yet, or the
        // read is one the queue took for the open list, or the record did not
        // read back as an advisory. The queue has one fewer to read whichever
        // it is, and the header says so from the first read after the view
        // opens, which is well before the walk this collection is waiting on.
        drawStatus(doc);
        return;
      }
      member.advisory = advisory;
      member.observedAt = entry.observedAt;
      corpus.unread = corpus.members
        .filter((each) => each.advisory === null)
        .map((each) => each.ghsaId);
      draw(doc);
    };
    listening.add(listener);

    /**
     * @param {string} message
     * @returns {void} puts one failure in the banner, named once however many
     *   attempts it took to give the page up.
     */
    const noteFailure = (message) => {
      if (!names(doc, ref)) return;
      const failures = stateOf(doc).failures;
      if (failures.includes(message)) return;
      setState(doc, { failures: [...failures, message] });
      draw(doc);
    };

    const started = globalThis.bghsa.corpus
      .collect({
        ref,
        queue,
        parsed,
        href: options.href ?? globalThis.location?.href,
        storage: options.storage,
        now: options.now,
        onFailure: (_state, url) => {
          noteFailure(`${FAILED_PREFIX} ${url}`);
        },
        onPage: (corpus) => {
          // A page landing after the maintainer has gone to another repository
          // is a page of the one they left.
          if (!names(doc, ref)) return;
          setState(doc, { corpus });
          draw(doc);
        },
      })
      .then((collected) => {
        if (names(doc, ref)) {
          setState(doc, { corpus: collected.corpus });
          const failed = collected.read.failed;
          if (failed > 0) {
            noteFailure(`${FAILED_PREFIX} ${globalThis.bghsa.table.countTextOf(failed)}`);
          }
        }
        return collected.corpus;
      })
      .finally(() => {
        listening.delete(listener);
        // A collection of another repository may have taken the entry over
        // while this one was finishing, and that one is the one still running.
        // Reporting it finished here would take the Reading chip off a crawl
        // that is still going, and where that crawl has no corpus yet the view
        // would say the repository has no advisories while it is fetching them.
        // The repository is not asked about on top of this: a collection the
        // document still holds is the one whose end this is, whichever
        // repository the page has come to name since.
        if (running.get(doc)?.started === started) {
          running.delete(doc);
          setState(doc, { reading: false });
        }
        // The view is drawn either way. What a collection put down under it
        // left on the header is what the end of that collection settles, and
        // where another one has the entry the draw reads that one.
        draw(doc);
      });
    // The queue is the repository's, and this collection's walk waits its turn
    // behind whatever the open list's refresh already has on it. The wait is
    // part of the collection: the entry stands before the view is drawn, so the
    // header says the view is loading from the moment it is asked and the count
    // moves with the queue while the walk waits.
    running.set(doc, { key, queue, started });
    setState(doc, { reading: true, ref, failures: [] });
    draw(doc);
    return started;
  }

  /**
   * Puts down a collection running for a repository the page no longer names.
   *
   * A collection is a walk of two list pages and then a read of every advisory
   * they name, a hundred-odd requests on a repository like
   * `containerd/containerd`. A maintainer who follows a link out of the list
   * has left it, and the rate this extension puts on github.com is one request
   * a second per repository: a collection left running there spends that second
   * on a repository nobody is looking at, and it spends it beside whatever the
   * page they moved to is spending. The list surface stops its own refresh on
   * the same reading of the page.
   *
   * The walk stops after the request in flight and the reads are never taken
   * up. What is left stays in the progress entry, so a maintainer who comes
   * back takes the collection back where it stood and reads no advisory twice.
   *
   * @param {Document} doc
   * @param {string | null} key The repository the page names now, and null
   *   where it names none.
   * @returns {void}
   */
  function left(doc, key) {
    const collecting = running.get(doc);
    if (collecting === undefined || collecting.key === key) return;
    void collecting.queue.stop();
    running.delete(doc);
    setState(doc, { reading: false });
    draw(doc);
  }

  const exported = {
    ROOT_ID,
    STYLE_ID,
    MODE,
    SHOW_OPEN,
    EMPTY_TEXT,
    LOADING_TEXT,
    FAILED_TEXT,
    STYLE_TEXT,
    notes,
    saving,
    stateOf,
    setState,
    current,
    rowsOf,
    memberOf,
    contextFor,
    buildBody,
    ensureStyle,
    draw,
    show,
    setReason,
    collect,
    left,
  };

  globalThis.bghsa.view = exported;

  // The list surface holds the choice of view and the bar the toggles sit on,
  // so this one takes its place there as soon as it loads.
  globalThis.bghsa.table.addSurface({ control: buildToggle, controls: buildControls, show, left });

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
