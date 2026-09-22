'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');
const schema = require('../src/common/schema.js');
const write = require('../src/common/write.js');
const merge = require('../src/common/merge.js');
const state = require('../src/detail/state.js');
const members = require('../src/common/members.js');
const record = require('../src/common/record.js');
const cache = require('../src/common/cache.js');

const allowlist = require('../src/common/allowlist.js');

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

const REF = { owner: 'git-utensils', repo: 'Spoon-Knife', ghsaId: 'GHSA-jmvx-2wfw-xfgj' };

const DRAFT_REF = { owner: 'git-utensils', repo: 'Spoon-Knife', ghsaId: 'GHSA-5hg2-rfq2-8fm5' };

const OBSERVED = 7;

const OWN_SEQ = 3;

const AT = '2026-08-26T11:00:00Z';

const OWN_ID = '282847';

const OTHER_ID = '282848';

const DRAFT_COMMENT = 'advisory-comment-282849';

const MEMBER_ACTION = '2026-08-25T22:20:26Z';

const PAGE_HTML = '<<the advisory page>>';

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render the marker as a code span and the JSON as a highlighted pre.
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
 * @returns {string} the comment body the request carries, whichever field it
 *   travels in.
 */
function postedBody(params) {
  return params.get('body') ?? params.get(write.EDIT_BODY_FIELD) ?? '';
}

/**
 * @typedef {(params: URLSearchParams) => { status: number, html: string }} Answer
 */

/** @type {Answer} */
const echo = (params) => ({ status: 200, html: renderStateComment(postedBody(params)) });

/**
 * Update the document returned by subsequent reads.
 * GitHub repeats the comment body for different responsive layouts.
 *
 * @param {Document} page
 * @param {string} elementId The comment the write edits.
 * @returns {Answer}
 */
function landing(page, elementId) {
  return (params) => {
    const written = /```json\n([\s\S]*?)\n```/.exec(postedBody(params))?.[1];
    if (written !== undefined) {
      for (const fence of page.querySelectorAll(`#${elementId} .highlight-source-json pre`)) {
        fence.textContent = written;
      }
    }
    return echo(params);
  };
}

/**
 * Return `page` for advisory reads and use `answer` for comment writes.
 *
 * @param {Document} page
 * @param {Answer} [answer]
 * @returns {{
 *   fetch: import('../src/common/write.js').WriteFetch,
 *   parseDocument: (html: string) => Document,
 *   calls: Array<{ url: string, init: RequestInit }>,
 * }}
 */
function session(page, answer) {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  const reply = answer ?? echo;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if ((init.method ?? 'GET') === 'GET') return { status: 200, text: async () => PAGE_HTML };
      const written = reply(/** @type {URLSearchParams} */ (/** @type {unknown} */ (init.body)));
      return { status: written.status, text: async () => written.html };
    },
    parseDocument: (html) => (html === PAGE_HTML ? page : document(html)),
  };
}

/**
 * @param {Document} page
 * @param {Partial<import('../src/detail/state.js').StateWriteOptions>} overrides
 * @param {Answer} [answer]
 * @returns {Promise<{
 *   outcome: import('../src/detail/state.js').StateWriteResult,
 *   calls: Array<{ url: string, init: RequestInit }>,
 * }>}
 */
async function run(page, overrides, answer) {
  const talk = session(page, answer);
  const outcome = await state.writeState({
    ref: REF,
    loadedSeq: OBSERVED,
    changes: {},
    at: AT,
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
    ...overrides,
  });
  return { outcome, calls: talk.calls };
}

/**
 * @param {Array<{ url: string, init: RequestInit }>} calls
 * @returns {URLSearchParams} the parameters the comment request carried.
 */
function sent(calls) {
  const post = calls.find((call) => call.init.method === 'POST');
  if (post === undefined) throw new Error('no comment request went out');
  return /** @type {URLSearchParams} */ (/** @type {unknown} */ (post.init.body));
}

