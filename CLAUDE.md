# Better GHSA

## What it is

A Firefox and Chrome MV3 extension that adds triage tracking to GitHub Security
Advisories. Each maintainer's triage state lives in a comment on the advisory
itself, one per maintainer, holding a JSON snapshot in a collapsed `<details>`
block. There is no server and no database. The REST API exposes neither advisory
comments nor the advisory timeline, so the extension reads GitHub's HTML and
posts through the same forms the page posts through. `REQUIREMENTS.md` is the
specification, `README.md` the user-facing description, and `docs/` one page per
surface.

## How the code is put together

No build step. The repository contents are the extension, loaded from disk.

Every surface is a content script. `manifest.json` lists them, and that order is
the load order and the dependency order. There is no background script and no
service worker. All content scripts of one extension share a single lexical
scope in the page, so each file has the same shape:

1. `'use strict';`, then `globalThis.bghsa ??= {};`.
2. A `typeof require === 'function'` block, taken under Node only, naming the
   files the manifest loads earlier.
3. The whole body inside an IIFE.
4. One `exported` object at the end, assigned to `globalThis.bghsa.<name>` and,
   where `module` exists, to `module.exports`.

The IIFE is load bearing. A top-level `const`, `let`, or `class` in two files is
a redeclaration in the shared scope, and the file throws in the browser. Node
loads each file as its own module, where the collision is invisible, so a green
suite says nothing about it. This broke the extension in Firefox once while
every test passed.

Files reach each other through `globalThis.bghsa` alone, and nothing starts on
load, because the content scripts match every `github.com` page.
`src/content.js` loads last and starts the surface a page belongs to.
`types/bghsa.d.ts` declares the member each file hangs its exports off, and
`test/content-scripts.test.js` loads every manifest script into one shared
context and checks which members arrive, which guards all of the above.

## Checking it

```
npm test        # node --test, one file at a time
npm run check   # tsc --noEmit
```

Those two commands are the whole check, and fixtures live in `testdata/`. One of
them reads a capture of a real closed advisory. A closed advisory is private, so
no capture of one is committed, and `BGHSA_CLOSED_ADVISORY_CAPTURE` names the
saved HTML. Unset, the check skips and names itself in the skip
message. Set to a path that does not exist or a file that does not read as an
advisory, the check fails, so a mistyped path is never a skip.
`docs/testing.md` carries the rest.

A test that still passes when the code it covers is broken is worth nothing.
Check a new test by breaking that code and confirming the test fails.

## GitHub facts the code rests on, each established from real pages

- The advisory's temporary private fork lists open pull requests only. A merged
  or closed pull request is never observable, so patch progress counts
  preparation.
- A pull request closed inside the fork produces no timeline event. The fork's
  only events are its creation and its deletion.
- Only people act on an advisory, so a timeline event reads
  `<actor> <phrase> <time>` where the actor is a login, and a login holds no
  space. Phrases are matched from the first space onward, and matched whole.
- The extension finds its own comments by marker (`better-ghsa:state:1:`,
  `better-ghsa:preserved:1:`), never by their prose.
- The allowlist gates the whole extension, not only its writes. On a repository
  the allowlist does not carry, the extension reads nothing, fetches nothing,
  and stores nothing. The settings control is all it puts on the page.

## testdata/published-containerd.html

A capture whose comments were removed before it was committed, and whose logins,
titles, identifiers, and instants are invented. Its missing comment bodies,
badges, and new-comment composer are the redaction, not GitHub's rendering: a
published advisory carries comments, carries a composer, and can be saved. Two
separate analyses have read the redaction as GitHub behavior and reached wrong
conclusions. The comment at the top of the file says what was taken out and
which fixtures to compare against.

## Conventions

One self-contained unit per commit, carrying its implementation, its tests, and
its documentation together. A documentation-only or specification-only commit is
not a unit. Subject imperative, first word lowercase, no trailing period, 50
characters or fewer; a `scope:` prefix is usual.

Every string a maintainer sees was reviewed one at a time with the author. Do
not reword one incidentally.
