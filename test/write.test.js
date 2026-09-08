'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const write = require('../src/common/write.js');

const allowlist = require('../src/common/allowlist.js');

// The list of repositories the extension acts on is stored rather than compiled
// in, and is empty on a fresh install. The fixtures here are that repository's,
// so the list is put in place and read before the first test, which is what the
// extension itself does before it takes a page.
test.before(async () => {
  allowlist.setStorage({
    get: async () => ({ [allowlist.STORAGE_KEY]: ['git-utensils/spoon-knife'] }),
    set: async () => {},
  });
  await allowlist.load();
});

/**
 * @param {string} name
 * @returns {Document}
 */
function fixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

/**
 * @param {string} markup
 * @returns {Document}
 */
function document(markup) {
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(markup).document));
}

/** The advisory the fixtures come from, which is on the allowlist. */
const REF = { owner: 'git-utensils', repo: 'Spoon-Knife', ghsaId: 'GHSA-jmvx-2wfw-xfgj' };

/** The one parse of each large fixture in this file. */
const triageDoc = fixture('triage-thread.html');
const editDoc = fixture('edit-form.html');

/**
 * @param {Document} doc
 * @param {string} selector
 * @returns {Element} the one element `selector` names.
 */
function one(doc, selector) {
  const found = doc.querySelector(selector);
  if (found === null) throw new Error(`no element matching ${selector}`);
  return found;
}

/**
 * @param {URLSearchParams} params
 * @returns {string[]} the field names, in order, with repeats kept.
 */
function names(params) {
  return Array.from(params.keys());
}

/**
 * A stand-in for `fetch` that answers with what the test hands it and records
 * the one call it was given.
 *
 * @param {number} status
 * @param {string} body
 * @returns {{ send: import('../src/common/write.js').WriteFetch, calls: Array<{ url: string, init: RequestInit }> }}
 */
function fakeFetch(status, body) {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  return {
    calls,
    send: async (url, init) => {
      calls.push({ url, init });
      return { status, text: async () => body };
    },
  };
}

/** A response document holding the comment that was written. */
const WROTE = '<!doctype html><html><body><div class="comment-body">' +
  '<details><summary>Original report preserved by Better GHSA</summary>' +
  '<p>Path traversal in drawer handler</p></details></div></body></html>';

/** A response document holding no such comment. */
const WROTE_NOTHING = '<!doctype html><html><body><div>Something went wrong.</div></body></html>';

/**
 * @param {Partial<import('../src/common/write.js').CreateCommentOptions>} overrides
 * @returns {import('../src/common/write.js').CreateCommentOptions}
 */
function options(overrides) {
  return {
    doc: triageDoc,
    ref: REF,
    body: 'a comment',
    expected: ['Original report preserved by Better GHSA'],
    parseDocument: document,
    ...overrides,
  };
}

test('the create form is the one whose action path ends in /comments', () => {
  const form = write.findCommentForm(triageDoc);
  assert.ok(form !== null, 'the triage thread carries no create-comment form');
  assert.strictEqual(
    /** @type {Element} */ (form).getAttribute('action'),
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments'
  );
  assert.strictEqual(
    /** @type {Element} */ (form).getAttribute('class'),
    'js-advisory-comment-form'
  );
});

test('an edit form is not taken for the create form', () => {
  assert.ok(write.findCommentForm(editDoc) === null, 'an edit form was taken for the create form');
});

test('the clone of an edit form carries every field the server signed', () => {
  const params = write.cloneForm(one(editDoc, 'form#advisory-comment-282847-edit-form'));
  const carried = names(params);
  for (const field of [
    '_method',
    'authenticity_token',
    'context',
    'timestamp',
    'timestamp_secret',
    'repository_advisory_comment[id]',
    'repository_advisory_comment[bodyVersion]',
    'repository_advisory_comment[body]',
    'comment_id',
  ]) {
    assert.ok(carried.includes(field), `the clone dropped ${field}`);
  }
  const required = carried.filter((name) => name.startsWith('required_field_'));
  assert.strictEqual(required.length, 1);
  assert.strictEqual(required[0], 'required_field_9231');
  assert.strictEqual(params.get('_method'), 'put');
});

