'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/schema.js');
  require('../common/merge.js');
}

/**
 * @typedef {import('../common/parse-detail.js').ParsedDetail} ParsedDetail
 * @typedef {import('../common/merge.js').MergedState} MergedState
 */

/**
 * A drifted confirmation has a different fingerprint from the current value.
 * Its author and timestamp remain available for display (REQUIREMENTS.md
 * section 6). An unreadable value could not be parsed for comparison.
 *
 * @typedef {'confirmed' | 'unconfirmed' | 'drifted' | 'unreadable'} ConfirmationStatus
 */

/**
 * @typedef {'title' | 'description' | 'scoring'} ConfirmationTrack
 */

/**
 * @typedef {object} Confirmation
 * @property {ConfirmationStatus} status
 * @property {string | null} by The confirming login.
 * @property {string | null} at The confirmation timestamp.
 */

/**
 * Confirmations use fingerprints of metadata form source values. A missing
 * field produces a null fingerprint. Empty severity and vector fields are
 * valid scoring inputs; their labels distinguish them in the fingerprint.
 *
 * @typedef {object} Fingerprints
 * @property {string | null} title
 * @property {string | null} description
 * @property {string | null} scoring
 */

/**
 * Unknown tracking values remain available for display as stored.
 *
 * @typedef {object} TrackingView
 * @property {string | null} triage
 * @property {string | null} triageSince
 * @property {string[]} owners
 * @property {string[]} backports
 * @property {boolean} embargo Whether an embargo applies.
 * @property {string | null} embargoLift
 * @property {string | null} closureReason
 * @property {string | null} closureDuplicateOf
 * @property {Confirmation} title
 * @property {Confirmation} description
 * @property {Confirmation} scoring
 */

(() => {
  /**
   * The panel and the unsaved-change list share these track names and order.
   *
   * @type {readonly { key: ConfirmationTrack, name: string }[]}
   */
  const CONFIRMATION_TRACKS = [
    { key: 'title', name: 'Title' },
    { key: 'description', name: 'Description' },
    { key: 'scoring', name: 'Severity' },
  ];

  /**
   * @param {Record<string, unknown> | null} record
   * @param {string} key
   * @returns {string | null} The string value, or null for missing, non-string, or blank values.
   */
  function stringField(record, key) {
    const value = record === null ? undefined : record[key];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  /**
   * @param {Record<string, unknown> | null} record
   * @param {string} key
   * @returns {string[]} Nonblank strings from the array field.
   */
  function stringArrayField(record, key) {
    const value = record === null ? undefined : record[key];
    if (!Array.isArray(value)) return [];
    return value.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
  }

  /**
   * @param {Record<string, unknown> | null} record
   * @param {string} key
   * @returns {Record<string, unknown> | null}
   */
  function objectField(record, key) {
    const value = record === null ? undefined : record[key];
    return globalThis.bghsa.schema.isPlainObject(value) ? value : null;
  }

  /**
   * A confirmation requires a fingerprint of the approved value.
   *
   * @param {Record<string, unknown> | null} state
   * @param {string} track
   * @param {string | null} current The fingerprint of the value on the page.
   * @returns {Confirmation}
   */
  function confirmationOf(state, track, current) {
    const record = objectField(objectField(state, 'confirmed'), track);
    const fingerprint = stringField(record, 'fp');
    if (fingerprint === null) return { status: 'unconfirmed', by: null, at: null };
    const by = stringField(record, 'by');
    const at = stringField(record, 'at');
    if (current === null) return { status: 'unreadable', by, at };
    return { status: fingerprint === current ? 'confirmed' : 'drifted', by, at };
  }

  /**
   * @param {Record<string, unknown> | null} state The merged snapshot.
   * @param {Fingerprints} fingerprints
   * @returns {TrackingView}
   */
  function read(state, fingerprints) {
    const embargo = objectField(state, 'embargo');
    const closure = objectField(state, 'closure');
    return {
      triage: stringField(state, 'triage'),
      triageSince: stringField(state, 'triageSince'),
      owners: stringArrayField(state, 'owners'),
      backports: stringArrayField(state, 'backports'),
      embargo: embargo !== null,
      embargoLift: stringField(embargo, 'lift'),
      closureReason: stringField(closure, 'reason'),
      closureDuplicateOf: stringField(closure, 'duplicateOf'),
      title: confirmationOf(state, 'title', fingerprints.title),
      description: confirmationOf(state, 'description', fingerprints.description),
      scoring: confirmationOf(state, 'scoring', fingerprints.scoring),
    };
  }

  /**
   * @returns {TrackingView} Tracking defaults for an advisory without stored state.
   */
  function untracked() {
    return read(null, { title: null, description: null, scoring: null });
  }

  /**
   * Fingerprint the metadata form source values, including raw description
   * markdown.
   *
   * @param {ParsedDetail} advisory
   * @returns {Promise<Fingerprints>}
   */
  async function fingerprints(advisory) {
    const schema = globalThis.bghsa.schema;
    const [title, description, scoring] = await Promise.all([
      advisory.title === null ? null : schema.fingerprint(advisory.title),
      advisory.description === null ? null : schema.fingerprint(advisory.description),
      advisory.severityFieldPresent && advisory.cvssV3Present
        ? schema.scoringFingerprint(advisory.severityField, advisory.cvssV3)
        : null,
    ]);
    return { title, description, scoring };
  }

  /**
   * @param {ParsedDetail} advisory
   * @param {MergedState} merged
   * @returns {Promise<TrackingView>}
   */
  async function readAdvisory(advisory, merged) {
    return read(merged.state, await fingerprints(advisory));
  }

  const exported = {
    CONFIRMATION_TRACKS,
    read,
    untracked,
    fingerprints,
    readAdvisory,
  };

  globalThis.bghsa.tracking = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
