'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

/**
 * @typedef {object} SnapshotReport
 * @property {string} raw The JSON source recovered from the fenced block.
 * @property {unknown} parsed The parsed payload, or null when it did not parse.
 * @property {string | null} version The `betterGhsa` schema version.
 * @property {number | null} major The major version parsed from `major.minor`.
 * @property {boolean} schemaSupported For parsed objects, false indicates an
 *   unsupported major version. Missing or malformed versions fail validation.
 * @property {number | null} seq The sequence number, an integer from 0 to MAX_SEQ.
 * @property {string | null} by The login the snapshot names as its writer.
 * @property {boolean} ordered Whether the sequence number is valid.
 * @property {boolean} valid Whether the payload passed validation.
 * @property {string[]} problems Why the snapshot is not usable, in display order.
 * @property {string[]} unrecognized Known enum fields with unknown values.
 *   Preserve those values for display and subsequent writes.
 */

(() => {
  const SCHEMA_VERSION = '1.0';

  const SCHEMA_MAJOR = 1;

  /** The version uses major.minor notation. */
  const VERSION_PATTERN = /^(\d+)\.(\d+)$/;

  /**
   * The marker identifies state comments even when their JSON is invalid.
   * It appears in a code span because GitHub preserves code but strips HTML
   * comments. The number after `state` identifies the body format.
   */
  const STATE_COMMENT_MARKER = 'better-ghsa:state:1:';

  const PROJECT_URL = 'https://github.com/samuelkarp/better-ghsa';

  /**
   * HTML anchors render inside GitHub's summary elements.
   */
  const PROJECT_LINK = `<a href="${PROJECT_URL}">Better GHSA</a>`;

  /**
   * State comment recognition uses the marker independently of this summary.
   */
  const STATE_COMMENT_SUMMARY = `${PROJECT_LINK} tracking state`;

  /** Triage values this reader interprets. @type {readonly string[]} */
  const TRIAGE_VALUES = ['evaluating', 'awaiting reporter', 'awaiting maintainer input'];

  /** Closure reasons this reader interprets. @type {readonly string[]} */
  const CLOSURE_REASONS = [
    'duplicate',
    'not a vulnerability',
    'not reproducible',
    'working as intended',
    'out of scope',
    'no reporter response',
    'withdrawn by reporter',
  ];

  /**
   * Reserve one safe integer above the highest accepted sequence number for
   * the next write.
   */
  const MAX_SEQ = Number.MAX_SAFE_INTEGER - 1;

  const FINGERPRINT_LENGTH = 12;

  /**
   * Reject malformed fingerprints during validation to avoid reporting them
   * as changes to the confirmed value.
   */
  const FINGERPRINT_PATTERN = new RegExp(`^[0-9a-f]{${FINGERPRINT_LENGTH}}$`);

  /**
   * @param {unknown} value
   * @returns {value is Record<string, unknown>}
   */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * @param {Record<string, unknown>} payload
   * @param {string} key
   * @param {string[]} problems
   * @returns {void}
   */
  function requireStringArray(payload, key, problems) {
    const value = payload[key];
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      problems.push(`${key} is not an array of strings`);
    }
  }

  /**
   * @param {Record<string, unknown>} payload
   * @param {string} key
   * @param {string[]} problems
   * @param {string} [prefix] The path to `payload` within the snapshot.
   * @returns {void}
   */
  function requireString(payload, key, problems, prefix) {
    const value = payload[key];
    if (value === undefined) return;
    if (typeof value !== 'string') {
      problems.push(`${prefix === undefined ? '' : `${prefix}.`}${key} is not a string`);
    }
  }

  /**
   * Validate known field types. Preserve unknown fields and enum values.
   *
   * @param {Record<string, unknown>} payload
   * @returns {{ problems: string[], unrecognized: string[] }}
   */
  function validateSnapshot(payload) {
    /** @type {string[]} */
    const problems = [];
    /** @type {string[]} */
    const unrecognized = [];

    const version = payload['betterGhsa'];
    if (typeof version !== 'string') {
      problems.push('betterGhsa is not a string');
    } else if (!VERSION_PATTERN.test(version)) {
      problems.push('betterGhsa is not a major.minor version');
    }
    for (const key of ['by', 'at', 'triage', 'triageSince']) requireString(payload, key, problems);
    for (const key of ['owners', 'backports']) requireStringArray(payload, key, problems);

    const triage = payload['triage'];
    if (typeof triage === 'string' && !TRIAGE_VALUES.includes(triage)) unrecognized.push('triage');

    const confirmed = payload['confirmed'];
    if (confirmed !== undefined) {
      if (!isPlainObject(confirmed)) {
        problems.push('confirmed is not an object');
      } else {
        for (const [track, record] of Object.entries(confirmed)) {
          if (!isPlainObject(record)) {
            problems.push(`confirmed.${track} is not an object`);
            continue;
          }
          for (const key of ['by', 'at', 'fp']) {
            requireString(record, key, problems, `confirmed.${track}`);
          }
          const fp = record['fp'];
          if (typeof fp === 'string' && !FINGERPRINT_PATTERN.test(fp)) {
            problems.push(`confirmed.${track}.fp is not a fingerprint`);
          }
        }
      }
    }

    const embargo = payload['embargo'];
    if (embargo !== undefined) {
      if (!isPlainObject(embargo)) problems.push('embargo is not an object');
      else requireString(embargo, 'lift', problems, 'embargo');
    }

    const closure = payload['closure'];
    if (closure !== undefined) {
      if (!isPlainObject(closure)) {
        problems.push('closure is not an object');
      } else {
        for (const key of ['reason', 'duplicateOf']) {
          requireString(closure, key, problems, 'closure');
        }
        const reason = closure['reason'];
        if (typeof reason === 'string' && !CLOSURE_REASONS.includes(reason)) {
          unrecognized.push('closure.reason');
        }
      }
    }

    return { problems, unrecognized };
  }

  /**
   * Read `seq` and `by` independently of field validation. An invalid payload
   * can still contribute a sequence number.
   *
   * @param {string} raw The JSON source from the fenced block.
   * @returns {SnapshotReport}
   */
  function readSnapshot(raw) {
    /** @type {SnapshotReport} */
    const report = {
      raw,
      parsed: null,
      version: null,
      major: null,
      schemaSupported: false,
      seq: null,
      by: null,
      ordered: false,
      valid: false,
      problems: [],
      unrecognized: [],
    };

    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      report.problems.push('the fenced block does not parse as JSON');
      return report;
    }
    if (!isPlainObject(parsed)) {
      report.problems.push('the fenced block is not a JSON object');
      return report;
    }
    report.parsed = parsed;

    const version = parsed['betterGhsa'];
    if (typeof version === 'string') {
      report.version = version;
      const major = VERSION_PATTERN.exec(version);
      if (major !== null) report.major = Number(major[1]);
    }
    report.schemaSupported = report.major === null || report.major === SCHEMA_MAJOR;

    const seq = parsed['seq'];
    if (typeof seq !== 'number' || !Number.isFinite(seq)) {
      report.problems.push('seq is absent or is not a number');
    } else if (!Number.isSafeInteger(seq) || seq < 0 || seq > MAX_SEQ) {
      report.problems.push(`seq is not a whole number between 0 and ${MAX_SEQ}`);
    } else {
      report.seq = seq;
      report.ordered = true;
    }

    const by = parsed['by'];
    if (typeof by === 'string') report.by = by;

    const checked = validateSnapshot(parsed);
    report.unrecognized = checked.unrecognized;
    report.problems.push(...checked.problems);
    report.valid = report.ordered && checked.problems.length === 0;

    return report;
  }

  /**
   * Normalize fingerprint inputs to LF and NFC. Remove trailing whitespace
   * from each line and leading and trailing blank lines.
   *
   * @param {string | null | undefined} value
   * @returns {string}
   */
  function normalize(value) {
    if (typeof value !== 'string') return '';
    const lines = value
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+$/u, ''));
    while (lines.length > 0 && lines[0] === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n').normalize('NFC');
  }

  /**
   * Use the first 12 hex characters of SHA-256 to detect changes. This
   * fingerprint is not a security boundary.
   *
   * @param {string | null | undefined} value Raw markdown from a metadata form
   *   field, not rendered text.
   * @returns {Promise<string>}
   */
  async function fingerprint(value) {
    const bytes = new TextEncoder().encode(normalize(value));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    let hex = '';
    for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
    return hex.slice(0, FINGERPRINT_LENGTH);
  }

  /**
   * Label and JSON-encode both scoring fields to escape embedded newlines.
   * Null and empty fields produce the same normalized input.
   *
   * @param {string | null | undefined} severity The stored severity selection.
   * @param {string | null | undefined} vector The CVSS vector.
   * @returns {string}
   */
  function scoringSource(severity, vector) {
    /** @param {string | null | undefined} value @returns {string} */
    const half = (value) => JSON.stringify(normalize(value));
    return `severity=${half(severity)}\ncvss=${half(vector)}`;
  }

  /**
   * @param {string | null | undefined} severity
   * @param {string | null | undefined} vector
   * @returns {Promise<string>}
   */
  function scoringFingerprint(severity, vector) {
    return fingerprint(scoringSource(severity, vector));
  }

  const exported = {
    SCHEMA_VERSION,
    STATE_COMMENT_MARKER,
    PROJECT_URL,
    PROJECT_LINK,
    STATE_COMMENT_SUMMARY,
    TRIAGE_VALUES,
    CLOSURE_REASONS,
    MAX_SEQ,
    FINGERPRINT_PATTERN,
    isPlainObject,
    readSnapshot,
    normalize,
    fingerprint,
    scoringSource,
    scoringFingerprint,
  };

  globalThis.bghsa.schema = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