/**
 * @param {Array<{ url: string, init: RequestInit }>} calls
 * @returns {string} the URL the comment request went to.
 */
function target(calls) {
  const post = calls.find((call) => call.init.method === 'POST');
  if (post === undefined) throw new Error('no comment request went out');
  return post.url;
}

/** @returns {Document} the triage advisory, parsed for one test to change. */
function triagePage() {
  return fixture('triage-thread.html');
}

/**
 * @param {Document} page
 * @param {string} login The signed-in account.
 * @returns {void}
 */
function signIn(page, login) {
  const link = page.querySelector('div.timeline-new-comment span.timeline-comment-avatar a');
  if (link === null) throw new Error('the page carries no new-comment box');
  link.setAttribute('href', `/${login}`);
  const image = link.querySelector('img[alt]');
  if (image !== null) image.setAttribute('alt', `@${login}`);
}

/**
 * Replace the second state comment with a member snapshot at OWN_SEQ.
 * The login determines which snapshot wins the tie.
 *
 * @param {Document} page
 * @param {string} login The snapshot author.
 * @returns {void}
 */
function rival(page, login) {
  const group = page.querySelector(`#advisory-comment-${OTHER_ID}`);
  if (group === null) throw new Error('the fixture carries a second state comment');
  for (const link of group.querySelectorAll('a.author')) link.setAttribute('href', `/${login}`);
  for (const badge of group.querySelectorAll('span.Label')) {
    if (badge.closest('.comment-body') === null) badge.textContent = 'Member';
  }
  const snapshot = JSON.stringify(
    {
      betterGhsa: '1.0',
      seq: OWN_SEQ,
      by: login,
      at: '2026-08-25T19:00:00Z',
      triage: 'evaluating',
      triageSince: '2026-08-25T19:00:00Z',
      owners: [login],
      confirmed: {},
      backports: [],
    },
    null,
    2
  );
  for (const fence of group.querySelectorAll('.highlight-source-json pre')) {
    fence.textContent = snapshot;
  }
}

test('a write edits the state comment the signed-in maintainer wrote', async () => {
  const { outcome, calls } = await run(triagePage(), {
    changes: { triage: 'evaluating' },
  });
  assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(
    target(calls),
    `/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/${OWN_ID}`
  );
  assert.ok(
    !target(calls).endsWith(`/comments/${OTHER_ID}`),
    "the write targeted the other maintainer's comment"
  );
  const params = sent(calls);
  assert.ok(params.has(write.EDIT_BODY_FIELD), 'the edit carried no body field');
  assert.ok(
    params.has('repository_advisory_comment[bodyVersion]'),
    'the edit carried no concurrency token'
  );

  const snapshot = /** @type {Record<string, unknown>} */ (outcome.snapshot);
  assert.ok(snapshot.seq === 8, `the snapshot claimed sequence ${String(snapshot.seq)}`);
  assert.ok(snapshot.by === 'samuelkarp', `the snapshot was written by ${String(snapshot.by)}`);
  assert.ok(snapshot.at === AT, 'the snapshot carries another write time');
  assert.ok(snapshot.betterGhsa === '1.0', 'the snapshot carries another schema version');
  assert.ok(snapshot.triage === 'evaluating', 'the change did not reach the snapshot');
});

test('a field this reader does not know survives the write', async () => {
  const { outcome, calls } = await run(triagePage(), { changes: { triage: 'evaluating' } });
  assert.strictEqual(outcome.ok, true);
  const carried = /** @type {Record<string, unknown>} */ (
    /** @type {Record<string, unknown>} */ (outcome.snapshot).cutleryPolicy
  );
  assert.ok(carried !== undefined, 'the unknown field was dropped');
  assert.ok(carried.sharpened === true, 'the unknown field lost its value');
  assert.ok(
    postedBody(sent(calls)).includes('"cutleryPolicy"'),
    'the request did not carry the unknown field'
  );
});

