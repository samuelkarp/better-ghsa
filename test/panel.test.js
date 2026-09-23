'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');
const derive = require('../src/common/derive.js');
const merge = require('../src/common/merge.js');
const schema = require('../src/common/schema.js');
const chips = require('../src/common/chips.js');
const dom = require('../src/common/dom.js');
const panel = require('../src/detail/panel.js');
const tracking = require('../src/detail/tracking.js');
const preserve = require('../src/detail/preserve.js');
const cache = require('../src/common/cache.js');
const members = require('../src/common/members.js');
const branches = require('../src/common/branches.js');
const edit = require('../src/detail/edit.js');

const allowlist = require('../src/common/allowlist.js');

const { fakeStorage } = require('../test-support/storage.js');

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
function parseFixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

/**
 * @param {string} name
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function readRecord(name) {
  const parsed = parse.parseDetail(parseFixture(name));
  if (parsed === null) throw new Error(`${name} is not an advisory detail page`);
  return parsed;
}

globalThis.location = /** @type {Location} */ (
  /** @type {unknown} */ ({
    pathname: '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj',
  })
);

const triageDoc = parseFixture('triage-thread.html');
const triage = /** @type {import('../src/common/parse-detail.js').ParsedDetail} */ (
  parse.parseDetail(triageDoc)
);
const draft = readRecord('draft.html');
const published = readRecord('published-containerd.html');

const blank = /** @type {Document} */ (
  /** @type {unknown} */ (parseHTML('<!doctype html><html><head></head><body></body></html>').document)
);

/**
 * GitHub nests the description Box within a live region in the main column.
 * The panel is placed outside the region GitHub replaces.
 */
const PAGE = [
  '<!doctype html><html><head></head><body>',
  '<div class="clearfix new-discussion-timeline container-xl">',
  '<div class="d-flex flex-column flex-md-row">',
  '<div class="col-12 col-md-9">',
  '<div class="js-quote-selection-container">',
  '<div class="js-socket-channel js-updatable-content"',
  ' data-url="/o/r/security/advisories/GHSA-0000-0000-0000/show_partial?partial=repository_advisory%2Fbody">',
  '<div class="Box">',
  '<div class="js-repository-advisory-details">',
  '<div class="Box-header timeline-comment-header">description</div>',
  '</div></div></div></div></div></div></body></html>',
].join('');

/**
 * @returns {Document} a document carrying the anchor elements and nothing else.
 */
function page() {
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(PAGE).document));
}

/**
 * @param {import('../src/common/parse-detail.js').ParsedDetail} advisory
 * @param {import('../src/detail/tracking.js').TrackingView} [view] The tracking
 *   state to render; defaults to untracked.
 * @returns {Element} the panel this advisory renders to.
 */
function build(advisory, view = tracking.untracked()) {
  return panel.buildPanel(blank, advisory, derive.derive(advisory), view);
}

/**
 * @param {import('../src/common/parse-detail.js').ParsedDetail} advisory
 * @returns {Promise<Element>}
 */
async function buildTracked(advisory) {
  const merged = merge.mergeSnapshots(advisory.comments);
  return build(advisory, await tracking.readAdvisory(advisory, merged));
}

/**
 * Editing controls require an editor context.
 *
 * @param {import('../src/common/parse-detail.js').ParsedDetail} advisory
 * @returns {Promise<Element>} the panel this advisory renders to.
 */
async function buildEditable(advisory) {
  const merged = merge.mergeSnapshots(advisory.comments);
  const view = await tracking.readAdvisory(advisory, merged);
  const derived = derive.derive(advisory);
  return panel.buildPanel(blank, advisory, derived, view, {
    advisory,
    derived,
    tracking: view,
    fingerprints: await tracking.fingerprints(advisory),
    merged,
  });
}

/**
 * @param {Document} doc
 * @param {import('../src/common/parse-detail.js').ParsedDetail} [advisory]
 * @returns {Element} the panel placed in `doc`.
 */
function place(doc, advisory = triage) {
  const injected = panel.injectPanel(doc, advisory, derive.derive(advisory), tracking.untracked());
  if (injected === null) throw new Error('the document offered no anchor');
  return injected;
}

/**
 * @param {Document} doc
 * @returns {void} takes the panel and its stylesheet back out of `doc`.
 */
function reset(doc) {
  for (const node of doc.querySelectorAll('#bghsa-detail-panel, #bghsa-style')) node.remove();
}

/**
 * @param {Element | null} node
 * @returns {string}
 */
