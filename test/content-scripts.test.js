'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

/**
 * The files the manifest loads into a page, in the order it loads them. Reading
 * the list here rather than repeating it means a file added to the manifest is
 * covered without anyone remembering to add it.
 *
 * @type {string[]}
 */
const scripts = manifest.content_scripts[0].js;

/** A repository on the allowlist, so the pages below are ones writes reach. */
const REPO = '/git-utensils/Spoon-Knife';

/** That repository as the allowlist stores it, and the key it is stored under. */
const ALLOWED = 'git-utensils/spoon-knife';
const ALLOWLIST_KEY = 'allowlist';

/** A GitHub page the extension has no surface for. */
const PULLS = `${REPO}/pulls`;

/**
 * What this browser's `runtime.getURL` prefixes a path with. Firefox builds it
 * from a UUID it generates for the installation, so the shape is Firefox's and
 * the digits are this test's.
 */
const EXTENSION_ORIGIN = 'moz-extension://11111111-2222-3333-4444-555555555555';

/** A repository the allowlist does not carry. */
const OTHER = '/another-owner/another-repo';

const OTHER_LIST = `${OTHER}/security/advisories`;
const OTHER_ADVISORY = `${OTHER_LIST}/GHSA-1234-5678-9abc`;

const ADVISORY_LIST = `${REPO}/security/advisories`;
const ADVISORY = `${ADVISORY_LIST}/GHSA-1234-5678-9abc`;

/**
 * @param {string} name
 * @returns {string} a fixture's markup. The fixtures are large, so each test
 *   reads only the ones it puts on a page.
 */
function fixture(name) {
  return fs.readFileSync(path.join(root, 'testdata', name), 'utf8');
}

/**
 * The `bghsa` member each file hangs its exports off, by the path the manifest
 * names the file under, read from the declaration in types/bghsa.d.ts.
 *
 * The declaration names a member against a whole path, so the member a file has
 * to leave behind is the one written down for that file. Deriving it from the
 * base name instead let two files in different directories answer for each
 * other: `src/done/stats.js` and a second `stats.js` elsewhere would both look
 * for `bghsa.stats`, and either one loading would satisfy the check for both.
 *
 * @type {Map<string, string>}
 */
const DECLARED = new Map(
  [
    ...fs
      .readFileSync(path.join(root, 'types', 'bghsa.d.ts'), 'utf8')
      .matchAll(/^\s*(\w+): typeof import\('\.\.\/([^']+)'\);$/gm),
  ].map((found) => [String(found[2]), String(found[1])])
);

/**
 * @returns {string[]} the files the settings page loads with its own script
 *   tags, by the path from the repository root, which is how the manifest and
 *   the declaration both write a path.
 */
function pageScripts() {
  const html = fs.readFileSync(path.join(root, 'src', 'settings', 'settings.html'), 'utf8');
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((found) =>
    path.posix.normalize(path.posix.join('src/settings', String(found[1])))
  );
}

/**
 * @param {string} file A path the manifest loads, as it writes it.
 * @returns {string} the member that file has to leave behind.
 */
function memberOf(file) {
  const held = DECLARED.get(file);
  if (held === undefined) throw new Error(`types/bghsa.d.ts declares no member for ${file}`);
  return held;
}

/**
 * @param {unknown} target What a request asked for.
 * @returns {string | null} the repository on `github.com` the URL names,
 *   lowercased, and null where it names none. A URL somewhere other than
 *   `github.com` names no repository here: the extension contacts that one host,
 *   so a request anywhere else is one no list ever permitted.
 */
function repositoryOf(target) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(String(target ?? ''), 'https://github.com');
  } catch {
    return null;
  }
  if (url.origin !== 'https://github.com') return null;
  const [owner, repo] = url.pathname.split('/').filter((part) => part !== '');
  if (owner === undefined || repo === undefined) return null;
  return `${owner}/${repo}`.toLowerCase();
}

/**
 * A stand-in for the one isolated-world global a page's content scripts share.
 * `require` and `module` are absent, which is what a content script gets, so
 * every file takes its browser branch and reaches the others only through
 * `bghsa`.
 *
 * The observer constructor and storage count what they are asked for, because
 * what the extension must not do on a page it has no surface for is watch it or
 * read for it.
 *
 * A request is recorded, not counted. `fetch` answers one that names a
 * repository this page has been told to act on and refuses every other, and a
 * refusal fails the test it was sent from, whatever path sent it. What it
 * recorded is `asked`, so a test can say what went out and not only what did
 * not.
 *
 * @param {{ pathname?: string, frame?: string, allowlist?: readonly string[],
 *   holdStorage?: boolean }} [options]
 *   The page the document loaded as: the URL GitHub is showing and the markup in
 *   the frame it replaces on a soft navigation. `allowlist` is what storage
 *   holds for the extension's list of repositories, which is empty on a fresh
 *   install and here defaults to the one the fixtures come from, and
 *   `holdStorage` makes every read hang, which is the page as it stands before
 *   the list has arrived.
 * @returns {Record<string, any>} the sandbox backing the context
 */
