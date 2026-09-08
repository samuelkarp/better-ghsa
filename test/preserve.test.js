'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');
const preserve = require('../src/detail/preserve.js');
const write = require('../src/common/write.js');
const stateWrite = require('../src/detail/state.js');

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

/**
 * @param {Document} doc
 * @param {string} name
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function detail(doc, name) {
  const parsed = parse.parseDetail(doc);
  if (parsed === null) throw new Error(`${name} is not an advisory detail page`);
  return parsed;
}

/** The one parse of each large fixture in this file. */
const draft = detail(fixture('draft.html'), 'draft.html');

/** The advisory the fixtures come from, which is on the allowlist. */
const REF = { owner: 'git-utensils', repo: 'Spoon-Knife', ghsaId: 'GHSA-jmvx-2wfw-xfgj' };

/** The path of that advisory's detail page. */
const DETAIL = '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj';

/** The title the built page carries. */
const TITLE = 'Path traversal in the drawer handler';

/** The description the built page carries. */
const DESCRIPTION = '### Summary\n\nThe handler joins a path without normalizing it.';

/** A marker standing in for one a press draws. */
const MARKER = `${preserve.MARKER_PREFIX}0123456789abcdef`;

/**
 * @param {string} value
 * @returns {string} `value` with the characters markup reads escaped.
 */
