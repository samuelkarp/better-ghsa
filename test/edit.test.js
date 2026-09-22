'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');
const merge = require('../src/common/merge.js');
const schema = require('../src/common/schema.js');
const derive = require('../src/common/derive.js');
const write = require('../src/common/write.js');
const tracking = require('../src/detail/tracking.js');
const edit = require('../src/detail/edit.js');
const members = require('../src/common/members.js');
const branches = require('../src/common/branches.js');
const panel = require('../src/detail/panel.js');
const cache = require('../src/common/cache.js');
const table = require('../src/list/table.js');
const record = require('../src/common/record.js');

const allowlist = require('../src/common/allowlist.js');

const { fakeStorage } = require('../test-support/storage.js');

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

/** The write time every save below stamps, so the snapshot it writes is exact. */
const AT = '2026-08-26T11:00:00Z';

/** What the fetch stand-in answers the page request with. */
const PAGE_HTML = '<<the advisory page>>';

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

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The comment GitHub renders from a state comment body: the marker in a code
 * span, and the fence as a highlighted `pre`.
 *
 * @param {string} markdown
 * @returns {string}
 */
function renderStateComment(markdown) {
  const marker = /`([^`\n]+)`/.exec(markdown)?.[1] ?? '';
  const fence = /```json\n([\s\S]*?)\n```/.exec(markdown)?.[1] ?? '';
  return (
    '<!doctype html><html><body>' +
    '<div class="comment-body markdown-body js-comment-body"><details>' +
    `<summary>${schema.STATE_COMMENT_SUMMARY}</summary>` +
    `<p><code>${escapeHtml(marker)}</code></p>` +
    `<div class="highlight highlight-source-json"><pre>${escapeHtml(fence)}</pre></div>` +
    '</details></div></body></html>'
  );
}

/**
 * @param {URLSearchParams} params
 * @returns {string} the comment body the request carries.
 */
function postedBody(params) {
  return params.get('body') ?? params.get(write.EDIT_BODY_FIELD) ?? '';
}

/** The comment the signed-in maintainer holds their state in on the fixture. */
const OWN_COMMENT = 'advisory-comment-282847';

/**
 * Puts what a write landed into the page the next fetch answers with, which is
 * what GitHub does with an edited comment.
 *
 * @param {Document} page
 * @param {URLSearchParams} params
 * @returns {void}
 */
function land(page, params) {
  const fence = page.querySelector(`#${OWN_COMMENT} .highlight-source-json pre`);
  const written = /```json\n([\s\S]*?)\n```/.exec(postedBody(params))?.[1];
  if (fence === null || written === undefined) return;
  fence.textContent = written;
}

/**
 * A stand-in for `fetch` that answers the page request with one document and
 * the comment request with the comment that request wrote. A write that lands
 * goes into that document, so a second save reads the advisory as it now
 * stands.
 *
 * @param {Document} page
 * @param {number} [status] The status the comment request is answered with.
 * @returns {{
 *   fetch: import('../src/common/write.js').WriteFetch,
 *   parseDocument: (html: string) => Document,
 *   calls: Array<{ url: string, init: RequestInit }>,
 *   posts: () => Array<{ url: string, init: RequestInit }>,
 * }}
 */
function session(page, status = 200) {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  return {
    calls,
    posts: () => calls.filter((call) => call.init.method === 'POST'),
    fetch: async (url, init) => {
      calls.push({ url, init });
      if ((init.method ?? 'GET') === 'GET') return { status: 200, text: async () => PAGE_HTML };
      const params = /** @type {URLSearchParams} */ (/** @type {unknown} */ (init.body));
      const answer = renderStateComment(postedBody(params));
      if (status >= 200 && status < 300) land(page, params);
      return { status, text: async () => answer };
    },
    parseDocument: (html) => (html === PAGE_HTML ? page : document(html)),
  };
}

/**
 * One advisory as two documents: the page this browsing context is looking at,
 * and the page a write's own fetch reads. A write lands on the second, because
 * a comment written from here is on GitHub and not in the document the panel
 * sits in.
 *
 * @param {string} name
 * @param {number} [status] The status the comment request is answered with.
 * @returns {{ page: Document, talk: ReturnType<typeof session> }}
 */
function pair(name, status) {
  return { page: fixture(name), talk: session(fixture(name), status) };
}

/**
 * @param {{ url: string, init: RequestInit } | undefined} post
 * @returns {Record<string, unknown>} the snapshot one comment request carried.
 */
function snapshotOf(post) {
  if (post === undefined) throw new Error('no comment request went out');
  const params = /** @type {URLSearchParams} */ (/** @type {unknown} */ (post.init.body));
  const fence = /```json\n([\s\S]*?)\n```/.exec(postedBody(params))?.[1] ?? '';
  return JSON.parse(fence);
}

/**
 * @param {Array<{ url: string, init: RequestInit }>} calls
 * @returns {Record<string, unknown>} the snapshot the first comment request
 *   carried.
 */
function sentSnapshot(calls) {
  return snapshotOf(calls.find((call) => call.init.method === 'POST'));
}

/**
 * @param {Array<{ url: string, init: RequestInit }>} calls
 * @returns {Record<string, unknown>} the snapshot the last comment request
 *   carried.
 */
function lastSnapshot(calls) {
  return snapshotOf(calls.filter((call) => call.init.method === 'POST').pop());
}

/**
 * @returns {void} takes every advisory's changes, held state, results,
 *   half-typed text, and flight marks back out, so one test says nothing to
 *   the next.
 */
function forget() {
  edit.edits.clear();
  edit.written.clear();
  edit.results.clear();
  edit.opened.clear();
  edit.drafts.clear();
  edit.branchDrafts.clear();
  edit.saving.clear();
  edit.showing.key = null;
  members.clear();
  branches.clear();
}

/**
 * @param {Document} doc
 * @param {Partial<import('../src/detail/edit.js').EditorContext>} [extra]
 * @returns {Promise<import('../src/detail/edit.js').EditorContext>}
 */
async function contextFor(doc, extra) {
  const advisory = parse.parseDetail(doc);
  if (advisory === null) throw new Error('the document is not an advisory detail page');
  const merged = edit.preferred(
    edit.keyOf(advisory),
    merge.mergeSnapshots(advisory.comments)
  );
  const fingerprints = await tracking.fingerprints(advisory);
  return {
    advisory,
    derived: derive.derive(advisory),
    tracking: tracking.read(merged.state, fingerprints),
    fingerprints,
    merged,
    at: AT,
    ...extra,
  };
}

/**
 * @param {Element} root
 * @param {string} selector
 * @returns {Element}
 */
function control(root, selector) {
  const node = root.querySelector(selector);
  if (node === null) throw new Error(`the editor carries no ${selector}`);
  return node;
}

/**
 * @param {Element} node
 * @returns {string}
 */
function text(node) {
  return String(node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {Element} node
 * @returns {void} tells the control's handler that its value moved.
 */
function changed(node) {
  const view = node.ownerDocument?.defaultView;
  if (view === null || view === undefined) throw new Error('the document has no view');
  node.dispatchEvent(new view.Event('change', { bubbles: true }));
}

/**
 * Picks an option the way a maintainer does. The selection is the `selected`
 * attribute here, which is what this document model reads a select's value
 * from.
 *
 * @param {Element} select
 * @param {string} value
 * @returns {void}
 */
function choose(select, value) {
  for (const option of select.querySelectorAll('option')) {
    if ((option.getAttribute('value') ?? '') === value) option.setAttribute('selected', '');
    else option.removeAttribute('selected');
  }
  changed(select);
}

/**
 * @param {Element} box
 * @param {boolean} value
 * @returns {void}
 */
function tick(box, value) {
  /** @type {{ checked?: unknown }} */ (/** @type {unknown} */ (box)).checked = value;
  changed(box);
}

/**
 * Types into a control without leaving it. `change` fires on blur, and half a
 * date is what the field holds until then.
 *
 * @param {Element} field
 * @param {string} value
 * @returns {void}
 */
function typing(field, value) {
  /** @type {{ value?: unknown }} */ (/** @type {unknown} */ (field)).value = value;
  field.setAttribute('value', value);
  const view = field.ownerDocument?.defaultView;
  if (view === null || view === undefined) throw new Error('the document has no view');
  field.dispatchEvent(new view.Event('input', { bubbles: true }));
}

/**
 * @param {Element} field
 * @param {string} value
 * @returns {void}
 */
function type(field, value) {
  /** @type {{ value?: unknown }} */ (/** @type {unknown} */ (field)).value = value;
  changed(field);
}

/**
 * @param {Element} root
 * @returns {string} what the panel says about unsaved work.
 */
function note(root) {
  return text(control(root, '.bghsa-save-note'));
}

/**
 * @param {Document} doc
 * @param {Partial<import('../src/detail/edit.js').EditorContext>} [extra]
 * @returns {Promise<{ editor: Element, context: import('../src/detail/edit.js').EditorContext }>}
 */
async function editorFor(doc, extra) {
  const context = await contextFor(doc, extra);
  return { editor: edit.buildEditor(doc, context), context };
}

test('a control change is held in the panel and nothing goes to GitHub', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');

  assert.strictEqual(talk.calls.length, 0, 'touching a control reached GitHub');
  assert.strictEqual(note(editor), 'Unsaved changes: Triage.');
  assert.strictEqual(control(editor, 'button.bghsa-save').hasAttribute('disabled'), false);
  assert.strictEqual(edit.editsFor(edit.keyOf(context.advisory)).triage, 'evaluating');
});

test('a save writes one comment carrying the change', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');
  const outcome = await edit.save(context);

  assert.ok(outcome.ok === true, `the save failed: ${outcome.message}`);
  assert.strictEqual(talk.posts().length, 1, 'the save wrote more than one comment');
  const snapshot = sentSnapshot(talk.calls);
  assert.strictEqual(snapshot['triage'], 'evaluating');
  assert.strictEqual(snapshot['by'], 'samuelkarp');
  assert.strictEqual(snapshot['seq'], 8);
  assert.strictEqual(snapshot['triageSince'], AT);
  // A track no control changed is carried forward, and so is a field this
  // reader does not know.
  assert.deepStrictEqual(snapshot['owners'], ['samuelkarp']);
  assert.deepStrictEqual(snapshot['cutleryPolicy'], { sharpened: true });
  assert.strictEqual(edit.edits.has(edit.keyOf(context.advisory)), false);
});

test('a save that landed leaves the panel holding what it wrote', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');
  await edit.save(context);

  const after = await contextFor(page);
  assert.strictEqual(after.tracking.triage, 'evaluating', 'the panel read the page again');
  assert.strictEqual(after.merged.observedSeq, 8);
  assert.strictEqual(after.merged.confirmationRequired, false);
});

/**
 * Another maintainer's state comment, at the ordering claim `seq` and from a
 * login that takes the tie. The reporter's comment on the fixture stands in
 * for it: it becomes a member's, and it carries their snapshot.
 *
 * @param {Document} page
 * @param {number} seq
 * @param {string} triage
 * @returns {void}
 */
