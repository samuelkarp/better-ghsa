'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const branches = require('../src/common/branches.js');
const panel = require('../src/detail/panel.js');

const { fakeStorage } = require('../test-support/storage.js');

/** @typedef {import('../test-support/storage.js').FakeStorage} Fake */

/**
 * @param {unknown} [held] The initial stored branch map.
 * @returns {Fake}
 */
const branchStorage = (held) =>
  fakeStorage(held === undefined ? {} : { [branches.BRANCHES_KEY]: held });

/**
 * @param {string} name
 * @returns {Document}
 */
function fixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

const REF = { owner: 'containerd', repo: 'containerd', ghsaId: 'GHSA-1111-1111-1111' };

/**
 * @param {Fake} storage
 * @param {string} repository
 * @returns {string[]} the branches the entry holds for one repository.
 */
function stored(storage, repository) {
  const value = storage.entries[branches.BRANCHES_KEY];
  if (value === null || typeof value !== 'object') return [];
  const held = /** @type {Record<string, unknown>} */ (value)[repository];
  return Array.isArray(held) ? held.map((name) => String(name)) : [];
}

/** @returns {void} */
function forget() {
  branches.clear();
  branches.setStorage(null);
}

test('non-contiguous release branches come out newest first', () => {
  const ordered = branches.order([
    'release/1.6',
    'release/2.0',
    'release/1.7',
    'release/2.10',
    'release/1.10',
  ]);
  assert.strictEqual(ordered.join(' '), 'release/2.10 release/2.0 release/1.10 release/1.7 release/1.6');
});

test('a version carrying more components is ordered above the one it extends', () => {
  const ordered = branches.order(['release/2.10', 'release/2.10.1']);
  assert.strictEqual(ordered[0], 'release/2.10.1', 'the patch release was not offered first');
  assert.strictEqual(ordered[1], 'release/2.10');
});

test('a leading v is not part of the version', () => {
  assert.strictEqual(branches.versionOf('release/v2.10')?.join('.'), '2.10');
  assert.strictEqual(branches.versionOf('release/2.10')?.join('.'), '2.10');
});

test('a branch that carries no version is offered after every branch that does', () => {
  const ordered = branches.order(['release/next', 'release/2.9', 'release/lts', 'release/2.10']);
  assert.strictEqual(ordered[0], 'release/2.10');
  assert.strictEqual(ordered[1], 'release/2.9');
  assert.strictEqual(ordered[2], 'release/lts', 'the versionless branches are not in code order');
  assert.strictEqual(ordered[3], 'release/next');
  assert.strictEqual(branches.versionOf('release/next'), null, 'next reads as a version');
});

test('only a release branch is held', () => {
  forget();
  assert.strictEqual(branches.remember(REF, ['release/2.1', 'main', 'v2.1.0', 'release/']), true);
  assert.strictEqual(branches.known(REF).join(' '), 'release/2.1', 'a name outside release/ was held');
});

test('a branch is held once and its case is its own', () => {
  forget();
  assert.strictEqual(branches.remember(REF, ['release/2.1']), true);
  assert.strictEqual(branches.remember(REF, ['release/2.1']), false, 'one branch was held twice');
  assert.strictEqual(branches.remember(REF, ['release/2.1 ']), false, 'the ends were not trimmed');
  assert.strictEqual(branches.remember(REF, ['Release/2.1']), false, 'Release/ read as release/');
  assert.strictEqual(branches.known(REF).join(' '), 'release/2.1');
});

test('one repository does not see another repository branches', () => {
  forget();
  branches.remember(REF, ['release/2.1']);
  branches.remember({ owner: 'containerd', repo: 'nerdctl' }, ['release/1.7']);
  assert.strictEqual(branches.known(REF).join(' '), 'release/2.1');
  assert.strictEqual(
    branches.known({ owner: 'CONTAINERD', repo: 'NERDCTL' }).join(' '),
    'release/1.7',
    'the repository key was not folded'
  );
});

test('a page that did not say which repository it is holds nothing', () => {
  forget();
  assert.strictEqual(branches.remember(null, ['release/2.1']), false);
  assert.strictEqual(branches.known(null).length === 0, true);
});

test('the branches this session read are written to storage', async () => {
  forget();
  const storage = branchStorage();
  branches.setStorage(storage);
  branches.remember(REF, ['release/2.1', 'release/1.7']);

  assert.strictEqual(await branches.sync(), false, 'storage held a branch this session did not');
  assert.strictEqual(stored(storage, 'containerd/containerd').join(' '), 'release/2.1 release/1.7');
  assert.strictEqual(storage.reads.join(' '), branches.BRANCHES_KEY);
});

test('the entry accumulates the branches of every session that wrote it', async () => {
  forget();
  const storage = branchStorage({ 'containerd/containerd': ['release/1.7'] });
  branches.setStorage(storage);
  branches.remember(REF, ['release/2.10']);

  assert.strictEqual(await branches.sync(), true, 'a branch storage held did not arrive');
  assert.strictEqual(branches.known(REF).join(' '), 'release/2.10 release/1.7');
  assert.strictEqual(stored(storage, 'containerd/containerd').join(' '), 'release/2.10 release/1.7');
});

test('a session that adds nothing leaves the entry as it stands', async () => {
  forget();
  const storage = branchStorage({ 'containerd/containerd': ['release/1.7', 'release/2.10'] });
  branches.setStorage(storage);
  branches.remember(REF, ['release/2.10']);

  assert.strictEqual(await branches.sync(), true);
  assert.strictEqual(storage.writes.length === 0, true, 'the entry was written with nothing new');

  branches.remember(REF, ['release/2.2']);
  assert.strictEqual(await branches.sync(), false, 'storage held a branch this session did not');
  assert.strictEqual(storage.writes.length, 1, 'a write went unrecorded');
  assert.ok(
    stored(storage, 'containerd/containerd').includes('release/2.2'),
    'the branch the session added is not in the entry'
  );
});

