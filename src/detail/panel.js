'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/dom.js');
  require('../common/text.js');
  require('../common/trust.js');
  require('../common/write.js');
  require('../common/merge.js');
  require('../common/parse-detail.js');
  require('../common/derive.js');
  require('../common/order.js');
  require('../common/chips.js');
  require('../common/duplicate.js');
  require('../common/members.js');
  require('../common/branches.js');
  require('../common/cache.js');
  require('./tracking.js');
  require('./comments.js');
  require('./preserve.js');
  require('./edit.js');
  require('../content.js');
}

(() => {

  const PANEL_ID = 'bghsa-detail-panel';

  const STYLE_ID = 'bghsa-style';

  const STYLE_TEXT = [
    '.bghsa-chips { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    '.bghsa-label { flex: 0 0 9rem; }',
    '.bghsa-field-label { flex: 0 0 9rem; }',
    // Hide the disclosure marker in engines where the Primer button's display
    // style alone does not remove it.
    '.bghsa-editor-summary { cursor: pointer; list-style: none; }',
    '.bghsa-editor-summary::-webkit-details-marker { display: none; }',
    '.bghsa-confirmed { display: flex; flex-direction: column; gap: 6px; }',
    '.bghsa-confirmation-name { flex: 0 0 9rem; }',
    // Use the page text color as the fallback in both themes.
    '.bghsa-confirmation-note { color: var(--fgColor-muted, currentColor); }',
    '.bghsa-since { color: var(--fgColor-muted, currentColor); }',
    ...globalThis.bghsa.chips.TONE_RULES,
  ].join('\n');

  const UNKNOWN = 'Unknown';

  const DRAFT_STATE = globalThis.bghsa.chips.DRAFT_STATE;

  const element = globalThis.bghsa.dom.element;

  const sentenceCase = globalThis.bghsa.chips.sentenceCase;

  /**
   * @param {Document} doc
   * @param {string} label
   * @returns {{ row: Element, body: Element }} The row and its value container.
   */
  function row(doc, label) {
    const container = element(doc, 'div', 'Box-row d-flex flex-items-baseline');
    container.append(element(doc, 'div', 'text-bold bghsa-label', label));
    const body = element(doc, 'div', 'flex-auto');
    container.append(body);
    return { row: container, body };
  }

  /**
   * @param {Document} doc
   * @param {string} text
   * @returns {Element}
   */
  function warning(doc, text) {
    return element(doc, 'div', 'flash flash-warn mt-2 bghsa-warning', text);
  }

  /**
   * Use the list's waiting and patch chips on the detail page. Patch preparation
   * applies to drafts. Published and closed advisories omit waiting chips.
   * Report an unreadable state because it controls which chips appear.
   *
   * @param {Document} doc
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {import('../common/derive.js').DerivedState} derived
   * @param {import('./tracking.js').TrackingView} tracking
   * @returns {Element}
   */
  function buildChips(doc, advisory, derived, tracking) {
    const header = element(doc, 'div', 'Box-header bghsa-chips');
    header.append(element(doc, 'strong', 'mr-2', 'Better GHSA'));
    if (advisory.state === null) {
      header.append(globalThis.bghsa.chips.buildChip(doc, { text: UNKNOWN, tone: 'attention' }));
    }
    if (!settled(advisory)) {
      const waiting = globalThis.bghsa.chips.waitingChips({
        neverReviewed: derived.neverReviewed,
        newActivity: derived.newActivity,
        triage: tracking.triage,
      });
      for (const chip of waiting) header.append(globalThis.bghsa.chips.buildChip(doc, chip));
    }
    if (advisory.state === DRAFT_STATE) {
      const patch = globalThis.bghsa.chips.patchChip(
        globalThis.bghsa.chips.patchStateOf(derived.patch)
      );
      header.append(globalThis.bghsa.chips.buildChip(doc, patch));
    }
    return header;
  }

  /**
   * Display drifted confirmations as unconfirmed.
   *
   * @param {import('./tracking.js').Confirmation} state
   * @returns {string}
   */
  function confirmationText(state) {
    if (state.status === 'confirmed') return 'Confirmed';
    if (state.status === 'unreadable') return 'Unknown';
    return 'Not confirmed';
  }

  /**
   * Confirmation remains valid when its author is unknown.
   *
   * @param {import('./tracking.js').Confirmation} state
   * @returns {string}
   */
  function attribution(state) {
    const who = state.by === null ? 'A maintainer' : state.by;
    const at = globalThis.bghsa.text.formatTime(state.at);
    return at === null ? who : `${who}, ${at}`;
  }

  /**
   * @param {import('./tracking.js').Confirmation} state
   * @returns {string | null} Attribution for a confirmed value, otherwise null.
   */
  function confirmationNote(state) {
    if (state.status === 'confirmed') return attribution(state);
    return null;
  }

  /**
   * Published and closed advisories omit confirmations and report preservation.
   *
   * @type {readonly string[]}
   */
  const SETTLED_STATES = ['published', 'closed'];

  /**
   * Confirmations and report preservation apply before publication or closure
   * (REQUIREMENTS.md section 8). Unknown states still show these controls.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {boolean}
   */
  function settled(advisory) {
    const state = advisory.state === null ? null : advisory.state.toLowerCase();
    return state !== null && SETTLED_STATES.includes(state);
  }

  /**
   * Report whether the description matches the original report, or is unknown.
   *
   * @param {boolean | null} original
   * @returns {string}
   */
  function provenanceText(original) {
    if (original === null) return UNKNOWN;
    return original ? 'Not updated' : 'Updated';
  }

  /**
   * Show confirmation status and description provenance together.
   *
   * @param {Document} doc
   * @param {import('./tracking.js').TrackingView} tracking
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {Element}
   */
  function buildConfirmations(doc, tracking, advisory) {
    const container = element(doc, 'div', 'Box-row bghsa-confirmed');
    container.append(element(doc, 'div', 'text-bold bghsa-confirmed-heading', 'Confirmations'));

    for (const track of globalThis.bghsa.tracking.CONFIRMATION_TRACKS) {
      const state = tracking[track.key];
      const line = element(doc, 'div', 'd-flex flex-items-baseline bghsa-confirmation');
      line.append(element(doc, 'span', 'bghsa-confirmation-name', track.name));
      // Use a separate flex container for chip gaps to preserve panel row alignment.
      const body = element(doc, 'div', 'flex-auto bghsa-chips');
      line.append(body);
      body.append(globalThis.bghsa.chips.buildChip(doc, { text: confirmationText(state) }));
      if (track.key === 'description') {
        const provenance = provenanceText(advisory.descriptionOriginal);
        body.append(globalThis.bghsa.chips.buildChip(doc, { text: provenance }));
      }
      const note = confirmationNote(state);
      if (note !== null) body.append(element(doc, 'span', 'bghsa-confirmation-note', note));
      container.append(line);
    }
    return container;
  }

  /**
   * The row label already names the embargo.
   *
   * @param {string | null} lift The stored lift date.
   * @param {boolean} overdue Whether the lift date has passed on an unpublished advisory.
   * @returns {string}
   */
  function embargoText(lift, overdue) {
    if (lift === null) return 'No lift date';
    return overdue ? `Overdue since ${lift}` : `Lifts ${lift}`;
  }

  /**
   * @param {Document} doc
   * @param {string} label
   * @param {string[]} values
   * @returns {Element}
   */
  function chipRow(doc, label, values) {
    const built = row(doc, label);
    built.body.className = 'flex-auto bghsa-chips';
    for (const value of values) {
      built.body.append(globalThis.bghsa.chips.buildChip(doc, { text: value }));
    }
    return built.row;
  }

  /**
   * Show stored tracks only when they have a value.
   *
   * @param {Document} doc
   * @param {import('./tracking.js').TrackingView} tracking
   * @param {boolean} embargoOverdue Whether the lift date has passed on an unpublished advisory.
   * @param {{ owner: string, repo: string } | null} ref The repository used for duplicate
   *   advisory links.
   * @returns {Element[]}
   */
  function buildTracks(doc, tracking, embargoOverdue, ref) {
    /** @type {Element[]} */
    const rows = [];

    if (tracking.triage !== null) {
      const built = row(doc, 'Triage');
      built.body.className = 'flex-auto bghsa-chips';
      // Unknown triage values count as waiting on maintainers.
      const blocked = globalThis.bghsa.order.classifyTriage(tracking.triage);
      built.body.append(
        globalThis.bghsa.chips.buildChip(doc, {
          text: sentenceCase(tracking.triage),
          tone: blocked === 'us' ? 'danger' : 'attention',
        })
      );
      const since = globalThis.bghsa.text.formatTime(tracking.triageSince);
      if (since !== null) built.body.append(element(doc, 'span', 'bghsa-since', `since ${since}`));
      rows.push(built.row);
    }
    if (tracking.owners.length > 0) rows.push(chipRow(doc, 'Owners', tracking.owners));
    if (tracking.backports.length > 0) {
      rows.push(chipRow(doc, 'Backport targets', tracking.backports));
    }
    if (tracking.embargo) {
      const built = row(doc, 'Embargo');
      built.body.className = 'flex-auto bghsa-chips';
      // The text also identifies an overdue embargo for readers who cannot
      // distinguish its color.
      built.body.append(
        globalThis.bghsa.chips.buildChip(doc, {
          text: embargoText(tracking.embargoLift, embargoOverdue),
          tone: embargoOverdue ? 'danger' : 'attention',
        })
      );
      rows.push(built.row);
    }
    if (tracking.closureReason !== null) {
      const built = row(doc, 'Closed as');
      built.body.className = 'flex-auto bghsa-chips';
      const reason = sentenceCase(tracking.closureReason);
      built.body.append(globalThis.bghsa.chips.buildChip(doc, { text: reason }));
      if (tracking.closureDuplicateOf !== null) {
        built.body.append(
          globalThis.bghsa.duplicate.buildDuplicate(
            doc,
            'bghsa-since',
            tracking.closureDuplicateOf,
            ref
          )
        );
      }
      rows.push(built.row);
    }
    return rows;
  }

  /**
   * These failures occur before a preservation request is sent and allow retries.
   *
   * @type {readonly string[]}
   */
  const RETRYABLE = [
    'allowlist',
    'provenance',
    'unreadable',
    'unverifiable',
    'no-form',
    'mismatch',
    'fetch',
  ];

  /**
   * Disable retries after a request may have created a preservation comment.
   *
   * @param {Document} doc
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {Element} button
   * @param {import('./preserve.js').PreserveOptions} [options]
   * @returns {Promise<import('../common/write.js').WriteResult>}
   */
  async function press(doc, advisory, button, options) {
    const host = button.parentElement;
    const note = host?.querySelector('.bghsa-preserve-note') ?? null;
    for (const stale of host?.querySelectorAll('.bghsa-preserve-result') ?? []) stale.remove();
    button.setAttribute('disabled', '');
    button.setAttribute('aria-disabled', 'true');
    if (note !== null) note.textContent = globalThis.bghsa.write.SAVING_MESSAGE;

    const outcome = await globalThis.bghsa.preserve.preserve(advisory, options);

    if (outcome.ok) {
      button.remove();
      if (note !== null) note.textContent = globalThis.bghsa.preserve.PRESERVED_MESSAGE;
      return outcome;
    }

    if (outcome.reason === 'preserved') {
      button.remove();
      if (note !== null) note.textContent = outcome.message;
      return outcome;
    }
    if (note !== null) note.textContent = '';
    // Allow retries only when the request could not have created a comment.
    const retryable = outcome.reason !== null && RETRYABLE.includes(outcome.reason);
    const banner = warning(doc, outcome.message);
    banner.classList.add('bghsa-preserve-result');
    host?.append(banner);
    if (retryable) {
      button.removeAttribute('disabled');
      button.removeAttribute('aria-disabled');
    }
    return outcome;
  }

  /**
   * Show the preservation control or a link to the existing comment. The caller
   * omits this row for published and closed advisories.
   *
   * @param {Document} doc
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {Element}
   */
  function buildPreserve(doc, advisory) {
    const state = globalThis.bghsa.preserve.offered(advisory);
    const built = row(doc, 'Original report');
    if (!state.available) {
      if (state.href === null) built.body.textContent = state.message;
      else {

        const link = element(doc, 'a', 'bghsa-preserved', 'Preserved');
        link.setAttribute('href', state.href);
        built.body.append(link);
      }
      return built.row;
    }
    const button = element(doc, 'button', 'btn btn-sm bghsa-preserve', 'Preserve');
    button.setAttribute('type', 'button');
    built.body.append(button);
    built.body.append(element(doc, 'span', 'ml-2 bghsa-preserve-note', state.message));
    button.addEventListener('click', () => {
      void press(doc, advisory, button);
    });
    return built.row;
  }

  /**
   * Build the panel from parsed and derived state.
   *
   * @param {Document} doc
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {import('../common/derive.js').DerivedState} derived
   * @param {import('./tracking.js').TrackingView} tracking
   * @param {import('./edit.js').EditorContext} [context] Enables editing when supplied.
   * @returns {Element}
   */
  function buildPanel(doc, advisory, derived, tracking, context) {
    const panel = element(doc, 'div', 'Box mb-3 bghsa-panel');
    panel.id = PANEL_ID;
    panel.setAttribute('data-bghsa-panel', '1');
    const embargoOverdue = globalThis.bghsa.derive.embargoOverdue(
      advisory,
      tracking.embargo ? tracking.embargoLift : null
    );
    panel.append(buildChips(doc, advisory, derived, tracking));

    const dealtWith = settled(advisory);
    if (!dealtWith) panel.append(buildConfirmations(doc, tracking, advisory));
    for (const track of buildTracks(doc, tracking, embargoOverdue, advisory.ref)) {
      panel.append(track);
    }

    if (!dealtWith) panel.append(buildPreserve(doc, advisory));

    if (context !== undefined) panel.append(globalThis.bghsa.edit.buildEditor(doc, context));

    return panel;
  }

  /**
   * Place the panel above the description and outside GitHub's independently
   * replaced live regions.
   *
   * @param {Document} doc
   * @returns {{ parent: Element, before: Element } | null}
   */
  function anchor(doc) {
    const header = doc.querySelector(globalThis.bghsa.parseDetail.DESCRIPTION_HEADER);
    const box = header === null ? null : header.closest('div.Box');
    const region = box === null ? null : box.closest('div.js-socket-channel');
    const before = region ?? box;
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
   * Replace an existing panel or insert one at the description anchor.
   *
   * @param {Document} doc
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {import('../common/derive.js').DerivedState} derived
   * @param {import('./tracking.js').TrackingView} tracking
   * @param {import('./edit.js').EditorContext} [context] Enables editing when supplied.
   * @returns {Element | null} The panel, or null if neither an anchor nor an existing panel
   *   is available.
   */
  function injectPanel(doc, advisory, derived, tracking, context) {
    const panel = buildPanel(doc, advisory, derived, tracking, context);
    const existing = doc.getElementById(PANEL_ID);
    const place = anchor(doc);
    if (place !== null) {
      if (existing !== null) existing.remove();
      place.parent.insertBefore(panel, place.before);
    } else if (existing !== null) {
      existing.replaceWith(panel);
    } else {
      return null;
    }
    ensureStyle(doc);
    return panel;
  }

  /**
   * Check for a missing panel or one displaced by a GitHub subtree replacement.
   *
   * @param {Document} doc
   * @returns {boolean}
   */
  function outOfPlace(doc) {
    const panel = doc.getElementById(PANEL_ID);
    if (panel === null) return true;
    const place = anchor(doc);
    return place !== null && panel.nextElementSibling !== place.before;
  }

  /**
   * Share one render loop per document to serialize observer and save requests.
   *
   * @type {WeakMap<Document, () => Promise<void>>}
   */
  const loops = new WeakMap();

  /**
   * Retain the mounted panel and the external inputs captured by its handlers.
   *
   * @type {WeakMap<Document, { panel: Element, inputs: string }>}
   */
  const rendered = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {() => Promise<void>} The document's render loop, created on first use.
   */
  function passFor(doc) {
    const held = loops.get(doc);
    if (held !== undefined) return held;
    const loop = renderLoop(doc);
    loops.set(doc, loop);
    return loop;
  }

  /**
   * Refresh the cache from the open detail page (REQUIREMENTS.md section 9).
   * Skip documents behind a local state or preservation write. Caching them
   * would replace newer data with old content under a fresh timestamp.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {Promise<import('../common/cache.js').CacheEntry | null>} The cached entry, or
   *   null for an unidentified advisory, a document behind a local write, or a storage
   *   failure.
   */
  function remember(advisory) {
    if (advisory.ref === null) return Promise.resolve(null);
    const edit = globalThis.bghsa.edit;
    const fromPage = globalThis.bghsa.merge.mergeSnapshots(advisory.comments);
    if (edit.ahead(edit.keyOf(advisory), fromPage)) return Promise.resolve(null);
    if (globalThis.bghsa.preserve.ahead(advisory)) return Promise.resolve(null);
    return globalThis.bghsa.cache.putAdvisory(advisory.ref, advisory);
  }

  /**
   * Read the document and place the panel. Fingerprinting confirmation values
   * requires an asynchronous digest.
   *
   * @param {Document} doc
   * @returns {Promise<Element | null>}
   */
  async function render(doc) {
    const edit = globalThis.bghsa.edit;
    const advisory = globalThis.bghsa.parseDetail.parseDetail(doc);
    // Record departures caused by navigation without a click.
    if (advisory === null) {
      rendered.delete(doc);
      edit.panelShows(null);
      return null;
    }

    edit.panelShows(edit.keyOf(advisory));

    void remember(advisory);

    // Prefer locally saved state until the document includes that write.
    const context = await edit.contextFor(advisory, {
      rerender: () => {
        // Save/discard feedback must refresh even when external data is unchanged.
        rendered.delete(doc);
        return passFor(doc)();
      },
    });

    // Changes to sequence numbers, holders, fingerprints, or unknown fields
    // require new handlers even when the displayed values are unchanged.
    const inputs = JSON.stringify({
      advisory,
      merged: context.merged,
      tracking: context.tracking,
      fingerprints: context.fingerprints,
      derived: context.derived,
      preserve: globalThis.bghsa.preserve.offered(advisory),
      members: globalThis.bghsa.members.known(advisory.ref),
      branches: globalThis.bghsa.branches.known(advisory.ref),
      embargoOverdue: globalThis.bghsa.derive.embargoOverdue(
        advisory,
        context.tracking.embargo ? context.tracking.embargoLift : null
      ),
    });

    // Read after contextFor yields: another pass may have installed a panel.
    const held = rendered.get(doc);
    const place = anchor(doc);
    const reusable = held !== undefined &&
      held.inputs === inputs &&
      doc.getElementById(PANEL_ID) === held.panel &&
      held.panel.ownerDocument === doc &&
      held.panel.isConnected &&
      place !== null &&
      held.panel.parentElement === place.parent &&
      held.panel.nextElementSibling === place.before;

    const placed = reusable
      ? held.panel
      : injectPanel(doc, advisory, context.derived, context.tracking, context);

    if (placed !== null) rendered.set(doc, { panel: placed, inputs });
    else rendered.delete(doc);

    // Comment chips need styles even when the panel cannot be placed.
    ensureStyle(doc);
    globalThis.bghsa.comments.markComments(doc, context.merged);

    // Refresh member and branch suggestions after storage loads without delaying
    // this render.
    void Promise.all([
      globalThis.bghsa.members.sync(),
      globalThis.bghsa.branches.sync(),
    ]).then((grew) => {
      if (grew.includes(true)) void passFor(doc)();
    });

    return placed;
  }

  /**
   * @returns {string} A selector for the panel, stylesheet, and comment chips.
   */
  function ownedSelector() {
    const attribute = globalThis.bghsa.parseDetail.EXTENSION_CHIP_ATTRIBUTE;
    return `#${PANEL_ID}, #${STYLE_ID}, [${attribute}]`;
  }

  /**
   * Serialize asynchronous renders to prevent an older read from overwriting
   * a newer panel. Coalesce requests during a pass into one subsequent pass.
   *
   * @param {Document} doc
   * @returns {() => Promise<void>}
   */
  function renderLoop(doc) {
    let running = false;
    let again = false;
    return async function pass() {
      if (running) {
        again = true;
        return;
      }
      // Recheck the allowlist after GitHub navigation within the same document.
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
    };
  }

  /**
   * Refresh the panel and comment chips when GitHub changes live regions or
   * removes or displaces the panel.
   *
   * @param {Document} doc
   * @param {() => Promise<void>} [pass] The shared render loop.
   * @returns {MutationObserver | null} The observer, or null if observation is unavailable.
   */
  function observe(doc, pass = renderLoop(doc)) {
    return globalThis.bghsa.dom.watch(doc, { ownedSelector, outOfPlace, pass });
  }

  /**
   * Retain the observer and navigation cleanup callback for {@link stop}.
   *
   * @type {WeakMap<Document, { observer: MutationObserver | null, disarm: () => void }>}
   */
  const attached = new WeakMap();

  /**
   * @returns {void}
   */
  function start() {
    const doc = globalThis.document;
    const pass = passFor(doc);
    void pass();
    const observer = observe(doc, pass);
    const disarm = globalThis.bghsa.edit.armNavigationWarning(doc);
    attached.set(doc, { observer, disarm });
  }

  /**
   * Disconnect the observer before removing the panel to prevent reinsertion.
   *
   * @param {Document} [doc]
   * @returns {void}
   */
  function stop(doc = globalThis.document) {
    rendered.delete(doc);

    const held = attached.get(doc);
    if (held !== undefined) {
      held.observer?.disconnect();
      held.disarm();
      attached.delete(doc);
    }

    for (const node of doc.querySelectorAll(ownedSelector())) node.remove();
  }

  const exported = {
    PANEL_ID,
    STYLE_ID,
    press,
    buildPanel,
    anchor,
    ensureStyle,
    outOfPlace,
    injectPanel,
    remember,
    render,
    renderLoop,
    passFor,
    observe,
    start,
    stop,
  };

  globalThis.bghsa.panel = exported;

  // src/content.js starts surfaces after checking the page and allowlist.
  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