function contentScriptScope(options = {}) {
  const pathname = options.pathname ?? ADVISORY;
  const { window, document } = parseHTML(
    '<!doctype html><html><head></head><body><div id="repo-content-turbo-frame">' +
      (options.frame ?? '') +
      '</div></body></html>'
  );

  const counts = { made: 0, connected: 0, reads: 0, writes: 0 };
  /**
   * Everything the extension asked GitHub for, in the order it asked. The
   * refusal below fails the test that sent a request no list permitted; this
   * is the other half, and it is what tells a page that asked for the right
   * repository from a page that asked for nothing at all.
   *
   * @type {string[]}
   */
  const asked = [];
  /** What storage holds, so a read answers with what a write put there. */
  /** @type {Record<string, unknown>} */
  const stored = {};
  stored[ALLOWLIST_KEY] = [...(options.allowlist ?? [ALLOWED])];
  /**
   * @returns {string[]} the repositories this page has been told to act on,
   *   lowercased, which is the list as the extension has been able to read it. A
   *   page whose read is still out has been told none, and the settings page
   *   editing the list changes what this answers from the same moment the page
   *   under test hears about it.
   */
  function listed() {
    if (options.holdStorage === true) return [];
    const held = stored[ALLOWLIST_KEY];
    return (Array.isArray(held) ? held : []).map((entry) => String(entry).toLowerCase());
  }
  /** Every key a write has named, in the order they were written. */
  /** @type {string[]} */
  const written = [];
  /**
   * Whoever the extension has asked to hear about a storage change. The browser
   * announces one page of an extension writing to the others, which is how a
   * settings page reaches an advisory page that is already open.
   *
   * @type {((changes: Record<string, { newValue?: unknown }>, area: string) => void)[]}
   */
  const changeListeners = [];
  const Native = window.MutationObserver;
  /**
   * @param {MutationCallback} callback
   * @returns {object} the observer, counting the connections it is asked for.
   */
  function CountingObserver(callback) {
    counts.made += 1;
    const inner = new Native(callback);
    return {
      /**
       * @param {Node} target
       * @param {MutationObserverInit} [init]
       * @returns {void}
       */
      observe(target, init) {
        counts.connected += 1;
        inner.observe(target, init);
      },
      disconnect: () => inner.disconnect(),
      takeRecords: () => inner.takeRecords(),
    };
  }

  const quiet = () => {};
  /**
   * Every tab the page has asked the browser to open, which is how the one
   * control the extension shows off the allowlist reaches the settings page.
   *
   * @type {{ url: unknown, target: unknown }[]}
   */
  const opened = [];
  // linkedom's window carries no `open`, and a control that opened a real one
  // would take the test process to a page.
  Object.defineProperty(window, 'open', {
    configurable: true,
    writable: true,
    /**
     * @param {unknown} url
     * @param {unknown} target
     * @returns {null}
     */
    value: (url, target) => {
      opened.push({ url, target });
      return null;
    },
  });
  /** @type {Record<string, any>} */
  const sandbox = {
    document,
    window,
    MutationObserver: CountingObserver,
    location: { pathname, href: `https://github.com${pathname}` },
    // `remove` is here because the cache will not use a storage without it, and
    // a stand-in the cache declines is one no cache write could ever reach: an
    // assertion that nothing was stored would then hold however much the
    // extension tried to store.
    browser: {
      runtime: {
        /**
         * @param {string} path
         * @returns {string} the extension's own address for one of its files.
         */
        getURL: (path) => `${EXTENSION_ORIGIN}/${path}`,
      },
      storage: {
        local: {
          /**
           * @param {string | string[] | null} keys
           * @returns {Promise<Record<string, unknown>>}
           */
          get: async (keys) => {
            if (options.holdStorage === true) return new Promise(() => {});
            // The extension's own list of repositories is not something stored
            // for a repository, and it is read on every github.com page,
            // including the ones the extension goes on to leave alone. The
            // count is of the reads a page costs, so that one is not in it.
            if (keys !== ALLOWLIST_KEY) counts.reads += 1;
            if (keys === null || keys === undefined) return { ...stored };
            /** @type {Record<string, unknown>} */
            const answer = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (Object.hasOwn(stored, key)) answer[key] = stored[key];
            }
            return answer;
          },
          /**
           * @param {Record<string, unknown>} items
           * @returns {Promise<void>}
           */
          set: async (items) => {
            counts.writes += 1;
            for (const [key, value] of Object.entries(items)) {
              stored[key] = value;
              written.push(key);
            }
          },
          /**
           * @param {string | string[]} keys
           * @returns {Promise<void>}
           */
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
          },
        },
        onChanged: {
          /**
           * @param {(changes: Record<string, { newValue?: unknown }>, area: string) => void} fn
           * @returns {void}
           */
          addListener: (fn) => {
            changeListeners.push(fn);
          },
        },
      },
    },
    console: { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet },
    // The page's own timers are held unreferenced. A pass still waiting on the
    // request that never settles has one pending when the last assertion runs,
    // and a referenced timer would keep the test process alive after it.
    /**
     * @param {(...args: any[]) => void} fn
     * @param {number} [ms]
     * @returns {unknown}
     */
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearTimeout,
    crypto,
    TextEncoder,
    TextDecoder,
    // The bound every request runs inside is built on one of these. Without it
    // the request path throws before it reaches `fetch`, and a page that asked
    // GitHub for nothing at all reads here exactly like a page that asked for
    // the right repository and is waiting on the answer.
    AbortController,
    /**
     * The privacy boundary REQUIREMENTS.md section 12 draws, enforced where a
     * request would leave: the extension asks GitHub for the repositories on the
     * list and for nothing else, on any page and through any path.
     *
     * A request for a listed repository never settles, so a page-load fetch
     * neither succeeds nor rejects.
     *
     * A request for anything else throws, and is thrown again outside this
     * promise chain. The surfaces catch a request that failed and carry on, so
     * the error handed to the caller is answered by whatever asked and reaches
     * no further; the rethrow is what fails the test, carrying the stack of the
     * code that sent it.
     *
     * @param {unknown} target What the caller asked GitHub for, absolute or as
     *   the path the extension builds.
     * @returns {Promise<never>}
     */
    fetch: (target) => {
      asked.push(String(target));
      const wanted = repositoryOf(target);
      if (wanted !== null && listed().includes(wanted)) return new Promise(() => {});
      const refused = new Error(`the extension asked GitHub for ${String(target)}`);
      setTimeout(() => {
        throw refused;
      });
      throw refused;
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.opened = opened;
  sandbox.counts = counts;
  sandbox.asked = asked;
  sandbox.written = written;
  sandbox.stored = stored;
  sandbox.changeListeners = changeListeners;
  vm.createContext(sandbox);
  return sandbox;
}

