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
 * The settings page itself, so the ids the script reaches for are the ids the
 * page carries and not a copy of them written here.
 *
 * @returns {{ window: any, document: Document }}
 */
function page() {
  const html = fs.readFileSync(path.join(root, 'src', 'settings', 'settings.html'), 'utf8');
  const { window, document } = parseHTML(html);
  return { window, document: /** @type {Document} */ (/** @type {unknown} */ (document)) };
}

/**
 * A storage seeded with the allowlist and with whatever else the extension has
 * left behind. `remove` is on it because the clear will not use a storage
 * without it, and a stand-in it declines is one no clear could ever reach: an
 * assertion that a key went would then fail for the wrong reason, and one that
 * a key stayed would hold however much was cleared.
 *
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
 * @returns {string} the reason the page is showing for refusing an entry, and
 *   empty where it is showing none.
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
 * @returns {string} what the page is saying about the clear, and empty where it
 *   is saying nothing.
 */
function clearedText(doc) {
  const status = doc.getElementById('clear-status');
  if (status === null || status.hasAttribute('hidden')) return '';
  return status.textContent ?? '';
}

/** Two repositories in one organization, and one in another. */
const CONTAINERD = 'containerd/containerd';
const NERDCTL = 'containerd/nerdctl';
const SPOON = 'git-utensils/spoon-knife';

/**
 * The keys one repository's reads are held under.
 *
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
 * Everything a browser that has read these repositories holds besides the list.
 *
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
 * @returns {string[]} the names the map at that key still carries.
 */
function namesIn(store, key) {
  const value = store.entries[key];
  return value === undefined || value === null ? [] : Object.keys(value).sort();
}

/**
 * @param {Document} doc
 * @param {any} window
 * @returns {Promise<void>} presses the control that empties the stores and lets
 *   the reads and writes it starts land.
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
  // In a tab rather than a popup, because the list is edited rather than read.
  assert.strictEqual(manifest.options_ui.open_in_tab, true);
  // Every surface is a content script, and nothing runs outside a page.
  // REQUIREMENTS.md section 12. Both the key and the file are checked: either
  // one alone leaves the other free to come back and sit there unnoticed.
  assert.ok(!Object.hasOwn(manifest, 'background'), 'the manifest declares a background script');
  assert.ok(
    !fs.existsSync(path.join(root, 'src', 'background.js')),
    'src/background.js is in the tree'
  );
  for (const file of ['src/settings/settings.html', 'src/settings/settings.js'])
    assert.ok(fs.existsSync(path.join(root, file)), `${file} is declared and missing`);
  // The settings page is not a content script and belongs in neither list.
  assert.ok(!manifest.content_scripts[0].js.includes('src/settings/settings.js'));
});

test('the manifest forbids any page from framing the extension pages', () => {
  // The settings page is in `web_accessible_resources` for `https://github.com/*`,
  // which is what lets the button on an off-allowlist advisory page open it. That
  // same listing lets a script on `github.com` put the page in a frame, so the
  // policy denies framing outright. Firefox has enforced `frame-ancestors` on
  // extension pages since 97 (CVE-2022-22761) and Chrome always has; the manifest
  // asks for 128 or later.
  const policy = manifest.content_security_policy.extension_pages;
  assert.match(policy, /frame-ancestors 'none'/);
  // Declaring the key replaces the browser's default, so the default's own
  // protections are restated here: Chrome's `script-src 'self'; object-src 'self';`
  // and Firefox's `script-src 'self'; upgrade-insecure-requests;`. Anything looser
  // in `script-src` would let the page run code it did not ship with.
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
  // On a fresh install this is the only thing on the page explaining why
  // nothing is happening, so it names the next step rather than the absence.
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
  // The field is cleared, so the next repository is typed into an empty one.
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
    // What was typed stays in the field, so it can be corrected.
    assert.strictEqual(
      /** @type {HTMLInputElement} */ (document.getElementById('add-input')).value,
      typed
    );
  }

  assert.deepStrictEqual(shown(document), []);
  assert.strictEqual(store.writes.length, 0, 'a repository the page refused was stored');
  assert.deepStrictEqual(store.entries, {});

  // A repository the page accepts does store, so the zero above is the refusal
  // and not a count that cannot move.
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

  // A field carrying a repository does store, so the zero above is the empty
  // field and not a count that cannot move.
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

  // A repository the list does not carry does store, so the zero above is the
  // duplicate and not a count that cannot move.
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
  // Every row's control reads Remove, so the name is what tells one from the
  // next for a reader moving between them by control alone.
  assert.strictEqual(
    button.getAttribute('aria-label'),
    'Remove containerd/containerd',
    'the control does not name the repository it removes'
  );
  button.dispatchEvent(new window.Event('click', { bubbles: true }));
  // The press reads and writes storage, so the page catches up a turn later.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepStrictEqual(shown(document), ['git-utensils/spoon-knife']);
  assert.deepStrictEqual(store.entries[allowlist.STORAGE_KEY], ['git-utensils/spoon-knife']);
  assert.strictEqual(allowlist.isAllowed('containerd/containerd'), false);
});

test('submitting the form adds what is typed', async () => {
  // The page is driven through its own control here, which is what proves the
  // control is wired to the code the rest of these tests call directly.
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
  // The list is what the clear leaves, so the extension goes on running where
  // it was listed. REQUIREMENTS.md section 2.
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

  // It comes down again the next time the maintainer works the list, so what
  // the page says answers the last thing that was pressed.
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
  // `containerd/nerdctl` is still listed, so the organization's members stay.
  assert.deepStrictEqual(namesIn(store, members.MEMBERS_KEY), ['containerd', 'git-utensils']);
  assert.deepStrictEqual(shown(document), [NERDCTL, SPOON]);
});

test('the page loads every file its script reaches, in an order that works', () => {
  // The page is not a content script, so the manifest does not order what it
  // loads and its own script tags do. A file reached through `bghsa` but never
  // loaded, or loaded after the file that reaches it, is a page that throws on
  // a press and a suite that never sees it: the tests here load each file
  // through `require`, which finds them whatever the page says.
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
