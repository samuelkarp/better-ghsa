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
 * @type {string[]}
 */
const scripts = manifest.content_scripts[0].js;

const REPO = '/git-utensils/Spoon-Knife';

const ALLOWED = 'git-utensils/spoon-knife';
const ALLOWLIST_KEY = 'allowlist';

const PULLS = `${REPO}/pulls`;

/**
 * Firefox assigns a UUID to each extension installation.
 */
const EXTENSION_ORIGIN = 'moz-extension://11111111-2222-3333-4444-555555555555';

const OTHER = '/another-owner/another-repo';

const OTHER_LIST = `${OTHER}/security/advisories`;
const OTHER_ADVISORY = `${OTHER_LIST}/GHSA-1234-5678-9abc`;

const ADVISORY_LIST = `${REPO}/security/advisories`;
const ADVISORY = `${ADVISORY_LIST}/GHSA-1234-5678-9abc`;

/**
 * @param {string} name
 * @returns {string} The fixture markup.
 */
function fixture(name) {
  return fs.readFileSync(path.join(root, 'testdata', name), 'utf8');
}

/**
 * Map full script paths to their declared `bghsa` members.
 * Files in different directories can share a basename.
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

/** @returns {string[]} Settings scripts as paths relative to the repository root. */
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
 * @param {unknown} target The requested URL.
 * @returns {string | null} The lowercase repository on github.com, or null.
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
 * Simulate the shared global scope of content scripts. Omitting `require`
 * and `module` selects the browser code paths. Record observers, storage
 * access, and requests. Requests outside the allowlist fail the test.
 *
 * @param {{ pathname?: string, frame?: string, allowlist?: readonly string[],
 *   holdStorage?: boolean }} [options]
 *   The initial URL, frame markup, and stored allowlist. The allowlist
 *   defaults to the fixture repository. holdStorage leaves storage reads pending.
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
   * @type {string[]}
   */
  const asked = [];
  /** @type {Record<string, unknown>} */
  const stored = {};
  stored[ALLOWLIST_KEY] = [...(options.allowlist ?? [ALLOWED])];
  /** @returns {string[]} The loaded allowlist, lowercased; empty while storage is pending. */
  function listed() {
    if (options.holdStorage === true) return [];
    const held = stored[ALLOWLIST_KEY];
    return (Array.isArray(held) ? held : []).map((entry) => String(entry).toLowerCase());
  }
  /** @type {string[]} */
  const written = [];
  /**
   * @type {((changes: Record<string, { newValue?: unknown }>, area: string) => void)[]}
   */
  const changeListeners = [];
  const Native = window.MutationObserver;
  /**
   * @param {MutationCallback} callback
   * @returns {object} An observer that counts observe calls.
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
   * @type {{ url: unknown, target: unknown }[]}
   */
  const opened = [];
  // linkedom does not implement window.open.
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
    // The cache requires storage to implement remove.
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
            // Every GitHub page reads the allowlist. Count only other storage reads.
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
    // Unreferenced timers allow the process to exit with requests still pending.
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
    AbortController,
    /**
     * Allowed requests remain pending. Other requests throw here and in a timer
     * callback. The callback fails the test even if the caller catches the error.
     * See REQUIREMENTS.md section 12.
     *
     * @param {unknown} target The requested URL or path.
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
 * @returns {string[]} Script loading and missing export errors.
 */