/**
 * @param {Record<string, any>} sandbox
 * @returns {string[]} what went wrong loading the manifest's files into this
 *   scope, and empty when every one of them loaded and left its exports behind.
 */
function loadScripts(sandbox) {
  /** @type {string[]} */
  const failures = [];
  for (const file of scripts) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    try {
      // A browser aborts the file that threw and loads the rest, so this
      // reports every file that failed and not only the first.
      vm.runInContext(code, sandbox, { filename: file });
    } catch (error) {
      failures.push(`${file} threw: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    const member = memberOf(file);
    if (sandbox.bghsa === undefined || sandbox.bghsa[member] === undefined) {
      failures.push(`${file} left no bghsa.${member}`);
    }
  }
  return failures;
}

/**
 * @param {Record<string, any>} sandbox
 * @returns {string[]} the extension's own names on the page, deduplicated and
 *   sorted. Everything it writes is named `bghsa` something, in an id, a class
 *   or an attribute, so this finds a surface, a stylesheet and a chip alike
 *   without naming each one, and says which it found.
 */
function names(sandbox) {
  const html = sandbox.document.documentElement.outerHTML;
  return [...new Set(html.match(/bghsa[a-z-]*/g) ?? [])].sort();
}

/**
 * @param {Record<string, any>} sandbox
 * @returns {Element | null} the one control the extension shows on an advisory
 *   page of a repository the allowlist does not carry.
 */
function control(sandbox) {
  return sandbox.document.getElementById(sandbox.bghsa.settingsControl.CONTROL_ID);
}

/**
 * @param {Record<string, any>} sandbox
 * @returns {number} how many controls the page carries. Counted by selector and
 *   not by id, because a second control carries the id the first one does and
 *   `getElementById` answers with one of them however many are there.
 */
function controls(sandbox) {
  return sandbox.document.querySelectorAll(`#${sandbox.bghsa.settingsControl.CONTROL_ID}`).length;
}

/**
 * @param {Record<string, any>} sandbox
 * @param {string} pathname
 * @returns {string} the sentinel of the surface that page belongs to, which is
 *   the block the control sits above once the surface has drawn it.
 */
function blockId(sandbox, pathname) {
  return pathname.split('/').length > 5
    ? sandbox.bghsa.panel.PANEL_ID
    : sandbox.bghsa.table.ROOT_ID;
}

/**
 * The surfaces, asserted absent by their own sentinels. The control is drawn on
 * a page neither of them may take, so a check that the page carries the control
 * says nothing about whether a surface came with it.
 *
 * @param {Record<string, any>} sandbox
 * @param {string} why
 * @returns {void}
 */
function noSurface(sandbox, why) {
  // Compared as booleans: a failure carrying a node makes the runner serialize
  // the subtree to report it, which exhausts the heap instead of printing.
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) === null,
    `the panel ${why}`
  );
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.table.ROOT_ID) === null,
    `the table ${why}`
  );
}

/**
 * GitHub replacing the frame: new markup inside it, a new URL, and the event
 * its framework fires inside the frame once the page is there.
 *
 * @param {Record<string, any>} sandbox
 * @param {{ pathname?: string, frame?: string }} to
 * @returns {void}
 */
function navigate(sandbox, to) {
  const frame = sandbox.document.getElementById('repo-content-turbo-frame');
  assert.ok(frame !== null, 'the page carries no frame to replace');
  if (to.frame !== undefined) frame.innerHTML = to.frame;
  if (to.pathname !== undefined) {
    sandbox.location.pathname = to.pathname;
    sandbox.location.href = `https://github.com${to.pathname}`;
  }
  const name = sandbox.bghsa.content.FRAME_EVENTS[0];
  frame.dispatchEvent(new sandbox.window.Event(name, { bubbles: true }));
}

