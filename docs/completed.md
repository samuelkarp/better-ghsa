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
those advisories. Filters use available values even before the advisory's detail
page has been read. Unknown values on unread advisories pass applicable filters.

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
means the tracking state changed since the editor loaded it. Your changes were
not saved. "Error: {owner}/{repo} is not on this extension's
allowlist." means writes to that repository are refused.

A closure reason can be staged and saved only after the advisory page has
been read.

## Reading and refreshing

Opening this view crawls the published and closed lists, then reads advisory
pages as needed based on cache freshness. Requests use the queue shared with
the open list in the same tab. Background advisory reads are throttled to one
request per second within each queue.
Requests from separate tabs can occur closer together. Rows initially use
cached data and update as reads finish.

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

Chips above the statistics show the total and the open and completed counts, as
"3 open" and "2 completed". "5 not loaded yet" counts advisories whose detail
page has not been read. "Open list not loaded" and "Completed list partly
loaded" name a group whose list crawl has not started or has not finished. "4 on
GitHub" shows the sum of GitHub's tab counts when it differs from the total.
"Loading..." appears during collection; the numbers can change as results
arrive.

### Counts

Four sections show "Outcome", "Closure reason", "Open", and "Severity". Each
reports its sample size as "N of M". Rows show a value, its count, and its
percentage of the sample. Missing values appear as "None" with a count.

"Outcome" counts completed advisories as "Published" or "Closed". The list page
supplies both, so advisories not loaded yet are counted. Open advisories are
excluded from this section.

"Closure reason" counts closed advisories: each stored closure reason, and
"None" for fetched closed advisories without a reason. All these rows have
percentages, including "None". "Not loaded yet" counts closed advisories whose
detail page has not been read, without a percentage, and appears only when
there are any. The sample size counts fetched closed advisories out of all
closed advisories: with 56 closed advisories, 5 of them not loaded yet, it
reads "51 of 56".

"None" in "Closure reason" is a link. Pressing it opens the completed view
with "State: Closed" and "Closure reason: None" selected.

"Open" counts open advisories as "Triage" or "Draft", with percentages over
open advisories. Completed advisories are excluded from this section.

"Severity" counts published advisories and drafts whose severity a maintainer
has confirmed, the drafts with a filled severity chip in the open list. Triage
and closed advisories are excluded, and so are drafts whose severity is
unconfirmed or has changed since its confirmation. Rows run by level:
"Critical", "High", "Moderate", "Low", any other level, then "None" for
advisories without a severity. "Not loaded yet" counts drafts whose detail
page has not been read, without a percentage, and appears only when there are
any. The sample size counts advisories with a severity out of all of these:
with 10 published advisories, 1 of them without a severity, 3 confirmed
drafts, and 1 draft not loaded yet, it reads "12 of 14".

The other sections calculate percentages over supplied values. Their "None"
rows show a count without a percentage.

### Reports by month

"Reports by month" is a table across the full width of the view, below the
counts. Its columns are "Year", "Jan" through "Dec", and "Total". The table ends
at the later of the current UTC month and the month of the latest report, so a
report dated ahead of the browser's clock counts. Each row is a year, from the
year of the earliest report to the year the table ends, oldest first. A cell
counts open and completed advisories reported in that month, read in UTC: a
report at 23:30 on December 31 in New York (UTC-5) counts in January. An
advisory whose detail read supplies no report time, because it is not loaded yet
or its page shows none, uses the time its list row shows. Months without reports
show 0, months after the end of the table are blank, and "Total" sums the row. A
year without reports between two with them appears with all zeros.

The sample size counts advisories with a report time out of all advisories.
With no report time at all, the table reads "Nothing counted".

### Timings

Four sections measure elapsed time from the report: "Time to first response",
"Time to accept", "Time to close", and "Time to publish". Each shows "Min",
"Median", "Mean", and "Max". Durations that cannot be measured are left out of
these figures, neither estimated nor counted as zero.

A first response is the earlier of the earliest comment by an organization
member and the earliest maintainer action on the timeline. The comments
exclude the extension's state and preservation comments. The actions are the
ones that clear "Never reviewed" in the open list: accepting the report,
adding another person as a collaborator, requesting a CVE, publishing, closing,
and deleting the temporary private fork. A reporter adding themselves as a
collaborator is not a response. Email responses are outside this measurement.
Advisories a maintainer filed are included.

"Time to first response" reports its sample size as the read advisories out of
all advisories, so advisories not loaded yet show only as the difference: with
52 advisories, 5 of them not loaded yet, it reads "47 of 52". "Min", "Median",
"Mean", and "Max" cover the read advisories with a response at or after the
report time. "No response" shows no count. It shows the longest current wait:
among read triage and draft advisories without a response, the longest time
since the report. It appears only when there is such an advisory. Completed
advisories without a response are outside this row.

"Time to accept" also reports its sample size as the read advisories out of
all advisories. "Min", "Median", "Mean", and "Max" cover the read advisories
with an acceptance event, whatever their state. "Never accepted" shows no
count. It shows the longest current wait: among read triage advisories
without an acceptance event, the longest time since the report. It appears
only when there is such an advisory. Draft, published, and closed advisories
without an acceptance event are outside this row.

"Time to close" covers closed advisories only. Its sample size counts the read
closed advisories out of all closed advisories: with 56 closed advisories, 5 of
them not loaded yet, it reads "51 of 56". "Min", "Median", "Mean", and "Max"
cover the read closed advisories with a close on their timeline. A reporter who
withdraws a report closes the advisory, and that close is measured like any
other. No row appears beside the spread.

"Time to publish" covers published advisories only. Its sample size counts the
read published advisories out of all published advisories. "Min", "Median",
"Mean", and "Max" cover the read published advisories with a publication on
their timeline. "Never published" shows no count. It shows the longest current
wait: among read drafts, the longest time since the report. It appears only
when there is such a draft. Triage and closed advisories are outside this row.

Acceptance, closure, and publication use the first matching timeline event. An
advisory that is closed, reopened, and closed again is measured to its first
closure.

### Export

"Export CSV" in the statistics heading downloads the whole corpus as
`{owner}-{repo}-advisories-{date}.csv`. Its columns are `ghsa_id`, `title`,
`state`, `severity`, `closure_reason`, `reported_at`, `month`,
`time_to_first_response_ms`, `time_to_accept_ms`, `time_to_close_ms`,
`time_to_publish_ms`, `detail_fetched`, and `observed_at`. Durations use
milliseconds; unavailable durations are blank. `time_to_first_response_ms`
measures to the first response the statistics use. The browser generates the file
locally without transmitting it.