test('a disabled field, and a field inside a template, are not submitted', () => {
  const doc = document(
    '<!doctype html><html><body><form action="/o/r/security/advisories/G/comments">' +
      '<input type="hidden" name="kept" value="1">' +
      '<input type="hidden" name="off" value="1" disabled>' +
      '<template><input type="hidden" name="inert" value="1"></template>' +
      '<input type="checkbox" name="unchecked" value="y">' +
      '<input type="checkbox" name="checked" value="y" checked>' +
      '</form></body></html>'
  );
  const params = write.cloneForm(one(doc, 'form'));
  assert.deepStrictEqual(names(params), ['kept', 'checked']);
  assert.strictEqual(params.get('checked'), 'y');
});

test('what a page renders in a comment is what confirms a write', () => {
  assert.strictEqual(write.commentContains(triageDoc, ['Better GHSA tracking state']), true);
  assert.strictEqual(
    write.commentContains(triageDoc, ['Original report preserved by Better GHSA']),
    false
  );
  assert.strictEqual(write.commentContains(triageDoc, []), false);
});

test('a body echoed back into the comment box does not confirm a write', () => {
  const echoed = document(
    '<!doctype html><html><body>' +
      '<div class="comment-body markdown-body js-comment-body">' +
      '<form action="/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments">' +
      '<textarea name="body">Original report preserved by Better GHSA and both notes</textarea>' +
      '</form></div></body></html>'
  );
  assert.ok(
    write.commentContains(echoed, ['Original report preserved by Better GHSA']) === false,
    'a body echoed into the comment box confirmed a write'
  );
});

test('the strings a write put in one comment must come back in one comment', () => {
  const scattered = document(
    '<!doctype html><html><body>' +
      '<div class="comment-body">Original report preserved by Better GHSA</div>' +
      '<div class="comment-body">The title below is the advisory title.</div>' +
      '</body></html>'
  );
  const together = document(
    '<!doctype html><html><body><div class="comment-body">' +
      'Original report preserved by Better GHSA. The title below is the advisory title.' +
      '</div></body></html>'
  );
  const expected = [
    'Original report preserved by Better GHSA',
    'The title below is the advisory title.',
  ];
  assert.strictEqual(write.commentContains(scattered, expected), false);
  assert.strictEqual(write.commentContains(together, expected), true);
});

test('a form action names the advisory the reference names', () => {
  assert.strictEqual(
    write.commentPath(REF),
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments'
  );
  for (const action of [
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments',
    'https://github.com/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments',
    '/GIT-UTENSILS/spoon-knife/security/advisories/GHSA-JMVX-2WFW-XFGJ/comments',
  ]) {
    assert.strictEqual(write.actionMatchesRef(action, REF), true, action);
  }
  for (const action of [
    '/someone/else/security/advisories/GHSA-jmvx-2wfw-xfgj/comments',
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-0000-0000-0000/comments',
    'https://example.invalid/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments',
    // Credentials in the action, which `origin` does not carry.
    'https://user:pass@github.com/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments',
    'https://evil@github.com/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments',
    'comments',
    '',
  ]) {
    assert.strictEqual(write.actionMatchesRef(action, REF), false, action);
  }
});

test('a comment form posting to another advisory is not written to', async () => {
  const elsewhere = document(
    '<!doctype html><html><body>' +
      '<form action="/someone/else/security/advisories/GHSA-0000-0000-0000/comments">' +
      '<input type="hidden" name="authenticity_token" value="t">' +
      '<textarea name="body"></textarea></form></body></html>'
  );
  const fake = fakeFetch(200, WROTE);
  const outcome = await write.createComment(options({ doc: elsewhere, fetch: fake.send }));
  assert.ok(outcome.ok === false, 'the write went to a form naming another advisory');
  assert.strictEqual(outcome.reason, 'mismatch');
  assert.strictEqual(fake.calls.length, 0, 'a request went out');
  assert.strictEqual(outcome.message, 'Error: unexpected comment form destination');
});

