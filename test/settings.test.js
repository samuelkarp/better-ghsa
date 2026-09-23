'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const allowlist = require('../src/common/allowlist.js');
const branches = require('../src/common/branches.js');
const cache = require('../src/common/cache.js');
const members = require('../src/common/members.js');
const settings = require('../src/settings/settings.js');

const { fakeStorage } = require('../test-support/storage.js');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

/**
 * @returns {{ window: any, document: Document }}
 */
function page() {
  const html = fs.readFileSync(path.join(root, 'src', 'settings', 'settings.html'), 'utf8');
  const { window, document } = parseHTML(html);
  return { window, document: /** @type {Document} */ (/** @type {unknown} */ (document)) };
}

/**
 * @param {readonly string[]} [initial] The repositories on the list.
 * @param {Record<string, unknown>} [rest] What else the extension has stored.
 * @returns {import('../test-support/storage.js').FakeStorage}
 */
const memory = (initial, rest) =>
  fakeStorage({
    ...(initial === undefined ? {} : { [allowlist.STORAGE_KEY]: [...initial] }),
    ...(rest ?? {}),
  });

/**
 * @param {Document} doc
 * @returns {string[]} the repositories the page is showing, in the order it
 *   shows them.
 */
function shown(doc) {
  return [...doc.querySelectorAll('#list .row-name')].map((node) => node.textContent ?? '');
}

/**
 * @param {Document} doc
 * @returns {string} The entry validation message, or an empty string.
 */
function errorText(doc) {
  const error = doc.getElementById('add-error');
  if (error === null || error.hasAttribute('hidden')) return '';
  return error.textContent ?? '';
}

/**
 * @param {Document} doc
 * @param {string} typed
 * @returns {Promise<boolean>}
 */
async function type(doc, typed) {
  const input = /** @type {HTMLInputElement | null} */ (doc.getElementById('add-input'));
  assert.ok(input !== null, 'the page carries no field to type in');
  input.value = typed;
  return settings.submit(doc);
}

/**
 * @param {Document} doc
 * @returns {string} The clear-data status message, or an empty string.
 */
function clearedText(doc) {
  const status = doc.getElementById('clear-status');
  if (status === null || status.hasAttribute('hidden')) return '';
  return status.textContent ?? '';
}

const CONTAINERD = 'containerd/containerd';
const NERDCTL = 'containerd/nerdctl';
const SPOON = 'git-utensils/spoon-knife';

/**
 * @param {string} repository
 * @returns {string[]}
 */
function keysOf(repository) {
  return [
    `${cache.ADVISORY_PREFIX}${repository}:ghsa-1111-2222-3333`,
    `${cache.LIST_PREFIX}${repository}`,
    `${cache.PROGRESS_PREFIX}${repository}`,
  ];
}

/**
 * @param {readonly string[]} repositories
 * @returns {Record<string, unknown>}
 */
function reads(repositories) {
  /** @type {Record<string, unknown>} */
  const held = {};
  /** @type {Record<string, string[]>} */
  const branchesHeld = {};
  /** @type {Record<string, string[]>} */
  const membersHeld = {};
  for (const repository of repositories) {
    for (const key of keysOf(repository)) {
      held[key] = { record: { state: 'triage' }, observedAt: 1, state: 'triage' };
    }
    branchesHeld[repository] = ['release/2.1'];
    membersHeld[String(repository.split('/')[0])] = ['samuelkarp'];
  }
  held[branches.BRANCHES_KEY] = branchesHeld;
  held[members.MEMBERS_KEY] = membersHeld;
  return held;
}

/**
 * @param {ReturnType<typeof memory>} store
 * @param {string} repository
 * @returns {string[]} the keys storage still holds for that repository.
 */
function survivors(store, repository) {
  return keysOf(repository).filter((key) => Object.hasOwn(store.entries, key));
}

/**
 * @param {ReturnType<typeof memory>} store
 * @param {string} key
 * @returns {string[]} The keys of the stored map.
 */
function namesIn(store, key) {
  const value = store.entries[key];
  return value === undefined || value === null ? [] : Object.keys(value).sort();
}

/**
 * @param {Document} doc
 * @param {any} window
 * @returns {Promise<void>} Clicks Clear and waits one event-loop turn.
 */