test('the sequence the write claims is one above the highest on the advisory', async () => {
  const { outcome } = await run(triagePage(), {});
  // New writes must exceed even the sequence numbers in untrusted snapshots.
  assert.strictEqual(outcome.merged?.observedSeq, OBSERVED);
  assert.strictEqual(outcome.merged?.seq, 3);
  assert.ok(
    /** @type {Record<string, unknown>} */ (outcome.snapshot).seq === OBSERVED + 1,
    'the write did not outrank every claim on the advisory'
  );
});

test('the comment the write sends parses back as the snapshot it wrote', async () => {
  const { outcome, calls } = await run(triagePage(), { changes: { triage: 'evaluating' } });
  assert.strictEqual(outcome.ok, true);
  const rendered = document(renderStateComment(postedBody(sent(calls))));
  const report = parse.parseStateComment(rendered.querySelector('.comment-body'));
  assert.ok(report !== null, 'the comment this extension wrote is not a state comment');
  assert.ok(report.valid === true, `the snapshot did not validate: ${report.problems.join('; ')}`);
  assert.ok(report.seq === 8, 'the snapshot came back with another sequence number');
  assert.ok(report.by === 'samuelkarp', 'the snapshot came back under another login');
});

test('the first write on an advisory creates the comment', async () => {
  const page = triagePage();
  const own = page.querySelector(`#advisory-comment-${OWN_ID}`);
  if (own === null) throw new Error('the fixture carries no state comment to remove');
  own.remove();

  const { outcome, calls } = await run(page, {});
  assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);
  assert.strictEqual(
    target(calls),
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments'
  );
  const params = sent(calls);
  assert.ok(params.has('body'), 'the create carried no body field');
  assert.ok(params.has('authenticity_token'), 'the create carried no token');
  const snapshot = /** @type {Record<string, unknown>} */ (outcome.snapshot);
  assert.ok(snapshot.seq === 8, 'the created snapshot claimed another sequence');
  assert.ok(snapshot.by === 'samuelkarp', 'the created snapshot named another writer');
  assert.ok(snapshot.cutleryPolicy === undefined, 'a removed comment still reached state');
});

test('a write never targets the comment another maintainer wrote', async () => {
  const page = triagePage();
  signIn(page, 'prakleumas');
  const { outcome, calls } = await run(page, {});
  assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);
  assert.strictEqual(
    target(calls),
    `/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/${OTHER_ID}`
  );
  assert.ok(
    /** @type {Record<string, unknown>} */ (outcome.snapshot).by === 'prakleumas',
    'the snapshot was stamped with another login'
  );
});

test('a viewer login spelled in another case edits the comment already there', async () => {
  assert.strictEqual(
    state.sameLogin('SamuelKarp', 'samuelkarp'),
    true,
    'two spellings of one login read as two accounts'
  );

  const page = triagePage();
  signIn(page, 'SamuelKarp');
  const { outcome, calls } = await run(page, {});
  assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);
  assert.strictEqual(
    target(calls),
    `/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/${OWN_ID}`
  );
});

test('a maintainer with two state comments is not written for', async () => {
  const page = triagePage();
  const other = page.querySelector(`#advisory-comment-${OTHER_ID}`);
  if (other === null) throw new Error('the fixture carries one state comment');
  for (const link of other.querySelectorAll('a.author')) link.setAttribute('href', '/samuelkarp');

  const { outcome, calls } = await run(page, {});
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'ambiguous');
  assert.strictEqual(calls.length, 1, 'a comment request went out');
});

