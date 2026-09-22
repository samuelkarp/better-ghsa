'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');
const derive = require('../src/common/derive.js');

/**
 * @param {string} name
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function advisory(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  const root = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
  const parsed = parse.parseDetail(root);
  if (parsed === null) throw new Error(`${name} is not an advisory detail page`);
  return parsed;
}

test('a Member comment makes the advisory reviewed', () => {
  const state = derive.derive(advisory('triage-thread.html'));
  assert.deepStrictEqual(state.members, ['samuelkarp']);
  assert.strictEqual(state.neverReviewed, false);
});

test('a member action after the last reporter comment clears new activity', () => {
  const state = derive.derive(advisory('triage-thread.html'));
  assert.strictEqual(state.lastNonMemberCommentAt, '2026-08-25T22:17:47Z');
  assert.strictEqual(state.lastMemberActivityAt, '2026-08-25T22:22:42Z');
  assert.strictEqual(state.newActivity, false);
});

test('a reporter comment newer than every member action is new activity', () => {
  const parsed = advisory('triage-thread.html');
  const trimmed = {
    ...parsed,
    timeline: parsed.timeline.filter((event) => event.actor !== 'samuelkarp'),
  };
  const state = derive.derive(trimmed);
  assert.strictEqual(state.lastMemberActivityAt, '2026-08-25T22:17:05Z');
  assert.strictEqual(state.newActivity, true);
});

test('a capture carrying no comment thread has no visible member', () => {
  // Comments and member badges were removed from the containerd capture.
  const state = derive.derive(advisory('published-containerd.html'));
  assert.deepStrictEqual(state.members, []);
  assert.strictEqual(state.newActivity, false);
});

test('the advisory state alone says whether it has been reviewed', () => {
  // The containerd capture omits comments. Clear the timeline to isolate
  // the advisory state as evidence of review.
  const parsed = { ...advisory('published-containerd.html'), timeline: [] };
  assert.deepStrictEqual(derive.derive(parsed).members, []);

  /** @type {[string, boolean][]} */
  const cases = [
    ['Draft', false],
    ['Published', false],
    ['Triage', true],
    ['Closed', true],
  ];
  for (const [state, neverReviewed] of cases) {
    assert.strictEqual(
      derive.derive({ ...parsed, state }).neverReviewed,
      neverReviewed,
      `state ${state}`
    );
  }
});

/**
 * @param {string} name
 * @returns {import('../src/common/parse-detail.js').TimelineEvent[]}
 */
function timeline(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  const root = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
  return parse.parseTimeline(root);
}