function escape(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @typedef {object} PageOptions
 * @property {string} [title]
 * @property {string} [description]
 * @property {boolean} [revised] Whether the description carries a revision.
 * @property {boolean} [preserved] Whether the thread carries the comment.
 * @property {string} [detail] The path the live region names.
 * @property {string} [action] The comment form's action.
 */

/**
 * An advisory detail page holding what this extension reads from one: the
 * reference, the title and description, the description's revision control,
 * the comment thread, and the form a write clones.
 *
 * @param {PageOptions} [options]
 * @returns {string}
 */
function pageHtml(options) {
  const settings = options ?? {};
  const detail = settings.detail ?? DETAIL;
  const action = settings.action ?? `${detail}/comments`;
  const revision =
    settings.revised === true
      ? `<details><summary>edited</summary>` +
        `<details-menu src="${detail}/edit_history_log"></details-menu></details>`
      : '';
  const thread =
    settings.preserved === true
      ? '<div class="timeline-comment-group" id="advisory-comment-42">' +
        '<div class="comment-body markdown-body js-comment-body">' +
        `${preserve.PRESERVE_SUMMARY}<code>${MARKER}</code>` +
        `${preserve.TITLE_LABEL} ${escape(TITLE)}</div></div>`
      : '';
  return [
    '<!doctype html><html><body>',
    '<div class="gh-header-meta">',
    '<span class="State">Triage</span>',
    '<span class="Label--large" title="Severity: High">High</span>',
    '<span class="user-select-contain">GHSA-jmvx-2wfw-xfgj</span>',
    '</div>',
    `<div class="js-socket-channel js-updatable-content" data-url="${detail}/repository_advisory/body">`,
    '<div class="Box">',
    '<div class="js-repository-advisory-details">',
    '<div class="Box-header timeline-comment-header">',
    '<a class="author" href="/prakleumas">prakleumas</a>',
    '<relative-time datetime="2026-08-01T00:00:00Z"></relative-time>',
    `<span class="js-comment-edit-history">${revision}</span>`,
    '</div>',
    '<form>',
    `<input name="repository_advisory[title]" value="${escape(settings.title ?? TITLE)}">`,
    '<textarea name="repository_advisory[description]">',
    escape(settings.description ?? DESCRIPTION),
    '</textarea>',
    '</form>',
    '</div>',
    '</div>',
    '</div>',
    thread,
    `<form class="js-advisory-comment-form" action="${action}">`,
    '<input type="hidden" name="authenticity_token" value="a-token">',
    '<input type="hidden" name="required_field_1234" value="">',
    '<textarea name="body"></textarea>',
    '<button type="submit" name="comment" value="1" disabled>Comment</button>',
    '</form>',
    '</body></html>',
  ].join('\n');
}

/**
 * @param {PageOptions} [options]
 * @returns {import('../src/common/parse-detail.js').ParsedDetail} the advisory
 *   a built page parses to.
 */
function pageRecord(options) {
  const parsed = parse.parseDetail(document(pageHtml(options)));
  if (parsed === null) throw new Error('the built page is not an advisory detail page');
  return parsed;
}

/** The advisory the panel loaded with in most of these tests. */
const advisory = pageRecord();

/**
 * A response holding the comment a write claims to have made, as GitHub
 * renders it: the code span survives the sanitizer, so the marker is in the
 * document the write is read back out of.
 *
 * @param {string} marker The marker the press wrote.
 * @param {string} [title] The title the comment carries.
 * @returns {string}
 */
function wroteHtml(marker, title) {
  return (
    '<!doctype html><html><body>' +
    '<div class="comment-body markdown-body js-comment-body"><details>' +
    `<summary>${preserve.PRESERVE_SUMMARY}</summary>` +
    `<p><code>${escape(marker)}</code></p>` +
    `<p>${preserve.TITLE_LABEL}</p><p>${escape(title ?? TITLE)}</p>` +
    `<p>${preserve.DESCRIPTION_LABEL}</p><p>${escape(DESCRIPTION)}</p>` +
    '</details></div></body></html>'
  );
}

/**
 * @param {RequestInit} init The write request.
 * @returns {string} the marker the body of that request carries.
 */
function markerOf(init) {
  const sent = /** @type {URLSearchParams} */ (/** @type {unknown} */ (init.body));
  const found = new RegExp(`${preserve.MARKER_PREFIX}[0-9a-f]+`).exec(String(sent.get('body')));
  return found === null ? '' : found[0];
}

/**
 * @typedef {object} Exchange
 * @property {import('../src/common/write.js').WriteFetch} send
 * @property {Array<{ url: string, init: RequestInit }>} calls
 * @property {() => Array<{ url: string, init: RequestInit }>} posts
 */

/**
 * A stand-in for `fetch` answering the detail page with `page` and the write
 * with `answer`.
 *
 * @param {object} [options]
 * @param {string} [options.page] The detail page markup.
 * @param {number} [options.pageStatus]
 * @param {string} [options.answer] The markup the write is answered with. By
 *   default the comment the press wrote, as GitHub renders it.
 * @param {string} [options.answerTitle] The title that comment carries.
 * @param {number} [options.status] The status the write is answered with.
 * @param {Promise<void>} [options.holdPage] Awaited before the page answers.
 * @param {Promise<void>} [options.holdWrite] Awaited before the write answers.
 * @returns {Exchange}
 */
function exchange(options) {
  const settings = options ?? {};
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  return {
    calls,
    posts: () => calls.filter((call) => call.init.method === 'POST'),
    send: async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'GET') {
        if (settings.holdPage !== undefined) await settings.holdPage;
        const page = settings.page ?? pageHtml();
        return { status: settings.pageStatus ?? 200, text: async () => page };
      }
      if (settings.holdWrite !== undefined) await settings.holdWrite;
      const answer = settings.answer ?? wroteHtml(markerOf(init), settings.answerTitle);
      return { status: settings.status ?? 200, text: async () => answer };
    },
  };
}

/**
 * @param {Exchange} fake
 * @returns {import('../src/detail/preserve.js').PreserveOptions}
 */
function run(fake) {
  return { fetch: fake.send, parseDocument: document };
}

/**
 * @returns {Promise<void>} resolves once every pending microtask has run.
 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The link the summary carries, as the body writes it. */
const LINK = '<a href="https://github.com/samuelkarp/better-ghsa">Better GHSA</a>';

/** The comment an advisory gets. */
const BODY = [
  '<details>',
  '',
  `<summary>Original report preserved by ${LINK}</summary>`,
  '',
  `\`${MARKER}\``,
  '',
  'Title:',
  '',
  'Path traversal in the drawer handler',
  '',
  'Description:',
  '',
  '### Summary',
  '',
  'The handler joins a path without normalizing it.',
  '',
  '</details>',
  '',
].join('\n');

