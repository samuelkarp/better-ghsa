'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parseDetail = require('../src/common/parse-detail.js');
const derive = require('../src/common/derive.js');
const merge = require('../src/common/merge.js');
const schema = require('../src/common/schema.js');
const order = require('../src/common/order.js');
const chips = require('../src/common/chips.js');
const tracking = require('../src/detail/tracking.js');
const panel = require('../src/detail/panel.js');
const table = require('../src/list/table.js');

/**
 * The list row and the detail panel are two renderings of one advisory. These
 * tests build both from one fixture and one stored state and hold their chips
 * against each other, because a panel that says something other than the row a
 * maintainer clicked through from is worse than a panel that says nothing.
 */

/** When this render is happening, and when the read behind it was taken. */
const AT = Date.parse('2026-08-28T12:00:00Z');
const OBSERVED = Date.parse('2026-08-28T11:00:00Z');

/**
 * @param {string} name
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function readFixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  const doc = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
  const parsed = parseDetail.parseDetail(doc);
  if (parsed === null) throw new Error(`${name} is not an advisory detail page`);
  return parsed;
}

/** The one parse of each fixture in this file. */
const TRIAGE = readFixture('triage-thread.html');
const DRAFT = readFixture('draft.html');
const PUBLISHED = readFixture('published-containerd.html');

/** The document the panels are built into. */
const BLANK = /** @type {Document} */ (
  /** @type {unknown} */ (
    parseHTML('<!doctype html><html><head></head><body></body></html>').document
  )
);

/** A private fork holding one open pull request. */
const OPEN_FORK = {
  cloneUrl: null,
  repository: 'git-utensils/Spoon-Knife-ghsa-fork',
  deleteUrl: null,
  pullRequests: [
    {
      number: 1,
      url: null,
      title: 'Fix it',
      state: 'open',
      baseRef: 'main',
      headRef: 'fix',
      author: 'samuelkarp',
      openedAt: '2026-08-26T00:00:00Z',
      assignees: [],
    },
  ],
};

/**
 * The advisory with one more state comment on it, written by a member so that
 * it counts. Both surfaces read stored state out of the comments, so a snapshot
 * put here is one stored state that both of them merge for themselves.
 *
 * @param {import('../src/common/parse-detail.js').ParsedDetail} advisory
 * @param {Record<string, unknown>} payload What the snapshot holds beyond its
 *   envelope.
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function withState(advisory, payload) {
  const raw = JSON.stringify({
    betterGhsa: '1.0',
    seq: 99,
    by: 'samuelkarp',
    at: '2026-08-28T10:00:00Z',
    ...payload,
  });
  return {
    ...advisory,
    comments: [
      ...advisory.comments,
      {
        id: '900001',
        elementId: 'advisory-comment-900001',
        author: 'samuelkarp',
        role: 'Member',
        roles: ['Member'],
        trusted: true,
        at: '2026-08-28T10:00:00Z',
        text: 'state',
        stateComment: schema.readSnapshot(raw),
      },
    ],
  };
}

/**
 * One chip as both surfaces can be asked for it.
 *
 * @typedef {object} RenderedChip
 * @property {string} text
 * @property {string | null} tone The Primer state token the chip is colored
 *   with, and null for a dimmed chip.
 */

/**
 * @param {import('../src/common/parse-detail.js').ParsedDetail} advisory
 * @returns {Promise<RenderedChip[]>} the chips the list row carries.
 */
async function listChips(advisory) {
  const source = {
    row: {
      ghsaId: advisory.ghsaId,
      owner: advisory.ref?.owner ?? 'git-utensils',
      repo: advisory.ref?.repo ?? 'Spoon-Knife',
      href: `/git-utensils/Spoon-Knife/security/advisories/${advisory.ghsaId ?? ''}`,
      title: advisory.title,
      state: advisory.state,
      severity: null,
      severityLabel: null,
      severityClass: null,
      openedAt: advisory.reportedAt,
      reporter: advisory.reporter,
    },
    seenAt: OBSERVED,
  };
  // The cache holds what JSON holds, which is the shape the list reads from.
  const entry = {
    record: JSON.parse(JSON.stringify(advisory)),
    observedAt: OBSERVED,
    state: 'triage',
  };
  const row = await table.viewRow(source, entry, AT);
  return table.chipsFor(row).map((spec) => ({ text: spec.text, tone: spec.tone ?? null }));
}

