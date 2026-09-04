'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseHTML } = require('linkedom');

const duplicate = require('../src/common/duplicate.js');

/** The repository the surfaces drawing a duplicate stand on. */
const REF = { owner: 'git-utensils', repo: 'Spoon-Knife' };

/**
 * @returns {Document} a document with nothing in it, which is all a builder
 *   needs to make elements.
 */
function blank() {
  return /** @type {Document} */ (
    /** @type {unknown} */ (parseHTML('<!doctype html><html><body></body></html>').document)
  );
}

/**
 * @param {string} value
 * @param {{ owner: string, repo: string } | null} [ref]
 * @returns {{ text: string, href: string | null }} what the built span reads
 *   and where its link leads, with null for a span carrying no link.
 */
function built(value, ref = REF) {
  const node = duplicate.buildDuplicate(blank(), 'bghsa-since', value, ref);
  const link = node.querySelector('a');
  return {
    text: (node.textContent ?? '').trim(),
    href: link === null ? null : link.getAttribute('href'),
  };
}

test('a GHSA identifier points at that advisory in the repository in hand', () => {
  assert.deepStrictEqual(duplicate.pointerOf('GHSA-cm76-qm8v-3j95', REF), {
    text: 'GHSA-cm76-qm8v-3j95',
    href: '/git-utensils/Spoon-Knife/security/advisories/GHSA-cm76-qm8v-3j95',
  });
  // GitHub reads an identifier case-insensitively, so both spellings of one
  // identifier are the one advisory and each leads to it as it was written.
  assert.deepStrictEqual(duplicate.pointerOf('ghsa-cm76-qm8v-3j95', REF), {
    text: 'ghsa-cm76-qm8v-3j95',
    href: '/git-utensils/Spoon-Knife/security/advisories/ghsa-cm76-qm8v-3j95',
  });
  // An identifier names no repository, so with no repository to read it in
  // there is no address to lead to and it stands as the text it is.
  assert.strictEqual(duplicate.pointerOf('GHSA-cm76-qm8v-3j95', null), null);
});

test('an issue is named the way GitHub names one', () => {
  assert.deepStrictEqual(
    duplicate.pointerOf('https://github.com/git-utensils/Spoon-Knife/issues/412', REF),
    { text: '#412', href: '/git-utensils/Spoon-Knife/issues/412' }
  );
  // GitHub writes an issue of another repository with that repository in front
  // of the number, and this reader has one repository to compare against.
  assert.deepStrictEqual(
    duplicate.pointerOf('https://github.com/containerd/containerd/issues/412', REF),
    { text: 'containerd/containerd#412', href: '/containerd/containerd/issues/412' }
  );
  // The comparison is the one GitHub makes: a repository is one repository
  // however it is capitalized.
  assert.strictEqual(
    duplicate.pointerOf('https://github.com/GIT-UTENSILS/spoon-knife/issues/412', REF)?.text,
    '#412'
  );
});

test('a pull request is named the way an issue is', () => {
  // A repository numbers its issues and its pull requests in one sequence and
  // GitHub writes a reference to either as `#12`, so the two read alike. The
  // address parts them, and the link leads to the one the value named.
  assert.deepStrictEqual(
    duplicate.pointerOf('https://github.com/git-utensils/Spoon-Knife/pull/13327', REF),
    { text: '#13327', href: '/git-utensils/Spoon-Knife/pull/13327' }
  );
  assert.deepStrictEqual(
    duplicate.pointerOf('https://github.com/containerd/containerd/pull/13327', REF),
    { text: 'containerd/containerd#13327', href: '/containerd/containerd/pull/13327' }
  );
  assert.deepStrictEqual(built('https://github.com/containerd/containerd/pull/13327'), {
    text: 'of containerd/containerd#13327',
    href: '/containerd/containerd/pull/13327',
  });
});

test('a value that is not exactly one of the forms this reader knows points nowhere', () => {
  // REQUIREMENTS.md section 6 stores the field as the maintainer typed it and
  // validates none of it, so anything can arrive here. Only a whole match is
  // read, so every address a link carries is one built out of a pattern this
  // reader matched.
  for (const value of [
    'GHSA-cm76-qm8v-3j95 and GHSA-jmvx-2wfw-xfgj',
    'see GHSA-cm76-qm8v-3j95',
    'GHSA-cm76-qm8v',
    'GHSA-cm76-qm8v-3j95-3j95',
    ' GHSA-cm76-qm8v-3j95 ',
    'https://github.com/git-utensils/Spoon-Knife/issues/412?from=triage',
    'https://github.com/git-utensils/Spoon-Knife/issues/412#issuecomment-1',
    'https://github.com/git-utensils/Spoon-Knife/pulls/412',
    'http://github.com/git-utensils/Spoon-Knife/issues/412',
    'https://github.com/git-utensils/Spoon-Knife/pull/412/files',
    'https://example.invalid/github.com/git-utensils/Spoon-Knife/issues/412',
    'javascript:alert(1)',
    'the one prakleumas filed last March',
  ]) {
    assert.strictEqual(duplicate.pointerOf(value, REF), null, `${value} was read as a pointer`);
    assert.strictEqual(built(value).href, null, `${value} was drawn as a link`);
  }
});

test('a value nobody can interpret is still readable', () => {
  assert.deepStrictEqual(built('the one prakleumas filed last March'), {
    text: 'of the one prakleumas filed last March',
    href: null,
  });
  // The angle brackets go on display. The field is free text a maintainer
  // typed, and it reaches the page as text either way.
  assert.deepStrictEqual(built('<img src=x onerror=alert(1)>'), {
    text: 'of img src=x onerror=alert(1)',
    href: null,
  });
});

test('a recognized value is drawn as a link to it', () => {
  assert.deepStrictEqual(built('GHSA-cm76-qm8v-3j95'), {
    text: 'of GHSA-cm76-qm8v-3j95',
    href: '/git-utensils/Spoon-Knife/security/advisories/GHSA-cm76-qm8v-3j95',
  });
  assert.deepStrictEqual(built('https://github.com/git-utensils/Spoon-Knife/issues/412'), {
    text: 'of #412',
    href: '/git-utensils/Spoon-Knife/issues/412',
  });
});
