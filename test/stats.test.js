'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parseDetail = require('../src/common/parse-detail.js');
const schema = require('../src/common/schema.js');
const preserve = require('../src/detail/preserve.js');
const derive = require('../src/common/derive.js');
const stats = require('../src/done/stats.js');

/**
 * @param {string} name
 * @returns {import('../src/common/parse-detail.js').ParsedDetail} the advisory
 *   that fixture holds.
 */
function fixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  const doc = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
  const advisory = parseDetail.parseDetail(doc);
  if (advisory === null) throw new Error(`${name} did not read as an advisory`);
  return advisory;
}

/**
 * @param {string} name
 * @returns {import('../src/common/parse-detail.js').TimelineEvent[]} The timeline parsed from the fixture region.
 */
function timelineFixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  const doc = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
  return parseDetail.parseTimeline(doc);
}

/**
 * @param {Partial<import('../src/common/parse-detail.js').ParsedDetail>} fields
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function advisory(fields) {
  return {
    ref: null,
    viewer: null,
    ghsaId: null,
    state: null,
    severity: null,
    severityLabel: null,
    severityClass: null,
    reportedAt: null,
    reporter: null,
    title: null,
    description: null,
    severityField: null,
    severityFieldPresent: false,
    cvssV3: null,
    cvssV3Present: false,
    cveId: null,
    cveSelection: null,
    descriptionOriginal: null,
    descriptionRevision: null,
    comments: [],
    timeline: [],
    fork: null,
    collaborators: [],
    ...fields,
  };
}

/**
 * @param {{
 *   author: string,
 *   role: string,
 *   at: string | null,
 *   text?: string,
 *   state?: Record<string, unknown>,
 * }} fields
 * @returns {import('../src/common/parse-detail.js').ParsedComment}
 */
function comment(fields) {
  const raw = fields.state === undefined ? null : JSON.stringify(fields.state);
  return {
    id: '1',
    elementId: 'advisory-comment-1',
    author: fields.author,
    role: fields.role,
    roles: [fields.role],
    trusted: fields.role === 'Member' || fields.role === 'Owner',
    at: fields.at,
    text: fields.text ?? 'text',
    stateComment: raw === null ? null : schema.readSnapshot(raw),
  };
}

/**
 * @param {{ at: string | null, text: string }} fields
 * @returns {import('../src/common/parse-detail.js').TimelineEvent}
 */
function event(fields) {
  return { id: 'event-1', actor: 'samuelkarp', at: fields.at, text: fields.text };
}

/**
 * @param {{
 *   ghsaId: string,
 *   state: string,
 *   severity?: string | null,
 *   openedAt?: string | null,
 *   advisory?: import('../src/common/parse-detail.js').ParsedDetail | null,
 * }} fields
 * @returns {import('../src/done/corpus.js').CorpusMember}
 */
function member(fields) {
  return {
    ghsaId: fields.ghsaId,
    state: fields.state,
    seenAt: 0,
    advisory: fields.advisory ?? null,
    observedAt: fields.advisory === undefined || fields.advisory === null ? null : 1,
    row: {
      ghsaId: fields.ghsaId,
      owner: 'containerd',
      repo: 'containerd',
      href: null,
      title: null,
      state: fields.state,
      severity: fields.severity ?? null,
      severityLabel: null,
      severityClass: null,
      openedAt: fields.openedAt ?? null,
      reporter: null,
    },
  };
}

/**
 * @param {readonly import('../src/done/corpus.js').CorpusMember[]} members
 * @param {{ complete?: boolean, running?: boolean, expected?: Record<string, number | null> }} [over]
 * @returns {import('../src/done/corpus.js').Corpus}
 */
function corpusOf(members, over = {}) {
  return {
    members: [...members],
    unread: members.filter((entry) => entry.advisory === null).map((entry) => entry.ghsaId),
    complete: over.complete ?? true,
    running: over.running ?? false,
    expected: over.expected ?? { published: null, closed: null },
  };
}

/** The instant the summaries are taken at. */
const NOW = Date.parse('2026-08-27T12:00:00Z');

const CLOSED_AS = /** @param {string} reason */ (reason) => ({
  betterGhsa: '1.0',
  seq: 1,
  by: 'samuelkarp',
  at: '2026-04-01T00:00:00Z',
  closure: { reason },
});

test("a member's state comment is not an answer to the reporter", () => {
  const draft = fixture('draft.html');
  assert.strictEqual(draft.comments.length, 1);
  assert.strictEqual(draft.comments[0]?.role, 'Member');
  assert.notStrictEqual(draft.comments[0]?.stateComment, null);
  assert.strictEqual(stats.firstResponseAt(draft), null);
  assert.strictEqual(stats.durationOf(draft, stats.firstResponseAt), null);
});

