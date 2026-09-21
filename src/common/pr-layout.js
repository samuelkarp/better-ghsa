'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

if (typeof require === 'function') require('./allowlist.js');

(() => {
  const STYLE_ID = 'bghsa-pr-layout';

  // The private-fork capture has this extra wrapper around the diff viewer.
  // The viewer supplies its own horizontal padding, as on a public PR.
  const CSS = `
    #js-repo-pjax-container > .container-xl.p-responsive:has(#diff-comparison-viewer-container) {
      max-width: none !important;
      padding-left: 0 !important;
      padding-right: 0 !important;
    }
  `;

  /**
   * @param {string} pathname
   * @returns {string | null} The parent repository inferred from the GHSA fork name.
   */
  function parentRepository(pathname) {
    const match = /^\/([^/]+)\/([^/]+)-ghsa-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}\/pull\/[1-9]\d*\/(?:changes|files)(?:\/[^/]+)?\/?$/i.exec(pathname);
    return match === null ? null : `${match[1]}/${match[2]}`;
  }

  /**
   * CSS also covers a diff viewer inserted after the navigation event.
   * @param {Document} doc
   * @param {string} pathname
   * @returns {void}
   */
  function apply(doc, pathname) {
    const parent = parentRepository(pathname);
    const existing = doc.getElementById(STYLE_ID);
    if (parent === null || !globalThis.bghsa.allowlist.isAllowed(parent)) {
      existing?.remove();
      return;
    }
    if (existing !== null) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.append(style);
  }

  const exported = { STYLE_ID, CSS, parentRepository, apply };
  globalThis.bghsa.prLayout = exported;
  if (typeof module !== 'undefined') module.exports = exported;
})();
