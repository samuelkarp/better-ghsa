'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./text.js');
  require('./allowlist.js');
  require('./parse-detail.js');
}

/**
 * The response fields used to check a write.
 *
 * @typedef {object} WriteResponse
 * @property {number} status The HTTP response status.
 * @property {() => Promise<string>} text
 */

/**
 * @typedef {(url: string, init: RequestInit) => Promise<WriteResponse>} WriteFetch
 */

/** @typedef {'malformed-action' | 'origin' | 'credentials' | 'advisory-path' | 'comment-path'} DestinationCheck */

/**
 * Diagnostics contain structural facts only. Exclude form values, page
 * content, and identifiers. Missing field names come from REQUIRED_EDIT_FIELDS.
 *
 * @typedef {{ code: 'edit-form-missing-fields', missingFields: string[] } |
 *   { code: 'comment-form-missing' } |
 *   { code: 'advisory-page-mismatch', pageRecognized: boolean, identityReadable: boolean | null,
 *     identityMatches: boolean | null } |
 *   { code: 'form-destination-mismatch', operation: 'create' | 'edit', failedCheck: DestinationCheck } |
 *   { code: 'edit-form-missing', targetCommentFound: boolean } |
 *   { code: 'save-unconfirmed', status: number, commentContainersFound: boolean | null,
 *     expectedContentFound: boolean | null }} WriteDiagnostic
 */

/**
 * @typedef {object} WriteResult
 * @property {boolean} ok
 * @property {string | null} reason The failure reason, or null on success.
 * @property {number | null} status The HTTP response status, or null without a
 *   response.
 * @property {string} message The user-facing result message.
 * @property {WriteDiagnostic} [diagnostic]
 */

/**
 * @typedef {object} CreateCommentOptions
 * @property {Document} doc The page containing the form to copy.
 * @property {import('./parse-detail.js').AdvisoryRef} ref The advisory identity read
 *   from the page.
 * @property {string} body The comment's markdown.
 * @property {readonly string[]} expected Strings required in one rendered body to
 *   confirm the write.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 * @property {() => void} [beforeSend] Called after building the request and
 *   immediately before sending it.
 */

/**
 * @typedef {object} EditCommentOptions
 * @property {Document} doc The page containing the form to copy.
 * @property {import('./parse-detail.js').AdvisoryRef} ref The advisory identity read
 *   from the page.
 * @property {string} commentId The target comment. The caller must verify that the
 *   current user owns it.
 * @property {string} body The comment's new markdown.
 * @property {readonly string[]} expected Strings required in one rendered body to
 *   confirm the write.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 * @property {() => void} [beforeSend] Called after building the request and
 *   immediately before sending it.
 */

/**
 * A write uses one freshly fetched advisory page.
 *
 * @typedef {object} WriteRun
 * @property {Document} page The page the form is cloned from.
 * @property {import('./parse-detail.js').ParsedDetail} advisory The parsed advisory
 *   page.
 * @property {import('./parse-detail.js').AdvisoryRef} ref The advisory identity read
 *   from the page.
 * @property {number} readAt The page-fetch start time in epoch milliseconds.
 */

/**
 * @typedef {object} PreparedWrite
 * @property {string} body The comment's markdown.
 * @property {readonly string[]} expected Strings required in one rendered body to
 *   confirm the write.
 * @property {string} [commentId] The comment to edit. Omit to create a comment.
 */

/**
 * The caller controls how long a write hold remains active, including after
 * an unconfirmed response.
 *
 * @typedef {object} WriteHold
 * @property {(key: string) => WriteResult | null} [held] Return a refusal if the
 *   advisory already has a write hold, otherwise null.
 * @property {(key: string) => void} [take] Acquire the hold before the first await.
 * @property {(key: string) => void} [sent] Called immediately before sending the
 *   comment request.
 * @property {(key: string, settled: { sent: boolean, outcome: WriteResult |
 *   null }) => void} [release] Called when the attempt finishes. sent records
 *   whether sending began.
 */