test('a preserved original report is not an answer to the reporter', () => {
  // Preservation comments copy the reporter's text. They do not count as member responses.
  const preserved = comment({
    author: 'samuelkarp',
    role: 'Member',
    at: '2026-08-25T22:05:00Z',
    text: `Original report preserved by better-ghsa ${preserve.MARKER_PREFIX}0011223344556677`,
  });
  assert.strictEqual(preserved.stateComment, null, 'the copy is not a state comment');

  const answered = advisory({
    reportedAt: '2026-08-25T22:00:00Z',
    comments: [preserved, comment({ author: 'samuelkarp', role: 'Member', at: '2026-08-25T23:00:00Z' })],
  });
  assert.strictEqual(stats.durationOf(answered, stats.firstResponseAt), 60 * 60 * 1000);

  const alone = advisory({ reportedAt: '2026-08-25T22:00:00Z', comments: [preserved] });
  assert.strictEqual(stats.firstResponseAt(alone), null);
});

test('a comment from someone who is not an org member is not a first response', () => {
  const held = advisory({
    reportedAt: '2026-08-25T22:15:18Z',
    comments: [
      comment({ author: 'prakleumas', role: 'Author', at: '2026-08-25T22:20:00Z' }),
      comment({ author: 'passerby', role: 'Contributor', at: '2026-08-25T22:30:00Z' }),
    ],
  });
  assert.strictEqual(stats.firstResponseAt(held), null);
  assert.strictEqual(stats.durationOf(held, stats.firstResponseAt), null);
});

test('the first response is the earliest qualifying comment, not the first found', () => {
  const held = advisory({
    reportedAt: '2026-08-25T22:00:00Z',
    comments: [
      comment({ author: 'samuelkarp', role: 'Member', at: '2026-08-25T23:00:00Z' }),
      comment({ author: 'HidekiMorita', role: 'Owner', at: '2026-08-25T22:30:00Z' }),
    ],
  });
  assert.strictEqual(stats.durationOf(held, stats.firstResponseAt), 30 * 60 * 1000);
});

test('a maintainer action with no comment is a first response', () => {
  const held = advisory({
    reportedAt: '2026-08-25T22:00:00Z',
    timeline: [
      // A reporter can add themselves; only a maintainer's action counts.
      event({ at: '2026-08-25T22:30:00Z', text: 'prakleumas added themselves as a collaborator' }),
      event({ at: '2026-08-26T00:00:00Z', text: 'samuelkarp requested a CVE' }),
    ],
  });
  assert.deepStrictEqual(held.comments, []);
  assert.strictEqual(stats.firstResponseAt(held), Date.parse('2026-08-26T00:00:00Z'));
  assert.strictEqual(stats.durationOf(held, stats.firstResponseAt), 2 * 60 * 60 * 1000);
});

test('the first response is the earlier of a member comment and a maintainer action', () => {
  const commentFirst = advisory({
    reportedAt: '2026-08-25T22:00:00Z',
    comments: [comment({ author: 'samuelkarp', role: 'Member', at: '2026-08-25T22:30:00Z' })],
    timeline: [event({ at: '2026-08-26T00:00:00Z', text: 'samuelkarp accepted this report' })],
  });
  assert.strictEqual(stats.durationOf(commentFirst, stats.firstResponseAt), 30 * 60 * 1000);

  const actionFirst = advisory({
    reportedAt: '2026-08-25T22:00:00Z',
    comments: [comment({ author: 'samuelkarp', role: 'Member', at: '2026-08-26T01:00:00Z' })],
    timeline: [event({ at: '2026-08-25T22:45:00Z', text: 'samuelkarp closed this' })],
  });
  assert.strictEqual(stats.durationOf(actionFirst, stats.firstResponseAt), 45 * 60 * 1000);
});

test('a reporter accepting credit is not the advisory entering draft', () => {
  const published = fixture('published-containerd.html');
  const credit = published.timeline.find((entry) => /accepted credit/.test(entry.text));
  assert.ok(credit !== undefined, 'the fixture carries a credit acceptance');
  assert.strictEqual(credit?.at, '2026-04-07T18:06:41Z');
  assert.ok(
    Date.parse(/** @type {string} */ (credit?.at)) < Date.parse('2026-04-07T19:02:26Z'),
    'and it comes first, so a looser match would read it as the draft'
  );
  assert.strictEqual(stats.draftAt(advisory({ timeline: [credit] })), null);
});

test('an event the page stamps before the report yields no duration', () => {
  const held = advisory({
    reportedAt: '2026-08-25T22:00:00Z',
    timeline: [event({ at: '2026-08-25T21:00:00Z', text: 'samuelkarp accepted this report' })],
  });
  assert.strictEqual(stats.draftAt(held), Date.parse('2026-08-25T21:00:00Z'));
  assert.strictEqual(stats.durationOf(held, stats.draftAt), null);
});

test('an advisory whose report time went unread yields no duration', () => {
  const held = advisory({
    reportedAt: null,
    timeline: [event({ at: '2026-08-25T22:00:00Z', text: 'samuelkarp accepted this report' })],
  });
  assert.strictEqual(stats.durationOf(held, stats.draftAt), null);
});

