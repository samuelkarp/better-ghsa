'use strict';

const test = require('node:test');
const assert = require('node:assert');

const order = require('../src/common/order.js');

/**
 * @param {string} ghsaId
 * @param {Partial<import('../src/common/order.js').OrderEntry>} [fields]
 * @returns {import('../src/common/order.js').OrderEntry}
 */
function entry(ghsaId, fields = {}) {
  return {
    ghsaId,
    state: 'Triage',
    neverReviewed: false,
    newActivity: false,
    triage: null,
    embargoOverdue: false,
    severity: null,
    severityConfirmed: false,
    waitingSince: null,
    ...fields,
  };
}

/**
 * @param {readonly import('../src/common/order.js').OrderEntry[]} entries
 * @param {readonly string[]} wanted
 * @param {string} what
 */
function ordersAs(entries, wanted, what) {
  const sorted = order.sort(entries);
  assert.strictEqual(sorted.length, wanted.length, `${what}: entry count`);
  for (let i = 0; i < wanted.length; i += 1) {
    assert.ok(
      sorted[i]?.ghsaId === wanted[i],
      `${what}: position ${i} holds ${sorted[i]?.ghsaId} where ${wanted[i]} belongs`
    );
  }
}

/**
 * Choose identifiers whose order opposes the expected group order.
 *
 * @param {string} state
 * @param {Partial<import('../src/common/order.js').OrderEntry>} first The group
 *   that belongs above.
 * @param {Partial<import('../src/common/order.js').OrderEntry>} second The group
 *   that belongs below.
 * @param {string} what
 */
function boundary(state, first, second, what) {
  const above = entry('GHSA-zzzz-zzzz-zzzz', { state, ...first });
  const below = entry('GHSA-aaaa-aaaa-aaaa', { state, ...second });
  assert.ok(
    order.compare(above, below) < 0 && order.compare(below, above) > 0,
    `${what}: the boundary does not hold`
  );
  ordersAs([below, above], ['GHSA-zzzz-zzzz-zzzz', 'GHSA-aaaa-aaaa-aaaa'], what);
  ordersAs([above, below], ['GHSA-zzzz-zzzz-zzzz', 'GHSA-aaaa-aaaa-aaaa'], `${what}, reversed`);
}

const OVERDUE = { embargoOverdue: true, triage: 'awaiting reporter' };
const ACTIVITY = { newActivity: true, triage: 'awaiting reporter' };
const OURS = { triage: 'evaluating' };
const FRESH = { neverReviewed: true, triage: 'awaiting reporter' };
const THEIRS = { triage: 'awaiting reporter' };
const UNTRIAGED = { triage: null };

test('state comes before every group: a draft sorts above every advisory in triage', () => {
  // Severity, waiting time, and identifier order all oppose the state order.
  const quiet = entry('GHSA-zzzz-zzzz-zzzz', { state: 'Draft', triage: 'awaiting reporter' });
  const urgent = entry('GHSA-aaaa-aaaa-aaaa', {
    state: 'Triage',
    embargoOverdue: true,
    severity: 'critical',
    severityConfirmed: true,
    waitingSince: '2020-01-01T00:00:00Z',
  });
  ordersAs([urgent, quiet], ['GHSA-zzzz-zzzz-zzzz', 'GHSA-aaaa-aaaa-aaaa'], 'draft above triage');
});

test('each state orders the groups REQUIREMENTS.md section 9 names for it', () => {
  // Moving an advisory to draft requires a maintainer and counts as review.
  assert.deepStrictEqual(order.groupsFor('draft'), [
    'embargo overdue',
    'new activity',
    'blocked on us',
    'blocked on the reporter',
  ]);
  assert.deepStrictEqual(order.groupsFor('triage'), [
    'embargo overdue',
    'blocked on us',
    'never reviewed',
    'new activity',
    'blocked on the reporter',
  ]);
});