test('the comment is the summary, the marker, and the title and description', () => {
  const body = preserve.buildBody(advisory, MARKER);
  assert.ok(body === BODY, `the comment body reads:\n${String(body)}`);
});

test('an advisory whose description was edited is preserved the same way', () => {
  const body = /** @type {string} */ (preserve.buildBody(draft, MARKER));
  assert.strictEqual(draft.descriptionOriginal, false);
  assert.strictEqual(body.includes(/** @type {string} */ (draft.title)), true);
  assert.strictEqual(body.includes(/** @type {string} */ (draft.description)), true);
});

test('no comment is built for a description whose provenance did not read', () => {
  assert.strictEqual(preserve.buildBody({ ...advisory, descriptionOriginal: null }, MARKER), null);
  assert.strictEqual(preserve.buildBody({ ...advisory, title: null }, MARKER), null);
  assert.strictEqual(preserve.buildBody({ ...advisory, description: null }, MARKER), null);
});

test('every press draws a marker of its own under the fixed prefix', () => {
  const first = preserve.newMarker();
  const second = preserve.newMarker();
  assert.strictEqual(first.startsWith(preserve.MARKER_PREFIX), true);
  assert.strictEqual(second.startsWith(preserve.MARKER_PREFIX), true);
  assert.strictEqual(/^[0-9a-f]{16}$/.test(first.slice(preserve.MARKER_PREFIX.length)), true);
  assert.notStrictEqual(first, second);
});

test('a report carrying its own collapsed blocks keeps them', () => {
  const nested = '<details>\n<summary>Proof of concept</summary>\n\nA log.\n\n</details>';
  assert.strictEqual(preserve.balanceDetails(nested), nested);
  const body = /** @type {string} */ (
    preserve.buildBody({ ...advisory, description: nested }, MARKER)
  );
  assert.strictEqual(body.includes(nested), true);
});

test('a closing tag that closes nothing is taken out of the report', () => {
  assert.strictEqual(preserve.balanceDetails('The rest.\n</details>\nSpilled.'),
    'The rest.\n\nSpilled.');
  assert.strictEqual(preserve.balanceDetails('a </DETAILS > b'), 'a  b');
  assert.strictEqual(
    preserve.balanceDetails('<details open>\n</details>\n</details>'),
    '<details open>\n</details>\n'
  );
  const body = /** @type {string} */ (
    preserve.buildBody({ ...advisory, description: 'Report.\n</details>\nSpilled.' }, MARKER)
  );
  assert.strictEqual(body.includes('Report.\n\nSpilled.'), true);
  assert.strictEqual(body.split('</details>').length - 1, 1);
});

test('a title carrying a closing tag cannot close the block either', () => {
  const body = /** @type {string} */ (
    preserve.buildBody({ ...advisory, title: 'Bug</details>Spilled' }, MARKER)
  );
  assert.strictEqual(body.includes('BugSpilled'), true);
  assert.strictEqual(body.split('</details>').length - 1, 1);
});

test('an advisory with no preservation comment offers the button', () => {
  preserve.attempts.clear();
  const state = preserve.offered(advisory);
  assert.strictEqual(state.available, true);
  assert.strictEqual(state.writable, true);
  assert.strictEqual(state.reason, null);
  assert.strictEqual(state.message, 'Preserve the title and description in a comment.');
});

test('the fixed summary text on a comment is what says the report is preserved', () => {
  const preserved = pageRecord({ preserved: true });
  assert.strictEqual(preserve.hasPreservationComment(advisory.comments), false);
  assert.strictEqual(preserve.hasPreservationComment(preserved.comments), true);

  const state = preserve.offered(preserved);
  assert.strictEqual(state.available, false);
  assert.strictEqual(state.writable, false);
  assert.strictEqual(state.reason, 'preserved');
  assert.strictEqual(state.message, 'Preserved');
  const held = preserve.preservationComment(preserved.comments);
  assert.ok(held !== null, 'the marker named no comment');
  assert.strictEqual(state.href, `#${held?.elementId}`);
});

