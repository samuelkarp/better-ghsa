'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const layout = require('../src/common/pr-layout.js');

test('private-fork diff routes identify the parent repository', () => {
  const base = '/git-utensils/Spoon-Knife-ghsa-jmvx-2wfw-xfgj/pull/1';
  for (const suffix of ['/changes', '/files', '/changes/abcdef', '/files/']) {
    assert.equal(layout.parentRepository(base + suffix), 'git-utensils/Spoon-Knife');
  }
  for (const route of [
    base, base + '/commits', base + '/changes/one/two',
    '/git-utensils/Spoon-Knife/pull/1/changes',
    '/git-utensils/Spoon-Knife-ghsa-invalid/pull/1/changes',
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj',
  ]) {
    assert.equal(layout.parentRepository(route), null, route);
  }
});

test('the layout rule selects the captured outer wrapper and retains viewer padding', () => {
  const html = fs.readFileSync(path.join(__dirname, '../testdata/private-pr-layout.html'), 'utf8');
  const { document } = parseHTML(html);
  const selector = layout.CSS.split('{')[0]?.trim();
  assert.ok(selector);
  const matches = document.querySelectorAll(selector);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.className, 'container-xl p-responsive');
  const viewer = document.getElementById('diff-comparison-viewer-container');
  assert.ok(viewer);
  assert.equal(viewer.matches(selector), false);
  assert.match(layout.CSS, /max-width:\s*none\s*!important/);
  assert.match(layout.CSS, /padding-left:\s*0\s*!important/);
  assert.match(layout.CSS, /padding-right:\s*0\s*!important/);
  viewer.remove();
  assert.equal(document.querySelectorAll(selector).length, 0);
});
