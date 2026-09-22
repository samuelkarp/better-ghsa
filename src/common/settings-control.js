'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

(() => {
  const CONTROL_ID = 'bghsa-settings-control';

  const LABEL = 'Better GHSA settings';

  /**
   * Navigation from github.com requires the settings page to appear in the
   * manifest's `web_accessible_resources`.
   */
  const SETTINGS_PAGE = 'src/settings/settings.html';

  /**
   * @returns {Record<string, any> | undefined} The first extension API with
   *   runtime.getURL, or undefined if unavailable.
   */
  function extensionApi() {
    const global = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));
    for (const name of ['browser', 'chrome']) {
      if (typeof global[name]?.runtime?.getURL === 'function') return global[name];
    }
    return undefined;
  }

  /**
   * Hold the settings URL in the isolated world.
   * Firefox URLs contain an installation UUID; exposing it in the DOM would
   * allow page scripts to read it. Chrome URLs use the public extension ID.
   *
   * @returns {string | null} The settings URL, or null if unavailable.
   */
  function settingsUrl() {
    const runtime = extensionApi()?.runtime;
    if (runtime === undefined) return null;
    try {
      const url = runtime.getURL(SETTINGS_PAGE);
      return typeof url === 'string' && url !== '' ? url : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {Document} doc
   * @returns {Element | null}
   */
  function ownBlock(doc) {
    const bghsa = globalThis.bghsa ?? {};
    for (const id of [bghsa.table?.ROOT_ID, bghsa.panel?.PANEL_ID]) {
      if (typeof id !== 'string') continue;
      const node = doc.getElementById(id);
      if (node?.parentElement != null) return node;
    }
    return null;
  }

  /**
   * Use the active surface's placement function.
   *
   * @param {Document} doc
   * @returns {{ parent: Element, before: Element } | null}
   */
  function surfaceAnchor(doc) {
    const bghsa = globalThis.bghsa ?? {};
    const surface = doc.querySelector('#advisories') !== null ? bghsa.table : bghsa.panel;
    try {
      return surface?.anchor?.(doc) ?? null;
    } catch {
      // Try the fallback placement if the surface cannot supply one.
      return null;
    }
  }

  /**
   * Place the control above the extension's surface. Each surface checks its
   * next sibling to detect displacement. The control must precede it.
   * Before the surface renders, use its intended position.
   *
   * @param {Document} doc
   * @returns {{ parent: Element, before: Element } | null} Null if a suitable position
   *   is unavailable.
   */
  function anchor(doc) {
    const own = ownBlock(doc);
    if (own?.parentElement != null) return { parent: own.parentElement, before: own };
    const place = surfaceAnchor(doc);
    if (place !== null) return place;
    const container = doc.querySelector('#advisories');
    if (container !== null) {
      // Use the table's position when its script is unavailable.
      const before = container.querySelector('repository-advisories-filter');
      if (before?.parentElement != null) return { parent: before.parentElement, before };
    }
    // GitHub replaces the title's live region as a whole. Place the control
    // outside that region when the panel cannot supply a position.
    const header = doc.querySelector('div.gh-header.js-repository-advisory-details');
    const before = header?.closest('div.js-socket-channel') ?? header;
    if (before?.parentElement != null) return { parent: before.parentElement, before };
    return null;
  }

  /**
   * @param {Document} doc
   * @param {string} url The settings URL, stored in the click handler's closure.
   * @returns {Element} The control.
   */
  function build(doc, url) {
    const holder = doc.createElement('div');
    holder.id = CONTROL_ID;
    holder.className = 'd-flex flex-justify-end mb-2';
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm';
    button.textContent = LABEL;
    button.addEventListener('click', () => {
      // Preserve the advisory page when opening settings.
      (doc.defaultView ?? globalThis).open(url, '_blank');
    });
    holder.append(button);
    return holder;
  }

  /**
   * Show the settings control even on repositories outside the allowlist
   * (REQUIREMENTS.md section 12). Repeated calls reuse the existing control.
   *
   * @param {Document} [doc]
   * @returns {Element | null} The control, or null if its position or settings
   *   URL is unavailable.
   */
  function show(doc = globalThis.document) {
    const held = doc.getElementById(CONTROL_ID);
    if (held !== null) return held;
    const url = settingsUrl();
    if (url === null) return null;
    const place = anchor(doc);
    if (place === null) return null;
    const control = build(doc, url);
    place.parent.insertBefore(control, place.before);
    return control;
  }

  /**
   * @param {Document} [doc]
   * @returns {boolean} Whether the control was removed.
   */
  function hide(doc = globalThis.document) {
    const held = doc.getElementById(CONTROL_ID);
    if (held === null) return false;
    held.remove();
    return true;
  }

  const exported = {
    CONTROL_ID,
    SETTINGS_PAGE,
    show,
    hide,
  };

  globalThis.bghsa.settingsControl = exported;

  if (typeof module !== 'undefined') module.exports = exported;
})();