function rivalSnapshot(page, seq, triage) {
  const group = page.querySelector('#advisory-comment-282848');
  if (group === null) throw new Error('the fixture carries one other comment');
  for (const link of group.querySelectorAll('a.author')) {
    link.setAttribute('href', '/zulu-triage');
  }
  const badge = page.createElement('span');
  badge.className = 'Label';
  badge.textContent = 'Member';
  group.prepend(badge);
  const fence = group.querySelector('.highlight-source-json pre');
  if (fence === null) throw new Error('the comment carries no snapshot');
  fence.textContent = JSON.stringify(
    {
      betterGhsa: '1.0',
      seq,
      by: 'zulu-triage',
      at: AT,
      triage,
      triageSince: AT,
    },
    null,
    2
  );
}

test('a rival snapshot at the sequence a save reached refuses the next save', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const remote = fixture('triage-thread.html');
  const talk = session(remote);
  const first = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  const key = edit.keyOf(first.context.advisory);
  choose(control(first.editor, 'select.bghsa-triage'), 'evaluating');
  const landed = await edit.save(first.context);
  assert.ok(landed.ok === true, `the first save failed: ${landed.message}`);
  assert.strictEqual(sentSnapshot(talk.calls)['seq'], 8);

  // Another maintainer claimed sequence 8 at the same moment, and the tie on
  // GitHub goes to the greater login.
  rivalSnapshot(remote, 8, 'awaiting maintainer input');

  const second = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  assert.strictEqual(second.context.merged.observedSeq, 8, 'the panel forgot the write it made');
  choose(control(second.editor, 'select.bghsa-triage'), 'awaiting reporter');
  const outcome = await edit.save(second.context);

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'superseded');
  assert.strictEqual(
    talk.posts().length,
    1,
    'the second save wrote on state the maintainer never saw'
  );
  assert.strictEqual(
    edit.editsFor(key).triage,
    'awaiting reporter',
    'the refused change was taken out of the panel'
  );

  // The panel reloads from what the advisory says now.
  const third = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  assert.strictEqual(third.context.tracking.triage, 'awaiting maintainer input');
  forget();
});

test('a save GitHub refused leaves the change in the panel and says why', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html', 422);
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');
  const outcome = await edit.save(context);

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.status, 422);
  assert.strictEqual(edit.editsFor(edit.keyOf(context.advisory)).triage, 'evaluating');

  const again = await editorFor(page, { fetch: talk.fetch, parseDocument: talk.parseDocument });
  assert.strictEqual(note(again.editor), 'Unsaved changes: Triage.');
  assert.strictEqual(text(control(again.editor, '.bghsa-save-result')), outcome.message);
});

test('a panel at a sequence the advisory has moved past refuses and reloads', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');
  const stale = { ...context, merged: { ...context.merged, observedSeq: 5, nextSeq: 6 } };
  const refusal = await edit.save(stale);

  assert.strictEqual(refusal.ok, false);
  assert.strictEqual(refusal.reason, 'stale');
  assert.strictEqual(talk.posts().length, 0, 'a refused write reached the comment');
  assert.strictEqual(edit.editsFor(edit.keyOf(context.advisory)).triage, 'evaluating');

  // The panel reloaded with what the fetch read, so pressing Save again writes.
  const reloaded = await contextFor(page, { fetch: talk.fetch, parseDocument: talk.parseDocument });
  assert.strictEqual(reloaded.merged.observedSeq, 7);
  const outcome = await edit.save({ ...reloaded, at: AT });
  assert.ok(outcome.ok === true, `the second save failed: ${outcome.message}`);
  assert.strictEqual(sentSnapshot(talk.calls)['triage'], 'evaluating');
});

test('pressing Save with every control as it stands writes nothing', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const context = await contextFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  const outcome = await edit.save(context);

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'unchanged');
  assert.strictEqual(talk.calls.length, 0, 'a save with no change reached GitHub');
});

test('a save that stops before a request reports it and asks for a pass', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  let passes = 0;
  const context = await contextFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
    rerender: () => {
      passes += 1;
    },
  });
  const outcome = await edit.save(context);

  assert.strictEqual(outcome.reason, 'unchanged');
  assert.strictEqual(talk.calls.length, 0, 'a save with no change reached GitHub');
  // The press disabled the controls and wrote "Writing to GitHub" on the
  // panel, so a save that stops has to put something else there.
  assert.strictEqual(passes, 1, 'the panel was left as the press put it');
  assert.strictEqual(edit.results.get(edit.keyOf(context.advisory))?.message, '');
});

test('a page naming no advisory says so and asks for a pass', async () => {
  forget();
  const page = fixture('triage-thread.html');
  let passes = 0;
  const context = await contextFor(page, {
    rerender: () => {
      passes += 1;
    },
  });
  /** @type {import('../src/detail/edit.js').EditorContext} */
  const anonymous = { ...context, advisory: { ...context.advisory, ref: null } };
  const key = edit.keyOf(anonymous.advisory);
  edit.stage(key, anonymous.tracking, { triage: 'evaluating' });
  const outcome = await edit.save(anonymous);

  assert.strictEqual(outcome.reason, 'unreadable');
  assert.strictEqual(outcome.message, 'Error: failed to parse advisory');
  assert.strictEqual(passes, 1, 'the panel was left as the press put it');
  assert.strictEqual(edit.results.get(key)?.message, 'Error: failed to parse advisory');
  forget();
});

test('discarding takes the changes back out', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const { editor, context } = await editorFor(page);
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');
  assert.strictEqual(note(editor), 'Unsaved changes: Triage.');

  /** @type {HTMLElement} */ (/** @type {unknown} */ (control(editor, 'button.bghsa-discard')))
    .click();

  // The panel the next pass builds is what the maintainer is left looking at,
  // and it offers the stored state with nothing staged over it.
  const after = edit.buildEditor(page, context);
  assert.strictEqual(note(after), '');
  assert.strictEqual(control(after, 'button.bghsa-save').hasAttribute('disabled'), true);
  const chosen = Array.from(control(after, 'select.bghsa-triage').querySelectorAll('option'))
    .filter((option) => option.hasAttribute('selected'))
    .map((option) => option.getAttribute('value') ?? '');
  assert.deepStrictEqual(chosen, [context.tracking.triage ?? '']);
});

test('a value confirmed now reads as confirmed', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  assert.strictEqual(context.tracking.description.status, 'unconfirmed');
  tick(control(editor, 'input.bghsa-confirm-description'), true);
  // A staged confirmation is named by the label its own row carries.
  assert.strictEqual(note(editor), 'Unsaved changes: Description.');
  const outcome = await edit.save(context);

  assert.ok(outcome.ok === true, `the save failed: ${outcome.message}`);
  const view = tracking.read(sentSnapshot(talk.calls), context.fingerprints);
  assert.strictEqual(view.description.status, 'confirmed');
  assert.strictEqual(view.description.by, 'samuelkarp');
  assert.strictEqual(view.description.at, AT);
  // The record another maintainer wrote is carried forward untouched, drift
  // and all.
  assert.strictEqual(view.title.status, 'drifted');
  assert.strictEqual(view.title.by, 'samuelkarp');
});

test('clearing a confirmation takes the record away', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const wiring = { fetch: talk.fetch, parseDocument: talk.parseDocument };
  const confirming = await editorFor(page, wiring);
  tick(control(confirming.editor, 'input.bghsa-confirm-description'), true);
  await edit.save(confirming.context);

  // The comment is on GitHub and not in this document, so the panel reads the
  // state its own write left behind.
  const clearing = await editorFor(page, wiring);
  assert.strictEqual(clearing.context.tracking.description.status, 'confirmed');
  assert.strictEqual(
    control(clearing.editor, 'input.bghsa-confirm-description').hasAttribute('checked'),
    true
  );
  tick(control(clearing.editor, 'input.bghsa-confirm-description'), false);
  const outcome = await edit.save(clearing.context);

  assert.ok(outcome.ok === true, `the save failed: ${outcome.message}`);
  const view = tracking.read(lastSnapshot(talk.calls), clearing.context.fingerprints);
  assert.strictEqual(view.description.status, 'unconfirmed');
  assert.strictEqual(view.description.by, null);
});

test('a value the page did not give cannot be confirmed', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const field = page.querySelector('[name="repository_advisory[cvss_v3]"]');
  if (field === null) throw new Error('the triage fixture carries no CVSS vector field');
  field.setAttribute('name', 'repository_advisory[cvss_v3-renamed]');
  try {
    const { editor, context } = await editorFor(page);
    assert.strictEqual(context.fingerprints.scoring, null);
    assert.strictEqual(
      control(editor, 'input.bghsa-confirm-scoring').hasAttribute('disabled'),
      true
    );
  } finally {
    field.setAttribute('name', 'repository_advisory[cvss_v3]');
  }
});

test('a confirmation the page cannot back is cleared and taken away', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const talk = session(fixture('triage-thread.html'));
  const first = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  // Ticked while the title was on the page.
  tick(control(first.editor, 'input.bghsa-confirm-title'), true);
  const key = edit.keyOf(first.context.advisory);
  assert.strictEqual(edit.editsFor(key).confirm?.title, true);

  // The page stops carrying the title, so nothing says what the record would
  // bind to.
  const field = page.querySelector('[name="repository_advisory[title]"]');
  if (field === null) throw new Error('the fixture carries no title field');
  field.remove();
  const second = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });

  const box = control(second.editor, 'input.bghsa-confirm-title');
  assert.strictEqual(box.hasAttribute('disabled'), true, 'the box can still be ticked');
  assert.strictEqual(box.hasAttribute('checked'), false, 'the box still stands ticked');
  assert.strictEqual(
    text(control(second.editor, '.bghsa-confirmation-note')),
    'Unavailable'
  );
  assert.strictEqual(
    edit.editsFor(key).confirm?.title,
    undefined,
    'the tick the page cannot back is still staged'
  );
  assert.strictEqual(
    control(second.editor, 'button.bghsa-save').hasAttribute('disabled'),
    true,
    'Save offered a write that would carry nothing'
  );
  assert.strictEqual(note(second.editor), '');
  assert.strictEqual(talk.calls.length, 0, 'a save carrying nothing reached GitHub');
  forget();
});