test('an advisory nobody has triaged is never reviewed in triage', () => {
  const untouched = entry('GHSA-aaaa-aaaa-aaaa');
  assert.strictEqual(untouched.triage, null);
  assert.strictEqual(order.groupOf(untouched), 'never reviewed');
  assert.strictEqual(order.groupRank(untouched), 2);
  assert.strictEqual(order.blockedOnUs(untouched), false);
  assert.strictEqual(order.groupOf(entry('B', { neverReviewed: true })), 'never reviewed');
  boundary('Triage', OURS, UNTRIAGED, 'triage, blocked on us above an advisory nobody has triaged');
  boundary(
    'Triage',
    UNTRIAGED,
    ACTIVITY,
    'triage, an advisory nobody has triaged above new activity'
  );
});

test('an advisory nobody has triaged is blocked on us in draft', () => {
  const untouched = entry('GHSA-aaaa-aaaa-aaaa', { state: 'Draft' });
  assert.strictEqual(order.groupOf(untouched), 'blocked on us');
  assert.strictEqual(order.groupRank(untouched), 2);
  assert.strictEqual(order.blockedOnUs(untouched), true);
  assert.strictEqual(
    order.groupOf(entry('B', { state: 'Draft', neverReviewed: true })),
    'blocked on us'
  );
  boundary(
    'Draft',
    ACTIVITY,
    UNTRIAGED,
    'draft, new activity above an advisory nobody has triaged'
  );
  boundary(
    'Draft',
    UNTRIAGED,
    THEIRS,
    'draft, an advisory nobody has triaged above blocked on the reporter'
  );
});

test('a state this reader does not know takes the triage order', () => {
  assert.strictEqual(order.stateOf(entry('A', { state: 'Draft' })), 'draft');
  assert.strictEqual(order.stateOf(entry('A', { state: 'draft' })), 'draft');
  assert.strictEqual(order.stateOf(entry('A', { state: 'Triage' })), 'triage');
  assert.strictEqual(order.stateOf(entry('A', { state: null })), 'triage');
  assert.strictEqual(order.stateOf(entry('A', { state: 'Published' })), 'triage');
  assert.strictEqual(order.stateOf(entry('A', { state: 'Closed' })), 'triage');
  assert.strictEqual(order.groupOf(entry('A', { state: 'Closed', ...FRESH })), 'never reviewed');
});

test('every triage value says which side the advisory waits on', () => {
  assert.strictEqual(order.classifyTriage('evaluating'), 'us');
  assert.strictEqual(order.classifyTriage('awaiting maintainer input'), 'us');
  assert.strictEqual(order.classifyTriage('awaiting reporter'), 'reporter');
  assert.strictEqual(order.classifyTriage('Awaiting Reporter'), 'reporter');
  assert.strictEqual(order.classifyTriage(null), null, 'an advisory nobody has triaged');
  assert.strictEqual(order.classifyTriage(undefined), null, 'a field that never arrived');
  assert.strictEqual(order.classifyTriage('   '), null, 'a value with no content');
  assert.strictEqual(order.classifyTriage('parked'), 'us', 'a value this reader does not know');
  assert.strictEqual(order.groupOf(entry('A', { triage: 'awaiting maintainer input' })), 'blocked on us');
  assert.strictEqual(order.groupOf(entry('A', { triage: 'evaluating' })), 'blocked on us');
  assert.strictEqual(order.groupOf(entry('A', { triage: 'awaiting reporter' })), 'blocked on the reporter');
});

test('the waiting state a chip carries is not the ordering group', () => {
  assert.deepStrictEqual(order.WAITING_STATES, [
    'never reviewed',
    'new activity',
    'blocked on us',
    'blocked on the reporter',
  ]);
  const fresh = entry('A', { neverReviewed: true, triage: 'evaluating' });
  assert.strictEqual(order.waitingStateOf(fresh), 'never reviewed');
  assert.strictEqual(order.groupOf(fresh), 'blocked on us');
  const overdue = entry('B', { embargoOverdue: true, triage: 'evaluating' });
  assert.strictEqual(order.waitingStateOf(overdue), 'blocked on us');
  assert.strictEqual(order.groupOf(overdue), 'embargo overdue');
});