test('the caller is told the request is going out before the answer is awaited', async () => {
  /** @type {string[]} */
  const order = [];
  const outcome = await write.createComment(
    options({
      beforeSend: () => order.push('held'),
      fetch: async () => {
        order.push('sent');
        return { status: 200, text: async () => WROTE };
      },
    })
  );
  assert.strictEqual(outcome.ok, true);
  assert.deepStrictEqual(order, ['held', 'sent']);
});

test('a write GitHub answered with the whole advisory page is confirmed', async () => {
  const answer = fs.readFileSync(
    path.join(__dirname, '..', 'testdata', 'triage-thread.html'),
    'utf8'
  );
  const fake = fakeFetch(200, answer);
  const outcome = await write.createComment(
    options({ expected: ['Better GHSA tracking state'], fetch: fake.send })
  );
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.status, 200);
});

test('a repository off the allowlist is refused before a request is built', async () => {
  const fake = fakeFetch(200, WROTE);
  const outcome = await write.createComment(
    options({
      ref: { owner: 'someone', repo: 'else', ghsaId: 'GHSA-0000-0000-0000' },
      fetch: fake.send,
    })
  );
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'allowlist');
  assert.strictEqual(fake.calls.length, 0);
  assert.strictEqual(
    outcome.message,
    "Error: someone/else is not on this extension's allowlist."
  );
});

test('a write posts the cloned form, with the body replaced, to the form action', async () => {
  const fake = fakeFetch(200, WROTE);
  const outcome = await write.createComment(
    options({ body: 'the comment this extension writes', fetch: fake.send })
  );
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.reason, null);
  assert.strictEqual(outcome.status, 200);
  assert.strictEqual(outcome.message, '', 'a landed write carried words of its own');
  assert.strictEqual(fake.calls.length, 1);

  const call = /** @type {{ url: string, init: RequestInit }} */ (fake.calls[0]);
  assert.strictEqual(
    call.url,
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments'
  );
  assert.strictEqual(call.init.method, 'POST');
  assert.strictEqual(call.init.credentials, 'same-origin');

  const sent = /** @type {URLSearchParams} */ (/** @type {unknown} */ (call.init.body));
  assert.ok(sent instanceof URLSearchParams, 'the write did not send form parameters');
  assert.strictEqual(sent.get('body'), 'the comment this extension writes');
  assert.ok(sent.has('authenticity_token'), 'the write dropped the authenticity token');
  assert.strictEqual(sent.get('comment'), '1');
  assert.ok(!sent.has('comment_and_close'), 'the write carried the close action');
});

test('a non-2xx answer is a failed write', async () => {
  for (const status of [302, 403, 422, 500]) {
    const fake = fakeFetch(status, WROTE);
    const outcome = await write.createComment(options({ fetch: fake.send }));
    assert.strictEqual(outcome.ok, false, `status ${status}`);
    assert.strictEqual(outcome.reason, 'status', `status ${status}`);
    assert.strictEqual(outcome.status, status);
    assert.strictEqual(outcome.message, 'Error: failed to save');
  }
});

test('a 2xx answer without the comment is a failed write', async () => {
  const fake = fakeFetch(200, WROTE_NOTHING);
  const outcome = await write.createComment(options({ fetch: fake.send }));
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'unwritten');
  assert.strictEqual(outcome.status, 200);
  assert.strictEqual(
    outcome.message,
    'Error: failed to validate save'
  );
});

test('a request that never arrived is a failed write', async () => {
  const outcome = await write.createComment(
    options({
      fetch: async () => {
        throw new TypeError('NetworkError');
      },
    })
  );
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'unreachable');
  assert.strictEqual(outcome.status, null);
});

test('a page carrying no comment form is not written to', async () => {
  const fake = fakeFetch(200, WROTE);
  const outcome = await write.createComment(options({ doc: editDoc, fetch: fake.send }));
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'no-form');
  assert.strictEqual(fake.calls.length, 0);
});