test('an excluded snapshot takes one confirmation, and the panel asks for it', async () => {
  forget();
  const { page, talk } = pair('draft.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  assert.strictEqual(context.merged.confirmationRequired, true);
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');

  const refusal = await edit.save(context);
  assert.strictEqual(refusal.ok, false);
  assert.strictEqual(refusal.reason, 'confirmation');
  assert.strictEqual(talk.posts().length, 0, 'a write went out without the confirmation');

  const again = await editorFor(page, { fetch: talk.fetch, parseDocument: talk.parseDocument });
  assert.strictEqual(
    text(control(again.editor, 'input.bghsa-supersede').parentElement ?? again.editor),
    'Supersede unparsed state'
  );
  // The row label, which is not the word the confirmation rows are under: this
  // one is a maintainer overriding a snapshot, not approving a value.
  const row = control(again.editor, 'input.bghsa-supersede').closest('.bghsa-field');
  assert.strictEqual(text(row?.querySelector('.bghsa-field-label') ?? again.editor), 'Override');
  tick(control(again.editor, 'input.bghsa-supersede'), true);
  const outcome = await edit.save(again.context);
  assert.ok(outcome.ok === true, `the confirmed save failed: ${outcome.message}`);
  assert.strictEqual(sentSnapshot(talk.calls)['triage'], 'evaluating');
});

test('a schema this extension does not read leaves the panel read-only', async () => {
  forget();
  const page = fixture('draft.html');
  const fence = page.querySelector('.highlight-source-json pre');
  if (fence === null) throw new Error('the draft fixture carries no snapshot');
  fence.textContent = '{ "betterGhsa": "2.0", "seq": 2, "by": "samuelkarp" }';
  const { editor, context } = await editorFor(page);

  assert.strictEqual(context.merged.readOnly, true);
  assert.ok(editor.querySelector('button.bghsa-save') === null, 'the panel still offers a save');
  assert.ok(editor.querySelector('select.bghsa-triage') === null, 'the panel still offers controls');
  assert.strictEqual(text(control(editor, '.bghsa-read-only')), 'Update the extension to edit');
});

/**
 * @param {Element} editor
 * @param {string} name The class stem of the control to read.
 * @returns {(string | null)[]} the values that control offers.
 */
function candidates(editor, name = 'owner') {
  return Array.from(
    editor.querySelectorAll(`datalist.bghsa-${name}-candidates option`)
  ).map((option) => option.getAttribute('value'));
}

test('the owner candidates are the members, and the reporter is not one', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const { editor, context } = await editorFor(page);
  assert.deepStrictEqual(context.advisory.collaborators, ['prakleumas']);
  assert.strictEqual(context.advisory.reporter, 'prakleumas');
  assert.deepStrictEqual(context.derived.members, ['samuelkarp']);
  assert.deepStrictEqual(candidates(editor), ['samuelkarp']);
});

test('a member seen on another advisory is offered on this one', async () => {
  forget();
  const other = fixture('draft.html');
  for (const link of other.querySelectorAll('div.timeline-comment-group a.author')) {
    link.setAttribute('href', '/dmcgowan');
  }
  const drawn = await panel.render(other);
  assert.ok(drawn !== null, 'the draft fixture offered no anchor');
  assert.deepStrictEqual(
    members.known({ owner: 'git-utensils' }),
    ['dmcgowan'],
    'the other advisory taught nothing'
  );

  const { editor } = await editorFor(fixture('triage-thread.html'));
  assert.deepStrictEqual(candidates(editor), ['samuelkarp', 'dmcgowan']);
  forget();
});

test('a member of one organization is not offered on another organization', async () => {
  forget();
  members.remember({ owner: 'containerd' }, ['dmcgowan']);
  members.remember({ owner: 'git-utensils' }, ['samuelkarp']);

  const { editor: utensils, context } = await editorFor(fixture('triage-thread.html'));
  assert.strictEqual(context.advisory.ref?.owner, 'git-utensils');
  const offered = candidates(utensils);
  assert.ok(
    offered.includes('samuelkarp'),
    'a member of this organization is not offered as an owner'
  );
  assert.ok(
    !offered.includes('dmcgowan'),
    "a member of another organization is offered as this one's owner"
  );

  // With no containerd member seen, that advisory falls back to the
  // collaborators, and a git-utensils member has no place among them either.
  forget();
  members.remember({ owner: 'git-utensils' }, ['samuelkarp']);
  const { editor: cd } = await editorFor(fixture('published-containerd.html'));
  assert.ok(
    !candidates(cd).includes('samuelkarp'),
    'a member of another organization suppressed the collaborator fallback'
  );
  forget();
});

test('an advisory with no member seen offers the collaborators, not the reporter', async () => {
  forget();
  const page = fixture('published-containerd.html');
  const { editor, context } = await editorFor(page);
  assert.deepStrictEqual(context.derived.members, [], 'the fixture shows a member badge');
  assert.strictEqual(context.advisory.reporter, 'pieter-vosk');
  assert.deepStrictEqual(candidates(editor), [
    'vanBruggen',
    'devon-quist',
    'yaroslavk',
    'rowan-hale-ext',
  ]);
});

test('a typed login matching no candidate is taken as it is', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  type(control(editor, 'input.bghsa-owner-input'), 'yaroslavk');
  /** @type {HTMLElement} */ (/** @type {unknown} */ (control(editor, 'button.bghsa-owner-add')))
    .click();

  const owners = Array.from(editor.querySelectorAll('.bghsa-owner'));
  assert.deepStrictEqual(
    owners.map((owner) => text(control(owner, '.Label'))),
    ['samuelkarp', 'yaroslavk']
  );
  // No chip marks an owner the extension does not recognize: it blocked
  // nothing, and such an owner could always be saved.
  assert.strictEqual(editor.querySelector('.bghsa-owner-unknown'), null);
  assert.strictEqual(note(editor), 'Unsaved changes: Owners.');

  await edit.save(context);
  assert.deepStrictEqual(sentSnapshot(talk.calls)['owners'], ['samuelkarp', 'yaroslavk']);
});

/**
 * @param {Element} editor
 * @returns {string[]} the logins the owner control holds.
 */
function ownersHeld(editor) {
  return Array.from(editor.querySelectorAll('.bghsa-owner')).map((owner) =>
    text(control(owner, '.Label'))
  );
}

test('an owner taken off and put back holds no change', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const base = await contextFor(page);
  const context = {
    ...base,
    tracking: { ...base.tracking, owners: ['samuelkarp', 'dmcgowan'] },
  };
  const key = edit.keyOf(context.advisory);
  const editor = edit.buildEditor(page, context);
  assert.strictEqual(ownersHeld(editor).join(' '), 'samuelkarp dmcgowan');
  press(editor, 'button.bghsa-owner-remove');
  type(control(editor, 'input.bghsa-owner-input'), 'samuelkarp');
  press(editor, 'button.bghsa-owner-add');

  assert.strictEqual(
    edit.editsFor(key).owners,
    undefined,
    'a list put back where it started stayed staged'
  );
  assert.strictEqual(edit.anyPending(), false, 'a list put back where it started warns on leaving');
  assert.strictEqual(ownersHeld(editor).join(' '), 'samuelkarp dmcgowan');
  assert.strictEqual(note(editor), '');
  assert.strictEqual(control(editor, 'button.bghsa-save').hasAttribute('disabled'), true);
});

test('an owner retyped in a different case holds no change', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const base = await contextFor(page);
  const context = { ...base, tracking: { ...base.tracking, owners: ['samuelkarp'] } };
  const key = edit.keyOf(context.advisory);
  const editor = edit.buildEditor(page, context);
  press(editor, 'button.bghsa-owner-remove');
  type(control(editor, 'input.bghsa-owner-input'), 'SamuelKarp');
  press(editor, 'button.bghsa-owner-add');

  assert.strictEqual(edit.editsFor(key).owners, undefined, 'one login in two cases stayed staged');
  assert.strictEqual(ownersHeld(editor).join(' '), 'samuelkarp');
  assert.strictEqual(note(editor), '');
  assert.strictEqual(control(editor, 'button.bghsa-save').hasAttribute('disabled'), true);
});

/** The repository every fixture below carries an advisory of. */
const REPO = { owner: 'git-utensils', repo: 'Spoon-Knife' };

/**
 * @param {Element} editor
 * @returns {string[]} the branches the backport control holds.
 */
function backports(editor) {
  return Array.from(editor.querySelectorAll('.bghsa-backport .Label')).map((label) => text(label));
}

/**
 * @param {Element} editor
 * @param {string} selector
 * @returns {void} presses one button of the editor.
 */
function press(editor, selector) {
  /** @type {HTMLElement} */ (/** @type {unknown} */ (control(editor, selector))).click();
}

test('the backport candidates are offered by version, newest first', async () => {
  forget();
  // release/0.9 sorts below the release/1.0 this advisory already carries, so
  // the two sources are ordered together and not one after the other.
  branches.remember(REPO, ['release/2.9', 'release/2.10', 'release/0.9', 'main']);
  const { editor } = await editorFor(fixture('triage-thread.html'));

  const offered = candidates(editor, 'backport');
  assert.strictEqual(
    offered.join(' '),
    'release/2.10 release/2.9 release/1.0 release/0.9',
    'the branches were not offered by version'
  );
  assert.strictEqual(
    offered.indexOf('release/2.10') < offered.indexOf('release/2.9'),
    true,
    'release/2.10 was offered after release/2.9'
  );
});

test('a branch this advisory already carries is offered on it', async () => {
  forget();
  const { editor, context } = await editorFor(fixture('triage-thread.html'));
  assert.strictEqual(context.tracking.backports.join(' '), 'release/1.0');
  assert.strictEqual(candidates(editor, 'backport').join(' '), 'release/1.0');
  assert.strictEqual(backports(editor).join(' '), 'release/1.0');
});

test('a typed branch is taken and is written on the save', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  type(control(editor, 'input.bghsa-backport-input'), 'release/2.10');
  press(editor, 'button.bghsa-backport-add');

  assert.strictEqual(backports(editor).join(' '), 'release/1.0 release/2.10');
  assert.strictEqual(note(editor), 'Unsaved changes: Backport targets.');
  assert.strictEqual(talk.calls.length, 0, 'the staged branch reached GitHub before the save');

  await edit.save(context);
  const written = /** @type {string[]} */ (sentSnapshot(talk.calls)['backports']);
  assert.strictEqual(written.join(' '), 'release/1.0 release/2.10');
});

test('the same branch is not taken twice', async () => {
  forget();
  const { editor } = await editorFor(fixture('triage-thread.html'));
  const field = control(editor, 'input.bghsa-backport-input');
  type(field, 'release/2.10');
  press(editor, 'button.bghsa-backport-add');
  type(field, 'release/2.10');
  press(editor, 'button.bghsa-backport-add');

  assert.strictEqual(backports(editor).join(' '), 'release/1.0 release/2.10');
});

test('taking the last branch off clears the track', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  press(editor, 'button.bghsa-backport-remove');
  assert.strictEqual(backports(editor).length === 0, true, 'the branch is still held');
  assert.strictEqual(note(editor), 'Unsaved changes: Backport targets.');

  await edit.save(context);
  assert.strictEqual(
    sentSnapshot(talk.calls)['backports'],
    undefined,
    'the backports field survived a save that cleared it'
  );
});

test('a branch taken off and put back holds no change', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const base = await contextFor(page);
  const context = {
    ...base,
    tracking: { ...base.tracking, backports: ['release/1.0', 'release/2.10'] },
  };
  const key = edit.keyOf(context.advisory);
  const editor = edit.buildEditor(page, context);
  assert.strictEqual(backports(editor).join(' '), 'release/1.0 release/2.10');
  press(editor, 'button.bghsa-backport-remove');
  type(control(editor, 'input.bghsa-backport-input'), 'release/1.0');
  press(editor, 'button.bghsa-backport-add');

  assert.strictEqual(
    edit.editsFor(key).backports,
    undefined,
    'a list put back where it started stayed staged'
  );
  assert.strictEqual(backports(editor).join(' '), 'release/1.0 release/2.10');
  assert.strictEqual(note(editor), '');
  assert.strictEqual(control(editor, 'button.bghsa-save').hasAttribute('disabled'), true);
});

