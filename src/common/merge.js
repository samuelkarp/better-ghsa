'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') require('./schema.js');

/**
 * @typedef {object} SnapshotSource
 * @property {string} id The numeric comment id.
 * @property {string} elementId The `advisory-comment-{id}` element id.
 * @property {string | null} author
 * @property {boolean} trusted
 * @property {import('./schema.js').SnapshotReport | null} stateComment
 */

/**
 * @typedef {'not a snapshot' | 'untrusted' | 'invalid payload' | 'unsupported schema'} WarningKind
 */

/**
 * @typedef {object} MergeWarning
 * @property {WarningKind} kind
 * @property {string} commentId
 * @property {string} elementId
 * @property {string | null} author
 * @property {string} message The chip tooltip, or an empty string.
 */

/**
 * @typedef {object} MergedState
 * @property {Record<string, unknown> | null} state The payload of the snapshot
 *   that holds current state, unknown fields included.
 * @property {SnapshotSource | null} source The comment that payload came from.
 * @property {number | null} seq The winning snapshot's sequence number.
 * @property {number} observedSeq The highest valid sequence number, including
 *   snapshots excluded from state.
 * @property {number} nextSeq One above the highest observed sequence number.
 * @property {MergeWarning[]} warnings
 * @property {boolean} readOnly Whether a trusted snapshot uses an unsupported
 *   schema major.
 * @property {boolean} confirmationRequired Whether an invalid trusted snapshot
 *   with a valid sequence number requires confirmation before writing.
 */

(() => {
  /**
   * Use the comment author for tie-breaking, with the payload's login as fallback.
   *
   * @param {SnapshotSource} source
   * @returns {string}
   */
  function loginOf(source) {
    return source.author ?? source.stateComment?.by ?? '';
  }

  /**
   * Compare logins by Unicode code point. JavaScript string comparisons use
   * UTF-16 code units, which differ for non-BMP characters.
   *
   * @param {string} left
   * @param {string} right
   * @returns {number}
   */
  function compareLogins(left, right) {
    const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
    const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
    const shared = Math.min(leftPoints.length, rightPoints.length);
    for (let index = 0; index < shared; index += 1) {
      const leftPoint = leftPoints[index] ?? 0;
      const rightPoint = rightPoints[index] ?? 0;
      if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    }
    return leftPoints.length - rightPoints.length;
  }

  /**
   * The higher sequence number wins. Break ties by the greater login in
   * Unicode code point order.
   *
   * @param {SnapshotSource} candidate
   * @param {SnapshotSource} holder
   * @returns {boolean}
   */
  function outranks(candidate, holder) {
    const candidateSeq = candidate.stateComment?.seq ?? 0;
    const holderSeq = holder.stateComment?.seq ?? 0;
    if (candidateSeq !== holderSeq) return candidateSeq > holderSeq;
    return compareLogins(loginOf(candidate), loginOf(holder)) > 0;
  }

  /**
   * @param {MergeWarning[]} warnings
   * @param {WarningKind} kind
   * @param {SnapshotSource} source
   * @param {string} message The chip tooltip, or an empty string.
   * @returns {void}
   */
  function warn(warnings, kind, source, message) {
    warnings.push({
      kind,
      commentId: source.id,
      elementId: source.elementId,
      author: source.author,
      message,
    });
  }

  /**
   * Select the highest-ranked valid, trusted snapshot. A trusted snapshot with
   * a valid sequence number and invalid fields requires confirmation before
   * the next write. An unsupported trusted schema makes the advisory read-only.
   *
   * @param {SnapshotSource[]} sources
   * @returns {MergedState}
   */
  function mergeSnapshots(sources) {
    /** @type {MergeWarning[]} */
    const warnings = [];
    /** @type {SnapshotSource | null} */
    let holder = null;
    let observedSeq = 0;
    let readOnly = false;
    let confirmationRequired = false;

    for (const source of sources) {
      const report = source.stateComment;
      if (report === null) continue;

      if (!report.ordered) {
        warn(warnings, 'not a snapshot', source, report.problems.join('; '));
        continue;
      }

      observedSeq = Math.max(observedSeq, report.seq ?? 0);

      if (!source.trusted) {
        warn(warnings, 'untrusted', source, '');
        continue;
      }

      // Handle unsupported major versions before field-validation errors.
      // A missing or malformed betterGhsa value is a validation error.
      if (!report.schemaSupported) {
        readOnly = true;
        warn(
          warnings,
          'unsupported schema',
          source,
          `Schema version ${report.version ?? 'none'}`
        );
        continue;
      }

      if (!report.valid) {
        confirmationRequired = true;
        warn(warnings, 'invalid payload', source, report.problems.join('; '));
        continue;
      }

      if (holder === null || outranks(source, holder)) holder = source;
    }

    const state =
      holder === null
        ? null
        : /** @type {Record<string, unknown>} */ (holder.stateComment?.parsed ?? null);

    return {
      state,
      source: holder,
      seq: holder?.stateComment?.seq ?? null,
      observedSeq,
      nextSeq: observedSeq + 1,
      warnings,
      readOnly,
      confirmationRequired,
    };
  }

  /**
   * Define an own property to preserve `__proto__` as data.
   *
   * @param {Record<string, unknown>} target
   * @param {string} key
   * @param {unknown} value
   * @returns {void}
   */
  function define(target, key, value) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  /**
   * Deep-copy JSON values to isolate the result from later mutations.
   *
   * @param {unknown} value
   * @returns {unknown}
   */
  function clone(value) {
    const schema = globalThis.bghsa.schema;
    if (Array.isArray(value)) return value.map((entry) => clone(entry));
    if (!schema.isPlainObject(value)) return value;
    /** @type {Record<string, unknown>} */
    const copy = {};
    for (const [key, entry] of Object.entries(value)) define(copy, key, clone(entry));
    return copy;
  }

  /**
   * Apply changes recursively while preserving unspecified fields. Null
   * removes a field; undefined leaves it unchanged.
   *
   * @param {Record<string, unknown>} base
   * @param {Record<string, unknown>} changes
   * @returns {Record<string, unknown>}
   */
  function applyChanges(base, changes) {
    const schema = globalThis.bghsa.schema;
    const merged = /** @type {Record<string, unknown>} */ (clone(base));
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      if (value === null) {
        delete merged[key];
        continue;
      }
      const existing = Object.hasOwn(merged, key) ? merged[key] : undefined;
      define(
        merged,
        key,
        schema.isPlainObject(value) && schema.isPlainObject(existing)
          ? applyChanges(existing, value)
          : clone(value)
      );
    }
    return merged;
  }

  /**
   * Build the next snapshot from the current state, changes, and envelope.
   * Nested objects are copied.
   *
   * @param {Record<string, unknown> | null} current
   * @param {Record<string, unknown>} changes
   * @param {{ by: string, at: string, seq: number }} envelope
   * @returns {Record<string, unknown>}
   */
  function nextSnapshot(current, changes, envelope) {
    const schema = globalThis.bghsa.schema;
    const merged = applyChanges(current ?? {}, changes);
    merged['betterGhsa'] = schema.SCHEMA_VERSION;
    merged['seq'] = envelope.seq;
    merged['by'] = envelope.by;
    merged['at'] = envelope.at;
    return merged;
  }

  const exported = { compareLogins, mergeSnapshots, applyChanges, nextSnapshot };

  globalThis.bghsa.merge = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