test('an advisory closed twice is measured to the close that first resolved it', () => {
  const held = advisory({
    reportedAt: '2026-08-24T16:19:16Z',
    timeline: [
      event({ at: '2026-08-26T19:21:00Z', text: 'brackenhollow closed this Aug 26, 2026' }),
      event({ at: '2026-08-24T19:21:00Z', text: 'brackenhollow closed this Aug 24, 2026' }),
    ],
  });
  assert.strictEqual(stats.closeAt(held), Date.parse('2026-08-24T19:21:00Z'));
  assert.strictEqual(stats.durationOf(held, stats.closeAt), 10904 * 1000);
});

test('the last close and the last publication are read beside the first', () => {
  const closed = advisory({
    reportedAt: '2026-08-24T16:19:16Z',
    timeline: [
      event({ at: '2026-08-26T19:21:00Z', text: 'brackenhollow closed this Aug 26, 2026' }),
      event({ at: '2026-08-24T19:21:00Z', text: 'brackenhollow closed this Aug 24, 2026' }),
    ],
  });
  assert.strictEqual(stats.lastCloseAt(closed), Date.parse('2026-08-26T19:21:00Z'));
  assert.strictEqual(stats.closeAt(closed), Date.parse('2026-08-24T19:21:00Z'));
  assert.strictEqual(stats.lastPublishAt(closed), null, 'and nothing published it');

  const published = advisory({
    reportedAt: '2026-08-24T16:19:16Z',
    timeline: [
      event({ at: '2026-08-25T19:21:00Z', text: 'brackenhollow published this advisory' }),
      event({ at: '2026-08-27T19:21:00Z', text: 'brackenhollow published this advisory' }),
    ],
  });
  assert.strictEqual(stats.lastPublishAt(published), Date.parse('2026-08-27T19:21:00Z'));
  assert.strictEqual(stats.publishAt(published), Date.parse('2026-08-25T19:21:00Z'));
  assert.strictEqual(stats.lastCloseAt(published), null, 'and nothing closed it');
});

test('a title carrying a maintainer act sets no timing', () => {
  // Title-change events contain reporter-controlled text, including event phrases.
  const timeline = timelineFixture('invented-title-timeline.html');
  const forged = timeline.filter((entry) => /changed the title/.test(entry.text));
  assert.strictEqual(forged.length, 7, 'the fixture holds seven title changes');
  for (const phrase of ['accepted this report', 'closed this', 'published this']) {
    assert.ok(
      forged.some((entry) => new RegExp(phrase).test(entry.text)),
      `a title reads ${phrase}`
    );
  }

  const held = advisory({ reportedAt: '2026-08-24T16:00:00Z', timeline: forged });
  assert.strictEqual(stats.draftAt(held), null);
  assert.strictEqual(stats.closeAt(held), null);
  assert.strictEqual(stats.publishAt(held), null);
  assert.strictEqual(stats.durationOf(held, stats.draftAt), null);
  assert.strictEqual(stats.durationOf(held, stats.closeAt), null);
  assert.strictEqual(stats.durationOf(held, stats.publishAt), null);
});

test('an event this reader does not know sets no timing', () => {
  // Anchoring the phrase rejects matches inside unknown event types.
  const held = advisory({
    reportedAt: '2026-08-24T16:00:00Z',
    timeline: [
      event({ at: '2026-08-24T17:00:00Z', text: 'nettleweed referenced this from accepted this report' }),
      event({ at: '2026-08-24T18:00:00Z', text: 'nettleweed referenced this from closed this' }),
      event({ at: '2026-08-24T19:00:00Z', text: 'nettleweed referenced this from published this' }),
    ],
  });
  assert.strictEqual(stats.draftAt(held), null);
  assert.strictEqual(stats.closeAt(held), null);
  assert.strictEqual(stats.publishAt(held), null);
});

test('GitHub releasing an advisory is not a maintainer publishing it', () => {
  const published = fixture('published-containerd.html');
  const released = published.timeline.find((entry) => /released this/.test(entry.text));
  assert.ok(released !== undefined, 'the fixture carries a release');
  assert.strictEqual(released?.at, '2026-08-04T18:26:14Z');
  assert.strictEqual(stats.publishAt(advisory({ timeline: [released] })), null);
  assert.strictEqual(
    published.timeline.filter((entry) => derive.eventIs(entry, stats.PUBLISH_EVENT)).length,
    1,
    'one event on the timeline reads as the publication, and no other'
  );
});

test('closing and publishing are two different endings', () => {
  const published = fixture('published-containerd.html');
  assert.strictEqual(stats.closeAt(published), null, 'nothing closed the published advisory');
  assert.strictEqual(stats.publishAt(published), Date.parse('2026-08-03T22:11:52Z'));

  const closed = advisory({
    reportedAt: '2026-08-24T16:19:16Z',
    timeline: timelineFixture('invented-close-timeline.html'),
  });
  assert.strictEqual(stats.closeAt(closed), Date.parse('2026-08-24T19:21:00Z'));
  assert.strictEqual(stats.publishAt(closed), null, 'and nothing published the closed one');
});

/** @typedef {import('../src/common/parse-detail.js').ParsedDetail} Advisory */