function text(node) {
  return String(node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {Element} root
 * @param {string} selector
 * @returns {string[]}
 */
function texts(root, selector) {
  return Array.from(root.querySelectorAll(selector)).map((node) => text(node));
}

/**
 * @param {Element} root
 * @param {string} label
 * @returns {string} the text of the panel row carrying `label`.
 */
function rowText(root, label) {
  for (const row of root.querySelectorAll('.Box-row')) {
    if (text(row.querySelector('.bghsa-label')) === label) {
      return text(row.querySelector('.flex-auto'));
    }
  }
  throw new Error(`no panel row labeled ${label}`);
}

/**
 * @param {Element} root
 * @returns {string[]} The dated header chips.
 */
function headerDates(root) {
  return texts(root, '.Box-header .Label').filter((label) => /\d{4}-\d{2}-\d{2}/.test(label));
}

/**
 * @param {Element} root
 * @param {string} label the chip's own text.
 * @returns {string} the class attribute of the chip reading `label`.
 */
function chipClass(root, label) {
  for (const node of root.querySelectorAll('.Box-header .Label')) {
    if (text(node) === label) return String(node.getAttribute('class') ?? '');
  }
  throw new Error(`no chip reading ${label}`);
}

/**
 * @param {Element} root
 * @param {string} label the panel row's label.
 * @returns {{ text: string, classes: string }} the one chip that row carries.
 */
function rowChip(root, label) {
  for (const row of root.querySelectorAll('.Box-row')) {
    if (text(row.querySelector('.bghsa-label')) !== label) continue;
    const chips = row.querySelectorAll('.Label');
    if (chips.length !== 1) throw new Error(`the ${label} row carries ${chips.length} chips`);
    const chip = /** @type {Element} */ (chips[0]);
    return { text: text(chip), classes: String(chip.getAttribute('class') ?? '') };
  }
  throw new Error(`no panel row labeled ${label}`);
}

/**
 * @param {import('../src/common/parse-detail.js').ParsedDetail} advisory
 * @param {Record<string, unknown>} payload
 * @returns {Promise<Element>}
 */
async function buildWith(advisory, payload) {
  return build(advisory, tracking.read(payload, await tracking.fingerprints(advisory)));
}

/**
 * @param {Element} root
 * @returns {string} The description provenance chip text.
 */
function provenance(root) {
  for (const line of root.querySelectorAll('.bghsa-confirmation')) {
    if (text(line.querySelector('.bghsa-confirmation-name')) !== 'Description') continue;
    return text(line.querySelectorAll('.Label')[1] ?? null);
  }
  throw new Error('no description confirmation line');
}

/**
 * @param {Element} root
 * @param {string} name the track's name in the confirmation block.
 * @returns {{ chip: string, classes: string, note: string }}
 */
function confirmation(root, name) {
  for (const line of root.querySelectorAll('.bghsa-confirmation')) {
    if (text(line.querySelector('.bghsa-confirmation-name')) !== name) continue;
    const label = line.querySelector('.Label');
    return {
      chip: text(label),
      classes: String(label?.getAttribute('class') ?? ''),
      note: text(line.querySelector('.bghsa-confirmation-note')),
    };
  }
  throw new Error(`no confirmation line for ${name}`);
}

/**
 * @param {Element} root
 * @returns {string[]} the labels of the rows the panel carries.
 */
function rowLabels(root) {
  return texts(root, '.Box-row .bghsa-label');
}

/**
 * @param {string} name The field name inside `repository_advisory[...]`.
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function withRenamedField(name) {
  const field = triageDoc.querySelector(`[name="repository_advisory[${name}]"]`);
  if (field === null) throw new Error(`the triage fixture carries no ${name} field`);
  field.setAttribute('name', `repository_advisory[${name}-renamed]`);
  try {
    const parsed = parse.parseDetail(triageDoc);
    if (parsed === null) throw new Error('the triage fixture stopped parsing');
    return parsed;
  } finally {
    field.setAttribute('name', `repository_advisory[${name}]`);
  }
}

test('an advisory that is dealt with carries no waiting chip', async () => {
  assert.strictEqual(published.state, 'Published');
  const built = await buildTracked(published);
  assert.deepStrictEqual(texts(built, '.Box-header .Label'), []);
  const closed = { ...published, state: 'Closed', timeline: [] };
  assert.strictEqual(derive.derive(closed).neverReviewed, true);
  assert.deepStrictEqual(texts(build(closed), '.Box-header .Label'), []);
});

test('an embargo past its lift date says overdue in words, not only in tone', async () => {
  const built = await buildWith(triage, { embargo: { lift: '2000-01-01' } });
  assert.deepStrictEqual(rowChip(built, 'Embargo'), {
    text: 'Overdue since 2000-01-01',
    classes: 'Label Label--secondary bghsa-tone-danger',
  });
  const inForce = await buildWith(triage, { embargo: { lift: '2999-12-31' } });
  assert.notStrictEqual(
    rowChip(built, 'Embargo').text,
    rowChip(inForce, 'Embargo').text,
    'an overdue embargo and one in force read alike'
  );
});

test('an embargo with no lift date is a chip saying so', async () => {
  const built = await buildWith(triage, { embargo: {} });
  assert.deepStrictEqual(rowChip(built, 'Embargo'), {
    text: 'No lift date',
    classes: 'Label Label--secondary bghsa-tone-attention',
  });
});

test('an advisory with no embargo carries no chip about one', async () => {
  const built = await buildWith(triage, { triage: 'evaluating' });
  assert.deepStrictEqual(headerDates(built), []);
  assert.deepStrictEqual(rowLabels(built).includes('Embargo'), false);
});

test('the panel reports whether the description is the original text', () => {
  assert.strictEqual(provenance(build(triage)), 'Not updated');
  assert.strictEqual(provenance(build(draft)), 'Updated');
  assert.deepStrictEqual(
    rowLabels(build(triage)).filter((label) => label === 'Description'),
    [],
    'the panel carries a second row called Description'
  );
});

test('the panel leads with the three confirmations', () => {
  const built = build(triage);
  assert.strictEqual(text(built.querySelector('.bghsa-confirmed-heading')), 'Confirmations');
  assert.deepStrictEqual(texts(built, '.bghsa-confirmation-name'), [
    'Title',
    'Description',
    'Severity',
  ]);
  const first = built.querySelector('.Box-header')?.nextElementSibling;
  assert.ok(
    first?.classList.contains('bghsa-confirmed') === true,
    'the confirmations are not the first thing under the chip row'
  );
});

test('the confirmations go with the state, and with nothing else about the page', () => {
  /** @type {readonly [string | null, boolean][]} */
  const states = [
    ['Triage', true],
    ['Draft', true],
    ['Published', false],
    ['published', false],
    ['Closed', false],
    [null, true],
  ];
  for (const [state, shown] of states) {
    const built = build({ ...triage, state });
    assert.strictEqual(
      built.querySelector('.bghsa-confirmed') !== null,
      shown,
      `the confirmations under the state ${String(state)}`
    );
    assert.strictEqual(
      text(built).includes('Not confirmed'),
      shown,
      `an absence reported under the state ${String(state)}`
    );
  }
});

test('a dealt-with advisory offers no preserve button and no row', async () => {
  const payload = { triage: 'awaiting reporter' };
  /** @type {readonly [string, boolean][]} */
  const states = [
    ['Triage', true],
    ['Draft', true],
    ['Published', false],
    ['Closed', false],
  ];
  for (const [state, offered] of states) {
    const built = await buildWith({ ...triage, state }, payload);
    assert.strictEqual(
      built.querySelector('button.bghsa-preserve') !== null,
      offered,
      `the preserve button under the state ${state}`
    );
    assert.strictEqual(
      rowLabels(built).includes('Original report'),
      offered,
      `the original report row under the state ${state}: ${rowLabels(built).join(', ')}`
    );
  }
});

test('a confirmed value names who confirmed it and when', async () => {
  const fingerprint = await schema.fingerprint(triage.title);
  assert.ok(fingerprint === '8ae5d80140a5', `the title fingerprint reads ${fingerprint}`);
  const built = await buildWith(triage, {
    confirmed: { title: { by: 'samuelkarp', at: '2026-08-25T18:04:11Z', fp: fingerprint } },
  });
  const title = confirmation(built, 'Title');
  assert.ok(title.chip === 'Confirmed', `the title chip reads ${title.chip}`);
  assert.ok(title.classes === 'Label Label--secondary', `a confirmed chip is toned: ${title.classes}`);
  assert.ok(
    title.note === 'samuelkarp, 2026-08-25 18:04 UTC',
    `the note reads ${title.note}`
  );
  assert.deepStrictEqual(texts(built, '.bghsa-warning'), []);
});

test('a value changed after it was confirmed reverts to unconfirmed', async () => {
  const fingerprint = await schema.fingerprint(triage.title);
  const confirmed = {
    confirmed: { title: { by: 'samuelkarp', at: '2026-08-25T18:04:11Z', fp: fingerprint } },
  };
  const rewritten = { ...triage, title: `${triage.title} in the drawer handler` };
  const built = await buildWith(rewritten, confirmed);
  const title = confirmation(built, 'Title');
  assert.ok(title.chip === 'Not confirmed', `the title chip reads ${title.chip}`);
  assert.ok(
    title.classes === 'Label Label--secondary',
    `the drifted chip is toned: ${title.classes}`
  );
  assert.ok(title.note === '', `the drifted track carries a note: ${title.note}`);
  assert.deepStrictEqual(texts(built, '.bghsa-warning'), []);
});

