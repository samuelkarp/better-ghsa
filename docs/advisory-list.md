# The advisory list

On a repository's advisory list, `https://github.com/{owner}/{repo}/security/advisories`,
the extension replaces the rows GitHub shows with a table of its own. The table
covers the open advisories, those in triage and in draft. Published and closed
ones are on [the completed view](completed.md).

The point of the table is the order: the advisory most in need of attention is
at the top, and the chips under each title say why it is there.

## The control bar

Above the table:

- "Show GitHub's view" restores GitHub's own state tabs, query form, rows, and
  pagination, and hides the extension's table. The button then reads "Show
  Better GHSA".
- "Show completed" and "Show statistics" open the other two views. Both are
  hidden while GitHub's view is showing.

The page always opens on the extension's table. Which view you were on, how you
sorted, and what you filtered are not remembered across a reload.

The heading reads "Better GHSA" with a count beside it: "N advisories", or "M of
N advisories" while a filter is hiding rows.

## What a row shows

- The advisory title, as a link.
- Beneath it, the GHSA identifier, the date the report was opened, and the
  reporter's login, in the form `GHSA-xxxx-xxxx-xxxx opened 2026-03-14 by
  someone`.
- Beneath that, the chips.
- In its own cell, GitHub's state: "Triage" or "Draft".
- The owners, as profile pictures linking to each account, in the style of issue
  assignees. Absent when nobody owns the advisory.
- "Observed" and the time this extension last read that advisory's own page, in
  UTC. A row whose advisory has never been read reads "Not read".

An unread row carries no chips beyond the severity GitHub's own markup supplied.
Nothing has been read to say what else holds.

## The chips

**Waiting.** What the advisory is waiting on, derived from the thread and the
timeline.

- "Never reviewed": no org member has commented on it or acted on it.
- "New activity": the newest comment from someone outside the org is newer than
  anything a maintainer said or did.
- "Blocked on us": the stored triage value is one a maintainer has to move.
- "Blocked on the reporter": the stored triage value is one the reporter has to
  move.

**Patch**, on draft advisories. "Patch in review" when the advisory's private
fork holds an open pull request, "No patch yet" when it does not, and "Unknown"
when a pull request's state could not be read.

The fork's list shows open pull requests only: merging deletes the fork, and a
closed pull request is not shown there. This chip counts preparation.

**Backports**, when backport targets are set: "Backports 1 of 3", counting the
targets that have a pull request prepared against them.

**CVE.** The identifier once assigned, otherwise "CVE requested" or "CVE not
applicable".

**Severity.** The level, and ", unconfirmed" appended when no maintainer has
confirmed the scoring. A confirmed severity is a filled chip in the color GitHub
paints that level. An unconfirmed severity is dimmed and unfilled. The severity
on an unread row is dimmed too, because nothing has been read that could confirm
it.

**Embargo.** One of "Embargo lifts 2026-04-01", "Embargo overdue since
2026-04-01", or "Embargo, no lift date".

## Order

By default:

1. Every draft advisory before every advisory in triage. A draft has been
   accepted and needs work.
2. Within draft, by group: embargo overdue, then new activity, then blocked on
   us, then blocked on the reporter.
3. Within triage, by group: embargo overdue, then blocked on us, then never
   reviewed, then new activity, then blocked on the reporter.
4. Within a group, by severity: every severity a maintainer confirmed first,
   highest first, then every unconfirmed severity, highest first, then
   advisories with no severity.
5. Then longest waiting first.

An advisory answering to more than one group takes the first it matches. An
advisory with no triage value set is not blocked on anyone, so in triage it
sorts with the never reviewed and in draft it sorts with blocked on us.

The order does not shift while background reads land. The table re-sorts once a
refresh pass finishes, so rows do not move under you as you read.

## Filters and sorts

Seven filter menus: "Waiting", "Severity", "Owner", "State", "Patch",
"Backports", and "Embargo". A menu holding a value reads it in its own label,
as "Severity: Critical". "Any" clears that one menu.

Each menu offers only the values the rows in front of you carry. A menu also
offers "None" when at least one advisory that has been read holds nothing for
that value, which selects exactly those advisories. An advisory nothing has been
read on passes every filter, because no value has been looked up that could
exclude it.

The filter values worth knowing by their wording: "Patch" offers "In review" and
"No patch"; "Backports" offers "Outstanding" and "Complete"; "Embargo" offers
"Overdue" and "In force", and an overdue embargo matches both.

A draft whose pull request state could not be read shows the "Unknown" patch
chip and matches neither patch value.

"Sort" offers three orders: "Default", the order above; "Highest severity",
which puts every confirmed severity above every unconfirmed one and orders each
of those by level; and "Longest waiting", which puts the advisory that has sat
in its current triage value the longest at the top and advisories whose waiting
time could not be read at the bottom.

"Reset" clears every filter and returns the sort to the default. It is the only
clear, and it is disabled while nothing is set.

When a filter keeps no rows, the table reads "No matches".

## Reading and refreshing

The table paints immediately from the local cache and from the list markup
already on the page. Then a refresh runs: it walks the triage and draft list
pages, then reads each advisory's own page, stalest first, updating rows in
place as the reads land.

Requests go out one per second per repository, through a single queue that this
page, the completed view, and the statistics view all share.

A chip beside the heading reports progress: "Loading..." while walking the list
pages, "Loading (12 left)..." while reading advisories, and nothing when the
pass is done.

An advisory in triage or draft is re-read when its last read is more than five
minutes old. A repository does not start a second refresh pass within five
minutes of finishing one. Leaving the repository stops the pass after the
request already in flight, and returning resumes it.

The list page shows no banner when a read fails. A page GitHub refused shows up
as rows that stay "Not read".

## On a repository the settings do not list

Nothing on this page is the extension's. GitHub's own advisory list is what the
page shows, no table is drawn, no refresh runs, and nothing about the repository
is read or stored. Adding the repository in the settings starts the extension on
the page, and removing it stops the extension and puts GitHub's own list back.
