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
 * @typedef {object} DoneRow
 * @property {string} ghsaId
 * @property {string | null} href
 * @property {string | null} title
 * @property {string | null} state The GitHub state label.
 * @property {string | null} severityLabel
 * @property {string | null} severityClass GitHub's class from the same page as the severity
 *   label.
 * @property {string | null} openedAt
 * @property {string | null} reporter
 * @property {string | null} ending The ending label, or null when endedAt is unknown.
 * @property {number | null} endedAt The last close or publication matching the current
 *   state. Null if the detail read or corresponding event is unavailable.
 * @property {string | null} closureReason The stored reason, or null if absent or unread.
 * @property {string | null} closureDuplicateOf The stored duplicate identifier.
 * @property {boolean} read Whether detail data is available.
 * @property {number | null} observedAt The detail observation time in epoch milliseconds.
 * @property {boolean} writable Whether detail data identifies the advisory for saving a
 *   reason.
 */

/**
 * @typedef {object} Held
 * @property {import('./corpus.js').Corpus | null} corpus The collected corpus, or null
 *   before the first page arrives.
 * @property {boolean} reading Whether collection is active.
 * @property {{ owner: string, repo: string } | null} ref
 * @property {string[]} failures Distinct collection failures in detection order.
 */

/**
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

  const ROOT_ID = 'bghsa-done';

  const STYLE_ID = 'bghsa-done-style';

  const MODE = 'done';

  const SHOW_DONE = 'Show completed';

  const SHOW_OPEN = 'Show open';

  const HEADING_TEXT = 'Completed';

  const SAVE_LABEL = 'Save';

  const REASON_LABEL = 'Closure reason';

  const STATE_LABEL = 'State';

  const SEVERITY_LABEL = 'Severity';

  const PUBLISHED = 'Published';

  const CLOSED = 'Closed';

  const EMPTY_TEXT = 'Not found';

  const LOADING_TEXT = 'Loading...';

  const FAILED_PREFIX = 'Failed to load';

  const FAILED_TEXT = `${FAILED_PREFIX} all advisories`;

  const UNREADABLE_MESSAGE = 'Error: cannot set reason';

  const STYLE_TEXT = [
    '.bghsa-done-chips { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    // Use the page text color as the fallback in both themes.
    '.bghsa-done-meta { color: var(--fgColor-muted, currentColor); }',
    '.bghsa-done-observed { color: var(--fgColor-muted, currentColor); white-space: nowrap; }',
    // Wrap long duplicate IDs within the control width to preserve column alignment.
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
   * Track each document's active collection and repository queue.
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

  const refOf = globalThis.bghsa.table.refOf;

  /**
   * @param {Document} doc
   * @param {{ owner: string, repo: string }} ref
   * @returns {boolean} Whether the page still identifies that repository.
   */
  function names(doc, ref) {
    const table = globalThis.bghsa.table;
    const here = refOf(doc);
    return here !== null && table.refKey(here) === table.refKey(ref);
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
    if (state.ref === null || names(doc, state.ref)) return state;
    return setState(doc, { corpus: null, ref: null, failures: [] });
  }

  const element = globalThis.bghsa.dom.element;

  /**
   * Use locally saved closure state until the corpus includes that write,
   * through the same edit.preferred check as the detail panel.
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
   * Display the last close or publication for the current advisory state.
   * Statistics measure durations to the first occurrence. An end date requires
   * a detail read with the corresponding timeline event.
   *
   * @param {string | null} state The displayed state.
   * @param {import('../common/parse-detail.js').ParsedDetail | null} advisory
   * @returns {{ ending: string | null, endedAt: number | null }}
   */
  function endingOf(state, advisory) {
    /** @type {{ ending: string | null, endedAt: number | null }} */
    const none = { ending: null, endedAt: null };
    if (advisory === null) return none;
    const name = state === null ? null : globalThis.bghsa.chips.sentenceCase(state);
    if (name === CLOSED) {
      const at = globalThis.bghsa.stats.lastCloseAt(advisory);
      return at === null ? none : { ending: 'closed', endedAt: at };
    }
    if (name === PUBLISHED) {
      const at = globalThis.bghsa.stats.lastPublishAt(advisory);
      return at === null ? none : { ending: 'published', endedAt: at };
    }
    return none;
  }

  /**
   * Sort rows by latest ending first, with unknown endings last. Preserve
   * corpus identifier order for equal or missing dates and leave the shared
   * corpus order unchanged.
   *
   * @param {import('./corpus.js').Corpus | null} corpus
   * @returns {DoneRow[]}
   */
  function rowsOf(corpus) {
    if (corpus === null) return [];
    const rows = corpus.members.map((member) => {
      const advisory = member.advisory;
      const closure = closureOf(advisory);
      const state = advisory?.state ?? member.row.state ?? member.state;
      const ending = endingOf(state, advisory);
      // Take the color from the same source as the severity label.
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
        ending: ending.ending,
        endedAt: ending.endedAt,
        closureReason: closure.reason,
        closureDuplicateOf: closure.duplicateOf,
        read: advisory !== null,
        observedAt: member.observedAt,
        writable: advisory !== null && advisory.ref !== null,
      };
    });

    return rows.sort((left, right) => {
      if (left.endedAt === right.endedAt) return 0;
      if (left.endedAt === null) return 1;
      if (right.endedAt === null) return -1;
      return right.endedAt - left.endedAt;
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
   * Normalize casing between list query states and detail page labels.
   *
   * @param {DoneRow} row
   * @returns {string | null}
   */
  function stateNameOf(row) {
    return row.state === null ? null : globalThis.bghsa.chips.sentenceCase(row.state);
  }

  /**
   * Match GitHub's colors for closed and published states.
   *
   * @param {string} state The normalized state label.
   * @returns {import('../common/chips.js').Chip['tone']}
   */
  function stateToneOf(state) {
    if (state === CLOSED) return 'done';
    if (state === PUBLISHED) return 'success';
    return undefined;
  }

  /**
   * Filter closure reasons on closed advisories. None selects fetched closed
   * advisories without a stored reason. Severity applies to published advisories
   * (REQUIREMENTS.md section 10).
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
    {
      key: 'severity',
      label: SEVERITY_LABEL,

      values: ['Critical', 'High', 'Moderate', 'Low'],
      applies: (row) => stateNameOf(row) === PUBLISHED,
      // Normalize lowercase list values to the displayed severity labels.
      valuesOf: (row) =>
        row.severityLabel === null
          ? []
          : [globalThis.bghsa.chips.sentenceCase(row.severityLabel)],
    },
  ];

  /**
   * Retain selected filters across view rebuilds.
   *
   * @type {WeakMap<Document, Record<string, string>>}
   */
  const filters = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {Record<string, string>} The selected value for each active facet.
   */
  function filtersOf(doc) {
    return filters.get(doc) ?? {};
  }

  /**
   * @param {Document} doc
   * @returns {boolean} Whether any filter is active.
   */
  function filtering(doc) {
    return Object.values(filtersOf(doc)).some((value) => value !== '');
  }

  /**
   * Filter collected rows locally while preserving their order.
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
   * Use the shared editor context with this view's redraw callback.
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
   * Save closure reasons through the shared editor and its concurrency checks
   * (REQUIREMENTS.md section 10).
   *
   * @param {Document} doc
   * @param {string} ghsaId
   * @param {string | null} reason
   * @param {WriteOptions} [options]
   * @returns {Promise<import('../detail/state.js').StateWriteResult | null>} The save
   *   result, or null if detail data is unavailable or a save is already pending.
   */
  async function setReason(doc, ghsaId, reason, options) {
    const corpus = current(doc).corpus;
    const advisory = corpus === null ? null : (memberOf(corpus, ghsaId)?.advisory ?? null);
    if (advisory === null || advisory.ref === null) {
      notes.set(ghsaId, { ok: false, message: UNREADABLE_MESSAGE });
      draw(doc);
      return null;
    }
    // Reject concurrent saves before reading a potentially outdated sequence.
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
   * Record refusals that occur before the shared editor handles the save.
   *
   * @type {Map<string, { ok: boolean, message: string }>}
   */
  const notes = new Map();

  /**
   * Track pending saves by advisory ID to disable their controls across redraws.
   *
   * @type {Set<string>}
   */
  const saving = new Set();

  /**
   * @param {DoneRow} row
   * @param {import('./corpus.js').Corpus | null} corpus
   * @returns {{ ok: boolean, message: string } | null} The latest row status, or null.
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

    return held === null || held.message === '' ? null : held;
  }

  /**
   * Prefer pending closure edits over stored values.
   *
   * @param {Document} doc
   * @param {DoneRow} row
   * @param {import('./corpus.js').Corpus | null} corpus
   * @param {{ owner: string, repo: string } | null} ref The repository used for duplicate
   *   advisory links.
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

    // Supply an accessible label for the select's blank option.
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
     * Disable controls during saves and enable Save only for pending changes.
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
      // Staging waits for the editor context. Save also reads the control directly
      // to include the latest choice.
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

    // Constrain duplicate text width to preserve closure-control alignment.
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
   * Align state and observation cells with the open list.
   *
   * @param {Document} doc
   * @param {DoneRow} row
   * @param {Held} state
   * @returns {Element}
   */
  function buildRow(doc, row, state) {
    const built = globalThis.bghsa.row;
    const corpus = state.corpus;
    const ending = stateNameOf(row);

    /** @type {import('../common/chips.js').ChipSpec[]} */
    const chips = [];
    // Publication confirms severity; closed rows omit it
    // (REQUIREMENTS.md section 10).
    if (row.severityLabel !== null && ending !== CLOSED) {
      chips.push({
        text: globalThis.bghsa.chips.sentenceCase(row.severityLabel),
        severityClass: row.severityClass,
        fill: ending === PUBLISHED,
        subject: globalThis.bghsa.chips.SEVERITY_SUBJECT,
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
    // Closure reasons apply to closed advisories (REQUIREMENTS.md section 10).
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
   * Build filter choices from all collected rows.
   *
   * @param {Document} doc
   * @param {import('../list/table.js').Facet<DoneRow>} facet
   * @param {readonly DoneRow[]} rows
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
   * Place filters outside the replaced view to keep menus stable during reads.
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
   * @returns {Element | null} The rendered filter controls, or null if absent.
   */
  function controlsIn(doc) {
    return doc.querySelector(`#${globalThis.bghsa.table.ROOT_ID} .bghsa-done-controls`);
  }

  /**
   * Rebuild filters after a selection changes. New data uses {@link syncControls}.
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
   * Update offered values when newly fetched rows add closure reasons.
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
   * List failed pages and advisories while retaining readable results
   * (REQUIREMENTS.md section 11).
   *
   * @param {Document} doc
   * @param {readonly string[]} failures
   * @returns {Element | null} The failure banner, or null if every read succeeded.
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
   * Report active collection or an incomplete result after collection stops.
   *
   * @param {Held} state
   * @returns {string | null} The loading or incomplete status, or null when complete.
   */
  function statusTextOf(state) {
    if (state.reading || state.corpus?.running === true) return LOADING_TEXT;
    if (state.corpus !== null && !state.corpus.complete) return FAILED_TEXT;
    return null;
  }

  /**
   * Read progress from the active collection because a retained corpus may
   * still have its running flag after cancellation. Use the shared queue
   * progress chip while collecting and report incomplete results afterward.
   *
   * @param {Document} doc
   * @param {Held} state
   * @returns {Element | null} The progress or failure chip, or null if absent.
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
   * Refresh progress independently of rows because open-list reads also advance
   * the shared queue.
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
   * Show loading before the first corpus page arrives.
   *
   * @param {Document} doc
   * @param {readonly DoneRow[]} rows
   * @param {Held} state
   * @returns {Element}
   */
  function buildBody(doc, rows, state) {
    const list = element(doc, 'ul', 'bghsa-done-rows');
    if (rows.length === 0) {
      // Distinguish an empty corpus from a filter without matches.
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

    const status = buildStatus(doc, state);
    if (status !== null) header.append(status);
    root.append(header);

    const banner = buildBanner(doc, state.failures);
    if (banner !== null) root.append(banner);

    root.append(buildBody(doc, shown, state));
    return root;
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
   * Rebuild the view below the shared toolbar. The editing store restores
   * pending values in the new controls.
   *
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

    syncControls(doc);
    return root;
  }

  /**
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
    if (wanted === MODE) void collect(doc);
  }

  /**
   * Open this view on closed advisories without a closure reason, the
   * selection its State and Closure reason menus make.
   *
   * @param {Document} doc
   * @returns {void}
   */
  function showUnreasoned(doc) {
    const table = globalThis.bghsa.table;
    filters.set(doc, { state: CLOSED, reason: table.NO_VALUE });
    table.setViewMode(doc, MODE);
    drawControls(doc);
    table.applyVisibility(doc);
    void collect(doc);
  }

  /**
   * Hide extension toggles in GitHub's native view.
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
   * Collect done advisories when this view is first requested. Share the
   * repository queue from table.queueFor to enforce one request rate across
   * the open and completed views.
   *
   * @param {Document} doc
   * @param {CollectOptions} [options]
   * @returns {Promise<import('./corpus.js').Corpus | null>} The corpus, or null outside an
   *   identified advisory list.
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
      // Update each member as its detail read arrives.
      if (!names(doc, ref)) return;
      const corpus = stateOf(doc).corpus;
      const member = corpus === null ? null : memberOf(corpus, ghsaId);
      const advisory = member === null ? null : globalThis.bghsa.record.advisoryFrom(entry.record);
      if (corpus === null || member === null || advisory === null) {
        // Shared queue progress can change before this corpus has a matching row.
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
     * @returns {void}
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
          // Ignore results for a repository the document has left.
          if (!names(doc, ref)) return;
          setState(doc, { corpus });
          draw(doc);
        },
      })
      .then((collected) => {
        if (names(doc, ref)) {
          setState(doc, { corpus: collected.corpus });
          for (const ghsaId of collected.read.failed) {
            noteFailure(`${FAILED_PREFIX} ${ghsaId}`);
          }
        }
        return collected.corpus;
      })
      .finally(() => {
        listening.delete(listener);
        // Clear only this collection's entry; another repository's collection may
        // have replaced it while the request was pending.
        if (running.get(doc)?.started === started) {
          running.delete(doc);
          setState(doc, { reading: false });
        }
        // Redraw using the current collection after either completion or replacement.
        draw(doc);
      });
    // Register before drawing to show loading while this collection waits for
    // other work in the shared queue.
    running.set(doc, { key, queue, started });
    setState(doc, { reading: true, ref, failures: [] });
    draw(doc);
    return started;
  }

  /**
   * Stop collection after navigation to another repository or away from the list.
   * The current request finishes and saved queue progress supports resumption.
   *
   * @param {Document} doc
   * @param {string | null} key The current repository key, or null outside an identified list.
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
    showUnreasoned,
    collect,
    left,
  };

  globalThis.bghsa.view = exported;

  globalThis.bghsa.table.addSurface({ control: buildToggle, controls: buildControls, show, left });

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