test('each timing measures from the report time to the event that ends it', () => {
  const triage = fixture('triage-thread.html');
  assert.strictEqual(triage.reportedAt, '2026-08-25T22:15:18Z');
  const published = fixture('published-containerd.html');
  assert.strictEqual(published.reportedAt, '2026-04-07T18:05:12Z');
  const closed = advisory({
    reportedAt: '2026-08-24T16:19:16Z',
    timeline: timelineFixture('invented-close-timeline.html'),
  });

  /** @type {[string, Advisory, (held: Advisory) => number | null, string, number][]} */
  const cases = [
    ['first response', triage, stats.firstResponseAt, '2026-08-25T22:16:30Z', 72 * 1000],
    ['accept', published, stats.draftAt, '2026-04-07T19:02:26Z', 3434 * 1000],
    ['close', closed, stats.closeAt, '2026-08-24T19:21:00Z', 10904 * 1000],
    ['publish', published, stats.publishAt, '2026-08-03T22:11:52Z', 10210000 * 1000],
  ];
  for (const [name, held, at, eventAt, duration] of cases) {
    assert.strictEqual(at(held), Date.parse(eventAt), `${name}: the event`);
    assert.strictEqual(stats.durationOf(held, at), duration, `${name}: the duration`);
  }
});

test('the four timings are named for what each measures', () => {
  assert.deepStrictEqual(
    stats.TIMINGS.map((entry) => [entry.key, entry.name, entry.omission]),
    [
      ['firstResponse', 'Time to first response', 'No response'],
      ['accept', 'Time to accept', 'Never accepted'],
      ['close', 'Time to close', undefined],
      ['publish', 'Time to publish', 'Never published'],
    ]
  );
});

/**
 * Closed advisory captures contain private data and stay outside the repository.
 * BGHSA_CLOSED_ADVISORY_CAPTURE selects the local capture; see docs/testing.md.
 * The test skips when the variable is unset and fails for an invalid path or page.
 */
const CAPTURE_VAR = 'BGHSA_CLOSED_ADVISORY_CAPTURE';
const CAPTURE_SET = Object.prototype.hasOwnProperty.call(process.env, CAPTURE_VAR);
const CAPTURE = process.env[CAPTURE_VAR] ?? '';

test(
  'the close reads the same on a real closed advisory',
  {
    skip: CAPTURE_SET
      ? false
      : `set ${CAPTURE_VAR} to a capture of a closed advisory to run this`,
  },
  () => {
    assert.ok(
      fs.existsSync(CAPTURE),
      `${CAPTURE_VAR} names no file: ${JSON.stringify(CAPTURE)}`
    );
    const html = fs.readFileSync(CAPTURE, 'utf8');
    const doc = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
    const held = parseDetail.parseDetail(doc);
    assert.ok(held !== null, `${CAPTURE_VAR} names a file that does not read as an advisory`);
    assert.strictEqual(
      held.timeline.filter((entry) => derive.eventIs(entry, stats.CLOSE_EVENT)).length,
      1,
      'one event on the real timeline reads as the close, and no other'
    );
    assert.strictEqual(held.reportedAt, '2026-08-24T16:19:16Z');
    assert.strictEqual(stats.closeAt(held), Date.parse('2026-08-24T19:21:00Z'));
    assert.strictEqual(stats.durationOf(held, stats.closeAt), 10904 * 1000);
  }
);

test('time from report to close is a timing, and nothing is left uncomputed', async () => {
  const timeline = timelineFixture('invented-close-timeline.html');
  const summary = await stats.summarize(
    corpusOf([
      member({
        ghsaId: 'GHSA-aaaa-aaaa-aaaa',
        state: 'closed',
        advisory: advisory({ state: 'Closed', reportedAt: '2026-08-24T16:19:16Z', timeline }),
      }),
      member({
        ghsaId: 'GHSA-bbbb-bbbb-bbbb',
        state: 'closed',
        advisory: advisory({ state: 'Closed', reportedAt: '2026-08-24T16:19:16Z' }),
      }),
    ]),
    NOW
  );
  assert.deepStrictEqual(Object.keys(summary.timings).sort(), [
    'accept',
    'close',
    'firstResponse',
    'publish',
  ]);
  assert.deepStrictEqual(summary.timings.close?.values, [10904 * 1000]);
  assert.strictEqual(
    summary.timings.close?.counted,
    1,
    'the advisory with no close event contributes nothing, and not a zero'
  );
  assert.strictEqual(
    summary.timings.publish?.counted,
    0,
    'and neither of the two closed advisories was published'
  );
  assert.deepStrictEqual(summary.uncomputed, {});
  assert.deepStrictEqual(
    stats.TIMINGS.map((entry) => entry.key),
    Object.keys(summary.timings)
  );
});