test('a scoring source the form does not carry reads as unread, not as drift', async () => {
  const unread = withRenamedField('severity');
  assert.strictEqual(unread.severityFieldPresent, false);
  assert.strictEqual(unread.cvssV3Present, true);

  const built = await buildWith(unread, {
    confirmed: {
      scoring: {
        by: 'dmcgowan',
        at: '2026-08-21T14:02:00Z',
        fp: await schema.scoringFingerprint(triage.severityField, triage.cvssV3),
      },
    },
  });
  const scoring = confirmation(built, 'Severity');
  assert.ok(scoring.chip === 'Unknown', `the scoring chip reads ${scoring.chip}`);
  assert.ok(
    scoring.classes === 'Label Label--secondary',
    `the scoring chip is toned: ${scoring.classes}`
  );
  assert.strictEqual(scoring.note, '', `the chip carries a note: ${scoring.note}`);
  assert.deepStrictEqual(texts(built, '.bghsa-warning'), []);
});

test('a CVSS vector the form does not carry reads as unread, not as drift', async () => {
  // Scoring fingerprints require both severity and the CVSS vector.
  // A missing field makes confirmation status unknown.
  const unread = withRenamedField('cvss_v3');
  const built = await buildWith(unread, {
    confirmed: {
      scoring: {
        by: 'dmcgowan',
        at: '2026-08-21T14:02:00Z',
        fp: await schema.scoringFingerprint(triage.severityField, triage.cvssV3),
      },
    },
  });
  const scoring = confirmation(built, 'Severity');
  assert.ok(scoring.chip === 'Unknown', `the scoring chip reads ${scoring.chip}`);
  assert.strictEqual(scoring.note, '', `the chip carries a note: ${scoring.note}`);
  assert.deepStrictEqual(texts(built, '.bghsa-warning'), []);
});

test('the stored tracks the triage advisory carries are shown', async () => {
  const built = await buildTracked(triage);
  assert.deepStrictEqual(rowLabels(built), [
    'Triage',
    'Owners',
    'Backport targets',
    'Embargo',
    'Original report',
  ]);
  assert.deepStrictEqual(texts(built, '.Box-row:not(.bghsa-confirmed) .bghsa-chips .Label'), [
    'Awaiting reporter',
    'samuelkarp',
    'release/1.0',
    'Lifts 2026-09-30',
  ]);
  assert.deepStrictEqual(texts(built, '.bghsa-since'), ['since 2026-08-25 18:04 UTC']);
  assert.strictEqual(rowText(built, 'Embargo'), 'Lifts 2026-09-30');
});

test('the triage chip says which side the advisory is waiting on', () => {
  const base = tracking.untracked();
  /**
   * @param {string} value
   * @returns {{ text: string, classes: string }}
   */
  const triageChip = (value) => rowChip(build(triage, { ...base, triage: value }), 'Triage');

  const evaluating = triageChip('evaluating');
  assert.ok(evaluating.text === 'Evaluating', `the chip reads ${evaluating.text}`);
  assert.ok(
    evaluating.classes === 'Label Label--secondary bghsa-tone-danger',
    `evaluating is on us: ${evaluating.classes}`
  );

  const ours = triageChip('awaiting maintainer input');
  assert.ok(
    ours.classes === 'Label Label--secondary bghsa-tone-danger',
    `awaiting maintainer input is on us: ${ours.classes}`
  );

  const theirs = triageChip('awaiting reporter');
  assert.ok(
    theirs.classes === 'Label Label--secondary bghsa-tone-attention',
    `awaiting reporter is on the reporter: ${theirs.classes}`
  );

  const unknown = triageChip('waiting for the weekend');
  assert.ok(
    unknown.classes === 'Label Label--secondary bghsa-tone-danger',
    `a value this reader does not know: ${unknown.classes}`
  );
});

test('a track the snapshot says nothing about carries no row', () => {
  assert.deepStrictEqual(rowLabels(build(draft)), ['Original report']);
});

test('the editing controls start collapsed', async () => {
  const built = await buildEditable(triage);

  const disclosure = built.querySelector('.bghsa-editor details');
  if (disclosure === null) throw new Error('the panel carries no editing disclosure');
  const open = disclosure.getAttribute('open');
  assert.ok(open === null, `the editing disclosure's open attribute: ${open}`);
  assert.ok(
    disclosure.querySelector('select.bghsa-triage') !== null,
    'the disclosure holds none of the editing controls'
  );
});

test('a closed advisory shows the reason and what it duplicates', async () => {
  const built = await buildWith(triage, {
    triage: 'evaluating',
    closure: { reason: 'duplicate', duplicateOf: 'GHSA-cm76-qm8v-3j95' },
  });
  assert.strictEqual(rowText(built, 'Closed as'), 'Duplicateof GHSA-cm76-qm8v-3j95');
  assert.strictEqual(
    built.querySelector('.bghsa-duplicate')?.getAttribute('href'),
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-cm76-qm8v-3j95'
  );
});

test('a duplicate the panel cannot interpret is still readable', async () => {
  const built = await buildWith(triage, {
    triage: 'evaluating',
    closure: { reason: 'duplicate', duplicateOf: 'the one <prakleumas> filed last March' },
  });
  assert.strictEqual(
    rowText(built, 'Closed as'),
    'Duplicateof the one prakleumas filed last March'
  );
  assert.strictEqual(
    built.querySelector('.bghsa-duplicate'),
    null,
    'a value nobody can interpret was drawn as a link'
  );
});

test('a chip carrying a stored value is sentence-cased, and a login is not', async () => {
  assert.strictEqual(chips.sentenceCase('awaiting reporter'), 'Awaiting reporter');
  assert.strictEqual(chips.sentenceCase('not a vulnerability'), 'Not a vulnerability');
  assert.strictEqual(chips.sentenceCase('Already capital'), 'Already capital');
  assert.strictEqual(chips.sentenceCase(''), '');
  const built = await buildWith(triage, {
    triage: 'awaiting reporter',
    owners: ['samuelkarp'],
    backports: ['release/1.0'],
    closure: { reason: 'no reporter response' },
  });
  assert.deepStrictEqual(texts(built, '.Box-row:not(.bghsa-confirmed) .bghsa-chips .Label'), [
    'Awaiting reporter',
    'samuelkarp',
    'release/1.0',
    'No reporter response',
  ]);
});

test('the panel does not list the snapshots it read', async () => {
  const built = await buildTracked(triage);
  const rendered = text(built);
  assert.ok(
    !rendered.includes('282848'),
    'the panel names a comment the snapshots came from'
  );
  assert.ok(
    !rendered.includes('prakleumas'),
    'the panel names the author of an untrusted snapshot'
  );
});

test('the panel sits in the main column, above the description Box, outside both live regions', async () => {
  reset(triageDoc);
  const injected = await panel.render(triageDoc);
  assert.ok(injected !== null, 'render placed no panel');
  const placed = /** @type {Element} */ (injected);

  const column = triageDoc.querySelector('div.col-12.col-md-9');
  assert.ok(column !== null, 'the page has no main column');
  assert.ok(placed.closest('div.col-12.col-md-9') === column, 'the panel is not in the main column');
  assert.ok(placed.closest('div.js-socket-channel') === null, 'the panel is inside a live region');

  const next = placed.nextElementSibling;
  assert.ok(next !== null, 'the panel has no following sibling');
  const region = /** @type {Element} */ (next);
  assert.match(
    region.getAttribute('data-url') ?? '',
    /show_partial\?partial=repository_advisory%2Fbody$/
  );
  const description = triageDoc.querySelector(
    'div.js-repository-advisory-details > div.Box-header.timeline-comment-header'
  );
  assert.ok(description !== null, 'the page has no description Box header');
  assert.strictEqual(region.contains(description), true);
});

