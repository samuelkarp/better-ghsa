# Better GHSA: requirements

A browser extension for Chrome and Firefox that adds tracking to GitHub
Security Advisories for the maintainers who handle them. The target user is a
containerd maintainer working on `containerd/containerd`, and v1 is built for
that one repository and that one workflow.

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

Load-bearing assumptions, to be verified during implementation:

- Editing an existing comment does not notify participants. The write model in
  section 3 depends on this.
- The `Member` badge is present for every org member, including security
  advisors. If it turns out to be unreliable, the fallback is to fetch the
  `containerd` org member list with the user's session and cache it.

## 2. Storage

All shared state lives in the advisory it describes. The extension does not
operate a server or a database.

The extension keeps a local cache in the browser. The cache is never
authoritative and is always rederivable from the advisories. An entry is kept
and refreshed on a schedule that follows the advisory's state, and a stale
entry is shown while its refresh runs. An entry is evicted when its advisory no
longer exists, and by a control in the extension's settings that clears the
cache immediately. That control leaves the repository list alone, because
clearing the list would turn the extension off.

Taking a repository off the list clears what was stored for it: its advisory
reads, its list reads, its refresh progress, and the release branches observed
on it. Observed organization members are keyed by organization, so they are
cleared only when no repository from that organization is still listed.

An entry's observation time is the time the content in it was read. A write
this extension makes updates the entry to carry what was written, so a surface
reading the cache afterwards sees the new state. Storing content read before a
write, under a timestamp taken after it, is the one thing the cache must never
do: the entry then looks fresh enough to skip a refresh while holding state the
maintainer has already replaced.

Nothing accumulates for a repository the extension does not read, because the
allowlist bounds what it ever stores.

Every read is a poll. Other maintainers write through their own browsers, and
GitHub changes derived state without notifying the extension.

## 3. Write model

Each maintainer has at most one state comment per advisory. The extension
creates it on that maintainer's first write and edits it on every write after
that. No maintainer edits another maintainer's comment. Each advisory therefore
generates one notification per maintainer who uses the extension.

The state comment body is a collapsed `<details>` block containing a JSON code
fence. The JSON is the only representation, and it stays in the rendered DOM
where a content script reads it.

Each write records a complete snapshot of the extension-managed record, not a
delta. Each snapshot carries a sequence number one higher than the highest the
writer observed across all state comments on that advisory. Current state is
the snapshot with the highest sequence number, with ties broken by the author's
login in lexicographic order. History is the union of the snapshots in each
maintainer's comment.

A write is read-merge-write: the writer copies the current merged state
forward, applies its own changes, and preserves any fields it does not
recognize.

Immediately before writing, the extension re-reads the advisory's state
comments. If the highest sequence number has changed since the panel loaded,
the write is refused and the panel reloads with the new state. The maintainer
reapplies the change.

Control changes accumulate in the panel and are written on an explicit save.
Navigating away with unsaved changes produces a warning.

While a save is in flight, the controls that fed it are disabled, on whichever
surface the save was started from. The values written are the values on screen.

A save carries every staged change or the panel refuses it. Nothing the write
would not carry is staged: a value another control has made irrelevant, and a
value equal to the one already stored. Turning an embargo off stages no lift
date, and the date stays in the control until the next save, so turning the
embargo back on beforehand restores it. A save redraws every control from
stored state, which no longer carries a lift date. Moving a control away from
its stored value and back leaves nothing staged.

Every snapshot carries a schema version. A reader that encounters a major
version it does not understand goes read-only and reports that the extension
needs an update.

## 4. Trust

A snapshot is honored only when its comment's author carries the `Member` or
`Owner` badge. Security advisors are org members and are trusted.

A well-formed snapshot in a comment from any other author is ignored for state
purposes, and the extension displays a warning on that advisory.

A snapshot from a trusted author that the extension cannot interpret is also
ignored for state purposes and warned on. Where that snapshot still carries an
ordering claim, changing state on that advisory takes one explicit
confirmation, after which the new value supersedes it.

The extension labels every comment in the thread by author role, distinguishing
org members from everyone else.

## 5. Reporter visibility