test('confirmed severities sort highest first, then unconfirmed severities', () => {
  for (const state of ['Draft', 'Triage']) {
    const entries = [
      entry('B', { state, triage: 'evaluating', severity: 'low' }),
      entry('D', { state, triage: 'evaluating', severity: 'high', severityConfirmed: true }),
      entry('C', { state, triage: 'evaluating', severity: 'critical' }),
      entry('E', { state, triage: 'evaluating', severity: 'critical', severityConfirmed: true }),
      entry('A', { state, triage: 'evaluating' }),
    ];
    ordersAs(entries, ['E', 'D', 'C', 'B', 'A'], `severity within a group in ${state}`);
  }
  assert.strictEqual(order.severityRank('critical'), 4);
  assert.strictEqual(order.severityRank('high'), 3);
  assert.strictEqual(order.severityRank('moderate'), 2);
  assert.strictEqual(order.severityRank('low'), 1);
  assert.strictEqual(order.severityRank(null), 0);
  assert.strictEqual(order.severityRank('unknown'), 0);
});

test('severity orders every group, not the blocked-on-us one alone', () => {
  for (const state of ['Draft', 'Triage']) {
    for (const group of [OVERDUE, ACTIVITY, THEIRS, FRESH]) {
      if (state === 'Draft' && group === FRESH) continue;
      const severe = entry('GHSA-zzzz-zzzz-zzzz', {
        state,
        ...group,
        severity: 'critical',
        severityConfirmed: true,
        waitingSince: '2026-08-25T00:00:00Z',
      });
      const waited = entry('GHSA-aaaa-aaaa-aaaa', {
        state,
        ...group,
        waitingSince: '2020-01-01T00:00:00Z',
      });
      ordersAs(
        [waited, severe],
        ['GHSA-zzzz-zzzz-zzzz', 'GHSA-aaaa-aaaa-aaaa'],
        `severity above waiting in ${state} ${order.groupOf(severe)}`
      );
    }
  }
});

test('the longest waiting breaks a tie inside a group, in both states', () => {
  for (const state of ['Draft', 'Triage']) {
    const entries = [
      entry('A', {
        state,
        triage: 'evaluating',
        severity: 'high',
        waitingSince: '2026-08-20T00:00:00Z',
      }),
      entry('C', {
        state,
        triage: 'evaluating',
        severity: 'high',
        waitingSince: '2026-06-01T00:00:00Z',
      }),
      entry('B', {
        state,
        triage: 'evaluating',
        severity: 'high',
        waitingSince: '2026-08-19T23:59:59Z',
      }),
    ];
    ordersAs(entries, ['C', 'B', 'A'], `the longest waiting of three equal severities in ${state}`);
  }
});

test('a waiting time that went unread sorts after every one that is known', () => {
  const entries = [
    entry('B', { ...THEIRS, waitingSince: '2026-08-01T00:00:00Z' }),
    entry('C', { ...THEIRS, waitingSince: '2025-12-31T00:00:00Z' }),
    entry('A', { ...THEIRS, waitingSince: null }),
  ];
  ordersAs(entries, ['C', 'B', 'A'], 'a waiting time that went unread sorts last');
});

function grid() {
  /** @type {import('../src/common/order.js').OrderEntry[]} */
  const entries = [];
  for (const state of ['Draft', 'Triage']) {
    for (const neverReviewed of [false, true]) {
      for (const newActivity of [false, true]) {
        for (const triage of [null, 'evaluating', 'awaiting reporter']) {
          for (const embargoOverdue of [false, true]) {
            for (const score of [
              { severity: null, severityConfirmed: false },
              { severity: 'critical', severityConfirmed: false },
              { severity: 'low', severityConfirmed: true },
            ]) {
              for (const waitingSince of [null, '2026-01-01T00:00:00Z', '2026-08-01T00:00:00Z']) {
                const id = `GHSA-0000-0000-${String(entries.length).padStart(4, '0')}`;
                entries.push(
                  entry(id, {
                    state,
                    neverReviewed,
                    newActivity,
                    triage,
                    embargoOverdue,
                    waitingSince,
                    ...score,
                  })
                );
              }
            }
          }
        }
      }
    }
  }
  return entries;
}

