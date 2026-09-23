'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./corpus.js');
  require('./stats.js');
}

/**
 * Export one row per corpus member, falling back to list data for unread
 * advisories. `detail_fetched` identifies those rows; their timings are blank.
 *
 * @typedef {Record<string, string | number | null>} CsvRow
 */

/**
 * @typedef {object} DownloadOptions
 * @property {typeof globalThis.Blob} [Blob]
 * @property {(blob: Blob) => string} [createObjectURL]
 * @property {(url: string) => void} [revokeObjectURL]
 */

(() => {

  const MIME = 'text/csv;charset=utf-8';

  /**
   * Durations use unrounded milliseconds measured from the report time.
   *
   * @type {readonly string[]}
   */
  const COLUMNS = [
    'ghsa_id',
    'title',
    'state',
    'severity',
    'closure_reason',
    'reported_at',
    'month',
    'time_to_first_response_ms',
    'time_to_accept_ms',
    'time_to_close_ms',
    'time_to_publish_ms',
    'detail_fetched',
    'observed_at',
  ];

  /**
   * Prefix potentially executable spreadsheet formulas with a text marker.
   * Titles and closure reasons can contain user-supplied text.
   */
  const FORMULA_LEAD = /^[=+\-@\t\r]/;

  const FORMULA_GUARD = "'";

  /** RFC 4180 ends a record with a carriage return and a line feed. */
  const NEWLINE = '\r\n';

  /**
   * @param {string | number | null} value
   * @returns {string} The escaped CSV field.
   */
  function field(value) {
    if (value === null) return '';
    const text = typeof value === 'number' ? String(value) : value;
    const guarded = FORMULA_LEAD.test(text) ? `${FORMULA_GUARD}${text}` : text;
    if (guarded === text && !/[",\r\n]/.test(text)) return text;
    return `"${guarded.replace(/"/g, '""')}"`;
  }

  /**
   * @param {readonly (string | number | null)[]} values
   * @returns {string}
   */
  function line(values) {
    return values.map(field).join(',');
  }

  /**
   * @param {number | null} at
   * @returns {string | null} The ISO timestamp, or null for a missing value.
   */
  function stampOf(at) {
    return at === null ? null : new Date(at).toISOString();
  }

  /**
   * @param {import('./corpus.js').CorpusMember} member
   * @returns {CsvRow}
   */
  function rowOf(member) {
    const stats = globalThis.bghsa.stats;
    const advisory = member.advisory;
    const state = advisory?.state ?? member.row.state ?? member.state;
    return {
      ghsa_id: member.ghsaId,
      title: advisory?.title ?? member.row.title,
      state: state === null ? null : state.toLowerCase(),
      severity: advisory?.severity ?? member.row.severity,
      closure_reason: advisory === null ? null : stats.closureReasonOf(advisory),
      reported_at: advisory?.reportedAt ?? member.row.openedAt,
      month: stats.monthOf(advisory?.reportedAt ?? member.row.openedAt),
      time_to_first_response_ms: stats.durationOf(advisory, stats.firstResponseAt),
      time_to_accept_ms: stats.durationOf(advisory, stats.draftAt),
      time_to_close_ms: stats.durationOf(advisory, stats.closeAt),
      time_to_publish_ms: stats.durationOf(advisory, stats.publishAt),
      detail_fetched: advisory === null ? 'no' : 'yes',
      observed_at: stampOf(member.observedAt),
    };
  }

  /**
   * Build CSV from the collected corpus in the page.
   *
   * @param {import('./corpus.js').Corpus} held
   * @returns {string}
   */
  function toCsv(held) {
    const lines = [line(COLUMNS)];
    for (const member of held.members) {
      const row = rowOf(member);
      lines.push(line(COLUMNS.map((column) => row[column] ?? null)));
    }
    return `${lines.join(NEWLINE)}${NEWLINE}`;
  }

  /**
   * @param {{ owner: string, repo: string }} ref
   * @param {number} at
   * @returns {string} A filename containing the repository and UTC date.
   */
  function filenameFor(ref, at) {
    const day = new Date(at).toISOString().slice(0, 10);
    const name = `${ref.owner}-${ref.repo}`.replace(/[^A-Za-z0-9._-]+/g, '-');
    return `${name}-advisories-${day}.csv`;
  }

  /**
   * Start a download through an attached anchor. Revoke the blob URL on the
   * next turn to give the browser time to begin the download.
   *
   * @param {Document} doc
   * @param {string} name
   * @param {string} text
   * @param {DownloadOptions} [options]
   * @returns {string | null} The download URL, or null if Blob or a document host is unavailable.
   */
  function download(doc, name, text, options = {}) {
    // Call URL methods with their receiver.
    const urls = globalThis.URL;
    const make = options.createObjectURL ?? ((blob) => urls.createObjectURL(blob));
    const drop = options.revokeObjectURL ?? ((url) => urls.revokeObjectURL(url));
    const BlobType = options.Blob ?? globalThis.Blob;
    if (typeof BlobType !== 'function') return null;
    // Check for a download host before allocating a blob URL.
    const host = doc.body ?? doc.documentElement;
    if (host === null) return null;
    const url = make(new BlobType([text], { type: MIME }));
    const anchor = doc.createElement('a');
    anchor.setAttribute('href', url);
    anchor.setAttribute('download', name);
    anchor.setAttribute('hidden', '');
    host.append(anchor);
    /** @type {{ click?: () => void }} */ (/** @type {unknown} */ (anchor)).click?.();
    anchor.remove();
    setTimeout(() => drop(url), 0);
    return url;
  }

  const exported = {
    MIME,
    COLUMNS,
    field,
    toCsv,
    filenameFor,
    download,
  };

  globalThis.bghsa.csv = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
