# Better GHSA: requirements

Better GHSA is a Chrome and Firefox extension for maintainers handling GitHub
Security Advisories. Version 1 is built for `containerd/containerd` and its
maintainer workflow.

## 1. Platform facts this design rests on

Documented behavior:

- The repository security advisories REST API
  (https://docs.github.com/en/rest/security-advisories/repository-advisories)
  covers list, get, create, update, CVE request, and private fork creation.
  Writable fields are `summary`, `description`, `severity`,
  `cvss_vector_string`, `cwe_ids`, `cve_id`, `vulnerabilities`, `credits`,
  `state`, `collaborating_users`, `collaborating_teams`, and
  `start_private_fork`. States are `triage`, `draft`, `published`, `closed`,
  and `withdrawn`.
- The API does not expose advisory comments or the advisory timeline.
- Closing an advisory does not record a reason.
- Advisory comments are visible to the reporter and to advisory collaborators
  (https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/fix-reported-vulnerabilities/manage-vulnerability-reports).
- Publishing an advisory makes the advisory data public and keeps the
  conversation collaborator-only
  (https://docs.github.com/en/code-security/concepts/vulnerability-reporting-and-management/about-repository-security-advisories).

Observed behavior in the web UI:

- The `description` field has a revision history dropdown. The title, severity,
  CVSS vector, and CWE fields do not.
- Comment authors in an advisory thread carry `Author` and `Member` badges.
- Pull requests opened in the advisory's private fork are shown on the advisory
  detail page.
- CVE request and CVE assignment appear as notes on the advisory detail page.
- Posting a comment notifies advisory participants, including the reporter.

Assumptions requiring verification:

- Editing an existing comment does not notify participants. The write model in
  section 3 depends on this.
- The `Member` badge is present for every org member, including security
  advisors. If it is unreliable, fetch and cache the `containerd` org member
  list through the user's session.

## 2. Storage

All shared state lives in the advisory it describes. The extension does not
operate a server or a database.

The browser cache can be reconstructed from the advisories, which remain
authoritative. Refresh entries according to advisory state and display stale
entries during refresh. Evict entries for deleted advisories. A settings
control clears cached data immediately while preserving the repository list.

Removing a repository from the allowlist clears its cached advisories, lists,
refresh progress, and observed release branches. Clear observed organization
members only after the last repository from that organization is removed.

An entry's observation time records when its content was read. After a write,
update the entry with the written state. Content read before the write must
retain its original observation time.

Store data only for allowed repositories.

Reads poll for changes made by other maintainers and by GitHub.

## 3. Write model

Each maintainer has at most one state comment per advisory. Create it on the
maintainer's first write and edit it on subsequent writes. A maintainer edits
only their own comment. State comments generate one notification per advisory
for each maintainer who uses the extension.

The state comment body is a collapsed `<details>` block containing a JSON code
fence. JSON is the only representation and remains in the rendered DOM for
content scripts to read.

Each write records a complete snapshot of the extension-managed record. Each
snapshot carries a sequence number one higher than the highest the writer
observed across all state comments on that advisory. Current state is
the snapshot with the highest sequence number, with ties broken by the author's
login in lexicographic order. History is the union of the snapshots in each
maintainer's comment.

Before writing, read the current merged state, apply the staged changes, and
preserve unrecognized fields.

Immediately before writing, the extension re-reads the advisory's state
comments. If the highest sequence number has changed since the panel loaded,
the write is refused and the panel reloads with the new state. The maintainer
reapplies the change.

Control changes accumulate in the panel and are written on an explicit save.
Navigating away with unsaved changes produces a warning.

Disable the submitting surface's controls while a save is in progress. Write
the values displayed when the save starts.

Save every staged change or refuse the save. Stage only values that differ
from stored state and remain applicable under the other controls.

Turning an embargo off excludes its lift date from the staged changes. Retain
the date in the control until the next save to restore it if the embargo is
turned back on. After saving, redraw all controls from stored state; a disabled
embargo does not have a stored lift date. Returning a control to its stored value
clears its staged change.

Every snapshot carries a schema version. Apply the trust and schema rules in
section 4 before using it.

## 4. Trust

A snapshot is honored only when its comment's author carries the `Member` or
`Owner` badge. Security advisors are org members and are trusted.

Ignore snapshots without a valid sequence number and display a warning.
For snapshots with a valid sequence number:

- Ignore state from untrusted authors and display a warning. Their schema
  versions do not make the editor read-only.
- For a trusted author with an unsupported major schema version, make the
  editor read-only and report that the extension needs an update.
- For a trusted author with a supported schema but an invalid payload, ignore
  the state and display a warning. Require explicit confirmation before a
  write supersedes it.

The extension labels every comment in the thread by author role, distinguishing
org members from everyone else.

## 5. Reporter visibility

The reporter can read every state comment. Use vocabulary suitable for sharing
with the reporter, as specified in section 6. Store the payload as readable JSON
without obfuscation.

## 6. Tracked state

### Stored tracks

**Triage.** One of `evaluating`, `awaiting reporter`, `awaiting maintainer
input`. Derive unreviewed status from the absence of org member activity.
GitHub's native state records acceptance and rejection.

**Owner.** Zero or more org members, matching how issues are assigned. Any
maintainer can set any maintainer.

**Advisory text confirmation.** A record that a named maintainer confirmed the
title and a record that a named maintainer confirmed the description, each
carrying a fingerprint of the value confirmed and the time of confirmation.

**Scoring confirmation.** A record that a named maintainer confirmed the
severity and CVSS vector, carrying a fingerprint of the value confirmed and the
time of confirmation. The reporter's proposed score is not stored. The display
distinguishes a score confirmed by a maintainer from a score supplied by the
reporter and not yet confirmed.

A confirmation applies only while its fingerprint matches the current value.
After a mismatch, display the track as unconfirmed and identify the maintainer
and time of the earlier confirmation.

**Backport targets.** The set of release branches this advisory requires a
backport to. A maintainer sets the targets. Suggestions may use GitHub's
affected-version data. Supported containerd branches are non-contiguous, so
suggestions require maintainer review.

**Embargo.** Whether an embargo applies, and the lift date.

**Closure reason.** A maintainer can set, change, or clear it, including
retroactively on advisories closed before the extension existed. One of:

- `duplicate`, carrying a pointer to the GHSA it duplicates
- `not a vulnerability`
- `not reproducible`
- `working as intended`
- `out of scope`
- `no reporter response`
- `withdrawn by reporter`

Store the duplicate pointer as entered. The detail panel and completed list
link complete GHSA identifiers and github.com issue or pull request URLs.
Display other values as text. Resolve GHSA identifiers within the current
repository. Display issue and pull request links as `#412` within that
repository and `owner/repo#412` for other repositories.

### Derived state

Derived state is read from the advisory detail page and is never stored.

**Patch.** Whether a private fork exists, which pull requests are open in it,
and which branches they target. Combined with the stored backport targets, this
yields backport progress as a count of required branches that have a patch
prepared.

Merging deletes the private fork. The advisory exposes only open pull
requests. Backport progress measures patch preparation.

**CVE.** Whether a CVE has been requested and whether one has been assigned,
from the notes on the detail page and the `cve_id` field.

**Never reviewed.** The advisory lacks evidence of org member activity. The
`draft` and `published` states establish a review because entering either state
requires a maintainer. The `closed` state alone does not establish a review;
the reporter can withdraw a report.

Comments with a member or owner badge count as reviews. The following timeline
events also count, even when the actor's membership is unknown: accepting the
report, adding another person as a collaborator, requesting a CVE, publishing,
closing the advisory, and deleting the temporary private fork.

Reporter and GitHub events do not establish a review: crediting a reporter,
accepting credit, adding themselves as a collaborator, changing the title,
creating the temporary private fork, releasing, and assigning a CVE identifier.

Closing a pull request inside the private fork does not produce an advisory
timeline event. The fork's timeline events are creation and deletion. Its pull
request list exposes only open pull requests.

Match complete event phrases. Distinguish `accepted this report` from
`accepted credit`, and `added as a collaborator` from `added themselves as a
collaborator`.

**New activity.** The most recent comment from a non-member is newer than the
most recent member comment or member action. It clears when a maintainer
responds or changes anything.

**Waiting.** How long the advisory has been in its current triage value. For an
advisory whose triage value is set for the first time, the duration is measured
from the most recent maintainer action on the advisory, or from the report time
when no maintainer has acted.

**Embargo overdue.** The embargo lift date has passed and the advisory is not
published.

Every triage value is classified as blocked on us or blocked on the reporter,
and that classification drives sorting and filtering.

## 7. Preserving the original report

The reporter's title and text are overwritten in place when maintainers rewrite
them for publication.

On an explicit button press, the extension writes one comment per advisory
holding the advisory's current title and description inside a collapsed
`<details>` block, formatted for a human reader. The extension does not read the
saved report back. Offer the button only while the advisory lacks a
preservation comment.

Preserve nested `<details>` blocks. Remove unmatched closing `</details>` tags
to keep the report inside the enclosing collapsed block.

Identify the original report in the summary line. The body contains only the
title and description under plain labels.

Refuse preservation when the extension cannot verify that the description is
the reporter's original text.

Preservation requires pressing the button before a maintainer rewrites the
report. The extension cannot recover the original afterward.

Treat the filer as the reporter, including when the filer is an org member.

## 8. Advisory detail page

The detail panel displays derived state, edits stored state, and shows
confirmation status. Show the original-report preservation row and button only
for triage and draft advisories.

Keep editing controls available in every advisory state, including for
retroactive owner and closure-reason changes.

Show the panel only on allowed repositories.

Show changed values as unconfirmed, using the same status as values that have
never been confirmed.

Start the panel with the same waiting chips as the list row, using their shared
implementation. Also show the stored triage value and waiting duration in a
separate row. Show the patch chip for draft advisories. Omit severity, CVE, and
the list of snapshots from the panel. Mark untrusted snapshots on their comments
in the thread alongside the author role labels from section 4.

The extension writes nothing to GitHub beyond its two comment types. It does
not change `summary`, `description`, severity, advisory state, or any other
native field.

## 9. Advisory list page

Replace the advisory list body with the extension's table. Provide a toggle to
GitHub's native view that restores its rows, state tabs, and query form. Hide
the native tabs and form while the extension table is visible.

Each row shows the advisory title as a link, GitHub's state, and the owners as
profile icons in the style of issue assignees. Below the title, chips carry the
waiting state, the patch state including backport progress, the confirmation
state of text and scoring, the CVE state, the severity marked as confirmed or
unconfirmed, and the embargo. A confirmed severity is filled with the color
GitHub paints that level. Each row shows the time its data was observed.

Use the sentence-cased stored triage value as the waiting chip. If triage is
unset, use the derived waiting state. Show never reviewed and new activity as
additional derived chips before a stored triage chip. Show blocked on us and
blocked on the reporter only when triage is unset.

Color waiting chips by who must act next: maintainers for evaluating and
awaiting maintainer input, and the reporter for awaiting reporter. The stored
labels distinguish the two maintainer states.

Filter and order rows by derived state, including when the chip shows stored
triage.

Rows are filterable on waiting, severity, owner, state, patch, backports, and
embargo, with a control that clears every filter. They are sortable by the
default order, by severity, and by longest waiting.

The default order places draft advisories before triage advisories.

Within draft:

1. Embargo overdue.
2. New activity.
3. Blocked on us.
4. Blocked on the reporter.

A draft advisory has already received a maintainer review.

Within triage:

1. Embargo overdue.
2. Blocked on us.
3. Never reviewed.
4. New activity.
5. Blocked on the reporter.

Assign an advisory to the first matching group.

When stored triage is unset, use the never reviewed group for triage advisories
and blocked on us for drafts, subject to the group priority above.

Within each group, sort by confirmed severity descending, then unconfirmed
severity descending, then longest waiting. Every confirmed severity ranks above
every unconfirmed severity. A confirmed low therefore sorts above any
unconfirmed reporter-supplied severity.

Published and closed advisories are excluded from this table and appear on the
done page described in section 10.

The list page renders from cache immediately and refreshes in the background,
stalest first, at a throttled rate. Rows update as data arrives. Reading an
advisory's state costs one fetch of its detail page, which also supplies every
derived value.

Read every page of each repository advisory list without a page-count cap.
Throttle requests and report any walk that stops before its last page as
incomplete in the views that use it.

## 10. Done page and statistics

The advisory list links to separate done and statistics views.

The done page lists published and closed advisories. Closure reasons can be set
here retroactively.

Use purple state chips for closed advisories and green for published
advisories, matching GitHub. Show severity beside the state chip only for
published advisories, using the confirmed-severity fill from section 9.
Offer closure-reason controls only for closed advisories.

Order rows by their latest closure or publication matching the current state,
newest first. An advisory closed, reopened, and closed again uses its latest
closure. Show that event and its date below the title. Place unread
advisories and those without a matching event last, in GHSA identifier order.

Filter rows by state, closure reason, and severity. Provide a control to clear
every filter. Apply closure-reason filtering to closed advisories, including
a value for unset reasons. Apply severity filtering to published advisories.
Use the open list's filter bar and show the controls for the current view.

Show collection status from the moment collection is requested, including
while its list walk waits for earlier queued work. Identify the list walk, then
show the remaining advisory reads across all views sharing the queue. Update
the count as work proceeds and clear the loading status when collection stops.

Update the originating row after saving a closure reason.

The statistics view covers all open and completed advisories.

Show counts and ratios by outcome, closure reason, open state, severity, and
month.

Outcome statistics count completed advisories as published or closed.
Closure-reason statistics cover closed advisories. Count them by their stored
reason, with an explicit category for unset reasons. Include that category in
the ratios. Other counts exclude missing values from their ratios. Exclude
triage and draft advisories from outcome and closure-reason statistics.

Open-state statistics count open advisories as triage or draft, with ratios
over open advisories.

Severity statistics cover published advisories and drafts whose scoring a
maintainer has confirmed at its current value, the confirmation behind the
filled severity chip of section 9. Exclude triage and closed advisories,
unconfirmed drafts, and drafts whose scoring has changed since its
confirmation. Order severities by level: critical, high, moderate, low, any
other level, then unset. Judging a draft's confirmation requires reading its
detail page. Exclude unread drafts from severity ratios and show their count
beside the severities.

The list page establishes publication and closure. A closure reason requires
reading the detail page. Exclude unread closed advisories from closure-reason
ratios until their reason can be determined, and show their count beside the
closure reasons.

The unset-reason category of the closure-reason statistics links to the done
page filtered to closed advisories with an unset reason.

Timing, reconstructed from page-observable events:

- Time to first response, measured to the first comment by an org member that
  the extension did not write. Exclude state and preserved-report comments.
  Email contact is unobservable and excluded.
- Time to accept, measured to the advisory entering draft.
- Time to close.
- Time to publish.

Measure closure and publication separately. Timings use the first matching
event; done-list ordering uses the last.

Beside each timing, show a row counting advisories without the required event:
response, acceptance, closure, or publication. Display each omission as a label
and count.

Omit metrics whose required event is unobservable. Do not estimate them.

The page exports to CSV.

Compute statistics and export CSV locally without transmitting the data.

## 11. Failure behavior

The extension locates the elements it needs with targeted queries and does not
validate the whole page structure.

When it cannot read something, it displays what it can, marks the result
incomplete, and shows a banner naming what it could not read.

Refuse writes and show a banner when the extension cannot verify the required
data and controls.

## 12. Platform and distribution

Support Chrome and Firefox from one codebase. Use the logged-in `github.com`
session without requesting a token or storing credentials. Contact only
`github.com` and do not collect telemetry.

On unlisted repositories, show only the settings button on advisory pages.
Do not read or store advisory data or fetch advisory pages.

The allowlist starts empty and is edited in settings. Apply allowlist changes
to open pages without reloading. Every advisory list and detail page has one
settings control, including repositories outside the allowlist.

On a GHSA private fork's pull request diff page (`/pull/{number}/changes` or
`/pull/{number}/files`), the extension removes the outer width limit and extra
horizontal padding. The diff viewer retains its own padding. This layout change
uses the parent repository's allowlist entry, inferred from the fork's
`owner/repo-ghsa-xxxx-xxxx-xxxx` name, and follows navigation and allowlist edits.

The extension does not use a background script. Every view runs as a content
script in a page.

The extension depends on undocumented endpoints and GitHub's DOM. Changes to
either can break it.

Distribute the extension through addons.mozilla.org and the Chrome Web Store.
Also support loading a repository clone directly without a build step.

Use `better-ghsa@sbk.wtf` as the Firefox add-on ID. Manifest V3 signing
requires an explicit ID; addons.mozilla.org does not assign one. Keep the ID
fixed from the first signing to preserve updates. Require Firefox 140 or later.

Declare the absence of data collection and transmission in the manifest, as
required by addons.mozilla.org. The declaration is displayed at installation
and must match the extension's behavior. It requires Firefox 140 or later and
Firefox for Android 142 or later.

Maintainers can collaborate without all installing the extension. Preserve
extension state when maintainers use GitHub's native UI and reflect their
actions in derived state.

## 13. Out of scope for v1

- Review status of private-fork pull requests. The advisory page omits review
  status; reading it would require one fetch per pull request. Patch state
  treats approved and unreviewed pull requests alike.
- Check status of private-fork pull requests. Private forks do not run CI,
  although GitHub displays an expected check state.
- Field-level merge on a write conflict.
- A cross-repository or org-wide view.
- A configurable track vocabulary.
- Per-maintainer snooze.
- Any write to GitHub outside the extension's two comment types.