test('a repository whose branches went unread still takes a typed branch', async () => {
  forget();
  const page = fixture('draft.html');
  const { editor, context } = await editorFor(page);
  assert.strictEqual(context.tracking.backports.length === 0, true, 'the advisory holds a branch');
  assert.strictEqual(
    edit.backportCandidates(context).length === 0,
    true,
    'a repository nothing has read the branches of offered one'
  );
  assert.strictEqual(candidates(editor, 'backport').length === 0, true);

  type(control(editor, 'input.bghsa-backport-input'), 'release/2.1');
  press(editor, 'button.bghsa-backport-add');
  assert.strictEqual(backports(editor).join(' '), 'release/2.1');
  assert.strictEqual(note(editor), 'Unsaved changes: Backport targets.');
});

test('an owner taken off the list is written without them', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  /** @type {HTMLElement} */ (/** @type {unknown} */ (control(editor, 'button.bghsa-owner-remove')))
    .click();
  await edit.save(context);

  assert.strictEqual(sentSnapshot(talk.calls)['owners'], undefined, 'the owners field is still set');
});

test('the embargo controls write the date they hold, and clear the track when off', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  assert.strictEqual(context.tracking.embargoLift, '2026-09-30');
  type(control(editor, 'input.bghsa-embargo-lift'), '2026-10-15');
  await edit.save(context);
  assert.deepStrictEqual(sentSnapshot(talk.calls)['embargo'], { lift: '2026-10-15' });

  forget();
  const { page: fresh, talk: second } = pair('triage-thread.html');
  const off = await editorFor(fresh, {
    fetch: second.fetch,
    parseDocument: second.parseDocument,
  });
  tick(control(off.editor, 'input.bghsa-embargo'), false);
  await edit.save(off.context);
  assert.strictEqual(sentSnapshot(second.calls)['embargo'], undefined);
});

test('text is held as it is typed, before the field is left', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const { editor, context } = await editorFor(page);
  const key = edit.keyOf(context.advisory);
  typing(control(editor, 'input.bghsa-embargo-lift'), '2026-12-01');
  choose(control(editor, 'select.bghsa-closure'), 'duplicate');
  typing(control(editor, 'input.bghsa-closure-duplicate'), 'GHSA-1111-2222-3333');

  assert.strictEqual(edit.editsFor(key).embargoLift, '2026-12-01');
  assert.strictEqual(edit.editsFor(key).closureDuplicateOf, 'GHSA-1111-2222-3333');
  // The list names each track by the label the panel's own row carries.
  assert.strictEqual(note(editor), 'Unsaved changes: Embargo, Closed as.');
  forget();
});

test('half-typed text survives a render pass', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const first = await panel.render(page);
  assert.ok(first !== null, 'the fixture offered no anchor');
  const before = /** @type {Element} */ (first);
  typing(control(before, 'input.bghsa-embargo-lift'), '2026-12-01');
  // A login is a change once it is added, and text in the control until then.
  typing(control(before, 'input.bghsa-owner-input'), 'kolysh');

  const second = await panel.render(page);
  assert.ok(second !== null, 'the second pass placed no panel');
  const after = /** @type {Element} */ (second);
  assert.ok(after !== before, 'the pass did not rebuild the panel');
  assert.strictEqual(
    control(after, 'input.bghsa-embargo-lift').getAttribute('value'),
    '2026-12-01',
    'the pass took the date with it'
  );
  assert.strictEqual(
    control(after, 'input.bghsa-owner-input').getAttribute('value'),
    'kolysh',
    'the pass took the half-typed login with it'
  );
  forget();
});

/**
 * Puts a field inside the stored embargo that this reader does not know, as a
 * newer version of the extension writing the same advisory would.
 *
 * @param {Document} page
 * @returns {void}
 */
function embargoWithUnknownField(page) {
  const fence = page.querySelector(`#${OWN_COMMENT} .highlight-source-json pre`);
  if (fence === null) throw new Error('the fixture carries no snapshot');
  const held = JSON.parse(String(fence.textContent ?? ''));
  held.embargo = { lift: '2026-09-30', reason: 'coordinated release' };
  fence.textContent = JSON.stringify(held, null, 2);
}

test('turning the embargo off stages no lift date and keeps the date on screen', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const advisory = parse.parseDetail(page);
  if (advisory === null) throw new Error('the fixture is not an advisory detail page');
  const key = edit.keyOf(advisory);
  const first = await panel.render(page);
  assert.ok(first !== null, 'the fixture offered no anchor');
  const built = /** @type {Element} */ (first);
  const lift = control(built, 'input.bghsa-embargo-lift');
  const applies = control(built, 'input.bghsa-embargo');
  assert.strictEqual(lift.hasAttribute('disabled'), false, 'the date is off under an embargo');
  typing(lift, '2026-12-01');
  assert.strictEqual(edit.editsFor(key).embargoLift, '2026-12-01');

  tick(applies, false);
  assert.strictEqual(lift.hasAttribute('disabled'), true, 'the date is still reachable');
  assert.strictEqual(
    edit.editsFor(key).embargoLift,
    undefined,
    'turning the embargo off staged a lift date'
  );
  assert.strictEqual(
    control(built, 'input.bghsa-embargo-lift').getAttribute('value'),
    '2026-12-01',
    'the date left the box'
  );
  assert.strictEqual(
    note(built).toLowerCase().includes('lift date'),
    false,
    `the panel said something about the date it does not hold: ${note(built)}`
  );

  tick(applies, true);
  assert.strictEqual(lift.hasAttribute('disabled'), false, 'the date stayed off under an embargo');
  assert.strictEqual(
    edit.editsFor(key).embargoLift,
    '2026-12-01',
    'ticking the embargo back on did not take the date with it'
  );
  forget();
});

test('a save turning the embargo off leaves nothing staged', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  const key = edit.keyOf(context.advisory);
  assert.strictEqual(context.tracking.embargoLift, '2026-09-30');
  typing(control(editor, 'input.bghsa-embargo-lift'), '2026-12-01');
  tick(control(editor, 'input.bghsa-embargo'), false);

  const outcome = await edit.save(context);
  assert.ok(outcome.ok === true, `the save failed: ${outcome.message}`);
  assert.strictEqual(sentSnapshot(talk.calls)['embargo'], undefined, 'the write carried an embargo');
  assert.strictEqual(
    edit.editsFor(key).embargoLift,
    undefined,
    'the save left a lift date the write did not carry'
  );
  assert.strictEqual(edit.results.get(key)?.message, 'Saved.');
  forget();
});

test('a reason moved off duplicate stages no id, and moving it back stages one', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  const key = edit.keyOf(context.advisory);
  const box = control(editor, 'input.bghsa-closure-duplicate');
  choose(control(editor, 'select.bghsa-closure'), 'duplicate');
  typing(box, 'GHSA-1111-2222-3333');
  assert.strictEqual(edit.editsFor(key).closureDuplicateOf, 'GHSA-1111-2222-3333');

  choose(control(editor, 'select.bghsa-closure'), 'out of scope');
  assert.strictEqual(
    edit.editsFor(key).closureDuplicateOf,
    undefined,
    'a reason that is not duplicate staged an id the write would drop'
  );
  assert.strictEqual(
    box.getAttribute('value'),
    'GHSA-1111-2222-3333',
    'the id left the box the maintainer typed it into'
  );
  assert.strictEqual(box.hasAttribute('disabled'), true, 'the id is still reachable');

  choose(control(editor, 'select.bghsa-closure'), 'duplicate');
  assert.strictEqual(
    edit.editsFor(key).closureDuplicateOf,
    'GHSA-1111-2222-3333',
    'moving the reason back did not take the id in the box with it'
  );
  const outcome = await edit.save(context);
  assert.ok(outcome.ok === true, `the save failed: ${outcome.message}`);
  const closure = /** @type {Record<string, unknown>} */ (sentSnapshot(talk.calls)['closure']);
  assert.ok(closure['reason'] === 'duplicate', 'the save wrote another closure reason');
  assert.ok(
    closure['duplicateOf'] === 'GHSA-1111-2222-3333',
    'the save did not write the id the maintainer typed'
  );
  forget();
});

test('a pass drops an id the advisory moved off duplicate under', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const fence = page.querySelector(`#${OWN_COMMENT} .highlight-source-json pre`);
  if (fence === null) throw new Error('the fixture carries no snapshot');
  const seeded = JSON.parse(String(fence.textContent ?? ''));
  seeded.closure = { reason: 'duplicate', duplicateOf: 'GHSA-oooo-oooo-oooo' };
  fence.textContent = JSON.stringify(seeded, null, 2);

  const first = await editorFor(page);
  const key = edit.keyOf(first.context.advisory);
  typing(control(first.editor, 'input.bghsa-closure-duplicate'), 'GHSA-1111-2222-3333');
  assert.strictEqual(edit.editsFor(key).closureDuplicateOf, 'GHSA-1111-2222-3333');

  // Another maintainer closes it as fixed, and the page carries that now.
  const moved = JSON.parse(String(fence.textContent ?? ''));
  moved.seq += 1;
  moved.closure = { reason: 'fixed' };
  fence.textContent = JSON.stringify(moved, null, 2);
  const second = await editorFor(page);
  assert.strictEqual(second.context.tracking.closureReason, 'fixed', 'the pass read the old state');

  assert.strictEqual(
    edit.editsFor(key).closureDuplicateOf,
    undefined,
    'the pass held an id no save from it would carry'
  );
  assert.strictEqual(edit.pendingOn(key), false, 'a value no save would carry warns on leaving');
  assert.strictEqual(note(second.editor), '');
  forget();
});

test('a control moved away and back beside a real edit leaves nothing staged', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  const key = edit.keyOf(context.advisory);
  const triage = control(editor, 'select.bghsa-triage');
  assert.strictEqual(context.tracking.triage, 'awaiting reporter');
  choose(triage, 'evaluating');
  assert.strictEqual(edit.editsFor(key).triage, 'evaluating');
  choose(triage, 'awaiting reporter');
  assert.strictEqual(
    edit.editsFor(key).triage,
    undefined,
    'a control put back where it started stayed staged'
  );
  assert.strictEqual(edit.anyPending(), false, 'a control put back where it started warns');

  tick(control(editor, 'input.bghsa-embargo'), false);
  assert.strictEqual(
    edit.changedTracks(context.tracking, edit.editsFor(key)).join(' '),
    'Embargo',
    'the panel counted a control put back where it started as a change to write'
  );
  const outcome = await edit.save(context);
  assert.ok(outcome.ok === true, `the save failed: ${outcome.message}`);
  assert.strictEqual(
    edit.edits.has(key),
    false,
    'the save left staged what the write did not carry'
  );
  assert.strictEqual(edit.results.get(key)?.message, 'Saved.');
  forget();
});