test('an advisory the event is not observable on contributes to no timing', async () => {
  const answered = advisory({
    reportedAt: '2026-04-01T00:00:00Z',
    comments: [comment({ author: 'samuelkarp', role: 'Member', at: '2026-04-01T01:00:00Z' })],
    timeline: [event({ at: '2026-04-01T02:00:00Z', text: 'samuelkarp accepted this report' })],
  });
  const silent = advisory({ reportedAt: '2026-04-02T00:00:00Z' });
  const summary = await stats.summarize(
    corpusOf([
      member({ ghsaId: 'GHSA-aaaa-aaaa-aaaa', state: 'published', advisory: answered }),
      member({ ghsaId: 'GHSA-bbbb-bbbb-bbbb', state: 'closed', advisory: silent }),
      member({ ghsaId: 'GHSA-cccc-cccc-cccc', state: 'closed' }),
    ]),
    NOW
  );

  const first = summary.timings.firstResponse;
  assert.deepStrictEqual(first?.values, [60 * 60 * 1000]);
  assert.strictEqual(first?.counted, 1);
  assert.strictEqual(first?.corpus, 3);
  assert.strictEqual(first?.unread, 1);
  assert.strictEqual(first?.mean, 60 * 60 * 1000, 'the mean is over what was measured');
  assert.ok(!(first?.values ?? []).includes(0), 'nothing landed as a zero');

  const draft = summary.timings.accept;
  assert.deepStrictEqual(draft?.values, [2 * 60 * 60 * 1000]);
});

test('the first response counts read advisories and holds the longest open wait', async () => {
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const before = /** @param {number} ms */ (ms) => new Date(NOW - ms).toISOString();
  const summary = await stats.summarize(
    corpusOf([
      member({
        ghsaId: 'GHSA-aaaa-aaaa-aaaa',
        state: 'triage',
        advisory: advisory({ state: 'Triage', reportedAt: before(45 * DAY_MS + 3 * HOUR_MS) }),
      }),
      member({
        ghsaId: 'GHSA-bbbb-bbbb-bbbb',
        state: 'draft',
        advisory: advisory({ state: 'Draft', reportedAt: before(10 * DAY_MS) }),
      }),
      // Unanswered and waiting longest, but closed.
      member({
        ghsaId: 'GHSA-cccc-cccc-cccc',
        state: 'closed',
        advisory: advisory({ state: 'Closed', reportedAt: before(90 * DAY_MS) }),
      }),
      member({
        ghsaId: 'GHSA-dddd-dddd-dddd',
        state: 'published',
        advisory: advisory({
          state: 'Published',
          reportedAt: '2026-04-01T00:00:00Z',
          comments: [comment({ author: 'samuelkarp', role: 'Member', at: '2026-04-01T01:00:00Z' })],
        }),
      }),
      member({
        ghsaId: 'GHSA-eeee-eeee-eeee',
        state: 'triage',
        advisory: advisory({
          state: 'Triage',
          reportedAt: '2026-04-01T00:00:00Z',
          timeline: [
            event({ at: '2026-04-01T02:00:00Z', text: 'samuelkarp added nettleweed as a collaborator' }),
          ],
        }),
      }),
      // Read, and without a report time to measure anything from.
      member({
        ghsaId: 'GHSA-ffff-ffff-ffff',
        state: 'triage',
        advisory: advisory({ state: 'Triage' }),
      }),
      member({ ghsaId: 'GHSA-gggg-gggg-gggg', state: 'triage' }),
    ]),
    NOW
  );

  const first = summary.timings.firstResponse;
  assert.deepStrictEqual(first.values, [HOUR_MS, 2 * HOUR_MS], 'over the answered advisories');
  assert.strictEqual(first.read, 6, 'every advisory but the unread one');
  assert.strictEqual(first.corpus, 7);
  assert.strictEqual(first.waiting, 45 * DAY_MS + 3 * HOUR_MS, 'the triage advisory, to now');
});

test('an open advisory reported after now has no wait', async () => {
  const summary = await stats.summarize(
    corpusOf([
      member({
        ghsaId: 'GHSA-aaaa-aaaa-aaaa',
        state: 'triage',
        advisory: advisory({ state: 'Triage', reportedAt: new Date(NOW + 1000).toISOString() }),
      }),
    ]),
    NOW
  );
  assert.strictEqual(summary.timings.firstResponse.waiting, null);
});

test('a timing reports the spread of what it measured', () => {
  const over = { corpus: 4, unread: 0 };
  const held = stats.timing([300, 100, null, 200], over);
  assert.deepStrictEqual(held.values, [100, 200, 300]);
  assert.strictEqual(held.counted, 3);
  assert.strictEqual(held.min, 100);
  assert.strictEqual(held.median, 200);
  assert.strictEqual(held.max, 300);
  assert.strictEqual(held.mean, 200);

  const even = stats.timing([10, 20, 30, 40], over);
  assert.strictEqual(even.median, 25, 'an even count takes the middle pair');

  const none = stats.timing([null, null, null, null], over);
  assert.deepStrictEqual(none.values, []);
  assert.strictEqual(none.counted, 0);
  assert.strictEqual(none.min, null);
  assert.strictEqual(none.median, null);
  assert.strictEqual(none.mean, null);
  assert.strictEqual(none.max, null);
});