The reporter reads the whole thread, including every state comment. The
vocabulary in section 6 is chosen so that every value is something a maintainer
is willing to say to the reporter. The extension does not encode or obfuscate
its payload.

## 6. Tracked state

### Stored tracks

**Triage.** One of `evaluating`, `awaiting reporter`, `awaiting maintainer
input`. An advisory that no org member has acted on is reported as unreviewed
by derivation, and no stored value expresses that. Acceptance and rejection are
expressed by GitHub's own state.

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

Every confirmation binds to what it confirmed. When the current value stops
matching the fingerprint, the track reverts to unconfirmed and reports who
confirmed a different value and when.

**Backport targets.** The set of release branches this advisory requires a
backport to. A maintainer sets it. The affected-version data GitHub stores can
seed a suggestion, and the containerd branches in support are non-contiguous,
so the suggestion is not authoritative.

**Embargo.** Whether an embargo applies, and the lift date.

**Closure reason.** Set once, at close, and settable retroactively on
advisories that were closed before the extension existed. One of:

- `duplicate`, carrying a pointer to the GHSA it duplicates
- `not a vulnerability`
- `not reproducible`
- `working as intended`
- `out of scope`
- `no reporter response`
- `withdrawn by reporter`

### Derived state

Derived state is read from the advisory detail page and is never stored.

**Patch.** Whether a private fork exists, which pull requests are open in it,
and which branches they target. Combined with the stored backport targets, this
yields backport progress as a count of required branches that have a patch
prepared.

A private fork is deleted when its changes merge into the repository, so a
merged pull request is never visible on an advisory the extension is tracking,
and progress counts preparation.

**CVE.** Whether a CVE has been requested and whether one has been assigned,
from the notes on the detail page and the `cve_id` field.

**Never reviewed.** No org member has commented on or acted on the advisory. An
advisory in `draft` or `published` has been reviewed, because a maintainer moved
it there. A `closed` advisory has not, on its own, been reviewed, because the
reporter can withdraw a report.

A comment counts when its author carries a member or owner badge. A timeline
event counts when only a maintainer could have caused it, whether or not the
extension can place its actor: accepting the report, adding another person as a
collaborator, requesting a CVE, publishing, closing the advisory, and deleting
the temporary private fork. The rest do not count, because the reporter or
GitHub itself produces them: crediting a reporter, accepting credit, adding
themselves as a collaborator, changing the title, creating the temporary
private fork, releasing, and assigning a CVE identifier.

A pull request closed inside the private fork produces no timeline event at
all. The fork's only events are its creation and its deletion, and the fork's
pull request list shows open pull requests only. A merged or closed pull
request is not something the extension can ever read.

These phrases are matched whole. `accepted this report` sits in the same
timeline as `accepted credit`, and `added as a collaborator` inside `added
themselves as a collaborator`, so a partial match reads a reporter's act as a
maintainer's.

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
`<details>` block, formatted for a human reader. The extension never reads this
comment back, and offers the button only where no such comment exists on that
advisory.

A description carrying its own `<details>` blocks keeps them, and they render
nested inside the enclosing one. A closing `</details>` with no matching opener
is removed, because it would end the enclosing block early and spill the rest
of the report into the thread.

The summary line is what records that the comment holds the original report.
The body carries the title and the description under plain labels and says
nothing further about them.

The extension refuses to write where it cannot tell whether the description is
the reporter's original text.

Pressing the button before a maintainer rewrites the report is what preserves
the original. Nothing recovers it afterward.

The filer of an advisory is its reporter whether or not they are an org member.
Advisories a maintainer files are treated the same as any other.

## 8. Advisory detail page

The extension adds a panel that displays derived state, displays and edits
stored state, and shows whether each confirmation stands. It offers the button
that preserves the original report while the advisory is in triage or draft.
Once an advisory is published or closed it is dealt with, and capturing the
reporter's original wording serves nothing, so neither the button nor the row
is shown.

The editing controls stay live in every state. A closure reason and the owners
remain worth recording after an advisory is published or closed, and the done
page exists to set a closure reason retroactively.

On a repository the allowlist does not carry, there is no panel, because the
extension does not run there at all.

A confirmation is confirmed or it is not. A value that has changed since it was
confirmed reads as unconfirmed, the same as one nobody has confirmed, because
the maintainer's next act is the same either way.