test('injecting twice leaves one panel', () => {
  const doc = page();
  place(doc);
  place(doc);
  place(doc);
  assert.strictEqual(doc.querySelectorAll('#bghsa-detail-panel').length, 1);
  assert.strictEqual(doc.querySelectorAll('#bghsa-style').length, 1);
});

test('a state the panel could not read carries the unknown chip', () => {
  const built = build({ ...triage, state: null });
  assert.deepStrictEqual(texts(built, '.Box-header .Label'), ['Unknown', 'Blocked on us']);
  assert.strictEqual(
    chipClass(built, 'Unknown'),
    'Label Label--secondary bghsa-tone-attention'
  );
});

test('a description whose provenance cannot be read is shown as unknown', () => {
  const built = build({ ...draft, descriptionOriginal: null });
  assert.strictEqual(provenance(built), 'Unknown');
});

test('a document that is not an advisory detail page gets no panel', async () => {
  for (const name of ['list-page-triage.html', 'list-page-draft.html', 'edit-form.html']) {
    const doc = parseFixture(name);
    assert.ok((await panel.render(doc)) === null, name);
    assert.ok(doc.getElementById('bghsa-detail-panel') === null, name);
  }
});

test('a panel no longer sitting at its anchor is put back there', () => {
  const doc = page();
  const injected = place(doc);
  const parent = /** @type {Element} */ (injected.parentElement);
  parent.append(injected);
  assert.strictEqual(panel.outOfPlace(doc), true);

  place(doc);
  assert.strictEqual(doc.querySelectorAll('#bghsa-detail-panel').length, 1);
  const placed = /** @type {Element} */ (doc.getElementById('bghsa-detail-panel'));
  assert.match(
    placed.nextElementSibling?.getAttribute('data-url') ?? '',
    /partial=repository_advisory%2Fbody$/
  );
  assert.strictEqual(panel.outOfPlace(doc), false);
});

test('advisory content swapped in after load gets a panel with no reload', async () => {
  reset(triageDoc);
  const content = /** @type {Element} */ (
    triageDoc.querySelector('div.new-discussion-timeline')
  );
  const host = /** @type {ParentNode} */ (content.parentNode);
  content.remove();

  assert.ok((await panel.render(triageDoc)) === null, 'content that is gone still rendered a panel');
  assert.ok(
    triageDoc.getElementById('bghsa-detail-panel') === null,
    'a panel is still in the document'
  );
  assert.strictEqual(panel.outOfPlace(triageDoc), true);

  host.append(content);
  const injected = await panel.render(triageDoc);
  assert.ok(injected !== null, 'swapped-in content got no panel');
  assert.strictEqual(triageDoc.querySelectorAll('#bghsa-detail-panel').length, 1);
  assert.strictEqual(provenance(/** @type {Element} */ (injected)), 'Not updated');
  assert.strictEqual(panel.outOfPlace(triageDoc), false);
});

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wait until ready returns true or two seconds elapse.
 *
 * @param {() => boolean} ready
 * @returns {Promise<void>}
 */
async function until(ready) {
  const deadline = Date.now() + 2000;
  while (!ready() && Date.now() < deadline) await delay(5);
}

/**
 * @param {string} suffix The end of the region's `data-url`.
 * @returns {Element} the live region the triage fixture carries under it.
 */
function region(suffix) {
  const found = triageDoc.querySelector(`div.js-socket-channel[data-url$="${suffix}"]`);
  if (found === null) throw new Error(`the triage fixture carries no ${suffix} region`);
  return found;
}

/**
 * @returns {number} The number of snapshot chips.
 */
function chipCount() {
  return triageDoc.querySelectorAll(`[${parse.EXTENSION_CHIP_ATTRIBUTE}]`).length;
}

/**
 * GitHub's refreshed markup omits extension chips.
 *
 * @param {Element} source
 * @returns {Element}
 */
function refreshedCopy(source) {
  const copy = /** @type {Element} */ (source.cloneNode(true));
  for (const chip of copy.querySelectorAll(`[${parse.EXTENSION_CHIP_ATTRIBUTE}]`)) chip.remove();
  return copy;
}

test('a live region whose content is replaced marks its snapshots again', async () => {
  reset(triageDoc);
  const timeline = region('timeline');
  const refreshed = refreshedCopy(timeline);
  const drawn = await panel.render(triageDoc);
  const marked = chipCount();
  assert.ok(marked > 0, 'the triage fixture marked no snapshot');

  const observer = panel.observe(triageDoc);
  assert.ok(observer !== null, 'the document offered no observer');
  try {
    timeline.replaceWith(refreshed);
    assert.strictEqual(chipCount(), 0, 'the refreshed region arrived carrying chips');
    assert.strictEqual(panel.outOfPlace(triageDoc), false, 'the refresh moved the panel');
    await until(() => chipCount() > 0);
    assert.strictEqual(chipCount(), marked);
    assert.ok(triageDoc.getElementById(panel.PANEL_ID) === drawn, 'warning repair replaced the panel');
  } finally {
    observer?.disconnect();
  }
});

test('a state a live region moved on reaches the panel', async () => {
  reset(triageDoc);
  const title = region('title');
  const refreshed = refreshedCopy(title);
  const state = refreshed.querySelector('.State');
  if (state === null) throw new Error('the title region carries no state label');
  state.textContent = 'Published';

  const injected = await panel.render(triageDoc);
  assert.ok(injected !== null, 'render placed no panel');
  const confirmations = () =>
    /** @type {Element} */ (triageDoc.getElementById(panel.PANEL_ID)).querySelectorAll(
      '.bghsa-confirmed'
    ).length;
  assert.strictEqual(confirmations(), 1, 'the triage advisory carries no confirmations');

  const observer = panel.observe(triageDoc);
  try {
    title.replaceWith(refreshed);
    await until(() => confirmations() === 0);
    assert.strictEqual(confirmations(), 0, 'the panel still answers for a published advisory');
    assert.strictEqual(triageDoc.querySelectorAll(`#${panel.PANEL_ID}`).length, 1);
  } finally {
    observer?.disconnect();
    refreshed.replaceWith(title);
  }
});

test("the extension's own writing schedules no pass", async () => {
  reset(triageDoc);
  const fingerprints = tracking.fingerprints;
  let passes = 0;
  globalThis.bghsa.tracking.fingerprints = (advisory) => {
    passes += 1;
    return fingerprints(advisory);
  };
  const observer = panel.observe(triageDoc);
  try {
    await panel.render(triageDoc);
    assert.strictEqual(passes, 1);
    await delay(dom.RENDER_DELAY_MS + 50);
    assert.strictEqual(passes, 1, `the extension's own writing ran ${passes - 1} more passes`);
    assert.strictEqual(triageDoc.querySelectorAll(`#${panel.PANEL_ID}`).length, 1);
  } finally {
    observer?.disconnect();
    globalThis.bghsa.tracking.fingerprints = fingerprints;
  }
});