test('the corpus is counted by outcome, closure reason, severity, and month', async () => {
  const summary = await stats.summarize(
    corpusOf([
      member({
        ghsaId: 'GHSA-aaaa-aaaa-aaaa',
        state: 'closed',
        advisory: advisory({
          state: 'Closed',
          severity: 'high',
          reportedAt: '2026-03-02T00:00:00Z',
          comments: [
            comment({
              author: 'samuelkarp',
              role: 'Member',
              at: '2026-03-03T00:00:00Z',
              state: CLOSED_AS('not a vulnerability'),
            }),
          ],
        }),
      }),
      member({
        ghsaId: 'GHSA-bbbb-bbbb-bbbb',
        state: 'closed',
        advisory: advisory({
          state: 'Closed',
          severity: 'low',
          reportedAt: '2026-03-20T00:00:00Z',
          comments: [
            comment({
              author: 'samuelkarp',
              role: 'Member',
              at: '2026-03-21T00:00:00Z',
              state: CLOSED_AS('not a vulnerability'),
            }),
          ],
        }),
      }),
      member({
        ghsaId: 'GHSA-cccc-cccc-cccc',
        state: 'published',
        advisory: advisory({
          state: 'Published',
          severity: 'high',
          reportedAt: '2026-04-01T00:00:00Z',
        }),
      }),
      member({
        ghsaId: 'GHSA-dddd-dddd-dddd',
        state: 'published',
        severity: 'moderate',
        openedAt: '2026-04-15T00:00:00Z',
      }),
    ]),
    NOW
  );

  assert.strictEqual(summary.corpus, 4);
  assert.strictEqual(summary.unread, 1);

  assert.deepStrictEqual(
    { ...summary.counts.severity?.counts },
    { high: 1, moderate: 1 },
    'the severities of the published advisories, and none of the closed'
  );
  assert.strictEqual(
    summary.counts.severity?.counted,
    2,
    'the list page names the severity of an advisory no read backs'
  );

  assert.deepStrictEqual({ ...summary.counts.month?.counts }, { '2026-03': 2, '2026-04': 2 });

  assert.deepStrictEqual({ ...summary.counts.outcome?.counts }, { closed: 2, published: 2 });
  assert.strictEqual(
    summary.counts.outcome?.counted,
    4,
    'the list page names a publication, so the published advisory nobody read still ended'
  );

  assert.deepStrictEqual({ ...summary.counts.reason?.counts }, { 'not a vulnerability': 2 });
  assert.strictEqual(summary.counts.reason?.corpus, 2, 'only closed advisories have a reason');
  assert.strictEqual(summary.counts.reason?.missing, 0);
  assert.strictEqual(summary.counts.reason?.ratios['not a vulnerability'], 1);
});

test('outcomes count every ending, and reasons every read closure', async () => {
  const summary = await stats.summarize(
    corpusOf([
      member({ ghsaId: 'GHSA-aaaa-aaaa-aaaa', state: 'triage' }),
      member({ ghsaId: 'GHSA-bbbb-bbbb-bbbb', state: 'draft' }),
      member({ ghsaId: 'GHSA-cccc-cccc-cccc', state: 'published' }),
      member({ ghsaId: 'GHSA-ffff-ffff-ffff', state: 'closed' }),
      member({
        ghsaId: 'GHSA-dddd-dddd-dddd',
        state: 'closed',
        advisory: advisory({
          state: 'Closed',
          comments: [
            comment({
              author: 'samuelkarp',
              role: 'Member',
              at: '2026-03-03T00:00:00Z',
              state: CLOSED_AS('duplicate'),
            }),
          ],
        }),
      }),
      member({
        ghsaId: 'GHSA-eeee-eeee-eeee',
        state: 'closed',
        advisory: advisory({ state: 'Closed' }),
      }),
    ]),
    NOW
  );

  assert.strictEqual(summary.corpus, 6, 'the corpus is every advisory the crawl found');
  assert.deepStrictEqual(
    { ...summary.counts.outcome?.counts },
    { published: 1, closed: 3 },
    'the two still being worked are no outcome, and the closure nobody read is one'
  );
  assert.strictEqual(summary.counts.outcome?.corpus, 4);
  assert.deepStrictEqual(
    { ...summary.counts.open?.counts },
    { triage: 1, draft: 1 },
    'the two still being worked are counted by state'
  );
  assert.strictEqual(summary.counts.open?.corpus, 2);

  assert.deepStrictEqual({ ...summary.counts.reason?.counts }, { duplicate: 1 });
  assert.strictEqual(
    summary.counts.reason?.missing,
    1,
    'the closed advisory nobody has given a reason'
  );
  // An unread closed advisory has an unknown closure reason.
  // Omit it from the metric (REQUIREMENTS.md section 10).
  assert.strictEqual(
    summary.counts.reason?.corpus,
    2,
    'the closure nobody read is outside the reasons'
  );
  assert.strictEqual(summary.counts.reason?.unread, 1, 'and counted beside them');
});

