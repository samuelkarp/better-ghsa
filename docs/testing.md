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