test('two state comments of one maintainer are named before the holder', async () => {
  // Duplicate state comments require deletion. Reloading cannot resolve them.
  const page = triagePage();
  const other = page.querySelector(`#advisory-comment-${OTHER_ID}`);
  if (other === null) throw new Error('the fixture carries one state comment');
  for (const link of other.querySelectorAll('a.author')) link.setAttribute('href', '/samuelkarp');

  const { outcome, calls } = await run(page, {
    loadedHolder: { commentId: '10101', by: 'samuelkarp' },
  });
  assert.ok(outcome.ok === false, 'a write went out on an advisory with two own comments');
  assert.ok(outcome.reason === 'ambiguous', `the write was refused as ${outcome.reason}`);
  assert.strictEqual(calls.length, 1, 'a comment request went out');
  assert.strictEqual(outcome.message, 'Error: multiple tracking comments from samuelkarp');
});

test('a page that moved past the sequence the panel loaded refuses the write', async () => {
  for (const loadedSeq of [3, 6, 8]) {
    const { outcome, calls } = await run(triagePage(), { loadedSeq });
    assert.strictEqual(outcome.ok, false, `sequence ${loadedSeq}`);
    assert.strictEqual(outcome.reason, 'stale', `sequence ${loadedSeq}`);
    assert.strictEqual(calls.length, 1, 'a comment request went out');
    assert.strictEqual(outcome.snapshot, null);
    assert.strictEqual(outcome.merged?.observedSeq, OBSERVED);
    assert.strictEqual(outcome.message, 'Error: concurrent edits');
  }
});

test('a snapshot other than the one the panel loaded refuses the write', async () => {
  const { outcome, calls } = await run(triagePage(), {
    loadedHolder: { commentId: null, by: 'yaroslavk' },
  });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'superseded');
  assert.strictEqual(calls.length, 1, 'a comment request went out');
  assert.strictEqual(outcome.snapshot, null);
  assert.strictEqual(outcome.merged?.observedSeq, OBSERVED);
  assert.strictEqual(outcome.message, 'Error: concurrent edits');
});

test('a comment other than the one that held state refuses the write', async () => {
  const { outcome, calls } = await run(triagePage(), {
    loadedHolder: { commentId: '10101', by: 'samuelkarp' },
  });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'superseded');
  assert.strictEqual(calls.length, 1, 'a comment request went out');
});

test('a rival claiming one sequence takes the state, and the write it refuses', async () => {
  // Logins break sequence ties (REQUIREMENTS.md section 3).
  // Exercise rivals whose logins sort before and after the maintainer's.
  const taken = triagePage();
  rival(taken, 'yaroslavk');
  const refused = await run(taken, {
    loadedSeq: OWN_SEQ,
    loadedHolder: { commentId: OWN_ID, by: 'samuelkarp' },
    changes: { triage: 'evaluating' },
  });
  assert.ok(refused.outcome.ok === false, 'the write went out over the rival snapshot');
  assert.strictEqual(refused.outcome.reason, 'superseded');
  assert.strictEqual(refused.calls.length, 1, 'a comment request went out');
  assert.strictEqual(refused.outcome.snapshot, null);
  assert.strictEqual(refused.outcome.merged?.source?.id, OTHER_ID);
  assert.strictEqual(refused.outcome.merged?.observedSeq, OWN_SEQ);

  const held = triagePage();
  rival(held, 'prakleumas');
  const written = await run(held, {
    loadedSeq: OWN_SEQ,
    loadedHolder: { commentId: OWN_ID, by: 'samuelkarp' },
    changes: { triage: 'evaluating' },
  });
  assert.ok(written.outcome.ok === true, `the write failed: ${written.outcome.message}`);
  assert.strictEqual(written.outcome.merged?.source?.id, OWN_ID);
  assert.ok(
    /** @type {Record<string, unknown>} */ (written.outcome.snapshot).seq === OWN_SEQ + 1,
    'the write did not outrank the tie it wrote over'
  );
});

test('the state a write of this panel left behind is not a rival', async () => {
  // The saved snapshot lacks a comment ID. Its author identifies the holder.
  const { outcome } = await run(triagePage(), {
    loadedHolder: { commentId: null, by: 'SamuelKarp' },
  });
  assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);
});

