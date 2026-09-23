'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');

/**
 * @param {string} name
 * @returns {Document}
 */
function fixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

/**
 * @param {string} markup
 * @returns {Document}
 */
function document(markup) {
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(markup).document));
}

test('the triage advisory header yields identity, state, severity, and reporter', () => {
  const advisory = parse.parseDetail(fixture('triage-thread.html'));
  assert.notStrictEqual(advisory, null);
  if (advisory === null) return;
  assert.deepStrictEqual(advisory.ref, {
    owner: 'git-utensils',
    repo: 'Spoon-Knife',
    ghsaId: 'GHSA-jmvx-2wfw-xfgj',
  });
  assert.strictEqual(advisory.ghsaId, 'GHSA-jmvx-2wfw-xfgj');
  assert.strictEqual(advisory.state, 'Triage');
  assert.strictEqual(advisory.severity, 'high');
  assert.strictEqual(advisory.severityLabel, 'High');
  // Label--large sets chip size. Only color modifiers belong in severityClass.
  assert.strictEqual(advisory.severityClass, 'Label--orange');
  assert.strictEqual(advisory.reportedAt, '2026-08-25T22:15:18Z');
  assert.strictEqual(advisory.reporter, 'prakleumas');
  assert.deepStrictEqual(advisory.collaborators, ['prakleumas']);
});

