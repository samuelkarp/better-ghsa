'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');
const merge = require('../src/common/merge.js');
const record = require('../src/common/record.js');
const schema = require('../src/common/schema.js');
const tracking = require('../src/detail/tracking.js');

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

const triage = advisory('triage-thread.html');
const draft = advisory('draft.html');

/**
 * The triage fixture scored with CVSS v4. GitHub then selects `cvss_v4` and
 * names its one vector input `cvss_v4`, with no `cvss_v3` input.
 *
 * @param {string} vector
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function scoredWithV4(vector) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', 'triage-thread.html'), 'utf8');
  /** @type {[string, string][]} */
  const edits = [
    ['<option selected="selected" value="cvss_v3">', '<option value="cvss_v3">'],
    ['<option value="cvss_v4">', '<option selected="selected" value="cvss_v4">'],
    [
      'name="repository_advisory[cvss_v3]" id="repository_advisory_cvss_v3" value="CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"',
      `name="repository_advisory[cvss_v4]" id="repository_advisory_cvss_v3" value="${vector}"`,
    ],
  ];
  let edited = html;
  for (const [from, to] of edits) {
    if (!edited.includes(from)) throw new Error(`the triage fixture no longer carries ${from}`);
    edited = edited.replace(from, to);
  }
  const root = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(edited).document));
  const parsed = parse.parseDetail(root);
  if (parsed === null) throw new Error('the v4 triage page is not an advisory detail page');
  return parsed;
}

const V4_VECTOR = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N';

/**
 * @param {string} fp
 * @returns {import('../src/detail/tracking.js').Fingerprints}
 */
function matching(fp) {
  return { title: fp, description: fp, scoring: fp };
}

test('an advisory no snapshot holds state for tracks nothing', () => {
  const view = tracking.untracked();
  assert.ok(view.triage === null, 'a triage value appeared from nowhere');
  assert.deepStrictEqual(view.owners, []);
  assert.deepStrictEqual(view.backports, []);
  assert.ok(view.embargo === false, 'an embargo appeared from nowhere');
  assert.ok(view.closureReason === null, 'a closure reason appeared from nowhere');
  assert.ok(view.title.status === 'unconfirmed', 'the title is not unconfirmed');
  assert.ok(view.description.status === 'unconfirmed', 'the description is not unconfirmed');
  assert.ok(view.scoring.status === 'unconfirmed', 'the scoring is not unconfirmed');
});

test('the stored tracks are read from the snapshot that holds state', () => {
  const view = tracking.read(
    {
      triage: 'awaiting reporter',
      triageSince: '2026-08-25T18:04:11Z',
      owners: ['samuelkarp', 'dmcgowan'],
      backports: ['release/2.1', 'release/1.7'],
      embargo: { lift: '2026-09-01' },
      closure: { reason: 'duplicate', duplicateOf: 'GHSA-cm76-qm8v-3j95' },
    },
    matching('ffffffffffff')
  );
  assert.ok(view.triage === 'awaiting reporter', 'the triage value did not read');
  assert.ok(view.triageSince === '2026-08-25T18:04:11Z', 'the triage time did not read');
  assert.deepStrictEqual(view.owners, ['samuelkarp', 'dmcgowan']);
  assert.deepStrictEqual(view.backports, ['release/2.1', 'release/1.7']);
  assert.ok(view.embargo === true, 'the embargo did not read');
  assert.ok(view.embargoLift === '2026-09-01', 'the lift date did not read');
  assert.ok(view.closureReason === 'duplicate', 'the closure reason did not read');
  assert.ok(
    view.closureDuplicateOf === 'GHSA-cm76-qm8v-3j95',
    'the duplicated advisory did not read'
  );
});

test('a triage value this reader does not interpret reads as it stands', () => {
  const view = tracking.read({ triage: 'awaiting the harvest' }, matching('ffffffffffff'));
  assert.ok(view.triage === 'awaiting the harvest', 'the raw value did not survive');
});

test('a field holding the wrong type says nothing', () => {
  const view = tracking.read(
    {
      triage: 7,
      owners: 'samuelkarp',
      backports: ['release/1.0', 4, ''],
      embargo: 'yes',
      closure: 'duplicate',
    },
    matching('ffffffffffff')
  );
  assert.ok(view.triage === null, 'a number read as a triage value');
  assert.deepStrictEqual(view.owners, []);
  assert.deepStrictEqual(view.backports, ['release/1.0']);
  assert.ok(view.embargo === false, 'a string read as an embargo');
  assert.ok(view.closureReason === null, 'a string read as a closure');
});

test('a confirmation whose fingerprint matches the current value is confirmed', () => {
  const view = tracking.read(
    {
      confirmed: {
        title: { by: 'samuelkarp', at: '2026-08-20T09:12:00Z', fp: '3f9a1c2e8b4d' },
      },
    },
    { title: '3f9a1c2e8b4d', description: null, scoring: 'a41b09ff3c7e' }
  );
  assert.ok(view.title.status === 'confirmed', 'a matching fingerprint did not confirm');
  assert.ok(view.title.by === 'samuelkarp', 'the confirming login did not read');
  assert.ok(view.title.at === '2026-08-20T09:12:00Z', 'the confirmation time did not read');
});

