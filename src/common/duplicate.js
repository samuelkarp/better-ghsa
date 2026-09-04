'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./dom.js');
}

/**
 * Where a duplicate points, as a link on github.com.
 *
 * @typedef {object} DuplicatePointer
 * @property {string} text What the link reads.
 * @property {string} href Where it leads, as a path on github.com.
 */

(() => {
  /** How every surface builds an element. */
  const element = globalThis.bghsa.dom.element;

  /** The word between the closure reason and what it points at. */
  const OF = 'of';

  /**
   * A GHSA identifier, whole. GitHub writes one as `GHSA` and three groups of
   * four, and reads it case-insensitively, so the two spellings of one
   * identifier both match and both resolve.
   */
  const GHSA_ID = /^GHSA(?:-[0-9a-z]{4}){3}$/i;

  /**
   * One issue or one pull request on github.com, whole, as its address reads.
   * A repository numbers the two in one sequence and GitHub writes a reference
   * to either as `#12`, so one pattern reads both and one form renders them.
   * The path segment is carried out of the match, because it is what parts the
   * two addresses.
   *
   * Nothing after the number matches, so a query or a fragment leaves the value
   * unrecognized.
   */
  const NUMBERED_URL =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)$/;

  /**
   * The stored value as it is displayed. The angle brackets go, because the
   * field is free text a maintainer typed and nothing downstream reads it as
   * markup.
   *
   * @param {string} value
   * @returns {string}
   */
  function displayed(value) {
    return value.replace(/[<>]/g, '');
  }

  /**
   * Where one stored duplicate points.
   *
   * The value is free text: REQUIREMENTS.md section 6 stores what a maintainer
   * typed and validates none of it. So the forms this reader knows are
   * matched whole, and a value that is not exactly one of them points nowhere
   * and is displayed as it stands. Nothing partial is recognized, so every
   * address a link carries is one this reader built out of a pattern it
   * matched.
   *
   * A GHSA identifier names no repository, so it is read as an advisory of the
   * repository in hand, which is where a maintainer marking a duplicate is
   * working. An identifier from another repository leads to an address that
   * repository does not answer for.
   *
   * @param {string} value
   * @param {{ owner: string, repo: string } | null} ref The repository the
   *   surface is showing, and null where it names none.
   * @returns {DuplicatePointer | null} null where the value is neither form,
   *   and where a GHSA identifier stands with no repository to read it in.
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
    // GitHub writes one of the repository in hand as `#12` and one of another
    // as `owner/repo#12`, and both surfaces here stand on a repository.
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
   * What one advisory duplicates, as the panel and the completed row both draw
   * it: the word, and then the link where this reader knows where the value
   * points and the value itself where it does not.
   *
   * @param {Document} doc
   * @param {string} className What the surface names the span.
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