test('severity counts publications and drafts whose current scoring is confirmed', async () => {
  /**
   * @param {string} fp The confirmed scoring fingerprint.
   * @returns {import('../src/common/parse-detail.js').ParsedComment[]}
   */
  const confirming = (fp) => [
    comment({
      author: 'samuelkarp',
      role: 'Member',
      at: '2026-03-03T00:00:00Z',
      state: {
        betterGhsa: '1.0',
        seq: 1,
        by: 'samuelkarp',
        at: '2026-03-03T00:00:00Z',
        confirmed: { scoring: { by: 'samuelkarp', at: '2026-03-03T00:00:00Z', fp } },
      },
    }),
  ];
  /**
   * A scored advisory: its severity selection and an empty vector field.
   *
   * @param {string} state
   * @param {string} severity
   * @param {import('../src/common/parse-detail.js').ParsedComment[]} comments
   * @returns {import('../src/common/parse-detail.js').ParsedDetail}
   */
  const scored = (state, severity, comments) =>
    advisory({
      state,
      severity,
      severityField: severity,
      severityFieldPresent: true,
      cvssV3: '',
      cvssV3Present: true,
      comments,
    });

  const summary = await stats.summarize(
    corpusOf([
      member({ ghsaId: 'GHSA-aaaa-aaaa-aaaa', state: 'published', severity: 'low' }),
      member({
        ghsaId: 'GHSA-bbbb-bbbb-bbbb',
        state: 'published',
        advisory: advisory({ state: 'Published' }),
      }),
      member({
        ghsaId: 'GHSA-cccc-cccc-cccc',
        state: 'draft',
        advisory: scored(
          'Draft',
          'critical',
          confirming(await schema.scoringFingerprint('critical', ''))
        ),
      }),
      member({
        ghsaId: 'GHSA-dddd-dddd-dddd',
        state: 'draft',
        // Confirmed at high, since moved to moderate.
        advisory: scored(
          'Draft',
          'moderate',
          confirming(await schema.scoringFingerprint('high', ''))
        ),
      }),
      member({
        ghsaId: 'GHSA-eeee-eeee-eeee',
        state: 'draft',
        advisory: scored('Draft', 'high', []),
      }),
      member({ ghsaId: 'GHSA-ffff-ffff-ffff', state: 'draft', severity: 'high' }),
      member({
        ghsaId: 'GHSA-gggg-gggg-gggg',
        state: 'triage',
        advisory: scored('Triage', 'high', confirming(await schema.scoringFingerprint('high', ''))),
      }),
      member({
        ghsaId: 'GHSA-hhhh-hhhh-hhhh',
        state: 'closed',
        advisory: scored('Closed', 'high', confirming(await schema.scoringFingerprint('high', ''))),
      }),
    ]),
    NOW
  );

  assert.deepStrictEqual(
    { ...summary.counts.severity?.counts },
    { low: 1, critical: 1 },
    'the published one the list names, and the draft confirmed at its current score'
  );
  assert.strictEqual(
    summary.counts.severity?.missing,
    1,
    'the published advisory without a severity'
  );
  assert.strictEqual(
    summary.counts.severity?.corpus,
    3,
    'the moved, unconfirmed, triage, and closed advisories are outside the severities'
  );
  assert.strictEqual(
    summary.counts.severity?.unread,
    1,
    'the draft nobody read cannot be judged, and is counted beside them'
  );
});

test('a closure reason this reader does not interpret is counted as it stands', async () => {
  const summary = await stats.summarize(
    corpusOf([
      member({
        ghsaId: 'GHSA-aaaa-aaaa-aaaa',
        state: 'closed',
        advisory: advisory({
          state: 'Closed',
          comments: [
            comment({
              author: 'samuelkarp',
              role: 'Member',
              at: '2026-03-03T00:00:00Z',
              state: CLOSED_AS('rejected by the sun'),
            }),
          ],
        }),
      }),
    ]),
    NOW
  );
  assert.deepStrictEqual({ ...summary.counts.reason?.counts }, { 'rejected by the sun': 1 });
});

test('a closure reason from an author who is not a member is counted nowhere', () => {
  const held = advisory({
    state: 'Closed',
    comments: [
      comment({
        author: 'prakleumas',
        role: 'Author',
        at: '2026-03-03T00:00:00Z',
        state: CLOSED_AS('not a vulnerability'),
      }),
    ],
  });
  assert.strictEqual(stats.closureReasonOf(held), null);
});

test('a stored reason named __proto__ is counted and sets no prototype', () => {
  const held = stats.tally(['__proto__', '__proto__', 'duplicate'], { corpus: 3, unread: 0 });
  assert.strictEqual(held.counts['__proto__'], 2);
  assert.strictEqual(held.counted, 3);
  assert.strictEqual(Object.getPrototypeOf(held.counts), null);
});

test('a summary says whether it is over the whole corpus', async () => {
  const partial = await stats.summarize(
    corpusOf([member({ ghsaId: 'GHSA-aaaa-aaaa-aaaa', state: 'published' })], {
      complete: false,
      expected: { published: 41, closed: 12 },
    }),
    NOW
  );
  assert.strictEqual(partial.complete, false, 'the walk did not reach the last page');
  assert.strictEqual(partial.corpus, 1, 'and this is what it found');
  assert.deepStrictEqual(partial.expected, { published: 41, closed: 12 });
  assert.strictEqual(partial.unread, 1);
  assert.strictEqual(partial.counts.outcome?.corpus, 1);
});