test('an advisory with no preservation comment names no comment to link to', () => {
  preserve.attempts.clear();
  assert.strictEqual(preserve.preservationComment(advisory.comments), null);
  assert.strictEqual(preserve.offered(advisory).href, null);
});

test('an advisory in a repository off the allowlist offers a button that refuses', () => {
  const elsewhere = {
    ...advisory,
    ref: { owner: 'someone', repo: 'else', ghsaId: 'GHSA-0000-0000-0000' },
  };
  const state = preserve.offered(elsewhere);
  assert.strictEqual(state.available, true);
  assert.strictEqual(state.writable, false);
  assert.strictEqual(state.reason, 'allowlist');
  assert.strictEqual(
    state.message,
    "Error: someone/else is not on this extension's allowlist."
  );
});

test('a description whose provenance did not read refuses the write', () => {
  const state = preserve.offered({ ...advisory, descriptionOriginal: null });
  assert.strictEqual(state.available, true);
  assert.strictEqual(state.writable, false);
  assert.strictEqual(state.reason, 'provenance');
  assert.strictEqual(state.message, 'Error: failed to save');
});

test('a title or description that did not read refuses the write', () => {
  for (const record of [
    { ...advisory, title: null },
    { ...advisory, description: null },
  ]) {
    const state = preserve.offered(record);
    assert.strictEqual(state.writable, false);
    assert.strictEqual(state.reason, 'unreadable');
    assert.strictEqual(state.message, 'Error: failed to parse advisory');
  }
});

test('what refuses the press is what the body cannot be built from', () => {
  // The comment holds the title and the description, and is written only where
  // the description is the reporter's own text. A press is refused on exactly
  // the readings that build no body, so the refusal a maintainer sees always
  // names which of the three did not read.
  for (const title of [advisory.title, null]) {
    for (const description of [advisory.description, null]) {
      for (const original of [advisory.descriptionOriginal, null]) {
        const record = { ...advisory, title, description, descriptionOriginal: original };
        const state = preserve.offered(record);
        const built = preserve.buildBody(record, MARKER);
        assert.strictEqual(
          state.writable,
          built !== null,
          `title=${String(title)} description=${String(description)}` +
            ` original=${String(original)} was ${state.writable ? 'writable' : 'refused'}` +
            ` and built ${built === null ? 'nothing' : 'a body'}`
        );
      }
    }
  }
});

test('pressing on an advisory whose provenance did not read sends nothing', async () => {
  preserve.attempts.clear();
  const fake = exchange();
  const outcome = await preserve.preserve(
    { ...advisory, descriptionOriginal: null },
    run(fake)
  );
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'provenance');
  assert.strictEqual(fake.calls.length, 0);
});

test('a press reads the advisory page and writes what that page says', async () => {
  preserve.attempts.clear();
  const fake = exchange({
    page: pageHtml({
      title: 'The title as it stands now',
      description: 'The description as it stands now.',
      revised: true,
    }),
    answerTitle: 'The title as it stands now',
  });
  const outcome = await preserve.preserve(advisory, run(fake));

  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.status, 200);
  assert.strictEqual(fake.calls.length, 2);

  const read = /** @type {{ url: string, init: RequestInit }} */ (fake.calls[0]);
  assert.strictEqual(read.url, DETAIL);
  assert.strictEqual(read.init.method, 'GET');
  assert.strictEqual(read.init.credentials, 'same-origin');

  const wrote = /** @type {{ url: string, init: RequestInit }} */ (fake.calls[1]);
  assert.strictEqual(wrote.url, `${DETAIL}/comments`);
  assert.strictEqual(wrote.init.method, 'POST');
  const sent = /** @type {URLSearchParams} */ (/** @type {unknown} */ (wrote.init.body));
  const body = String(sent.get('body'));
  assert.ok(
    body.includes('The title as it stands now'),
    'the comment carries the title the panel loaded with'
  );
  assert.ok(
    body.includes('The description as it stands now.'),
    'the comment carries the description the panel loaded with'
  );
  assert.ok(!body.includes(TITLE), 'the comment carries the title the panel loaded with');
  assert.ok(
    !body.includes('The handler joins a path'),
    'the comment carries the description the panel loaded with'
  );
  preserve.attempts.clear();
});

