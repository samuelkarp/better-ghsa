'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/allowlist.js');
  require('../common/schema.js');
  require('../common/parse-detail.js');
  require('../common/write.js');
}

/**
 * @typedef {import('../common/parse-detail.js').ParsedDetail} ParsedDetail
 * @typedef {import('../common/parse-detail.js').ParsedComment} ParsedComment
 * @typedef {import('../common/parse-detail.js').AdvisoryRef} AdvisoryRef
 * @typedef {import('../common/write.js').WriteResult} WriteResult
 */

/**
 * `pending` reserves an advisory before the first await. `sent` records a
 * request with an unconfirmed outcome. `written` records confirmed preservation.
 *
 * @typedef {'pending' | 'sent' | 'written'} AttemptState
 */

/**
 * @typedef {object} Availability
 * @property {boolean} available Whether the button is offered.
 * @property {boolean} writable Whether preservation is permitted.
 * @property {string | null} reason The refusal reason, or null when writable. Preservation
 *   and state writes share the `in-flight` reason.
 * @property {string} message The displayed status or refusal message.
 * @property {string | null} href The preservation comment's fragment URL, or null if absent
 *   from the document.
 */

/**
 * @typedef {object} PreserveOptions
 * @property {import('../common/write.js').WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 */

(() => {
  /**
   * Recognition and write verification use the marker, independently of this
   * summary text.
   */
  const PRESERVE_SUMMARY = `Original report preserved by ${globalThis.bghsa.schema.PROJECT_LINK}`;

  const TITLE_LABEL = 'Title:';

  const DESCRIPTION_LABEL = 'Description:';

  /**
   * GitHub preserves code spans when sanitizing comments. The marker uses one
   * to identify preservation comments in the rendered page. `1` is the format
   * version. Verification also requires the random suffix from `newMarker`.
   */
  const MARKER_PREFIX = 'better-ghsa:preserved:1:';

  const MARKER_BYTES = 8;

  /**
   * Generate a random marker per write. Verification requires this marker in
   * the response to distinguish the new comment from existing page content.
   *
   * @returns {string}
   */
  function newMarker() {
    const bytes = new Uint8Array(MARKER_BYTES);
    globalThis.crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${MARKER_PREFIX}${value}`;
  }

  const PENDING_MESSAGE = globalThis.bghsa.write.SAVING_MESSAGE;

  /**
   * An unconfirmed request may have created the comment. Require a page reload
   * before another attempt to prevent duplicate preservation comments.
   */
  const ATTEMPTED_MESSAGE = 'Reload page';

  const PRESERVED_MESSAGE = 'Preserved';

  /**
   * Record attempts by `owner/repo/GHSA-id` across panel rebuilds. The live
   * document may omit a comment created by this page's request.
   *
   * @type {Map<string, AttemptState>}
   */
  const attempts = new Map();

  /**
   * Identify preservation comments by their marker.
   *
   * @param {readonly ParsedComment[]} comments
   * @returns {ParsedComment | null}
   */
  function preservationComment(comments) {
    return comments.find((comment) => comment.text.includes(MARKER_PREFIX)) ?? null;
  }

  /**
   * @param {readonly ParsedComment[]} comments
   * @returns {boolean}
   */
  function hasPreservationComment(comments) {
    return preservationComment(comments) !== null;
  }

  /**
   * Remove unmatched closing details tags to protect the enclosing block.
   * Nested pairs are preserved. This counts literal tags, including code samples;
   * a tag in a sample can consume an opener and leave the wrapper unprotected.
   *
   * @param {string} text
   * @returns {string}
   */
  function balanceDetails(text) {
    let depth = 0;
    return text.replace(/<details(\s[^>]*)?>|<\/details\s*>/gi, (tag) => {
      if (tag[1] === '/') {
        if (depth === 0) return '';
        depth -= 1;
        return tag;
      }
      depth += 1;
      return tag;
    });
  }

  /**
   * Place the marker before reporter text to protect it from that text's markup.
   * Preservation requires known description provenance.
   *
   * @param {ParsedDetail} advisory
   * @param {string} marker The per-write marker.
   * @returns {string | null} The comment body, or null if the title, description, or
   *   provenance is unavailable.
   */
  function buildBody(advisory, marker) {
    const { title, description, descriptionOriginal } = advisory;
    if (title === null || description === null || descriptionOriginal === null) return null;
    return globalThis.bghsa.write.detailsBody(PRESERVE_SUMMARY, marker, [
      TITLE_LABEL,
      '',
      balanceDetails(title),
      '',
      DESCRIPTION_LABEL,
      '',
      balanceDetails(description),
    ]);
  }

  /**
   * @param {boolean} available
   * @param {boolean} writable
   * @param {string | null} reason
   * @param {string} message
   * @param {string | null} [href]
   * @returns {Availability}
   */
  function availability(available, writable, reason, message, href = null) {
    return { available, writable, reason, message, href };
  }

  /**
   * Determine availability from the parsed document. Refusals leave the button
   * enabled so a click can show the reason.
   *
   * @param {ParsedDetail} advisory
   * @returns {Availability}
   */
  function inspect(advisory) {
    const held = preservationComment(advisory.comments);
    if (held !== null) {

      return availability(
        false,
        false,
        'preserved',
        PRESERVED_MESSAGE,
        `#${held.elementId}`
      );
    }
    const ref = advisory.ref;
    if (ref === null) {
      return availability(true, false, 'unreadable', globalThis.bghsa.write.PARSE_MESSAGE);
    }
    const nameWithOwner = `${ref.owner}/${ref.repo}`;
    if (!globalThis.bghsa.allowlist.isAllowed(nameWithOwner)) {
      return availability(
        true,
        false,
        'allowlist',
        globalThis.bghsa.write.allowlistMessage(nameWithOwner)
      );
    }
    if (advisory.descriptionOriginal === null) {
      return availability(true, false, 'provenance', globalThis.bghsa.write.FAILED_MESSAGE);
    }
    if (advisory.title === null || advisory.description === null) {
      return availability(true, false, 'unreadable', globalThis.bghsa.write.PARSE_MESSAGE);
    }
    return availability(true, true, null, 'Preserve the title and description in a comment.');
  }

  /**
   * Combine page contents with local attempts to offer preservation at most once.
   *
   * @param {ParsedDetail} advisory
   * @returns {Availability}
   */
  function offered(advisory) {
    const state = inspect(advisory);
    const ref = advisory.ref;
    if (!state.writable || ref === null) return state;
    const attempt = attempts.get(globalThis.bghsa.write.holdKey(ref));
    if (attempt === 'written') {
      return availability(false, false, 'preserved', PRESERVED_MESSAGE);
    }
    if (attempt === 'sent') return availability(false, false, 'attempted', ATTEMPTED_MESSAGE);
    if (attempt === 'pending') return availability(false, false, 'in-flight', PENDING_MESSAGE);
    return state;
  }

  /**
   * Check whether a sent request may have created a comment missing from this
   * document. Both confirmed and unconfirmed requests count.
   *
   * @param {ParsedDetail} advisory
   * @returns {boolean}
   */
  function ahead(advisory) {
    const ref = advisory.ref;
    if (ref === null) return false;
    const attempt = attempts.get(globalThis.bghsa.write.holdKey(ref));
    if (attempt !== 'sent' && attempt !== 'written') return false;
    return !hasPreservationComment(advisory.comments);
  }

  /**
   * @param {Availability} state
   * @returns {WriteResult}
   */
  function refused(state) {
    return { ok: false, reason: state.reason, status: null, message: state.message };
  }

  /**
   * @param {string} reason
   * @param {number | null} status
   * @param {string} message
   * @returns {WriteResult}
   */
  function failed(reason, status, message) {
    return { ok: false, reason, status, message };
  }

  /**
   * Preserve the title and description from a fresh advisory read. The same
   * read supplies the form and the check for an existing preservation comment.
   *
   * @param {ParsedDetail} advisory
   * @param {PreserveOptions} [options]
   * @returns {Promise<WriteResult>}
   */
  async function preserve(advisory, options) {
    const state = offered(advisory);
    if (!state.writable) return refused(state);

    const send =
      options?.fetch ??
      /** @type {import('../common/write.js').WriteFetch} */ (globalThis.fetch.bind(globalThis));
    const toDocument =
      options?.parseDocument ?? ((html) => new DOMParser().parseFromString(html, 'text/html'));

    const { outcome } = await globalThis.bghsa.write.runWrite({
      ref: advisory.ref,
      unreadable: { reason: 'unreadable', message: globalThis.bghsa.write.PARSE_MESSAGE },
      fetch: send,
      parseDocument: toDocument,
      // Retain the hold after sending, including unconfirmed outcomes, to prevent
      // duplicate preservation comments.
      hold: {
        // Acquire the hold before the first await to prevent concurrent requests.
        take: (key) => {
          attempts.set(key, 'pending');
        },
        sent: (key) => {
          attempts.set(key, 'sent');
        },
        release: (key, settled) => {
          if (settled.outcome?.ok === true) attempts.set(key, 'written');

          else if (settled.outcome?.reason === 'preserved') attempts.set(key, 'written');
          else if (!settled.sent) attempts.delete(key);
        },
      },
      prepare: (run) => {
        const current = inspect(run.advisory);
        if (!current.writable) return refused(current);
        const marker = newMarker();
        const body = buildBody(run.advisory, marker);
        if (body === null) {
          return failed(
            'unreadable',
            null,
            'Error: this extension could not read what the comment would say.'
          );
        }
        return { body, expected: [marker] };
      },
    });
    return outcome;
  }

  const exported = {
    PRESERVE_SUMMARY,
    attempts,
    TITLE_LABEL,
    DESCRIPTION_LABEL,
    MARKER_PREFIX,
    PENDING_MESSAGE,
    ATTEMPTED_MESSAGE,
    PRESERVED_MESSAGE,
    newMarker,
    balanceDetails,
    preservationComment,
    hasPreservationComment,
    buildBody,
    offered,
    ahead,
    preserve,
  };

  globalThis.bghsa.preserve = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