test('the metadata form yields source markdown and the stored scoring fields', () => {
  const advisory = parse.parseDetail(fixture('triage-thread.html'));
  if (advisory === null) throw new Error('triage-thread.html did not parse');
  assert.strictEqual(
    advisory.title,
    'Path traversal in drawer handler allows reading arbitrary files'
  );
  assert.match(advisory.description ?? '', /^### Summary\n\nThe drawer handler joins a user-supplied/);
  assert.strictEqual(advisory.severityField, 'cvss_v3');
  assert.strictEqual(advisory.cvssV3, 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N');
  assert.strictEqual(advisory.cveId, null);
  assert.strictEqual(advisory.cveSelection, 'requesting');
});

test('a severity the maintainer has not set reads as absent', () => {
  const advisory = parse.parseDetail(fixture('draft.html'));
  if (advisory === null) throw new Error('draft.html did not parse');
  assert.strictEqual(advisory.state, 'Draft');
  assert.strictEqual(advisory.severity, null);
  assert.strictEqual(advisory.severityLabel, null);
  assert.strictEqual(advisory.severityClass, null);
  assert.strictEqual(advisory.severityField, null);
  assert.strictEqual(advisory.severityFieldPresent, true);
  assert.strictEqual(advisory.cvssV3, null);
  assert.strictEqual(advisory.cvssV3Present, true);
});

test('a scoring field that is there and empty is told from one that is absent', () => {
  const carried = parse.parseDetail(
    document(
      '<div class="gh-header-meta"></div><form>' +
        '<select name="repository_advisory[severity]"><option value="" selected></option></select>' +
        '<input name="repository_advisory[cvss_v3]" value="">' +
        '</form>'
    )
  );
  if (carried === null) throw new Error('the page with the scoring fields did not parse');
  assert.strictEqual(carried.severityField, null);
  assert.strictEqual(carried.severityFieldPresent, true);
  assert.strictEqual(carried.cvssV3, null);
  assert.strictEqual(carried.cvssV3Present, true);

  const absent = parse.parseDetail(document('<div class="gh-header-meta"></div><form></form>'));
  if (absent === null) throw new Error('the page without the scoring fields did not parse');
  assert.strictEqual(absent.severityField, null);
  assert.strictEqual(absent.severityFieldPresent, false);
  assert.strictEqual(absent.cvssV3, null);
  assert.strictEqual(absent.cvssV3Present, false);
});

test('a published advisory carries its assigned CVE in the metadata form', () => {
  const advisory = parse.parseDetail(fixture('published-containerd.html'));
  if (advisory === null) throw new Error('published-containerd.html did not parse');
  assert.strictEqual(advisory.state, 'Published');
  assert.strictEqual(advisory.severity, 'moderate');
  // GitHub severity classes name colors, not severity levels.
  assert.strictEqual(advisory.severityClass, 'Label--warning');
  assert.strictEqual(advisory.severityField, 'moderate');
  assert.strictEqual(advisory.cveId, 'CVE-2026-31984');
  assert.strictEqual(advisory.cveSelection, 'existing');
  assert.strictEqual(
    advisory.title,
    'containerd denial of service via unbounded image metadata allocation'
  );
});

test('the reporter and the report time come from the description Box header', () => {
  const triage = parse.parseDetail(fixture('triage-thread.html'));
  if (triage === null) throw new Error('triage-thread.html did not parse');
  assert.strictEqual(triage.reporter, 'prakleumas');
  assert.strictEqual(triage.reportedAt, '2026-08-25T22:15:18Z');

  const draft = parse.parseDetail(fixture('draft.html'));
  if (draft === null) throw new Error('draft.html did not parse');
  assert.strictEqual(draft.reporter, 'samuelkarp');
  assert.strictEqual(draft.reportedAt, '2026-08-25T22:19:40Z');

  const published = parse.parseDetail(fixture('published-containerd.html'));
  if (published === null) throw new Error('published-containerd.html did not parse');
  assert.strictEqual(published.reporter, 'pieter-vosk');
  assert.strictEqual(published.reportedAt, '2026-04-07T18:05:12Z');
});

test('a description with no revision control is the reporter original', () => {
  const advisory = parse.parseDetail(fixture('triage-thread.html'));
  if (advisory === null) throw new Error('triage-thread.html did not parse');
  assert.strictEqual(advisory.descriptionOriginal, true);
  assert.strictEqual(advisory.descriptionRevision, null);
});

test('a revised description reports who revised it and where the log lives', () => {
  const draft = parse.parseDetail(fixture('draft.html'));
  if (draft === null) throw new Error('draft.html did not parse');
  assert.strictEqual(draft.descriptionOriginal, false);
  assert.deepStrictEqual(draft.descriptionRevision, {
    summary: 'edited',
    historyUrl: '/git-utensils/Spoon-Knife/security/advisories/GHSA-5hg2-rfq2-8fm5/edit_history_log',
  });

  const published = parse.parseDetail(fixture('published-containerd.html'));
  if (published === null) throw new Error('published-containerd.html did not parse');
  assert.strictEqual(published.descriptionOriginal, false);
  assert.deepStrictEqual(published.descriptionRevision, {
    summary: 'edited by marlowe-tsu',
    historyUrl: '/containerd/containerd/security/advisories/GHSA-6r4h-2xvq-wm93/edit_history_log',
  });
});

test('a description Box carrying no revision control reports originality unknown', () => {
  const root = document(
    '<div class="gh-header-meta"><span class="State">Triage</span></div>' +
      '<div class="Box"><div class="js-repository-advisory-details">' +
      '<div class="Box-header timeline-comment-header">' +
      '<a class="author" href="/prakleumas">prakleumas</a>' +
      '<relative-time datetime="2026-08-25T22:15:18Z">Aug 25, 2026</relative-time>' +
      '</div></div></div>'
  );
  const advisory = parse.parseDetail(root);
  if (advisory === null) throw new Error('the constructed page did not parse');
  assert.strictEqual(advisory.reporter, 'prakleumas');
  assert.strictEqual(advisory.descriptionOriginal, null);
  assert.strictEqual(advisory.descriptionRevision, null);
});

test('a page with no description Box reports the reporter and originality unknown', () => {
  const root = document(
    '<div class="gh-header-meta"><span class="State">Published</span>' +
      '<a class="author" href="/marlowe-tsu">marlowe-tsu</a>' +
      '<relative-time datetime="2026-08-03T22:11:52Z">Aug 3, 2026</relative-time>' +
      '</div>'
  );
  const advisory = parse.parseDetail(root);
  if (advisory === null) throw new Error('the constructed page did not parse');
  assert.strictEqual(advisory.reporter, null);
  assert.strictEqual(advisory.reportedAt, null);
  assert.strictEqual(advisory.descriptionOriginal, null);
});

test('the comment thread reads one entry per comment identifier', () => {
  const advisory = parse.parseDetail(fixture('triage-thread.html'));
  if (advisory === null) throw new Error('triage-thread.html did not parse');
  assert.deepStrictEqual(
    advisory.comments.map((comment) => comment.elementId),
    ['advisory-comment-282846', 'advisory-comment-282847', 'advisory-comment-282848']
  );
  assert.deepStrictEqual(
    advisory.comments.map((comment) => [comment.author, comment.role, comment.at]),
    [
      ['samuelkarp', 'Member', '2026-08-25T22:16:30Z'],
      ['samuelkarp', 'Member', '2026-08-25T22:17:05Z'],
      ['prakleumas', 'Author', '2026-08-25T22:17:47Z'],
    ]
  );
  assert.match(advisory.comments[0]?.text ?? '', /^Thanks for the report\. I can reproduce it against main\./);
});

test('a comment carrying two badges in two container shapes resolves to one role', () => {
  const root = fixture('draft.html');
  const group = root.getElementById('advisory-comment-282849');
  assert.strictEqual(group?.querySelectorAll('span.Label').length, 4);

  const comments = parse.parseComments(root);
  assert.strictEqual(comments.length, 1);
  assert.deepStrictEqual(comments[0]?.roles, ['Member', 'Author']);
  assert.strictEqual(comments[0]?.role, 'Member');
  assert.strictEqual(comments[0]?.trusted, true);
});

test('a comment whose badges run least privileged first still resolves to Member', () => {
  const root = document(
    '<div class="timeline-comment-group" id="advisory-comment-991">' +
      '<div class="timeline-comment unminimized-comment">' +
      '<a class="author" href="/samuelkarp">samuelkarp</a>' +
      '<span class="Label">Author</span><span class="Label">Member</span>' +
      '<div class="comment-body markdown-body js-comment-body">Reported by me.</div>' +
      '</div></div>'
  );
  const comments = parse.parseComments(root);
  assert.deepStrictEqual(comments[0]?.roles, ['Author', 'Member']);
  assert.strictEqual(comments[0]?.role, 'Member');
  assert.strictEqual(comments[0]?.trusted, true);
});

test('the empty comment form template is not read as a comment', () => {
  const root = fixture('draft.html');
  assert.strictEqual(root.querySelectorAll('div.timeline-comment-group').length, 2);
  assert.strictEqual(parse.parseComments(root).length, 1);
});

test('a state comment from a Member yields its envelope and carries unknown fields', () => {
  const advisory = parse.parseDetail(fixture('triage-thread.html'));
  if (advisory === null) throw new Error('triage-thread.html did not parse');
  const snapshot = advisory.comments[1]?.stateComment;
  assert.notStrictEqual(snapshot, null);
  assert.strictEqual(snapshot?.version, '1.0');
  assert.strictEqual(snapshot?.major, 1);
  assert.strictEqual(snapshot?.schemaSupported, true);
  assert.strictEqual(snapshot?.seq, 3);
  assert.strictEqual(snapshot?.by, 'samuelkarp');
  assert.strictEqual(snapshot?.ordered, true);
  assert.strictEqual(snapshot?.valid, true);
  assert.deepStrictEqual(snapshot?.problems, []);
  assert.deepStrictEqual(snapshot?.unrecognized, []);
  assert.strictEqual(advisory.comments[1]?.trusted, true);

  const payload = /** @type {Record<string, unknown>} */ (snapshot?.parsed);
  assert.strictEqual(payload['triage'], 'awaiting reporter');
  assert.deepStrictEqual(payload['owners'], ['samuelkarp']);
  assert.deepStrictEqual(payload['backports'], ['release/1.0']);
  assert.deepStrictEqual(payload['cutleryPolicy'], { sharpened: true });
});

test('a well-formed state comment from a refused author is read and marked untrusted', () => {
  const advisory = parse.parseDetail(fixture('triage-thread.html'));
  if (advisory === null) throw new Error('triage-thread.html did not parse');
  const comment = advisory.comments[2];
  assert.strictEqual(comment?.author, 'prakleumas');
  assert.strictEqual(comment?.role, 'Author');
  assert.strictEqual(comment?.trusted, false);
  assert.strictEqual(comment?.stateComment?.seq, 7);
  assert.strictEqual(comment?.stateComment?.by, 'prakleumas');
  assert.strictEqual(comment?.stateComment?.valid, true);
});

/**
 * @param {string} inner The markup the comment body holds.
 * @returns {Element | null} the comment body a state comment is read from.
 */
function commentBody(inner) {
  const root = document(`<div class="comment-body markdown-body js-comment-body">${inner}</div>`);
  return root.querySelector('div.comment-body');
}

test('a comment carrying no marker outside a fence is not a state comment', () => {
  /** @type {[string, string][]} */
  const cases = [
    [
      'a JSON fence in an ordinary comment',
      '<div class="highlight highlight-source-json"><pre>{"hello": "world"}</pre></div>',
    ],
    [
      'the summary text and nothing else',
      '<details><summary>Better GHSA tracking state</summary>' +
        '<div class="highlight highlight-source-json"><pre>{ oops</pre></div></details>',
    ],
    [
      'the marker inside the fence',
      '<div class="highlight highlight-source-json"><pre><code>' +
        'better-ghsa:state:1: { oops</code></pre></div>',
    ],
  ];
  for (const [name, inner] of cases) {
    assert.strictEqual(parse.parseStateComment(commentBody(inner)), null, name);
  }
});

test('the marker marks a state comment whose payload does not parse', () => {
  /** @type {[string, string][]} */
  const cases = [
    [
      'a fence that is broken',
      '<details><summary>Whatever the maintainer wrote here</summary>' +
        '<p><code>better-ghsa:state:1:</code></p>' +
        '<div class="highlight highlight-source-json"><pre>{ oops</pre></div></details>',
    ],
    [
      'no fence at all',
      '<details><summary>Better GHSA tracking state</summary>' +
        '<p><code>better-ghsa:state:1:</code></p></details>',
    ],
  ];
  for (const [name, inner] of cases) {
    const report = parse.parseStateComment(commentBody(inner));
    assert.notStrictEqual(report, null, name);
    assert.strictEqual(report?.ordered, false, `${name} carried an ordering claim`);
    assert.deepStrictEqual(
      report?.problems,
      ['the fenced block does not parse as JSON'],
      `${name} reported the wrong problem`
    );
  }
});

test('a state comment written before the marker is read on its payload', () => {
  const root = document(
    '<div class="comment-body markdown-body js-comment-body"><details>' +
      '<summary>Better GHSA tracking state</summary>' +
      '<div class="highlight highlight-source-json"><pre>' +
      '{"betterGhsa":"1.0","seq":4,"by":"samuelkarp"}</pre></div>' +
      '</details></div>'
  );
  const report = parse.parseStateComment(root.querySelector('div.comment-body'));
  assert.strictEqual(report?.seq, 4);
  assert.strictEqual(report?.valid, true);
});

test('the timeline excludes comment groups and names actor and time', () => {
  const advisory = parse.parseDetail(fixture('triage-thread.html'));
  if (advisory === null) throw new Error('triage-thread.html did not parse');
  assert.deepStrictEqual(
    advisory.timeline.map((event) => [event.id, event.actor, event.at]),
    [
      ['event-970580', 'prakleumas', '2026-08-25T22:15:18Z'],
      ['event-970581', 'prakleumas', '2026-08-25T22:15:18Z'],
      ['event-970595', 'samuelkarp', '2026-08-25T22:22:42Z'],
    ]
  );
  assert.strictEqual(
    advisory.timeline[2]?.text,
    'samuelkarp created the temporary private fork git-utensils/Spoon-Knife-ghsa-jmvx-2wfw-xfgj Aug 25, 2026'
  );
});

test('the private fork yields its clone url and its pull requests', () => {
  const fork = parse.parseFork(fixture('fork-multi-branch.html'));
  assert.notStrictEqual(fork, null);
  assert.strictEqual(
    fork?.cloneUrl,
    'git@github.com:git-utensils/Spoon-Knife-ghsa-jmvx-2wfw-xfgj.git'
  );
  assert.strictEqual(fork?.repository, 'git-utensils/Spoon-Knife-ghsa-jmvx-2wfw-xfgj');
  assert.strictEqual(
    fork?.deleteUrl,
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/delete_workspace'
  );
  assert.deepStrictEqual(fork?.pullRequests, [
    {
      number: 2,
      url: '/git-utensils/Spoon-Knife-ghsa-jmvx-2wfw-xfgj/pull/2',
      title: 'Normalize drawer paths before opening (1.0)',
      state: 'open',
      baseRef: 'release/1.0',
      headRef: 'fix-traversal-1.0',
      author: 'samuelkarp',
      openedAt: '2026-08-25T22:25:35Z',
      assignees: [],
    },
    {
      number: 1,
      url: '/git-utensils/Spoon-Knife-ghsa-jmvx-2wfw-xfgj/pull/1',
      title: 'Normalize drawer paths before opening',
      state: 'open',
      baseRef: 'main',
      headRef: 'fix-traversal-main',
      author: 'samuelkarp',
      openedAt: '2026-08-25T22:24:37Z',
      assignees: [],
    },
  ]);
});

test('a fork row whose modifier was renamed is read open off its label', () => {
  const root = document(
    '<private-forks-git-clone-help><ul><li class="Box-row">' +
      '<span class="tooltipped color-fg-brand" aria-label="Open Pull Request"></span>' +
      '<a class="h4 Link--primary" href="/o/r-ghsa-x/pull/5">Fix</a>' +
      '</li></ul></private-forks-git-clone-help>'
  );
  const fork = parse.parseFork(root);
  assert.strictEqual(fork?.pullRequests[0]?.state, 'open');
});

test('a fork row whose icon names no known state reports no state', () => {
  const root = document(
    '<private-forks-git-clone-help><ul><li class="Box-row">' +
      '<span class="tooltipped color-fg-muted" aria-label="Draft Pull Request"></span>' +
      '<a class="h4 Link--primary" href="/o/r-ghsa-x/pull/7">Fix</a>' +
      '<span class="commit-ref css-truncate base-ref">' +
      '<span class="css-truncate-target">main</span></span>' +
      '</li></ul></private-forks-git-clone-help>'
  );
  const fork = parse.parseFork(root);
  assert.strictEqual(fork?.pullRequests.length, 1);
  assert.strictEqual(fork?.pullRequests[0]?.number, 7);
  assert.strictEqual(fork?.pullRequests[0]?.state, null);
});

test('an advisory with no private fork reports none', () => {
  const advisory = parse.parseDetail(fixture('draft.html'));
  if (advisory === null) throw new Error('draft.html did not parse');
  assert.strictEqual(advisory.fork, null);
});

test('a document that is not an advisory detail page yields null', () => {
  for (const name of ['edit-form.html', 'list-page-triage.html', 'list-page-draft.html']) {
    assert.ok(parse.parseDetail(fixture(name)) === null, name);
  }
});

/**
 * @param {string} inner The markup inside the new-comment box.
 * @returns {Document}
 */
function composer(inner) {
  return document(`<div class="timeline-new-comment">${inner}</div>`);
}

const COMPOSER_FORM =
  '<form action="/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments">' +
  '<textarea name="body"></textarea></form>';

/**
 * @param {string} href
 * @param {string} alt
 * @returns {string} the avatar the new-comment box carries.
 */
function avatar(href, alt) {
  return (
    `<span class="timeline-comment-avatar"><a href="${href}">` +
    `<img class="avatar" alt="${alt}"></a></span>`
  );
}

test('the signed-in login is the one on the new-comment box', () => {
  const advisory = parse.parseDetail(fixture('triage-thread.html'));
  if (advisory === null) throw new Error('triage-thread.html did not parse');
  assert.strictEqual(advisory.viewer, 'samuelkarp');
  assert.strictEqual(advisory.reporter, 'prakleumas');
  assert.ok(
    advisory.comments.some((comment) => comment.author === 'prakleumas'),
    'the triage thread carries no comment by the reporter'
  );
});

test('a capture carrying no new-comment box names no signed-in login', () => {
  // Comments and the new-comment composer were removed from this capture.
  // The signed-in account cannot be read from the redacted fixture.
  const advisory = parse.parseDetail(fixture('published-containerd.html'));
  if (advisory === null) throw new Error('published-containerd.html did not parse');
  assert.strictEqual(advisory.viewer, null);
});

test('the signed-in login is named only where one box, avatar and form agree', () => {
  /** @type {[string, Document, string | null][]} */
  const cases = [
    [
      'a box that posts a comment',
      composer(avatar('/samuelkarp', '@samuelkarp') + COMPOSER_FORM),
      'samuelkarp',
    ],
    ['a box that posts no comment', composer(avatar('/samuelkarp', '@samuelkarp')), null],
    [
      'an avatar naming two logins',
      composer(avatar('/samuelkarp', '@prakleumas') + COMPOSER_FORM),
      null,
    ],
    [
      'two new-comment boxes',
      document(
        `<div class="timeline-new-comment">${avatar('/samuelkarp', '@samuelkarp')}` +
          `${COMPOSER_FORM}</div>` +
          `<div class="timeline-new-comment">${avatar('/prakleumas', '@prakleumas')}` +
          `${COMPOSER_FORM}</div>`
      ),
      null,
    ],
    ['a box carrying no avatar', composer(COMPOSER_FORM), null],
    [
      'an avatar whose image names no login',
      composer(avatar('/samuelkarp', '') + COMPOSER_FORM),
      null,
    ],
    [
      'an avatar carrying no image',
      composer(
        '<span class="timeline-comment-avatar"><a href="/samuelkarp"></a></span>' + COMPOSER_FORM
      ),
      null,
    ],
  ];
  for (const [name, box, viewer] of cases) {
    assert.strictEqual(parse.parseViewer(box), viewer, name);
  }
});

test('an href whose percent escape does not decode names no login', () => {
  const commented = document(
    '<div class="timeline-comment-group" id="advisory-comment-1">' +
      '<a class="author" href="/%zz">prakleumas</a></div>'
  );
  const comments = parse.parseComments(commented);
  assert.strictEqual(comments.length, 1);
  assert.strictEqual(comments[0]?.author, 'prakleumas');

  const box = composer(avatar('/%zz', '@%zz') + COMPOSER_FORM);
  assert.strictEqual(parse.parseViewer(box), null);
});
