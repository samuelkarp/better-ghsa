'use strict';

const test = require('node:test');
const assert = require('node:assert');

const record = require('../src/common/record.js');

test('a cache record this reader cannot use answers as absent', () => {
  assert.ok(record.advisoryFrom(null) === null, 'null is not an advisory');
  assert.ok(record.advisoryFrom('advisory') === null, 'a string is not an advisory');
  assert.ok(record.advisoryFrom({ ghsaId: 'GHSA-x' }) === null, 'a record with no comment list');
  assert.ok(record.advisoryFrom({ comments: [], timeline: {} }) === null, 'a record with no timeline');
});

test("an author's standing in a cache record is recomputed, not read", () => {
  const advisory = record.advisoryFrom({
    comments: [
      { id: '1', elementId: 'advisory-comment-1', author: 'prakleumas', role: 'Author', trusted: true },
      { id: '2', elementId: 'advisory-comment-2', author: 'samuelkarp', role: 'Member', trusted: false },
    ],
    timeline: [],
  });
  if (advisory === null) throw new Error('the record did not read as an advisory');
  const reporter = advisory.comments[0]?.trusted ?? null;
  assert.ok(reporter === false, `a reporter stored as trusted: ${reporter}`);
  const member = advisory.comments[1]?.trusted ?? null;
  assert.ok(member === true, `a member stored as untrusted: ${member}`);
});

test('a cache record carries the advisory the parser read', () => {
  const advisory = record.advisoryFrom({
    ghsaId: 'GHSA-jmvx-2wfw-xfgj',
    state: 'Closed',
    severity: 'high',
    reportedAt: '2026-08-25T22:15:18Z',
    reporter: 'prakleumas',
    comments: [],
    timeline: [{ id: 'event-1', actor: 'samuelkarp', at: '2026-08-26T00:00:00Z', text: 'samuelkarp accepted this report' }],
    fork: { pullRequests: [{ number: 7, state: 'open', baseRef: 'main' }] },
    collaborators: ['prakleumas', 42],
  });
  if (advisory === null) throw new Error('the record did not read as an advisory');
  assert.strictEqual(advisory.ghsaId, 'GHSA-jmvx-2wfw-xfgj');
  assert.strictEqual(advisory.state, 'Closed');
  assert.strictEqual(advisory.severity, 'high');
  assert.strictEqual(advisory.reportedAt, '2026-08-25T22:15:18Z');
  assert.strictEqual(advisory.reporter, 'prakleumas');
  assert.strictEqual(advisory.timeline.length, 1);
  assert.strictEqual(advisory.timeline[0]?.text, 'samuelkarp accepted this report');
  assert.strictEqual(advisory.fork?.pullRequests[0]?.number, 7);
  assert.strictEqual(advisory.fork?.pullRequests[0]?.baseRef, 'main');
  assert.deepStrictEqual(advisory.collaborators, ['prakleumas']);
});

test('a cache record names the advisory a write from it goes to', () => {
  const advisory = record.advisoryFrom({
    ref: { owner: 'git-utensils', repo: 'Spoon-Knife', ghsaId: 'GHSA-jmvx-2wfw-xfgj' },
    ghsaId: 'GHSA-jmvx-2wfw-xfgj',
    comments: [],
    timeline: [],
  });
  if (advisory === null) throw new Error('the record did not read as an advisory');
  assert.strictEqual(advisory.ref?.owner, 'git-utensils');
  assert.strictEqual(advisory.ref?.repo, 'Spoon-Knife');
  assert.strictEqual(advisory.ref?.ghsaId, 'GHSA-jmvx-2wfw-xfgj');
});

test('a cache record naming half an advisory names none', () => {
  const half = { comments: [], timeline: [] };
  assert.strictEqual(
    record.advisoryFrom({ ...half, ref: { owner: 'git-utensils', repo: 'Spoon-Knife' } })?.ref,
    null,
    'a reference with no identifier is one no write can be aimed at'
  );
  assert.strictEqual(
    record.advisoryFrom({ ...half, ref: { owner: '', repo: 'Spoon-Knife', ghsaId: 'GHSA-x' } })?.ref,
    null,
    'and neither is one with no owner'
  );
  assert.strictEqual(record.advisoryFrom({ ...half, ref: 'git-utensils' })?.ref, null);
});

test('a cache record carries its packages, and one written before packages were read does not carry them', () => {
  const held = { comments: [], timeline: [] };
  const advisory = record.advisoryFrom({
    ...held,
    packages: [
      { ecosystem: 'go', name: 'example.com/drawer', affected: '< 1.2.0', patched: '1.2.0' },
      { ecosystem: 'other', name: '', affected: null },
      'npm',
    ],
  });
  assert.deepStrictEqual(advisory?.packages, [
    { ecosystem: 'go', name: 'example.com/drawer', affected: '< 1.2.0', patched: '1.2.0' },
    { ecosystem: 'other', name: null, affected: null, patched: null },
  ]);
  assert.strictEqual(record.advisoryFrom(held)?.packages, null);
});
