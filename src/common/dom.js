'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

(() => {
  /**
   * @param {Document} doc
   * @param {string} tag
   * @param {string} className
   * @param {string} [text]
   * @returns {Element}
   */
  function element(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className !== '') node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * Coalesce consecutive DOM mutation batches before rendering.
   */
  const RENDER_DELAY_MS = 50;

  /**
   * @param {Node} node
   * @param {string} selector
   * @returns {boolean} Whether `node` belongs to the extension or is inside
   *   an extension-owned node.
   */
  function ownedNode(node, selector) {
    const start = node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement;
    return start !== null && start.closest(selector) !== null;
  }

  /**
   * Ignore changes to extension-owned nodes to prevent render loops.
   *
   * @param {MutationRecord} record
   * @param {string} selector
   * @returns {boolean}
   */
  function ownWrite(record, selector) {
    if (ownedNode(record.target, selector)) return true;
    const touched = [...record.addedNodes, ...record.removedNodes];
    return touched.length > 0 && touched.every((node) => ownedNode(node, selector));
  }

  /**
   * @typedef {object} Watched
   * @property {() => string} ownedSelector Matches the surface's nodes.
   * @property {(doc: Document) => boolean} outOfPlace Whether the surface is
   *   missing or misplaced.
   * @property {() => Promise<void>} pass Serializes renders from all callers.
   */

  /**
   * Observe the document element to detect replacement of GitHub's content
   * frame and its descendants, including navigation without a document load.
   * Schedule at most one render per burst of external mutations.
   *
   * @param {Document} doc
   * @param {Watched} surface
   * @returns {MutationObserver | null} Null if the target or MutationObserver is unavailable.
   */
  function watch(doc, surface) {
    const target = doc.documentElement ?? doc.body;
    if (target === null) return null;
    const Observer = globalThis.MutationObserver ?? doc.defaultView?.MutationObserver;
    if (Observer === undefined || Observer === null) return null;
    let scheduled = false;
    const observer = new Observer((records) => {
      if (scheduled) return;
      const selector = surface.ownedSelector();
      const changed =
        records.some((record) => !ownWrite(record, selector)) || surface.outOfPlace(doc);
      if (!changed) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        void surface.pass();
      }, RENDER_DELAY_MS);
    });
    observer.observe(target, { childList: true, subtree: true });
    return observer;
  }

  const exported = {
    element,
    RENDER_DELAY_MS,
    watch,
  };

  globalThis.bghsa.dom = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