test('a checkbox ticked and unticked leaves nothing staged', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const { editor, context } = await editorFor(page);
  const key = edit.keyOf(context.advisory);
  assert.strictEqual(context.tracking.embargo, true);
  const applies = control(editor, 'input.bghsa-embargo');
  tick(applies, false);
  assert.strictEqual(edit.editsFor(key).embargo, false);
  tick(applies, true);
  assert.strictEqual(
    edit.editsFor(key).embargo,
    undefined,
    'a checkbox put back where it started stayed staged'
  );
  assert.strictEqual(edit.anyPending(), false, 'a checkbox put back where it started warns');

  // The title confirmation on this fixture has drifted, so the box stands
  // unticked and ticking it is a record the advisory does not carry.
  assert.strictEqual(context.tracking.title.status, 'drifted');
  const title = control(editor, 'input.bghsa-confirm-title');
  tick(title, true);
  assert.strictEqual(edit.anyPending(), true, 'a confirmation the maintainer changed is not work');
  tick(title, false);
  assert.strictEqual(
    edit.editsFor(key).confirm,
    undefined,
    'a confirmation put back where it started stayed staged'
  );
  assert.strictEqual(edit.anyPending(), false, 'a confirmation put back where it started warns');
  forget();
});

test('clearing a record holding an unknown field is refused', async () => {
  forget();
  const page = fixture('triage-thread.html');
  embargoWithUnknownField(page);
  const remote = fixture('triage-thread.html');
  embargoWithUnknownField(remote);
  const talk = session(remote);
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  const key = edit.keyOf(context.advisory);
  tick(control(editor, 'input.bghsa-embargo'), false);
  const outcome = await edit.save(context);

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'unclearable');
  assert.strictEqual(talk.posts().length, 0, 'a write that would delete a field went out');
  assert.strictEqual(outcome.message, 'Error: update the extension');
  assert.strictEqual(edit.editsFor(key).embargo, false, 'the refused change was dropped');
  forget();
});

test('a clear is judged against the state the write reads', async () => {
  forget();
  // The field landed on the advisory after the panel loaded, by a hand edit at
  // the sequence the panel is holding. The panel's own page does not carry it.
  const page = fixture('triage-thread.html');
  const remote = fixture('triage-thread.html');
  embargoWithUnknownField(remote);
  const talk = session(remote);
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  tick(control(editor, 'input.bghsa-embargo'), false);
  const outcome = await edit.save(context);

  assert.ok(outcome.ok === false, 'a write that would delete embargo.reason landed');
  assert.ok(outcome.reason === 'unclearable', `the write was refused as ${outcome.reason}`);
  assert.strictEqual(talk.posts().length, 0, 'a write that would delete a field went out');
});

test('a clear the write reads no unknown field against still goes', async () => {
  forget();
  // The mirror: the panel loaded with the field and the advisory no longer
  // carries it, so nothing stands in the way of the clear.
  const page = fixture('triage-thread.html');
  embargoWithUnknownField(page);
  const talk = session(fixture('triage-thread.html'));
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  tick(control(editor, 'input.bghsa-embargo'), false);
  const outcome = await edit.save(context);

  assert.ok(outcome.ok === true, `the save failed: ${outcome.message}`);
  assert.strictEqual(sentSnapshot(talk.calls)['embargo'], undefined);
  forget();
});

test('a duplicate advisory retyped in a different case holds no change', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const base = await contextFor(page);
  const editor = edit.buildEditor(page, {
    ...base,
    tracking: {
      ...base.tracking,
      closureReason: 'duplicate',
      closureDuplicateOf: 'GHSA-cm76-qm8v-3j95',
    },
  });
  type(control(editor, 'input.bghsa-closure-duplicate'), 'ghsa-cm76-qm8v-3j95');

  assert.strictEqual(note(editor), '');
  assert.strictEqual(control(editor, 'button.bghsa-save').hasAttribute('disabled'), true);
  forget();
});

test('the closure controls write the duplicate only for a duplicate', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  const reason = control(editor, 'select.bghsa-closure');
  const duplicate = control(editor, 'input.bghsa-closure-duplicate');
  assert.strictEqual(duplicate.hasAttribute('disabled'), true);

  choose(reason, 'duplicate');
  assert.strictEqual(duplicate.hasAttribute('disabled'), false);
  type(duplicate, 'GHSA-cm76-qm8v-3j95');
  await edit.save(context);
  assert.deepStrictEqual(sentSnapshot(talk.calls)['closure'], {
    reason: 'duplicate',
    duplicateOf: 'GHSA-cm76-qm8v-3j95',
  });

  forget();
  const { page: fresh, talk: second } = pair('triage-thread.html');
  const other = await editorFor(fresh, {
    fetch: second.fetch,
    parseDocument: second.parseDocument,
  });
  choose(control(other.editor, 'select.bghsa-closure'), 'out of scope');
  await edit.save(other.context);
  // A closure that is not a duplicate names none, and a field the snapshot
  // never carried is left out rather than written as null, which the validator
  // refuses.
  const written = sentSnapshot(second.calls);
  assert.deepStrictEqual(written['closure'], { reason: 'out of scope' });
  assert.strictEqual(
    schema.readSnapshot(JSON.stringify(written)).valid,
    true,
    'the snapshot this save wrote does not pass validation'
  );
});

test('an embargo turned on with no date writes a snapshot that validates', async () => {
  forget();
  const { page, talk } = pair('draft.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  assert.strictEqual(context.tracking.embargo, false);
  tick(control(editor, 'input.bghsa-embargo'), true);
  tick(control(editor, 'input.bghsa-supersede'), true);
  const outcome = await edit.save(context);

  assert.ok(outcome.ok === true, `the save failed: ${outcome.message}`);
  const written = sentSnapshot(talk.calls);
  assert.deepStrictEqual(written['embargo'], {});
  assert.strictEqual(
    schema.readSnapshot(JSON.stringify(written)).valid,
    true,
    'the snapshot this save wrote does not pass validation'
  );
});

/**
 * @param {() => boolean} done
 * @returns {Promise<void>} resolves once `done` holds, or throws.
 */
async function until(done) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition never held');
}

test('pressing Save writes once and asks for a render pass', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  let passes = 0;
  const { editor } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
    rerender: () => {
      passes += 1;
    },
  });
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');
  const button = control(editor, 'button.bghsa-save');
  /** @type {HTMLElement} */ (/** @type {unknown} */ (button)).click();

  assert.strictEqual(note(editor), edit.WRITING_MESSAGE);
  assert.strictEqual(note(editor), 'Saving...');
  // The controls are held still while the request is out: a value staged
  // against it is a value that write does not carry.
  const held = Array.from(editor.querySelectorAll('.bghsa-controls input, .bghsa-controls select'));
  assert.ok(held.length > 0, 'the editor offers no controls');
  assert.strictEqual(
    held.filter((node) => !node.hasAttribute('disabled')).length,
    0,
    'a control was left open while the write was going out'
  );
  await until(() => passes > 0);
  assert.strictEqual(talk.posts().length, 1, 'one press wrote more than one comment');
  assert.strictEqual(passes, 1);
});

test('a pass during a save leaves the maintainer nothing to stage', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const talk = session(fixture('triage-thread.html'));
  /** @type {() => void} */
  let land = () => {};
  const held = new Promise((resolve) => {
    land = () => resolve(undefined);
  });
  /** @type {import('../src/common/write.js').WriteFetch} */
  const gated = async (url, init) => {
    if ((init.method ?? 'GET') !== 'GET') await held;
    return talk.fetch(url, init);
  };
  const context = await contextFor(page, { fetch: gated, parseDocument: talk.parseDocument });
  const key = edit.keyOf(context.advisory);
  const editor = edit.buildEditor(page, context);
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');
  /** @type {HTMLElement} */ (/** @type {unknown} */ (control(editor, 'button.bghsa-save')))
    .click();

  // GitHub replaces what surrounds the panel while the request is out, and the
  // pass that follows builds the controls again.
  const midflight = edit.buildEditor(page, context);
  const open = Array.from(
    midflight.querySelectorAll('.bghsa-controls input, .bghsa-controls select')
  ).filter((node) => !node.hasAttribute('disabled'));
  assert.strictEqual(open.length, 0, 'a rebuilt control was open while the write was going out');
  assert.strictEqual(note(midflight), edit.WRITING_MESSAGE);

  land();
  await until(() => edit.results.has(key));
  assert.strictEqual(talk.posts().length, 1, 'one press wrote more than one comment');
  assert.strictEqual(edit.results.get(key)?.message, 'Saved.');
  forget();
});

test('a second save while one is on its way keeps the flight mark', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const talk = session(fixture('triage-thread.html'));
  /** @type {() => void} */
  let go = () => {};
  /** @type {Promise<void>} */
  const arrive = new Promise((resolve) => {
    go = () => resolve();
  });
  /** @type {import('../src/common/write.js').WriteFetch} */
  const slow = async (url, init) => {
    if ((init.method ?? 'GET') === 'GET') await arrive;
    return talk.fetch(url, init);
  };
  const { editor, context } = await editorFor(page, {
    fetch: slow,
    parseDocument: talk.parseDocument,
  });
  const key = edit.keyOf(context.advisory);
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');

  const flight = edit.save(context);
  /** @type {import('../src/detail/state.js').StateWriteResult} */
  let landed;
  try {
    const second = await edit.save(context);
    assert.ok(second.ok === false, 'a second save while one was out was not refused');
    assert.ok(second.reason === 'in-flight', `the second save was refused as ${second.reason}`);
    assert.ok(edit.saving.has(key), 'the second save took the mark the first one is flying under');
    // What a pass during the flight builds, which is what the maintainer reads.
    const during = edit.buildEditor(page, context);
    assert.strictEqual(note(during), edit.WRITING_MESSAGE);
    assert.strictEqual(control(during, 'button.bghsa-save').hasAttribute('disabled'), true);
  } finally {
    // Let go of the flight whatever happened above, so a write left hanging
    // says nothing to the next test.
    go();
    landed = await flight;
  }
  assert.ok(landed.ok === true, `the first save failed: ${landed.message}`);
  assert.strictEqual(talk.posts().length, 1, 'more than one comment request went out');
  assert.ok(!edit.saving.has(key), 'the mark outlived the flight');
  forget();
});

test('a value staged while a write is out is kept and reported', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const talk = session(fixture('triage-thread.html'));
  /** @type {() => void} */
  let land = () => {};
  const held = new Promise((resolve) => {
    land = () => resolve(undefined);
  });
  /** @type {import('../src/common/write.js').WriteFetch} */
  const gated = async (url, init) => {
    if ((init.method ?? 'GET') !== 'GET') await held;
    return talk.fetch(url, init);
  };
  const context = await contextFor(page, { fetch: gated, parseDocument: talk.parseDocument });
  const key = edit.keyOf(context.advisory);
  const editor = edit.buildEditor(page, context);
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');
  const sent = edit.save(context);
  // A control the maintainer reached before the pass held it still.
  edit.stage(key, context.tracking, { closureReason: 'not a vulnerability' });
  land();
  const outcome = await sent;

  assert.ok(outcome.ok === true, `the save failed: ${outcome.message}`);
  const snapshot = sentSnapshot(talk.calls);
  assert.strictEqual(snapshot['triage'], 'evaluating');
  assert.strictEqual(snapshot['closure'], undefined, 'the write carried a value staged after it');
  assert.strictEqual(
    edit.editsFor(key).closureReason,
    'not a vulnerability',
    'a value staged while the write was out was dropped'
  );
  assert.strictEqual(edit.editsFor(key).triage, undefined, 'the written value stayed staged');
  assert.strictEqual(edit.results.get(key)?.message, 'Saved.');
  forget();
});