test('a write this extension could not confirm is not sent', async () => {
  const fake = fakeFetch(200, WROTE);
  const empty = await write.createComment(options({ body: '  ', fetch: fake.send }));
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.reason, 'unverifiable');
  assert.strictEqual(empty.message, 'Error: cannot save invalid state');
  const blind = await write.createComment(options({ expected: [''], fetch: fake.send }));
  assert.strictEqual(blind.ok, false);
  assert.strictEqual(blind.reason, 'unverifiable');
  assert.strictEqual(blind.message, 'Error: cannot save invalid state');
  assert.strictEqual(fake.calls.length, 0);
});

/** The id of the comment the captured edit form belongs to. */
const EDIT_ID = '282847';

/** The edit form as GitHub rendered it, by field name. */
const EDIT_FIELDS = [
  '_method',
  'authenticity_token',
  'context',
  'required_field_9231',
  'timestamp',
  'timestamp_secret',
  'repository_advisory_comment[id]',
  'repository_advisory_comment[bodyVersion]',
  'repository_advisory_comment[body]',
  'comment_id',
];

/** A response document holding the edited comment. */
const EDITED =
  '<!doctype html><html><body><div class="comment-body">' +
  '<details><summary>Better GHSA tracking state</summary>' +
  '<p><code>better-ghsa:state:1:</code></p></details></div></body></html>';

/**
 * @param {Partial<import('../src/common/write.js').EditCommentOptions>} overrides
 * @returns {import('../src/common/write.js').EditCommentOptions}
 */
function editOptions(overrides) {
  return {
    doc: editDoc,
    ref: REF,
    commentId: EDIT_ID,
    body: 'the snapshot this extension writes',
    expected: ['better-ghsa:state:1:'],
    parseDocument: document,
    ...overrides,
  };
}

/**
 * @param {string} action
 * @param {string} fields
 * @returns {Document} a page carrying one edit form for {@link EDIT_ID}.
 */
function editPage(action, fields) {
  return document(
    `<!doctype html><html><body><form id="advisory-comment-${EDIT_ID}-edit-form"` +
      ` action="${action}">${fields}</form></body></html>`
  );
}

/** The fields an edit form has to carry, as markup. */
const EDIT_TOKENS =
  '<input type="hidden" name="authenticity_token" value="t">' +
  '<input type="hidden" name="repository_advisory_comment[bodyVersion]" value="v">' +
  '<textarea name="repository_advisory_comment[body]"></textarea>';

test('the edit form for one comment is found by its id', () => {
  assert.ok(write.findEditForm(editDoc, EDIT_ID) !== null, 'the capture carries no edit form');
  assert.ok(
    write.findEditForm(triageDoc, EDIT_ID) !== null,
    'the advisory page carries no edit form for that comment'
  );
  assert.ok(
    write.findEditForm(triageDoc, '999999') === null,
    'an edit form was found for a comment that is not on the page'
  );
});

test('an edit action names the one comment the caller chose', () => {
  assert.strictEqual(
    write.editPath(REF, EDIT_ID),
    `/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/${EDIT_ID}`
  );
  for (const action of [
    `/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/${EDIT_ID}`,
    `https://github.com/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/${EDIT_ID}`,
  ]) {
    assert.strictEqual(write.actionMatchesRef(action, REF, EDIT_ID), true, action);
  }
  for (const action of [
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/282848',
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments',
    `/someone/else/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/${EDIT_ID}`,
    `https://example.invalid/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/${EDIT_ID}`,
    `https://user:pass@github.com/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/${EDIT_ID}`,
  ]) {
    assert.strictEqual(write.actionMatchesRef(action, REF, EDIT_ID), false, action);
  }
});

test('an edit sends the cloned form with the body the only field changed', async () => {
  const form = one(editDoc, `form[id="advisory-comment-${EDIT_ID}-edit-form"]`);
  const rendered = write.cloneForm(form);
  assert.deepStrictEqual(names(rendered), EDIT_FIELDS);

  const fake = fakeFetch(200, EDITED);
  const outcome = await write.editComment(editOptions({ fetch: fake.send }));
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.status, 200);
  assert.strictEqual(fake.calls.length, 1);

  const call = /** @type {{ url: string, init: RequestInit }} */ (fake.calls[0]);
  assert.strictEqual(
    call.url,
    `/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/${EDIT_ID}`
  );
  assert.strictEqual(call.init.method, 'POST');
  assert.strictEqual(call.init.credentials, 'same-origin');

  const sent = /** @type {URLSearchParams} */ (/** @type {unknown} */ (call.init.body));
  assert.ok(sent instanceof URLSearchParams, 'the edit did not send form parameters');
  assert.deepStrictEqual(names(sent), EDIT_FIELDS);
  for (const field of EDIT_FIELDS) {
    if (field === write.EDIT_BODY_FIELD) continue;
    assert.ok(
      sent.get(field) === rendered.get(field),
      `the edit changed ${field} on its way out of the page`
    );
  }
  assert.ok(
    sent.get(write.EDIT_BODY_FIELD) === 'the snapshot this extension writes',
    'the edit did not carry the new body'
  );
});