test('the observer runs its passes through the loop it is given', async () => {
  const doc = page();
  let passes = 0;
  const observer = panel.observe(doc, async () => {
    passes += 1;
  });
  assert.ok(observer !== null, 'the document offered no observer');
  try {
    doc.body?.append(doc.createElement('div'));
    await until(() => passes > 0);
    assert.strictEqual(passes, 1);
  } finally {
    observer?.disconnect();
  }
});

test('unrelated page mutations leave the editor mounted', async (t) => {
  const doc = advisoryPage();
  const drawn = await panel.render(doc);
  assert.ok(drawn);

  const input = /** @type {HTMLInputElement} */ (drawn.querySelector('.bghsa-owner-input'));
  const disclosure = /** @type {Element} */ (drawn.querySelector('details.bghsa-editor-details'));
  assert.ok(doc.defaultView);
  input.value = 'half-typed';
  input.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
  disclosure.setAttribute('open', '');

  const host = doc.createElement('div');
  const shadowHost = doc.createElement('div');
  shadowHost.attachShadow({ mode: 'closed' }).append(doc.createElement('input'));

  const loop = panel.passFor(doc);
  let passes = 0;
  const observer = panel.observe(doc, async () => {
    await loop();
    passes += 1;
  });

  try {
    /** @type {Array<[string, () => void]>} */
    const mutations = [
      ['body insertion', () => doc.body.append(host)],
      ['body modification', () => host.append(doc.createElement('span'))],
      ['body removal', () => host.remove()],
      ['shadow host insertion', () => doc.body.append(shadowHost)],
      ['shadow host removal', () => shadowHost.remove()],
    ];

    for (const [name, mutate] of mutations) {
      await t.test(name, async () => {
        const before = passes;
        mutate();
        await until(() => passes > before);

        assert.ok(passes > before, 'the broad observer did not run the loop');
        assert.ok(doc.getElementById(panel.PANEL_ID) === drawn, 'the mutation replaced the panel');
        assert.ok(drawn.querySelector('.bghsa-owner-input') === input, 'the input was replaced');
        assert.ok(drawn.querySelector('details.bghsa-editor-details') === disclosure);
        assert.ok(input.isConnected);
        assert.strictEqual(input.value, 'half-typed');
        assert.ok(disclosure.hasAttribute('open'));
      });
    }

    const before = passes;
    drawn.append(doc.createElement('span'));
    await delay(dom.RENDER_DELAY_MS + 50);
    assert.strictEqual(passes, before, 'owned writing scheduled a pass');

    // Linkedom reports attributes even to a child-list-only observer. Whether
    // a pass runs or not, an attribute-only change must leave the editor alone.
    doc.body.setAttribute('data-unrelated', 'changed');
    await delay(dom.RENDER_DELAY_MS + 50);
    assert.ok(doc.getElementById(panel.PANEL_ID) === drawn, 'attribute-only writing replaced the panel');

    doc.getElementById(panel.STYLE_ID)?.remove();
    assert.ok(await panel.render(doc) === drawn, 'stylesheet repair replaced the panel');
    assert.ok(doc.getElementById(panel.STYLE_ID), 'reuse skipped stylesheet repair');
  } finally {
    observer?.disconnect();
    edit.drafts.clear();
  }
});

test('only the remembered panel at its anchor can be reused', async (t) => {
  /** @type {Array<[string, (doc: Document, drawn: Element) => void]>} */
  const cases = [
    ['removed panel', (_doc, drawn) => drawn.remove()],
    ['displaced panel', (doc, drawn) => doc.body.append(drawn)],
    ['cloned sentinel', (_doc, drawn) => drawn.replaceWith(drawn.cloneNode(true))],
    ['missing anchor', (doc) => doc.querySelector(parse.DESCRIPTION_HEADER)?.remove()],
    ['replaced description region', (doc) => {
      const place = panel.anchor(doc);
      assert.ok(place);
      const replacement = doc.createElement('div');
      replacement.append(place.before.cloneNode(true));
      place.before.replaceWith(replacement);
    }],
    ['replaced frame', (doc) => {
      const frame = doc.querySelector('div.new-discussion-timeline');
      assert.ok(frame);
      frame.replaceWith(frame.cloneNode(true));
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const doc = advisoryPage();
      const drawn = await panel.render(doc);
      assert.ok(drawn);

      const loop = panel.passFor(doc);
      let passes = 0;
      const observer = panel.observe(doc, async () => {
        await loop();
        passes += 1;
      });

      try {
        mutate(doc, drawn);
        const sentinel = doc.getElementById(panel.PANEL_ID);

        if (name === 'cloned sentinel') {
          // A sentinel-only swap is owned writing to the broad observer; the
          // next requested pass must not mistake the clone for our controls.
          await loop();
        } else {
          await until(() => passes > 0);
          assert.ok(passes > 0, 'the observer did not repair placement');
        }

        const next = doc.getElementById(panel.PANEL_ID);
        assert.ok(next);
        assert.ok(next !== drawn, 'the panel was not reconstructed');
        if (name === 'cloned sentinel') assert.ok(next !== sentinel, 'the cloned sentinel was reused');
        assert.ok(next.isConnected);
        assert.strictEqual(doc.querySelectorAll(`#${panel.PANEL_ID}`).length, 1);

        const place = panel.anchor(doc);
        if (place !== null) assert.ok(next.nextElementSibling === place.before);

        const again = await panel.render(doc);
        if (place === null) assert.ok(again !== next);
        else assert.ok(again === next);
      } finally {
        observer?.disconnect();
      }
    });
  }
});

test('departure and stop forget the mounted panel', async (t) => {
  for (const action of ['departure', 'stop']) {
    await t.test(action, async () => {
      const doc = advisoryPage();
      const drawn = await panel.render(doc);
      assert.ok(drawn);
      const place = panel.anchor(doc);
      assert.ok(place);

      if (action === 'stop') {
        panel.stop(doc);
        place.parent.insertBefore(drawn, place.before);
      } else {
        const frame = doc.querySelector('div.new-discussion-timeline');
        assert.ok(frame);
        const parent = frame.parentElement;
        assert.ok(parent);
        frame.remove();
        assert.strictEqual(await panel.render(doc), null);
        parent.append(frame);
      }

      assert.ok(await panel.render(doc) !== drawn);
    });
  }
});