/**
 * A maintainer editing the list in the extension's settings, which is another
 * page of this extension writing to the same storage. The page under test hears
 * it the way the browser tells it: a change announcement, not a read.
 *
 * @param {Record<string, any>} sandbox
 * @param {readonly string[]} entries
 * @returns {void}
 */
function setAllowlist(sandbox, entries) {
  const next = [...entries];
  sandbox.stored[ALLOWLIST_KEY] = next;
  for (const listener of [...sandbox.changeListeners]) {
    listener({ [ALLOWLIST_KEY]: { newValue: next } }, 'local');
  }
}

/**
 * Waits for the page to reach GitHub. The work a page load starts runs on the
 * clock, not on a fixed number of turns: the queue holds its requests to one a
 * second, so how many turns pass before the first one goes out is not fixed.
 *
 * @param {Record<string, any>} sandbox
 * @param {number} [limitMs] How long to wait before giving up on one.
 * @returns {Promise<void>} settled once a request has gone out, or once the
 *   bound has passed with none.
 */
async function asksGitHub(sandbox, limitMs = 20_000) {
  const until = Date.now() + limitMs;
  while (sandbox.asked.length === 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * @param {number} [turns] How many turns of the event loop to give the page.
 * @returns {Promise<void>} settled once the work a pass started has run.
 */
async function settle(turns = 40) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * A navigation redraw is debounced by `RENDER_DELAY_MS`, so a fixed number of
 * event-loop turns can finish before the new surface appears.
 *
 * @param {() => boolean} reached Whether the expected state has appeared.
 * @param {number} [limitMs] Maximum time to wait.
 * @returns {Promise<void>} resolves when `reached` returns true or the limit
 *   elapses.
 */
async function waitFor(reached, limitMs = 2_000) {
  const until = Date.now() + limitMs;
  while (!reached() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('every manifest content script loads in one shared scope', async () => {
  /** @type {string[]} */
  const rejections = [];

  /** @type {(reason: unknown) => void} */
  const onRejection = (reason) => {
    rejections.push(`rejected after load: ${reason instanceof Error ? reason.message : reason}`);
  };
  process.prependListener('unhandledRejection', onRejection);

  const sandbox = contentScriptScope();
  let failures;
  try {
    failures = loadScripts(sandbox);
    // The self-running files start asynchronous work. Let it reach the point
    // where a member missing from the shared namespace would reject.
    await settle(4);
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }

  assert.deepStrictEqual([...failures, ...rejections], []);
  assert.deepStrictEqual(Object.keys(sandbox.bghsa).sort(), scripts.map(memberOf).sort());
});

test('every content script is declared under a name of its own', () => {
  // A file the declaration has no line for has no member this check could ask
  // for, and one declared for a file nothing loads is a line nothing stands
  // behind.
  assert.deepStrictEqual(
    scripts.filter((file) => !DECLARED.has(file)),
    [],
    'a content script types/bghsa.d.ts declares no member for'
  );
  // The settings page is not a content script and the manifest does not list
  // what it loads, so the page itself says. A file only that page loads still
  // hangs its exports off the shared namespace and is still declared.
  const loaded = new Set([...scripts, ...pageScripts()]);
  assert.deepStrictEqual(
    [...DECLARED.keys()].filter((file) => !loaded.has(file)),
    [],
    'a member declared for a file nothing loads'
  );

  // Two files under one member is the collision this check exists to catch:
  // either of them loading would answer for both.
  const names = [...DECLARED.values()];
  assert.deepStrictEqual(
    names.filter((name, at) => names.indexOf(name) !== at),
    [],
    'a member two files are declared under'
  );
});

test('the settings page the control opens is the one the manifest exposes', () => {
  const settingsControl = require('../src/common/settings-control.js');

  // A navigation a github.com page starts to an extension page is blocked
  // unless the page is listed here, and a content script cannot open the
  // settings any other way: `runtime.openOptionsPage` is not among the APIs a
  // content script has, and this extension has no background script to ask.
  /** @type {{ resources: string[], matches: string[] }[]} */
  const exposed = manifest.web_accessible_resources;
  assert.deepStrictEqual(exposed, [
    { resources: ['src/settings/settings.html'], matches: ['https://github.com/*'] },
  ]);

  // Listing a resource makes it reachable by every page on the matched origins,
  // so the origins are the ones the extension already runs on and no others.
  // Without `matches` it would be reachable from every site.
  const [entry] = exposed;
  assert.ok(entry !== undefined, 'the manifest exposes nothing');
  assert.deepStrictEqual(entry.matches, manifest.content_scripts[0].matches);

  // One page is exposed, and it is the page the control opens and the page the
  // browser's own add-on settings open. A path that got out of step here would
  // leave the control opening an address the browser blocks.
  assert.deepStrictEqual(entry.resources, [settingsControl.SETTINGS_PAGE]);
  assert.strictEqual(manifest.options_ui.page, settingsControl.SETTINGS_PAGE);
});

test('a GitHub page the extension has no surface for is left alone', async () => {
  const sandbox = contentScriptScope({
    pathname: PULLS,
    frame: fixture('select-menu.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  assert.deepStrictEqual(names(sandbox), [], 'the extension wrote on a page it has no surface for');
  assert.strictEqual(sandbox.counts.connected, 0, 'an observer was connected');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer was made');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read');
});

test('a page that becomes the advisory list gets the table', async () => {
  const sandbox = contentScriptScope({
    pathname: PULLS,
    frame: fixture('select-menu.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.deepStrictEqual(names(sandbox), [], 'a surface took a pull requests page');

  // The markup on its own is not the signal. GitHub renders an advisory list
  // into the frame on other pages than the advisory list, and the URL is what
  // says which page this is.
  navigate(sandbox, { frame: fixture('list-page-triage.html') });
  await settle();
  assert.deepStrictEqual(names(sandbox), [], 'a surface started while the URL still said pulls');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read for a page the URL does not name');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer watched a page the URL does not name');

  navigate(sandbox, { pathname: ADVISORY_LIST });
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.table.ROOT_ID) !== null,
    `the table never landed; the page carries ${names(sandbox).join(', ') || 'nothing'}`
  );
  assert.ok(sandbox.counts.connected > 0, 'the surface started with nothing watching the page');
  // The counts the tests above read zero from are counts that move, and the key
  // list they read empty is a list that gets pushed to. A surface that has
  // landed watches the page, reads storage, and stores what it read.
  assert.ok(sandbox.counts.made > 0, 'the surface made no observer');
  assert.ok(sandbox.counts.reads > 0, 'the surface read no storage');
  assert.ok(sandbox.counts.writes > 0, 'the surface stored nothing');
  assert.ok(sandbox.written.length > 0, 'the surface named no key it stored');
});

test('a page that becomes an advisory gets the panel', async () => {
  const sandbox = contentScriptScope({
    pathname: PULLS,
    frame: fixture('select-menu.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.deepStrictEqual(names(sandbox), [], 'a surface took a pull requests page');

  navigate(sandbox, { frame: fixture('published-containerd.html') });
  await settle();
  assert.deepStrictEqual(names(sandbox), [], 'a surface started while the URL still said pulls');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read for a page the URL does not name');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer watched a page the URL does not name');

  navigate(sandbox, { pathname: ADVISORY });
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) !== null,
    `the panel never landed; the page carries ${names(sandbox).join(', ') || 'nothing'}`
  );
  assert.ok(sandbox.counts.connected > 0, 'the surface started with nothing watching the page');
  // The counts the tests above read zero from are counts that move, and the key
  // list they read empty is a list that gets pushed to. A surface that has
  // landed watches the page, reads storage, and stores what it read.
  assert.ok(sandbox.counts.made > 0, 'the surface made no observer');
  assert.ok(sandbox.counts.reads > 0, 'the surface read no storage');
  assert.ok(sandbox.counts.writes > 0, 'the surface stored nothing');
  assert.ok(sandbox.written.length > 0, 'the surface named no key it stored');
});

test('a page on a listed repository asks GitHub for that repository', async () => {
  // Every gate test above reads a request that did not go out. Nothing read
  // one that did, so a change that left the extension asking for nothing would
  // satisfy all of them: silence and correctness look alike from there.
  const sandbox = contentScriptScope({
    pathname: ADVISORY_LIST,
    frame: fixture('list-page-triage.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await asksGitHub(sandbox);

  assert.ok(
    sandbox.asked.length > 0,
    `the extension asked GitHub for nothing; the page carries ${
      names(sandbox).join(', ') || 'nothing'
    }`
  );
  // Every one of them named the repository on the list. The double throws on a
  // request naming anything else, so this says what the throw cannot: the
  // requests that were permitted were for the repository the page is showing.
  assert.deepStrictEqual(
    [...new Set(sandbox.asked.map((/** @type {string} */ target) => repositoryOf(target)))],
    [ALLOWED],
    `the extension asked for ${sandbox.asked.join(', ')}`
  );
});

test('an advisory on a repository the allowlist does not carry gets the control alone', async () => {
  const sandbox = contentScriptScope({
    pathname: OTHER_ADVISORY,
    frame: fixture('triage-thread.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  // What is asserted first, because it is what a panel-shaped assertion misses.
  // A surface that drew nothing can still have read the advisory and stored it:
  // the panel holds the advisory it renders, the logins carrying a member
  // badge, and the branches the patches name, and none of those is on the page
  // to be looked for.
  assert.deepStrictEqual(sandbox.written, [], 'something was stored');
  assert.strictEqual(sandbox.counts.writes, 0, 'storage was written');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read');
  // The page is an advisory and the extension has a surface for it; the
  // repository is the only thing keeping the surface off. REQUIREMENTS.md
  // section 8.
  noSurface(sandbox, 'took an advisory on a repository the allowlist does not carry');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer was made');
  assert.strictEqual(sandbox.counts.connected, 0, 'an observer was connected');

  // The one thing the extension does show here. The names are checked against
  // the whole list rather than the control alone, so a surface that wrote
  // anything else under the extension's own name fails this too.
  assert.deepStrictEqual(
    names(sandbox),
    [sandbox.bghsa.settingsControl.CONTROL_ID],
    'the extension wrote something beside the control'
  );
  const shown = control(sandbox);
  assert.ok(shown !== null, 'the control never landed');
  assert.strictEqual(shown.textContent?.trim(), 'Better GHSA settings');
  // Primer's own button, so the control reads as part of the page it sits on.
  assert.ok(
    shown.querySelector('button')?.classList.contains('btn'),
    'the control is not drawn as a button of the page'
  );
});

test('an advisory list on a repository the allowlist does not carry gets the control alone', async () => {
  const sandbox = contentScriptScope({
    pathname: OTHER_LIST,
    frame: fixture('list-page-triage.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  // The list page's own stores, asserted first for the same reason: the parsed
  // list, and the crawl's progress carrying the moment of the last request.
  assert.deepStrictEqual(sandbox.written, [], 'something was stored');
  assert.strictEqual(sandbox.counts.writes, 0, 'storage was written');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read');
  noSurface(sandbox, 'took an advisory list on a repository the allowlist does not carry');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer was made');
  assert.strictEqual(sandbox.counts.connected, 0, 'an observer was connected');

  assert.deepStrictEqual(
    names(sandbox),
    [sandbox.bghsa.settingsControl.CONTROL_ID],
    'the extension wrote something beside the control'
  );
  const shown = control(sandbox);
  assert.ok(shown !== null, 'the control never landed');
  assert.strictEqual(shown.textContent?.trim(), 'Better GHSA settings');
  // Primer's own button, so the control reads as part of the page it sits on.
  assert.ok(
    shown.querySelector('button')?.classList.contains('btn'),
    'the control is not drawn as a button of the page'
  );
});

test('the control opens the extension settings in a tab of their own', async () => {
  const sandbox = contentScriptScope({
    pathname: OTHER_ADVISORY,
    frame: fixture('triage-thread.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  const shown = control(sandbox);
  assert.ok(shown !== null, 'the control never landed');
  const button = shown.querySelector('button');
  assert.ok(button !== null, 'the control carries nothing to press');
  assert.deepStrictEqual(sandbox.opened, [], 'a tab was opened before anything was pressed');

  button.dispatchEvent(new sandbox.window.Event('click', { bubbles: true }));
  await settle(2);

  assert.deepStrictEqual(sandbox.opened, [
    { url: `${EXTENSION_ORIGIN}/src/settings/settings.html`, target: '_blank' },
  ]);

  // The address is the browser's own for this installation, and on Firefox it
  // is a UUID no page may learn. It stays out of the page: an attribute
  // carrying it would hand it to every script on github.com.
  assert.ok(
    !sandbox.document.documentElement.outerHTML.includes(EXTENSION_ORIGIN),
    'the extension address was written into the page'
  );

  // Pressing it is not a read or a write either.
  assert.deepStrictEqual(sandbox.written, [], 'something was stored');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read');
});

test('the pages the extension runs on carry one control, above its own block', async () => {
  /** @type {[string, string][]} */
  const pages = [
    [ADVISORY, 'triage-thread.html'],
    [ADVISORY_LIST, 'list-page-triage.html'],
  ];
  for (const [pathname, frame] of pages) {
    const sandbox = contentScriptScope({ pathname, frame: fixture(frame) });
    assert.deepStrictEqual(loadScripts(sandbox), []);
    await settle();

    // The surface having started is what makes this page the running case, so
    // it is asserted before where the control sits is read as saying anything.
    const sentinel = blockId(sandbox, pathname);
    assert.ok(
      sandbox.document.getElementById(sentinel) !== null,
      `the surface never took ${pathname}`
    );

    // One control, on the surface's own page as on every other advisory page.
    // REQUIREMENTS.md section 12.
    assert.strictEqual(controls(sandbox), 1, `${pathname} carries ${controls(sandbox)} controls`);
    const shown = control(sandbox);
    assert.ok(shown !== null, `the control never landed on ${pathname}`);
    assert.strictEqual(shown.textContent?.trim(), 'Better GHSA settings');
    // Primer's own button, so the control reads as part of the page it sits on.
    assert.ok(
      shown.querySelector('button')?.classList.contains('btn'),
      `the control on ${pathname} is not drawn as a button of the page`
    );

    // Directly above the extension's own block, which is what makes it read as
    // the extension's control and not one more of GitHub's. Compared by name,
    // because a failure carrying the node makes the runner serialize the
    // subtree to report it.
    assert.strictEqual(
      shown.nextElementSibling?.id ?? null,
      sentinel,
      `the control on ${pathname} does not sit above the extension's own block`
    );
  }
});

test('a move between the advisory pages leaves one control', async () => {
  // Each half of the area has a surface of its own and each puts the control
  // above its own block, so a move between them is where a second control would
  // come from.
  const sandbox = contentScriptScope({
    pathname: ADVISORY_LIST,
    frame: fixture('list-page-triage.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.strictEqual(controls(sandbox), 1, 'the advisory list carries no one control');

  navigate(sandbox, { pathname: ADVISORY, frame: fixture('triage-thread.html') });
  await waitFor(() => sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) !== null);
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) !== null,
    `the panel never landed; the page carries ${names(sandbox).join(', ') || 'nothing'}`
  );
  assert.strictEqual(controls(sandbox), 1, `the advisory carries ${controls(sandbox)} controls`);
  assert.strictEqual(
    control(sandbox)?.nextElementSibling?.id ?? null,
    sandbox.bghsa.panel.PANEL_ID,
    'the control does not sit above the panel'
  );

  navigate(sandbox, { pathname: ADVISORY_LIST, frame: fixture('list-page-triage.html') });
  await waitFor(() => sandbox.document.getElementById(sandbox.bghsa.table.ROOT_ID) !== null);
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.table.ROOT_ID) !== null,
    `the table never landed; the page carries ${names(sandbox).join(', ') || 'nothing'}`
  );
  assert.strictEqual(
    controls(sandbox),
    1,
    `the advisory list carries ${controls(sandbox)} controls after the move back`
  );
  assert.strictEqual(
    control(sandbox)?.nextElementSibling?.id ?? null,
    sandbox.bghsa.table.ROOT_ID,
    'the control does not sit above the table'
  );
});

test('the control stays off a GitHub page that is not an advisory page', async () => {
  // The markup on its own is not the signal. GitHub renders an advisory list
  // into the frame on other pages than the advisory list, so the page here
  // carries an anchor the control would take and a URL that names no advisory
  // page, and the URL is the only thing keeping it off.
  const sandbox = contentScriptScope({
    pathname: PULLS,
    frame: fixture('list-page-triage.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  assert.ok(control(sandbox) === null, 'the control took a pull requests page');

  // The same markup under a URL that does name one carries it, so an anchor
  // the page never offered is not what kept the control off above.
  navigate(sandbox, { pathname: OTHER_LIST });
  await settle();
  assert.ok(control(sandbox) !== null, 'the control never landed on the advisory list');
});

test('a repository leaving the list and rejoining it leaves one control', async () => {
  const sandbox = contentScriptScope({
    pathname: ADVISORY,
    frame: fixture('triage-thread.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) !== null,
    'the panel never landed on the repository the list carried'
  );
  assert.strictEqual(controls(sandbox), 1, 'the page the extension runs on carries no one control');

  setAllowlist(sandbox, []);
  await settle();

  // The surfaces come off and the control stays. It is what the page is left
  // with, and it is what the maintainer puts the repository back with.
  noSurface(sandbox, 'stayed on a repository nobody lists');
  assert.strictEqual(controls(sandbox), 1, `the page carries ${controls(sandbox)} controls`);
  assert.deepStrictEqual(
    names(sandbox),
    [sandbox.bghsa.settingsControl.CONTROL_ID],
    'the extension left its own writing on the page'
  );

  // And putting the repository back leaves the one control where the panel is.
  setAllowlist(sandbox, [ALLOWED]);
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) !== null,
    `the panel never came back; the page carries ${names(sandbox).join(', ') || 'nothing'}`
  );
  assert.strictEqual(
    controls(sandbox),
    1,
    `a second control came with the panel: ${controls(sandbox)} are on the page`
  );
  assert.strictEqual(
    control(sandbox)?.nextElementSibling?.id ?? null,
    sandbox.bghsa.panel.PANEL_ID,
    'the control does not sit above the panel'
  );
});

test('a page that becomes another repository advisory stores nothing for it', async () => {
  // The surfaces are already running, on a repository the allowlist carries.
  // GitHub then replaces the frame with an advisory somewhere else, which loads
  // no document, so the gate at the start of the page is long past.
  const sandbox = contentScriptScope({
    pathname: ADVISORY_LIST,
    frame: fixture('list-page-triage.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.table.ROOT_ID) !== null,
    'the table never landed on the repository the allowlist carries'
  );

  // Nonzero, so the comparison below rests on a recording this test has seen
  // work: the surface stored what it read for the repository it opened on.
  const before = sandbox.written.length;
  assert.ok(before > 0, 'the surface stored nothing on the repository the allowlist carries');
  navigate(sandbox, { pathname: OTHER_ADVISORY, frame: fixture('triage-thread.html') });
  await settle();

  // The repository the page opened on keeps its refresh going, so what is
  // asserted is what the advisory would have stored: the advisory itself, the
  // logins on it, and the branches its patches name.
  const after = /** @type {string[]} */ (sandbox.written.slice(before));
  assert.deepStrictEqual(
    after.filter(
      (key) => key.startsWith('adv:') || key === 'members' || key === 'branches'
    ),
    [],
    `the advisory was stored: ${after.join(', ')}`
  );
  // Compared as a boolean, because a failure carrying the node itself is a
  // subtree the runner serializes to report it, and that exhausts the heap
  // rather than printing a failure.
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) === null,
    'the panel took an advisory on a repository the allowlist does not carry'
  );
});

test('a page that becomes another repository advisory list stores nothing for it', async () => {
  // The list fixture names the repository it came from throughout, and the
  // surface reads that name off the page, so this stands the same page up under
  // a repository the allowlist does not carry.
  const elsewhere = fixture('list-page-triage.html').replaceAll(
    'git-utensils/Spoon-Knife',
    'another-owner/another-repo'
  );

  const sandbox = contentScriptScope({
    pathname: ADVISORY_LIST,
    frame: fixture('list-page-triage.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.table.ROOT_ID) !== null,
    'the table never landed on the repository the allowlist carries'
  );

  // Nonzero, so the comparison below rests on a recording this test has seen
  // work: the surface stored what it read for the repository it opened on.
  const before = sandbox.written.length;
  assert.ok(before > 0, 'the surface stored nothing on the repository the allowlist carries');
  navigate(sandbox, { pathname: OTHER_LIST, frame: elsewhere });
  await settle();

  const after = /** @type {string[]} */ (sandbox.written.slice(before));
  assert.deepStrictEqual(
    after.filter((key) => key.includes('another-owner/another-repo')),
    [],
    `the list was stored: ${after.join(', ')}`
  );
});

test('a repository is matched against the list whatever case either is in', async () => {
  // GitHub serves the repository under the case its owner chose and the
  // maintainer types whichever case they remember, so neither side of the
  // comparison is the one the other was written in.
  const sandbox = contentScriptScope({
    pathname: ADVISORY,
    frame: fixture('triage-thread.html'),
    allowlist: ['GIT-Utensils/Spoon-KNIFE'],
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) !== null,
    `the panel never landed; the page carries ${names(sandbox).join(', ') || 'nothing'}`
  );
});

test('a repository taken off the list stops the extension on a page showing it', async () => {
  const sandbox = contentScriptScope({
    pathname: ADVISORY,
    frame: fixture('triage-thread.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) !== null,
    'the panel never landed on the repository the list carried'
  );

  // Nonzero, so the comparison below rests on a recording this test has seen
  // work: the surface stored what it read for the repository it opened on.
  const before = sandbox.written.length;
  assert.ok(before > 0, 'the surface stored nothing on the repository the allowlist carries');
  setAllowlist(sandbox, []);
  await settle();

  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) === null,
    'the panel stayed on a repository nobody lists'
  );
  assert.deepStrictEqual(
    names(sandbox),
    [sandbox.bghsa.settingsControl.CONTROL_ID],
    'the extension left its own writing on the page'
  );
  assert.deepStrictEqual(
    /** @type {string[]} */ (sandbox.written.slice(before)),
    [],
    'the advisory was stored after its repository left the list'
  );
});

test('a repository taken off the list stops the extension on an advisory list', async () => {
  const sandbox = contentScriptScope({
    pathname: ADVISORY_LIST,
    frame: fixture('list-page-triage.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.table.ROOT_ID) !== null,
    'the table never landed on the repository the list carried'
  );

  setAllowlist(sandbox, []);
  await settle();

  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.table.ROOT_ID) === null,
    'the table stayed on a repository nobody lists'
  );
  assert.deepStrictEqual(
    names(sandbox),
    [sandbox.bghsa.settingsControl.CONTROL_ID],
    'the extension left its own writing on the page'
  );
  // GitHub's own view is what the page had before the table hid it, and it is
  // what the page is left with.
  const container = sandbox.document.querySelector('#advisories');
  assert.ok(container !== null, 'the list page carries no container');
  assert.strictEqual(
    container.querySelectorAll(`.${sandbox.bghsa.table.HIDDEN_CLASS}`).length,
    0,
    "GitHub's own view was left hidden"
  );
});

test('a repository added to the list starts the extension on a page already open', async () => {
  const sandbox = contentScriptScope({
    pathname: ADVISORY,
    frame: fixture('triage-thread.html'),
    allowlist: [],
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.deepStrictEqual(
    names(sandbox),
    [sandbox.bghsa.settingsControl.CONTROL_ID],
    'a surface took a page no list carried'
  );

  setAllowlist(sandbox, [ALLOWED]);
  await settle();

  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) !== null,
    `the panel never landed; the page carries ${names(sandbox).join(', ') || 'nothing'}`
  );
  // The control was placed before the panel had drawn, and the panel lands
  // under it rather than over it.
  assert.strictEqual(controls(sandbox), 1, `the page carries ${controls(sandbox)} controls`);
  assert.strictEqual(
    control(sandbox)?.nextElementSibling?.id ?? null,
    sandbox.bghsa.panel.PANEL_ID,
    'the control does not sit above the panel that arrived under it'
  );
});

test('a page whose list has not arrived yet is left alone', async () => {
  // The gate is synchronous and storage is not, so between the content scripts
  // loading and the read landing there is no answer. Reading no answer as yes
  // would inject and store on a repository nobody listed, so it is read as no,
  // and this holds the read open to prove it.
  const sandbox = contentScriptScope({
    pathname: ADVISORY,
    frame: fixture('triage-thread.html'),
    holdStorage: true,
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  // The gate itself, asked while the read is still out. Everything below is
  // what answering it wrongly would cost.
  assert.strictEqual(
    sandbox.bghsa.content.enabled(),
    false,
    'the gate said yes before the list had arrived'
  );
  assert.deepStrictEqual(sandbox.written, [], 'something was stored');
  assert.strictEqual(sandbox.counts.writes, 0, 'storage was written');
  assert.deepStrictEqual(names(sandbox), [], 'the extension wrote on the page');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer was made');
  assert.strictEqual(sandbox.counts.connected, 0, 'an observer was connected');
});
