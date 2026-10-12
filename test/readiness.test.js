'use strict';

const test = require('node:test');
const assert = require('node:assert');

const readiness = require('../src/common/readiness.js');
const tracking = require('../src/detail/tracking.js');

/** @typedef {import('../src/common/parse-detail.js').ParsedDetail} ParsedDetail */
/** @typedef {import('../src/detail/tracking.js').TrackingView} TrackingView */
/** @typedef {import('../src/common/cache.js').ReviewResult} ReviewResult */

/**
 * @param {number} number
 * @param {string} baseRef
 * @param {string | null} [state]
 * @returns {import('../src/common/parse-detail.js').ForkPullRequest}
 */
function pull(number, baseRef, state = 'open') {
  return {
    number,
    url: `/git-utensils/Spoon-Knife-ghsa-jmvx-2wfw-xfgj/pull/${number}`,
    title: '',
    state,
    baseRef,
    headRef: null,
    author: null,
    openedAt: null,
    assignees: [],
  };
}

const CONFIRMED = /** @type {const} */ ({ status: 'confirmed', by: 'samuelkarp', at: null });

/**
 * A draft with a patch on main and a backport to release/2.1, each approved,
 * and one package naming one patched version per branch.
 *
 * @returns {{ advisory: ParsedDetail, view: TrackingView,
 *   reviews: Record<string, ReviewResult>, required: number }}
 */
function ready() {
  const advisory = /** @type {ParsedDetail} */ (
    /** @type {unknown} */ ({
      state: 'Draft',
      fork: {
        cloneUrl: null,
        repository: null,
        deleteUrl: null,
        pullRequests: [pull(1, 'main'), pull(2, 'release/2.1')],
      },
      packages: [
        {
          ecosystem: 'go',
          name: 'example.com/drawer',
          affected: '< 2.1.1',
          patched: '2.2.0, 2.1.1',
        },
      ],
    })
  );
  const view = {
    ...tracking.untracked(),
    backports: ['main', 'release/2.1'],
    title: CONFIRMED,
    description: CONFIRMED,
    scoring: CONFIRMED,
  };
  const approved = { approvals: 2, changesRequested: false, observedAt: 0 };
  return { advisory, view, reviews: { 1: approved, 2: { ...approved } }, required: 2 };
}

/**
 * @param {ReturnType<typeof ready>} draft
 * @returns {import('../src/common/readiness.js').Readiness}
 */
function compute(draft) {
  const held = readiness.compute(draft.advisory, draft.view, draft.reviews, draft.required);
  assert.ok(held !== null, 'a draft does not have a readiness');
  return held;
}

test('a draft meeting every condition is ready, and its chips say so', () => {
  const held = compute(ready());
  assert.strictEqual(held.ready, true);
  assert.strictEqual(held.detailReady, true);
  assert.deepStrictEqual(held.lines, {
    package: 'Complete',
    affected: 'Complete',
    patched: 'Complete',
  });
  assert.deepStrictEqual(held.backports, [
    { branch: 'main', tone: 'success-muted' },
    { branch: 'release/2.1', tone: 'success-muted' },
  ]);
  assert.strictEqual(held.backportsIncomplete, false);
  assert.strictEqual(held.patchApproved, true);
  assert.deepStrictEqual(held.confirmed, { title: true, description: true, scoring: true });
});

/**
 * @param {Partial<import('../src/common/parse-detail.js').Package>} fields
 * @returns {import('../src/common/parse-detail.js').Package} a complete package
 *   with two patched versions, one per backport target, unless overridden.
 */
function pkg(fields) {
  return { ecosystem: 'go', name: 'x', affected: '< 1', patched: '1, 2', ...fields };
}

/**
 * @param {number} approvals
 * @param {boolean} [changesRequested]
 * @returns {ReviewResult}
 */
function result(approvals, changesRequested = false) {
  return { approvals, changesRequested, observedAt: 0 };
}

/**
 * Each entry breaks one condition of a ready draft. `detail` is whether the
 * conditions the advisory page answers still hold.
 *
 * @type {{ name: string, detail: boolean, breaks: (draft: ReturnType<typeof ready>) => void }[]}
 */