test('write metadata refreshes handlers even when labels are unchanged', async (t) => {
  for (const field of ['seq', 'unknown']) {
    await t.test(field, async () => {
      const doc = advisoryPage();
      const drawn = await panel.render(doc);
      assert.ok(drawn);

      const fence = doc.querySelector('#advisory-comment-282847 .highlight-source-json pre');
      assert.ok(fence);
      const snapshot = JSON.parse(fence.textContent ?? '');
      if (field === 'seq') snapshot.seq += 1;
      else snapshot.future = { retained: true };
      fence.textContent = JSON.stringify(snapshot);

      const next = await panel.render(doc);
      assert.ok(next);
      assert.ok(next !== drawn, 'changed write metadata did not reconstruct the panel');
      assert.strictEqual(text(next), text(drawn));
      assert.ok(await panel.render(doc) === next);
    });
  }
});

test('the clock redraws only when the embargo becomes overdue', async () => {
  const doc = advisoryPage();
  const now = Date.now;

  try {
    Date.now = () => Date.parse('2026-09-30T12:00:00Z');
    const drawn = await panel.render(doc);
    assert.ok(drawn);
    assert.strictEqual(rowText(drawn, 'Embargo'), 'Lifts 2026-09-30');

    Date.now = () => Date.parse('2026-09-30T23:00:00Z');
    assert.ok(await panel.render(doc) === drawn, 'raw time caused a redraw');

    Date.now = () => Date.parse('2026-10-01T00:00:00Z');
    const next = await panel.render(doc);
    assert.ok(next);
    assert.ok(next !== drawn);
    assert.strictEqual(rowText(next, 'Embargo'), 'Overdue since 2026-09-30');
  } finally {
    Date.now = now;
  }
});

/**
 * The captured fragment inside a full document, so body mutations and frame
 * replacement exercise the same ancestry as the browser.
 *
 * @returns {Document}
 */
function advisoryPage() {
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(
    '<!doctype html><html><head></head><body>' +
    parseFixture('triage-thread.html').documentElement.outerHTML +
    '</body></html>'
  ).document));
}

test('a pass reads the document alone, and a request during one folds into one more', async () => {
  reset(triageDoc);
  const fingerprints = tracking.fingerprints;
  let reading = 0;
  let overlaps = 0;
  let passes = 0;
  globalThis.bghsa.tracking.fingerprints = async (advisory) => {
    passes += 1;
    reading += 1;
    if (reading > 1) overlaps += 1;
    await delay(5);
    const read = await fingerprints(advisory);
    reading -= 1;
    return read;
  };
  try {
    const pass = panel.renderLoop(triageDoc);
    await Promise.all([pass(), pass(), pass()]);
    await until(() => reading === 0 && passes >= 2);
    assert.strictEqual(overlaps, 0, 'two passes read the document together');
    assert.strictEqual(passes, 2, `three requests ran ${passes} passes`);
    assert.strictEqual(triageDoc.querySelectorAll(`#${panel.PANEL_ID}`).length, 1);
    assert.strictEqual(triageDoc.querySelectorAll(`#${panel.STYLE_ID}`).length, 1);
    assert.strictEqual(chipCount(), 1);
  } finally {
    globalThis.bghsa.tracking.fingerprints = fingerprints;
  }
});

/**
 * @param {Document} doc
 * @param {string} name The class stem of the control to read.
 * @returns {string[]} the values that control offers in the panel the document
 *   carries.
 */
function offered(doc, name) {
  const placed = doc.getElementById(panel.PANEL_ID);
  if (placed === null) return [];
  return Array.from(placed.querySelectorAll(`datalist.bghsa-${name}-candidates option`)).map(
    (option) => String(option.getAttribute('value') ?? '')
  );
}

test('a member storage holds and this page does not reaches the panel', async () => {
  reset(triageDoc);
  members.clear();
  members.setStorage(fakeStorage({ [members.MEMBERS_KEY]: { 'git-utensils': ['dmcgowan'] } }));
  try {
    const drawn = await panel.render(triageDoc);
    assert.ok(drawn !== null, 'the triage fixture offered no anchor');
    await until(() => offered(triageDoc, 'owner').includes('dmcgowan'));
    assert.strictEqual(
      offered(triageDoc, 'owner').join(' '),
      'samuelkarp dmcgowan',
      'the stored login is not offered as an owner'
    );
    assert.strictEqual(triageDoc.querySelectorAll(`#${panel.PANEL_ID}`).length, 1);
    assert.ok(triageDoc.getElementById(panel.PANEL_ID) !== drawn);
  } finally {
    members.setStorage(null);
    members.clear();
    reset(triageDoc);
  }
});

test('a branch storage holds and this page does not reaches the panel', async () => {
  reset(triageDoc);
  branches.clear();
  const key = branches.keyOf({ owner: 'git-utensils', repo: 'Spoon-Knife' });
  assert.ok(key !== null, 'the repository has no branch key');
  branches.setStorage(fakeStorage({ [branches.BRANCHES_KEY]: { [key]: ['release/2.10'] } }));
  try {
    const drawn = await panel.render(triageDoc);
    assert.ok(drawn !== null, 'the triage fixture offered no anchor');
    await until(() => offered(triageDoc, 'backport').includes('release/2.10'));
    assert.strictEqual(
      offered(triageDoc, 'backport').join(' '),
      'release/2.10 release/1.0',
      'the stored branch is not offered as a backport target'
    );
    assert.strictEqual(triageDoc.querySelectorAll(`#${panel.PANEL_ID}`).length, 1);
    assert.ok(triageDoc.getElementById(panel.PANEL_ID) !== drawn);
  } finally {
    branches.setStorage(null);
    branches.clear();
    reset(triageDoc);
  }
});

test('candidate stores elsewhere do not replace this panel', async () => {
  const doc = advisoryPage();
  members.setStorage(fakeStorage({ [members.MEMBERS_KEY]: { elsewhere: ['new-member'] } }));
  branches.setStorage(fakeStorage({
    [branches.BRANCHES_KEY]: { 'git-utensils/other-repo': ['release/99.0'] },
  }));

  try {
    const drawn = await panel.render(doc);
    await until(() => members.known({ owner: 'elsewhere' }).includes('new-member'));
    await panel.passFor(doc)();

    assert.ok(doc.getElementById(panel.PANEL_ID) === drawn, 'unrelated candidates replaced the panel');
    assert.ok(!offered(doc, 'owner').includes('new-member'));
    assert.ok(!offered(doc, 'backport').includes('release/99.0'));
  } finally {
    members.setStorage(null);
    branches.setStorage(null);
    members.clear();
    branches.clear();
  }
});

const DETAIL = '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj';

const ADVISORY_PAGE = [
  '<!doctype html><html><body>',
  '<div class="gh-header-meta"><span class="State">Triage</span>',
  '<span class="Label--large" title="Severity: High">High</span>',
  '<span class="user-select-contain">GHSA-jmvx-2wfw-xfgj</span></div>',
  `<div class="js-socket-channel js-updatable-content" data-url="${DETAIL}/repository_advisory/body">`,
  '<div class="Box"><div class="js-repository-advisory-details">',
  '<div class="Box-header timeline-comment-header">',
  '<a class="author" href="/prakleumas">prakleumas</a>',
  '<span class="js-comment-edit-history"></span></div>',
  '<form><input name="repository_advisory[title]" value="Path traversal in the drawer handler">',
  '<textarea name="repository_advisory[description]">The handler joins a path.</textarea>',
  '</form></div></div></div>',
  `<form class="js-advisory-comment-form" action="${DETAIL}/comments">`,
  '<input type="hidden" name="authenticity_token" value="a-token">',
  '<textarea name="body"></textarea>',
  '<button type="submit" name="comment" value="1" disabled>Comment</button>',
  '</form></body></html>',
].join('\n');

