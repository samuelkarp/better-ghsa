# The completed view

The completed view lists published and closed advisories. It also lets you add
closure reasons to closed advisories. The statistics view is documented below.

## Getting there

Both views open from a repository's advisory list,
`https://github.com/{owner}/{repo}/security/advisories`. The toolbar has three
toggles:

- "Show completed" opens this view. Its toggle reads "Show open" while the
  view is open.
- "Show statistics" opens statistics. Its toggle also reads "Show open" while
  that view is open.
- "Show GitHub's view" restores GitHub's rows. Its toggle then reads "Show
  Better GHSA", and the other two toggles are hidden.

"Show open" returns to the extension's table of open advisories. One view is
visible at a time.

## What a row shows

The heading reads "Completed" with an advisory count. Rows are ordered by end
time, newest first. Closed advisories use their latest closure; published
advisories use their latest publication. The order includes time of day even
though rows display only the date.

Advisories with unknown end times appear last, in GHSA identifier order. An
end time requires a closure or publication event from the advisory page,
matching the current state.

Each row shows:

- The title as a link, or the GHSA identifier if the title is unavailable.
- The identifier, report date, reporter, and end date, in the form
  `GHSA-xxxx-xxxx-xxxx opened 2026-03-14 by someone closed 2026-08-02`.
  Published advisories use `published` in place of `closed`. Unread values
  are omitted.
- A severity chip, except on closed advisories. Published advisories use a
  filled chip in GitHub's color for that level. Publication confirms severity.
- A closure reason control, except on published advisories. A stored duplicate
  reference appears beneath it.
- A state chip in a separate cell: filled green for "Published" and filled
  purple for "Closed". Other states are uncolored. These can appear when the
  advisory page disagrees with the list where it was found.
- "Observed" with the UTC time the extension read the advisory page, or
  "Not read" if detail data is unavailable.

The open and completed views use the same row builder. Both put state and
observation time in the last two cells.

Before the first page arrives, the list reads "Loading...". A completed search
without results reads "Not found".

The heading also shows a progress chip: "Loading..." during the list crawl and
"Loading (37 left)..." during advisory reads. The count comes from the queue
shared with the open list and includes both views' pending advisories.
Collection waits for requests already queued by the open list. Completed rows
arrive as this view's list pages are read.

The count updates after each successful read. Failed reads are reflected in
the next update. The progress chip disappears when collection finishes or
stops.

## Filters

Three menus appear above the completed list: "State", "Closure reason", and
"Severity". The toolbar shows the current view's filters. Selected values
appear in their labels, as "State: Closed". "Any" clears one menu; "Reset"
clears all three. When filters exclude rows, the heading count reads
"2 of 5 advisories".

Menus offer values from the displayed rows. "Closure reason" also offers
"None" when at least one read closed advisory lacks a reason. It selects
those advisories. Unread advisories pass every filter.

"Closure reason" applies only to closed advisories. Published advisories are
excluded whenever that filter is active, including when "None" is selected.

"Severity" applies only to published advisories. Closed advisories are
excluded whenever that filter is active.

The list reads "No matches" when filters exclude every row.

## Recording a closure reason

Each unpublished row has a "Closure reason" dropdown and a "Save" button.
The first option is blank for an unset reason. The remaining options are:

- Duplicate
- Not a vulnerability
- Not reproducible
- Working as intended
- Out of scope
- No reporter response
- Withdrawn by reporter

An unrecognized stored reason remains available in the dropdown.

A duplicate reference appears below the dropdown as "of" followed by the
stored value. An exact GHSA identifier links to that advisory in the current
repository. An exact github.com issue or pull request URL displays as "#412"
for the current repository or "owner/repo#412" for another repository. Other
values appear as typed. Long references wrap within the column. Set the
duplicate reference from the advisory's own page.

"Save" is enabled when the selection differs from the stored reason. Restoring
the stored value disables it. Both controls are disabled during a save.

Saving re-reads the advisory, merges the closure reason into its tracking
state, and creates or edits your state comment on GitHub. Everyone with access
to the conversation, including the reporter, can see the comment. Other
advisory fields remain unchanged.

The row reports "Saving...", then "Saved." or an error below the controls.
After success, the dropdown shows the saved reason. "Error: concurrent edits"
means another maintainer wrote to the advisory between the read and write;
your change was not applied. "Error: {owner}/{repo} is not on this extension's
allowlist." means writes to that repository are refused.

A closure reason can be staged and saved only after the advisory page has
been read.

## Reading and refreshing

Opening this view crawls the published and closed lists, then reads each
advisory page. A hundred completed advisories require a hundred requests,
sent one per second through the queue shared with the open list. Rows initially
use cached data and update as reads finish.

Navigating to another repository stops collection after the current request.
Saved progress allows collection to resume when you return.

Failures appear above the rows as "Failed to load {url}" for list pages and
"Failed to load {GHSA id}" for advisory pages. The banner lists failures from
the current collection. A later collection that succeeds clears it. A crawl
that stops before the last page shows "Failed to load all advisories" beside
the heading.

## The statistics view

Statistics cover both open and completed advisories. The view uses data already
collected by the extension, with coverage limited to what has been read.
Calculations run locally in the page. The statistics view sends no requests
or data.

A repository without collected data shows "Nothing has been read on this
repository".

Chips above the statistics show the total and the open and completed counts.
They identify unread advisories, incomplete or unstarted crawls, and GitHub's
tab counts. "Reading" appears during collection; the numbers can change as
results arrive.

### Counts

Four sections show "Closure reason", "State", "Severity", and "Month". Each
reports its sample size as "N of M". Rows show a value, its count, and its
percentage of the sample. Missing values appear as "None" with a count. Months
use UTC and the format `YYYY-MM`.

"Closure reason" counts completed outcomes: "Published", each stored closure
reason, and "None" for fetched closed advisories without a reason. All these
rows have percentages, including "None". Open advisories and unread closed
advisories are excluded from this section.

The other sections calculate percentages over supplied values. Their "None"
rows show a count without a percentage.

### Timings

Four sections measure elapsed time from the report: "Time to first response",
"Time to accept", "Time to close", and "Time to publish". Each shows "Min",
"Median", "Mean", and "Max".

Unavailable durations are excluded from these calculations and counted in
separate rows: "No response", "Never accepted", "Never closed", and "Never
published". They are neither estimated nor counted as zero.

First response uses the earliest comment by an organization member, excluding
the extension's state and preservation comments. Email responses and actions
without comments are outside this measurement. Acceptance, closure, and
publication use the first matching timeline event. An advisory that is closed,
reopened, and closed again is measured to its first closure.

### Export

"Export CSV" in the statistics heading downloads the whole corpus as
`{owner}-{repo}-advisories-{date}.csv`. Its columns are `ghsa_id`, `title`,
`state`, `severity`, `closure_reason`, `reported_at`, `month`,
`time_to_first_response_ms`, `time_to_accept_ms`, `time_to_close_ms`,
`time_to_publish_ms`, `detail_fetched`, and `observed_at`. Durations use
milliseconds; unavailable durations are blank. The browser generates the file
locally without transmitting it.