test('the holder of a state is the comment it came from', () => {
  const page = triagePage();
  const advisory = parse.parseDetail(page);
  if (advisory === null) throw new Error('the fixture is not an advisory detail page');
  const holder = state.holderOf(merge.mergeSnapshots(advisory.comments));
  assert.strictEqual(holder.commentId, OWN_ID);
  assert.strictEqual(holder.by, 'samuelkarp');
});

test('a page naming no signed-in account is not written to', async () => {
  const page = triagePage();
  const box = page.querySelector('div.timeline-new-comment');
  if (box === null) throw new Error('the fixture carries no new-comment box');
  box.remove();
  const { outcome, calls } = await run(page, {});
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'unreadable');
  assert.strictEqual(outcome.message, 'Error: cannot identify logged-in user');
  assert.strictEqual(calls.length, 1, 'a comment request went out');
});

test('an unreadable viewer with a comment form is not diagnosed as a missing form', async () => {
  const page = triagePage();
  const avatar = page.querySelector('div.timeline-new-comment span.timeline-comment-avatar');
  assert.ok(avatar !== null);
  avatar.remove();
  const { outcome, calls } = await run(page, {});
  assert.strictEqual(outcome.reason, 'unreadable');
  assert.strictEqual(outcome.diagnostic, undefined);
  assert.strictEqual(calls.length, 1, 'a comment request went out');
});

test('a snapshot this extension could not interpret takes one confirmation', async () => {
  const page = fixture('draft.html');
  const refusal = await run(page, { ref: DRAFT_REF, loadedSeq: 2 });
  assert.strictEqual(refusal.outcome.ok, false);
  assert.strictEqual(refusal.outcome.reason, 'confirmation');
  assert.strictEqual(refusal.outcome.message, 'Error: unparsed tracking state');
  assert.strictEqual(refusal.calls.length, 1, 'a comment request went out');
  assert.strictEqual(refusal.outcome.merged?.confirmationRequired, true);

  const confirmed = await run(page, { ref: DRAFT_REF, loadedSeq: 2, confirmed: true });
  assert.ok(confirmed.outcome.ok === true, `the write failed: ${confirmed.outcome.message}`);
  assert.strictEqual(
    target(confirmed.calls),
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-5hg2-rfq2-8fm5/comments/282849'
  );
  assert.ok(
    /** @type {Record<string, unknown>} */ (confirmed.outcome.snapshot).seq === 3,
    'the confirmed write did not outrank the snapshot it supersedes'
  );
});

test('a snapshot this extension would not read back is not written', async () => {
  const { outcome, calls } = await run(triagePage(), { changes: { owners: 'dmcgowan' } });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'invalid');
  assert.strictEqual(calls.length, 1, 'a comment request went out');
  assert.strictEqual(outcome.snapshot, null);
  assert.strictEqual(outcome.message, 'Error: cannot save invalid state');
});

test('a schema major this extension does not read refuses the write', async () => {
  const page = fixture('draft.html');
  const fence = page.querySelector('.highlight-source-json pre');
  if (fence === null) throw new Error('the draft fixture carries no snapshot');
  fence.textContent = '{ "betterGhsa": "2.0", "seq": 2, "by": "samuelkarp" }';

  const { outcome, calls } = await run(page, { ref: DRAFT_REF, loadedSeq: 2, confirmed: true });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'read-only');
  assert.strictEqual(outcome.message, 'Error: update the extension');
  assert.strictEqual(calls.length, 1, 'a comment request went out');
  assert.strictEqual(outcome.merged?.readOnly, true);
});

