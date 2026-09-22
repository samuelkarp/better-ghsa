'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const schema = require('../src/common/schema.js');
const parse = require('../src/common/parse-detail.js');
const merge = require('../src/common/merge.js');

/**
 * @param {string} name
 * @returns {Document}
 */
function fixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

/**
 * @param {string} id
 * @param {string} author
 * @param {boolean} trusted
 * @param {string} raw
 * @returns {import('../src/common/merge.js').SnapshotSource}
 */
function source(id, author, trusted, raw) {
  return {
    id,
    elementId: `advisory-comment-${id}`,
    author,
    trusted,
    stateComment: schema.readSnapshot(raw),
  };
}

/**
 * @param {number} seq
 * @param {string} by
 * @param {string} [triage]
 * @returns {string}
 */
function snapshotJson(seq, by, triage) {
  return JSON.stringify({
    betterGhsa: '1.0',
    seq,
    by,
    at: '2026-08-25T18:04:11Z',
    triage: triage ?? 'evaluating',
  });
}

test('the merged state is the trusted snapshot with the highest seq', () => {
  const merged = merge.mergeSnapshots([
    source('11', 'dmcgowan', true, snapshotJson(1, 'dmcgowan', 'evaluating')),
    source('12', 'samuelkarp', true, snapshotJson(5, 'samuelkarp', 'awaiting reporter')),
    source('13', 'dmcgowan', true, snapshotJson(3, 'dmcgowan', 'awaiting maintainer input')),
  ]);
  assert.strictEqual(merged.seq, 5);
  assert.strictEqual(merged.source?.id, '12');
  assert.strictEqual(merged.state?.['triage'], 'awaiting reporter');
  assert.strictEqual(merged.observedSeq, 5);
  assert.strictEqual(merged.nextSeq, 6);
  assert.strictEqual(merged.warnings.length, 0);
});

test('the highest seq holds state over the greater login', () => {
  // Sequence number precedes login in the snapshot order (REQUIREMENTS.md section 3).
  // These values make the two criteria produce opposite orders.
  const stale = source('11', 'zeta', true, snapshotJson(1, 'zeta', 'awaiting reporter'));
  const current = source('12', 'alpha', true, snapshotJson(9, 'alpha', 'evaluating'));

  for (const order of [[stale, current], [current, stale]]) {
    const merged = merge.mergeSnapshots(order);
    assert.strictEqual(merged.seq, 9, 'the lower seq holds state');
    assert.strictEqual(merged.source?.author, 'alpha');
    assert.strictEqual(merged.state?.['triage'], 'evaluating');
  }

  assert.ok(merge.compareLogins('zeta', 'alpha') > 0, 'the logins do not oppose the seq');
});

test('a tie on seq goes to the greater login in code point order', () => {
  const alpha = source('11', 'alpha', true, snapshotJson(4, 'alpha', 'evaluating'));
  const zeta = source('12', 'zeta', true, snapshotJson(4, 'zeta', 'awaiting reporter'));
  const Zulu = source('13', 'Zulu', true, snapshotJson(4, 'Zulu', 'awaiting maintainer input'));

  assert.strictEqual(merge.mergeSnapshots([alpha, zeta]).source?.author, 'zeta');
  assert.strictEqual(merge.mergeSnapshots([zeta, alpha]).source?.author, 'zeta');

  // Every upper case letter sorts below every lower case one by code point.
  assert.strictEqual(merge.mergeSnapshots([alpha, Zulu]).source?.author, 'alpha');
  assert.strictEqual(merge.mergeSnapshots([Zulu, alpha]).source?.author, 'alpha');
});

test('a tie is resolved by code point, not by UTF-16 code unit', () => {
  // 'Ａ' is U+FF21 and sorts above the surrogate pair by code unit and below
  // U+10000 by code point.
  const astral = source('11', '\u{10000}', true, snapshotJson(4, '\u{10000}', 'evaluating'));
  const wide = source('12', '\uFF21', true, snapshotJson(4, '\uFF21', 'awaiting reporter'));

  assert.strictEqual(merge.mergeSnapshots([astral, wide]).source?.id, '11');
  assert.strictEqual(merge.mergeSnapshots([wide, astral]).source?.id, '11');
  assert.ok(merge.compareLogins('\u{10000}', '\uFF21') > 0, 'the comparison is not by code point');
  assert.ok(merge.compareLogins('samuel', 'samuelkarp') < 0, 'a prefix does not sort first');
  assert.strictEqual(merge.compareLogins('dmcgowan', 'dmcgowan'), 0);
});