/**
 * @param {import('../src/common/parse-detail.js').ParsedDetail} advisory
 * @returns {Promise<RenderedChip[]>} the chips the detail panel's header
 *   carries, read back off the nodes it built.
 */
async function panelChips(advisory) {
  const view = await tracking.readAdvisory(advisory, merge.mergeSnapshots(advisory.comments));
  const built = panel.buildPanel(BLANK, advisory, derive.derive(advisory), view);
  return Array.from(built.querySelectorAll('.Box-header .Label')).map((node) => {
    const classes = String(node.getAttribute('class') ?? '').split(/\s+/);
    const tone = classes.find((name) => name.startsWith('bghsa-tone-'));
    return {
      text: String(node.textContent ?? '').replace(/\s+/g, ' ').trim(),
      tone: tone === undefined ? null : tone.slice('bghsa-tone-'.length),
    };
  });
}

/** Every text the waiting chip can read. */
const WAITING_TEXTS = order.WAITING_STATES.map(chips.sentenceCase);

/** Every text the patch chip can read. */
const PATCH_TEXTS = [chips.PATCH_IN_REVIEW, chips.NO_PATCH, chips.PATCH_UNKNOWN];

/**
 * @param {RenderedChip[]} rendered
 * @param {readonly string[]} texts The texts this kind of chip can read.
 * @param {string} where Which surface these came from.
 * @returns {RenderedChip} the one chip of that kind. A surface carrying none of
 *   them, or more than one, is the failure this reports.
 */
function oneOf(rendered, texts, where) {
  const found = rendered.filter((chip) => texts.includes(chip.text));
  assert.ok(
    found.length === 1,
    `${where} carries ${found.length} of those chips: ${rendered.map((c) => c.text).join(', ')}`
  );
  return /** @type {RenderedChip} */ (found[0]);
}

/**
 * @param {RenderedChip} chip
 * @returns {string}
 */
function shown(chip) {
  return `${chip.text}[${chip.tone ?? 'dimmed'}]`;
}

/**
 * Four waiting states, each from a fixture and the stored state that produces
 * it. One state would pass on a coincidence: two surfaces that both said
 * `Blocked on us` whatever they read would agree on that row and disagree on
 * every other.
 */
const WAITING_CASES = [
  {
    name: 'a draft nobody has triaged',
    advisory: () => DRAFT,
    expected: 'Blocked on us[danger]',
  },
  {
    name: 'a stored triage value handing the advisory back',
    advisory: () => TRIAGE,
    expected: 'Blocked on the reporter[attention]',
  },
  {
    name: 'a stored triage value keeping the advisory with us',
    advisory: () => withState(TRIAGE, { triage: 'evaluating' }),
    expected: 'Blocked on us[danger]',
  },
  {
    name: 'an advisory no member has touched',
    advisory: () => ({ ...PUBLISHED, state: 'Triage', timeline: [] }),
    expected: 'Never reviewed[danger]',
  },
  {
    name: 'a reporter who spoke after every member action',
    advisory: () => ({
      ...TRIAGE,
      timeline: TRIAGE.timeline.filter((event) => event.actor !== 'samuelkarp'),
    }),
    expected: 'New activity[attention]',
  },
];

for (const one of WAITING_CASES) {
  test(`the list row and the panel agree on the waiting chip: ${one.name}`, async () => {
    const advisory = one.advisory();
    const fromList = oneOf(await listChips(advisory), WAITING_TEXTS, 'the list row');
    const fromPanel = oneOf(await panelChips(advisory), WAITING_TEXTS, 'the panel');
    assert.ok(
      shown(fromList) === one.expected,
      `the list row read ${shown(fromList)}, wanted ${one.expected}`
    );
    assert.ok(
      shown(fromPanel) === shown(fromList),
      `the panel read ${shown(fromPanel)} where the list row read ${shown(fromList)}`
    );
  });
}

/** Two patch states on a draft, from the same fixture with and without a fork. */
const PATCH_CASES = [
  {
    name: 'a draft whose fork holds no pull request',
    advisory: () => DRAFT,
    expected: 'No patch yet[danger]',
  },
  {
    name: 'a draft whose fork holds an open pull request',
    advisory: () => ({ ...DRAFT, fork: OPEN_FORK }),
    expected: 'Patch in review[attention]',
  },
];