test('triageSince marks the moment the triage value last changed', async () => {
  const carried = await run(triagePage(), { changes: { owners: ['dmcgowan'] } });
  assert.strictEqual(carried.outcome.ok, true);
  assert.ok(
    /** @type {Record<string, unknown>} */ (carried.outcome.snapshot).triageSince ===
      '2026-08-25T18:04:11Z',
    'a write that left triage alone moved triageSince'
  );

  const changed = await run(triagePage(), { changes: { triage: 'evaluating' } });
  assert.strictEqual(changed.outcome.ok, true);
  assert.ok(
    /** @type {Record<string, unknown>} */ (changed.outcome.snapshot).triageSince === AT,
    'a write that changed triage did not move triageSince'
  );
});

test('the first write on an advisory measures triage from the last member action', async () => {
  const { outcome } = await run(fixture('draft.html'), {
    ref: DRAFT_REF,
    loadedSeq: 2,
    confirmed: true,
    changes: { triage: 'evaluating' },
  });
  assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);
  assert.strictEqual(outcome.merged?.state, null, 'the advisory already carried state');
  assert.ok(
    /** @type {Record<string, unknown>} */ (outcome.snapshot).triageSince ===
      '2026-08-25T22:20:26Z',
    'the first write did not measure triage from the last member action'
  );
});

test('a first write on an advisory no member has touched measures from the report', async () => {
  const page = fixture('draft.html');
  for (const badge of page.querySelectorAll('div.timeline-comment-group span.Label')) {
    badge.remove();
  }
  const { outcome } = await run(page, {
    ref: DRAFT_REF,
    loadedSeq: 2,
    changes: { triage: 'evaluating' },
  });
  assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);
  assert.ok(
    /** @type {Record<string, unknown>} */ (outcome.snapshot).triageSince ===
      '2026-08-25T22:19:40Z',
    'the first write did not measure triage from the report time'
  );
});

test('a page offering nothing to measure from falls back to the write time', () => {
  /** @type {Record<string, unknown>} */
  const snapshot = { triage: 'evaluating' };
  state.stampTriageSince(snapshot, null, {}, AT, null);
  assert.strictEqual(snapshot['triageSince'], AT);
});

test('clearing the triage value takes the time it was set with it', async () => {
  const { outcome } = await run(triagePage(), { changes: { triage: null } });
  assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);
  const snapshot = /** @type {Record<string, unknown>} */ (outcome.snapshot);
  assert.ok(!Object.hasOwn(snapshot, 'triage'), 'the snapshot still carries a triage value');
  assert.ok(
    !Object.hasOwn(snapshot, 'triageSince'),
    'the snapshot carries a time for a triage value it does not have'
  );
  assert.strictEqual(
    schema.readSnapshot(JSON.stringify(snapshot)).valid,
    true,
    'the snapshot this write built does not pass validation'
  );
});

test('a triage value set after a write that set none measures from the member action', async () => {
  const page = fixture('draft.html');
  const first = await run(
    page,
    { ref: DRAFT_REF, loadedSeq: 2, confirmed: true, changes: { owners: ['samuelkarp'] } },
    landing(page, DRAFT_COMMENT)
  );
  assert.ok(first.outcome.ok === true, `the first write failed: ${first.outcome.message}`);
  const opening = /** @type {Record<string, unknown>} */ (first.outcome.snapshot);
  assert.ok(!Object.hasOwn(opening, 'triage'), 'the first write set a triage value');
  assert.ok(!Object.hasOwn(opening, 'triageSince'), 'a write with no triage value timed one');

  const second = await run(page, {
    ref: DRAFT_REF,
    loadedSeq: 3,
    changes: { triage: 'awaiting reporter' },
  });
  assert.ok(second.outcome.ok === true, `the second write failed: ${second.outcome.message}`);
  assert.deepStrictEqual(
    second.outcome.merged?.state?.['owners'],
    ['samuelkarp'],
    'the second write did not build on the first'
  );
  const snapshot = /** @type {Record<string, unknown>} */ (second.outcome.snapshot);
  assert.ok(
    snapshot['triageSince'] === MEMBER_ACTION,
    `the first triage value was timed from ${String(snapshot['triageSince'])}`
  );
});

