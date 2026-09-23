'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./common/allowlist.js');
  require('./common/settings-control.js');
  require('./common/pr-layout.js');
}

/**
 * @typedef {object} AdvisoryLocation
 * @property {string} owner
 * @property {string} repo
 * @property {string | null} ghsaId The advisory identifier, or null on the list page.
 */

(() => {
  /**
   * @param {string} pathname
   * @returns {AdvisoryLocation | null} The advisory location, or null outside the advisory area.
   */
  function locate(pathname) {
    const parts = pathname.split('/').filter((part) => part !== '');
    const [owner, repo, security, advisories, ghsaId] = parts;
    if (owner === undefined || repo === undefined) return null;
    if (security !== 'security' || advisories !== 'advisories') return null;
    return { owner, repo, ghsaId: ghsaId ?? null };
  }

  /**
   * Require an allowlisted advisory path before starting or rendering surfaces
   * (REQUIREMENTS.md section 8). Recheck after navigation within one document.
   *
   * @param {unknown} [pathname] The path to check; defaults to the current location.
   * @returns {boolean}
   */
  function enabled(pathname = globalThis.location?.pathname) {
    if (typeof pathname !== 'string') return false;
    const here = locate(pathname);
    if (here === null) return false;
    return globalThis.bghsa.allowlist.isAllowed(`${here.owner}/${here.repo}`);
  }

  function report() {
    const here = locate(globalThis.location.pathname);
    if (here === null) return;
    const nameWithOwner = `${here.owner}/${here.repo}`;
    const subject = here.ghsaId === null ? 'advisory list' : here.ghsaId;
    const writes = globalThis.bghsa.allowlist.isAllowed(nameWithOwner)
      ? 'writes permitted'
      : 'writes refused';
    console.info(`[better-ghsa] ${nameWithOwner} ${subject}, ${writes}`);
  }

  /**
   * Listen for GitHub frame replacements across its navigation event families.
   * Repeated events are safe because apply starts surfaces once per document.
   * Window events separately cover history and back-forward-cache navigation.
   *
   * @type {readonly string[]}
   */
  const FRAME_EVENTS = [
    'turbo:load',
    'turbo:render',
    'turbo:frame-load',
    'turbo:frame-render',
    'soft-nav:end',
    'soft-nav:success',
    'pjax:end',
  ];

  /** @type {readonly string[]} */
  const WINDOW_EVENTS = ['popstate', 'pageshow'];

  /**
   * Start surfaces once per document to avoid duplicate observers.
   *
   * @type {WeakSet<Document>}
   */
  const started = new WeakSet();

  /**
   * @returns {{ start?: () => unknown, stop?: (doc: Document) => unknown }[]} Surfaces in
   *   start order. Stop them in reverse order.
   */
  function surfaces() {
    const bghsa = globalThis.bghsa;
    return [bghsa.table, bghsa.panel].filter((surface) => surface !== undefined);
  }

  /**
   * Start both surfaces on allowlisted advisory pages. Their observers handle
   * transitions between list and detail pages even without navigation events.
   *
   * @param {Document} [doc] The document to start on.
   * @returns {boolean} Whether this call started the surfaces.
   */
  function apply(doc = globalThis.document) {
    if (!enabled()) return false;
    if (started.has(doc)) return false;
    started.add(doc);
    report();
    for (const surface of surfaces()) {
      try {
        surface.start?.();
      } catch {
        // Continue starting other surfaces if one fails.
      }
    }
    return true;
  }

  /**
   * Stop surfaces when a repository leaves the allowlist.
   *
   * @param {Document} [doc] The document to stop on.
   * @returns {boolean} Whether this call stopped the surfaces.
   */
  function stop(doc = globalThis.document) {
    if (!started.has(doc)) return false;
    started.delete(doc);
    for (const surface of [...surfaces()].reverse()) {
      try {
        surface.stop?.(doc);
      } catch {
        // Continue stopping other surfaces if one fails.
      }
    }
    return true;
  }

  /**
   * Apply the allowlist to advisory pages. Preserve observers on other pages
   * for return navigation unless `everywhere` requests a full stop after an
   * allowlist change. Show settings on every advisory page, including repositories
   * outside the allowlist (REQUIREMENTS.md section 12).
   *
   * @param {Document} [doc]
   * @param {boolean} [everywhere]
   * @returns {boolean} Whether this call started or stopped the surfaces.
   */
  function reconsider(doc = globalThis.document, everywhere = false) {
    globalThis.bghsa.prLayout.apply(doc, globalThis.location?.pathname ?? '');
    const control = globalThis.bghsa.settingsControl;
    if (locate(globalThis.location?.pathname ?? '') === null) {
      control?.hide(doc);
      if (!everywhere) return false;
      return stop(doc);
    }
    const changed = enabled() ? apply(doc) : stop(doc);
    control?.show(doc);
    return changed;
  }

  /**
   * Watch navigation even before any surface starts, including documents that
   * initially load outside the advisory area.
   *
   * @param {Document} [doc] The document to listen on.
   * @returns {void}
   */
  function watch(doc = globalThis.document) {
    const view = doc?.defaultView ?? globalThis;
    const onNavigated = () => {
      reconsider(doc);
    };
    for (const name of FRAME_EVENTS) doc?.addEventListener?.(name, onNavigated);
    for (const name of WINDOW_EVENTS) view?.addEventListener?.(name, onNavigated);
  }

  /**
   * Load the allowlist before starting surfaces, then reconsider the document
   * after navigation and allowlist changes.
   *
   * @returns {void}
   */
  function start() {
    const allowlist = globalThis.bghsa.allowlist;
    watch();
    allowlist.watch();
    allowlist.subscribe(() => {
      reconsider(globalThis.document, true);
    });
    void allowlist.load().then(() => {
      reconsider();
    });
  }

  const exported = {
    locate,
    enabled,
    report,
    FRAME_EVENTS,
    stop,
    watch,
    start,
  };

  globalThis.bghsa.content = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  } else {
    start();
  }
})();