/**
 * Create a triage advisory with only untrusted comments.
 *
 * @param {import('../src/common/parse-detail.js').TimelineEvent[]} events
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function unbadged(events) {
  const parsed = advisory('triage-thread.html');
  return {
    ...parsed,
    state: 'Triage',
    comments: parsed.comments.filter((comment) => !comment.trusted),
    timeline: events,
  };
}

const DELETED_FORK = {
  id: 'event-100000200',
  actor: 'thornapple',
  at: '2026-08-24T20:00:00Z',
  text: 'thornapple deleted the temporary private fork example/example-ghsa-xxxx-xxxx-xxxx Aug 24, 2026',
};

test('an event only a maintainer can cause reviews the advisory', () => {
  // Deleting the private fork requires a maintainer, even without a member badge.
  const parsed = unbadged([...timeline('invented-close-timeline.html'), DELETED_FORK]);
  const state = derive.derive(parsed);
  assert.deepStrictEqual(state.members, []);
  assert.strictEqual(state.neverReviewed, false);
  assert.strictEqual(state.lastMemberActivityAt, '2026-08-24T20:00:00Z');
});

test('the acts a reporter can make leave the advisory never reviewed', () => {
  // Accepting credit and adding oneself as a collaborator are reporter actions.
  const parsed = unbadged(timeline('invented-close-timeline.html'));
  const kept = parsed.timeline.filter((event) => !/\bclosed this\b/.test(event.text));
  for (const phrase of ['accepted credit', 'added themselves as a collaborator']) {
    assert.ok(
      kept.some((event) => event.text.includes(phrase)),
      `the fixture carries no event reading ${phrase}`
    );
  }
  for (const event of kept) {
    assert.strictEqual(derive.maintainerOnlyEvent(event), false, event.text);
  }

  const state = derive.derive({ ...parsed, timeline: kept });
  assert.strictEqual(state.neverReviewed, true);
  assert.strictEqual(state.lastMemberActivityAt, null);
});

test('a title carrying a maintainer act is not read as one', () => {
  // Title-change events include reporter-controlled text after the event phrase.
  const parsed = unbadged(timeline('invented-title-timeline.html'));
  assert.strictEqual(parsed.timeline.length, 8);
  assert.match(parsed.timeline[0]?.text ?? '', /accepted this report/);
  assert.match(parsed.timeline[0]?.text ?? '', /closed this/);
  assert.match(parsed.timeline[1]?.text ?? '', /deleted the temporary private fork/);
  const state = derive.derive(parsed);
  assert.strictEqual(state.neverReviewed, true);
  assert.strictEqual(state.lastMemberActivityAt, null);
});

test('a title reading like a CVE request does not request a CVE', () => {
  const parsed = unbadged(timeline('invented-title-timeline.html'));
  const titles = parsed.timeline.filter((entry) => /requested a CVE/.test(entry.text));
  assert.strictEqual(titles.length, 2, 'two title changes carry the wording');
  const cve = derive.cveState(parsed);
  assert.strictEqual(cve.requested, false);
  assert.strictEqual(cve.state, 'none');
});

test('a CVE request a maintainer made is read as one', () => {
  const parsed = unbadged([
    {
      id: 'event-100000300',
      actor: 'thornapple',
      at: '2026-08-24T20:00:00Z',
      text: 'thornapple requested a CVE Aug 24, 2026',
    },
  ]);
  const cve = derive.cveState(parsed);
  assert.strictEqual(cve.requested, true);
  assert.strictEqual(cve.state, 'requested');
});

test('an event this reader does not know cannot carry a phrase into a match', () => {
  // Anchoring the phrase also rejects matches inside unknown event types.
  const unknown = {
    id: null,
    actor: null,
    at: '2026-08-24T20:00:00Z',
    text: 'nettleweed referenced this from requested a CVE Aug 24, 2026',
  };
  assert.strictEqual(derive.eventIs(unknown, derive.CVE_REQUEST_EVENT), false);
  assert.strictEqual(derive.maintainerOnlyEvent(unknown), false);
  assert.strictEqual(derive.cveState(unbadged([unknown])).requested, false);
});

test('each timeline phrase is placed on the side REQUIREMENTS.md puts it', () => {
  /** @type {[string, boolean][]} */
  const cases = [
    ['thornapple accepted this report Aug 24, 2026', true],
    ['thornapple added nettleweed as a collaborator Aug 24, 2026', true],
    ['thornapple added example/committers as a collaborator Aug 24, 2026', true],
    ['thornapple requested a CVE Aug 24, 2026', true],
    ['thornapple published this Aug 24, 2026', true],
    ['thornapple closed this Aug 24, 2026', true],
    ['thornapple deleted the temporary private fork example/example-ghsa-x Aug 24, 2026', true],
    ['nettleweed was credited as a reporter Aug 24, 2026', false],
    ['nettleweed accepted credit Aug 24, 2026', false],
    ['nettleweed added themselves as a collaborator Aug 24, 2026', false],
    ['nettleweed changed the title old new Aug 24, 2026', false],
    ['nettleweed created the temporary private fork example/example-ghsa-x Aug 24, 2026', false],
    ['GitHub released this Aug 24, 2026', false],
    ['gh-advisory-staff assigned CVE-2026-31984 Aug 24, 2026', false],
  ];
  for (const [text, maintainerOnly] of cases) {
    assert.strictEqual(
      derive.maintainerOnlyEvent({ id: null, actor: null, at: null, text }),
      maintainerOnly,
      text
    );
  }
});

