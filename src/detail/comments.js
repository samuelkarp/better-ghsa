'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/parse-detail.js');
  require('../common/merge.js');
  require('../common/chips.js');
}

/**
 * @typedef {import('../common/merge.js').MergedState} MergedState
 * @typedef {import('../common/merge.js').MergeWarning} MergeWarning
 * @typedef {import('../common/merge.js').WarningKind} WarningKind
 */

(() => {
  /**
   * Missing snapshots and invalid payloads share a label because both prevent
   * the extension from reading tracking state. The untrusted label reports the
   * author's role badge, which determines whether the merge accepts the comment.
   *
   * @type {Record<WarningKind, string>}
   */
  const CHIP_TEXT = {
    untrusted: 'Ignored: non-member state',
    'invalid payload': 'Unable to parse tracking state',
    'not a snapshot': 'Unable to parse tracking state',
    'unsupported schema': 'Tracking state from a newer extension',
  };

  /**
   * Untrusted state uses the danger color because only organization members may
   * set tracking state.
   *
   * @type {Record<WarningKind, 'attention' | 'danger'>}
   */
  const CHIP_TONE = {
    untrusted: 'danger',
    'invalid payload': 'attention',
    'not a snapshot': 'attention',
    'unsupported schema': 'attention',
  };

  /**
   * @param {Document} doc
   * @param {string} elementId
   * @returns {Element | null}
   */
  function commentGroup(doc, elementId) {
    const group = doc.getElementById(elementId);
    if (group === null) return null;
    return group.matches('div.timeline-comment-group[id^="advisory-comment-"]') ? group : null;
  }

  /**
   * @param {Document} doc
   * @param {MergeWarning} alert
   * @returns {Element}
   */
  function buildChip(doc, alert) {
    const parse = globalThis.bghsa.parseDetail;
    const node = globalThis.bghsa.chips.buildChip(doc, {
      text: CHIP_TEXT[alert.kind],
      tone: CHIP_TONE[alert.kind],
    });
    node.setAttribute(parse.EXTENSION_CHIP_ATTRIBUTE, alert.kind);

    if (alert.message !== '') node.setAttribute('title', alert.message);
    return node;
  }

  /**
   * Place the chip beside the author role badge (REQUIREMENTS.md section 4).
   * Insert it outside the badge's tooltip wrapper to avoid inheriting the tooltip.
   * Headers without a badge receive the chip at the end.
   *
   * @param {Element} group
   * @param {Element} node
   * @returns {boolean} Whether placement succeeded.
   */
  function placeChip(group, node) {
    const parse = globalThis.bghsa.parseDetail;
    const header = group.querySelector('div.timeline-comment-header');
    if (header === null) return false;
    const badge = Array.from(header.querySelectorAll('span.Label')).find(
      (label) =>
        label.closest('.comment-body') === null &&
        !label.hasAttribute(parse.EXTENSION_CHIP_ATTRIBUTE)
    );
    if (badge === undefined) {
      header.append(node);
      return true;
    }
    const wrapper = badge.closest('span.tooltipped');
    const outer = wrapper !== null && header.contains(wrapper) ? wrapper : badge;
    const host = outer.parentElement;
    if (host === null) return false;
    host.insertBefore(node, outer.nextSibling);
    return true;
  }

  /**
   * Mark comments whose snapshots the merge rejected (REQUIREMENTS.md section 8).
   * Reuse matching chips to avoid triggering the mutation observer on each pass.
   *
   * @param {Document} doc
   * @param {MergedState} merged
   * @returns {Element[]} The warning chips in the updated document.
   */
  function markComments(doc, merged) {
    const attribute = globalThis.bghsa.parseDetail.EXTENSION_CHIP_ATTRIBUTE;

    // The merge reports only the first problem with each snapshot.
    /** @type {Map<string, MergeWarning>} */
    const wanted = new Map();
    for (const alert of merged.warnings) {
      if (!wanted.has(alert.elementId)) wanted.set(alert.elementId, alert);
    }

    for (const existing of doc.querySelectorAll(`[${attribute}]`)) {
      const group = existing.closest('div.timeline-comment-group[id^="advisory-comment-"]');
      const alert = group === null ? undefined : wanted.get(group.id);
      if (group !== null && alert !== undefined && existing.getAttribute(attribute) === alert.kind) {
        wanted.delete(group.id);
        continue;
      }
      existing.remove();
    }

    for (const [elementId, alert] of wanted) {
      const group = commentGroup(doc, elementId);
      if (group === null) continue;
      placeChip(group, buildChip(doc, alert));
    }

    return Array.from(doc.querySelectorAll(`[${attribute}]`));
  }

  const exported = { CHIP_TEXT, CHIP_TONE, buildChip, placeChip, markComments };

  globalThis.bghsa.comments = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