/**
 * Run `body` with the process's local time zone set to `zone`, which Node
 * applies at once, so a check does not depend on the host's zone.
 *
 * @param {string} zone
 * @param {() => void} body
 */
function inZone(zone, body) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'TZ');
  const was = process.env.TZ;
  process.env.TZ = zone;
  try {
    body();
  } finally {
    if (had) process.env.TZ = was;
    else delete process.env.TZ;
  }
}

test('the month a report falls in is read in one zone', () => {
  // Each instant falls in a different month in the zone it runs under.
  inZone('Asia/Tokyo', () => {
    assert.strictEqual(stats.monthOf('2026-03-31T23:30:00Z'), '2026-03');
    assert.strictEqual(stats.monthOf('2026-04-01T00:30:00+02:00'), '2026-03');
  });
  inZone('America/New_York', () => {
    assert.strictEqual(stats.monthOf('2026-04-01T00:30:00Z'), '2026-04');
  });
  assert.strictEqual(stats.monthOf(null), null);
  assert.strictEqual(stats.monthOf('not a time'), null);
});

test('the years of reports run through the later of now and the latest report', () => {
  // September in UTC, still August in New York.
  const at = Date.parse('2026-09-01T02:00:00Z');
  const blank = null;
  inZone('America/New_York', () => {
    assert.deepStrictEqual(
      stats.yearsOf({ '2025-11': 1, '2026-03': 2 }, at),
      [
        { year: 2025, months: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0], total: 1 },
        {
          year: 2026,
          months: [0, 0, 2, 0, 0, 0, 0, 0, 0, blank, blank, blank],
          total: 2,
        },
      ],
      'the months after the latest report through the current UTC month read 0'
    );
    assert.deepStrictEqual(
      stats.yearsOf({ '2026-01': 1, '2026-10': 1 }, at),
      [{ year: 2026, months: [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, blank, blank], total: 2 }],
      'a report after the current month is counted'
    );
    assert.deepStrictEqual(
      stats.yearsOf({ '2027-02': 3 }, at),
      [{ year: 2027, months: [0, 3, ...Array(10).fill(blank)], total: 3 }],
      'and so is one in a later year'
    );
  });
  assert.deepStrictEqual(stats.yearsOf({}, at), []);
});

test('a corpus of one real advisory measures what its page carries', async () => {
  const published = fixture('published-containerd.html');
  const summary = await stats.summarize(
    corpusOf([
      member({ ghsaId: 'GHSA-6r4h-2xvq-wm93', state: 'published', advisory: published }),
    ]),
    NOW
  );
  assert.deepStrictEqual({ ...summary.counts.outcome?.counts }, { published: 1 });
  assert.deepStrictEqual({ ...summary.counts.severity?.counts }, { moderate: 1 });
  assert.deepStrictEqual({ ...summary.counts.month?.counts }, { '2026-04': 1 });
  assert.deepStrictEqual(summary.timings.accept?.values, [3434 * 1000]);
  assert.deepStrictEqual(summary.timings.publish?.values, [10210000 * 1000]);
  assert.strictEqual(summary.timings.close?.counted, 0, 'a published advisory is not a closed one');
  assert.strictEqual(summary.timings.close?.corpus, 0);
  // Comments were removed from the capture. Its first response is the
  // acceptance, the earliest maintainer action on its timeline.
  assert.deepStrictEqual(published.comments, []);
  assert.deepStrictEqual(summary.timings.firstResponse?.values, [3434 * 1000]);
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('the median of a timing is the middle of what it measured', () => {
  // The long response time makes the mean differ from the median.
  const odd = stats.timing([DAY, 12 * DAY, HOUR], { corpus: 3, unread: 0 });
  assert.strictEqual(odd.median, DAY, 'the middle of an odd count');
  assert.strictEqual(odd.mean, (HOUR + DAY + 12 * DAY) / 3);
  assert.notStrictEqual(odd.median, odd.mean, 'the input tells the two answers apart');

  const even = stats.timing([30 * DAY, DAY, HOUR, DAY], { corpus: 4, unread: 0 });
  assert.strictEqual(even.median, DAY, 'the middle pair of an even count');
  assert.strictEqual(even.mean, (HOUR + DAY + DAY + 30 * DAY) / 4);
  assert.notStrictEqual(even.median, even.mean, 'the input tells the two answers apart');
});

test('a timing orders its values by magnitude', () => {
  // These durations sort differently as numbers and strings.
  const values = [3 * DAY, 2 * HOUR, DAY];
  assert.notDeepStrictEqual(
    [...values].sort(),
    [2 * HOUR, DAY, 3 * DAY],
    'the input tells an order by magnitude from an order by text'
  );

  const held = stats.timing(values, { corpus: 3, unread: 0 });
  assert.deepStrictEqual(held.values, [2 * HOUR, DAY, 3 * DAY], 'ascending by magnitude');
  assert.strictEqual(held.min, 2 * HOUR);
  assert.strictEqual(held.median, DAY);
  assert.strictEqual(held.max, 3 * DAY);
});
