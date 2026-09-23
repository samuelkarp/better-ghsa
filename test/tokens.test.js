'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

/**
 * @type {string[]}
 */
const scripts = manifest.content_scripts[0].js;

/** @typedef {{ file: string, id: string, text: string }} Sheet */

/**
 * Collect the stylesheets injected by each surface.
 *
 * @returns {Sheet[]}
 */
function stylesheets() {
  /** @type {Sheet[]} */
  const found = [];
  for (const file of scripts) {
    const loaded = require(path.join(root, file));
    if (typeof loaded.ensureStyle !== 'function') continue;
    const doc = /** @type {Document} */ (
      /** @type {unknown} */ (parseHTML('<html><head></head><body></body></html>').document)
    );
    loaded.ensureStyle(doc);
    for (const style of doc.querySelectorAll('style')) {
      found.push({ file, id: style.id, text: style.textContent ?? '' });
    }
  }
  return found;
}

/**
 * @param {string} text A stylesheet.
 * @returns {string[]} Complete var() expressions, including nested parentheses.
 */
function varsIn(text) {
  /** @type {string[]} */
  const found = [];
  for (let at = text.indexOf('var('); at !== -1; at = text.indexOf('var(', at + 4)) {
    let depth = 0;
    let end = -1;
    for (let i = at + 3; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.ok(end !== -1, `a var() is never closed: ${text.slice(at, at + 60)}`);
    found.push(text.slice(at, end + 1));
  }
  return found;
}

/**
 * @param {string} expression A complete var() expression.
 * @returns {string} The fallback after the top-level comma, or an empty string.
 */
function fallbackOf(expression) {
  const inner = expression.slice('var('.length, -1);
  let depth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const at = inner[i];
    if (at === '(') depth += 1;
    else if (at === ')') depth -= 1;
    else if (at === ',' && depth === 0) return inner.slice(i + 1).trim();
  }
  return '';
}

test('every var() the extension writes carries a fallback', () => {
  // linkedom does not compute styles. Check fallback expressions directly
  // to detect dependencies on unavailable Primer tokens.
  const sheets = stylesheets();
  assert.ok(sheets.length >= 4, `stylesheets found: ${sheets.length}, expected the four surfaces`);
  for (const sheet of sheets) {
    for (const expression of varsIn(sheet.text)) {
      assert.ok(
        fallbackOf(expression) !== '',
        `${sheet.file} writes ${expression} with no fallback`
      );
    }
  }
});
