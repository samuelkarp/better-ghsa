'use strict';

const test = require('node:test');
const assert = require('node:assert');

const schema = require('../src/common/schema.js');

test('a fence that does not parse is reported as carrying no ordering claim', () => {
  const report = schema.readSnapshot('{ "betterGhsa": "1.0", ');
  assert.strictEqual(report.parsed, null);
  assert.strictEqual(report.seq, null);
  assert.strictEqual(report.ordered, false);
  assert.strictEqual(report.valid, false);
  assert.deepStrictEqual(report.problems, ['the fenced block does not parse as JSON']);
});

test('a snapshot with no seq carries no ordering claim', () => {
  const report = schema.readSnapshot('{"betterGhsa":"1.0","by":"samuelkarp"}');
  assert.strictEqual(report.ordered, false);
  assert.strictEqual(report.valid, false);
  assert.deepStrictEqual(report.problems, ['seq is absent or is not a number']);

  const stringSeq = schema.readSnapshot('{"betterGhsa":"1.0","seq":"4"}');
  assert.strictEqual(stringSeq.ordered, false);
  assert.deepStrictEqual(stringSeq.problems, ['seq is absent or is not a number']);
});

test('a seq outside the range this reader orders carries no ordering claim', () => {
  for (const raw of [
    '{"betterGhsa":"1.0","seq":9007199254740992}',
    '{"betterGhsa":"1.0","seq":1e300}',
    '{"betterGhsa":"1.0","seq":9007199254740991}',
    '{"betterGhsa":"1.0","seq":-1}',
    '{"betterGhsa":"1.0","seq":2.5}',
  ]) {
    const report = schema.readSnapshot(raw);
    assert.strictEqual(report.ordered, false, `${raw} carried an ordering claim`);
    assert.strictEqual(report.seq, null, `${raw} yielded a seq`);
    assert.deepStrictEqual(
      report.problems,
      [`seq is not a whole number between 0 and ${schema.MAX_SEQ}`],
      `${raw} reported the wrong problem`
    );
  }

  const ceiling = schema.readSnapshot(`{"betterGhsa":"1.0","seq":${schema.MAX_SEQ}}`);
  assert.strictEqual(ceiling.ordered, true);
  assert.strictEqual(ceiling.seq, schema.MAX_SEQ);
  assert.strictEqual(Number.isSafeInteger(schema.MAX_SEQ + 1), true);
});

test('a readable seq survives a payload that fails validation', () => {
  const report = schema.readSnapshot(
    '{"betterGhsa":"1.0","seq":4,"by":"samuelkarp","owners":"samuelkarp"}'
  );
  assert.strictEqual(report.seq, 4);
  assert.strictEqual(report.by, 'samuelkarp');
  assert.strictEqual(report.ordered, true);
  assert.strictEqual(report.valid, false);
  assert.deepStrictEqual(report.problems, ['owners is not an array of strings']);
});

test('an unrecognized value in a known enum field is named, not rejected', () => {
  const report = schema.readSnapshot(
    '{"betterGhsa":"1.0","seq":1,"triage":"marinating","closure":{"reason":"lost the fork"}}'
  );
  assert.strictEqual(report.valid, true);
  assert.deepStrictEqual(report.problems, []);
  assert.deepStrictEqual(report.unrecognized, ['triage', 'closure.reason']);

  const payload = /** @type {Record<string, unknown>} */ (report.parsed);
  assert.strictEqual(payload['triage'], 'marinating');
  const closure = /** @type {Record<string, unknown>} */ (payload['closure']);
  assert.strictEqual(closure['reason'], 'lost the fork');
});

test('an unknown field passes validation and stays in the payload', () => {
  const report = schema.readSnapshot(
    '{"betterGhsa":"1.0","seq":1,"cutleryPolicy":{"sharpened":true}}'
  );
  assert.strictEqual(report.valid, true);
  assert.deepStrictEqual(report.problems, []);
  assert.deepStrictEqual(report.unrecognized, []);

  const payload = /** @type {Record<string, unknown>} */ (report.parsed);
  const policy = /** @type {Record<string, unknown>} */ (payload['cutleryPolicy']);
  assert.strictEqual(policy['sharpened'], true);
});

test('a schema major this reader does not know is reported as unsupported', () => {
  const report = schema.readSnapshot('{"betterGhsa":"2.0","seq":9}');
  assert.strictEqual(report.major, 2);
  assert.strictEqual(report.schemaSupported, false);
  assert.strictEqual(report.valid, true);

  const known = schema.readSnapshot('{"betterGhsa":"1.4","seq":9}');
  assert.strictEqual(known.major, 1);
  assert.strictEqual(known.schemaSupported, true);
});

test('a payload naming no readable version fails validation and is not a version gap', () => {
  const cases = [
    ['{"seq":3}', 'betterGhsa is not a string'],
    ['{"betterGhsa":1,"seq":3}', 'betterGhsa is not a string'],
    ['{"betterGhsa":"soon","seq":3}', 'betterGhsa is not a major.minor version'],
    ['{"betterGhsa":"1","seq":3}', 'betterGhsa is not a major.minor version'],
    ['{"betterGhsa":"1.0.1","seq":3}', 'betterGhsa is not a major.minor version'],
  ];
  for (const [raw, problem] of cases) {
    const report = schema.readSnapshot(/** @type {string} */ (raw));
    assert.strictEqual(report.major, null, `${raw} yielded a major`);
    assert.strictEqual(report.ordered, true, `${raw} lost its ordering claim`);
    assert.strictEqual(report.valid, false, `${raw} passed validation`);
    assert.strictEqual(
      report.schemaSupported,
      true,
      `${raw} was read as a schema version this reader is too old for`
    );
    assert.deepStrictEqual(report.problems, [problem], `${raw} reported the wrong problem`);
  }
});