test('a confirmation whose fingerprint no longer matches has drifted', () => {
  const view = tracking.read(
    {
      confirmed: {
        title: { by: 'samuelkarp', at: '2026-08-20T09:12:00Z', fp: '3f9a1c2e8b4d' },
      },
    },
    { title: '77c0e5a1b930', description: null, scoring: null }
  );
  assert.ok(view.title.status === 'drifted', 'a changed value stayed confirmed');
  assert.ok(view.title.by === 'samuelkarp', 'who confirmed a different value was lost');
  assert.ok(view.title.at === '2026-08-20T09:12:00Z', 'when they confirmed it was lost');
});

test('a confirmation carrying no fingerprint confirms nothing', () => {
  const view = tracking.read(
    { confirmed: { title: { by: 'samuelkarp', at: '2026-08-20T09:12:00Z' } } },
    matching('3f9a1c2e8b4d')
  );
  assert.ok(view.title.status === 'unconfirmed', 'a record with no fingerprint confirmed');
  assert.ok(view.title.by === null, 'a record that confirms nothing named a login');
});

test('a confirmation whose current value could not be read is not checked', () => {
  const view = tracking.read(
    {
      confirmed: {
        description: { by: 'dmcgowan', at: '2026-08-20T09:12:00Z', fp: '77c0e5a1b930' },
      },
    },
    { title: null, description: null, scoring: 'a41b09ff3c7e' }
  );
  assert.ok(view.description.status === 'unreadable', 'an unread value was judged anyway');
  assert.ok(view.description.by === 'dmcgowan', 'the confirming login was lost');
});

test('the fingerprints come from the metadata form source values', async () => {
  const fingerprints = await tracking.fingerprints(triage);
  assert.ok(
    fingerprints.title === (await schema.fingerprint(triage.title)),
    'the title fingerprint is not the fingerprint of the title source'
  );
  assert.ok(fingerprints.title === '8ae5d80140a5', 'the title fingerprint changed');
  assert.ok(fingerprints.description === 'e9aec39df65a', 'the description fingerprint changed');
  assert.ok(
    fingerprints.scoring ===
      (await schema.scoringFingerprint(triage.severityField, triage.cvssV3)),
    'the scoring fingerprint does not cover the severity and the vector'
  );
  assert.ok(fingerprints.scoring === 'a42f036545e4', 'the scoring fingerprint changed');
});

test('a title the parser did not read has no fingerprint', async () => {
  const fingerprints = await tracking.fingerprints({ ...triage, title: null });
  assert.ok(fingerprints.title === null, 'an unread title fingerprinted anyway');
  assert.ok(fingerprints.description === 'e9aec39df65a', 'the description fingerprint changed');
});

test('an unset severity and an unset vector still fingerprint', async () => {
  const fingerprints = await tracking.fingerprints(draft);
  assert.ok(draft.severityField === null, 'the draft fixture carries a severity');
  assert.ok(draft.cvssV3 === null, 'the draft fixture carries a vector');
  assert.ok(fingerprints.scoring === 'a533e6b86c5c', 'the empty scoring fingerprint changed');
});

test('a CVSS v4 score binds its confirmation to the v4 vector', async () => {
  const scored = scoredWithV4(V4_VECTOR);
  const { scoring } = await tracking.fingerprints(scored);
  assert.ok(scoring !== null, 'a v4 score could not be confirmed');

  const confirmed = { confirmed: { scoring: { by: 'samuelkarp', at: '2026-09-28T10:00:00Z', fp: scoring } } };
  const same = tracking.read(confirmed, await tracking.fingerprints(scoredWithV4(V4_VECTOR)));
  assert.ok(same.scoring.status === 'confirmed', `the unchanged v4 score reads ${same.scoring.status}`);

  const rescored = scoredWithV4(V4_VECTOR.replace('VA:H', 'VA:L'));
  const moved = tracking.read(confirmed, await tracking.fingerprints(rescored));
  assert.ok(moved.scoring.status === 'drifted', `the rescored v4 vector reads ${moved.scoring.status}`);
});

test('a cached CVSS v4 advisory fingerprints its score as the page does', async () => {
  const scored = scoredWithV4(V4_VECTOR);
  const cached = record.advisoryFrom(JSON.parse(JSON.stringify(scored)));
  if (cached === null) throw new Error('the v4 advisory did not read back from the cache');
  const live = (await tracking.fingerprints(scored)).scoring;
  const held = (await tracking.fingerprints(cached)).scoring;
  assert.ok(live !== null && held === live, `the page fingerprints ${live}, the cache ${held}`);
});

test("the triage fixture's stored state drifted from its title", async () => {
  const merged = merge.mergeSnapshots(triage.comments);
  const view = await tracking.readAdvisory(triage, merged);
  assert.ok(view.triage === 'awaiting reporter', 'the triage value did not read');
  assert.deepStrictEqual(view.owners, ['samuelkarp']);
  assert.deepStrictEqual(view.backports, ['release/1.0']);
  assert.ok(view.embargoLift === '2026-09-30', 'the lift date did not read');
  assert.ok(view.title.status === 'drifted', 'the confirmed title did not drift');
  assert.ok(view.title.by === 'samuelkarp', 'who confirmed the title was lost');
  assert.ok(view.description.status === 'unconfirmed', 'the description confirmed itself');
  assert.ok(view.scoring.status === 'unconfirmed', 'the scoring confirmed itself');
});

test('a snapshot excluded from state tracks nothing', async () => {
  const merged = merge.mergeSnapshots(draft.comments);
  assert.ok(merged.state === null, 'the draft fixture merged to a state');
  const view = await tracking.readAdvisory(draft, merged);
  assert.ok(view.triage === null, 'an excluded snapshot supplied a triage value');
  assert.ok(view.title.status === 'unconfirmed', 'an excluded snapshot confirmed the title');
});