test('a tie is resolved on the comment author, with the payload standing in', () => {
  const named = source('11', 'alpha', true, snapshotJson(4, 'zzz', 'evaluating'));
  const other = source('12', 'beta', true, snapshotJson(4, 'aaa', 'awaiting reporter'));
  assert.strictEqual(
    merge.mergeSnapshots([named, other]).source?.id,
    '12',
    'the tie was resolved on the login the payload names'
  );

  const anonymous = source('13', 'zeta', true, snapshotJson(4, 'zeta'));
  anonymous.author = null;
  const known = source('14', 'alpha', true, snapshotJson(4, 'alpha'));
  assert.strictEqual(
    merge.mergeSnapshots([anonymous, known]).source?.id,
    '13',
    'the payload did not stand in for the missing author'
  );
});

test('a fence that carries no ordering claim is warned on and writing continues', () => {
  const merged = merge.mergeSnapshots([
    source('11', 'samuelkarp', true, '{ "betterGhsa": "1.0", '),
    source('12', 'dmcgowan', true, snapshotJson(2, 'dmcgowan')),
  ]);
  assert.strictEqual(merged.warnings.length, 1);
  assert.strictEqual(merged.warnings[0]?.kind, 'not a snapshot');
  assert.strictEqual(merged.warnings[0]?.commentId, '11');
  assert.strictEqual(merged.warnings[0]?.message, 'the fenced block does not parse as JSON');
  assert.strictEqual(merged.confirmationRequired, false);
  assert.strictEqual(merged.source?.id, '12');
  assert.strictEqual(merged.observedSeq, 2);
  assert.strictEqual(merged.nextSeq, 3);
});

test('a readable seq with an invalid payload is excluded and takes a confirmation', () => {
  const merged = merge.mergeSnapshots([
    source('11', 'samuelkarp', true, '{"betterGhsa":"1.0","seq":9,"by":"samuelkarp","owners":"x"}'),
    source('12', 'dmcgowan', true, snapshotJson(2, 'dmcgowan')),
  ]);
  assert.strictEqual(merged.warnings.length, 1);
  assert.strictEqual(merged.warnings[0]?.kind, 'invalid payload');
  assert.strictEqual(merged.warnings[0]?.commentId, '11');
  assert.strictEqual(merged.warnings[0]?.message, 'owners is not an array of strings');
  assert.strictEqual(merged.confirmationRequired, true);
  assert.strictEqual(merged.source?.id, '12');
  assert.strictEqual(merged.observedSeq, 9);
  assert.strictEqual(merged.nextSeq, 10, 'the next write does not outrank the excluded snapshot');

  const both = merge.mergeSnapshots([
    source('11', 'samuelkarp', true, '{"betterGhsa":"1.0","seq":9,"by":"samuelkarp","owners":"x"}'),
    source('12', 'dmcgowan', true, '{"betterGhsa":"1.0","seq":4,"by":"dmcgowan","backports":3}'),
  ]);
  assert.deepStrictEqual(
    both.warnings.map((warning) => `${warning.kind} ${warning.commentId}`),
    ['invalid payload 11', 'invalid payload 12']
  );
  assert.strictEqual(both.state, null, 'a snapshot the reader would not take held state');
  assert.strictEqual(both.confirmationRequired, true);
});

test('a schema major this reader does not know puts the advisory read-only', () => {
  const merged = merge.mergeSnapshots([
    source('11', 'samuelkarp', true, '{"betterGhsa":"2.0","seq":4,"by":"samuelkarp"}'),
  ]);
  assert.strictEqual(merged.readOnly, true);
  assert.strictEqual(merged.state, null);
  assert.strictEqual(merged.warnings[0]?.kind, 'unsupported schema');
  assert.strictEqual(merged.warnings[0]?.message, 'Schema version 2.0');
  assert.strictEqual(merged.confirmationRequired, false);

  const known = merge.mergeSnapshots([source('11', 'samuelkarp', true, snapshotJson(4, 'x'))]);
  assert.strictEqual(known.readOnly, false);
});