test('an edit form posting to another comment is not written to', async () => {
  const elsewhere = editPage(
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/282848',
    EDIT_TOKENS
  );
  const fake = fakeFetch(200, EDITED);
  const outcome = await write.editComment(editOptions({ doc: elsewhere, fetch: fake.send }));
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'mismatch');
  assert.strictEqual(fake.calls.length, 0, 'a request went out');
  assert.strictEqual(outcome.message, 'Error: unexpected edit form destination');
});

test('a page carrying no edit form for that comment is not edited', async () => {
  const fake = fakeFetch(200, EDITED);
  const outcome = await write.editComment(
    editOptions({ doc: triageDoc, commentId: '999999', fetch: fake.send })
  );
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'no-form');
  assert.strictEqual(fake.calls.length, 0);
  assert.strictEqual(
    outcome.message,
    'Error: cannot post'
  );
});

test('an edit form carrying no concurrency token is not sent', async () => {
  const action = `/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/${EDIT_ID}`;
  const stripped = editPage(
    action,
    '<input type="hidden" name="authenticity_token" value="t">' +
      '<textarea name="repository_advisory_comment[body]"></textarea>'
  );
  const fake = fakeFetch(200, EDITED);
  const outcome = await write.editComment(editOptions({ doc: stripped, fetch: fake.send }));
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'no-token');
  assert.strictEqual(fake.calls.length, 0, 'a request went out');
  assert.strictEqual(outcome.message, 'Error: unexpected edit form fields');
  const whole = editPage(action, EDIT_TOKENS);
  const second = await write.editComment(editOptions({ doc: whole, fetch: fake.send }));
  assert.strictEqual(second.ok, true);
});

test('the page a write runs against is fetched from the advisory URL', async () => {
  assert.strictEqual(
    write.detailUrl(REF),
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj'
  );
  const fake = fakeFetch(200, '<!doctype html><html><body><p id="here">read</p></body></html>');
  const fetched = await write.fetchAdvisoryPage(REF, {
    fetch: fake.send,
    parseDocument: document,
  });
  assert.strictEqual(fetched.failure, null);
  assert.ok(fetched.page !== null, 'the fetch produced no page');
  assert.strictEqual(
    /** @type {Document} */ (fetched.page).querySelector('#here')?.textContent,
    'read'
  );
  const call = /** @type {{ url: string, init: RequestInit }} */ (fake.calls[0]);
  assert.strictEqual(call.url, '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj');
  assert.strictEqual(call.init.method, 'GET');
  assert.strictEqual(call.init.credentials, 'same-origin');
  assert.strictEqual(call.init.cache, 'no-store');
});

test('a page the write could not read produces a failure and no page', async () => {
  const refused = await write.fetchAdvisoryPage(REF, {
    fetch: fakeFetch(404, '').send,
    parseDocument: document,
  });
  assert.strictEqual(refused.page, null);
  assert.strictEqual(refused.failure?.reason, 'fetch');
  assert.strictEqual(refused.failure?.status, 404);
  assert.strictEqual(
    refused.failure?.message,
    'Error: failed to refresh advisory data'
  );

  const unreachable = await write.fetchAdvisoryPage(REF, {
    fetch: async () => {
      throw new TypeError('NetworkError');
    },
    parseDocument: document,
  });
  assert.strictEqual(unreachable.page, null);
  assert.strictEqual(unreachable.failure?.reason, 'fetch');
  assert.strictEqual(unreachable.failure?.status, null);
});