test('a write that names triageSince itself keeps the value it names', () => {
  /** @type {Record<string, unknown>} */
  const snapshot = { triage: 'evaluating', triageSince: '2020-01-01T00:00:00Z' };
  state.stampTriageSince(snapshot, null, { triageSince: '2020-01-01T00:00:00Z' }, AT, AT);
  assert.strictEqual(snapshot['triageSince'], '2020-01-01T00:00:00Z');
});

test('the state comment names the extension and links to it', () => {
  const body = state.buildBody({ betterGhsa: '1.0', seq: 1 });
  const link = '<a href="https://github.com/samuelkarp/better-ghsa">Better GHSA</a>';
  assert.strictEqual(schema.STATE_COMMENT_SUMMARY, `${link} tracking state`);
  assert.strictEqual(body.includes(`<summary>${link} tracking state</summary>`), true);
  // This spacing preserves GitHub's rendering of the summary link.
  assert.strictEqual(body.startsWith('<details>\n\n<summary>'), true);
  assert.strictEqual(body.trimEnd().endsWith('\n\n</details>'), true);
  assert.strictEqual(body.includes(`\n\`${schema.STATE_COMMENT_MARKER}\`\n`), true);
});


const READ_AT = Date.parse('2026-08-26T10:59:00Z');

/**
 * @param {import('../src/detail/state.js').StateWriteResult} outcome
 * @returns {import('../src/common/parse-detail.js').ParsedDetail} The saved advisory after a JSON round trip through the cache reader.
 */
function stored(outcome) {
  const held = record.advisoryFrom(
    JSON.parse(JSON.stringify(outcome.advisory))
  );
  if (held === null) throw new Error('the write left no advisory the cache can read');
  return held;
}

test('a write that landed hands back the advisory carrying what it wrote', async () => {
  cache.setClock(() => READ_AT);
  try {
    const { outcome } = await run(triagePage(), { changes: { triage: 'evaluating' } });
    assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);
    assert.strictEqual(outcome.readAt, READ_AT, 'the advisory was stamped at another moment');

    const after = merge.mergeSnapshots(stored(outcome).comments);
    assert.strictEqual(after.state?.['triage'], 'evaluating', 'the write is not in the advisory');
    assert.strictEqual(after.seq, 8);
    assert.strictEqual(after.observedSeq, 8);
    assert.strictEqual(after.source?.id, OWN_ID);
    assert.strictEqual(
      stored(outcome).comments.filter(
        (comment) => comment.author === 'samuelkarp' && comment.stateComment !== null
      ).length,
      1,
      'the edit left the maintainer holding two state comments'
    );
    assert.deepStrictEqual(after.state?.['cutleryPolicy'], { sharpened: true });
  } finally {
    cache.setClock(null);
  }
});

/**
 * Remove the signed-in maintainer's comments.
 * The new-comment composer still identifies the account.
 *
 * @returns {Document}
 */
function pageWithNoOwnComment() {
  const page = triagePage();
  for (const id of [OWN_ID, '282846']) {
    const group = page.querySelector(`#advisory-comment-${id}`);
    if (group === null) throw new Error(`the fixture carries no comment ${id}`);
    group.remove();
  }
  return page;
}

test('a created comment reaches the advisory the write hands back', async () => {
  const page = pageWithNoOwnComment();
  // Membership observed on another advisory in the organization establishes trust.
  members.clear();
  members.remember({ owner: 'git-utensils' }, ['samuelkarp']);
  try {
    const { outcome } = await run(page, { changes: { triage: 'evaluating' } });
    assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);

    const after = merge.mergeSnapshots(stored(outcome).comments);
    assert.strictEqual(after.state?.['triage'], 'evaluating', 'the created comment holds no state');
    assert.strictEqual(after.seq, 8);
    // The new comment ID is unavailable until a reread. Its author identifies the holder.
    const holder = state.holderOf(after);
    assert.strictEqual(holder.commentId, null);
    assert.strictEqual(holder.by, 'samuelkarp');
    assert.strictEqual(state.sameHolder(holder, { commentId: '99999', by: 'samuelkarp' }), true);
  } finally {
    members.clear();
  }
});

