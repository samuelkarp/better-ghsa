'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/dom.js');
  require('../common/text.js');
  require('../common/storage.js');
  require('../common/schema.js');
  require('../common/write.js');
  require('../common/merge.js');
  require('../common/parse-detail.js');
  require('../common/derive.js');
  require('../common/chips.js');
  require('../common/members.js');
  require('../common/branches.js');
  require('../common/cache.js');
  require('./tracking.js');
  require('./state.js');
}

/**
 * @typedef {import('../common/parse-detail.js').ParsedDetail} ParsedDetail
 * @typedef {import('../common/derive.js').DerivedState} DerivedState
 * @typedef {import('../common/merge.js').MergedState} MergedState
 * @typedef {import('../common/write.js').WriteFetch} WriteFetch
 * @typedef {import('./tracking.js').TrackingView} TrackingView
 * @typedef {import('./tracking.js').Fingerprints} Fingerprints
 * @typedef {import('./tracking.js').ConfirmationTrack} ConfirmationTrack
 * @typedef {import('./state.js').StateWriteResult} StateWriteResult
 */

/**
 * Pending fields differ from stored state and are waiting to be saved.
 *
 * @typedef {object} Pending
 * @property {string | null} [triage]
 * @property {string[]} [owners]
 * @property {string[]} [backports]
 * @property {boolean} [embargo]
 * @property {string | null} [embargoLift]
 * @property {string | null} [closureReason]
 * @property {string | null} [closureDuplicateOf]
 * @property {Partial<Record<ConfirmationTrack, boolean>>} [confirm]
 * @property {boolean} [supersede] Approval to supersede an unreadable snapshot. This flag
 *   is excluded from the snapshot and the pending-change count.
 */

/**
 * Each render pass builds the state used by the editor and its save handler.
 *
 * @typedef {object} EditorContext
 * @property {ParsedDetail} advisory
 * @property {DerivedState} derived
 * @property {TrackingView} tracking The stored state, as the panel displays it.
 * @property {Fingerprints} fingerprints Fingerprints of displayed values for confirmation
 *   records.
 * @property {MergedState} merged Loaded state used for concurrency checks.
 * @property {() => Promise<void> | void} [rerender] Redraws the surface after a save.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 * @property {string} [at] An explicit write timestamp.
 */

/**
 * Owners and backport targets share a control with removable chips and a text
 * field for adding values.
 *
 * @typedef {object} ChipList
 * @property {string} label The row's label.
 * @property {string} name The CSS class suffix for each control part.
 * @property {string} noun The item name used in Remove labels.
 * @property {string} placeholder
 * @property {string[]} candidates Suggestions in display order.
 * @property {(value: string) => string} fold Normalizes equality comparisons. Logins are
 *   case-insensitive; branch names are case-sensitive.
 * @property {Map<string, string>} drafts Retains unfinished input across renders.
 * @property {() => string[]} held Returns selected values.
 * @property {(values: string[]) => void} put Stages selected values.
 */

