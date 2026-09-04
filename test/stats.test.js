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
 * @returns {import('../src/common/parse-detail.js').TimelineEvent[]} the
 *   timeline that fixture's region holds. A fixture is kept to the one region a
 *   test reads, and a timeline region carries no page header for `parseDetail`
 *   to recognize.
 */
function timelineFixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  const doc = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
  return parseDetail.parseTimeline(doc);
}

/**
 * An advisory in the shape the parser produces, carrying only what a statistic
 * reads. Everything else is what an advisory with nothing on it holds.
 *
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
 * One comment in the shape the parser produces.
 *
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

/** One snapshot payload a member wrote, carrying a closure reason. */
const CLOSED_AS = /** @param {string} reason */ (reason) => ({
  betterGhsa: '1.0',
  seq: 1,
  by: 'samuelkarp',
  at: '2026-04-01T00:00:00Z',
  closure: { reason },
});

test("a member's state comment is not an answer to the reporter", () => {
  // The draft fixture carries one comment: a state comment from a member. The
  // advisory contributes no first response, and not a response of zero.
  const draft = fixture('draft.html');
  assert.strictEqual(draft.comments.length, 1);
  assert.strictEqual(draft.comments[0]?.role, 'Member');
  assert.notStrictEqual(draft.comments[0]?.stateComment, null);
  assert.strictEqual(stats.firstResponseAt(draft), null);
  assert.strictEqual(stats.durationOf(draft, stats.firstResponseAt), null);
});

test('a preserved original report is not an answer to the reporter', () => {
  // The preservation comment carries the reporter's own text back onto the
  // thread under a member's login. Counting it would move the first response
  // from the answer at 23:00 to the copy at 22:05.
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

test('a title carrying a maintainer act sets no timing', () => {
  // The reporter writes the advisory's title, and a `changed the title` event
  // repeats it into the timeline, so every one of these phrases is text the
  // reporter chose. Read against the whole event text they set all three
  // instants, and the report-to-accept, report-to-close and report-to-publish
  // durations with them.
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
  // The reporter list names the events this reader knows about. An event it
  // does not know, carrying the words of an act somewhere after its own
  // opening, is refused by the anchor alone.
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
  // The same timeline carries a release the day after the publication. A rule
  // taking any event that ends in "this" would read the release as one.
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
    // 22:15:18 to 22:16:30 is a minute and twelve seconds.
    ['first response', triage, stats.firstResponseAt, '2026-08-25T22:16:30Z', 72 * 1000],
    // 18:05:12 to 19:02:26 is fifty-seven minutes and fourteen seconds.
    ['accept', published, stats.draftAt, '2026-04-07T19:02:26Z', 3434 * 1000],
    // 16:19:16 to 19:21:00 is three hours, one minute, and forty-four seconds.
    ['close', closed, stats.closeAt, '2026-08-24T19:21:00Z', 10904 * 1000],
    // 18:05:12 on April 7 to 22:11:52 on August 3 is a hundred and eighteen
    // days, four hours, six minutes and forty seconds.
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
      ['close', 'Time to close', 'Never closed'],
      ['publish', 'Time to publish', 'Never published'],
    ]
  );
});