test('the grid covers both states and every group in each', () => {
  const entries = grid();
  assert.strictEqual(entries.length, 432);
  /** @type {Record<string, number>} */
  const seen = {};
  for (const each of entries) {
    const key = `${order.stateOf(each)} ${order.groupOf(each)}`;
    seen[key] = (seen[key] ?? 0) + 1;
  }
  for (const group of order.groupsFor('draft')) {
    assert.ok((seen[`draft ${group}`] ?? 0) > 0, `the grid holds no draft in ${group}`);
  }
  for (const group of order.groupsFor('triage')) {
    assert.ok((seen[`triage ${group}`] ?? 0) > 0, `the grid holds no triage advisory in ${group}`);
  }
  assert.strictEqual(seen['draft never reviewed'], undefined, 'never reviewed cannot arise in draft');
});

test('the comparator is a total order', () => {
  const entries = grid();
  assert.strictEqual(entries.length, 432);

  // Agreement with every pair of sorted positions proves transitivity
  // for these entries.
  /** @type {Map<import('../src/common/order.js').OrderEntry, number>} */
  const place = new Map();
  order.sort(entries).forEach((each, index) => place.set(each, index));
  assert.strictEqual(place.size, entries.length, 'the sorted list dropped an entry');

  for (const a of entries) {
    assert.ok(order.compare(a, a) === 0, `${a.ghsaId} against itself`);
    for (const b of entries) {
      const forward = Math.sign(order.compare(a, b));
      const back = Math.sign(order.compare(b, a));
      assert.ok(forward === -back, `${a.ghsaId} and ${b.ghsaId} disagree on which comes first`);
      if (a !== b) {
        assert.ok(forward !== 0, `${a.ghsaId} and ${b.ghsaId} are distinct but tie`);
        assert.strictEqual(
          forward,
          Math.sign(Number(place.get(a)) - Number(place.get(b))),
          `${a.ghsaId} and ${b.ghsaId} do not order the way one sequence holds them`
        );
      }
    }
  }
});

test('the sorted grid holds each group whole and in its state order', () => {
  const sorted = order.sort(grid());
  /** @type {string[]} */
  const runs = [];
  for (const each of sorted) {
    const key = `${order.stateOf(each)} ${order.groupOf(each)}`;
    if (runs[runs.length - 1] !== key) runs.push(key);
  }
  assert.deepStrictEqual(runs, [
    ...order.groupsFor('draft').map((group) => `draft ${group}`),
    ...order.groupsFor('triage').map((group) => `triage ${group}`),
  ]);
});

test('the answer does not depend on the order the entries arrived in', () => {
  const entries = grid();
  const wanted = order.sort(entries).map((each) => each.ghsaId ?? '');
  let seed = 12345;
  for (let round = 0; round < 20; round += 1) {
    const shuffled = entries.slice();
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      const swap = /** @type {import('../src/common/order.js').OrderEntry} */ (shuffled[i]);
      shuffled[i] = /** @type {import('../src/common/order.js').OrderEntry} */ (shuffled[j]);
      shuffled[j] = swap;
    }
    ordersAs(shuffled, wanted, `shuffle ${round}`);
  }
});

test('an advisory whose identifier went unread sorts below one that has an identifier', () => {
  const unread = entry('GHSA-aaaa-aaaa-aaaa', { ghsaId: null, triage: 'evaluating' });
  const known = entry('GHSA-aaaa-aaaa-aaaa', { triage: 'evaluating' });
  assert.ok(order.compare(unread, known) > 0, 'the unread identifier did not sort second');
  assert.ok(order.compare(known, unread) < 0, 'the pair does not order the same way both ways round');
  const sorted = order.sort([unread, known]);
  assert.ok(sorted[0] === known, 'the advisory carrying an identifier belongs first');
  assert.ok(sorted[1] === unread, 'the advisory carrying none belongs last');
});

test('the table sorts on the comparators this file holds', () => {
  assert.strictEqual(order.compareText(null, 'GHSA-aaaa-aaaa-aaaa'), 1);
  assert.strictEqual(order.compareText('GHSA-aaaa-aaaa-aaaa', null), -1);
  assert.strictEqual(order.compareText(null, null), 0);
  assert.strictEqual(order.compareNumber(null, 1), 1);
  assert.strictEqual(order.compareNumber(1, null), -1);
  assert.strictEqual(order.compareNumber(null, null), 0);
});

test('sorting leaves the array it was given alone', () => {
  const entries = [entry('B'), entry('A')];
  order.sort(entries);
  assert.strictEqual(entries[0]?.ghsaId, 'B');
});