test('a press on an advisory another tab preserved writes nothing', async () => {
  preserve.attempts.clear();
  const fake = exchange({ page: pageHtml({ preserved: true }) });
  const outcome = await preserve.preserve(advisory, run(fake));
  assert.ok(outcome.ok === false, 'a second comment was written onto a preserved advisory');
  assert.strictEqual(outcome.reason, 'preserved');
  assert.strictEqual(fake.posts().length, 0, 'a second comment was posted');
  assert.strictEqual(preserve.offered(advisory).reason, 'preserved');
  preserve.attempts.clear();
});

test('a press whose page could not be read writes nothing and can be pressed again', async () => {
  preserve.attempts.clear();
  const fake = exchange({ pageStatus: 503 });
  const outcome = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'fetch');
  assert.strictEqual(outcome.status, 503);
  assert.strictEqual(fake.posts().length, 0);
  assert.strictEqual(preserve.attempts.size, 0);
  assert.strictEqual(preserve.offered(advisory).writable, true);
});

test('a second press while the first is still in flight sends nothing', async () => {
  preserve.attempts.clear();
  /** @type {() => void} */
  let release = () => {};
  /** @type {Promise<void>} */
  const holdWrite = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const fake = exchange({ holdWrite });

  const first = preserve.preserve(advisory, run(fake));
  await tick();
  assert.strictEqual(fake.posts().length, 1, 'the first press had not reached the write');

  const state = preserve.offered(advisory);
  assert.ok(state.available === false, 'the button is offered while a press is in flight');
  assert.strictEqual(state.reason, 'attempted');

  const second = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'attempted');
  assert.strictEqual(fake.posts().length, 1, 'a second comment was posted');

  release();
  const outcome = await first;
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(fake.posts().length, 1, 'a second comment was posted');
  preserve.attempts.clear();
});

test('a second press while the first is still reading the page sends nothing', async () => {
  preserve.attempts.clear();
  /** @type {() => void} */
  let release = () => {};
  /** @type {Promise<void>} */
  const holdPage = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const fake = exchange({ holdPage });

  const first = preserve.preserve(advisory, run(fake));
  await tick();
  assert.strictEqual(fake.calls.length, 1, 'the first press had not reached the page');

  const state = preserve.offered(advisory);
  assert.ok(state.available === false, 'the button is offered while a press is in flight');
  assert.strictEqual(state.reason, 'in-flight');
  assert.strictEqual(state.message, preserve.PENDING_MESSAGE);

  const second = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(second.reason, 'in-flight');
  assert.strictEqual(fake.calls.length, 1, 'a second press went out');

  release();
  const outcome = await first;
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(fake.posts().length, 1, 'a second comment was posted');
  preserve.attempts.clear();
});

test('the write is confirmed by the marker that press drew, and nothing else', async () => {
  preserve.attempts.clear();
  const fake = exchange();
  const outcome = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(outcome.ok, true);

  const wrote = /** @type {{ url: string, init: RequestInit }} */ (fake.posts()[0]);
  const marker = markerOf(wrote.init);
  assert.strictEqual(marker.startsWith(preserve.MARKER_PREFIX), true);
  assert.notStrictEqual(marker, MARKER);

  const stale = exchange({ answer: wroteHtml(marker) });
  preserve.attempts.clear();
  const second = await preserve.preserve(advisory, run(stale));
  assert.ok(second.ok === false, 'an answer holding an earlier marker confirmed this write');
  assert.strictEqual(second.reason, 'unwritten');
  preserve.attempts.clear();
});

test('one advisory spelled two ways is one advisory', async () => {
  preserve.attempts.clear();
  const fake = exchange();
  const first = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(first.ok, true);

  const shouted = {
    ...advisory,
    ref: { owner: 'GIT-Utensils', repo: 'spoon-knife', ghsaId: 'ghsa-JMVX-2wfw-xfgj' },
  };
  const second = await preserve.preserve(shouted, run(fake));
  assert.ok(second.ok === false, 'a second comment was written onto the same advisory');
  assert.strictEqual(second.reason, 'preserved');
  assert.strictEqual(fake.posts().length, 1, 'a second comment was posted');
  preserve.attempts.clear();
});

