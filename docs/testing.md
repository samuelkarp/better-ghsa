# Running the tests

This is a maintainer page. Nothing here is needed to install or use the
extension.

```
npm test        # node --test, one test file at a time
npm run check   # tsc --noEmit over src, test, test-support, types
```

There is no build step, so those two commands are the whole check.

Committed fixtures live in `testdata/`. They are captures of GitHub pages taken
with the console helpers in `tools/`, which blank session tokens before the
markup leaves the page, plus a few pages this project invented to hold a shape
GitHub produced once.

## Tracking editor refreshes

The focused selection is:

```
node --test --test-concurrency=1 test/panel.test.js test/edit.test.js test/dom.test.js test/content-scripts.test.js
```

Observer-driven tests check that unrelated body and shadow-host mutations keep
the same connected panel, input, and disclosure, including drafts and local
control state. They also check warning repair without rebuilding, real advisory
and write-metadata changes, candidate arrival and scoping, placement repair,
embargo expiry, and explicit save/discard feedback. Draft-restoration tests
deliberately change advisory data to require reconstruction rather than relying
on a no-op render to rebuild.

These DOM tests do not establish native focus or selection behavior. Validate
that separately in a fresh browser profile using committed fixtures, in-memory
storage, disabled network requests, and the actual manifest scripts and observer
loop. Check activeElement and a nonempty selection across unrelated body UI and
closed-shadow-host insertion/removal, then verify real updates and placement
repair. Synthetic mutations are not evidence of genuine IME behavior or a
particular password manager's mutation records.

## The closed-advisory capture

One check reads a capture of a real closed advisory:

    the close reads the same on a real closed advisory

A closed advisory is not published. Its title, its participants, and its
timeline are private, so no capture of one is committed here and the check is
skipped by default. It runs where `BGHSA_CLOSED_ADVISORY_CAPTURE` names the
saved HTML of a closed advisory page:

```
BGHSA_CLOSED_ADVISORY_CAPTURE=~/scratch/better-ghsa/closed-containerd.html npm test
```

Keep the file outside this repository, and outside anywhere an assistant reads.

With the variable unset the check skips and names itself in the skip message, so
a clone of this repository runs clean. With the variable set the check fails if
the path does not exist or the file does not read as an advisory: a mistyped
path is a failure, never a skip that would look like a check that ran.

It asserts instants only, so neither the check nor a failure of it writes down
anything the capture holds. Every other check in the suite is against
`testdata/`, and any future check reading a private capture belongs behind the
same variable.
