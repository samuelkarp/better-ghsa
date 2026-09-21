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
 * @property {string | null} ghsaId The advisory, or null on the list page.
 */

(() => {
  /**
   * The advisory a github.com path points at.
   *
   * @param {string} pathname
   * @returns {AdvisoryLocation | null} null when the path is not an advisory page
   */
  function locate(pathname) {
    const parts = pathname.split('/').filter((part) => part !== '');
    const [owner, repo, security, advisories, ghsaId] = parts;
    if (owner === undefined || repo === undefined) return null;
    if (security !== 'security' || advisories !== 'advisories') return null;
    return { owner, repo, ghsaId: ghsaId ?? null };
  }

  /**
   * Whether the extension runs on the page at a path.
   *
   * REQUIREMENTS.md section 8: on a repository the allowlist does not carry the
   * extension does nothing at all, so this is the one question every surface
   * asks. Answering no keeps a surface from starting and stops a started one
   * from taking a page GitHub has since turned into another repository's, which
   * is what keeps a repository the allowlist does not carry out of storage
   * rather than only out of reach of a write.
   *
   * A path is needed to answer, so an environment with no location is not a
   * page the extension belongs on. That is every environment outside a browser.
   *
   * @param {unknown} [pathname] The path to judge, and absent to read the one
   *   the page is showing.
   * @returns {boolean}
   */
  function enabled(pathname = globalThis.location?.pathname) {
    if (typeof pathname !== 'string') return false;
    const here = locate(pathname);
    if (here === null) return false;
    return globalThis.bghsa.allowlist.isAllowed(`${here.owner}/${here.repo}`);
  }

  /** Log the advisory this page is, and whether writes to it are permitted. */
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
   * What GitHub gives when it has replaced the content frame without a document
   * load. The framework's own events are fired inside the frame and reach the
   * document; `popstate` and `pageshow` are fired at the window and cover a
   * history move and a return from the back-forward cache.
   *
   * Several names are watched because the fact that matters is the frame having
   * arrived and each of these announces it. Missing every name on a navigation
   * costs a page whose surface never starts; hearing several costs one more call
   * to {@link apply}, which returns without touching a document it has already
   * started.
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
   * The documents whose surfaces have been started. A document is started once:
   * a surface holds its own observer from then on, and a second start would
   * connect a second one.
   *
   * @type {WeakSet<Document>}
   */
  const started = new WeakSet();

  /**
   * @returns {{ start?: () => unknown, stop?: (doc: Document) => unknown }[]} the
   *   surfaces this extension puts on an advisory page, in the order they take
   *   it. A surface puts itself down in the reverse of that order.
   */
  function surfaces() {
    const bghsa = globalThis.bghsa;
    return [bghsa.table, bghsa.panel].filter((surface) => surface !== undefined);
  }

  /**
   * Starts the surfaces on a document the URL says is an advisory page on a
   * repository the allowlist carries, and leaves every other page untouched: no
   * surface drawn, no observer connected, no storage read and no request sent.
   * The content script matches every github.com page, so this is what keeps the
   * extension off the pages it has nothing to say about, and off the
   * repositories it has no business reading.
   *
   * Both surfaces start together, because the advisory list and an advisory are
   * the two halves of one area and each surface's own pass decides which half it
   * is looking at. A move between the halves is then carried by observers that
   * are already connected, so it costs nothing when no navigation event arrives.
   *
   * @param {Document} [doc] The document to start on.
   * @returns {boolean} whether this call started the surfaces.
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
        // A surface that cannot take the page is not a reason to keep the next
        // one off it.
      }
    }
    return true;
  }

  /**
   * Takes the surfaces off a document they are running on: what they drew comes
   * out, what they are watching is let go, and the reads they have in flight are
   * put down. This is what a repository leaving the allowlist does to a page
   * that is already showing it, and it leaves GitHub's own page as it found it.
   *
   * @param {Document} [doc] The document to stop on.
   * @returns {boolean} whether this call stopped the surfaces.
   */
  function stop(doc = globalThis.document) {
    if (!started.has(doc)) return false;
    started.delete(doc);
    for (const surface of [...surfaces()].reverse()) {
      try {
        surface.stop?.(doc);
      } catch {
        // A surface that cannot put the page down is not a reason to leave the
        // next one running on it.
      }
    }
    return true;
  }

  /**
   * Puts the document where the allowlist says it belongs, starting the surfaces
   * on a page they belong to and stopping them on one they no longer do.
   *
   * A path that names no advisory page is left alone unless `everywhere` says
   * otherwise. The surfaces are not on such a page to begin with, and a document
   * that keeps them across a move to one is a document they come back on without
   * waiting for another navigation event. An allowlist edit passes `everywhere`,
   * because a repository nobody listed has to stop being read wherever the
   * reading is happening.
   *
   * Every advisory page carries a control that opens the extension's settings,
   * listed repository or not, which is how a maintainer reaches the list from
   * the page they expected the extension to work on. REQUIREMENTS.md section 12.
   * It is shown after the surfaces have been asked to start, so a page that has
   * already drawn one puts the control above it. On a repository the allowlist
   * does not carry the control is the whole of what happens, because the
   * surfaces are what read, fetch and store and none of them starts.
   *
   * @param {Document} [doc]
   * @param {boolean} [everywhere]
   * @returns {boolean} whether this call started or stopped the surfaces.
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
   * Listens for the frame becoming a page a surface belongs to. A document that
   * loaded as something else has no surface running and so nothing watching it,
   * which is why this listens rather than leaving the surfaces to notice.
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
   * Takes the page the extension loaded onto, and every page GitHub turns it
   * into afterwards.
   *
   * Nothing starts before the allowlist has been read. The list lives in
   * `browser.storage.local` and the gate is synchronous, so until the read lands
   * every repository reads as off the list and no surface takes the page. The
   * document is reconsidered when it lands, which is what starts the surfaces on
   * a page that was already showing when this ran.
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