test('a second press in one page lifetime is not offered', async () => {
  preserve.attempts.clear();
  const fake = exchange();
  const first = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(first.ok, true);

  const state = preserve.offered(advisory);
  assert.strictEqual(state.available, false);
  assert.strictEqual(state.reason, 'preserved');
  assert.strictEqual(state.message, 'Preserved');

  const second = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'preserved');
  assert.strictEqual(fake.posts().length, 1);
  preserve.attempts.clear();
});

test('a press whose answer did not confirm it is not offered again', async () => {
  preserve.attempts.clear();
  const fake = exchange({ answer: '<!doctype html><html><body>nothing</body></html>' });
  const first = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(first.reason, 'unwritten');

  const state = preserve.offered(advisory);
  assert.ok(state.available === false, 'the button is offered while a press is in flight');
  assert.strictEqual(state.reason, 'attempted');
  assert.strictEqual(state.message, preserve.ATTEMPTED_MESSAGE);
  assert.strictEqual(state.message, 'Reload page');

  const second = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'attempted');
  assert.strictEqual(fake.posts().length, 1);
  preserve.attempts.clear();
});

test('a press that never went out leaves the button offered', async () => {
  preserve.attempts.clear();
  const fake = exchange();
  const refused = await preserve.preserve(
    { ...advisory, ref: { owner: 'someone', repo: 'else', ghsaId: 'GHSA-0000-0000-0000' } },
    run(fake)
  );
  assert.strictEqual(refused.reason, 'allowlist');
  assert.strictEqual(preserve.attempts.size, 0);
  assert.strictEqual(preserve.offered(advisory).available, true);
});

test('a press and a save landing on a write already out report one reason', async () => {
  preserve.attempts.clear();
  /** @type {() => void} */
  let release = () => {};
  /** @type {Promise<void>} */
  const holdPage = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const fake = exchange({ holdPage });

  const first = preserve.preserve(advisory, run(fake));
  await tick();
  const pressed = await preserve.preserve(advisory, run(fake));

  // The same event on the state write, which the panel's Save button reaches.
  const key = write.holdKey(REF);
  stateWrite.inFlight.add(key);
  /** @type {import('../src/detail/state.js').StateWriteResult} */
  let saved;
  try {
    saved = await stateWrite.writeState({
      ref: REF,
      loadedSeq: 0,
      changes: {},
      fetch: async () => {
        throw new Error('a save landing on a write already out asked GitHub for a page');
      },
      parseDocument: document,
    });
  } finally {
    stateWrite.inFlight.delete(key);
  }

  assert.strictEqual(
    pressed.reason,
    saved.reason,
    `the press said ${String(pressed.reason)} and the save said ${String(saved.reason)}`
  );
  assert.strictEqual(pressed.reason, 'in-flight');
  assert.strictEqual(pressed.message, saved.message);
  assert.strictEqual(preserve.offered(advisory).reason, 'in-flight');

  release();
  const outcome = await first;
  assert.strictEqual(outcome.ok, true, outcome.message);
  preserve.attempts.clear();
});

test('a page naming no advisory refuses the press on the reference', async () => {
  preserve.attempts.clear();
  const fake = exchange();
  /** @type {import('../src/common/parse-detail.js').ParsedDetail} */
  const anonymous = { ...advisory, ref: null };

  const state = preserve.offered(anonymous);
  assert.strictEqual(state.writable, false);
  assert.strictEqual(state.reason, 'unreadable');
  assert.strictEqual(state.message, 'Error: failed to parse advisory');

  const outcome = await preserve.preserve(anonymous, run(fake));
  assert.strictEqual(outcome.reason, 'unreadable');
  assert.strictEqual(outcome.message, 'Error: failed to parse advisory');
  assert.strictEqual(fake.calls.length, 0, 'a press with no reference reached GitHub');
  preserve.attempts.clear();
});