test('a confirmation fingerprint is validated on its shape, and an absent one passes', () => {
  /** @type {[string, string | null, string[]][]} */
  const cases = [
    ['a number', '12', ['confirmed.title.fp is not a string']],
    ['too few hex characters', '"3f9a1c2e8b4"', ['confirmed.title.fp is not a fingerprint']],
    ['too many', '"3f9a1c2e8b4d0"', ['confirmed.title.fp is not a fingerprint']],
    ['a character that is not hex', '"3f9a1c2e8b4z"', ['confirmed.title.fp is not a fingerprint']],
    ['upper case hex', '"3F9A1C2E8B4D"', ['confirmed.title.fp is not a fingerprint']],
    ['the empty string', '""', ['confirmed.title.fp is not a fingerprint']],
    ['no fingerprint at all', null, []],
  ];
  for (const [name, fp, problems] of cases) {
    const record =
      fp === null ? '{"by":"dmcgowan","at":"x"}' : `{"by":"dmcgowan","at":"x","fp":${fp}}`;
    const report = schema.readSnapshot(
      `{"betterGhsa":"1.0","seq":1,"confirmed":{"title":${record}}}`
    );
    assert.deepStrictEqual(report.problems, problems, `${name} reported the wrong problem`);
    assert.strictEqual(report.valid, problems.length === 0, `${name} was judged wrong`);
  }
});

test('a fingerprint this writer produces passes validation', async () => {
  const fp = await schema.fingerprint('the advisory title');
  assert.match(fp, schema.FINGERPRINT_PATTERN);
  const report = schema.readSnapshot(
    `{"betterGhsa":"1.0","seq":1,"confirmed":{"title":{"by":"dmcgowan","fp":"${fp}"}}}`
  );
  assert.deepStrictEqual(report.problems, []);
  assert.strictEqual(report.valid, true);
});

test('normalization settles line endings, trailing space, outer blanks, and NFC', () => {
  /** @type {[string, string, string][]} */
  const cases = [
    ['CRLF becomes LF', 'one\r\ntwo\r\n\r\nthree', 'one\ntwo\n\nthree'],
    ['trailing whitespace goes from every line', 'one   \ntwo\t\nthree ', 'one\ntwo\nthree'],
    ['leading whitespace stays', '  indented  ', '  indented'],
    ['leading and trailing blank lines are trimmed', '\n \n\nbody\n\n  \n', 'body'],
    ['interior blank lines are kept', 'one\n\n\ntwo', 'one\n\n\ntwo'],
    ['a value of nothing but blank lines normalizes to empty', '\n\n \n', ''],
    ['a decomposed accent is composed', 'café', 'café'],
  ];
  for (const [name, raw, normalized] of cases) {
    assert.strictEqual(schema.normalize(raw), normalized, name);
  }
  assert.ok('café'.length === 4, 'the composed expectation is not NFC');
});

test('a fingerprint is twelve hex characters of the SHA-256 of the normalized value', async () => {
  const empty = await schema.fingerprint('');
  /** @type {[string, string | null | undefined, string][]} */
  const cases = [
    ['the value as written', 'hello world', 'b94d27b9934d'],
    ['the same value needing normalization', '\r\nhello world  \r\n\r\n', 'b94d27b9934d'],
    ['a decomposed accent', 'café', '850f7dc43910'],
    ['the same accent composed', 'café', '850f7dc43910'],
    ['a value that is absent', null, empty],
    ['a value that was never set', undefined, empty],
  ];
  for (const [name, raw, fp] of cases) {
    assert.strictEqual(await schema.fingerprint(raw), fp, name);
  }
});

test('the scoring source labels each half and writes an absent half empty', () => {
  assert.strictEqual(
    schema.scoringSource('cvss_v3', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N'),
    'severity="cvss_v3"\ncvss="CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"'
  );
  assert.strictEqual(schema.scoringSource('moderate', null), 'severity="moderate"\ncvss=""');
  assert.strictEqual(schema.scoringSource(null, null), 'severity=""\ncvss=""');
});

test('a newline in one scoring half cannot imitate the separator', async () => {
  const inSeverity = schema.scoringSource('low\ncvss=x', '');
  const inVector = schema.scoringSource('low', 'x\ncvss=');
  assert.notStrictEqual(inSeverity, inVector, 'two scoring states share one source value');
  assert.notStrictEqual(
    await schema.scoringFingerprint('low\ncvss=x', ''),
    await schema.scoringFingerprint('low', 'x\ncvss='),
    'two scoring states share one fingerprint'
  );
});

test('the scoring fingerprint covers severity and vector together', async () => {
  const severityOnly = await schema.scoringFingerprint('moderate', null);
  assert.strictEqual(severityOnly, 'fa0dd8eb9e2a');
  assert.strictEqual(
    await schema.scoringFingerprint('cvss_v3', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N'),
    'a42f036545e4'
  );
  assert.strictEqual(await schema.scoringFingerprint(null, null), 'a533e6b86c5c');

  const changed = await schema.scoringFingerprint('high', null);
  assert.ok(changed !== severityOnly, 'a changed severity kept its fingerprint');
});