for (const one of PATCH_CASES) {
  test(`the list row and the panel agree on the patch chip: ${one.name}`, async () => {
    const advisory = one.advisory();
    assert.ok(advisory.state === 'Draft', `the fixture is in ${advisory.state}`);
    const fromList = oneOf(await listChips(advisory), PATCH_TEXTS, 'the list row');
    const fromPanel = oneOf(await panelChips(advisory), PATCH_TEXTS, 'the panel');
    assert.ok(
      shown(fromList) === one.expected,
      `the list row read ${shown(fromList)}, wanted ${one.expected}`
    );
    assert.ok(
      shown(fromPanel) === shown(fromList),
      `the panel read ${shown(fromPanel)} where the list row read ${shown(fromList)}`
    );
  });
}

test('neither surface carries a patch chip on an advisory in triage', async () => {
  // The triage fixture holds an open pull request, so this is the rule and not
  // an advisory with nothing to say: a patch chip here would read
  // `Patch in review` on both surfaces.
  assert.ok(TRIAGE.state === 'Triage', `the fixture is in ${TRIAGE.state}`);
  assert.ok(
    chips.patchStateOf(derive.derive(TRIAGE).patch) === chips.PATCH_IN_REVIEW,
    'the triage fixture holds no open pull request'
  );
  const fromList = (await listChips(TRIAGE)).filter((chip) => PATCH_TEXTS.includes(chip.text));
  const fromPanel = (await panelChips(TRIAGE)).filter((chip) => PATCH_TEXTS.includes(chip.text));
  assert.ok(fromList.length === 0, `the list row carried ${fromList.map(shown).join(', ')}`);
  assert.ok(fromPanel.length === 0, `the panel carried ${fromPanel.map(shown).join(', ')}`);
});

/**
 * @param {string | null} state
 * @returns {import('../src/common/derive.js').PatchState['pullRequests'][number]}
 */
function pull(state) {
  return { number: 1, url: null, title: 'p', state, baseRef: 'main', headRef: null, author: null, openedAt: null, assignees: [] };
}

/**
 * @param {import('../src/common/derive.js').PatchState['pullRequests']} pullRequests
 * @param {boolean} incomplete
 * @returns {import('../src/common/derive.js').PatchState}
 */
function patchOf(pullRequests, incomplete) {
  return { hasFork: true, pullRequests, branches: [], open: [], unknown: [], incomplete };
}

test('the patch chip reads Unknown over a pull request whose state went unread', () => {
  const unread = chips.patchStateOf(patchOf([pull(null)], true));
  assert.ok(unread === 'Unknown', `a patch state this reader cannot judge: ${unread}`);
});

// The fork's list shows open pull requests only, so a fork listing none reads as
// the patch that is not there.
test('a fork with no open pull request reads as no patch yet', () => {
  assert.strictEqual(chips.patchStateOf(patchOf([], false)), 'No patch yet');
  assert.strictEqual(chips.patchStateOf(patchOf([pull('open')], false)), 'Patch in review');
});

test('one builder draws every chip, and each part of a chip reaches its class', () => {
  // Five surfaces drew a chip of their own before this one. The parts are
  // asserted together because a builder that dropped one of them, as the done
  // view's dropped the tone, still drew a chip that looked like a chip.
  const plain = chips.buildChip(BLANK, { text: 'Never reviewed' });
  assert.strictEqual(plain.getAttribute('class'), 'Label Label--secondary');
  assert.strictEqual(plain.textContent, 'Never reviewed');
  assert.strictEqual(
    chips.buildChip(BLANK, { text: 'x', tone: 'danger' }).getAttribute('class'),
    'Label Label--secondary bghsa-tone-danger'
  );
  assert.strictEqual(
    chips.buildChip(BLANK, { text: 'x', severityClass: 'Label--danger' }).getAttribute('class'),
    'Label Label--danger',
    "GitHub's own color for the severity stands in for the neutral one"
  );
  assert.strictEqual(
    chips.buildChip(BLANK, { text: 'x', severityClass: 'Label--danger', dim: true }).getAttribute(
      'class'
    ),
    `Label Label--danger ${chips.DIM_CLASS}`
  );

  // A filled chip paints its own color, so its text carries the page's
  // background color and takes an element of its own to be given one.
  const filled = chips.buildChip(BLANK, { text: 'Critical', severityClass: 'Label--danger', fill: true });
  assert.strictEqual(filled.getAttribute('class'), `Label Label--danger ${chips.FILL_CLASS}`);
  assert.strictEqual(filled.textContent, 'Critical', 'a filled chip reads what it was given');
  assert.strictEqual(
    filled.querySelector('span')?.textContent,
    'Critical',
    'the text of a filled chip is in an element the fill rule can color'
  );
});