test('a save drops a confirmation the page stopped backing', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const talk = session(fixture('triage-thread.html'));
  const first = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  tick(control(first.editor, 'input.bghsa-confirm-title'), true);
  const key = edit.keyOf(first.context.advisory);

  const field = page.querySelector('[name="repository_advisory[title]"]');
  if (field === null) throw new Error('the fixture carries no title field');
  field.remove();
  const second = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
  });
  choose(control(second.editor, 'select.bghsa-triage'), 'evaluating');
  const outcome = await edit.save(second.context);

  assert.ok(outcome.ok === true, `the save failed: ${outcome.message}`);
  assert.strictEqual(sentSnapshot(talk.calls)['triage'], 'evaluating');
  assert.strictEqual(
    edit.editsFor(key).confirm?.title,
    undefined,
    'the tick the page cannot back outlived the pass that cleared it'
  );
  assert.strictEqual(edit.results.get(key)?.message, 'Saved.');
  forget();
});

/**
 * Puts the writer out of action the way an environment failure does, and puts
 * it back whatever the caller did.
 *
 * @param {() => Promise<void>} body
 * @returns {Promise<void>}
 */
async function withBrokenWriter(body) {
  const real = globalThis.bghsa.state.writeState;
  globalThis.bghsa.state.writeState = async () => {
    throw new TypeError('crypto.subtle is undefined');
  };
  try {
    await body();
  } finally {
    globalThis.bghsa.state.writeState = real;
  }
}

test('a save that threw is recorded and asks for a pass', async () => {
  forget();
  const page = fixture('triage-thread.html');
  let passes = 0;
  const { editor, context } = await editorFor(page, {
    rerender: () => {
      passes += 1;
    },
  });
  const key = edit.keyOf(context.advisory);
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');

  await withBrokenWriter(async () => {
    const outcome = await edit.save(context);
    assert.ok(outcome.ok === false, 'a save that threw came back as a write that landed');
    assert.ok(outcome.reason === 'failed', `the save came back as ${outcome.reason}`);
    assert.strictEqual(outcome.message, 'Error: failed to validate save');
  });
  assert.strictEqual(passes, 1, 'the save asked for no pass');
  assert.ok(!edit.saving.has(key), 'the panel is still marked as writing');
  assert.strictEqual(edit.editsFor(key).triage, 'evaluating', 'the change was thrown away');
  forget();
});

test('a save whose render pass throws still settles', async () => {
  forget();
  const { page, talk } = pair('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
    rerender: () => {
      throw new Error('the pass failed');
    },
  });
  const key = edit.keyOf(context.advisory);
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');
  const outcome = await edit.save(context);

  assert.ok(outcome.ok === true, `the save failed: ${outcome.message}`);
  assert.strictEqual(talk.posts().length, 1, 'the save wrote more than one comment');
  assert.ok(!edit.saving.has(key), 'the panel is still marked as writing');
  forget();
});

test('a save that ended in an error leaves the panel usable', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const { editor, context } = await editorFor(page, {
    rerender: () => {
      throw new Error('the pass failed');
    },
  });
  const key = edit.keyOf(context.advisory);
  choose(control(editor, 'select.bghsa-triage'), 'evaluating');

  await withBrokenWriter(async () => {
    /** @type {HTMLElement} */ (
      /** @type {unknown} */ (control(editor, 'button.bghsa-save'))
    ).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.ok(!edit.saving.has(key), 'the panel is still marked as writing');
  assert.ok(
    note(editor).includes('Error: failed to validate save'),
    `the panel says: ${note(editor)}`
  );
  assert.strictEqual(
    control(editor, 'select.bghsa-triage').hasAttribute('disabled'),
    false,
    'the flight kept the controls it took'
  );
  assert.strictEqual(
    control(editor, 'button.bghsa-save').hasAttribute('disabled'),
    false,
    'the panel offers no way to try again'
  );
  forget();
});

test('an unsaved change survives a render pass', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const first = await panel.render(page);
  assert.ok(first !== null, 'the fixture offered no anchor');
  choose(control(/** @type {Element} */ (first), 'select.bghsa-triage'), 'evaluating');
  type(control(/** @type {Element} */ (first), 'input.bghsa-owner-input'), 'yaroslavk');
  /** @type {HTMLElement} */ (
    /** @type {unknown} */ (control(/** @type {Element} */ (first), 'button.bghsa-owner-add'))
  ).click();

  const second = await panel.render(page);
  assert.ok(second !== null, 'the second pass placed no panel');
  const rebuilt = /** @type {Element} */ (second);
  assert.ok(rebuilt !== first, 'the pass did not rebuild the panel');
  assert.strictEqual(
    /** @type {{ value?: unknown }} */ (
      /** @type {unknown} */ (control(rebuilt, 'select.bghsa-triage'))
    ).value,
    'evaluating'
  );
  assert.deepStrictEqual(
    Array.from(rebuilt.querySelectorAll('.bghsa-owner .Label')).map((label) => text(label)),
    ['samuelkarp', 'yaroslavk']
  );
  assert.strictEqual(note(rebuilt), 'Unsaved changes: Triage, Owners.');
  forget();
});

test('the panel still does not name the author of an untrusted snapshot', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const placed = await panel.render(page);
  assert.ok(placed !== null, 'the fixture offered no anchor');
  assert.ok(
    !text(/** @type {Element} */ (placed)).includes('prakleumas'),
    'the panel names the author of an untrusted snapshot'
  );
  forget();
});

test('the changes carry a confirmation only where a fingerprint stands behind it', () => {
  const view = tracking.untracked();
  const changes = edit.changesOf(
    view,
    { title: null, description: 'aaaaaaaaaaaa', scoring: null },
    { confirm: { title: true, description: true, scoring: true } },
    { by: 'samuelkarp', at: AT }
  );
  assert.deepStrictEqual(changes['confirmed'], {
    description: { by: 'samuelkarp', at: AT, fp: 'aaaaaaaaaaaa' },
  });
});

/**
 * @param {Document} doc
 * @param {string} type
 * @returns {Event} an event a handler can cancel.
 */
function cancelable(doc, type) {
  const view = doc.defaultView;
  if (view === null || view === undefined) throw new Error('the document has no view');
  return new view.Event(type, { bubbles: true, cancelable: true });
}

test('leaving the page with changes that were never written warns', async () => {
  forget();
  const { page } = pair('triage-thread.html');
  const { editor } = await editorFor(page);
  const disarm = edit.armNavigationWarning(page, { confirm: () => true });
  try {
    const clean = cancelable(page, 'beforeunload');
    page.defaultView?.dispatchEvent(clean);
    assert.strictEqual(clean.defaultPrevented, false, 'a panel with nothing to save warned');

    choose(control(editor, 'select.bghsa-triage'), 'evaluating');
    const dirty = cancelable(page, 'beforeunload');
    page.defaultView?.dispatchEvent(dirty);
    assert.strictEqual(dirty.defaultPrevented, true, 'unsaved changes did not warn');
    assert.strictEqual(
      /** @type {{ returnValue?: unknown }} */ (/** @type {unknown} */ (dirty)).returnValue,
      ''
    );
  } finally {
    disarm();
    forget();
  }
});

test('a link GitHub would follow without a load is asked about first', async () => {
  forget();
  const { page } = pair('triage-thread.html');
  const { editor } = await editorFor(page);
  const link = page.createElement('a');
  link.setAttribute('href', '/git-utensils/Spoon-Knife/security/advisories');
  page.body?.append(link);
  /** @type {string[]} */
  const asked = [];
  let answer = false;
  const disarm = edit.armNavigationWarning(page, {
    confirm: (message) => {
      asked.push(message);
      return answer;
    },
  });
  try {
    const clean = cancelable(page, 'click');
    link.dispatchEvent(clean);
    assert.strictEqual(asked.length, 0, 'a panel with nothing to save asked');
    assert.strictEqual(clean.defaultPrevented, false);

    choose(control(editor, 'select.bghsa-triage'), 'evaluating');
    const stopped = cancelable(page, 'click');
    link.dispatchEvent(stopped);
    assert.deepStrictEqual(asked, ['Better GHSA: Leave without saving your changes?']);
    assert.strictEqual(stopped.defaultPrevented, true, 'the navigation went ahead');

    answer = true;
    const allowed = cancelable(page, 'click');
    link.dispatchEvent(allowed);
    assert.strictEqual(asked.length, 2);
    assert.strictEqual(allowed.defaultPrevented, false, 'the navigation was stopped anyway');
  } finally {
    disarm();
    link.remove();
    forget();
  }
});

test('a move within the page and a press on the panel are not navigation', async () => {
  forget();
  const { page } = pair('triage-thread.html');
  const { editor } = await editorFor(page);
  page.body?.append(editor);
  const fragment = page.createElement('a');
  fragment.setAttribute('href', '#advisory-comment-282847');
  page.body?.append(fragment);
  let asked = 0;
  const disarm = edit.armNavigationWarning(page, {
    confirm: () => {
      asked += 1;
      return true;
    },
  });
  try {
    choose(control(editor, 'select.bghsa-triage'), 'evaluating');
    fragment.dispatchEvent(cancelable(page, 'click'));
    control(editor, 'button.bghsa-discard').dispatchEvent(cancelable(page, 'click'));
    assert.strictEqual(asked, 0, 'a click that stays on the page asked about leaving');
  } finally {
    disarm();
    fragment.remove();
    editor.remove();
    forget();
  }
});

test('a link opened somewhere else leaves the panel where it is', async () => {
  forget();
  const { page } = pair('triage-thread.html');
  const { editor } = await editorFor(page);
  const link = page.createElement('a');
  link.setAttribute('href', '/git-utensils/Spoon-Knife');
  link.setAttribute('target', '_blank');
  page.body?.append(link);
  let asked = 0;
  const disarm = edit.armNavigationWarning(page, {
    confirm: () => {
      asked += 1;
      return true;
    },
  });
  try {
    choose(control(editor, 'select.bghsa-triage'), 'evaluating');
    link.dispatchEvent(cancelable(page, 'click'));
    assert.strictEqual(asked, 0, 'a link opening a second tab asked about leaving');
  } finally {
    disarm();
    link.remove();
    forget();
  }
});

/**
 * A click carrying what the pointer held: a button other than the primary one,
 * or a modifier key.
 *
 * @param {Document} doc
 * @param {Record<string, unknown>} held
 * @returns {Event}
 */
function pointer(doc, held) {
  const event = cancelable(doc, 'click');
  for (const [name, value] of Object.entries(held)) {
    Object.defineProperty(event, name, { value, configurable: true });
  }
  return event;
}

