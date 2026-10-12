'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const allowlist = require('../src/common/allowlist.js');
const reviews = require('../src/common/reviews.js');

/**
 * @param {string} name
 * @returns {Record<string, any>} The merge box data in the fixture.
 */
function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8'));
}

const REF = { owner: 'git-utensils', repo: 'Spoon-Knife', ghsaId: 'GHSA-jmvx-2wfw-xfgj' };

const FORK = '/git-utensils/Spoon-Knife-ghsa-jmvx-2wfw-xfgj';

/**
 * @param {number} number
 * @param {string} [url]
 * @returns {import('../src/common/parse-detail.js').ForkPullRequest}
 */
function pull(number, url = `${FORK}/pull/${number}`) {
  return {
    number,
    url,
    title: 'Normalize drawer paths',
    state: 'open',
    baseRef: 'main',
    headRef: 'fix',
    author: 'prakleumas',
    openedAt: null,
    assignees: [],
  };
}

test.before(async () => {
  allowlist.setStorage({
    get: async () => ({ [allowlist.STORAGE_KEY]: ['git-utensils/spoon-knife'] }),
    set: async () => {},
  });
  await allowlist.load();
});

test.after(() => {
  allowlist.setStorage(null);
});

test("the branch rule's count is GitHub's, over the approvals it lists", () => {
  // The two listed approvals are stale; GitHub counts one.
  assert.deepStrictEqual(reviews.reviewResultOf(fixture('merge-box-stale.json')), {
    approvals: 1,
    changesRequested: false,
  });
  assert.deepStrictEqual(reviews.reviewResultOf(fixture('merge-box-changes-requested.json')), {
    approvals: 0,
    changesRequested: true,
  });
});

test('without a branch rule, the reviews of people with write access count', () => {
  const data = fixture('merge-box-private.json');
  assert.deepStrictEqual(reviews.reviewResultOf(data), { approvals: 4, changesRequested: false });

  const listed = data['pullRequest'].latestOpinionatedReviews;
  listed[0].authorCanPushToRepository = false;
  listed.push({ ...listed[1], state: 'CHANGES_REQUESTED', authorCanPushToRepository: false });
  assert.deepStrictEqual(reviews.reviewResultOf(data), { approvals: 3, changesRequested: false });

  listed.push({ ...listed[1], state: 'CHANGES_REQUESTED' });
  assert.deepStrictEqual(reviews.reviewResultOf(data), { approvals: 3, changesRequested: true });
});

test('the review result of data without the latest reviews is null', () => {
  const data = fixture('merge-box-stale.json');
  delete data['pullRequest'].latestOpinionatedReviews;
  assert.strictEqual(reviews.reviewResultOf(data), null);
  assert.strictEqual(reviews.reviewResultOf({ error: 'Not Found' }), null);
  assert.strictEqual(reviews.reviewResultOf('<html></html>'), null);
});

test("only the advisory's own fork of a listed repository is asked", () => {
  assert.strictEqual(
    reviews.mergeBoxPath(REF, pull(2)),
    `${FORK}/pull/2/page_data/merge_box`
  );
  /** @typedef {import('../src/common/parse-detail.js').AdvisoryRef} AdvisoryRef */
  /** @typedef {import('../src/common/parse-detail.js').ForkPullRequest} ForkPullRequest */
  /** @type {[string, AdvisoryRef, ForkPullRequest][]} */
  const refused = [
    ['another repository', REF, pull(2, '/another-owner/another-repo/pull/2')],
    [
      "another advisory's fork",
      REF,
      pull(2, '/git-utensils/Spoon-Knife-ghsa-2222-3333-4444/pull/2'),
    ],
    ['another number than the row', REF, pull(2, `${FORK}/pull/3`)],
    ['another host', REF, pull(2, `https://example.com${FORK}/pull/2`)],
    [
      'a repository the allowlist does not carry',
      { ...REF, owner: 'another-owner', repo: 'another-repo' },
      pull(2, '/another-owner/another-repo-ghsa-jmvx-2wfw-xfgj/pull/2'),
    ],
  ];
  for (const [why, ref, row] of refused) {
    assert.strictEqual(reviews.mergeBoxPath(ref, row), null, `asked ${why}`);
  }
});

test("a read requests JSON with the page's headers and records the time it was read", async () => {
  /** @type {{ url: string, init: RequestInit }[]} */
  const sent = [];
  const before = Date.now();
  const result = await reviews.readReview(REF, pull(2), {
    fetch: async (url, init) => {
      sent.push({ url, init });
      return {
        status: 200,
        text: async () => JSON.stringify(fixture('merge-box-private.json')),
      };
    },
  });
  const after = Date.now();
  const observedAt = result?.observedAt ?? NaN;
  assert.ok(observedAt >= before && observedAt <= after, `read at ${observedAt}`);
  assert.deepStrictEqual(result, { approvals: 4, changesRequested: false, observedAt });
  assert.strictEqual(sent[0]?.url, `${FORK}/pull/2/page_data/merge_box`);
  const headers = /** @type {Record<string, string>} */ (sent[0]?.init.headers);
  assert.strictEqual(headers['X-Requested-With'], 'XMLHttpRequest');
  assert.strictEqual(headers['Accept'], 'application/json');
  assert.strictEqual(sent[0]?.init.credentials, 'same-origin');
});

test('a failed, unreadable, or unanswered read returns null', async () => {
  /** @type {[string, import('../src/common/write.js').WriteFetch][]} */
  const answers = [
    ['a 404', async () => ({ status: 404, text: async () => '{"error":"Not Found"}' })],
    ['HTML', async () => ({ status: 200, text: async () => '<!doctype html>' })],
    ['a network error', async () => Promise.reject(new TypeError('Failed to fetch'))],
    ['no answer', () => new Promise(() => {})],
  ];
  for (const [why, fetch] of answers) {
    const result = await reviews.readReview(REF, pull(2), { fetch, timeoutMs: 20 });
    assert.strictEqual(result, null, `${why} gave a result`);
  }
});