const BROKEN = [
  {
    name: 'the title is not confirmed',
    detail: false,
    breaks: (d) => {
      d.view.title = { ...CONFIRMED, status: 'drifted' };
    },
  },
  {
    name: 'the description is not confirmed',
    detail: false,
    breaks: (d) => {
      d.view.description = { ...CONFIRMED, status: 'unconfirmed' };
    },
  },
  {
    name: 'the scoring is not confirmed',
    detail: false,
    breaks: (d) => {
      d.view.scoring = { ...CONFIRMED, status: 'unreadable' };
    },
  },
  {
    name: 'the fork does not hold an open pull request',
    detail: false,
    breaks: (d) => {
      d.advisory.fork = null;
      d.view.backports = [];
    },
  },
  {
    name: 'a branch has two open pull requests',
    detail: false,
    breaks: (d) => {
      d.advisory.fork?.pullRequests.push(pull(3, 'main'));
      d.reviews[3] = result(2);
    },
  },
  {
    name: 'a pull request is short of approvals',
    detail: true,
    breaks: (d) => {
      d.reviews[2] = result(1);
    },
  },
  {
    name: 'a pull request has changes requested',
    detail: true,
    breaks: (d) => {
      d.reviews[1] = result(5, true);
    },
  },
  {
    name: "a pull request's merge box was not read",
    detail: true,
    breaks: (d) => {
      delete d.reviews[2];
    },
  },
  {
    name: 'a fork row could not be read',
    detail: false,
    breaks: (d) => {
      d.advisory.fork?.pullRequests.push(pull(4, 'main', null));
    },
  },
  {
    name: 'a backport target does not have an open pull request',
    detail: false,
    breaks: (d) => {
      d.view.backports = ['main', 'release/2.0'];
    },
  },
  {
    name: 'no package is listed',
    detail: false,
    breaks: (d) => {
      d.advisory.packages = [];
      d.view.backports = [];
    },
  },
  {
    name: 'packages were never read',
    detail: false,
    breaks: (d) => {
      d.advisory.packages = null;
      d.view.backports = [];
    },
  },
  {
    name: 'a package does not have an ecosystem',
    detail: false,
    breaks: (d) => {
      d.advisory.packages = [pkg({ ecosystem: null })];
    },
  },
  {
    name: 'a package does not have a name',
    detail: false,
    breaks: (d) => {
      d.advisory.packages = [pkg({ name: null })];
    },
  },
  {
    name: 'a package does not have affected versions',
    detail: false,
    breaks: (d) => {
      d.advisory.packages = [pkg({ affected: null })];
    },
  },
  {
    name: 'a package does not have patched versions',
    detail: false,
    breaks: (d) => {
      d.advisory.packages = [pkg({}), pkg({ name: 'y', patched: null })];
    },
  },
  {
    name: 'the patched versions outnumber the targets',
    detail: false,
    breaks: (d) => {
      d.advisory.packages = [pkg({ patched: '1, 2, 3' })];
    },
  },
];

for (const one of BROKEN) {
  test(`a draft is not ready when ${one.name}`, () => {
    const draft = ready();
    one.breaks(draft);
    const held = compute(draft);
    assert.strictEqual(held.ready, false);
    assert.strictEqual(held.detailReady, one.detail, 'the conditions the page answers');
  });
}

test('a draft that needs zero approvals still needs each merge box read', () => {
  const draft = ready();
  draft.required = 0;
  draft.reviews = { 1: { approvals: 0, changesRequested: false, observedAt: 0 } };
  assert.strictEqual(compute(draft).ready, false);
  draft.reviews[2] = { approvals: 0, changesRequested: false, observedAt: 0 };
  assert.strictEqual(compute(draft).ready, true);
});

test('the readiness of an advisory that is not a draft is null', () => {
  const draft = ready();
  for (const state of ['Triage', 'Published', 'Closed', null]) {
    const advisory = { ...draft.advisory, state };
    const held = readiness.compute(advisory, draft.view, draft.reviews, 2);
    assert.strictEqual(held, null, String(state));
  }
});

test('each package line reads missing, incomplete, or complete', () => {
  const draft = ready();
  draft.view.backports = [];
  draft.advisory.packages = [
    { ecosystem: 'other', name: 'x', affected: null, patched: '1' },
    { ecosystem: 'go', name: null, affected: null, patched: '2' },
  ];
  assert.deepStrictEqual(compute(draft).lines, {
    package: 'Incomplete',
    affected: 'Missing',
    patched: 'Complete',
  });
  draft.advisory.packages = [];
  assert.deepStrictEqual(compute(draft).lines, {
    package: 'Missing',
    affected: 'Missing',
    patched: 'Missing',
  });
});

test('patched versions short of or beyond the targets read incomplete', () => {
  const draft = ready();
  // One entry is empty and still counts.
  draft.advisory.packages = [{ ecosystem: 'go', name: 'x', affected: '< 1', patched: '1, , 2' }];
  const beyond = compute(draft);
  assert.strictEqual(beyond.lines.patched, 'Incomplete');
  assert.strictEqual(beyond.backportsIncomplete, true);

  draft.advisory.packages = [{ ecosystem: 'go', name: 'x', affected: '< 1', patched: '1' }];
  const short = compute(draft);
  assert.strictEqual(short.lines.patched, 'Incomplete');
  assert.strictEqual(short.backportsIncomplete, false);
});

test('a backport target is red with two open pull requests and gray with an unapproved one', () => {
  const draft = ready();
  draft.advisory.fork?.pullRequests.push(pull(3, 'main'));
  delete draft.reviews[2];
  const held = compute(draft);
  assert.deepStrictEqual(held.backports, [
    { branch: 'main', tone: 'danger' },
    { branch: 'release/2.1', tone: undefined },
  ]);
  // Every open pull request approved, but two on one branch.
  draft.reviews[2] = { approvals: 2, changesRequested: false, observedAt: 0 };
  draft.reviews[3] = { approvals: 2, changesRequested: false, observedAt: 0 };
  assert.strictEqual(compute(draft).patchApproved, false);
});

test('a fork row that could not be read leaves the patch unapproved', () => {
  const draft = ready();
  assert.strictEqual(compute(draft).patchApproved, true);
  draft.advisory.fork?.pullRequests.push(pull(4, 'release/2.0', null));
  assert.strictEqual(compute(draft).patchApproved, false);
});
