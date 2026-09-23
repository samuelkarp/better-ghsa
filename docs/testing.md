# Running the tests

Run both checks from the repository root:

```
npm test        # node --test, one test file at a time
npm run check   # tsc --noEmit over src, test, test-support, types
```

The extension loads directly from the repository and does not need a build.

Committed fixtures are in `testdata/`. They include GitHub page captures and
synthetic markup based on observed page structures. The capture helpers in
`tools/` blank session tokens before saving markup.

## Tracking editor refreshes

Run the tracking editor tests with:

```
node --test --test-concurrency=1 test/panel.test.js test/edit.test.js test/dom.test.js test/content-scripts.test.js
```

Observer tests check that unrelated mutations to the body and shadow hosts
preserve the panel, inputs, disclosure, drafts, and local control state. They
also cover comment warning repair, advisory and write metadata changes,
candidate suggestions scoped to the organization or repository, panel placement,
embargo expiry, and save and discard feedback. Draft restoration tests change
advisory data to trigger a rebuild.

These DOM tests do not establish native focus or selection behavior. Validate
that separately in a fresh browser profile using committed fixtures, in-memory
storage, disabled network requests, and the actual manifest scripts and observer
loop. Check `activeElement` and a nonempty selection while changing unrelated
body elements and inserting or removing hosts with closed shadow roots. Then
verify advisory updates and panel placement repair. IME composition and
password manager interactions require separate browser tests.

## The closed-advisory capture

The test `the close reads the same on a real closed advisory` uses a local
capture selected by `BGHSA_CLOSED_ADVISORY_CAPTURE`:

```
BGHSA_CLOSED_ADVISORY_CAPTURE=~/scratch/better-ghsa/closed-containerd.html npm test
```

Closed advisories contain private titles, participants, and timelines. Keep the
capture outside this repository and outside any location an assistant reads.

The test skips when the variable is unset. When set, the test fails if the path
is invalid or the file cannot be parsed as an advisory.

The test checks timestamps, a duration, and a timeline-event count. Assertion
failures can display these values, but the test does not print the captured
page. Other checks use `testdata/`. Any future test that reads a private capture
must use the same environment variable.