test('an entry holding something other than branches is read as empty', async () => {
  forget();
  const storage = branchStorage(['release/1.7']);
  branches.setStorage(storage);
  branches.remember(REF, ['release/2.10']);

  assert.strictEqual(await branches.sync(), false);
  assert.strictEqual(branches.known(REF).join(' '), 'release/2.10');
  assert.strictEqual(
    stored(storage, 'containerd/containerd').join(' '),
    'release/2.10',
    'the entry was left unusable'
  );
});

test('storage that fails leaves this session holding what it read', async () => {
  forget();
  branches.remember(REF, ['release/2.10']);
  branches.setStorage({
    /** @returns {Promise<Record<string, unknown>>} */
    get: async () => {
      throw new Error('storage is unavailable');
    },
    /** @returns {Promise<void>} */
    set: async () => {
      throw new Error('storage is unavailable');
    },
  });

  assert.strictEqual(await branches.sync(), false);
  assert.strictEqual(branches.known(REF).join(' '), 'release/2.10');
});

test('a set that cannot be stored is still held for this page', async () => {
  forget();
  const storage = branchStorage({ 'containerd/containerd': ['release/1.7'] });
  branches.setStorage({
    get: storage.get,
    /** @returns {Promise<void>} */
    set: async () => {
      throw new Error('the quota is full');
    },
  });
  branches.remember(REF, ['release/2.10']);

  assert.strictEqual(await branches.sync(), true);
  assert.strictEqual(branches.known(REF).join(' '), 'release/2.10 release/1.7');
});

test('a page outside a browser stores nothing and reads nothing', async () => {
  forget();
  branches.remember(REF, ['release/2.10']);
  assert.strictEqual(branches.storageOf(), null, 'this environment offers an extension storage');
  assert.strictEqual(await branches.sync(), false);
  assert.strictEqual(branches.known(REF).join(' '), 'release/2.10');
  forget();
});

test('a render pass holds the release branches the advisory names and stores them', async () => {
  forget();
  const storage = branchStorage();
  branches.setStorage(storage);

  const placed = await panel.render(fixture('triage-thread.html'));
  assert.strictEqual(placed !== null, true, 'the fixture offered no anchor');
  assert.strictEqual(
    branches.known({ owner: 'git-utensils', repo: 'Spoon-Knife' }).join(' '),
    'release/1.0',
    'the pass did not hold the advisory branches before it drew'
  );

  // Branch storage completes after the render pass returns.
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(
    stored(storage, 'git-utensils/spoon-knife').join(' '),
    'release/1.0',
    'the pass stored no branch'
  );
  forget();
});

/**
 * The fixture contains a private fork and does not contain state comments.
 * Only the fork supplies branches.
 *
 * @returns {Document}
 */
function forkPage() {
  const fork = fs.readFileSync(
    path.join(__dirname, '..', 'testdata', 'fork-multi-branch.html'),
    'utf8'
  );
  const html = [
    '<!doctype html><html><head></head><body>',
    '<div class="clearfix new-discussion-timeline container-xl">',
    '<div class="d-flex flex-column flex-md-row">',
    '<div class="col-12 col-md-9">',
    '<div class="gh-header-meta"></div>',
    '<div class="js-quote-selection-container">',
    '<div class="js-socket-channel js-updatable-content"',
    ' data-url="/o/r/security/advisories/GHSA-0000-0000-0000/show_partial?partial=repository_advisory%2Fbody">',
    '<div class="Box">',
    '<div class="js-repository-advisory-details">',
    '<div class="Box-header timeline-comment-header">description</div>',
    '</div></div>',
    fork,
    '</div></div></div></div></body></html>',
  ].join('');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

/**
 * The base ref is the last `span.css-truncate-target` within
 * `span.commit-ref.base-ref` on each pull request row.
 *
 * @param {Document} doc
 * @param {string} from The branch the row names now.
 * @param {string} to The branch to point it at.
 * @returns {number} The number of updated rows.
 */
function retargetFork(doc, from, to) {
  let moved = 0;
  for (const base of doc.querySelectorAll('span.commit-ref.base-ref')) {
    const targets = base.querySelectorAll('span.css-truncate-target');
    const last = targets[targets.length - 1];
    if (last === undefined || last.textContent !== from) continue;
    last.textContent = to;
    moved += 1;
  }
  return moved;
}

test('the release branches an advisory fork patches become candidates', async () => {
  forget();
  const placed = await panel.render(forkPage());
  assert.strictEqual(placed !== null, true, 'the page offered no anchor');
  assert.strictEqual(
    branches.known({ owner: 'o', repo: 'r' }).join(' '),
    'release/1.0',
    'the branches the fork pull requests target did not reach the candidates'
  );
  forget();
});

test('a branch a fork names is offered on the other advisories of its repository', async () => {
  forget();
  const doc = fixture('triage-thread.html');
  // The captured fork and snapshot name the same backport branch.
  // Change the fork branch to distinguish its contribution.
  assert.strictEqual(
    retargetFork(doc, 'release/1.0', 'release/9.9'),
    1,
    'the capture carries no fork pull request against release/1.0'
  );
  assert.strictEqual(await panel.render(doc) !== null, true, 'the fixture offered no anchor');

  const elsewhere = { owner: 'git-utensils', repo: 'Spoon-Knife', ghsaId: 'GHSA-2222-2222-2222' };
  assert.strictEqual(
    branches.known(elsewhere).join(' '),
    'release/9.9 release/1.0',
    'the fork branch and the backport target are not both offered newest first'
  );
  forget();
});
