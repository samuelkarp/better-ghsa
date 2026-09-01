# The completed view

The completed view lists the advisories that are finished: everything in the
published and closed states, which the advisory list leaves out. It is where a
closure reason is recorded on an advisory that was closed before this extension
existed. The statistics view sits beside it and is documented at the bottom of
this page.

## Getting there

Both views are reached from a repository's advisory list,
`https://github.com/{owner}/{repo}/security/advisories`. The extension puts a
row of toggles above the table:

- "Show completed" opens this view. While it is open the toggle reads
  "Show open".
- "Show statistics" opens the statistics view. Its toggle also reads
  "Show open" while it is open.
- "Show GitHub's view" hands the page back to GitHub. While GitHub's own rows
  are showing, that toggle reads "Show Better GHSA" and the other two are
  hidden.

"Show open" returns to the extension's table of open advisories.

One view shows at a time.

## What a row shows

The heading reads "Completed" with the number of advisories beside it.
Advisories are ordered by GHSA identifier ascending. There is no other ordering
and no filter on this view.

Each row carries:

- The advisory title, as a link. An advisory whose title has not been read shows
  its GHSA identifier instead.
- A line beneath it with the GHSA identifier, the date the report was opened,
  and the reporter's login, in the form `GHSA-xxxx-xxxx-xxxx opened 2026-03-14
  by someone`. Any part that has not been read is left out.
- A state chip: "Published" as a filled green chip and "Closed" as a filled
  purple one, the colors GitHub gives the two endings. A state that is neither,
  which happens when the advisory's own page disagrees with the list it was
  found under, is uncolored.
- A severity chip in the color GitHub paints that level. On a published row it
  is filled with that color, because publishing an advisory settles its
  severity.
- The closure reason control.
- "Observed" with the time the row's data was read, in UTC. A row backed by no
  advisory read reads "Not read".

Before the first page of results arrives, the list reads "Loading...". A
finished search that found nothing reads "Not found".

## Recording a closure reason

Each row carries a dropdown labeled "Closure reason" and a "Save" button. The
options are:

- No reason
- Duplicate
- Not a vulnerability
- Not reproducible
- Working as intended
- Out of scope
- No reporter response
- Withdrawn by reporter

An advisory carrying a reason this version does not recognize keeps that value
in the dropdown so a save does not discard it.

"Save" becomes available once the dropdown has moved away from the value stored
on the advisory. Putting it back where it started disables the button again.
Both controls are disabled while a save is in flight.

Saving writes to GitHub. It is the same write every other stored value goes
through: the extension re-reads the advisory page, merges the closure reason
onto the state that page carries, and posts or edits your state comment on the
advisory thread. Everyone who can read the advisory's conversation sees it, the
reporter included. Nothing else about the advisory changes.

The row reports what happened underneath the control: "Saving..." while the
write is in flight, "Saved." when it lands, and an error otherwise. The errors
worth recognizing are "Error: concurrent edits", which means another maintainer
wrote to that advisory between the read and the write and the change was not
applied, and "Error: {owner}/{repo} is not on this extension's allowlist.",
which means writes to that repository are refused.

Changing the dropdown on a row that has no advisory read behind it stages
nothing and saves nothing.

## Reading and refreshing

Opening this view starts a walk of the repository's published and closed
advisory lists and then reads each advisory's own page. On a repository with a
hundred finished advisories that is a hundred requests, sent one per second
through a single queue shared with the advisory list. Rows paint immediately
from the local cache and fill in as reads land.

Navigating to another repository stops the walk after the request already in
flight. Progress is kept, so returning resumes where it stopped.

Failures are named above the rows: "Failed to load {url}" for each list page
that could not be read, and "Failed to load {N} advisories" counting the
advisory pages that never arrived. A walk that finished without reaching the
last page shows "Failed to load all advisories" beside the heading.

## The statistics view

Statistics cover the whole corpus, open advisories and finished ones together,
because they describe work in progress as much as work completed. The view
reads only what the extension already holds. It sends no requests of its own,
so its numbers describe how much of the repository has been read so far.
Everything is computed in the page. Nothing is sent anywhere.

A repository nothing has been read on shows "Nothing has been read on this
repository".

A row of chips at the top says what the numbers are over: the total, how many
are open, how many are done, how many have never been read, how many GitHub's
own tab counts say exist, and whether either half is partly crawled or not
crawled at all. "Reading" appears while a walk is running, which means the
numbers can move while you look at them.

### Counts

Four sections: "Closure reason", "State", "Severity", and "Month". Each names
how many advisories it counted out of the corpus, and each row gives a value, a
count, and a percentage of the counted advisories. Advisories carrying no value
for that section appear as a "None" row with a count and no percentage. Months
are UTC, as `YYYY-MM`.

### Timings

Four sections, each measured from the time the report was opened: "Time to
first response", "Time to accept", "Time to close", and "Time to publish". Each
gives "Min", "Median", "Mean", and "Max".

Advisories that cannot be measured are excluded from those four numbers and
counted on a row of their own: "No response", "Never accepted", "Never closed",
"Never published". They are never counted as zero and never estimated.

What these can see bounds what they mean. First response is the earliest comment
by an org member that this extension did not write, so a maintainer who answered
by email or who acted without commenting is invisible to it. Acceptance,
closure, and publication are read from the wording of the advisory's timeline
events.

### Export

"Export CSV", in the statistics heading, downloads the whole corpus as a file
named `{owner}-{repo}-advisories-{date}.csv`. The columns are `ghsa_id`,
`title`, `state`, `severity`, `closure_reason`, `reported_at`, `month`,
`time_to_first_response_ms`, `time_to_accept_ms`, `time_to_close_ms`,
`time_to_publish_ms`, `detail_fetched`, and `observed_at`. Durations are
milliseconds, and a duration that could not be measured is blank. The file is
built in the browser and never leaves it.