test('a maintainer act named in the middle of an event is not read', () => {
  // The final four cases represent unknown event types with embedded
  // maintainer-action phrases.
  const texts = [
    'nettleweed changed the title x accepted this report Aug 24, 2026',
    'nettleweed changed the title x published this Aug 24, 2026',
    'nettleweed changed the title x added nettleweed as a collaborator Aug 24, 2026',
    'nettleweed created the temporary private fork closed this Aug 24, 2026',
    'nettleweed changed the description closed this Aug 24, 2026',
    'nettleweed marked this as a duplicate of accepted this report Aug 24, 2026',
    'nettleweed renamed the branch requested a CVE Aug 24, 2026',
    'nettleweed edited a comment published this Aug 24, 2026',
  ];
  for (const text of texts) {
    assert.strictEqual(
      derive.maintainerOnlyEvent({ id: null, actor: null, at: null, text }),
      false,
      text
    );
  }
});

test('a CVE named on the advisory reads as assigned', () => {
  const state = derive.derive(advisory('published-containerd.html'));
  assert.deepStrictEqual(state.cve, {
    id: 'CVE-2026-31984',
    assigned: true,
    requested: true,
    selection: 'existing',
    state: 'assigned',
  });
});

test('an advisory that has never asked for a CVE reads as none', () => {
  const state = derive.derive(advisory('triage-thread.html'));
  assert.deepStrictEqual(state.cve, {
    id: null,
    assigned: false,
    requested: false,
    selection: 'requesting',
    state: 'none',
  });
});

test('a fork with one pull request per branch reports both branches prepared', () => {
  const state = derive.derive(advisory('triage-thread.html'));
  assert.strictEqual(state.patch.hasFork, true);
  assert.deepStrictEqual(state.patch.open, [2, 1]);
  assert.deepStrictEqual(state.patch.unknown, []);
  assert.strictEqual(state.patch.incomplete, false);
  assert.deepStrictEqual(state.patch.branches, [
    { branch: 'release/1.0', pullRequests: [2], open: true },
    { branch: 'main', pullRequests: [1], open: true },
  ]);
});

test('a fork row whose state went unread marks the patch state incomplete', () => {
  const parsed = advisory('triage-thread.html');
  const fork = parsed.fork;
  if (fork === null) throw new Error('triage-thread.html has no private fork');
  const unread = {
    ...parsed,
    fork: {
      ...fork,
      pullRequests: [
        { ...(fork.pullRequests[0] ?? {}), number: 2, baseRef: 'release/1.0', state: null },
        { ...(fork.pullRequests[1] ?? {}), number: 1, baseRef: 'main', state: 'open' },
      ],
    },
  };
  const state = derive.derive(/** @type {typeof parsed} */ (unread));
  assert.strictEqual(state.patch.incomplete, true);
  assert.deepStrictEqual(state.patch.unknown, [2]);
  assert.deepStrictEqual(state.patch.open, [1]);
  assert.deepStrictEqual(state.patch.branches, [
    { branch: 'release/1.0', pullRequests: [2], open: false },
    { branch: 'main', pullRequests: [1], open: true },
  ]);
});

test('an advisory with no private fork has no patch prepared', () => {
  const state = derive.derive(advisory('draft.html'));
  assert.strictEqual(state.patch.hasFork, false);
  assert.deepStrictEqual(state.patch.branches, []);
  assert.deepStrictEqual(state.patch.pullRequests, []);
});

const NOW = Date.parse('2026-08-26T12:00:00Z');

test('an embargo is overdue where its lift moment has passed and nothing published it', () => {
  const triage = advisory('triage-thread.html');
  assert.strictEqual(triage.state, 'Triage');
  const published = advisory('published-containerd.html');
  assert.strictEqual(published.state, 'Published');
  const unread = { ...triage, state: null };

  /** @type {[string, typeof triage, string | null, boolean][]} */
  const cases = [
    ['a lift date already gone by', triage, '2026-08-01', true],
    ['a lift date later today', triage, '2026-08-26', false],
    ['a lift date next month', triage, '2026-09-30', false],
    ['a lift time earlier today', triage, '2026-08-26T11:00:00Z', true],
    ['a lift time later today', triage, '2026-08-26T13:00:00Z', false],
    ['a lift date gone by on a published advisory', published, '2026-08-01', false],
    ['a lift date gone by on an advisory whose state went unread', unread, '2026-08-01', true],
    ['a lift date that is not a date', triage, 'when the harvest is in', false],
    ['no lift date at all', triage, null, false],
  ];
  for (const [name, parsed, lift, overdue] of cases) {
    assert.strictEqual(derive.embargoOverdue(parsed, lift, NOW), overdue, name);
  }
});