function loadScripts(sandbox) {
  /** @type {string[]} */
  const failures = [];
  for (const file of scripts) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    try {
      // Browsers continue loading scripts after an earlier script throws.
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
 * @returns {string[]} Unique, sorted bghsa names from the page markup.
 */
function names(sandbox) {
  const html = sandbox.document.documentElement.outerHTML;
  return [...new Set(html.match(/bghsa[a-z-]*/g) ?? [])].sort();
}

/**
 * @param {Record<string, any>} sandbox
 * @returns {Element | null} The settings control, if present.
 */
function control(sandbox) {
  return sandbox.document.getElementById(sandbox.bghsa.settingsControl.CONTROL_ID);
}

/**
 * Count duplicate IDs with querySelectorAll.
 *
 * @param {Record<string, any>} sandbox
 * @returns {number} The number of settings controls.
 */
function controls(sandbox) {
  return sandbox.document.querySelectorAll(`#${sandbox.bghsa.settingsControl.CONTROL_ID}`).length;
}

/**
 * @param {Record<string, any>} sandbox
 * @param {string} pathname
 * @returns {string} The panel or table root ID for the path.
 */
function blockId(sandbox, pathname) {
  return pathname.split('/').length > 5
    ? sandbox.bghsa.panel.PANEL_ID
    : sandbox.bghsa.table.ROOT_ID;
}

/**
 * @param {Record<string, any>} sandbox
 * @param {string} why
 * @returns {void}
 */
function noSurface(sandbox, why) {
  // Comparing DOM nodes can exhaust the heap while formatting a failure.
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
 * Simulate GitHub replacing the frame during navigation.
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
 * Simulate a storage change from the settings page.
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
 * @param {number} [turns] How many turns of the event loop to give the page.
 * @returns {Promise<void>} Resolves after the specified event-loop turns.
 */
async function settle(turns = 40) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Navigation debounce and request throttling require elapsed time.
 * A fixed number of event-loop turns may finish before either deadline.
 *
 * @param {() => boolean} reached Whether the expected state has appeared.
 * @param {number} [limitMs] Maximum time to wait.
 * @returns {Promise<void>} Resolves when reached returns true or the time limit elapses.
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
  assert.deepStrictEqual(
    scripts.filter((file) => !DECLARED.has(file)),
    [],
    'a content script types/bghsa.d.ts declares no member for'
  );
  const loaded = new Set([...scripts, ...pageScripts()]);
  assert.deepStrictEqual(
    [...DECLARED.keys()].filter((file) => !loaded.has(file)),
    [],
    'a member declared for a file nothing loads'
  );

  const names = [...DECLARED.values()];
  assert.deepStrictEqual(
    names.filter((name, at) => names.indexOf(name) !== at),
    [],
    'a member two files are declared under'
  );
});

test('the settings page the control opens is the one the manifest exposes', () => {
  const settingsControl = require('../src/common/settings-control.js');

  // Opening the settings from a GitHub page requires a web-accessible resource.
  // Content scripts cannot call runtime.openOptionsPage.
  /** @type {{ resources: string[], matches: string[] }[]} */
  const exposed = manifest.web_accessible_resources;
  assert.deepStrictEqual(exposed, [
    { resources: ['src/settings/settings.html'], matches: ['https://github.com/*'] },
  ]);

  const [entry] = exposed;
  assert.ok(entry !== undefined, 'the manifest exposes nothing');
  assert.deepStrictEqual(entry.matches, manifest.content_scripts[0].matches);

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

  // GitHub also renders advisory lists on other URLs.
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
  assert.ok(sandbox.counts.made > 0, 'the surface made no observer');
  assert.ok(sandbox.counts.reads > 0, 'the surface read no storage');
  assert.ok(sandbox.counts.writes > 0, 'the surface stored nothing');
  assert.ok(sandbox.written.length > 0, 'the surface named no key it stored');
});

test('a page on a listed repository asks GitHub for that repository', async () => {
  const sandbox = contentScriptScope({
    pathname: ADVISORY_LIST,
    frame: fixture('list-page-triage.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  // Request throttling can delay the first request after page load.
  await waitFor(() => sandbox.asked.length > 0, 20_000);

  assert.ok(
    sandbox.asked.length > 0,
    `the extension asked GitHub for nothing; the page carries ${
      names(sandbox).join(', ') || 'nothing'
    }`
  );
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

  assert.deepStrictEqual(sandbox.written, [], 'something was stored');
  assert.strictEqual(sandbox.counts.writes, 0, 'storage was written');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read');
  noSurface(sandbox, 'took an advisory on a repository the allowlist does not carry');
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

  // The Firefox extension URL identifies the installation.
  // DOM attributes would expose it to scripts on github.com.
  assert.ok(
    !sandbox.document.documentElement.outerHTML.includes(EXTENSION_ORIGIN),
    'the extension address was written into the page'
  );

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

    const sentinel = blockId(sandbox, pathname);
    assert.ok(
      sandbox.document.getElementById(sentinel) !== null,
      `the surface never took ${pathname}`
    );

    assert.strictEqual(controls(sandbox), 1, `${pathname} carries ${controls(sandbox)} controls`);
    const shown = control(sandbox);
    assert.ok(shown !== null, `the control never landed on ${pathname}`);
    assert.strictEqual(shown.textContent?.trim(), 'Better GHSA settings');
    assert.ok(
      shown.querySelector('button')?.classList.contains('btn'),
      `the control on ${pathname} is not drawn as a button of the page`
    );

    // Compare IDs to avoid serializing a DOM subtree on failure.
    assert.strictEqual(
      shown.nextElementSibling?.id ?? null,
      sentinel,
      `the control on ${pathname} does not sit above the extension's own block`
    );
  }
});

test('a move between the advisory pages leaves one control', async () => {
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
  const sandbox = contentScriptScope({
    pathname: PULLS,
    frame: fixture('list-page-triage.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  assert.ok(control(sandbox) === null, 'the control took a pull requests page');

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

  noSurface(sandbox, 'stayed on a repository nobody lists');
  assert.strictEqual(controls(sandbox), 1, `the page carries ${controls(sandbox)} controls`);
  assert.deepStrictEqual(
    names(sandbox),
    [sandbox.bghsa.settingsControl.CONTROL_ID],
    'the extension left its own writing on the page'
  );

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
  // Soft navigation replaces the frame while content scripts continue running.
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

  const before = sandbox.written.length;
  assert.ok(before > 0, 'the surface stored nothing on the repository the allowlist carries');
  navigate(sandbox, { pathname: OTHER_ADVISORY, frame: fixture('triage-thread.html') });
  await settle();

  // The original repository continues refreshing. Check the storage keys
  // for the advisory opened by navigation.
  const after = /** @type {string[]} */ (sandbox.written.slice(before));
  assert.deepStrictEqual(
    after.filter(
      (key) => key.startsWith('adv:') || key === 'members' || key === 'branches'
    ),
    [],
    `the advisory was stored: ${after.join(', ')}`
  );
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) === null,
    'the panel took an advisory on a repository the allowlist does not carry'
  );
});

test('a page that becomes another repository advisory list stores nothing for it', async () => {
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
  assert.strictEqual(controls(sandbox), 1, `the page carries ${controls(sandbox)} controls`);
  assert.strictEqual(
    control(sandbox)?.nextElementSibling?.id ?? null,
    sandbox.bghsa.panel.PANEL_ID,
    'the control does not sit above the panel that arrived under it'
  );
});

test('a page whose list has not arrived yet is left alone', async () => {
  // Allowlist loading is asynchronous. Hold the read pending to check
  // that the extension waits before accessing repository data.
  const sandbox = contentScriptScope({
    pathname: ADVISORY,
    frame: fixture('triage-thread.html'),
    holdStorage: true,
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

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

test('private-fork diff width follows navigation and the parent allowlist', async () => {
  const fork = `${REPO}-ghsa-jmvx-2wfw-xfgj/pull/1`;
  const sandbox = contentScriptScope({ pathname: `${fork}/changes`, allowlist: [] });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  const styleId = sandbox.bghsa.prLayout.STYLE_ID;
  const hasStyle = () => sandbox.document.getElementById(styleId) !== null;
  assert.strictEqual(hasStyle(), false);

  setAllowlist(sandbox, [ALLOWED]);
  await settle();
  assert.strictEqual(hasStyle(), true, 'listing the parent did not widen the diff');
  assert.deepStrictEqual(names(sandbox), [styleId]);
  assert.strictEqual(sandbox.counts.writes, 0);
  assert.strictEqual(sandbox.counts.made, 0);

  navigate(sandbox, { pathname: fork });
  await settle();
  assert.strictEqual(hasStyle(), false, 'the override remained on the conversation');
  navigate(sandbox, { pathname: `${fork}/files` });
  await settle();
  assert.strictEqual(hasStyle(), true);
  navigate(sandbox, { pathname: `${REPO}/pull/1/changes` });
  await settle();
  assert.strictEqual(hasStyle(), false, 'an ordinary PR received the override');
  navigate(sandbox, { pathname: `${fork}/changes` });
  await settle();
  assert.strictEqual(hasStyle(), true);
  setAllowlist(sandbox, []);
  await settle();
  assert.strictEqual(hasStyle(), false, 'removing the parent left the override active');
});
