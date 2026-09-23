'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

(() => {
  /**
   * Comments can have multiple badges. This order determines which role to display.
   *
   * @type {readonly string[]}
   */
  const ROLES = ['Owner', 'Member', 'Contributor', 'Author'];

  /**
   * The roles whose snapshots count toward advisory state.
   *
   * @type {readonly string[]}
   */
  const TRUSTED_ROLES = ['Owner', 'Member'];

  /**
   * Require an identifiable author with an Owner or Member badge for a snapshot
   * to contribute to advisory state.
   *
   * @param {string | null | undefined} login
   * @param {string | null | undefined} role One of {@link ROLES}, or any other
   *   badge text GitHub renders.
   * @returns {boolean}
   */
  function isTrustedAuthor(login, role) {
    if (typeof login !== 'string' || login.trim() === '') return false;
    if (typeof role !== 'string') return false;
    const wanted = role.trim().toLowerCase();
    return TRUSTED_ROLES.some((trusted) => trusted.toLowerCase() === wanted);
  }

  globalThis.bghsa.trust = { ROLES, TRUSTED_ROLES, isTrustedAuthor };

  if (typeof module !== 'undefined') {
    module.exports = { ROLES, TRUSTED_ROLES, isTrustedAuthor };
  }
})();