(() => {

  const READ_ONLY_MESSAGE = 'Update the extension to edit';

  const SAVED_MESSAGE = 'Saved.';

  const WRITING_MESSAGE = globalThis.bghsa.write.SAVING_MESSAGE;

  /**
   * Mark controls disabled during a save to restore only those controls afterward.
   */
  const FLIGHT_MARK = 'data-bghsa-flight';

  const LEAVE_MESSAGE = 'Better GHSA: Leave without saving your changes?';

  /**
   * Superseding writes a higher sequence number. The unreadable comment remains.
   */
  const SUPERSEDE_LABEL = 'Supersede unparsed state';

  /**
   * Retain unsaved changes across panel rebuilds, keyed by {@link keyOf}.
   *
   * @type {Map<string, Pending>}
   */
  const edits = new Map();

  /**
   * Prefer locally written state until the live document includes that write.
   *
   * @type {Map<string, MergedState>}
   */
  const written = new Map();

  /**
   * Record the latest save result for each advisory.
   *
   * @type {Map<string, { ok: boolean, message: string, diagnostic?: import('../common/write.js').WriteDiagnostic }>}
   */
  const results = new Map();

  const opened = new Set();

  /**
   * Retain partially typed logins across renders. They become pending changes
   * only when added to the owner list.
   *
   * @type {Map<string, string>}
   */
  const drafts = new Map();

  /**
   * Retain partially typed backport branches across renders.
   *
   * @type {Map<string, string>}
   */
  const branchDrafts = new Map();

  /**
   * Identify the visible advisory for navigation warnings. Pending edits can
   * belong to advisories visited earlier in the same document.
   *
   * @type {{ key: string | null }}
   */
  const showing = { key: null };

  /**
   * Retain the confirmation callback for departures detected by later renders.
   *
   * @type {((message: string) => boolean) | null}
   */
  let asker = null;

  /**
   * Disable rebuilt controls while a save is pending. Changes staged during a
   * request would be absent from that request.
   *
   * @type {Set<string>}
   */
  const saving = new Set();

  /**
   * @param {ParsedDetail} advisory
   * @returns {string} The lowercase key for this advisory's edits.
   */
  function keyOf(advisory) {
    const ref = advisory.ref;
    const name = ref === null ? (advisory.ghsaId ?? '') : `${ref.owner}/${ref.repo}/${ref.ghsaId}`;
    return name.toLowerCase();
  }

  /**
   * @param {string} key
   * @returns {Pending} The pending edits.
   */
  function editsFor(key) {
    return edits.get(key) ?? {};
  }

  /**
   * Stage only changes a save can write, as determined by {@link differences}.
   * Values excluded by another control remain in their input fields.
   *
   * @param {string} key
   * @param {TrackingView} tracking
   * @param {Pending} patch
   * @returns {void}
   */
  function stage(key, tracking, patch) {
    const kept = differences(tracking, { ...editsFor(key), ...patch });
    if (Object.keys(kept).length === 0) edits.delete(key);
    else edits.set(key, kept);
    results.delete(key);
  }

  /**
   * @param {string} key
   * @param {TrackingView} tracking
   * @param {ConfirmationTrack} track
   * @param {boolean} value
   * @returns {void}
   */
  function stageConfirmation(key, tracking, track, value) {
    stage(key, tracking, { confirm: { ...editsFor(key).confirm, [track]: value } });
  }

  /**
   * Remove an unavailable confirmation without clearing the last save result.
   *
   * @param {string} key
   * @param {ConfirmationTrack} track
   * @returns {void}
   */
  function unstageConfirmation(key, track) {
    const pending = edits.get(key);
    if (pending?.confirm?.[track] === undefined) return;
    const confirm = { ...pending.confirm };
    delete confirm[track];
    /** @type {Pending} */
    const kept = { ...pending };
    if (Object.keys(confirm).length === 0) delete kept.confirm;
    else kept.confirm = confirm;
    if (Object.keys(kept).length === 0) edits.delete(key);
    else edits.set(key, kept);
  }

  /**
   * @param {string} key
   * @returns {void}
   */
  function discard(key) {
    edits.delete(key);
    results.delete(key);
    drafts.delete(key);
    branchDrafts.delete(key);
  }

  /**
   * GitHub logins are case-insensitive.
   *
   * @param {string} login
   * @returns {string}
   */
  function foldLogin(login) {
    return login.toLowerCase();
  }

  /**
   * GHSA identifiers are case-insensitive.
   *
   * @param {string | null | undefined} id
   * @returns {string | null | undefined}
   */
  function foldGhsaId(id) {
    return typeof id === 'string' ? id.toLowerCase() : id;
  }

  /**
   * Owner and backport order is insignificant. Compare logins case-insensitively
   * and branch names case-sensitively.
   *
   * @param {string[]} left
   * @param {string[]} right
   * @param {(value: string) => string} [fold]
   * @returns {boolean} Whether the lists contain the same values.
   */
  function sameList(left, right, fold = (value) => value) {
    if (left.length !== right.length) return false;
    const one = left.map(fold).sort();
    const two = right.map(fold).sort();
    return one.every((value, index) => value === two[index]);
  }

  /**
   * @template T
   * @param {T | undefined} staged
   * @param {T} stored
   * @returns {T} The staged value, including null for a cleared field, or the stored value
   *   when unstaged.
   */
  function pick(staged, stored) {
    return staged === undefined ? stored : staged;
  }

  /**
   * Compare pending values with stored state. This includes values retained in
   * disabled controls; {@link differences} excludes those from saves.
   *
   * @param {TrackingView} tracking
   * @param {Pending} pending
   * @returns {Pending}
   */
  function staged(tracking, pending) {
    /** @type {Pending} */
    const kept = {};
    if (pending.triage !== undefined && pending.triage !== tracking.triage) {
      kept.triage = pending.triage;
    }
    if (pending.owners !== undefined && !sameList(pending.owners, tracking.owners, foldLogin)) {
      kept.owners = pending.owners;
    }
    if (pending.backports !== undefined && !sameList(pending.backports, tracking.backports)) {
      kept.backports = pending.backports;
    }
    if (pending.embargo !== undefined && pending.embargo !== tracking.embargo) {
      kept.embargo = pending.embargo;
    }
    if (pending.embargoLift !== undefined && pending.embargoLift !== tracking.embargoLift) {
      kept.embargoLift = pending.embargoLift;
    }
    if (pending.closureReason !== undefined && pending.closureReason !== tracking.closureReason) {
      kept.closureReason = pending.closureReason;
    }
    if (
      pending.closureDuplicateOf !== undefined &&
      foldGhsaId(pending.closureDuplicateOf) !== foldGhsaId(tracking.closureDuplicateOf)
    ) {
      kept.closureDuplicateOf = pending.closureDuplicateOf;
    }
    /** @type {Partial<Record<ConfirmationTrack, boolean>>} */
    const confirm = {};
    for (const track of globalThis.bghsa.tracking.CONFIRMATION_TRACKS) {
      const value = pending.confirm?.[track.key];
      if (value === undefined) continue;
      if (value === (tracking[track.key].status === 'confirmed')) continue;
      confirm[track.key] = value;
    }
    if (Object.keys(confirm).length > 0) kept.confirm = confirm;
    if (pending.supersede !== undefined) kept.supersede = pending.supersede;
    return kept;
  }

  /**
   * Exclude a lift date when embargo is off and a duplicate ID when the closure
   * reason is not duplicate.
   *
   * @param {TrackingView} tracking
   * @param {Pending} pending
   * @returns {Pending}
   */
  function differences(tracking, pending) {
    const kept = staged(tracking, pending);
    if (!pick(pending.embargo, tracking.embargo)) delete kept.embargoLift;
    if (pick(pending.closureReason, tracking.closureReason) !== 'duplicate') {
      delete kept.closureDuplicateOf;
    }
    return kept;
  }

  /**
   * Use the same comparison for the save, button state, and unsaved-change list.
   *
   * @param {TrackingView} tracking
   * @param {Pending} pending
   * @returns {string[]}
   */
  function changedTracks(tracking, pending) {
    const diff = differences(tracking, pending);
    /** @type {string[]} */
    const names = [];
    if (diff.triage !== undefined) names.push('Triage');
    if (diff.owners !== undefined) names.push('Owners');
    if (diff.backports !== undefined) names.push('Backport targets');
    if (diff.embargo !== undefined || diff.embargoLift !== undefined) names.push('Embargo');
    if (diff.closureReason !== undefined || diff.closureDuplicateOf !== undefined) {
      names.push('Closed as');
    }
    for (const track of globalThis.bghsa.tracking.CONFIRMATION_TRACKS) {
      if (diff.confirm?.[track.key] !== undefined) names.push(track.name);
    }
    return names;
  }

  /**
   * Recheck pending edits against freshly read state and discard matching or
   * inapplicable values.
   *
   * @param {string} key
   * @param {TrackingView} tracking
   * @returns {void}
   */
  function prune(key, tracking) {
    const pending = edits.get(key);
    if (pending === undefined) return;
    const kept = differences(tracking, pending);
    if (PENDING_FIELDS.every((field) => !Object.hasOwn(kept, field)) && kept.supersede !== true) {
      edits.delete(key);
    } else {
      edits.set(key, kept);
    }
  }

  /**
   * Remove saved values while preserving edits staged after the request started.
   * Supersede confirmation applies only to the write that used it.
   *
   * @param {string} key
   * @param {Pending} captured The edits sent in the request.
   * @returns {void}
   */
  function release(key, captured) {
    const pending = edits.get(key);
    if (pending === undefined) return;
    /** @type {Pending} */
    const kept = { ...pending };
    if (captured.triage !== undefined && kept.triage === captured.triage) delete kept.triage;
    if (
      captured.owners !== undefined &&
      kept.owners !== undefined &&
      sameList(kept.owners, captured.owners, foldLogin)
    ) {
      delete kept.owners;
    }
    if (
      captured.backports !== undefined &&
      kept.backports !== undefined &&
      sameList(kept.backports, captured.backports)
    ) {
      delete kept.backports;
    }
    if (captured.embargo !== undefined && kept.embargo === captured.embargo) delete kept.embargo;
    if (captured.embargoLift !== undefined && kept.embargoLift === captured.embargoLift) {
      delete kept.embargoLift;
    }
    if (captured.closureReason !== undefined && kept.closureReason === captured.closureReason) {
      delete kept.closureReason;
    }
    if (
      captured.closureDuplicateOf !== undefined &&
      kept.closureDuplicateOf !== undefined &&
      foldGhsaId(kept.closureDuplicateOf) === foldGhsaId(captured.closureDuplicateOf)
    ) {
      delete kept.closureDuplicateOf;
    }
    if (captured.confirm !== undefined) {
      /** @type {Partial<Record<ConfirmationTrack, boolean>>} */
      const confirm = { ...kept.confirm };
      for (const track of globalThis.bghsa.tracking.CONFIRMATION_TRACKS) {
        const written = captured.confirm[track.key];
        if (written !== undefined && confirm[track.key] === written) delete confirm[track.key];
      }
      if (Object.keys(confirm).length === 0) delete kept.confirm;
      else kept.confirm = confirm;
    }
    delete kept.supersede;
    if (Object.keys(kept).length === 0) edits.delete(key);
    else edits.set(key, kept);
  }

  /**
   * Use null to delete a stored field. Omit absent fields because snapshot
   * validation rejects null values left in the resulting object.
   *
   * @param {string} key
   * @param {string | null} value
   * @param {string | null} stored
   * @returns {Record<string, unknown>}
   */
  function optional(key, value, stored) {
    if (value !== null) return { [key]: value };
    return stored === null ? {} : { [key]: null };
  }

  /**
   * Supersede approval permits a write but does not count as an unsaved change.
   *
   * @type {readonly string[]}
   */
  const PENDING_FIELDS = [
    'triage',
    'owners',
    'backports',
    'embargo',
    'embargoLift',
    'closureReason',
    'closureDuplicateOf',
    'confirm',
  ];

  /**
   * @param {string} key
   * @returns {boolean} Whether this advisory has pending edits.
   */
  function pendingOn(key) {
    const pending = edits.get(key);
    if (pending === undefined) return false;
    return PENDING_FIELDS.some((field) => Object.hasOwn(pending, field));
  }

  /**
   * @returns {boolean} Whether any advisory has pending edits.
   */
  function anyPending() {
    for (const key of edits.keys()) {
      if (pendingOn(key)) return true;
    }
    return false;
  }

  /**
   * Detect advisory departures after GitHub replaces the content frame.
   * Confirmation discards pending changes; declining retains them for a return
   * to that advisory.
   *
   * @param {string | null} key The visible advisory key, or null.
   * @returns {void}
   */
  function panelShows(key) {
    const left = showing.key;
    if (left === key) return;
    showing.key = key;
    if (left === null || asker === null || !pendingOn(left)) return;
    if (asker(LEAVE_MESSAGE)) discard(left);
  }

  /**
   * Ignore navigation within the page and links opened in another tab or window.
   *
   * @param {Event} event
   * @returns {boolean}
   */
  function leavesPage(event) {
    const mouse = /** @type {{ button?: unknown, metaKey?: unknown, ctrlKey?: unknown,
     *   shiftKey?: unknown, altKey?: unknown }} */ (/** @type {unknown} */ (event));
    if (typeof mouse.button === 'number' && mouse.button !== 0) return false;
    if (mouse.metaKey === true || mouse.ctrlKey === true) return false;
    if (mouse.shiftKey === true || mouse.altKey === true) return false;

    const start = /** @type {Node | null} */ (event.target);
    const from =
      start === null
        ? null
        : start.nodeType === 1
          ? /** @type {Element} */ (/** @type {unknown} */ (start))
          : start.parentElement;
    const anchor = from === null ? null : from.closest('a[href]');
    if (anchor === null || anchor.hasAttribute('download')) return false;
    const target = anchor.getAttribute('target');
    if (target !== null && target !== '' && target !== '_self') return false;
    const href = anchor.getAttribute('href') ?? '';
    return href !== '' && !href.startsWith('#');
  }

  /**
   * Warn before unsaved changes are lost. A document unload checks all pending
   * edits because it destroys the store. Captured link clicks check the visible
   * advisory and can cancel GitHub frame navigation. Other departures are
   * detected by {@link panelShows}.
   *
   * @param {Document} doc
   * @param {{ confirm?: (message: string) => boolean }} [options]
   * @returns {() => void} Removes the navigation warnings.
   */
  function armNavigationWarning(doc, options) {
    const view = doc.defaultView;
    const ask =
      options?.confirm ?? ((message) => view?.confirm === undefined || view.confirm(message));
    asker = ask;

    /** @param {Event} event @returns {void} */
    const onUnload = (event) => {
      if (!anyPending()) return;
      event.preventDefault();
      // Trigger the browser's native unload confirmation.
      /** @type {{ returnValue?: unknown }} */ (/** @type {unknown} */ (event)).returnValue = '';
    };
    /** @param {Event} event @returns {void} */
    const onClick = (event) => {
      const key = showing.key;
      if (key === null || !pendingOn(key) || !leavesPage(event)) return;
      if (ask(LEAVE_MESSAGE)) {
        discard(key);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    view?.addEventListener('beforeunload', onUnload);
    doc.addEventListener('click', onClick, true);
    return () => {
      if (asker === ask) asker = null;
      view?.removeEventListener('beforeunload', onUnload);
      doc.removeEventListener('click', onClick, true);
    };
  }

  /**
   * Build changes from edited controls. Omitted fields remain unchanged.
   * Confirmations record the write's login and timestamp with the fingerprint
   * of the displayed value.
   *
   * @param {TrackingView} tracking
   * @param {Fingerprints} fingerprints
   * @param {Pending} pending
   * @param {{ by: string, at: string }} envelope
   * @returns {Record<string, unknown>}
   */
  function changesOf(tracking, fingerprints, pending, envelope) {
    const diff = differences(tracking, pending);
    /** @type {Record<string, unknown>} */
    const changes = {};

    if (diff.triage !== undefined) changes['triage'] = diff.triage;
    if (diff.owners !== undefined) changes['owners'] = diff.owners.length === 0 ? null : diff.owners;
    if (diff.backports !== undefined) {
      changes['backports'] = diff.backports.length === 0 ? null : diff.backports;
    }

    if (diff.embargo !== undefined || diff.embargoLift !== undefined) {
      const embargo = pick(pending.embargo, tracking.embargo);
      changes['embargo'] = embargo
        ? { ...optional('lift', pick(pending.embargoLift, tracking.embargoLift), tracking.embargoLift) }
        : null;
    }

    if (diff.closureReason !== undefined || diff.closureDuplicateOf !== undefined) {
      const reason = pick(pending.closureReason, tracking.closureReason);
      const duplicateOf = pick(pending.closureDuplicateOf, tracking.closureDuplicateOf);
      changes['closure'] =
        reason === null
          ? null
          : {
              reason,
              ...optional(
                'duplicateOf',
                reason === 'duplicate' ? duplicateOf : null,
                tracking.closureDuplicateOf
              ),
            };
    }

    /** @type {Record<string, unknown>} */
    const confirmed = {};
    for (const track of globalThis.bghsa.tracking.CONFIRMATION_TRACKS) {
      const staged = diff.confirm?.[track.key];
      if (staged === undefined) continue;
      if (!staged) {
        confirmed[track.key] = null;
        continue;
      }

      const fingerprint = fingerprints[track.key];
      if (fingerprint === null) continue;
      confirmed[track.key] = { by: envelope.by, at: envelope.at, fp: fingerprint };
    }
    if (Object.keys(confirmed).length > 0) changes['confirmed'] = confirmed;

    return changes;
  }

  /**
   * These controls remove whole objects. List their known fields for deletion
   * checks.
   *
   * @type {readonly { key: string, name: string, fields: readonly string[] }[]}
   */
  const NESTED_TRACKS = [
    { key: 'embargo', name: 'embargo', fields: ['lift'] },
    { key: 'closure', name: 'closure reason', fields: ['reason', 'duplicateOf'] },
  ];

  /**
   * @param {Record<string, unknown> | null} state
   * @param {string} key
   * @param {readonly string[]} known
   * @returns {string[]}
   */
  function unknownFields(state, key, known) {
    const held = state === null ? undefined : state[key];
    if (!globalThis.bghsa.schema.isPlainObject(held)) return [];
    return Object.keys(held).filter((field) => !known.includes(field));
  }

  /**
   * Reject deletion of nested objects containing unknown fields to preserve
   * data written by newer extension versions (REQUIREMENTS.md section 3).
   *
   * @param {Record<string, unknown> | null} state The state the write builds on.
   * @param {Record<string, unknown>} changes
   * @returns {{ key: string, name: string, fields: string[] }[]}
   */
  function unclearable(state, changes) {
    /** @type {{ key: string, name: string, fields: string[] }[]} */
    const blocked = [];
    for (const track of NESTED_TRACKS) {
      if (changes[track.key] !== null) continue;
      const unknown = unknownFields(state, track.key, track.fields);
      if (unknown.length > 0) blocked.push({ key: track.key, name: track.name, fields: unknown });
    }
    return blocked;
  }

  /**
   * @param {string} key
   * @param {MergedState} merged
   * @returns {void}
   */
  function remember(key, merged) {
    written.set(key, merged);
  }

  /**
   * Cache the advisory returned by a write, including fresh reads from refused
   * writes. Use the fetch timestamp because all data except a successfully
   * written comment was observed then (REQUIREMENTS.md section 2).
   *
   * @param {StateWriteResult} outcome
   * @returns {Promise<void>}
   */
  async function hold(outcome) {
    const advisory = outcome.advisory;
    if (advisory === null || advisory.ref === null) return;
    await globalThis.bghsa.cache.putAdvisory(
      advisory.ref,
      advisory,
      outcome.readAt === null ? {} : { at: outcome.readAt }
    );
  }

  /**
   * Compare sequence numbers, then holders when the numbers match. Concurrent
   * maintainers can use the same sequence number for different snapshots.
   *
   * @param {MergedState} fromPage The merged document state.
   * @param {MergedState} held
   * @returns {boolean}
   */
  function caughtUp(fromPage, held) {
    if (fromPage.observedSeq !== held.observedSeq) return fromPage.observedSeq > held.observedSeq;
    const state = globalThis.bghsa.state;
    return state.sameHolder(state.holderOf(fromPage), state.holderOf(held));
  }

  /**
   * Detect a document behind locally retained state. Such a document must not
   * replace newer cache data.
   *
   * @param {string} key
   * @param {MergedState} fromPage The merged document state.
   * @returns {boolean}
   */
  function ahead(key, fromPage) {
    const held = written.get(key);
    return held !== undefined && !caughtUp(fromPage, held);
  }

  /**
   * Prefer locally retained state until the document catches up.
   *
   * @param {string} key
   * @param {MergedState} fromPage The merged document state.
   * @returns {MergedState}
   */
  function preferred(key, fromPage) {
    const held = written.get(key);
    if (held === undefined) return fromPage;
    if (caughtUp(fromPage, held)) {
      written.delete(key);
      return fromPage;
    }
    return held;
  }

  /**
   * Represent a successful write as merged state at its new sequence number.
   *
   * @param {StateWriteResult} outcome
   * @returns {MergedState | null}
   */
  function afterWrite(outcome) {
    const merged = outcome.merged;
    if (merged === null || outcome.snapshot === null) return null;
    return {
      ...merged,
      state: outcome.snapshot,
      source: null,
      seq: merged.nextSeq,
      observedSeq: merged.nextSeq,
      nextSeq: merged.nextSeq + 1,
      // The written snapshot supersedes the unreadable snapshot.
      confirmationRequired: false,
    };
  }

  /**
   * @param {string} reason
   * @param {string} message
   * @returns {StateWriteResult}
   */
  function refused(reason, message) {
    return {
      ok: false,
      reason,
      status: null,
      message,
      snapshot: null,
      merged: null,
      advisory: null,
      readAt: null,
    };
  }

  /**
   * @param {unknown} error
   * @returns {string} The message for an exception with an unknown write outcome.
   */
  function failedMessage(error) {
    console.warn('[better-ghsa] the save did not finish', error);
    return globalThis.bghsa.write.UNCONFIRMED_MESSAGE;
  }

  /**
   * Request a render. If it fails, the save handler updates the existing controls.
   *
   * @param {EditorContext} context
   * @returns {Promise<void>}
   */
  async function repaint(context) {
    try {
      await context.rerender?.();
    } catch {
      // The save handler restores the controls and displays the recorded result.
    }
  }

  /**
   * Record a refusal and redraw to restore disabled controls.
   *
   * @param {EditorContext} context
   * @param {string} key
   * @param {string} reason
   * @param {string} message
   * @returns {Promise<StateWriteResult>}
   */
  async function stopped(context, key, reason, message) {
    results.set(key, { ok: false, message });
    await repaint(context);
    return refused(reason, message);
  }

  /**
   * Save the staged changes. Successful writes clear their edits and retain the
   * written state until the document catches up. Failures preserve pending edits.
   *
   * @param {EditorContext} context
   * @returns {Promise<StateWriteResult>}
   */
  async function save(context) {
    const key = keyOf(context.advisory);
    // Reject concurrent saves before either call can clear the first call's mark.
    if (saving.has(key)) {
      return stopped(context, key, 'in-flight', globalThis.bghsa.state.IN_FLIGHT_MESSAGE);
    }
    const pending = editsFor(key);
    // The Save button is disabled when there are no changes.
    if (changedTracks(context.tracking, pending).length === 0) {
      return stopped(context, key, 'unchanged', '');
    }
    const ref = context.advisory.ref;
    if (ref === null) {
      return stopped(context, key, 'unreadable', globalThis.bghsa.write.PARSE_MESSAGE);
    }

    results.delete(key);
    // Capture the edits sent by this request to preserve later edits on completion.
    const captured = differences(context.tracking, pending);
    saving.add(key);
    /** @type {StateWriteResult} */
    let outcome;
    try {
      outcome = await globalThis.bghsa.state.writeState({
        ref,
        loadedSeq: context.merged.observedSeq,
        // Distinguish concurrent snapshots with the same sequence number.
        loadedHolder: globalThis.bghsa.state.holderOf(context.merged),
        changes: (envelope) => changesOf(context.tracking, context.fingerprints, pending, envelope),
        // Check deletion against the freshly fetched state, which may contain
        // additional fields.
        guard: (state, changes) => {
          const blocked = unclearable(state, changes);
          if (blocked.length === 0) return null;
          console.warn(
            '[better-ghsa] the save would delete fields this extension does not recognize',
            blocked
          );
          return { reason: 'unclearable', message: globalThis.bghsa.write.OUTDATED_MESSAGE };
        },
        confirmed: pending.supersede === true,
        ...(context.at === undefined ? {} : { at: context.at }),
        ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
        ...(context.parseDocument === undefined ? {} : { parseDocument: context.parseDocument }),
      });
    } catch (error) {
      // Unexpected exceptions must also clear the saving state and redraw
      // the panel to restore its controls.
      saving.delete(key);
      return stopped(context, key, 'failed', failedMessage(error));
    }
    // Clear the mark before rendering to enable the rebuilt controls.
    saving.delete(key);

    const landed = outcome.ok ? afterWrite(outcome) : null;
    if (landed !== null) {
      release(key, captured);
      remember(key, landed);
    } else if (outcome.merged !== null) {
      remember(key, outcome.merged);
    }

    await hold(outcome);
    results.set(key, {
      ok: outcome.ok,
      message: outcome.ok ? SAVED_MESSAGE : outcome.message,
      ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
    });
    await repaint(context);
    return outcome;
  }

  const element = globalThis.bghsa.dom.element;

  /**
   * Builds a local, copyable explanation from the writer's structural facts.
   * The visible text remains available for manual copying if clipboard access fails.
   * @param {Document} doc
   * @param {import('../common/write.js').WriteDiagnostic} diagnostic
   * @returns {Element}
   */
  function diagnosticDetails(doc, diagnostic) {
    const details = element(doc, 'details', 'mt-2 bghsa-diagnostic');
    details.append(element(doc, 'summary', '', 'Diagnostic details'));
    const version = globalThis.bghsa.storage.api()?.runtime?.getManifest?.().version ?? 'unknown';
    /** @param {boolean | null} value */
    const answer = (value) => value === null ? 'unknown' : value ? 'yes' : 'no';
    /** @type {string[]} */
    let facts;
    switch (diagnostic.code) {
      case 'edit-form-missing-fields':
        facts = [`Missing: ${diagnostic.missingFields.join(', ')}`];
        break;
      case 'edit-form-missing':
        facts = ['Missing: edit comment form', `Target comment found: ${answer(diagnostic.targetCommentFound)}`];
        break;
      case 'comment-form-missing':
        facts = ['Missing: new comment form'];
        break;
      case 'form-destination-mismatch': {
        const checks = {
          'malformed-action': 'form action is a valid URL',
          origin: 'destination origin is https://github.com',
          credentials: 'destination URL excludes credentials',
          'advisory-path': 'destination path matches the advisory comment endpoint',
          'comment-path': 'destination path matches the target comment',
        };
        facts = [`Failed check: ${checks[diagnostic.failedCheck]}`];
        break;
      }
      case 'advisory-page-mismatch':
        facts = [
          `Advisory parser recognized page: ${answer(diagnostic.pageRecognized)}`,
          `Advisory identity read: ${answer(diagnostic.identityReadable)}`,
          `Identity matches requested advisory: ${answer(diagnostic.identityMatches)}`,
        ];
        break;
      case 'save-unconfirmed':
        facts = [
          `HTTP response status: ${diagnostic.status}`,
          `Matching response containers found: ${answer(diagnostic.commentContainersFound)}`,
          `Expected content found in one matching container: ${answer(diagnostic.expectedContentFound)}`,
          'Save unconfirmed: the comment may have been saved.',
        ];
        break;
    }
    const report = [
      `Extension: ${version}`,
      diagnostic.code === 'form-destination-mismatch'
        ? `Operation: ${diagnostic.operation} tracking comment`
        : diagnostic.code === 'comment-form-missing' || diagnostic.code === 'save-unconfirmed'
          || diagnostic.code === 'advisory-page-mismatch'
          ? 'Operation: save tracking state'
          : 'Operation: edit tracking comment',
      `Diagnostic: ${diagnostic.code}`,
      ...facts,
      `Comment POST sent: ${diagnostic.code === 'save-unconfirmed' ? 'yes' : 'no'}`,
    ].join('\n');
    const text = element(doc, 'pre', 'mt-2', report);
    text.setAttribute('style', 'white-space: pre-wrap; overflow-wrap: anywhere');
    const copy = element(doc, 'button', 'btn btn-sm bghsa-copy-diagnostic', 'Copy diagnostic');
    copy.setAttribute('type', 'button');
    const status = element(doc, 'span', 'ml-2 bghsa-copy-status');
    status.setAttribute('role', 'status');
    copy.addEventListener('click', () => {
      copy.setAttribute('disabled', '');
      void (async () => {
        try {
          await globalThis.navigator.clipboard.writeText(report);
          status.textContent = 'Copied.';
        } catch {
          status.textContent = 'Unable to copy. Select and copy the details above.';
        } finally {
          copy.removeAttribute('disabled');
        }
      })();
    });
    details.append(text, copy, status);
    return details;
  }

  /**
   * @param {Element} field
   * @returns {string} The control's live value, falling back to its value attribute.
   */
  function valueOf(field) {
    const live = /** @type {{ value?: unknown }} */ (/** @type {unknown} */ (field)).value;
    return typeof live === 'string' ? live : (field.getAttribute('value') ?? '');
  }

  /**
   * @param {Element} field
   * @returns {boolean} Whether the checkbox is checked.
   */
  function isChecked(field) {
    const live = /** @type {{ checked?: unknown }} */ (/** @type {unknown} */ (field)).checked;
    return typeof live === 'boolean' ? live : field.hasAttribute('checked');
  }

  const orNull = globalThis.bghsa.text.orNull;

  /**
   * @param {Element} node
   * @param {boolean} off
   * @returns {void}
   */
  function setDisabled(node, off) {
    if (off) {
      node.setAttribute('disabled', '');
      node.setAttribute('aria-disabled', 'true');
    } else {
      node.removeAttribute('disabled');
      node.removeAttribute('aria-disabled');
    }
  }

  /**
   * Read each input event to retain text if the panel is rebuilt before blur.
   *
   * @param {Element} field
   * @param {() => void} handler
   * @returns {void}
   */
  function onValue(field, handler) {
    field.addEventListener('input', handler);
    field.addEventListener('change', handler);
  }

  /**
   * @param {Document} doc
   * @param {string} label
   * @returns {{ field: Element, body: Element }} The labeled field and its control container.
   */
  function fieldRow(doc, label) {
    const field = element(doc, 'div', 'd-flex flex-items-center flex-wrap mb-2 bghsa-field');
    field.append(element(doc, 'span', 'text-bold bghsa-field-label', label));
    const body = element(doc, 'div', 'flex-auto bghsa-field-body');
    field.append(body);
    return { field, body };
  }

  /**
   * Include unknown stored values among the choices. `label` changes display
   * text while preserving the stored option value.
   *
   * @param {Document} doc
   * @param {string} className
   * @param {readonly string[]} values
   * @param {string | null} current
   * @param {string} blank The empty-option label.
   * @param {object} [options]
   * @param {(value: string) => string} [options.label] Formats display labels.
   * @param {string} [options.ariaLabel] The accessible label for a control without a visible label.
   * @returns {Element}
   */
  function selectControl(doc, className, values, current, blank, options = {}) {
    const label = options.label ?? ((value) => value);
    const node = element(doc, 'select', `form-select select-sm ${className}`);
    if (options.ariaLabel !== undefined) node.setAttribute('aria-label', options.ariaLabel);
    const empty = element(doc, 'option', '', blank);
    empty.setAttribute('value', '');
    if (current === null) empty.setAttribute('selected', '');
    node.append(empty);
    const offered = current !== null && !values.includes(current) ? [...values, current] : values;
    for (const value of offered) {
      const option = element(doc, 'option', '', label(value));
      option.setAttribute('value', value);
      if (value === current) option.setAttribute('selected', '');
      node.append(option);
    }
    return node;
  }

  /**
   * @param {Document} doc
   * @param {string} className
   * @param {boolean} checked
   * @param {string} label
   * @returns {{ wrap: Element, box: Element }}
   */
  function checkboxControl(doc, className, checked, label) {
    const wrap = element(doc, 'label', 'd-inline-flex flex-items-center mr-3');
    const box = element(doc, 'input', className);
    box.setAttribute('type', 'checkbox');
    if (checked) box.setAttribute('checked', '');
    wrap.append(box);
    wrap.append(element(doc, 'span', 'ml-1', label));
    return { wrap, box };
  }

  /**
   * @param {Document} doc
   * @param {string} className
   * @param {string} type
   * @param {string | null} value
   * @param {string} placeholder
   * @returns {Element}
   */
  function textControl(doc, className, type, value, placeholder) {
    const node = element(doc, 'input', `form-control input-sm ${className}`);
    node.setAttribute('type', type);
    node.setAttribute('placeholder', placeholder);
    node.setAttribute('value', value ?? '');
    return node;
  }

  /**
   * Suggest members observed in this organization. Fall back to advisory
   * collaborators when membership is unknown. Exclude the reporter from that
   * fallback because GitHub also lists the reporter as a collaborator.
   *
   * @param {EditorContext} context
   * @returns {string[]}
   */
  function ownerCandidates(context) {
    /** @type {string[]} */
    const candidates = [];
    const seen = globalThis.bghsa.members.known(context.advisory.ref);
    for (const login of [...context.derived.members, ...seen]) {
      if (!candidates.some((known) => known.toLowerCase() === login.toLowerCase())) {
        candidates.push(login);
      }
    }
    if (candidates.length > 0) return candidates;
    const reporter = context.advisory.reporter;
    return context.advisory.collaborators.filter(
      (login) => reporter === null || login.toLowerCase() !== reporter.toLowerCase()
    );
  }

  /**
   * Build the editor context using merged state, preferring locally retained
   * state until the document catches up. Record observed members and branches
   * synchronously to make them available to the pickers before storage finishes.
   *
   * @param {ParsedDetail} advisory
   * @param {object} [options]
   * @param {() => Promise<void> | void} [options.rerender] Redraws the requesting surface
   *   after a save.
   * @param {import('../common/write.js').WriteFetch} [options.fetch]
   * @param {(html: string) => Document} [options.parseDocument]
   * @returns {Promise<EditorContext>}
   */
  async function contextFor(advisory, options = {}) {
    const merged = preferred(
      keyOf(advisory),
      globalThis.bghsa.merge.mergeSnapshots(advisory.comments)
    );
    const fingerprints = await globalThis.bghsa.tracking.fingerprints(advisory);
    const tracking = globalThis.bghsa.tracking.read(merged.state, fingerprints);
    const derived = globalThis.bghsa.derive.derive(advisory);
    globalThis.bghsa.members.remember(advisory.ref, derived.members);
    globalThis.bghsa.branches.remember(advisory.ref, [
      ...derived.patch.branches.map((patch) => patch.branch),
      ...tracking.backports,
    ]);
    return {
      advisory,
      derived,
      tracking,
      fingerprints,
      merged,
      ...(options.rerender === undefined ? {} : { rerender: options.rerender }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.parseDocument === undefined ? {} : { parseDocument: options.parseDocument }),
    };
  }

  /**
   * @param {Document} doc
   * @param {EditorContext} context
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function triageField(doc, context, key, update) {
    const { field, body } = fieldRow(doc, 'Triage');
    const current = pick(editsFor(key).triage, context.tracking.triage);
    const control = selectControl(
      doc,
      'bghsa-triage',
      globalThis.bghsa.schema.TRIAGE_VALUES,
      current,
      'Not set'
    );
    control.addEventListener('change', () => {
      stage(key, context.tracking, { triage: orNull(valueOf(control)) });
      update();
    });
    body.append(control);
    return field;
  }

  /**
   * Suggest observed and stored backport branches in descending version order,
   * including release/2.10 before release/2.9. The control also accepts typed
   * branches outside these suggestions.
   *
   * @param {EditorContext} context
   * @returns {string[]}
   */
  function backportCandidates(context) {
    const branches = globalThis.bghsa.branches;
    const held = context.tracking.backports.filter((branch) => branches.isRelease(branch));
    return branches.order([...new Set([...branches.known(context.advisory.ref), ...held])]);
  }

  /**
   * @param {Document} doc
   * @param {string} key
   * @param {() => void} update
   * @param {ChipList} list
   * @returns {Element}
   */
  function chipListField(doc, key, update, list) {
    const { field, body } = fieldRow(doc, list.label);
    const chips = element(doc, 'div', `d-flex flex-wrap flex-items-center bghsa-${list.name}-list`);
    body.append(chips);

    const draw = () => {
      chips.textContent = '';
      for (const value of list.held()) {
        const chip = element(doc, 'span', `d-inline-flex flex-items-center mr-2 bghsa-${list.name}`);
        chip.append(element(doc, 'span', 'Label Label--secondary', value));
        const remove = element(doc, 'button', `btn-link ml-1 bghsa-${list.name}-remove`, 'Remove');
        remove.setAttribute('type', 'button');
        remove.setAttribute('aria-label', `Remove ${value} as ${list.noun}`);
        remove.addEventListener('click', () => {
          list.put(list.held().filter((one) => one !== value));
          draw();
          update();
        });
        chip.append(remove);
        chips.append(chip);
      }
    };
    draw();

    const typed = textControl(
      doc,
      `bghsa-${list.name}-input`,
      'text',
      list.drafts.get(key) ?? null,
      list.placeholder
    );
    onValue(typed, () => {
      const value = valueOf(typed);
      if (value === '') list.drafts.delete(key);
      else list.drafts.set(key, value);
    });
    const candidateList = element(doc, 'datalist', `bghsa-${list.name}-candidates`);
    candidateList.id = `bghsa-${list.name}-candidates-${key.replace(/[^a-z0-9-]/g, '-')}`;
    typed.setAttribute('list', candidateList.id);
    for (const value of list.candidates) {
      const option = element(doc, 'option', '');
      option.setAttribute('value', value);
      candidateList.append(option);
    }
    const add = element(doc, 'button', `btn btn-sm ml-2 bghsa-${list.name}-add`, 'Add');
    add.setAttribute('type', 'button');
    add.addEventListener('click', () => {
      const value = orNull(valueOf(typed));
      if (value === null) return;
      if (!list.held().some((one) => list.fold(one) === list.fold(value))) {
        list.put([...list.held(), value]);
      }
      typed.setAttribute('value', '');
      /** @type {{ value?: unknown }} */ (/** @type {unknown} */ (typed)).value = '';
      list.drafts.delete(key);
      draw();
      update();
    });
    body.append(typed);
    body.append(candidateList);
    body.append(add);
    return field;
  }

  /**
   * @param {Document} doc
   * @param {EditorContext} context
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function ownersField(doc, context, key, update) {
    return chipListField(doc, key, update, {
      label: 'Owners',
      name: 'owner',
      noun: 'an owner',
      placeholder: 'login',
      candidates: ownerCandidates(context),
      fold: foldLogin,
      drafts,
      held: () => pick(editsFor(key).owners, context.tracking.owners),
      put: (owners) => stage(key, context.tracking, { owners }),
    });
  }

  /**
   * @param {Document} doc
   * @param {EditorContext} context
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function backportsField(doc, context, key, update) {
    return chipListField(doc, key, update, {
      label: 'Backport targets',
      name: 'backport',
      noun: 'a backport target',
      placeholder: 'release/2.1',
      candidates: backportCandidates(context),
      fold: (branch) => branch,
      drafts: branchDrafts,
      held: () => pick(editsFor(key).backports, context.tracking.backports),
      put: (backports) => stage(key, context.tracking, { backports }),
    });
  }

  /**
   * @param {Document} doc
   * @param {EditorContext} context
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function embargoField(doc, context, key, update) {
    const { field, body } = fieldRow(doc, 'Embargo');
    const pending = editsFor(key);
    const inForce = pick(pending.embargo, context.tracking.embargo);
    const applies = checkboxControl(doc, 'bghsa-embargo', inForce, 'In force');
    const lift = textControl(
      doc,
      'bghsa-embargo-lift',
      'date',
      pick(pending.embargoLift, context.tracking.embargoLift),
      'yyyy-mm-dd'
    );
    // Retain the date in the disabled field for reuse if embargo is re-enabled.
    // Staging excludes it while embargo is off.
    setDisabled(lift, !inForce);
    applies.box.addEventListener('change', () => {
      const held = isChecked(applies.box);
      setDisabled(lift, !held);
      stage(key, context.tracking, { embargo: held });
      if (held) stage(key, context.tracking, { embargoLift: orNull(valueOf(lift)) });
      update();
    });
    onValue(lift, () => {
      stage(key, context.tracking, { embargoLift: orNull(valueOf(lift)) });
      update();
    });
    body.append(applies.wrap);
    body.append(element(doc, 'span', 'mr-1', 'Lifts'));
    body.append(lift);
    return field;
  }

  /**
   * @param {Document} doc
   * @param {EditorContext} context
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function closureField(doc, context, key, update) {
    const { field, body } = fieldRow(doc, 'Closed as');
    const pending = editsFor(key);
    const reason = pick(pending.closureReason, context.tracking.closureReason);
    const control = selectControl(
      doc,
      'bghsa-closure',
      globalThis.bghsa.schema.CLOSURE_REASONS,
      reason,
      'Not closed',
      { label: globalThis.bghsa.chips.sentenceCase }
    );
    const duplicate = textControl(
      doc,
      'bghsa-closure-duplicate',
      'text',
      pick(pending.closureDuplicateOf, context.tracking.closureDuplicateOf),
      'GHSA-xxxx-xxxx-xxxx'
    );
    const showDuplicate = () => {
      setDisabled(duplicate, orNull(valueOf(control)) !== 'duplicate');
    };
    showDuplicate();
    // Retain the duplicate ID in the disabled field for reuse if the reason
    // returns to duplicate. Staging excludes it for other reasons.
    control.addEventListener('change', () => {
      const reason = orNull(valueOf(control));
      stage(key, context.tracking, { closureReason: reason });
      if (reason === 'duplicate') {
        stage(key, context.tracking, { closureDuplicateOf: orNull(valueOf(duplicate)) });
      }
      showDuplicate();
      update();
    });
    onValue(duplicate, () => {
      stage(key, context.tracking, { closureDuplicateOf: orNull(valueOf(duplicate)) });
      update();
    });
    body.append(control);
    body.append(element(doc, 'span', 'mx-1', 'of'));
    body.append(duplicate);
    return field;
  }

  /**
   * Checking a track stages a confirmation of the displayed value. Clearing it
   * removes the confirmation record.
   *
   * @param {Document} doc
   * @param {EditorContext} context
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function confirmationField(doc, context, key, update) {
    const { field, body } = fieldRow(doc, 'Confirmed');
    const pending = editsFor(key);
    for (const track of globalThis.bghsa.tracking.CONFIRMATION_TRACKS) {
      const stored = context.tracking[track.key].status === 'confirmed';
      // A new confirmation requires a readable value to fingerprint.
      const unreadable = context.fingerprints[track.key] === null && !stored;
      if (unreadable) unstageConfirmation(key, track.key);
      const checked = unreadable ? false : pick(pending.confirm?.[track.key], stored);
      const control = checkboxControl(
        doc,
        `bghsa-confirm bghsa-confirm-${track.key}`,
        checked,
        track.name
      );
      if (unreadable) {
        setDisabled(control.box, true);
        control.wrap.append(element(doc, 'span', 'ml-1 bghsa-confirmation-note', 'Unavailable'));
      }
      control.box.addEventListener('change', () => {
        stageConfirmation(key, context.tracking, track.key, isChecked(control.box));
        update();
      });
      body.append(control.wrap);
    }
    return field;
  }

  /**
   * @param {Document} doc
   * @param {EditorContext} context
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function supersedeField(doc, context, key, update) {
    const { field, body } = fieldRow(doc, 'Override');
    const control = checkboxControl(
      doc,
      'bghsa-supersede',
      editsFor(key).supersede === true,
      SUPERSEDE_LABEL
    );
    control.box.addEventListener('change', () => {
      stage(key, context.tracking, { supersede: isChecked(control.box) });
      update();
    });
    body.append(control.wrap);
    return field;
  }

  /**
   * Rebuild controls from retained pending edits after GitHub replaces the
   * surrounding content.
   *
   * @param {Document} doc
   * @param {EditorContext} context
   * @returns {Element}
   */
  function buildEditor(doc, context) {
    const key = keyOf(context.advisory);

    panelShows(key);
    prune(key, context.tracking);
    const box = element(doc, 'div', 'Box-row bghsa-editor');

    if (context.merged.readOnly) {
      box.append(element(doc, 'div', 'flash flash-warn bghsa-read-only', READ_ONLY_MESSAGE));
      return box;
    }

    const disclosure = element(doc, 'details', 'bghsa-editor-details');
    if (opened.has(key)) disclosure.setAttribute('open', '');
    // Use a summary element to retain native disclosure semantics.
    const summary = element(doc, 'summary', 'btn btn-sm bghsa-editor-summary', 'Edit tracking state');
    summary.addEventListener('click', () => {
      if (opened.has(key)) opened.delete(key);
      else opened.add(key);
    });
    disclosure.append(summary);

    const controls = element(doc, 'div', 'pt-2 bghsa-controls');
    disclosure.append(controls);

    // The flash displays this result. The note displays results received afterward.
    const shown = results.get(key);

    /** @type {{ run: () => void }} */
    const hook = { run: () => {} };
    const update = () => hook.run();

    controls.append(triageField(doc, context, key, update));
    controls.append(ownersField(doc, context, key, update));
    controls.append(backportsField(doc, context, key, update));
    controls.append(embargoField(doc, context, key, update));
    controls.append(closureField(doc, context, key, update));
    controls.append(confirmationField(doc, context, key, update));
    if (context.merged.confirmationRequired) {
      controls.append(supersedeField(doc, context, key, update));
    }

    const bar = element(doc, 'div', 'd-flex flex-items-center flex-wrap mt-2 bghsa-save-row');
    const saveButton = element(doc, 'button', 'btn btn-sm btn-primary bghsa-save', 'Save');
    saveButton.setAttribute('type', 'button');
    const discardButton = element(doc, 'button', 'btn btn-sm ml-2 bghsa-discard', 'Discard changes');
    discardButton.setAttribute('type', 'button');
    const note = element(doc, 'span', 'ml-2 bghsa-save-note');
    bar.append(saveButton);
    bar.append(discardButton);
    bar.append(note);
    controls.append(bar);

    hook.run = () => {
      const flight = saving.has(key);
      const pending = editsFor(key);
      const names = changedTracks(context.tracking, pending);
      /** @type {string[]} */
      const said = [];
      if (names.length > 0) said.push(`Unsaved changes: ${names.join(', ')}.`);
      // Display newer results in the existing note if the replacement render failed.
      const result = results.get(key);
      if (result !== undefined && result !== shown && result.message !== '') {
        said.push(result.message);
      }

      note.textContent = flight ? WRITING_MESSAGE : said.join(' ');
      setDisabled(saveButton, flight || names.length === 0);
      setDisabled(discardButton, flight || names.length === 0);
      // Mark controls disabled by this save. Preserve controls disabled for
      // other reasons when restoring them.
      if (flight) {
        for (const node of controls.querySelectorAll('input, select, button')) {
          if (node.hasAttribute('disabled')) continue;
          node.setAttribute(FLIGHT_MARK, '');
          setDisabled(node, true);
        }
      } else {
        for (const node of controls.querySelectorAll(`[${FLIGHT_MARK}]`)) {
          node.removeAttribute(FLIGHT_MARK);
          setDisabled(node, false);
        }
      }
    };
    hook.run();

    saveButton.addEventListener('click', () => {
      // Update existing controls before and after saving, including when the
      // replacement render fails.
      void save(context).then(update, update);
      update();
    });
    discardButton.addEventListener('click', () => {
      discard(key);
      void context.rerender?.();
    });

    if (shown !== undefined) {
      controls.append(
        element(
          doc,
          'div',
          `flash mt-2 bghsa-save-result ${shown.ok ? 'flash-success' : 'flash-warn'}`,
          shown.message
        )
      );
    }

    if (shown?.diagnostic !== undefined) {
      controls.append(diagnosticDetails(doc, shown.diagnostic));
    }

    box.append(disclosure);
    return box;
  }

  const exported = {
    WRITING_MESSAGE,
    edits,
    written,
    results,
    opened,
    saving,
    drafts,
    branchDrafts,
    keyOf,
    editsFor,
    stage,
    release,
    changedTracks,
    pendingOn,
    anyPending,
    showing,
    panelShows,
    armNavigationWarning,
    setDisabled,
    changesOf,
    remember,
    hold,
    ahead,
    preferred,
    save,
    backportCandidates,
    contextFor,
    selectControl,
    buildEditor,
  };

  globalThis.bghsa.edit = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