/**
 * @typedef {object} RunWriteOptions
 * @property {import('./parse-detail.js').AdvisoryRef | null} ref The advisory
 *   identity read from the page.
 * @property {{ reason: string, message: string }} [unreadable] The refusal to return
 *   when ref is null. Required in that case.
 * @property {(run: WriteRun) => PreparedWrite | WriteResult |
 *   Promise<PreparedWrite | WriteResult>} prepare Validate the freshly read state
 *   and build the comment, or return a refusal.
 * @property {WriteHold} [hold]
 * @property {() => number} [now] The clock supplying readAt.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 * @property {() => void} [beforeSend] Called after building the request and
 *   immediately before sending it.
 */

(() => {
  const collapse = globalThis.bghsa.text.collapse;

  /**
   * @param {Element} field
   * @returns {string} The live field value when available, otherwise its value
   *   attribute.
   */
  function valueOf(field) {
    const live = /** @type {{ value?: unknown }} */ (/** @type {unknown} */ (field)).value;
    return typeof live === 'string' ? live : (field.getAttribute('value') ?? '');
  }

  /**
   * @param {Element} field
   * @returns {boolean} whether a checkbox or radio is checked.
   */
  function isChecked(field) {
    const live = /** @type {{ checked?: unknown }} */ (/** @type {unknown} */ (field)).checked;
    return typeof live === 'boolean' ? live : field.hasAttribute('checked');
  }

  /**
   * @param {Element} field
   * @returns {boolean} whether the form submission leaves `field` out.
   */
  function isDisabled(field) {
    return field.hasAttribute('disabled') || field.closest('fieldset[disabled]') !== null;
  }

  /**
   * @param {Element} select
   * @returns {string[]} The selected option values submitted for a select.
   */
  function selectedValues(select) {
    const options = Array.from(select.querySelectorAll('option'));
    const picked = options.filter((option) => {
      const live = /** @type {{ selected?: unknown }} */ (/** @type {unknown} */ (option)).selected;
      return typeof live === 'boolean' ? live : option.hasAttribute('selected');
    });
    if (select.hasAttribute('multiple')) return picked.map((option) => valueOf(option));
    const one = picked[picked.length - 1] ?? options[0];
    return one === undefined ? [] : [valueOf(one)];
  }

  /**
   * These input types are excluded from formEntries.
   */
  const SKIPPED_INPUT_TYPES = ['submit', 'reset', 'button', 'image', 'file'];

  /**
   * Collect form fields in document order. The caller adds the selected
   * submit button separately.
   * @param {Element} form
   * @returns {Array<[string, string]>}
   */
  function formEntries(form) {
    /** @type {Array<[string, string]>} */
    const entries = [];
    for (const field of form.querySelectorAll('input, textarea, select')) {
      const name = field.getAttribute('name');
      if (name === null || name === '') continue;
      if (isDisabled(field)) continue;
      // A field inside a template or a datalist is not a control of the form.
      if (field.closest('template, datalist') !== null) continue;

      if (field.tagName === 'SELECT') {
        for (const value of selectedValues(field)) entries.push([name, value]);
        continue;
      }
      if (field.tagName === 'INPUT') {
        const type = (field.getAttribute('type') ?? 'text').toLowerCase();
        if (SKIPPED_INPUT_TYPES.includes(type)) continue;
        if (type === 'checkbox' || type === 'radio') {
          if (!isChecked(field)) continue;
          const value = valueOf(field);
          entries.push([name, value === '' ? 'on' : value]);
          continue;
        }
      }
      entries.push([name, valueOf(field)]);
    }
    return entries;
  }

  /**
   * Copy GitHub's randomized required_field_XXXX and signed timestamp_secret
   * from the rendered form. These forms use application/x-www-form-urlencoded.
   * @param {Element} form
   * @returns {URLSearchParams}
   */
  function cloneForm(form) {
    const params = new URLSearchParams();
    for (const [name, value] of formEntries(form)) params.append(name, value);
    return params;
  }

  /**
   * Creation forms post to /comments; edit forms post to a comment ID.
   * @param {Document} root
   * @returns {Element | null}
   */
  function findCommentForm(root) {
    for (const form of root.querySelectorAll('form[action]')) {
      if (globalThis.bghsa.parseDetail.isCommentForm(form)) return form;
    }
    return null;
  }

  /**
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @returns {string}
   */
  function commentPath(ref) {
    return `/${ref.owner}/${ref.repo}/security/advisories/${ref.ghsaId}/comments`;
  }

  /**
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @param {string} commentId
   * @returns {string}
   */
  function editPath(ref, commentId) {
    return `${commentPath(ref)}/${commentId}`;
  }

  /**
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @returns {string} The lowercase advisory key for write holds.
   */
  function holdKey(ref) {
    // Use the same case-insensitive identity as the allowlist and reference checks.
    return `${ref.owner}/${ref.repo}/${ref.ghsaId}`.toLowerCase();
  }

  /**
   * @param {import('./parse-detail.js').AdvisoryRef} left
   * @param {import('./parse-detail.js').AdvisoryRef} right
   * @returns {boolean} whether both name the same advisory.
   */
  function sameRef(left, right) {
    return (
      left.owner.toLowerCase() === right.owner.toLowerCase() &&
      left.repo.toLowerCase() === right.repo.toLowerCase() &&
      left.ghsaId.toLowerCase() === right.ghsaId.toLowerCase()
    );
  }

  /**
   * Require the form action to target this advisory on https://github.com
   * with credentials excluded from the URL.
   * @param {string} action
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @param {string} [commentId] The expected comment ID. Omit for the comment
   *   collection.
   * @returns {boolean}
   */
  function actionMatchesRef(action, ref, commentId) {
    return destinationFailure(action, ref, commentId) === null;
  }

  /**
   * Returns the first failed destination check without retaining the URL.
   * @param {string} action
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @param {string} [commentId]
   * @returns {DestinationCheck | null}
   */
  function destinationFailure(action, ref, commentId) {
    /** @type {URL} */
    let url;
    try {
      url = new URL(action, 'https://github.com/');
    } catch {
      return 'malformed-action';
    }
    if (url.origin !== 'https://github.com') return 'origin';
    // URL.origin excludes credentials, which this check rejects separately.
    if (url.username !== '' || url.password !== '') return 'credentials';
    const actual = url.pathname.replace(/\/+$/, '').toLowerCase();
    const wanted = commentId === undefined ? commentPath(ref) : editPath(ref, commentId);
    if (actual === wanted.toLowerCase()) return null;
    const collection = commentPath(ref).toLowerCase();
    if (commentId !== undefined && (actual === collection || actual.startsWith(`${collection}/`))) {
      return 'comment-path';
    }
    return 'advisory-path';
  }

  /**
   * GitHub includes edit forms in fetched HTML before any menu opens.
   * Maintainers may receive forms for other authors' comments; the caller
   * must verify ownership before editing.
   * @param {Document} root
   * @param {string} commentId
   * @returns {Element | null}
   */
  function findEditForm(root, commentId) {
    return root.querySelector(`form[id="advisory-comment-${commentId}-edit-form"]`);
  }

  /**
   * Exclude these elements when checking rendered comment content.
   */
  const NOT_RENDERED = [
    'TEXTAREA',
    'INPUT',
    'SELECT',
    'OPTION',
    'BUTTON',
    'TEMPLATE',
    'SCRIPT',
    'STYLE',
  ];

  const COMMENT_BODY = '.comment-body, .js-comment-body, .markdown-body';

  /**
   * Collect comment text while excluding controls and non-content elements.
   * @param {Node} node
   * @returns {string}
   */
  function renderedText(node) {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const element = /** @type {Element} */ (node);
    if (NOT_RENDERED.includes(element.tagName)) return '';
    let text = '';
    for (const child of element.childNodes) text += renderedText(child);
    return text;
  }

  /**
   * Confirm that one rendered body contains every expected string. Form
   * values echoed after a rejected submission are excluded.
   * @param {Document} doc
   * @param {readonly string[]} expected
   * @returns {boolean}
   */
  function commentContains(doc, expected) {
    return inspectComments(doc, expected).expectedContentFound;
  }

  /**
   * Share response checks between save confirmation and diagnostics.
   * Inspect both roots because parsed fragments may have an empty body.
   * @param {Document} doc
   * @param {readonly string[]} expected
   * @returns {{ commentContainersFound: boolean, expectedContentFound: boolean }}
   */
  function inspectComments(doc, expected) {
    const collapsed = expected.map((string) => collapse(string)).filter((string) => string !== '');
    /** @type {Set<Element>} */
    const bodies = new Set();
    for (const root of [doc.documentElement, doc.body]) {
      if (root === null) continue;
      if (root.matches(COMMENT_BODY)) bodies.add(root);
      for (const body of root.querySelectorAll(COMMENT_BODY)) bodies.add(body);
    }
    const expectedContentFound = collapsed.length > 0 && [...bodies].some((body) => {
      const text = collapse(renderedText(body));
      return collapsed.every((string) => text.includes(string));
    });
    return { commentContainersFound: bodies.size > 0, expectedContentFound };
  }

  /**
   * Build a collapsed details block with the marker immediately after its
   * summary. Blank lines around the tags allow Markdown links to render.
   * @param {string} summary The visible summary text.
   * @param {string} marker The extension comment marker.
   * @param {readonly string[]} lines The body lines below the marker.
   * @returns {string}
   */
  function detailsBody(summary, marker, lines) {
    return [
      '<details>',
      '',
      `<summary>${summary}</summary>`,
      '',
      `\`${marker}\``,
      '',
      ...lines,
      '',
      '</details>',
      '',
    ].join('\n');
  }

  /**
   * @param {boolean} ok
   * @param {string | null} reason
   * @param {number | null} status
   * @param {string} message
   * @returns {WriteResult}
   */
  function result(ok, reason, status, message) {
    return { ok, reason, status, message };
  }

  /**
   * The panel and completed view share this saving message.
   */
  const SAVING_MESSAGE = 'Saving...';

  const REFRESH_MESSAGE = 'Error: failed to refresh advisory data';

  const FAILED_MESSAGE = 'Error: failed to save';

  /**
   * A successful HTTP response can leave the save unconfirmed. The comment
   * may have been written.
   */
  const UNCONFIRMED_MESSAGE = 'Error: failed to validate save';

  const NO_FORM_MESSAGE = 'Error: cannot post';

  /**
   * Unsupported schemas and clears that would delete unknown fields both
   * require an extension update.
   */
  const OUTDATED_MESSAGE = 'Error: update the extension';

  /**
   * A changed sequence or a different winner at the same sequence makes
   * the loaded state stale. The editor retains staged changes.
   */
  const STALE_MESSAGE = 'Error: concurrent edits';

  const PARSE_MESSAGE = 'Error: failed to parse advisory';

  /**
   * Internal validation details are logged separately from this message.
   */
  const INVALID_STATE_MESSAGE = 'Error: cannot save invalid state';

  /**
   * @param {string} nameWithOwner
   * @returns {string} The shared allowlist refusal message.
   */
  function allowlistMessage(nameWithOwner) {
    return `Error: ${nameWithOwner} is not on this extension's allowlist.`;
  }

  const MISMATCH_MESSAGE = 'Error: unexpected response';

  const COMMENT_FORM_MESSAGE = 'Error: unexpected comment form destination';

  const EDIT_FORM_MESSAGE = 'Error: unexpected edit form destination';

  const EDIT_FIELDS_MESSAGE = 'Error: unexpected edit form fields';

  /**
   * Log diagnostic details separately from the user-facing message.
   * @param {string} what
   * @param {unknown} [detail]
   * @returns {void}
   */
  function log(what, detail) {
    if (detail === undefined) console.warn(`[better-ghsa] ${what}`);
    else console.warn(`[better-ghsa] ${what}`, detail);
  }

  /**
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @returns {string}
   */
  function detailUrl(ref) {
    return `/${ref.owner}/${ref.repo}/security/advisories/${ref.ghsaId}`;
  }

  const DETAIL_INIT = /** @type {RequestInit} */ ({
    method: 'GET',
    credentials: 'same-origin',
    redirect: 'follow',
    cache: 'no-store',
    headers: { Accept: 'text/html' },
  });

  /**
   * Fetch the advisory page used for state, form fields, and preserved text.
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @param {{ fetch?: WriteFetch, parseDocument?: (html: string) => Document }} options
   * @returns {Promise<{ page: Document | null, failure: WriteResult | null }>} Exactly
   *   one of page and failure is non-null.
   */
  async function fetchAdvisoryPage(ref, options) {
    const send = options.fetch ?? /** @type {WriteFetch} */ (globalThis.fetch.bind(globalThis));
    const toDocument =
      options.parseDocument ?? ((html) => new DOMParser().parseFromString(html, 'text/html'));
    try {
      const response = await send(detailUrl(ref), DETAIL_INIT);
      if (!(response.status >= 200 && response.status < 300)) {
        log(`the advisory page could not be read: GitHub answered ${response.status}`);
        return {
          page: null,
          failure: result(false, 'fetch', response.status, REFRESH_MESSAGE),
        };
      }
      return { page: toDocument(await response.text()), failure: null };
    } catch (error) {
      log('the advisory page could not be read', error);
      return { page: null, failure: result(false, 'fetch', null, REFRESH_MESSAGE) };
    }
  }

  const EDIT_BODY_FIELD = 'repository_advisory_comment[body]';

  /**
   * authenticity_token protects the POST against CSRF. GitHub uses
   * repository_advisory_comment[bodyVersion] to reject edits to a comment
   * that changed after the fetch.
   *
   * @type {readonly string[]}
   */
  const REQUIRED_EDIT_FIELDS = [
    'authenticity_token',
    'repository_advisory_comment[bodyVersion]',
    EDIT_BODY_FIELD,
  ];

  /**
   * Check the allowlist, comment body, and confirmation text before sending.
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @param {string} body
   * @param {readonly string[]} expected
   * @returns {WriteResult | null} The refusal, or null to proceed.
   */
  function refuseBeforeRequest(ref, body, expected) {
    const nameWithOwner = `${ref.owner}/${ref.repo}`;
    if (!globalThis.bghsa.allowlist.isAllowed(nameWithOwner)) {
      return result(false, 'allowlist', null, allowlistMessage(nameWithOwner));
    }
    if (collapse(body) === '') {
      log('the comment this write would leave is empty');
      return result(false, 'unverifiable', null, INVALID_STATE_MESSAGE);
    }
    if (expected.every((string) => collapse(string) === '')) {
      log('the write carries nothing to confirm it by');
      return result(false, 'unverifiable', null, INVALID_STATE_MESSAGE);
    }
    return null;
  }

  /**
   * Report success only after the response contains the expected comment text.
   * @param {string} action
   * @param {URLSearchParams} params
   * @param {readonly string[]} expected
   * @param {CreateCommentOptions | EditCommentOptions} options
   * @returns {Promise<WriteResult>}
   */
  async function postForm(action, params, expected, options) {
    const send = options.fetch ?? /** @type {WriteFetch} */ (globalThis.fetch.bind(globalThis));
    /** @type {WriteResponse} */
    let response;
    if (options.beforeSend !== undefined) options.beforeSend();
    try {
      response = await send(action, {
        method: 'POST',
        body: params,
        credentials: 'same-origin',
        redirect: 'follow',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      });
    } catch (error) {
      log('the write got no answer from GitHub', error);
      return result(false, 'unreachable', null, FAILED_MESSAGE);
    }

    const status = response.status;
    if (!(status >= 200 && status < 300)) {
      log(`the write failed: GitHub answered ${status}`);
      return result(false, 'status', status, FAILED_MESSAGE);
    }

    const toDocument =
      options.parseDocument ?? ((html) => new DOMParser().parseFromString(html, 'text/html'));
    /** @type {Extract<WriteDiagnostic, { code: 'save-unconfirmed' }>} */
    const diagnostic = {
      code: 'save-unconfirmed',
      status,
      commentContainersFound: null,
      expectedContentFound: null,
    };
    try {
      Object.assign(diagnostic, inspectComments(toDocument(await response.text()), expected));
    } catch (error) {
      log('the write could not be confirmed', error);
    }
    if (diagnostic.expectedContentFound !== true) {
      return {
        ...result(false, 'unwritten', status, UNCONFIRMED_MESSAGE),
        diagnostic,
      };
    }
    // The caller supplies its own success message.
    return result(true, null, status, '');
  }

  /**
   * Create a comment after checking the allowlist and form destination.
   * @param {CreateCommentOptions} options
   * @returns {Promise<WriteResult>}
   */
  async function createComment(options) {
    const { doc, ref, body, expected } = options;
    const refused = refuseBeforeRequest(ref, body, expected);
    if (refused !== null) return refused;

    const form = findCommentForm(doc);
    if (form === null) {
      return {
        ...result(false, 'no-form', null, NO_FORM_MESSAGE),
        diagnostic: { code: 'comment-form-missing' },
      };
    }
    const action = form.getAttribute('action') ?? '';
    const failedCheck = destinationFailure(action, ref);
    if (failedCheck !== null) {
      log(`the comment form posts to ${action}, not to ${ref.owner}/${ref.repo} ${ref.ghsaId}`);
      return {
        ...result(false, 'mismatch', null, COMMENT_FORM_MESSAGE),
        diagnostic: { code: 'form-destination-mismatch', operation: 'create', failedCheck },
      };
    }

    const params = cloneForm(form);
    params.set('body', body);
    // Include the Comment action even when the page disables the empty composer.
    const submit = form.querySelector('button[type="submit"][name="comment"]');
    if (submit !== null) params.set('comment', submit.getAttribute('value') ?? '1');

    return postForm(action, params, expected, options);
  }

  /**
   * Edit the caller-selected comment using GitHub's form fields. The caller
   * must verify ownership; findEditForm can return other authors' forms.
   * @param {EditCommentOptions} options
   * @returns {Promise<WriteResult>}
   */
  async function editComment(options) {
    const { doc, ref, commentId, body, expected } = options;
    const refused = refuseBeforeRequest(ref, body, expected);
    if (refused !== null) return refused;

    const form = findEditForm(doc, commentId);
    if (form === null) {
      return {
        ...result(false, 'no-form', null, NO_FORM_MESSAGE),
        diagnostic: {
          code: 'edit-form-missing',
          targetCommentFound: doc.getElementById(`advisory-comment-${commentId}`) !== null,
        },
      };
    }
    const action = form.getAttribute('action') ?? '';
    const failedCheck = destinationFailure(action, ref, commentId);
    if (failedCheck !== null) {
      log(
        `the edit form posts to ${action}, not to ${ref.owner}/${ref.repo} ${ref.ghsaId}` +
          ` comment ${commentId}`
      );
      return {
        ...result(false, 'mismatch', null, EDIT_FORM_MESSAGE),
        diagnostic: { code: 'form-destination-mismatch', operation: 'edit', failedCheck },
      };
    }

    const params = cloneForm(form);
    const missing = REQUIRED_EDIT_FIELDS.filter((field) => !params.has(field));
    if (missing.length > 0) {
      log(`the edit form for comment ${commentId} carries no ${missing.join(' and no ')}`);
      return {
        ...result(false, 'no-token', null, EDIT_FIELDS_MESSAGE),
        diagnostic: { code: 'edit-form-missing-fields', missingFields: missing },
      };
    }
    params.set(EDIT_BODY_FIELD, body);

    return postForm(action, params, expected, options);
  }

  /**
   * Check the advisory reference and allowlist before fetching. Verify the
   * fetched page's identity and allowlist membership before calling prepare.
   * The callback validates surface-specific state and prepares the comment
   * to create or edit.
   * @param {RunWriteOptions} options
   * @returns {Promise<{ outcome: WriteResult, run: WriteRun | null }>} The outcome
   *   and the verified page, if available.
   */
  async function runWrite(options) {
    const ref = options.ref;
    if (ref === null) {
      const unreadable = options.unreadable;
      if (unreadable === undefined) {
        throw new TypeError('a write with no advisory reference needs wording for one');
      }
      return { outcome: result(false, unreadable.reason, null, unreadable.message), run: null };
    }
    const nameWithOwner = `${ref.owner}/${ref.repo}`;
    if (!globalThis.bghsa.allowlist.isAllowed(nameWithOwner)) {
      return {
        outcome: result(false, 'allowlist', null, allowlistMessage(nameWithOwner)),
        run: null,
      };
    }

    const hold = options.hold;
    const key = holdKey(ref);
    const already = hold?.held?.(key) ?? null;
    if (already !== null) return { outcome: already, run: null };
    // Acquire the caller's hold before the first await to prevent duplicate
    // submissions. The caller defines how the hold is released.
    hold?.take?.(key);

    const passed = {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.parseDocument === undefined ? {} : { parseDocument: options.parseDocument }),
    };
    let sent = false;
    /** @type {WriteResult | null} */
    let outcome = null;
    /** @type {WriteRun | null} */
    let run = null;
    try {
      // Timestamp the observation before fetching to avoid overstating freshness.
      const readAt = (options.now ?? Date.now)();
      const fetched = await fetchAdvisoryPage(ref, passed);
      if (fetched.failure !== null || fetched.page === null) {
        outcome = fetched.failure ?? result(false, 'fetch', null, REFRESH_MESSAGE);
        return { outcome, run: null };
      }
      const page = fetched.page;

      const advisory = globalThis.bghsa.parseDetail.parseDetail(page);
      if (advisory === null || advisory.ref === null || !sameRef(advisory.ref, ref)) {
        log(`the page read for ${ref.owner}/${ref.repo} ${ref.ghsaId} is another advisory`);
        outcome = {
          ...result(false, 'mismatch', null, MISMATCH_MESSAGE),
          diagnostic: {
            code: 'advisory-page-mismatch',
            pageRecognized: advisory !== null,
            identityReadable: advisory === null ? null : advisory.ref !== null,
            identityMatches: advisory === null || advisory.ref === null ? null : false,
          },
        };
        return { outcome, run: null };
      }
      const freshName = `${advisory.ref.owner}/${advisory.ref.repo}`;
      if (!globalThis.bghsa.allowlist.isAllowed(freshName)) {
        outcome = result(false, 'allowlist', null, allowlistMessage(freshName));
        return { outcome, run: null };
      }

      run = { page, advisory, ref: advisory.ref, readAt };
      const prepared = await options.prepare(run);
      if ('ok' in prepared) {
        outcome = prepared;
        return { outcome, run };
      }

      const common = {
        doc: page,
        ref: advisory.ref,
        body: prepared.body,
        expected: prepared.expected,
        ...passed,
        beforeSend: () => {
          sent = true;
          hold?.sent?.(key);
          options.beforeSend?.();
        },
      };
      outcome =
        prepared.commentId === undefined
          ? await createComment(common)
          : await editComment({ ...common, commentId: prepared.commentId });
      return { outcome, run };
    } finally {
      hold?.release?.(key, { sent, outcome });
    }
  }

  const exported = {
    DETAIL_INIT,
    collapse,
    holdKey,
    detailsBody,
    SAVING_MESSAGE,
    FAILED_MESSAGE,
    UNCONFIRMED_MESSAGE,
    STALE_MESSAGE,
    OUTDATED_MESSAGE,
    PARSE_MESSAGE,
    INVALID_STATE_MESSAGE,
    allowlistMessage,
    EDIT_BODY_FIELD,
    detailUrl,
    fetchAdvisoryPage,
    cloneForm,
    findCommentForm,
    findEditForm,
    commentPath,
    editPath,
    actionMatchesRef,
    commentContains,
    createComment,
    editComment,
    runWrite,
  };

  globalThis.bghsa.write = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