/**
 * Render a response containing the marker from the submitted comment.
 *
 * @param {RequestInit} init The write request.
 * @returns {string}
 */
function wroteHtml(init) {
  const sent = /** @type {URLSearchParams} */ (/** @type {unknown} */ (init.body));
  const found = new RegExp(`${preserve.MARKER_PREFIX}[0-9a-f]+`).exec(String(sent.get('body')));
  return (
    '<!doctype html><html><body><div class="comment-body markdown-body js-comment-body"><details>' +
    `<summary>${preserve.PRESERVE_SUMMARY}</summary>` +
    `<p><code>${found === null ? '' : found[0]}</code></p>` +
    `<p>${preserve.TITLE_LABEL}</p><p>Path traversal in the drawer handler</p>` +
    `<p>${preserve.DESCRIPTION_LABEL}</p><p>The handler joins a path.</p>` +
    '</details></div></body></html>'
  );
}

const WROTE = null;

/**
 * Return `page` for advisory reads and `body` for writes.
 *
 * @param {number} status The write response status.
 * @param {string | null} body The write response markup; null echoes the submitted comment.
 * @param {string} [page] The advisory response markup.
 * @returns {{ send: import('../src/common/write.js').WriteFetch, calls: Array<{ url: string, init: RequestInit }>, posts: () => Array<{ url: string, init: RequestInit }> }}
 */
function fakeFetch(status, body, page) {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  return {
    calls,
    posts: () => calls.filter((call) => call.init.method === 'POST'),
    send: async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'GET') {
        const answer = page ?? ADVISORY_PAGE;
        return { status: 200, text: async () => answer };
      }
      const answer = body ?? wroteHtml(init);
      return { status, text: async () => answer };
    },
  };
}

/**
 * @param {string} markup
 * @returns {Document}
 */
function asDocument(markup) {
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(markup).document));
}

const elsewhere = {
  ...triage,
  ref: { owner: 'someone', repo: 'else', ghsaId: 'GHSA-0000-0000-0000' },
};

const preserved = {
  ...triage,
  comments: [
    {
      ...(/** @type {import('../src/common/parse-detail.js').ParsedComment} */ (
        triage.comments[0]
      )),
      text: `Original report preserved by Better GHSA ${preserve.MARKER_PREFIX}0f0f0f0f0f0f0f0f`,
    },
  ],
};

/**
 * @param {Element} root
 * @returns {Element} the preservation button in a panel.
 */
function preserveButton(root) {
  const button = root.querySelector('button.bghsa-preserve');
  if (button === null) throw new Error('the panel offers no preservation button');
  return button;
}

/**
 * @returns {Promise<void>} resolves once the click handler has run to the end.
 */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('an advisory that already carries the comment links to it', () => {
  const built = build(preserved);
  assert.strictEqual(built.querySelector('button.bghsa-preserve'), null);
  assert.strictEqual(rowText(built, 'Original report'), 'Preserved');
  const link = built.querySelector('.Box-row a.bghsa-preserved');
  assert.ok(link !== null, 'the row carries no link to the comment');
  assert.strictEqual(
    link?.getAttribute('href'),
    `#${preserved.comments[0]?.elementId}`,
    'the link does not point at the comment holding the report'
  );
});

test('the button on a repository off the allowlist writes nothing and says why', async () => {
  preserve.attempts.clear();
  const built = build(elsewhere);
  const button = /** @type {HTMLElement} */ (
    /** @type {unknown} */ (preserveButton(built))
  );
  button.click();
  await settle();

  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), [
    "Error: someone/else is not on this extension's allowlist.",
  ]);
  assert.strictEqual(button.hasAttribute('disabled'), false);
  assert.ok(built.contains(button), 'the button was taken out of the panel');
});

test('a press that could not tell the provenance writes nothing and says why', async () => {
  preserve.attempts.clear();
  const built = build({ ...triage, descriptionOriginal: null });
  const button = preserveButton(built);
  const fake = fakeFetch(200, WROTE);
  const outcome = await panel.press(blank, { ...triage, descriptionOriginal: null }, button, {
    fetch: fake.send,
    parseDocument: asDocument,
  });

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'provenance');
  assert.strictEqual(fake.calls.length, 0);
  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), ['Error: failed to save']);
  assert.strictEqual(button.hasAttribute('disabled'), false);
});

test('a press that wrote the comment takes the button away and says so', async () => {
  preserve.attempts.clear();
  const built = build(triage);
  const button = preserveButton(built);
  const fake = fakeFetch(200, WROTE);
  const outcome = await panel.press(blank, triage, button, {
    fetch: fake.send,
    parseDocument: asDocument,
  });

  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(fake.posts().length, 1);
  assert.strictEqual(built.querySelector('button.bghsa-preserve'), null);
  assert.strictEqual(rowText(built, 'Original report'), 'Preserved');
  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), []);
});

test('a press whose result GitHub did not confirm leaves the button pressed', async () => {
  preserve.attempts.clear();
  const built = build(triage);
  const button = preserveButton(built);
  const fake = fakeFetch(200, '<!doctype html><html><body>nothing</body></html>');
  const outcome = await panel.press(blank, triage, button, {
    fetch: fake.send,
    parseDocument: asDocument,
  });

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'unwritten');
  assert.strictEqual(button.hasAttribute('disabled'), true);
  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), [
    'Error: failed to validate save',
  ]);
});

test('a panel rebuilt after a press that wrote offers no button', async () => {
  preserve.attempts.clear();
  const built = build(triage);
  const fake = fakeFetch(200, WROTE);
  const outcome = await panel.press(blank, triage, preserveButton(built), {
    fetch: fake.send,
    parseDocument: asDocument,
  });
  assert.strictEqual(outcome.ok, true);

  const again = build(triage);
  assert.strictEqual(again.querySelector('button.bghsa-preserve'), null);
  assert.strictEqual(rowText(again, 'Original report'), 'Preserved');
  preserve.attempts.clear();
});

