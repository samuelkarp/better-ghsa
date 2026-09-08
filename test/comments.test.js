'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');
const merge = require('../src/common/merge.js');
const comments = require('../src/detail/comments.js');
const panel = require('../src/detail/panel.js');

const CHIP = `[${parse.EXTENSION_CHIP_ATTRIBUTE}]`;

/**
 * @param {string} name
 * @returns {Document}
 */
function parseFixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

/** The one parse of each large fixture in this file. */
const triageDoc = parseFixture('triage-thread.html');
const draftDoc = parseFixture('draft.html');

/**
 * @param {Document} doc
 * @returns {import('../src/common/merge.js').MergedState}
 */
function mergeOf(doc) {
  const advisory = parse.parseDetail(doc);
  if (advisory === null) throw new Error('the document is not an advisory detail page');
  return merge.mergeSnapshots(advisory.comments);
}

/**
 * @param {Element | null} node
 * @returns {string}
 */
function text(node) {
  return String(node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * A merged state carrying `warnings` and nothing else, which is what marking
 * the comments reads.
 *
 * @param {import('../src/common/merge.js').MergeWarning[]} warnings
 * @returns {import('../src/common/merge.js').MergedState}
 */
function merged(warnings) {
  return {
    state: null,
    source: null,
    seq: null,
    observedSeq: 0,
    nextSeq: 1,
    warnings,
    readOnly: false,
    confirmationRequired: false,
  };
}

/**
 * @param {string} id
 * @param {import('../src/common/merge.js').WarningKind} kind
 * @returns {import('../src/common/merge.js').MergeWarning}
 */
function alert(id, kind) {
  return {
    kind,
    commentId: id,
    elementId: `advisory-comment-${id}`,
    author: 'prakleumas',
    message: `prakleumas's comment ${id} says something this extension will not take`,
  };
}

/**
 * A document holding one comment, with or without the role badge GitHub wraps
 * in a tooltip.
 *
 * @param {string} id
 * @param {boolean} badged
 * @returns {Document}
 */
function commentPage(id, badged) {
  const badge = badged
    ? '<span class="tooltipped tooltipped-n"><span class="Label">Author</span></span>'
    : '';
  const html = [
    '<!doctype html><html><body>',
    `<div class="timeline-comment-group" id="advisory-comment-${id}">`,
    '<div class="timeline-comment">',
    '<div class="timeline-comment-header">',
    '<h3 class="f5">prakleumas commented</h3>',
    badge,
    '</div>',
    '<div class="comment-body markdown-body js-comment-body">a body</div>',
    '</div></div></body></html>',
  ].join('');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

test('a snapshot from a non-member marks the comment it came from', () => {
  const placed = comments.markComments(triageDoc, mergeOf(triageDoc));
  assert.strictEqual(placed.length, 1);
  const chip = /** @type {Element} */ (placed[0]);
  assert.strictEqual(text(chip), 'Ignored: non-member state');
  assert.strictEqual(chip.getAttribute('class'), 'Label Label--secondary bghsa-tone-danger');
  const group = chip.closest('div.timeline-comment-group');
  assert.ok(group?.id === 'advisory-comment-282848', 'the chip is on the wrong comment');
});

test('the chip on a non-member comment carries no tooltip', () => {
  const chip = triageDoc.querySelector(CHIP);
  assert.ok(chip !== null, 'the non-member comment lost its chip');
  assert.strictEqual(chip.getAttribute('title'), null);
  assert.strictEqual(chip.textContent, 'Ignored: non-member state');
});

test('a re-read does not take the chip for a role badge', () => {
  const advisory = parse.parseDetail(triageDoc);
  const comment = advisory?.comments.find((entry) => entry.id === '282848');
  assert.ok(comment !== undefined, 'the marked comment went missing');
  assert.deepStrictEqual(comment.roles, ['Author']);
  assert.ok(comment.role === 'Author', `the role reads ${String(comment.role)}`);
  assert.ok(comment.trusted === false, 'a chip made an author trusted');
});

test('a second pass over an unchanged document changes nothing', () => {
  const before = triageDoc.querySelector(CHIP);
  const placed = comments.markComments(triageDoc, mergeOf(triageDoc));
  assert.strictEqual(placed.length, 1);
  assert.strictEqual(triageDoc.querySelectorAll(CHIP).length, 1);
  // The same node, so a pass over an unchanged document raises no mutation and
  // cannot feed the observer that called it.
  assert.ok(placed[0] === before, 'the chip was taken out and put back');
});

test('a comment that no longer draws a warning loses its chip', () => {
  const placed = comments.markComments(triageDoc, merged([]));
  assert.deepStrictEqual(placed, []);
  assert.strictEqual(triageDoc.querySelectorAll(CHIP).length, 0);
});

test('a snapshot excluded for failing validation marks its comment', () => {
  const placed = comments.markComments(draftDoc, mergeOf(draftDoc));
  assert.strictEqual(placed.length, 1);
  const chip = /** @type {Element} */ (placed[0]);
  assert.strictEqual(text(chip), 'Unable to parse tracking state');
  // Not the tone a snapshot from outside the organization takes: that one is
  // the only chip here a maintainer has to act on.
  assert.strictEqual(chip.getAttribute('class'), 'Label Label--secondary bghsa-tone-attention');
  const group = chip.closest('div.timeline-comment-group');
  assert.ok(group?.id === 'advisory-comment-282849', 'the chip is on the wrong comment');
});

test('a comment carrying no snapshot is named as such', () => {
  const doc = commentPage('900', true);
  const warning = alert('900', 'not a snapshot');
  const placed = comments.markComments(doc, merged([warning]));
  assert.strictEqual(placed.length, 1);
  assert.strictEqual(text(placed[0] ?? null), 'Unable to parse tracking state');
  // What the merge had to say is the whole tooltip, with nothing before it.
  assert.strictEqual(placed[0]?.getAttribute('title'), warning.message);
});

test('a snapshot in a schema this reader does not read is named as such', () => {
  const doc = commentPage('901', true);
  const placed = comments.markComments(doc, merged([alert('901', 'unsupported schema')]));
  assert.strictEqual(text(placed[0] ?? null), 'Tracking state from a newer extension');
});

test('a comment carrying no role badge takes the chip at the end of its header', () => {
  const doc = commentPage('902', false);
  const placed = comments.markComments(doc, merged([alert('902', 'untrusted')]));
  assert.strictEqual(placed.length, 1);
  const chip = /** @type {Element} */ (placed[0]);
  const header = doc.querySelector('div.timeline-comment-header');
  assert.ok(header?.lastElementChild === chip, 'the chip is not at the end of the header');
});

test('a warning naming a comment the page does not hold marks nothing', () => {
  const doc = commentPage('903', true);
  const placed = comments.markComments(doc, merged([alert('904', 'untrusted')]));
  assert.deepStrictEqual(placed, []);
});

test('rendering the page marks the comment an untrusted snapshot came from', async () => {
  const doc = parseFixture('triage-thread.html');
  await panel.render(doc);
  const chips = doc.querySelectorAll(CHIP);
  assert.strictEqual(chips.length, 1);
  assert.strictEqual(text(chips[0] ?? null), 'Ignored: non-member state');
  assert.ok(doc.getElementById('bghsa-style') !== null, 'the chip has no stylesheet');
});
