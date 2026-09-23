'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-list.js');

/**
 * @param {string} markup
 * @returns {Document}
 */
function document(markup) {
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(markup).document));
}

/**
 * @param {string} name
 * @returns {Document}
 */
function fixture(name) {
  return document(fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8'));
}

/**
 * @param {string} name
 * @returns {import('../src/common/parse-list.js').ParsedList}
 */
function list(name) {
  const parsed = parse.parseList(fixture(name));
  if (parsed === null) throw new Error(`${name} carries no advisory list`);
  return parsed;
}

/**
 * @param {import('../src/common/parse-list.js').ParsedList} parsed
 * @returns {import('../src/common/parse-list.js').ListRow}
 */
function onlyRow(parsed) {
  assert.strictEqual(parsed.rows.length, 1, 'the fixture holds one advisory');
  const row = parsed.rows[0];
  if (row === undefined) throw new Error('no row');
  return row;
}

test('a triage row carries the advisory the table paints before any fetch', () => {
  const row = onlyRow(list('list-page-triage.html'));
  assert.strictEqual(row.ghsaId, 'GHSA-jmvx-2wfw-xfgj');
  assert.strictEqual(row.owner, 'git-utensils');
  assert.strictEqual(row.repo, 'Spoon-Knife');
  assert.strictEqual(row.href, '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj');
  assert.strictEqual(row.title, 'Path traversal in drawer handler allows reading arbitrary files');
  assert.strictEqual(row.state, 'Triage');
  assert.strictEqual(row.severity, 'high');
  assert.strictEqual(row.severityLabel, 'High');
  assert.strictEqual(row.severityClass, 'Label--orange');
  assert.strictEqual(row.openedAt, '2026-08-25T22:15:18Z');
  assert.strictEqual(row.reporter, 'prakleumas');
});

test('a draft row carries no state Label and no severity', () => {
  // The draft row omits severity. Its tooltip supplies the advisory state.
  const row = onlyRow(list('list-page-draft.html'));
  assert.strictEqual(row.ghsaId, 'GHSA-5hg2-rfq2-8fm5');
  assert.strictEqual(row.title, 'Command injection in the sharpening scheduler');
  assert.strictEqual(row.state, 'Draft');
  assert.strictEqual(row.severity, null);
  assert.strictEqual(row.severityLabel, null);
  assert.strictEqual(row.severityClass, null);
  assert.strictEqual(row.openedAt, '2026-08-25T22:19:40Z');
  assert.strictEqual(row.reporter, 'samuelkarp');
});

test('the state tabs carry the corpus size of every state', () => {
  const parsed = list('list-page-triage.html');
  assert.deepStrictEqual(
    parsed.tabs.map((tab) => tab.state),
    ['triage', 'draft', 'published', 'closed']
  );
  assert.deepStrictEqual(
    parsed.tabs.map((tab) => tab.count),
    [1, 1, 0, 0]
  );
  assert.deepStrictEqual(
    parsed.tabs.map((tab) => tab.label),
    ['Triage', 'Draft', 'Published', 'Closed']
  );
  assert.strictEqual(
    parsed.tabs[0]?.href,
    '/git-utensils/Spoon-Knife/security/advisories?state=triage'
  );
  assert.strictEqual(parsed.owner, 'git-utensils');
  assert.strictEqual(parsed.repo, 'Spoon-Knife');
});

test('the open set is the two open tabs together', () => {
  const triage = list('list-page-triage.html');
  const draft = list('list-page-draft.html');
  assert.strictEqual(triage.selectedState, 'triage');
  assert.strictEqual(draft.selectedState, 'draft');
  assert.strictEqual(triage.openCount, 2);
  assert.strictEqual(draft.openCount, 2);
  assert.deepStrictEqual(parse.OPEN_STATES, ['triage', 'draft']);
});

test('a single page of results offers no next link', () => {
  assert.strictEqual(list('list-page-triage.html').next, null);
  assert.strictEqual(list('list-page-draft.html').next, null);
});

test('the tab a count cannot be read from reports no count', () => {
  const parsed = parse.parseList(
    document(`<div id="advisories"><segmented-control><ul>
      <li class="SegmentedControl-item SegmentedControl-item--selected">
        <a href="/o/r/security/advisories?state=triage" aria-current="true">Triage</a></li>
      <li class="SegmentedControl-item">
        <a href="/o/r/security/advisories?state=draft">1,204 Draft</a></li>
    </ul></segmented-control></div>`)
  );
  assert.strictEqual(parsed?.tabs.length, 2);
  assert.strictEqual(parsed?.tabs[0]?.count, null);
  assert.strictEqual(parsed?.tabs[0]?.label, 'Triage');
  assert.strictEqual(parsed?.tabs[0]?.selected, true);
  assert.strictEqual(parsed?.tabs[1]?.count, 1204);
  assert.strictEqual(parsed?.tabs[1]?.selected, false);
  assert.strictEqual(parsed?.openCount, null, 'one count unread leaves the open set unknown');
});

test('the next link walks the page number of the state showing', () => {
  // GitHub marks both the numbered link and Next button with rel="next".
  const parsed = parse.parseList(
    document(`<div id="advisories"><div class="paginate-container"><div class="pagination">
      <a rel="prev" href="/o/r/security/advisories?state=draft&amp;page=2">Previous</a>
      <a rel="next" href="/o/r/security/advisories?state=draft&amp;page=4">4</a>
      <a rel="next" href="/o/r/security/advisories?state=draft&amp;page=4">Next</a>
    </div></div></div>`)
  );
  assert.strictEqual(parsed?.next?.href, '/o/r/security/advisories?state=draft&page=4');
  assert.strictEqual(parsed?.next?.page, 4);
});

test('only a Label titled with the level names the severity', () => {
  // Both state and severity chips can use Label--secondary.
  // The title attribute identifies the severity chip.
  const stateOnly = parse.parseRow(
    element(`<div class="d-flex Box-row--drag-hide">
      <span class="tooltipped" aria-label="Triage advisory"></span>
      <a class="Link--primary" href="/o/r/security/advisories/GHSA-aaaa-bbbb-cccc">T</a>
      <span title="Triage" class="Label Label--secondary">Triage</span>
    </div>`)
  );
  assert.strictEqual(stateOnly?.state, 'Triage');
  assert.strictEqual(stateOnly?.severity, null);

  const both = parse.parseRow(
    element(`<div class="d-flex Box-row--drag-hide">
      <span class="tooltipped" aria-label="Triage advisory"></span>
      <a class="Link--primary" href="/o/r/security/advisories/GHSA-aaaa-bbbb-cccc">T</a>
      <span title="Triage" class="Label Label--secondary">Triage</span>
      <span class="Label Label--secondary">Low</span>
    </div>`)
  );
  assert.strictEqual(both?.severity, null, 'an untitled Label names no severity');
  assert.strictEqual(both?.severityLabel, null);
  assert.strictEqual(both?.severityClass, null);
});

test('the severity class is every Label modifier the chip carries', () => {
  const painted = parse.parseRow(
    element(`<div class="d-flex Box-row--drag-hide">
      <span class="tooltipped" aria-label="Triage advisory"></span>
      <a class="Link--primary" href="/o/r/security/advisories/GHSA-aaaa-bbbb-cccc">T</a>
      <span title="Severity: high" class="Label Label--orange mr-2 tmp-mr-2">High</span>
    </div>`)
  );
  assert.strictEqual(painted?.severityClass, 'Label--orange');

  const bare = parse.parseRow(
    element(`<div class="d-flex Box-row--drag-hide">
      <span class="tooltipped" aria-label="Triage advisory"></span>
      <a class="Link--primary" href="/o/r/security/advisories/GHSA-aaaa-bbbb-cccc">T</a>
      <span title="Severity: unknown" class="Label mr-2">Unknown</span>
    </div>`)
  );
  assert.strictEqual(bare?.severity, 'unknown');
  assert.strictEqual(bare?.severityClass, null, 'a chip with no modifier leaves nothing to reuse');
});

test('a document carrying no advisory list parses as none', () => {
  assert.strictEqual(parse.parseList(document('<div id="repo-content"></div>')), null);
});

test('the container element parses on its own', () => {
  // Soft navigation replaces the div#advisories subtree.
  const container = fixture('list-page-triage.html').querySelector('#advisories');
  assert.notStrictEqual(container, null);
  const parsed = container === null ? null : parse.parseList(container);
  assert.strictEqual(parsed?.rows.length, 1);
  assert.strictEqual(parsed?.rows[0]?.ghsaId, 'GHSA-jmvx-2wfw-xfgj');
});

/**
 * @param {string} markup
 * @returns {Element}
 */
function element(markup) {
  const first = document(`<div id="advisories">${markup}</div>`).querySelector(
    'div.Box-row--drag-hide'
  );
  if (first === null) throw new Error('no row in the markup');
  return first;
}