/**
 * An advisory detail page carrying what a write reads from one: the reference,
 * the comment thread, and the form the request clones.
 *
 * @param {object} [options]
 * @param {string} [options.owner]
 * @param {string} [options.repo]
 * @param {string} [options.ghsaId]
 * @returns {string}
 */
function advisoryHtml(options) {
  const settings = options ?? {};
  const owner = settings.owner ?? REF.owner;
  const repo = settings.repo ?? REF.repo;
  const ghsaId = settings.ghsaId ?? REF.ghsaId;
  const detail = `/${owner}/${repo}/security/advisories/${ghsaId}`;
  return [
    '<!doctype html><html><body>',
    '<div class="gh-header-meta"><span class="State">Triage</span>',
    `<span class="user-select-contain">${ghsaId}</span></div>`,
    `<div class="js-socket-channel js-updatable-content" data-url="${detail}/repository_advisory/body">`,
    '<div class="Box"><div class="js-repository-advisory-details">',
    '<div class="Box-header timeline-comment-header"><a class="author" href="/rep">rep</a>',
    '<relative-time datetime="2026-08-01T00:00:00Z"></relative-time>',
    '<span class="js-comment-edit-history"></span></div>',
    '<form><input name="repository_advisory[title]" value="A title">',
    '<textarea name="repository_advisory[description]">A description.</textarea>',
    '</form></div></div></div>',
    `<form action="${detail}/comments">`,
    '<input type="hidden" name="authenticity_token" value="a-token">',
    '<textarea name="body"></textarea>',
    '<button type="submit" name="comment" value="1" disabled>Comment</button>',
    '</form>',
    `<form id="advisory-comment-77-edit-form" action="${detail}/comments/77">`,
    '<input type="hidden" name="authenticity_token" value="a-token">',
    '<input type="hidden" name="repository_advisory_comment[bodyVersion]" value="v1">',
    `<textarea name="${write.EDIT_BODY_FIELD}">held</textarea>`,
    '</form>',
    '</body></html>',
  ].join('\n');
}

/**
 * A stand-in for `fetch` answering the advisory page with `page` and the write
 * with a comment carrying `expected`.
 *
 * @param {object} [options]
 * @param {string} [options.page]
 * @param {string} [options.expected]
 * @param {number} [options.status] The status the write is answered with.
 * @returns {{ send: import('../src/common/write.js').WriteFetch, calls: Array<{ url: string, init: RequestInit }> }}
 */
function exchange(options) {
  const settings = options ?? {};
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  return {
    calls,
    send: async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'GET') {
        return { status: 200, text: async () => settings.page ?? advisoryHtml() };
      }
      return {
        status: settings.status ?? 200,
        text: async () =>
          `<div class="comment-body">${settings.expected ?? 'the expected text'}</div>`,
      };
    },
  };
}

test('one write runs the reference check before the allowlist check', async () => {
  const fake = exchange();
  const { outcome, run } = await write.runWrite({
    ref: null,
    unreadable: { reason: 'unreadable', message: 'Error: no advisory here.' },
    fetch: fake.send,
    parseDocument: document,
    prepare: () => {
      throw new Error('a write with no reference reached its body');
    },
  });
  assert.strictEqual(outcome.reason, 'unreadable');
  assert.strictEqual(outcome.message, 'Error: no advisory here.');
  assert.strictEqual(run, null);
  assert.strictEqual(fake.calls.length, 0, 'a write with no reference asked GitHub for a page');
});

test('a repository off the allowlist never reaches a request', async () => {
  const fake = exchange();
  const { outcome } = await write.runWrite({
    ref: { owner: 'other', repo: 'elsewhere', ghsaId: REF.ghsaId },
    fetch: fake.send,
    parseDocument: document,
    prepare: () => {
      throw new Error('a repository off the allowlist reached its body');
    },
  });
  assert.strictEqual(outcome.reason, 'allowlist');
  assert.strictEqual(outcome.message, write.allowlistMessage('other/elsewhere'));
  assert.strictEqual(fake.calls.length, 0, 'a repository off the allowlist was fetched');
});