test('a click the browser answers elsewhere leaves the panel where it is', async () => {
  forget();
  const { page } = pair('triage-thread.html');
  const { editor } = await editorFor(page);
  const link = page.createElement('a');
  link.setAttribute('href', '/git-utensils/Spoon-Knife/security/advisories');
  page.body?.append(link);
  const file = page.createElement('a');
  file.setAttribute('href', '/git-utensils/Spoon-Knife/archive/main.zip');
  file.setAttribute('download', '');
  page.body?.append(file);
  let asked = 0;
  const disarm = edit.armNavigationWarning(page, {
    confirm: () => {
      asked += 1;
      return true;
    },
  });
  try {
    choose(control(editor, 'select.bghsa-triage'), 'evaluating');
    // Each of these opens the link somewhere else, so the panel and the change
    // in it are still in front of the maintainer.
    const elsewhere = {
      'the middle button': { button: 1 },
      'command held': { metaKey: true },
      'control held': { ctrlKey: true },
      'shift held': { shiftKey: true },
      'alt held': { altKey: true },
    };
    for (const [what, held] of Object.entries(elsewhere)) {
      link.dispatchEvent(pointer(page, held));
      assert.strictEqual(asked, 0, `${what} asked about leaving`);
    }
    // A download takes the file and leaves the page showing.
    file.dispatchEvent(cancelable(page, 'click'));
    assert.strictEqual(asked, 0, 'a download asked about leaving');

    // The same link pressed with nothing held is the departure this warns on.
    link.dispatchEvent(cancelable(page, 'click'));
    assert.strictEqual(asked, 1, 'a plain press did not ask about leaving');
  } finally {
    disarm();
    link.remove();
    file.remove();
    forget();
  }
});

/**
 * The panel on an advisory page holding a change in a control that was never
 * saved, which is what a maintainer leaves behind by walking away from it.
 *
 * @param {string} name
 * @returns {Promise<{ page: Document, key: string }>}
 */
async function unsavedPanel(name) {
  const page = fixture(name);
  const placed = await panel.render(page);
  if (placed === null) throw new Error('the fixture got no panel');
  choose(control(placed, 'select.bghsa-triage'), 'evaluating');
  const advisory = parse.parseDetail(page);
  if (advisory === null) throw new Error('the fixture is not an advisory detail page');
  const key = edit.keyOf(advisory);
  if (!edit.pendingOn(key)) throw new Error('the control change was not held');
  return { page, key };
}

/** One row of the advisory list, as GitHub puts it in the content frame. */
const LIST_MARKUP =
  '<div id="advisories"><div class="Box-row Box-row--drag-hide">' +
  '<a class="Link--primary" href="/git-utensils/Spoon-Knife/security/advisories/' +
  'GHSA-2222-2222-2222">Another advisory</a></div></div>';

/**
 * GitHub replacing the content frame, which is how the advisory list arrives
 * with no document load and no press on a link: the advisory leaves the frame,
 * the panel goes with it, and the render loop takes the pass that finds a page
 * showing no advisory.
 *
 * @param {Document} page
 * @returns {Promise<Element>} the advisory the list offers to open next.
 */
async function leaveAdvisory(page) {
  const content = page.querySelector('div.new-discussion-timeline');
  if (content === null) throw new Error('the fixture carries no content frame');
  content.innerHTML = LIST_MARKUP;
  await panel.render(page);
  if (parse.parseDetail(page) !== null) throw new Error('the advisory is still on the page');
  const next = content.querySelector('a[href]');
  if (next === null) throw new Error('the list offers no advisory to open');
  return next;
}

test('the page holding unsaved changes is the page that asks about them', async () => {
  forget();
  const { page, key } = await unsavedPanel('triage-thread.html');
  /** @type {string[]} */
  const asked = [];
  const disarm = edit.armNavigationWarning(page, {
    confirm: (message) => {
      asked.push(message);
      return false;
    },
  });
  try {
    const next = await leaveAdvisory(page);
    assert.deepStrictEqual(
      asked,
      ['Better GHSA: Leave without saving your changes?'],
      'leaving the advisory asked nothing'
    );
    assert.strictEqual(edit.anyPending(), true, 'changes the maintainer kept were dropped');

    // The advisory list is not the page the changes were left on, and opening
    // another advisory from it is not the navigation that left them.
    next.dispatchEvent(cancelable(page, 'click'));
    assert.deepStrictEqual(
      asked,
      ['Better GHSA: Leave without saving your changes?'],
      'the next navigation asked again'
    );

    // The same press on the same link asks while the advisory holding the
    // changes is the one showing, so it is the departure that quieted it and
    // not a guard that stopped listening.
    edit.panelShows(key);
    next.dispatchEvent(cancelable(page, 'click'));
    assert.strictEqual(asked.length, 2, 'the guard heard nothing on the page it is armed for');
  } finally {
    disarm();
    forget();
  }
});

test('changes the maintainer leaves behind are left behind', async () => {
  forget();
  const { page } = await unsavedPanel('triage-thread.html');
  let asked = 0;
  const disarm = edit.armNavigationWarning(page, {
    confirm: () => {
      asked += 1;
      return true;
    },
  });
  try {
    await leaveAdvisory(page);
    assert.strictEqual(asked, 1, 'leaving the advisory asked once');
    assert.strictEqual(edit.anyPending(), false, 'the changes are still staged');
  } finally {
    disarm();
    forget();
  }
});

test('a confirmation to supersede is not work to warn about', async () => {
  forget();
  const { page } = pair('draft.html');
  const { editor } = await editorFor(page);
  tick(control(editor, 'input.bghsa-supersede'), true);
  assert.strictEqual(edit.anyPending(), false);
  forget();
});

/** The list row the table builds this advisory's row on top of. */
const LIST_ROW = {
  ghsaId: 'GHSA-jmvx-2wfw-xfgj',
  owner: 'git-utensils',
  repo: 'Spoon-Knife',
  href: '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj',
  title: 'What the list row says',
  state: 'Triage',
  severity: 'high',
  severityLabel: 'High',
  severityClass: 'Label--orange',
  openedAt: '2026-08-01T00:00:00Z',
  reporter: 'prakleumas',
};

test('a refused save leaves the cache holding the page the write read', async () => {
  forget();
  const readAt = Date.parse('2026-08-26T11:00:00Z');
  cache.setStorage(fakeStorage());
  cache.setClock(() => readAt);
  try {
    const { page, talk } = pair('triage-thread.html');
    const wiring = { fetch: talk.fetch, parseDocument: talk.parseDocument };
    const { editor, context } = await editorFor(page, wiring);
    choose(control(editor, 'select.bghsa-triage'), 'evaluating');
    const ref = /** @type {import('../src/common/parse-detail.js').AdvisoryRef} */ (
      context.advisory.ref
    );
    assert.strictEqual(await cache.getAdvisory(ref), null, 'the cache already held the advisory');

    const stale = { ...context, merged: { ...context.merged, observedSeq: 5, nextSeq: 6 } };
    const refusal = await edit.save(stale);
    assert.strictEqual(refusal.ok, false);
    assert.strictEqual(refusal.reason, 'stale');
    assert.strictEqual(talk.posts().length, 0, 'a refused write reached the comment');

    // The request was spent on reading the advisory, so what it read is held:
    // the panel reloads from it, and so does every other surface.
    const entry = await cache.getAdvisory(ref);
    assert.ok(entry !== null, 'a refused write left the page it read nowhere');
    assert.strictEqual(entry.observedAt, readAt, 'the entry carries another moment');
    const held = record.advisoryFrom(entry.record);
    assert.ok(held !== null, 'the entry holds nothing the cache can read back');
    assert.strictEqual(merge.mergeSnapshots(held.comments).observedSeq, 7);
  } finally {
    cache.setStorage(null);
    cache.setClock(null);
    forget();
  }
});

test('a superseded refusal leaves the cache holding the page the write read', async () => {
  // The stale case above is a refusal at a sequence number the advisory has
  // moved past, so the document is plainly behind. A superseded refusal is the
  // other shape: the rival claimed the same sequence number this panel loaded
  // with, so the document and what the refusal read agree on the number and
  // disagree on whose snapshot it is. The next pass over the document must not
  // put the document over what the refusal read.
  forget();
  const readAt = Date.parse('2026-08-26T11:00:00Z');
  cache.setStorage(fakeStorage());
  cache.setClock(() => readAt);
  try {
    const page = fixture('triage-thread.html');
    const remote = fixture('triage-thread.html');
    const talk = session(remote);
    const wiring = { fetch: talk.fetch, parseDocument: talk.parseDocument };
    const { editor, context } = await editorFor(page, wiring);
    const ref = /** @type {import('../src/common/parse-detail.js').AdvisoryRef} */ (
      context.advisory.ref
    );
    const key = edit.keyOf(context.advisory);
    assert.strictEqual(context.merged.observedSeq, 7);

    // Another maintainer claimed the sequence this panel loaded with, and the
    // tie on GitHub goes to the greater login.
    rivalSnapshot(remote, 7, 'awaiting maintainer input');
    choose(control(editor, 'select.bghsa-triage'), 'evaluating');
    const refusal = await edit.save(context);
    assert.strictEqual(refusal.ok, false);
    assert.strictEqual(refusal.reason, 'superseded');
    assert.strictEqual(talk.posts().length, 0, 'a refused write reached the comment');

    const held = await cache.getAdvisory(ref);
    assert.ok(held !== null, 'the refusal left the page it read nowhere');
    const readBack = record.advisoryFrom(held.record);
    assert.ok(readBack !== null, 'the entry holds nothing the cache can read back');
    assert.strictEqual(
      tracking.read(merge.mergeSnapshots(readBack.comments).state, {
        title: null,
        description: null,
        scoring: null,
      }).triage,
      'awaiting maintainer input',
      'the refusal stored something other than the rival state its fetch read'
    );

    // The pass the reload runs, over the document the refusal did not change.
    // It carries this maintainer's own snapshot at the same sequence number.
    assert.ok(
      (await panel.remember(context.advisory)) === null,
      'the pass stored the document over the state the refusal read'
    );
    assert.strictEqual(
      edit.preferred(key, merge.mergeSnapshots(context.advisory.comments)).observedSeq,
      7
    );
    const after = await cache.getAdvisory(ref);
    assert.ok(after !== null, 'the pass emptied the entry');
    const stillHeld = record.advisoryFrom(after.record);
    assert.ok(stillHeld !== null, 'the entry holds nothing the cache can read back');
    assert.strictEqual(
      tracking.read(merge.mergeSnapshots(stillHeld.comments).state, {
        title: null,
        description: null,
        scoring: null,
      }).triage,
      'awaiting maintainer input',
      'the pass put the document over the state the refusal read'
    );
  } finally {
    cache.setStorage(null);
    cache.setClock(null);
    forget();
  }
});

test('a save that landed leaves the list building the row from what it wrote', async () => {
  forget();
  const storage = fakeStorage();
  let clockAt = Date.parse('2026-08-26T11:00:00Z');
  cache.setStorage(storage);
  cache.setClock(() => clockAt);
  try {
    const { page, talk } = pair('triage-thread.html');
    const wiring = { fetch: talk.fetch, parseDocument: talk.parseDocument };
    // The pass that placed the panel, which holds the advisory as this page
    // shows it. The fixture's embargo lifts on the thirtieth of September.
    await panel.render(page);
    const { editor, context } = await editorFor(page, {
      ...wiring,
      rerender: async () => {
        await panel.render(page);
      },
    });
    type(control(editor, 'input.bghsa-embargo-lift'), '2026-08-01');
    const outcome = await edit.save(context);
    assert.ok(outcome.ok === true, `the save failed: ${outcome.message}`);
    assert.deepStrictEqual(sentSnapshot(talk.calls)['embargo'], { lift: '2026-08-01' });

    const ref = /** @type {import('../src/common/parse-detail.js').AdvisoryRef} */ (
      context.advisory.ref
    );
    // A later pass over the same document, which still does not carry the
    // comment the save wrote. What it parses to is not an observation of this
    // advisory, and the entry the write left stands at the moment it was read.
    const wroteAt = clockAt;
    clockAt += 4 * 60 * 1000;
    await panel.render(page);

    const entry = await cache.getAdvisory(ref);
    assert.ok(entry !== null, 'the cache holds no entry for the advisory that was written to');
    assert.strictEqual(
      entry.observedAt,
      wroteAt,
      'the entry was restamped with the document the write is not in'
    );
    const row = await table.viewRow({ row: LIST_ROW, seenAt: cache.now() }, entry, cache.now());

    assert.strictEqual(row.embargo, true, 'the row carries no embargo');
    assert.strictEqual(
      row.embargoLift,
      '2026-08-01',
      `the row was built from state the save replaced: ${row.embargoLift}`
    );
  } finally {
    cache.setStorage(null);
    cache.setClock(null);
    forget();
  }
});