test('a created comment whose author shows no badge is not counted as state', async () => {
  members.clear();
  const { outcome } = await run(pageWithNoOwnComment(), { changes: { triage: 'evaluating' } });
  assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);

  // Retain the untrusted comment until a reread can establish its author's membership.
  const held = stored(outcome);
  const written = held.comments.find(
    (comment) => comment.author === 'samuelkarp' && comment.stateComment !== null
  );
  assert.ok(written !== undefined, 'the created comment is not in the advisory');
  assert.strictEqual(written.stateComment?.seq, 8);
  assert.strictEqual(written.trusted, false);
  assert.strictEqual(
    merge.mergeSnapshots(held.comments).state,
    null,
    'an unplaceable author held state'
  );
});

test('a write refused by the page hands that page back', async () => {
  cache.setClock(() => READ_AT);
  try {
    const { outcome, calls } = await run(triagePage(), {
      loadedSeq: OBSERVED - 1,
      changes: { triage: 'evaluating' },
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.reason, 'stale');
    assert.strictEqual(calls.length, 1, 'a comment request went out');
    assert.strictEqual(outcome.snapshot, null);
    assert.strictEqual(outcome.readAt, READ_AT);
    const held = stored(outcome);
    const after = merge.mergeSnapshots(held.comments);
    assert.strictEqual(after.observedSeq, OBSERVED);
    assert.notStrictEqual(after.state?.['triage'], 'evaluating');
    assert.strictEqual(after.seq, outcome.merged?.seq);
  } finally {
    cache.setClock(null);
  }
});

test('a write GitHub turned away hands back no advisory', async () => {
  // After a write request, the fetched page may already be outdated.
  const { outcome, calls } = await run(triagePage(), { changes: { triage: 'evaluating' } }, () => ({
    status: 500,
    html: '<html><body></body></html>',
  }));
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(calls.length, 2, 'no comment request went out');
  assert.strictEqual(outcome.advisory, null);
  assert.strictEqual(outcome.readAt, null);
});

test('a repository taken off the list while the page is out is refused', async () => {
  // Remove the repository from the allowlist during the fetch.
  // The writer must check the allowlist again before posting.
  const page = triagePage();
  const talk = session(page);
  try {
    const outcome = await state.writeState({
      ref: REF,
      loadedSeq: OBSERVED,
      changes: { triage: 'evaluating' },
      at: AT,
      fetch: async (url, init) => {
        if ((init.method ?? 'GET') === 'GET') {
          allowlist.setStorage({
            get: async () => ({ [allowlist.STORAGE_KEY]: [] }),
            set: async () => {},
          });
          await allowlist.load();
        }
        return talk.fetch(url, init);
      },
      parseDocument: talk.parseDocument,
    });

    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.reason, 'allowlist');
    assert.strictEqual(
      outcome.message,
      write.allowlistMessage(`${REF.owner}/${REF.repo}`),
      'the refusal names another repository'
    );
    assert.strictEqual(outcome.merged, null, 'the save read state it should not have reached');
    assert.strictEqual(talk.calls.length, 1, 'the save spent more than the one read');
    assert.deepStrictEqual(
      talk.calls.filter((call) => (call.init.method ?? 'GET') !== 'GET'),
      [],
      'a comment was posted on a repository off the list'
    );
  } finally {
    allowlist.setStorage({
      get: async () => ({ [allowlist.STORAGE_KEY]: ['git-utensils/spoon-knife'] }),
      set: async () => {},
    });
    await allowlist.load();
  }
});