test('a page that is another advisory stops the write before the body', async () => {
  const fake = exchange({ page: advisoryHtml({ ghsaId: 'GHSA-0000-0000-0000' }) });
  const { outcome } = await write.runWrite({
    ref: REF,
    fetch: fake.send,
    parseDocument: document,
    prepare: () => {
      throw new Error('another advisory reached the body builder');
    },
  });
  assert.strictEqual(outcome.reason, 'mismatch');
  assert.strictEqual(outcome.message, 'Error: unexpected response');
  assert.strictEqual(fake.calls.filter((call) => call.init.method === 'POST').length, 0);
});

test('the read time is taken before the page is asked for', async () => {
  // REQUIREMENTS.md section 2: content read before a write must never be
  // stored under a timestamp taken after it. The stamp is what the surfaces
  // store the fetched page under, so a stamp taken after the request would
  // date a page to a moment later than it was read, and a change GitHub took
  // in between would read as already seen.
  const fake = exchange({ expected: 'the marker' });
  let clock = 1000;
  const { outcome, run } = await write.runWrite({
    ref: REF,
    // Time passes while the page is on the wire, which is the whole of what
    // this is about: the two moments are only ever equal on a clock that
    // does not move.
    fetch: async (url, init) => {
      if ((init.method ?? 'GET') === 'GET') clock += 60_000;
      return fake.send(url, init);
    },
    parseDocument: document,
    now: () => clock,
    prepare: (context) => {
      assert.strictEqual(context.readAt, 1000, 'the body builder was given the later moment');
      return { body: 'the marker', expected: ['the marker'] };
    },
  });
  assert.strictEqual(outcome.ok, true, outcome.message);
  assert.strictEqual(run?.readAt, 1000, 'the read was stamped after the page came back');
  assert.strictEqual(clock, 61_000, 'the clock did not move while the request was out');
});

test('the hold is taken, marked sent, and released with what happened', async () => {
  /** @type {string[]} */
  const events = [];
  const fake = exchange({ expected: 'the marker' });
  const { outcome, run } = await write.runWrite({
    ref: REF,
    fetch: fake.send,
    parseDocument: document,
    now: () => 1234,
    hold: {
      held: () => null,
      take: (key) => events.push(`take ${key}`),
      sent: (key) => events.push(`sent ${key}`),
      release: (key, settled) =>
        events.push(`release ${key} sent=${settled.sent} ok=${String(settled.outcome?.ok)}`),
    },
    prepare: (context) => {
      events.push(`prepare ${context.ref.ghsaId} at ${context.readAt}`);
      return { body: 'the marker', expected: ['the marker'] };
    },
  });
  assert.strictEqual(outcome.ok, true, outcome.message);
  assert.strictEqual(run?.readAt, 1234);
  assert.deepStrictEqual(events, [
    'take git-utensils/spoon-knife/ghsa-jmvx-2wfw-xfgj',
    'prepare GHSA-jmvx-2wfw-xfgj at 1234',
    'sent git-utensils/spoon-knife/ghsa-jmvx-2wfw-xfgj',
    'release git-utensils/spoon-knife/ghsa-jmvx-2wfw-xfgj sent=true ok=true',
  ]);
});

test('a held advisory refuses the write in the holder words', async () => {
  const fake = exchange();
  const { outcome } = await write.runWrite({
    ref: REF,
    fetch: fake.send,
    parseDocument: document,
    hold: {
      held: () => ({ ok: false, reason: 'in-flight', status: null, message: 'Saving...' }),
      take: () => {
        throw new Error('a held advisory was taken again');
      },
    },
    prepare: () => {
      throw new Error('a held advisory reached its body');
    },
  });
  assert.strictEqual(outcome.reason, 'in-flight');
  assert.strictEqual(fake.calls.length, 0);
});