/**
 * A capture of a real closed advisory, read from the path in
 * `BGHSA_CLOSED_ADVISORY_CAPTURE`. A closed advisory is not published: its
 * title, its participants, and its timeline are all private, so no such capture
 * is committed here and the variable points at a file outside the repository.
 * With the variable unset the check skips, which is what a clone of this
 * repository sees. With it set, a path that does not exist or does not read as
 * an advisory fails the check, so a mistyped path cannot pass for a check that
 * ran. The assertions are instants only, so nothing the capture holds is
 * written down here or printed by a failure.
 *
 * `docs/testing.md` describes the variable.
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

test('time from report to close is a timing, and nothing is left uncomputed', () => {
  const timeline = timelineFixture('invented-close-timeline.html');
  const summary = stats.summarize(
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
    ])
  );
  assert.deepStrictEqual(Object.keys(summary.timings).sort(), [
    'accept',
    'close',
    'firstResponse',
    'publish',
  ]);
  assert.deepStrictEqual(summary.timings.close?.values, [10904 * 1000]);
  assert.strictEqual(
    summary.timings.close?.omitted,
    1,
    'the advisory with no close event contributes nothing, and not a zero'
  );
  assert.strictEqual(
    summary.timings.publish?.counted,
    0,
    'and neither of the two closed advisories was published'
  );
  assert.strictEqual(summary.timings.publish?.omitted, 2);
  assert.deepStrictEqual(summary.uncomputed, {});
  assert.deepStrictEqual(
    stats.TIMINGS.map((entry) => entry.key),
    Object.keys(summary.timings)
  );
});

test('an advisory the event is not observable on contributes to no timing', () => {
  const answered = advisory({
    reportedAt: '2026-04-01T00:00:00Z',
    comments: [comment({ author: 'samuelkarp', role: 'Member', at: '2026-04-01T01:00:00Z' })],
    timeline: [event({ at: '2026-04-01T02:00:00Z', text: 'samuelkarp accepted this report' })],
  });
  const silent = advisory({ reportedAt: '2026-04-02T00:00:00Z' });
  const summary = stats.summarize(
    corpusOf([
      member({ ghsaId: 'GHSA-aaaa-aaaa-aaaa', state: 'published', advisory: answered }),
      member({ ghsaId: 'GHSA-bbbb-bbbb-bbbb', state: 'closed', advisory: silent }),
      member({ ghsaId: 'GHSA-cccc-cccc-cccc', state: 'closed' }),
    ])
  );

  const first = summary.timings.firstResponse;
  assert.deepStrictEqual(first?.values, [60 * 60 * 1000]);
  assert.strictEqual(first?.counted, 1);
  assert.strictEqual(first?.omitted, 2, 'the silent advisory and the unread one');
  assert.strictEqual(first?.corpus, 3);
  assert.strictEqual(first?.unread, 1);
  assert.strictEqual(first?.mean, 60 * 60 * 1000, 'the mean is over what was measured');
  assert.ok(!(first?.values ?? []).includes(0), 'nothing landed as a zero');

  const draft = summary.timings.accept;
  assert.deepStrictEqual(draft?.values, [2 * 60 * 60 * 1000]);
  assert.strictEqual(draft?.omitted, 2);
});

test('a timing reports the spread of what it measured', () => {
  const over = { corpus: 4, unread: 0 };
  const held = stats.timing([300, 100, null, 200], over);
  assert.deepStrictEqual(held.values, [100, 200, 300]);
  assert.strictEqual(held.counted, 3);
  assert.strictEqual(held.omitted, 1);
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

test('the corpus is counted by closure reason, state, severity, and month', () => {
  const summary = stats.summarize(
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
    ])
  );

  assert.strictEqual(summary.corpus, 4);
  assert.strictEqual(summary.unread, 1);

  assert.deepStrictEqual({ ...summary.counts.state?.counts }, { closed: 2, published: 2 });
  assert.strictEqual(summary.counts.state?.counted, 4, 'the list page names every state');
  assert.strictEqual(summary.counts.state?.missing, 0);

  assert.deepStrictEqual(
    { ...summary.counts.severity?.counts },
    { high: 2, low: 1, moderate: 1 }
  );
  assert.strictEqual(
    summary.counts.severity?.counted,
    4,
    'the list page names the severity of an advisory no read backs'
  );

  assert.deepStrictEqual({ ...summary.counts.month?.counts }, { '2026-03': 2, '2026-04': 2 });

  // Every advisory here has ended, two by being closed for a reason and two by
  // being published, so the endings account for the whole of it.
  assert.deepStrictEqual(
    { ...summary.counts.reason?.counts },
    { 'not a vulnerability': 2, published: 2 }
  );
  assert.strictEqual(summary.counts.reason?.counted, 4);
  assert.strictEqual(summary.counts.reason?.corpus, 4);
  assert.strictEqual(summary.counts.reason?.missing, 0);
  assert.strictEqual(
    summary.counts.reason?.unread,
    0,
    'the list page names a publication, so the published advisory nobody read still ended'
  );
  assert.strictEqual(summary.counts.reason?.ratios['not a vulnerability'], 0.5);
});

test('the endings are counted over the advisories that ended', () => {
  // A published advisory ended by being published and a closed one ended for
  // the reason it was closed for. A closed advisory nobody has given a reason
  // ended without one, and is the count a backfill works from. An advisory in
  // triage or in draft has not ended, and is in none of it: counting one under
  // no reason would say a report still being worked was closed without one.
  const summary = stats.summarize(
    corpusOf([
      member({ ghsaId: 'GHSA-aaaa-aaaa-aaaa', state: 'triage' }),
      member({ ghsaId: 'GHSA-bbbb-bbbb-bbbb', state: 'draft' }),
      member({ ghsaId: 'GHSA-cccc-cccc-cccc', state: 'published' }),
      // Closed and never read. Nothing has been read to say what reason it
      // carries.
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
    ])
  );

  assert.strictEqual(summary.corpus, 6, 'the corpus is every advisory the crawl found');
  assert.deepStrictEqual({ ...summary.counts.reason?.counts }, { published: 1, duplicate: 1 });
  assert.strictEqual(summary.counts.reason?.counted, 2);
  assert.strictEqual(
    summary.counts.reason?.missing,
    1,
    'the closed advisory nobody has given a reason'
  );
  assert.strictEqual(
    summary.counts.reason?.corpus,
    3,
    'the two still being worked, or the one nobody read, were counted as endings'
  );
  // REQUIREMENTS.md section 10: a metric is omitted where the event it needs is
  // not observable. A close nobody has read is such a member, and reading it as
  // a close with no reason set would inflate the share a backfill works from.
  assert.strictEqual(summary.counts.reason?.unread, 1);
});

test('a closure reason this reader does not interpret is counted as it stands', () => {
  const summary = stats.summarize(
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
    ])
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

test('a summary says whether it is over the whole corpus', () => {
  const partial = stats.summarize(
    corpusOf([member({ ghsaId: 'GHSA-aaaa-aaaa-aaaa', state: 'published' })], {
      complete: false,
      expected: { published: 41, closed: 12 },
    })
  );
  assert.strictEqual(partial.complete, false, 'the walk did not reach the last page');
  assert.strictEqual(partial.corpus, 1, 'and this is what it found');
  assert.deepStrictEqual(partial.expected, { published: 41, closed: 12 });
  assert.strictEqual(partial.unread, 1);
  assert.strictEqual(partial.counts.state?.corpus, 1);
});

test('the month a report falls in is read in one zone', () => {
  assert.strictEqual(stats.monthOf('2026-03-31T23:30:00Z'), '2026-03');
  assert.strictEqual(stats.monthOf('2026-04-01T00:30:00+02:00'), '2026-03');
  assert.strictEqual(stats.monthOf(null), null);
  assert.strictEqual(stats.monthOf('not a time'), null);
});

test('a corpus of one real advisory measures what its page carries', () => {
  const published = fixture('published-containerd.html');
  const summary = stats.summarize(
    corpusOf([
      member({ ghsaId: 'GHSA-6r4h-2xvq-wm93', state: 'published', advisory: published }),
    ])
  );
  assert.deepStrictEqual({ ...summary.counts.state?.counts }, { published: 1 });
  assert.deepStrictEqual({ ...summary.counts.severity?.counts }, { moderate: 1 });
  assert.deepStrictEqual({ ...summary.counts.month?.counts }, { '2026-04': 1 });
  assert.deepStrictEqual(summary.timings.accept?.values, [3434 * 1000]);
  assert.deepStrictEqual(summary.timings.publish?.values, [10210000 * 1000]);
  assert.strictEqual(summary.timings.close?.counted, 0, 'a published advisory is not a closed one');
  assert.strictEqual(summary.timings.close?.omitted, 1);
  // Redaction dropped every comment node from this capture before it was saved,
  // so the file holds none. An advisory with no comment on it answers nobody,
  // and the summary counts it among the omitted rather than at zero.
  assert.deepStrictEqual(published.comments, []);
  assert.deepStrictEqual(summary.timings.firstResponse?.values, []);
  assert.strictEqual(summary.timings.firstResponse?.omitted, 1);
  assert.strictEqual(summary.timings.firstResponse?.mean, null);
});

/** The units the durations below are written in. */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('the median of a timing is the middle of what it measured', () => {
  // One advisory answered in an hour, one in a day, one in twelve. The long one
  // carries the mean past every value but itself, so the two answers stand
  // apart and a mean standing in for the median would read as one.
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
  // Two hours, a day and three days are 7200000, 86400000 and 259200000
  // milliseconds, which read in a different order as text: "259200000" comes
  // first there and "86400000" last. A corpus holds durations of every size, so
  // an order taken from the text would report the wrong min, median and max.
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