test('one snapshot in a newer schema puts the whole advisory read-only', () => {
  // An unsupported snapshot may be current. Preserve readable state
  // and block writes until the unsupported version can be read.
  const merged = merge.mergeSnapshots([
    source('11', 'samuelkarp', true, snapshotJson(4, 'samuelkarp', 'evaluating')),
    source('12', 'dmcgowan', true, '{"betterGhsa":"2.0","seq":5,"by":"dmcgowan"}'),
  ]);
  assert.strictEqual(merged.readOnly, true, 'the advisory took a write over an unread claim');
  assert.strictEqual(merged.state?.['triage'], 'evaluating', 'the readable snapshot was dropped');
  assert.strictEqual(merged.source?.id, '11');
  assert.strictEqual(merged.observedSeq, 5, 'the unread claim did not order the advisory');
  assert.deepStrictEqual(
    merged.warnings.map((warning) => warning.kind),
    ['unsupported schema']
  );
});

test('a snapshot on a schema this reader cannot read is not judged by its fields', () => {
  const merged = merge.mergeSnapshots([
    source('11', 'samuelkarp', true, '{"betterGhsa":"2.0","seq":4,"by":"samuelkarp","owners":"x"}'),
  ]);
  assert.strictEqual(merged.readOnly, true);
  assert.strictEqual(merged.confirmationRequired, false);
  assert.strictEqual(merged.warnings.length, 1);
  assert.strictEqual(merged.warnings[0]?.kind, 'unsupported schema');
});

test('a trusted snapshot naming no readable version is excluded, not read-only', () => {
  const payloads = [
    '{"seq":3,"by":"samuelkarp"}',
    '{"betterGhsa":"soon","seq":3,"by":"samuelkarp"}',
    '{"betterGhsa":1,"seq":3,"by":"samuelkarp"}',
    '{"betterGhsa":"1","seq":3,"by":"samuelkarp"}',
  ];
  for (const raw of payloads) {
    const merged = merge.mergeSnapshots([source('11', 'samuelkarp', true, raw)]);
    assert.strictEqual(merged.readOnly, false, `${raw} locked writing on the advisory`);
    assert.strictEqual(merged.confirmationRequired, true, `${raw} took no confirmation`);
    assert.strictEqual(merged.state, null, `${raw} was read as state`);
    assert.strictEqual(merged.nextSeq, 4, `${raw} did not order the next write`);
    assert.strictEqual(merged.warnings.length, 1, `${raw} raised the wrong count of warnings`);
    assert.strictEqual(merged.warnings[0]?.kind, 'invalid payload', `${raw} was warned on wrongly`);
  }
});

test('an untrusted snapshot is ignored, warned on, and still orders writes', () => {
  const merged = merge.mergeSnapshots([
    source('11', 'prakleumas', false, snapshotJson(7, 'prakleumas', 'evaluating')),
    source('12', 'samuelkarp', true, snapshotJson(3, 'samuelkarp', 'awaiting reporter')),
  ]);
  assert.strictEqual(merged.state?.['triage'], 'awaiting reporter');
  assert.strictEqual(merged.warnings.length, 1);
  assert.strictEqual(merged.warnings[0]?.kind, 'untrusted');
  assert.strictEqual(merged.warnings[0]?.author, 'prakleumas');
  assert.strictEqual(merged.warnings[0]?.message, '');
  assert.strictEqual(merged.nextSeq, 8);
});

test('a seq beyond the range this reader orders does not stall the next write', () => {
  const merged = merge.mergeSnapshots([
    source('11', 'samuelkarp', true, '{"betterGhsa":"1.0","seq":9007199254740992,"by":"a"}'),
    source('12', 'dmcgowan', true, snapshotJson(4, 'dmcgowan')),
  ]);
  assert.strictEqual(merged.warnings.length, 1);
  assert.strictEqual(merged.warnings[0]?.kind, 'not a snapshot');
  assert.strictEqual(merged.observedSeq, 4);
  assert.strictEqual(merged.nextSeq, 5);
  assert.strictEqual(merged.source?.id, '12');
});

test('the next write outranks a snapshot at the highest claim this reader reads', () => {
  const merged = merge.mergeSnapshots([
    source('11', 'samuelkarp', true, `{"betterGhsa":"1.0","seq":${schema.MAX_SEQ},"by":"a"}`),
  ]);
  assert.strictEqual(merged.observedSeq, schema.MAX_SEQ);
  assert.strictEqual(merged.nextSeq, schema.MAX_SEQ + 1);
  assert.ok(merged.nextSeq > merged.observedSeq, 'the next write does not outrank the advisory');
  assert.strictEqual(Number.isSafeInteger(merged.nextSeq), true, 'the next claim is not exact');
});