test('a prepared write that names a comment replaces its body', async () => {
  const fake = exchange({ expected: 'replaced' });
  const { outcome } = await write.runWrite({
    ref: REF,
    fetch: fake.send,
    parseDocument: document,
    prepare: () => ({ body: 'replaced', expected: ['replaced'], commentId: '77' }),
  });
  assert.strictEqual(outcome.ok, true, outcome.message);
  const post = fake.calls.find((call) => call.init.method === 'POST');
  assert.strictEqual(
    post?.url,
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/77'
  );

  const created = exchange({ expected: 'made' });
  const { outcome: madeOutcome } = await write.runWrite({
    ref: REF,
    fetch: created.send,
    parseDocument: document,
    prepare: () => ({ body: 'made', expected: ['made'] }),
  });
  assert.strictEqual(madeOutcome.ok, true, madeOutcome.message);
  assert.strictEqual(
    created.calls.find((call) => call.init.method === 'POST')?.url,
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments'
  );
});

test('a refusal from the body builder is the write result', async () => {
  const fake = exchange();
  const { outcome, run } = await write.runWrite({
    ref: REF,
    fetch: fake.send,
    parseDocument: document,
    prepare: () => ({ ok: false, reason: 'stale', status: null, message: 'Error: concurrent edits' }),
  });
  assert.strictEqual(outcome.reason, 'stale');
  assert.strictEqual(outcome.message, 'Error: concurrent edits');
  assert.ok(run !== null, 'the write read no page');
  assert.strictEqual(fake.calls.filter((call) => call.init.method === 'POST').length, 0);
});

test('the hold is released on every path that sends nothing', async () => {
  // A hold that outlives the write it was taken for makes that advisory
  // unwritable for the life of the page, and the maintainer's only recovery is
  // a reload they have no reason to try. The write settles in four ways
  // without a request going out, and each of them has to hand the hold back
  // saying nothing was sent.
  /**
   * @param {object} settings
   * @param {import('../src/common/write.js').WriteFetch} settings.fetch
   * @param {import('../src/common/write.js').RunWriteOptions['prepare']} settings.prepare
   * @returns {Promise<{ events: string[], outcome: import('../src/common/write.js').WriteResult | null }>}
   */
  async function held(settings) {
    /** @type {string[]} */
    const events = [];
    /** @type {import('../src/common/write.js').WriteResult | null} */
    let settled = null;
    const run = write.runWrite({
      ref: REF,
      fetch: settings.fetch,
      parseDocument: document,
      hold: {
        held: () => null,
        take: (key) => events.push(`take ${key}`),
        sent: (key) => events.push(`sent ${key}`),
        release: (key, done) => {
          settled = done.outcome;
          events.push(`release ${key} sent=${done.sent}`);
        },
      },
      prepare: settings.prepare,
    });
    try {
      await run;
    } catch {
      events.push('threw');
    }
    return { events, outcome: settled };
  }

  const key = write.holdKey(REF);

  const unreachable = await held({
    fetch: async () => {
      throw new Error('the network is down');
    },
    prepare: () => {
      throw new Error('a page that never arrived reached the body builder');
    },
  });
  assert.deepStrictEqual(unreachable.events, [`take ${key}`, `release ${key} sent=false`]);
  assert.strictEqual(unreachable.outcome?.reason, 'fetch');

  const elsewhere = await held({
    fetch: exchange({ page: advisoryHtml({ ghsaId: 'GHSA-0000-0000-0000' }) }).send,
    prepare: () => {
      throw new Error('another advisory reached the body builder');
    },
  });
  assert.deepStrictEqual(elsewhere.events, [`take ${key}`, `release ${key} sent=false`]);
  assert.strictEqual(elsewhere.outcome?.reason, 'mismatch');

  const refused = await held({
    fetch: exchange().send,
    prepare: () => ({ ok: false, reason: 'stale', status: null, message: 'Error: concurrent edits' }),
  });
  assert.deepStrictEqual(refused.events, [`take ${key}`, `release ${key} sent=false`]);
  assert.strictEqual(refused.outcome?.reason, 'stale');

  // A body builder that throws is a defect in this extension, and it still
  // leaves the advisory writable.
  const threw = await held({
    fetch: exchange().send,
    prepare: () => {
      throw new Error('the body builder is broken');
    },
  });
  assert.deepStrictEqual(threw.events, [`take ${key}`, `release ${key} sent=false`, 'threw']);
  assert.strictEqual(threw.outcome, null);
});
