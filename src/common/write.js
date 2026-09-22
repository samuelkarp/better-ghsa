'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./text.js');
  require('./allowlist.js');
  require('./parse-detail.js');
}

/**
 * The response a write reads. `globalThis.fetch` satisfies it, and so does the
 * stand-in a test supplies.
 *
 * @typedef {object} WriteResponse
 * @property {number} status
 * @property {() => Promise<string>} text
 */

/**
 * @typedef {(url: string, init: RequestInit) => Promise<WriteResponse>} WriteFetch
 */

/** @typedef {'malformed-action' | 'origin' | 'credentials' | 'advisory-path' | 'comment-path'} DestinationCheck */

/**
 * Structural facts only: never form values, page content, or identifiers.
 * Missing field names come from REQUIRED_EDIT_FIELDS.
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
 * @property {string | null} reason One of `allowlist`, `fetch`,
 *   `unverifiable`, `no-form`, `no-token`, `mismatch`, `status`, `unwritten`,
 *   `unreachable`, and null on success.
 * @property {number | null} status The response status, when there was one.
 * @property {string} message What happened, in the words the panel shows.
 * @property {WriteDiagnostic} [diagnostic]
 */

/**
 * @typedef {object} CreateCommentOptions
 * @property {Document} doc The page carrying the form the write clones.
 * @property {import('./parse-detail.js').AdvisoryRef} ref The advisory the
 *   comment goes on, read from that page.
 * @property {string} body The comment's markdown.
 * @property {readonly string[]} expected Text the response must render in one
 *   comment for the write to count as done.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 * @property {() => void} [beforeSend] Called once the request is built and
 *   before it goes out, so the caller holds the advisory for the flight.
 */

/**
 * @typedef {object} EditCommentOptions
 * @property {Document} doc The page carrying the edit form the write clones.
 * @property {import('./parse-detail.js').AdvisoryRef} ref The advisory the
 *   comment is on, read from that page.
 * @property {string} commentId The comment this edit replaces the body of.
 *   The caller has established that this maintainer wrote it.
 * @property {string} body The comment's new markdown.
 * @property {readonly string[]} expected Text the response must render in one
 *   comment for the write to count as done.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 * @property {() => void} [beforeSend] Called once the request is built and
 *   before it goes out, so the caller holds the advisory for the flight.
 */

/**
 * What one write runs against: the advisory page it read, and when.
 *
 * @typedef {object} WriteRun
 * @property {Document} page The page the form is cloned from.
 * @property {import('./parse-detail.js').ParsedDetail} advisory That page, as
 *   this extension reads it.
 * @property {import('./parse-detail.js').AdvisoryRef} ref The reference that
 *   page carries, which the caller's own reference agrees with.
 * @property {number} readAt When the page was read, epoch milliseconds. It is
 *   taken before the request goes out, so it is when everything the page says
 *   was observed.
 */

/**
 * The comment one write puts on the advisory.
 *
 * @typedef {object} PreparedWrite
 * @property {string} body The comment's markdown.
 * @property {readonly string[]} expected Text the response must render in one
 *   comment for the write to count as done.
 * @property {string} [commentId] The comment this replaces the body of. A
 *   prepared write naming none creates a comment.
 */

/**
 * How one surface holds an advisory while its write is on its way to GitHub.
 * The lifetime is the surface's own: a write whose result GitHub does not show
 * is not one the surface can offer again, and a write that settles is.
 *
 * @typedef {object} WriteHold
 * @property {(key: string) => WriteResult | null} [held] What refuses a write
 *   on an advisory this surface is already writing to, and null where it is
 *   not.
 * @property {(key: string) => void} [take] Called before anything is awaited.
 * @property {(key: string) => void} [sent] Called once the request is built and
 *   before it goes out.
 * @property {(key: string, settled: { sent: boolean, outcome: WriteResult |
 *   null }) => void} [release] Called once, whatever happened. `sent` says
 *   whether a request left this extension.
 */

/**
 * @typedef {object} RunWriteOptions
 * @property {import('./parse-detail.js').AdvisoryRef | null} ref The advisory
 *   to write on, as the surface read it.
 * @property {{ reason: string, message: string }} [unreadable] What refuses a
 *   write on a page that did not say which advisory it is. Each surface has its
 *   own wording, so each supplies it; a caller whose reference cannot be null
 *   supplies none.
 * @property {(run: WriteRun) => PreparedWrite | WriteResult |
 *   Promise<PreparedWrite | WriteResult>} prepare What the comment says, built
 *   against the page this write read. Everything one surface checks that
 *   another does not belongs here, and a refusal it returns is the write's
 *   result.
 * @property {WriteHold} [hold]
 * @property {() => number} [now] The clock `readAt` is taken from.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 * @property {() => void} [beforeSend] Called once the request is built and
 *   before it goes out.
 */