test('a refused edit exposes copyable structural diagnostics without page data', async () => {
  forget();
  const page = fixture('triage-thread.html');
  const remote = fixture('triage-thread.html');
  for (const field of remote.querySelectorAll('[name="repository_advisory_comment[bodyVersion]"]')) {
    field.remove();
  }
  for (const field of remote.querySelectorAll('[name="authenticity_token"]')) {
    field.setAttribute('value', 'SYNTHETIC-SECRET-TOKEN');
  }
  const talk = session(remote);
  const contextOptions = { fetch: talk.fetch, parseDocument: talk.parseDocument };
  const first = await editorFor(page, contextOptions);
  choose(control(first.editor, 'select.bghsa-triage'), 'evaluating');
  const outcome = await edit.save(first.context);
  assert.strictEqual(outcome.reason, 'no-token');
  assert.strictEqual(talk.posts().length, 0);
  const next = await editorFor(page, contextOptions);
  assert.strictEqual(text(control(next.editor, '.bghsa-save-result')), 'Error: unexpected edit form fields');
  const details = control(next.editor, 'details.bghsa-diagnostic');
  assert.strictEqual(details.hasAttribute('open'), false);
  assert.strictEqual(text(control(details, 'summary')), 'Diagnostic details');
  const report = control(details, 'pre').textContent;
  assert.strictEqual(report, [
    'Extension: unknown',
    'Operation: edit tracking comment',
    'Diagnostic: edit-form-missing-fields',
    'Missing: repository_advisory_comment[bodyVersion]',
    'Comment POST sent: no',
  ].join('\n'));
  assert.ok(!report?.includes('SYNTHETIC-SECRET-TOKEN'));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  /** @type {string[]} */
  const copied = [];
  let reject = false;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (/** @type {string} */ value) => {
      if (reject) throw new Error('clipboard unavailable');
      copied.push(value);
    } } },
  });
  try {
    press(next.editor, '.bghsa-copy-diagnostic');
    await until(() => text(control(details, '.bghsa-copy-status')) === 'Copied.');
    assert.deepStrictEqual(copied, [report]);
    reject = true;
    press(next.editor, '.bghsa-copy-diagnostic');
    await until(() => text(control(details, '.bghsa-copy-status')).startsWith('Unable to copy.'));
    assert.strictEqual(control(details, 'pre').textContent, report);
    assert.strictEqual(control(details, 'button').hasAttribute('disabled'), false);
  } finally {
    if (previous !== undefined) Object.defineProperty(globalThis, 'navigator', previous);
    else Reflect.deleteProperty(globalThis, 'navigator');
    forget();
  }
});

for (const operation of ['create', 'edit']) {
  test(`a missing ${operation} form uses the collapsed copyable diagnostic`, async () => {
    forget();
    const page = fixture('triage-thread.html');
    const remote = fixture('triage-thread.html');
    if (operation === 'create') {
      for (const doc of [page, remote]) {
        for (const comment of doc.querySelectorAll('.timeline-comment-group[id^="advisory-comment-"]')) {
          comment.remove();
        }
      }
      const form = write.findCommentForm(remote);
      assert.ok(form !== null);
      form.remove();
    } else {
      for (const form of remote.querySelectorAll('form[id$="-edit-form"]')) form.remove();
    }
    const talk = session(remote);
    const options = { fetch: talk.fetch, parseDocument: talk.parseDocument };
    const first = await editorFor(page, options);
    choose(control(first.editor, 'select.bghsa-triage'), 'evaluating');
    const outcome = await edit.save(first.context);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(talk.posts().length, 0, 'a request went out despite the missing form');
    const next = await editorFor(page, options);
    assert.strictEqual(text(control(next.editor, '.bghsa-save-result')), operation === 'create'
      ? 'Error: cannot identify logged-in user' : 'Error: cannot post');
    const details = control(next.editor, 'details.bghsa-diagnostic');
    assert.strictEqual(details.hasAttribute('open'), false);
    assert.strictEqual(next.editor.querySelectorAll('.bghsa-diagnostic').length, 1);
    assert.strictEqual(text(control(details, 'summary')), 'Diagnostic details');
    const report = [
      'Extension: unknown',
      operation === 'create' ? 'Operation: save tracking state' : 'Operation: edit tracking comment',
      operation === 'create' ? 'Diagnostic: comment-form-missing' : 'Diagnostic: edit-form-missing',
      operation === 'create' ? 'Missing: new comment form' : 'Missing: edit comment form',
      ...(operation === 'edit' ? ['Target comment found: yes'] : []),
      'Comment POST sent: no',
    ].join('\n');
    assert.strictEqual(control(details, 'pre').textContent, report);
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    /** @type {string[]} */
    const copied = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async (/** @type {string} */ value) => { copied.push(value); } } },
    });
    try {
      press(next.editor, '.bghsa-copy-diagnostic');
      await until(() => text(control(details, '.bghsa-copy-status')) === 'Copied.');
      assert.deepStrictEqual(copied, [report]);
    } finally {
      if (previous !== undefined) Object.defineProperty(globalThis, 'navigator', previous);
      else Reflect.deleteProperty(globalThis, 'navigator');
      forget();
    }
  });
}

for (const responseKind of ['missing', 'different', 'unreadable']) {
  test(`an unconfirmed save with a ${responseKind} response has copyable diagnostics`, async () => {
    forget();
    const page = fixture('triage-thread.html');
    const remote = fixture('triage-thread.html');
    const talk = session(remote);
    /** @type {import('../src/common/write.js').WriteFetch} */
    const fetch = async (url, init) => {
      const response = await talk.fetch(url, init);
      if (init.method !== 'POST') return response;
      // GitHub saved the comment, but its response cannot confirm the save.
      return { status: 202, text: async () => {
        if (responseKind === 'unreadable') throw new Error('PRIVATE RESPONSE ERROR');
        return responseKind === 'different'
          ? '<div class="comment-body">PRIVATE RESPONSE TEXT</div>'
          : '<div>PRIVATE RESPONSE TEXT</div>';
      } };
    };
    const options = { fetch, parseDocument: talk.parseDocument };
    const first = await editorFor(page, options);
    choose(control(first.editor, 'select.bghsa-triage'), 'evaluating');
    const outcome = await edit.save(first.context);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.reason, 'unwritten');
    assert.strictEqual(talk.posts().length, 1, 'the save sent more than one POST');
    const next = await editorFor(page, options);
    assert.strictEqual(text(control(next.editor, '.bghsa-save-result')), 'Error: failed to validate save');
    const details = control(next.editor, 'details.bghsa-diagnostic');
    assert.strictEqual(details.hasAttribute('open'), false);
    const expected = [
      'Extension: unknown',
      'Operation: save tracking state',
      'Diagnostic: save-unconfirmed',
      'HTTP response status: 202',
      `Matching response containers found: ${responseKind === 'unreadable' ? 'unknown' : responseKind === 'different' ? 'yes' : 'no'}`,
      `Expected content found in one matching container: ${responseKind === 'unreadable' ? 'unknown' : 'no'}`,
      'Save unconfirmed: the comment may have been saved.',
      'Comment POST sent: yes',
    ].join('\n');
    assert.strictEqual(control(details, 'pre').textContent, expected);
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    /** @type {string[]} */
    const copied = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async (/** @type {string} */ value) => { copied.push(value); } } },
    });
    try {
      press(next.editor, '.bghsa-copy-diagnostic');
      await until(() => text(control(details, '.bghsa-copy-status')) === 'Copied.');
      assert.deepStrictEqual(copied, [expected]);
    } finally {
      if (previous !== undefined) Object.defineProperty(globalThis, 'navigator', previous);
      else Reflect.deleteProperty(globalThis, 'navigator');
      forget();
    }
  });
}

for (const operation of ['create', 'edit']) {
  test(`an unexpected ${operation} destination uses the collapsed diagnostic`, async () => {
    forget();
    const page = fixture('triage-thread.html');
    const remote = fixture('triage-thread.html');
    if (operation === 'create') {
      for (const doc of [page, remote]) {
        for (const comment of doc.querySelectorAll('.timeline-comment-group[id^="advisory-comment-"]')) {
          comment.remove();
        }
      }
      const form = write.findCommentForm(remote);
      assert.ok(form !== null);
      form.setAttribute('action', '/PRIVATE/REPO/security/advisories/GHSA-0000-0000-0000/comments');
    } else {
      const form = remote.getElementById(`${OWN_COMMENT}-edit-form`);
      assert.ok(form !== null);
      form.setAttribute('action', form.getAttribute('action')?.replace(/\d+$/, '999999') ?? '');
    }
    const talk = session(remote);
    const options = { fetch: talk.fetch, parseDocument: talk.parseDocument };
    const first = await editorFor(page, options);
    choose(control(first.editor, 'select.bghsa-triage'), 'evaluating');
    const outcome = await edit.save(first.context);
    assert.strictEqual(outcome.reason, 'mismatch');
    assert.strictEqual(talk.posts().length, 0);
    const next = await editorFor(page, options);
    assert.strictEqual(text(control(next.editor, '.bghsa-save-result')), operation === 'create'
      ? 'Error: unexpected comment form destination' : 'Error: unexpected edit form destination');
    const details = control(next.editor, 'details.bghsa-diagnostic');
    assert.strictEqual(details.hasAttribute('open'), false);
    const report = [
      'Extension: unknown',
      `Operation: ${operation} tracking comment`,
      'Diagnostic: form-destination-mismatch',
      operation === 'create'
        ? 'Failed check: destination path matches the advisory comment endpoint'
        : 'Failed check: destination path matches the target comment',
      'Comment POST sent: no',
    ].join('\n');
    assert.strictEqual(control(details, 'pre').textContent, report);
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    /** @type {string[]} */
    const copied = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async (/** @type {string} */ value) => { copied.push(value); } } },
    });
    try {
      press(next.editor, '.bghsa-copy-diagnostic');
      await until(() => text(control(details, '.bghsa-copy-status')) === 'Copied.');
      assert.deepStrictEqual(copied, [report]);
    } finally {
      if (previous !== undefined) Object.defineProperty(globalThis, 'navigator', previous);
      else Reflect.deleteProperty(globalThis, 'navigator');
      forget();
    }
  });
}