test('preservation completion refreshes a panel reconstructed mid-flight', async () => {
  preserve.attempts.clear();
  const doc = advisoryPage();
  const drawn = await panel.render(doc);
  assert.ok(drawn);
  const advisory = parse.parseDetail(doc);
  assert.ok(advisory);

  const fake = fakeFetch(200, WROTE);
  let sent = false;
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });

  const pending = panel.press(doc, advisory, preserveButton(drawn), {
    fetch: async (url, init) => {
      if (init.method === 'POST') {
        sent = true;
        await gate;
      }

      return fake.send(url, init);
    },
    parseDocument: asDocument,
  });

  try {
    await until(() => sent);

    // A real comment update reconstructs the panel while the write is held.
    const comment = doc.querySelector('.js-comment-body');
    assert.ok(comment);
    const added = doc.createElement('p');
    added.textContent = 'Additional context.';
    comment.append(added);

    const midflight = await panel.render(doc);
    assert.ok(midflight);
    assert.ok(midflight !== drawn, 'the comment update did not reconstruct the panel');
    assert.ok(!drawn.isConnected);
    assert.strictEqual(rowText(midflight, 'Original report'), preserve.ATTEMPTED_MESSAGE);

    release();
    assert.strictEqual((await pending).ok, true);
    assert.strictEqual(fake.posts().length, 1);

    // The original press settles on detached controls; the next pass must heal.
    assert.strictEqual(rowText(drawn, 'Original report'), 'Preserved');
    assert.strictEqual(rowText(midflight, 'Original report'), preserve.ATTEMPTED_MESSAGE);

    const completed = await panel.render(doc);
    assert.ok(completed);
    assert.strictEqual(rowText(completed, 'Original report'), 'Preserved');
    assert.strictEqual(completed.querySelector('button.bghsa-preserve'), null);
    assert.ok(await panel.render(doc) === completed, 'settled preservation should allow reuse');
  } finally {
    release();
    await pending;
    preserve.attempts.clear();
  }
});

test('a failed press leaves one result, not one per press', async () => {
  preserve.attempts.clear();
  const built = build(elsewhere);
  const button = preserveButton(built);
  for (const round of [1, 2, 3]) {
    const outcome = await panel.press(blank, elsewhere, button, {
      fetch: fakeFetch(200, WROTE).send,
      parseDocument: asDocument,
    });
    assert.strictEqual(outcome.reason, 'allowlist', `round ${round}`);
    assert.strictEqual(
      built.querySelectorAll('.bghsa-preserve-result').length,
      1,
      `round ${round} left more than one result`
    );
  }
  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), [
    "Error: someone/else is not on this extension's allowlist.",
  ]);
});

test('a press that read the comment already on the advisory takes the button away', async () => {
  preserve.attempts.clear();
  const preservedPage = ADVISORY_PAGE.replace(
    '<form class="js-advisory-comment-form"',
    '<div class="timeline-comment-group" id="advisory-comment-42">' +
      '<div class="comment-body markdown-body js-comment-body">' +
      `${preserve.PRESERVE_SUMMARY}<code>${preserve.MARKER_PREFIX}0f0f0f0f0f0f0f0f</code>` +
      '</div></div>' +
      '<form class="js-advisory-comment-form"'
  );
  const built = build(triage);
  const button = preserveButton(built);
  const fake = fakeFetch(200, WROTE, preservedPage);
  const outcome = await panel.press(blank, triage, button, {
    fetch: fake.send,
    parseDocument: asDocument,
  });

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'preserved');
  assert.strictEqual(fake.posts().length, 0);
  assert.strictEqual(built.querySelector('button.bghsa-preserve'), null);
  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), []);
  assert.strictEqual(rowText(built, 'Original report'), 'Preserved');
  preserve.attempts.clear();
});

test('a press that could not read the advisory page can be pressed again', async () => {
  preserve.attempts.clear();
  const built = build(triage);
  const button = preserveButton(built);
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  const outcome = await panel.press(blank, triage, button, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { status: 503, text: async () => '' };
    },
    parseDocument: asDocument,
  });

  assert.strictEqual(outcome.reason, 'fetch');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(button.hasAttribute('disabled'), false);
  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), [
    'Error: failed to refresh advisory data',
  ]);
  preserve.attempts.clear();
});

test('opening an advisory refreshes its cache entry at no request cost', async () => {
  const at = Date.parse('2026-08-27T09:00:00Z');
  const storage = fakeStorage();
  const sent = globalThis.fetch;
  cache.setStorage(storage);
  cache.setClock(() => at);
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
    /** @type {unknown} */ (() => {
      throw new Error('the detail page sent a request');
    })
  );
  try {
    const drawn = await panel.render(triageDoc);
    assert.ok(drawn !== null, 'the triage fixture offered no anchor');

    const key = cache.advisoryKey(triage.ref);
    assert.ok(key === 'adv:git-utensils/spoon-knife:ghsa-jmvx-2wfw-xfgj', `cache key: ${key}`);
    await until(() => Object.hasOwn(storage.entries, /** @type {string} */ (key)));

    const entry = await cache.getAdvisory(triage.ref, { at });
    assert.ok(entry !== null, 'the page left no cache entry');
    assert.ok(entry.observedAt === at, `the entry was observed at ${entry?.observedAt}`);
    assert.ok(entry.state === 'triage', `the entry state was ${entry?.state}`);
    const record = /** @type {{ ghsaId?: unknown }} */ (entry.record);
    assert.ok(
      record.ghsaId === 'GHSA-jmvx-2wfw-xfgj',
      `the entry holds ${String(record.ghsaId)}`
    );
  } finally {
    globalThis.fetch = sent;
    cache.setStorage(null);
    cache.setClock(null);
  }
});


test('a document behind a write from this page is not stored as a reading', async () => {
  const at = Date.parse('2026-08-27T09:00:00Z');
  const storage = fakeStorage();
  cache.setStorage(storage);
  cache.setClock(() => at);
  const key = edit.keyOf(triage);
  const fromPage = merge.mergeSnapshots(triage.comments);
  try {
    const held = await panel.remember(triage);
    assert.ok(held !== null, 'the page left no entry to stand on');

    // The saved snapshot has a higher sequence number than the open document.
    edit.written.set(key, { ...fromPage, seq: 8, observedSeq: 8, nextSeq: 9 });
    cache.setClock(() => at + 60 * 1000);
    const again = await panel.remember(triage);

    assert.strictEqual(again, null, 'the pass stored the document the write is not in');
    const entry = await cache.getAdvisory(triage.ref);
    assert.strictEqual(
      entry?.observedAt,
      at,
      'the entry was restamped with content read before the write'
    );
  } finally {
    edit.written.delete(key);
    cache.setStorage(null);
    cache.setClock(null);
  }
});

test('a document behind a preservation comment this page wrote is not stored', async () => {
  const storage = fakeStorage();
  cache.setStorage(storage);
  const ref = /** @type {import('../src/common/parse-detail.js').AdvisoryRef} */ (triage.ref);
  const key = `${ref.owner}/${ref.repo}/${ref.ghsaId}`.toLowerCase();
  try {
    preserve.attempts.set(key, 'written');
    const held = await panel.remember(triage);
    assert.strictEqual(held, null, 'the pass stored a document missing the comment it wrote');
    assert.deepStrictEqual(Object.keys(storage.entries), []);

    preserve.attempts.delete(key);
    assert.ok((await panel.remember(triage)) !== null, 'a document that caught up was not stored');
  } finally {
    preserve.attempts.delete(key);
    cache.setStorage(null);
  }
});

test('a page that does not say which advisory it is leaves no entry', async () => {
  const storage = fakeStorage();
  cache.setStorage(storage);
  try {
    const held = await panel.remember({ ...triage, ref: null });
    assert.ok(held === null, 'an advisory with no reference was cached');
    assert.deepStrictEqual(Object.keys(storage.entries), []);
  } finally {
    cache.setStorage(null);
  }
});