test('a comment holding no state comment raises nothing', () => {
  const merged = merge.mergeSnapshots([
    { id: '11', elementId: 'advisory-comment-11', author: 'x', trusted: true, stateComment: null },
  ]);
  assert.strictEqual(merged.state, null);
  assert.strictEqual(merged.seq, null);
  assert.strictEqual(merged.warnings.length, 0);
  assert.strictEqual(merged.nextSeq, 1);
});

test('the state comments on the triage advisory merge to the member snapshot', () => {
  const advisory = parse.parseDetail(fixture('triage-thread.html'));
  if (advisory === null) throw new Error('triage-thread.html did not parse');
  const merged = merge.mergeSnapshots(advisory.comments);

  assert.strictEqual(merged.seq, 3);
  assert.strictEqual(merged.source?.author, 'samuelkarp');
  assert.strictEqual(merged.state?.['triage'], 'awaiting reporter');
  assert.strictEqual(merged.readOnly, false);
  assert.strictEqual(merged.confirmationRequired, false);

  assert.strictEqual(merged.observedSeq, 7);
  assert.strictEqual(merged.nextSeq, 8);
  assert.strictEqual(merged.warnings.length, 1);
  assert.strictEqual(merged.warnings[0]?.kind, 'untrusted');
  assert.strictEqual(merged.warnings[0]?.author, 'prakleumas');
});

test('a write over the triage advisory carries its unknown field forward', () => {
  const advisory = parse.parseDetail(fixture('triage-thread.html'));
  if (advisory === null) throw new Error('triage-thread.html did not parse');
  const merged = merge.mergeSnapshots(advisory.comments);

  const written = merge.nextSnapshot(
    merged.state,
    { triage: 'evaluating' },
    { by: 'dmcgowan', at: '2026-08-26T09:00:00Z', seq: merged.nextSeq }
  );
  assert.strictEqual(written['seq'], 8);
  assert.strictEqual(written['by'], 'dmcgowan');
  assert.strictEqual(written['triage'], 'evaluating');

  const policy = /** @type {Record<string, unknown>} */ (written['cutleryPolicy']);
  assert.strictEqual(policy['sharpened'], true);
  const embargo = /** @type {Record<string, unknown>} */ (written['embargo']);
  assert.strictEqual(embargo['lift'], '2026-09-30');

  const reread = schema.readSnapshot(JSON.stringify(written));
  assert.strictEqual(reread.valid, true);
  assert.strictEqual(reread.seq, 8);
});

test('an unrecognized enum value survives a read-merge-write untouched', () => {
  const current = /** @type {Record<string, unknown>} */ (
    schema.readSnapshot('{"betterGhsa":"1.0","seq":2,"by":"x","triage":"marinating"}').parsed
  );
  const written = merge.nextSnapshot(
    current,
    { owners: ['dmcgowan'] },
    { by: 'dmcgowan', at: '2026-08-26T09:00:00Z', seq: 3 }
  );
  assert.strictEqual(written['triage'], 'marinating');
  const owners = /** @type {string[]} */ (written['owners']);
  assert.strictEqual(owners.join(','), 'dmcgowan');
});

test('a change merges into a known object without dropping its other fields', () => {
  const written = merge.nextSnapshot(
    { closure: { reason: 'duplicate', duplicateOf: 'GHSA-cm76-qm8v-3j95', note: 'kept' } },
    { closure: { reason: 'out of scope' } },
    { by: 'dmcgowan', at: '2026-08-26T09:00:00Z', seq: 2 }
  );
  const closure = /** @type {Record<string, unknown>} */ (written['closure']);
  assert.strictEqual(closure['reason'], 'out of scope');
  assert.strictEqual(closure['duplicateOf'], 'GHSA-cm76-qm8v-3j95');
  assert.strictEqual(closure['note'], 'kept');
});

test('null removes a field and the snapshot read forward is left alone', () => {
  const current = { betterGhsa: '1.0', seq: 1, by: 'x', embargo: { lift: '2026-09-01' } };
  const written = merge.nextSnapshot(
    current,
    { embargo: null },
    { by: 'dmcgowan', at: '2026-08-26T09:00:00Z', seq: 2 }
  );
  assert.strictEqual('embargo' in written, false);
  assert.strictEqual(current.embargo.lift, '2026-09-01', 'the merge wrote through to its input');
  assert.strictEqual(current.seq, 1, 'the merge stamped its input');
});