async function pressClear(doc, window) {
  const button = doc.getElementById('clear-button');
  assert.ok(button !== null, 'the page carries no control that clears the cache');
  button.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test.afterEach(() => {
  allowlist.setStorage(null);
  cache.setStorage(null);
});

test('the manifest declares the settings page and no background script', () => {
  assert.strictEqual(manifest.options_ui.page, 'src/settings/settings.html');
  assert.strictEqual(manifest.options_ui.open_in_tab, true);
  assert.ok(!Object.hasOwn(manifest, 'background'), 'the manifest declares a background script');
  assert.ok(
    !fs.existsSync(path.join(root, 'src', 'background.js')),
    'src/background.js is in the tree'
  );
  for (const file of ['src/settings/settings.html', 'src/settings/settings.js'])
    assert.ok(fs.existsSync(path.join(root, file)), `${file} is declared and missing`);
  assert.ok(!manifest.content_scripts[0].js.includes('src/settings/settings.js'));
});

test('the manifest forbids any page from framing the extension pages', () => {
  // The web-accessible settings page can be embedded by github.com.
  // The content security policy must forbid framing.
  const policy = manifest.content_security_policy.extension_pages;
  assert.match(policy, /frame-ancestors 'none'/);
  // An explicit content security policy replaces the browser defaults.
  // It must retain their restrictions on scripts, objects, and insecure requests.
  assert.match(policy, /script-src 'self';/);
  assert.match(policy, /object-src 'self';/);
  assert.match(policy, /upgrade-insecure-requests/);
  for (const loose of ["'unsafe-eval'", "'unsafe-inline'", "'wasm-unsafe-eval'", 'http:', 'https:', '*'])
    assert.ok(!policy.includes(loose), `the policy carries ${loose}`);
});

test('a fresh install shows an empty list and says what to do about it', async () => {
  allowlist.setStorage(memory());
  const { document } = page();
  await settings.start(document);

  assert.deepStrictEqual(shown(document), []);
  const empty = document.getElementById('empty');
  assert.ok(empty?.hasAttribute('hidden') === false, 'nothing said so');
  assert.strictEqual(empty?.textContent?.trim(), 'Add a repository to get started');
});

test('a repository typed into the page is stored and listed', async () => {
  const store = memory();
  allowlist.setStorage(store);
  const { document } = page();
  await settings.start(document);

  assert.strictEqual(await type(document, 'containerd/containerd'), true);
  assert.deepStrictEqual(shown(document), ['containerd/containerd']);
  assert.deepStrictEqual(store.entries[allowlist.STORAGE_KEY], ['containerd/containerd']);
  assert.strictEqual(errorText(document), '');
  assert.strictEqual(document.getElementById('empty')?.hasAttribute('hidden'), true);
  assert.strictEqual(
    /** @type {HTMLInputElement} */ (document.getElementById('add-input')).value,
    ''
  );
});

test('what is not a repository is refused, listed nowhere, and stored nowhere', async () => {
  const store = memory();
  allowlist.setStorage(store);
  const { document } = page();
  await settings.start(document);

  for (const typed of [
    'containerd',
    'containerd/containerd/extra',
    'https://github.com/containerd/containerd',
    'owner name/repo',
    '-owner/repo',
    'owner/repo?ref=main',
  ]) {
    assert.strictEqual(await type(document, typed), false, `accepted ${JSON.stringify(typed)}`);
    assert.strictEqual(
      errorText(document),
      settings.MALFORMED_MESSAGE,
      `said nothing about ${JSON.stringify(typed)}`
    );
    assert.strictEqual(
      /** @type {HTMLInputElement} */ (document.getElementById('add-input')).value,
      typed
    );
  }

  assert.deepStrictEqual(shown(document), []);
  assert.strictEqual(store.writes.length, 0, 'a repository the page refused was stored');
  assert.deepStrictEqual(store.entries, {});

  assert.strictEqual(await type(document, 'containerd/containerd'), true);
  assert.strictEqual(store.writes.length, 1, 'an accepted repository went unstored');
});

test('an empty field is not an error and stores nothing', async () => {
  const store = memory();
  allowlist.setStorage(store);
  const { document } = page();
  await settings.start(document);

  assert.strictEqual(await type(document, '   '), false);
  assert.strictEqual(errorText(document), '');
  assert.strictEqual(store.writes.length, 0, 'an empty field was stored');

  assert.strictEqual(await type(document, 'containerd/containerd'), true);
  assert.strictEqual(store.writes.length, 1, 'a filled field went unstored');
});

test('a repository already listed is refused once and listed once', async () => {
  const store = memory(['containerd/containerd']);
  allowlist.setStorage(store);
  const { document } = page();
  await settings.start(document);

  assert.strictEqual(await type(document, 'Containerd/Containerd'), false);
  assert.strictEqual(errorText(document), settings.DUPLICATE_MESSAGE);
  assert.deepStrictEqual(shown(document), ['containerd/containerd']);
  assert.strictEqual(store.writes.length, 0, 'a repository already listed was stored again');

  assert.strictEqual(await type(document, 'containerd/nerdctl'), true);
  assert.strictEqual(store.writes.length, 1, 'a repository not yet listed went unstored');
  assert.deepStrictEqual(shown(document), ['containerd/containerd', 'containerd/nerdctl']);
});

test('pressing Remove takes the repository out of storage and off the page', async () => {
  const store = memory(['containerd/containerd', 'git-utensils/spoon-knife']);
  allowlist.setStorage(store);
  const { window, document } = page();
  await settings.start(document);
  assert.deepStrictEqual(shown(document), ['containerd/containerd', 'git-utensils/spoon-knife']);

  const button = document.querySelector('#list button[data-entry="containerd/containerd"]');
  assert.ok(button !== null, 'the row carries no control that removes it');
  // Accessible names must distinguish each repository's Remove button.
  assert.strictEqual(
    button.getAttribute('aria-label'),
    'Remove containerd/containerd',
    'the control does not name the repository it removes'
  );
  button.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepStrictEqual(shown(document), ['git-utensils/spoon-knife']);
  assert.deepStrictEqual(store.entries[allowlist.STORAGE_KEY], ['git-utensils/spoon-knife']);
  assert.strictEqual(allowlist.isAllowed('containerd/containerd'), false);
});

test('submitting the form adds what is typed', async () => {
  allowlist.setStorage(memory());
  const { window, document } = page();
  await settings.start(document);

  /** @type {HTMLInputElement} */ (document.getElementById('add-input')).value =
    'containerd/nerdctl';
  const form = document.getElementById('add-form');
  assert.ok(form !== null, 'the page carries no form');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepStrictEqual(shown(document), ['containerd/nerdctl']);
});

test('a list changed elsewhere is redrawn without the page being reloaded', async () => {
  allowlist.setStorage(memory(['containerd/containerd']));
  const { document } = page();
  await settings.start(document);
  assert.deepStrictEqual(shown(document), ['containerd/containerd']);

  await allowlist.save(['git-utensils/spoon-knife']);
  assert.deepStrictEqual(shown(document), ['git-utensils/spoon-knife']);
});

test('pressing Clear cache empties every store and leaves the list', async () => {
  const store = memory([CONTAINERD, NERDCTL, SPOON], reads([CONTAINERD, NERDCTL, SPOON]));
  allowlist.setStorage(store);
  cache.setStorage(store);
  const { window, document } = page();
  await settings.start(document);

  await pressClear(document, window);

  for (const repository of [CONTAINERD, NERDCTL, SPOON]) {
    assert.deepStrictEqual(survivors(store, repository), [], `${repository} survived the clear`);
  }
  assert.strictEqual(Object.hasOwn(store.entries, members.MEMBERS_KEY), false, 'members survived');
  assert.strictEqual(Object.hasOwn(store.entries, branches.BRANCHES_KEY), false, 'branches survived');
  // Preserve the allowlist to keep the extension enabled (REQUIREMENTS.md section 2).
  assert.deepStrictEqual(store.entries[allowlist.STORAGE_KEY], [CONTAINERD, NERDCTL, SPOON]);
  assert.deepStrictEqual(Object.keys(store.entries), [allowlist.STORAGE_KEY]);
  assert.deepStrictEqual(shown(document), [CONTAINERD, NERDCTL, SPOON]);
  assert.strictEqual(allowlist.isAllowed(CONTAINERD), true);
});

test('a press of Clear cache is answered on the page', async () => {
  const store = memory([CONTAINERD], reads([CONTAINERD]));
  allowlist.setStorage(store);
  cache.setStorage(store);
  const { window, document } = page();
  await settings.start(document);
  assert.strictEqual(clearedText(document), '');

  await pressClear(document, window);
  assert.strictEqual(clearedText(document), settings.CLEARED_MESSAGE);

  await type(document, 'containerd/nerdctl');
  assert.strictEqual(clearedText(document), '');
});

test('pressing Remove clears that repository and leaves the others', async () => {
  const listed = [CONTAINERD, NERDCTL, SPOON];
  const store = memory(listed, reads(listed));
  allowlist.setStorage(store);
  cache.setStorage(store);
  const { window, document } = page();
  await settings.start(document);

  const button = document.querySelector(`#list button[data-entry="${CONTAINERD}"]`);
  assert.ok(button !== null, 'the row carries no control that removes it');
  button.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepStrictEqual(survivors(store, CONTAINERD), []);
  assert.deepStrictEqual(survivors(store, NERDCTL), keysOf(NERDCTL));
  assert.deepStrictEqual(survivors(store, SPOON), keysOf(SPOON));
  assert.deepStrictEqual(namesIn(store, branches.BRANCHES_KEY), [NERDCTL, SPOON].sort());
  assert.deepStrictEqual(namesIn(store, members.MEMBERS_KEY), ['containerd', 'git-utensils']);
  assert.deepStrictEqual(shown(document), [NERDCTL, SPOON]);
});

test('the page loads every file its script reaches, in an order that works', () => {
  // The settings page loads dependencies through its own script tags.
  // Node require calls do not check that order.
  const html = fs.readFileSync(path.join(root, 'src', 'settings', 'settings.html'), 'utf8');
  const loaded = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((found) =>
    path.posix.normalize(path.posix.join('src/settings', String(found[1])))
  );
  assert.strictEqual(loaded.at(-1), 'src/settings/settings.js', 'the page script is not last');

  /** @type {string[]} */
  const already = [];
  for (const file of loaded) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const found of source.matchAll(/require\('([^']+)'\)/g)) {
      const needed = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), String(found[1]))
      );
      assert.ok(already.includes(needed), `${file} reaches ${needed}, which the page has not loaded`);
    }
    already.push(file);
  }
});