The panel shows what a maintainer has to act on. It carries the same waiting
state chip the list row carries, from the same derivation, so the reason an
advisory sits where it does on the list is the first thing its page says. On a
draft advisory it carries the patch chip too. It does not restate what the
advisory page already carries, which is why severity and the CVE stay off it,
and it does not list the snapshots it read. A
snapshot from an untrusted author is marked on that comment in the thread,
where section 4's author role labels already are.

The extension writes nothing to GitHub beyond its two comment types. It does
not change `summary`, `description`, severity, advisory state, or any other
native field.

## 9. Advisory list page

The extension replaces the body of the repository's advisory list with its own
table, and provides a toggle back to GitHub's native view. While the table is
showing, GitHub's own state tabs and query form are hidden, and the toggle
restores them together with the native rows.

Each row shows the advisory title as a link, GitHub's state, and the owners as
profile icons in the style of issue assignees. Below the title, chips carry the
waiting state, the patch state including backport progress, the confirmation
state of text and scoring, the CVE state, the severity marked as confirmed or
unconfirmed, and the embargo. A confirmed severity is filled with the color
GitHub paints that level. Each row shows the time its data was observed.

Rows are filterable on waiting, severity, owner, state, patch, backports, and
embargo, with a control that clears every filter. They are sortable by the
default order, by severity, and by longest waiting.

Filtering and sorting on every value the extension holds produced eleven
standing controls and fourteen sort options, which is more than a maintainer
reads. These are the values worth narrowing a queue by. The default order
already carries state, group, severity and waiting, so a sort exists for
looking at the list another way and not for working it.

Default ordering is by state first. A draft advisory has been accepted and
needs active work, so every draft sorts above every advisory in triage.

Within draft:

1. Embargo overdue.
2. New activity.
3. Blocked on us.
4. Blocked on the reporter.

Never reviewed cannot arise in draft, because a maintainer moved the advisory
there.

Within triage:

1. Embargo overdue.
2. Blocked on us.
3. Never reviewed.
4. New activity.
5. Blocked on the reporter.

An advisory that answers to more than one group takes the first it matches.

An advisory carrying no stored triage value is not blocked on anyone, because
the classification is of triage values and it has none. In triage it takes the
never reviewed group. In draft, where never reviewed cannot arise, it takes
blocked on us: a maintainer accepted it and has not said where it stands.

Within each group, by confirmed severity descending, then by unconfirmed
severity descending, then by longest waiting.

Severity is two keys, not one. Every severity a maintainer confirmed ranks
above every severity nobody has confirmed, so a confirmed low sorts above a
severity the reporter claimed and no maintainer has checked.

Published and closed advisories are excluded from this table and appear on the
done page described in section 10.

The list page renders from cache immediately and refreshes in the background,
stalest first, at a throttled rate. Rows update as data arrives. Reading an
advisory's state costs one fetch of its detail page, which also supplies every
derived value.

Reading a repository's advisory lists walks every page. Nothing caps how many
pages it will read; the throttled rate is the only bound. A walk that stops
before the last page is recorded as incomplete, and the surfaces reading from
it say so.

## 10. Done page and statistics

Two views, each reached from the advisory list.

The done page lists published and closed advisories. Closure reasons can be set
here retroactively.

Each row carries a state chip colored by the ending the advisory came to: closed
purple and published green, which is how GitHub colors them. The severity stands
beside it, and a closed advisory carries none. On a published advisory it is
filled the way a confirmed severity is in section 9, because publication settles
the rating.

A published advisory has no closure reason, so its row carries no control for
setting one.

Rows are filterable on state and on closure reason, with a control that clears
every filter. Those filters stand on the same bar as the open list's, and the
bar shows the set belonging to the view on screen.

While the page is collecting, the view says what the collection is doing: the
walk, and then how many advisories the queue has still to read. That number
counts the work of every surface the queue serves and moves as the queue does,
so a reader can tell a collection that is working from one that has stopped. The reason filter is over closed advisories, and the value it
offers for the advisories carrying no reason is what a backfill works from.
The view says a collection is running only while it holds one, so a collection
put down leaves nothing on the page claiming to be loading, and it says so from
the moment one is asked for, including while that collection's own walk waits
behind work the queue already holds.