test('a __proto__ key in changes lands as an own field and sets no prototype', () => {
  const changes = /** @type {Record<string, unknown>} */ (
    JSON.parse('{"__proto__":{"polluted":true}}')
  );
  const written = merge.nextSnapshot(null, changes, {
    by: 'dmcgowan',
    at: '2026-08-26T09:00:00Z',
    seq: 1,
  });

  assert.strictEqual(Object.hasOwn(written, '__proto__'), true, 'the field was dropped');
  assert.strictEqual(
    Object.getPrototypeOf(written),
    Object.prototype,
    'the written snapshot took the prototype it was handed'
  );
  const carried = /** @type {Record<string, unknown>} */ (
    Object.getOwnPropertyDescriptor(written, '__proto__')?.value
  );
  assert.strictEqual(carried['polluted'], true, 'the change did not land');
  assert.strictEqual(
    /** @type {Record<string, unknown>} */ ({})['polluted'],
    undefined,
    'Object.prototype was polluted'
  );
  assert.ok(
    JSON.stringify(written).includes('"__proto__"'),
    `the written snapshot read: ${JSON.stringify(written)}`
  );
});

test('a __proto__ key the base holds survives the merge under it', () => {
  const base = /** @type {Record<string, unknown>} */ (
    JSON.parse('{"betterGhsa":"1.0","seq":1,"__proto__":{"kept":true}}')
  );
  const changes = /** @type {Record<string, unknown>} */ (
    JSON.parse('{"__proto__":{"added":true}}')
  );
  const written = merge.nextSnapshot(base, changes, {
    by: 'dmcgowan',
    at: '2026-08-26T09:00:00Z',
    seq: 2,
  });

  const carried = /** @type {Record<string, unknown>} */ (
    Object.getOwnPropertyDescriptor(written, '__proto__')?.value
  );
  assert.strictEqual(carried['kept'], true, 'the field the base held did not survive');
  assert.strictEqual(carried['added'], true, 'the change did not land');
});

test('a written snapshot shares no object with the state or the changes', () => {
  const current = /** @type {Record<string, unknown>} */ (
    JSON.parse('{"betterGhsa":"1.0","seq":1,"by":"x","embargo":{"lift":"2026-09-01"}}')
  );
  const changes = { closure: { reason: 'duplicate' }, backports: ['release/2.1'] };
  const written = merge.nextSnapshot(current, changes, {
    by: 'dmcgowan',
    at: '2026-08-26T09:00:00Z',
    seq: 2,
  });

  assert.notStrictEqual(written['embargo'], current['embargo'], 'the embargo object is shared');
  assert.notStrictEqual(written['closure'], changes.closure, 'the closure object is shared');
  assert.notStrictEqual(written['backports'], changes.backports, 'the backports array is shared');

  const embargo = /** @type {Record<string, unknown>} */ (written['embargo']);
  embargo['lift'] = '2026-10-01';
  const backports = /** @type {string[]} */ (written['backports']);
  backports.push('release/1.7');
  const closure = /** @type {Record<string, unknown>} */ (written['closure']);
  closure['reason'] = 'out of scope';

  const held = /** @type {Record<string, unknown>} */ (current['embargo']);
  assert.strictEqual(held['lift'], '2026-09-01', 'a change to the written snapshot reached state');
  const reached = 'a change to the written snapshot reached the changes it was built from';
  assert.strictEqual(changes.backports.length, 1, reached);
  assert.strictEqual(changes.closure.reason, 'duplicate', reached);
});

test('the first write on an advisory with no state carries a full envelope', () => {
  const written = merge.nextSnapshot(
    null,
    { triage: 'evaluating', owners: [] },
    { by: 'samuelkarp', at: '2026-08-26T09:00:00Z', seq: 1 }
  );
  assert.strictEqual(written['betterGhsa'], schema.SCHEMA_VERSION);
  assert.strictEqual(written['seq'], 1);
  assert.strictEqual(written['by'], 'samuelkarp');
  assert.strictEqual(written['at'], '2026-08-26T09:00:00Z');

  const reread = schema.readSnapshot(JSON.stringify(written));
  assert.strictEqual(reread.valid, true);
  assert.deepStrictEqual(reread.problems, []);
});
