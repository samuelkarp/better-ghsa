'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./dom.js');
}

/**
 * @typedef {object} DuplicatePointer
 * @property {string} text The link text.
 * @property {string} href The link path on github.com.
 */

(() => {
  const element = globalThis.bghsa.dom.element;

  const OF = 'of';

  /**
   * GHSA identifiers are case-insensitive.
   */
  const GHSA_ID = /^GHSA(?:-[0-9a-z]{4}){3}$/i;

  /**
   * Issue and pull request references share GitHub's `#number` notation.
   * Only complete URLs without a query or fragment are recognized.
   */
  const NUMBERED_URL =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)$/;

  /**
   * Remove angle brackets from the displayed free text.
   *
   * @param {string} value
   * @returns {string}
   */
  function displayed(value) {
    return value.replace(/[<>]/g, '');
  }

  /**
   * Duplicate references are stored as free text (REQUIREMENTS.md section 6).
   * Recognize only a complete GHSA identifier or issue/pull request URL.
   * GHSA identifiers resolve within the current repository.
   *
   * @param {string} value
   * @param {{ owner: string, repo: string } | null} ref The current repository, or null if unknown.
   * @returns {DuplicatePointer | null} Null if the reference is unrecognized or
   *   a GHSA identifier lacks a repository.
   */
  function pointerOf(value, ref) {
    if (GHSA_ID.test(value)) {
      if (ref === null) return null;
      return {
        text: value,
        href: `/${ref.owner}/${ref.repo}/security/advisories/${value}`,
      };
    }
    const numbered = NUMBERED_URL.exec(value);
    if (numbered === null) return null;
    const owner = /** @type {string} */ (numbered[1]);
    const repo = /** @type {string} */ (numbered[2]);
    const kind = /** @type {string} */ (numbered[3]);
    const number = /** @type {string} */ (numbered[4]);
    // Qualify references to other repositories as `owner/repo#12`.
    const here =
      ref !== null &&
      ref.owner.toLowerCase() === owner.toLowerCase() &&
      ref.repo.toLowerCase() === repo.toLowerCase();
    return {
      text: here ? `#${number}` : `${owner}/${repo}#${number}`,
      href: `/${owner}/${repo}/${kind}/${number}`,
    };
  }

  /**
   * @param {Document} doc
   * @param {string} className The span's CSS class.
   * @param {string} value The stored value.
   * @param {{ owner: string, repo: string } | null} ref
   * @returns {Element}
   */
  function buildDuplicate(doc, className, value, ref) {
    const pointer = pointerOf(value, ref);
    if (pointer === null) return element(doc, 'span', className, `${OF} ${displayed(value)}`);
    const box = element(doc, 'span', className, `${OF} `);
    const link = element(doc, 'a', 'bghsa-duplicate', pointer.text);
    link.setAttribute('href', pointer.href);
    box.append(link);
    return box;
  }

  const exported = {
    GHSA_ID,
    NUMBERED_URL,
    displayed,
    pointerOf,
    buildDuplicate,
  };

  globalThis.bghsa.duplicate = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