The statistics are their own view. They cover the whole corpus, open and done,
because they describe active work as much as finished work, and they are not a
property of the done list.

Counts and ratios: advisories by closure reason, by state, by severity, and by
month.

Timing, reconstructed from page-observable events:

- Time to first response, measured to the first comment by an org member that
  the extension did not write. Neither the state comment nor the preserved
  original report is a maintainer answering a reporter, so neither counts.
  First contact made by email is not visible and is not counted.
- Time to accept, measured to the advisory entering draft.
- Time to close.
- Time to publish.

Closing and publishing are two different endings and are measured separately.

A timing says how many advisories it could not measure and why, as a row of its
own beside the counts: an advisory with no response, one never accepted, one
never closed, one never published. The reason is a label and a number, not a
sentence.

A metric is omitted when the event it needs is not observable. It is not
estimated.

The page exports to CSV.

Every computation runs locally. Nothing is sent anywhere.

## 11. Failure behavior

The extension locates the elements it needs with targeted queries and does not
validate the whole page structure.

When it cannot read something, it displays what it can, marks the result
incomplete, and shows a banner.

When it cannot fully verify what it is looking at, it refuses to write and
shows a banner. A wrong read shows a stale value that the observation time
already qualifies. A wrong write puts a permanent claim on a real vulnerability
report in front of the reporter, and no other maintainer can edit it out.

## 12. Platform and distribution

Chrome and Firefox from one codebase. The extension works from the logged-in
`github.com` session. It does not ask for a token and does not
store a credential. It contacts only `github.com`. It does not collect
telemetry.

The extension acts only on repositories a maintainer has listed. On any other
repository it does nothing at all: no panel, no table, no reads, and nothing
stored. The allowlist gates the extension, not just its writes.

The list is empty on a fresh install and is edited in the extension's settings,
so the extension touches no repository nobody chose. A page open while the list
changes starts or stops without being reloaded, verified in Firefox on
2026-08-31. Every advisory list and
advisory detail page carries one control that opens those settings, whether or
not the repository is listed. On a repository that is not listed that control
is the only thing the extension does: it reads no advisory, fetches nothing,
and stores nothing.

The extension has no background script. Every surface is a content script, and
nothing runs outside a page.

This depends on undocumented endpoints and on GitHub's DOM, and GitHub's
changes will break it.

v1 loads in development mode. Distribution to other containerd maintainers is
in scope at the level of a loadable build and install instructions they can
follow. Store listings and signing are later work, and the constraints they
impose are considerations throughout.

The Firefox add-on id is `better-ghsa@sbk.wtf` and Firefox 140 is the floor. A
Manifest V3 extension carries its own add-on id
because signing requires one and addons.mozilla.org assigns none, and the id is
fixed from the first signing because the update path is keyed by it.

The manifest declares that the extension collects and transmits no data.
addons.mozilla.org requires that declaration of every extension, and Firefox
reads it from 140 and Firefox for Android from 142, which is what sets the
floor. The declaration is what a maintainer is shown at install, so it has to
stay true: an extension that sent data anywhere would name the categories it
sent.

The extension never requires another maintainer to have it installed. A
maintainer acting through GitHub's native UI must not corrupt or confuse the
extension's state, and their actions remain visible through derived state.

## 13. Out of scope for v1

- Private fork surfaces, including CSS styling. The purpose of that styling is
  an open question.
- Review status of the pull requests in a private fork. The advisory page
  carries none, so reading it costs one fetch per pull request. A set of
  prepared patches that nobody has approved is still pending maintainer work,
  which makes this worth revisiting. Reconsidered on 2026-08-27, when the patch
  chips took color, and left out again: a patch nobody has reviewed reads the
  same as one three maintainers approved, and that is the cost of not spending
  a fetch per pull request.
- Check status of those pull requests. A private fork does not run CI and still
  displays an expected check state, so the value shown does not describe
  anything that ran.
- Field-level merge on a write conflict.
- A cross-repository or org-wide view.
- A configurable track vocabulary.
- Per-maintainer snooze.
- Any write to GitHub outside the extension's two comment types.
