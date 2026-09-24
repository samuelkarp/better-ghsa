# The advisory list

On a repository's advisory list,
`https://github.com/{owner}/{repo}/security/advisories`, the extension replaces
GitHub's rows with a table of open advisories in triage and draft. Published
and closed advisories appear in [the completed view](completed.md).

The default order puts advisories needing attention first. Chips under each
title show their status.

## The control bar

Above the table:

- "Show GitHub's view" restores GitHub's state tabs, query form, rows, and
  pagination. The button then reads "Show Better GHSA".
- "Show completed" and "Show statistics" open the other two views. Both toggles
  are hidden in GitHub's view.

The page opens on the extension's table. Reloading resets the selected view,
sort order, and filters.

The heading reads "Better GHSA" with a count: "N advisories", or "M of N
advisories" when filters exclude rows.

## What a row shows

- The advisory title as a link.
- The GHSA identifier, report date, and reporter's login, in the form
  `GHSA-xxxx-xxxx-xxxx opened 2026-03-14 by someone`.
- Status chips beneath that line.
- Owners' profile pictures linking to their accounts. This cell is empty when
  the advisory has no owners.
- GitHub's state, "Triage" or "Draft", in a separate cell.
- "Observed" with the UTC time the extension last read the advisory page, or
  "Not read" if it has not read the advisory.

The open and completed views use the same row builder. Both put the state and
observation time in the last two cells.

Unread rows show only the severity chip supplied by GitHub's list markup.
Other chips require data from the advisory page.

## The chips

**Waiting.** A stored triage value appears in sentence case: "Evaluating",
"Awaiting reporter", or "Awaiting maintainer input". Without a stored value,
the chip reflects the comments and timeline:

- "Never reviewed": an organization member has neither commented nor acted on
  the advisory.
- "New activity": the newest comment from outside the organization is newer
  than the latest maintainer comment or action.
- "Blocked on us": neither condition applies and triage is unset.

"Never reviewed" or "New activity" also appears alongside a stored triage
value. The derived chip comes first:

    [New activity] [Evaluating] [No patch yet] [High]

"Evaluating" and "Awaiting maintainer input" both require maintainer action.
Their chips display the stored value.

"Never reviewed", "Blocked on us", "Evaluating", and "Awaiting maintainer
input" use the stronger color for maintainer action. "New activity" and
"Awaiting reporter" use the quieter color.

The waiting filter prioritizes "Never reviewed", then "New activity", then who
the stored triage value is waiting on. Sorting follows the separate group
priorities below.

**Patch**, on draft advisories. "Patch in review" means the private fork has an
open pull request. "No patch yet" means it has none. "Unknown" means a pull
request's state could not be read.

The fork lists open pull requests only. Merging deletes the fork, and closed
pull requests are absent from its list. This chip measures patch preparation.

**Backports**, when targets are set. "Backports 1 of 3" counts targets with a
prepared pull request.

**CVE.** The assigned identifier, "CVE requested", or "CVE not applicable".

**Severity.** The level with ", unconfirmed" appended until a maintainer
confirms the scoring. Confirmed severity uses a filled chip in GitHub's color
for that level. Unconfirmed severity is dimmed and unfilled. Unread rows also
have dimmed severity chips.

**Embargo.** One of "Embargo lifts 2026-04-01", "Embargo overdue since
2026-04-01", or "Embargo, no lift date".

## Order

By default:

1. Draft advisories precede triage advisories.
2. Draft groups are ordered: embargo overdue, new activity, blocked on us,
   blocked on the reporter.
3. Triage groups are ordered: embargo overdue, blocked on us, never reviewed,
   new activity, blocked on the reporter.
4. Within each group, confirmed severities precede unconfirmed severities.
   Each is ordered highest first, followed by advisories without severity.
5. Then longest waiting first.

An advisory belongs to the first group it matches. Without a stored triage
value, it sorts with never reviewed in triage and blocked on us in draft.

Rows stay in place during background reads. The table sorts again after the
refresh finishes.

## Filters and sorts

Seven filter menus are available: "Waiting", "Severity", "Owner", "State",
"Patch", "Backports", and "Embargo". A selected value appears in the label,
as "Severity: Critical". "Any" clears that menu.

Menus offer values from the displayed rows. "None" appears when at least one
read advisory lacks a value and selects those advisories. Filters use available
values even before the advisory's detail page has been read. Unknown values on
unread advisories pass applicable filters.

"Patch" offers "In review" and "No patch". "Backports" offers "Outstanding"
and "Complete". "Embargo" offers "Overdue" and "In force"; an overdue embargo
matches both.

A draft with an unreadable pull request state shows "Unknown" and matches
neither patch value.

"Sort" offers:

- "Default": the order above.
- "Highest severity": confirmed severities first, then unconfirmed severities,
  each ordered by level.
- "Longest waiting": longest time in the current triage value first, with
  unknown waiting times last.

"Reset" clears every filter and restores the default sort. It is disabled
when the view already has those settings.

The table reads "No matches" when filters exclude every row.

## Reading and refreshing

The table initially displays cached data and the list markup already on the
page. At the start of each page load, a refresh walks the triage, draft,
published, and closed lists, then reads the open advisories' pages, stalest
first. Each read updates its row in place. The walk runs whichever view is
showing, and the completed and statistics views use what it finds.

The list walk, the table's reads, and the completed view's reads share one
request queue per repository within a tab. The statistics view issues no
requests. Background requests are throttled to one per second within each
queue. Requests from separate tabs can occur closer together.

The heading shows "Loading..." during the list walk and "Loading (12 left)..."
during advisory reads. The progress chip disappears when the refresh finishes.

Each list is walked once per page load. A page load starts when a page shows
the repository's advisory list. Moving between the list's tabs and the
repository's advisories keeps it. Moving to another repository or to any other
page ends it, and coming back to the list starts a new one, as does reloading
the page. Within a page load, later refreshes walk no finished list again.
They finish a list walk that stopped part way, and a list page that fails
three times in a row abandons its walk until the next page load. A list walk
an earlier page load left part way starts over from its first page.

Triage and draft advisories are reread when their observations are more than
five minutes old. Within a page load, refreshes start at least five minutes
apart, and a new page load refreshes at once. A new refresh waits until the
current one finishes. Leaving the list stops the refresh after its current
request. Coming back from an advisory resumes it.

Failed reads leave existing cached data visible. Advisories without cached data
remain marked "Not read". The list omits failure banners.

## On a repository the settings do not list

On an unlisted repository, the extension adds only the settings button.
GitHub's advisory list remains visible. The extension does not read or store
advisory data or fetch advisory pages.

Adding the repository in settings starts the extension on the page. Removing
it stops the extension and restores GitHub's list.
