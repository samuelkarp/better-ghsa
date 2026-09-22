'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

(() => {
  /**
   * @param {string | null | undefined} value
   * @returns {string} `value` with runs of whitespace collapsed to one space and
   *   the ends trimmed.
   */
  function collapse(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  /**
   * @param {string} value
   * @returns {string | null} `value`, or null when it is empty after trimming.
   */
  function orNull(value) {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  /**
   * @param {string | number | null | undefined} at
   * @returns {number | null} Epoch milliseconds, or null for an invalid value.
   *   Numeric input is already in milliseconds.
   */
  function instantOf(at) {
    if (typeof at === 'number') return Number.isFinite(at) ? at : null;
    if (typeof at !== 'string') return null;
    const parsed = Date.parse(at);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * @param {string | number | null | undefined} at
   * @returns {string | null} The time to the minute in UTC. Invalid strings
   *   are returned unchanged.
   */
  function formatTime(at) {
    const parsed = instantOf(at);
    if (parsed === null) return typeof at === 'string' ? at : null;
    return new Date(parsed).toISOString().replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');
  }

  /**
   * @param {string | number | null | undefined} at
   * @returns {string | null} The UTC date. Invalid strings are returned unchanged.
   */
  function formatDate(at) {
    const parsed = instantOf(at);
    if (parsed === null) return typeof at === 'string' ? at : null;
    return new Date(parsed).toISOString().slice(0, 10);
  }

  const exported = {
    collapse,
    orNull,
    instantOf,
    formatTime,
    formatDate,
  };

  globalThis.bghsa.text = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