(() => {
  /** How every reader here squares up the text a page carries. */
  const collapse = globalThis.bghsa.text.collapse;

  /**
   * @param {Element} field
   * @returns {string} the value the browser would submit for `field`. The live
   *   property is read where the host offers one, because GitHub fills some
   *   fields after the server rendered them.
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
   * @returns {string[]} the values a submission carries for a `select`.
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

  /** Input types a form submission never carries a value for. */
  const SKIPPED_INPUT_TYPES = ['submit', 'reset', 'button', 'image', 'file'];

  /**
   * Every name and value a submission of `form` carries, in document order.
   * Submit buttons are left out: a submission carries only the button that was
   * pressed, and the caller names that one.
   *
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
   * A copy of what submitting `form` sends. Neither `required_field_XXXX`, which
   * is randomized per render, nor `timestamp_secret`, which is signed, can be
   * constructed, so the write carries the rendered form's own fields and changes
   * only the one field it means to change.
   *
   * The advisory comment forms carry no `enctype`, so a submission of one is
   * `application/x-www-form-urlencoded`, which is what these parameters are.
   *
   * @param {Element} form
   * @returns {URLSearchParams}
   */
  function cloneForm(form) {
    const params = new URLSearchParams();
    for (const [name, value] of formEntries(form)) params.append(name, value);
    return params;
  }

  /**
   * The form that creates a comment on the advisory: the one whose action path
   * ends in `/comments`. An edit form's action ends in the comment's id.
   *
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
   * The path the create-comment form of one advisory posts to.
   *
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @returns {string}
   */
  function commentPath(ref) {
    return `/${ref.owner}/${ref.repo}/security/advisories/${ref.ghsaId}/comments`;
  }

  /**
   * The path the form that edits one comment posts to.
   *
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @param {string} commentId
   * @returns {string}
   */
  function editPath(ref, commentId) {
    return `${commentPath(ref)}/${commentId}`;
  }

  /**
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @returns {string} the key one advisory's write is held under while it is on
   *   its way to GitHub.
   */
  function holdKey(ref) {
    // Lowercased, because the allowlist and the reference check read a
    // reference case-insensitively and two spellings of one advisory are one
    // advisory.
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
   * Whether a form action posts to the advisory the reference names. The
   * allowlist gates on the reference read from the page, so the request target
   * carries the same owner, repository, and advisory id, on `github.com`, and
   * names no credentials. An action this cannot resolve to that one path is
   * refused.
   *
   * @param {string} action
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @param {string} [commentId] The comment the action has to name. Without it
   *   the action has to name the advisory's comment collection.
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
   * The form that edits one comment. GitHub renders it into the document before
   * any menu is opened, so it is in a page this extension fetched and never
   * displayed.
   *
   * Its presence says nothing about who wrote the comment: a maintainer with
   * write access on the repository gets an edit form for everyone's comments.
   * The caller decides whose comment it may post.
   *
   * @param {Document} root
   * @param {string} commentId
   * @returns {Element | null}
   */
  function findEditForm(root, commentId) {
    return root.querySelector(`form[id="advisory-comment-${commentId}-edit-form"]`);
  }

  /** Elements whose text a reader of the page never sees as comment content. */
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

  /** The elements GitHub renders a comment's markdown into. */
  const COMMENT_BODY = '.comment-body, .js-comment-body, .markdown-body';

  /**
   * The text of `node` as a reader sees it: the content of a form field is the
   * value of a control, not rendered comment content, and is left out.
   *
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
   * Whether `doc` renders one comment holding every one of `expected`. Both
   * roots are read: a document parsed from a fragment carries its content
   * under the document element and leaves the body empty.
   *
   * A response that echoes a rejected body back into the comment box holds what
   * was written as the value of a control, and an advisory whose own description
   * quotes one of these strings holds it somewhere else on the page. One
   * rendered comment carrying all of them is the write.
   *
   * @param {Document} doc
   * @param {readonly string[]} expected
   * @returns {boolean}
   */
  function commentContains(doc, expected) {
    return inspectComments(doc, expected).expectedContentFound;
  }

  /**
   * Uses the same response checks for save confirmation and diagnostics.
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
   * The body of a comment this extension writes: one collapsed block holding a
   * marker and then whatever the caller puts under it.
   *
   * The marker is a code span immediately under the summary, which is what says
   * whose comment this is whatever the rest of the body holds, and no text
   * below it can render above it.
   *
   * The block's own tags each stand on a line with a blank line between them
   * and what they wrap, which is the shape the summary's link is known to
   * render in.
   *
   * @param {string} summary The summary line, which is prose for the reader.
   * @param {string} marker What says the comment is this extension's.
   * @param {readonly string[]} lines What the block holds under the marker.
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
   * What a surface says while a write it started is on its way to GitHub. It is
   * the state of the controls that write came from, which are held still until
   * it settles, and the panel and the done view read it from here so one event
   * reads the same however it was started.
   */
  const SAVING_MESSAGE = 'Saving...';

  /**
   * What refuses a write whose re-read of the advisory page did not arrive.
   * What GitHub answered, or what the read threw, goes to the console.
   */
  const REFRESH_MESSAGE = 'Error: failed to refresh advisory data';

  /** What reports a write GitHub refused or never answered. */
  const FAILED_MESSAGE = 'Error: failed to save';

  /**
   * What reports a write GitHub took whose result could not be read back. The
   * comment may or may not be there.
   */
  const UNCONFIRMED_MESSAGE = 'Error: failed to validate save';

  /** What refuses a write the page carries no form to send. */
  const NO_FORM_MESSAGE = 'Error: cannot post';

  /**
   * What refuses a write this build cannot make safely: a snapshot naming a
   * schema version it does not read, and a clear that would take away a field
   * inside one it does not recognize. Both mean the maintainer is behind the
   * extension that wrote the advisory's state.
   */
  const OUTDATED_MESSAGE = 'Error: update the extension';

  /**
   * What refuses a write another maintainer's save got in front of, whether the
   * sequence number moved or a rival claim on the same one won the tie-break.
   * The surface that pressed Save holds its changes, and neither case is one a
   * maintainer acts on differently.
   */
  const STALE_MESSAGE = 'Error: concurrent edits';

  /**
   * What refuses a write on a page this extension could not parse. The owner,
   * the repository and the GHSA identifier come out of a detail page together,
   * so a page that yields none of them names no advisory to write on, and one
   * whose title and description did not read holds nothing to write.
   */
  const PARSE_MESSAGE = 'Error: failed to parse advisory';

  /**
   * What refuses a write over a fault inside this extension: a comment body with
   * nothing in it, a write with nothing to confirm it by, and a snapshot this
   * extension's own reader would not read back. What is wrong with it goes to
   * the console, because none of it is something a maintainer can act on.
   */
  const INVALID_STATE_MESSAGE = 'Error: cannot save invalid state';

  /**
   * @param {string} nameWithOwner
   * @returns {string} what refuses a write on that repository. Three write
   *   paths check the allowlist and all three say this.
   */
  function allowlistMessage(nameWithOwner) {
    return `Error: ${nameWithOwner} is not on this extension's allowlist.`;
  }

  /**
   * What refuses a write whose page turned out to be another advisory than the
   * one it was asked for. The comment would have gone onto the wrong page.
   */
  const MISMATCH_MESSAGE = 'Error: unexpected response';

  /**
   * What refuses a write whose comment form posts somewhere other than the
   * advisory it was asked for.
   */
  const COMMENT_FORM_MESSAGE = 'Error: unexpected comment form destination';

  /**
   * What refuses a write whose edit form posts somewhere other than the comment
   * it was asked for. This is the path a save takes once a state comment
   * already exists, which is the usual one.
   */
  const EDIT_FORM_MESSAGE = 'Error: unexpected edit form destination';

  /**
   * What refuses a write whose edit form does not carry the fields the request
   * is cloned from. GitHub randomizes some field names and signs others, so a
   * missing one means the post would be rejected. Which ones are missing goes
   * to the console.
   */
  const EDIT_FIELDS_MESSAGE = 'Error: unexpected edit form fields';

  /**
   * The detail a refusal no longer carries. The message a maintainer reads names
   * what failed; what GitHub said about it is here.
   *
   * @param {string} what
   * @param {unknown} [detail]
   * @returns {void}
   */
  function log(what, detail) {
    if (detail === undefined) console.warn(`[better-ghsa] ${what}`);
    else console.warn(`[better-ghsa] ${what}`, detail);
  }

  /**
   * The advisory detail page a write reads before it builds anything.
   *
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @returns {string}
   */
  function detailUrl(ref) {
    return `/${ref.owner}/${ref.repo}/security/advisories/${ref.ghsaId}`;
  }

  /** How that page is asked for. */
  const DETAIL_INIT = /** @type {RequestInit} */ ({
    method: 'GET',
    credentials: 'same-origin',
    redirect: 'follow',
    cache: 'no-store',
    headers: { Accept: 'text/html' },
  });

  /**
   * Reads the advisory page the rest of a write runs against: the state it
   * merges, the form it clones, and the text it writes all come from this one
   * document, fetched at the moment the write was asked for.
   *
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @param {{ fetch?: WriteFetch, parseDocument?: (html: string) => Document }} options
   * @returns {Promise<{ page: Document | null, failure: WriteResult | null }>}
   *   exactly one of the two.
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

  /** The field an edit carries the comment's new markdown in. */
  const EDIT_BODY_FIELD = 'repository_advisory_comment[body]';

  /**
   * Fields an edit form has to carry for the request to be one this extension
   * will send. `authenticity_token` is what authorizes the POST, and
   * `repository_advisory_comment[bodyVersion]` is GitHub's optimistic
   * concurrency token for the comment body: without it, an edit would overwrite
   * a body that changed between the fetch and the POST.
   *
   * @type {readonly string[]}
   */
  const REQUIRED_EDIT_FIELDS = [
    'authenticity_token',
    'repository_advisory_comment[bodyVersion]',
    EDIT_BODY_FIELD,
  ];

  /**
   * What refuses a write before any request is built: a repository this
   * extension does not write to, a comment with nothing in it, and a write whose
   * result could not be recognized in GitHub's answer.
   *
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @param {string} body
   * @param {readonly string[]} expected
   * @returns {WriteResult | null} null when nothing refuses the write.
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
   * Sends one built request and reads GitHub's answer. A write whose result
   * cannot be confirmed is reported as failed, because the comment it would
   * leave is permanent and visible to the reporter.
   *
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
    // A write that landed says nothing here. Every surface that starts one has
    // its own words for what it just wrote, and a message set here would be
    // overwritten by all of them or displayed by none.
    return result(true, null, status, '');
  }

  /**
   * Creates one comment on the advisory the document shows.
   *
   * The repository is checked before anything else, so a repository off the
   * allowlist never reaches a request.
   *
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
    // The action the Comment button performs. It carries `disabled` while the
    // comment field is empty, which is the state of the page under the panel.
    const submit = form.querySelector('button[type="submit"][name="comment"]');
    if (submit !== null) params.set('comment', submit.getAttribute('value') ?? '1');

    return postForm(action, params, expected, options);
  }

  /**
   * Replaces the body of one comment on the advisory the document shows.
   *
   * The clone carries the form's own fields untouched and changes one: the
   * randomized `required_field_XXXX` and the signed `timestamp_secret` cannot be
   * constructed, and `repository_advisory_comment[bodyVersion]` is what makes
   * GitHub reject an edit whose comment changed after the fetch.
   *
   * Which comment this may post to is the caller's decision. The form for
   * another maintainer's comment is in the page too, and posting it would
   * overwrite what that maintainer wrote.
   *
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
   * Writes one comment on one advisory, from the first check to the answer.
   *
   * The order the earliest checks run in is settled here for every surface. The
   * reference comes first, because a page that did not say which advisory it is
   * names no repository to test, and the allowlist comes second, so a
   * repository this extension does not write to never reaches a request.
   *
   * The whole write then runs against a document fetched at the moment it was
   * asked for: the form the request clones and everything the comment says come
   * from that one page. The reference that page carries has to be the one the
   * write was asked for, and it is tested against the allowlist again, so a page
   * that turned out to be somewhere else stops the write before the body is
   * built.
   *
   * What the comment says, and every check one surface makes that another does
   * not, is `prepare`'s. So is the choice between creating a comment and
   * replacing the body of one.
   *
   * @param {RunWriteOptions} options
   * @returns {Promise<{ outcome: WriteResult, run: WriteRun | null }>} what
   *   happened, and the page it ran against where it read one.
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
    // Taken before anything is awaited, so a second press has something to land
    // on. What releasing it means is the surface's own.
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
      // Read before the request goes out, because it is when the page this
      // write reads was read.
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
