# The advisory detail panel

On an advisory page,
`https://github.com/{owner}/{repo}/security/advisories/GHSA-xxxx-xxxx-xxxx`, the
extension adds a panel to the main column, above the box holding the report. It
is headed "Better GHSA".

The panel reads the page in front of it. Drawing it sends no requests. Saving
does.

## What it shows

### The header chips

A chip for what the advisory is waiting on, the same one its row carries on
[the advisory list](advisory-list.md), so the reason it sits where it does in
the queue is the first thing its page says. Where a triage value is stored the
chip is that value, and where none is it is the derived reading, "Never
reviewed", "New activity", or "Blocked on us". Both appear, the derived one
first, when the derived reading says something the value does not. The stored
value also has its own row below, under "Triage", with how long it has been
held. Published and closed advisories carry no waiting chip.

On a draft advisory, a chip for the patch: "Patch in review" when the private
fork holds an open pull request, "No patch yet" when it does not, "Unknown" when
a pull request's state could not be read.

An "Unknown" chip appears in place of the waiting chip when the advisory's state
could not be read.

The panel does not repeat what the advisory page already shows, which is why the
severity and the CVE are not on it.

### Confirmations

Three lines, "Title", "Description", and "Severity", each reading "Confirmed",
"Not confirmed", or "Unknown". "Unknown" means the value on the page could not
be read, so nothing can be judged against it.

A confirmation binds to what was confirmed. When the title, the description, or
the score changes after someone confirmed it, the line goes back to "Not
confirmed" and reads exactly like one nobody has confirmed, because the next
thing to do is the same either way.

A confirmed line names who confirmed it and when.

The "Description" line carries a second chip saying whether the description is
still the reporter's original text: "Not updated", "Updated", or "Unknown".

This block is hidden on published and closed advisories.

### Stored values

One row for each value that has been set:

- "Triage", the triage value and how long it has been held.
- "Owners", one chip per maintainer.
- "Backport targets", one chip per release branch.
- "Embargo", reading "No lift date", "Lifts 2026-04-01", or "Overdue since
  2026-04-01".
- "Closed as", the closure reason, and the advisory it duplicates when the
  reason is a duplicate.

### Original report

A row that preserves the reporter's words. See below. It is hidden on published
and closed advisories.

## Editing

"Edit tracking state" opens the editor. It stays open as you move around the
advisory.

- **Triage**: a dropdown of "Not set", "evaluating", "awaiting reporter",
  "awaiting maintainer input". Acceptance and rejection are not in this list;
  they are GitHub's own advisory states.
- **Owners**: a chip per current owner with a "Remove" control, plus a text box
  and an "Add" button. The box suggests org members this extension has seen, and
  falls back to the advisory's collaborators. Any login is accepted. Any
  maintainer can set any maintainer.
- **Backport targets**: the same shape, suggesting release branches seen on this
  repository, newest version first. GitHub's affected-version data can suggest
  branches, and containerd's supported branches are not contiguous, so the
  suggestion is not authoritative.
- **Embargo**: an "In force" checkbox and a lift date. The date is disabled while
  the checkbox is clear. Clearing the checkbox leaves the date in the box, so
  ticking it again before you save restores it; saving with the embargo off
  stores no lift date and redraws the box empty.
- **Closed as**: a dropdown of "Not closed" and the seven closure reasons, read
  as the completed view reads them, and a box for the duplicated GHSA identifier
  that is enabled only for "Duplicate".
- **Confirmed**: checkboxes for "Title", "Description", and "Severity". Ticking
  one records you and a fingerprint of the value on the page right now. A value
  the extension could not read is disabled and marked "Unavailable".

Changes accumulate. Nothing is written until "Save". "Discard changes" throws
them away. While unsaved changes exist the panel names them, as
"Unsaved changes: Triage, Owners."

Putting a control back where it started removes it from the unsaved list, and so
does another maintainer saving the same value.

### Leaving with unsaved changes

Leaving the page asks first. A link GitHub handles in place asks
"Better GHSA: Leave without saving your changes?"; cancelling stays put. A full
page load gets the browser's own leave-site dialog. Going back to an advisory
you cancelled on brings the staged changes back.

### Saving

"Save" re-reads the advisory, merges your changes onto whatever the advisory now
carries, and posts or edits your state comment. You get one state comment per
advisory: the first save creates it, later saves edit it. No maintainer's save
ever touches another maintainer's comment.

While a save is in flight every control is disabled and the panel reads
"Saving...". Then it reads "Saved." or an error. The ones worth recognizing:

- "Error: concurrent edits". Someone else wrote to this advisory between the
  read and the write. Nothing was written and nothing you typed is lost. The
  panel redraws with their values so you can reapply yours.
- "Error: update the extension". The advisory carries state written by a newer
  version of this extension than the one you are running.
- "Error: unparsed tracking state". See untrusted and unreadable state below.
- "Error: {owner}/{repo} is not on this extension's allowlist." Writes to this
  repository are refused.
- "Error: failed to save", "Error: failed to validate save", and the rest of the
  failure messages. Nothing the extension could confirm was written.

## Untrusted and unreadable state

A snapshot counts toward the advisory's state only when GitHub badges its author
as an Owner or a Member of the organization. Security advisors are org members,
so their snapshots count.

Snapshots the extension refused are marked on the comment that carries them, in
the thread, next to the badge GitHub already put there:

- "Ignored: non-member state": the author is not an org member, so nothing in
  that snapshot counts.
- "Unable to parse tracking state": the author is trusted and the snapshot could
  not be read. Hovering names what was wrong with it.
- "Tracking state from a newer extension": the snapshot names a schema this
  build does not understand.

An unreadable snapshot from a trusted author still carries a claim about
ordering, so changing state on that advisory takes one explicit confirmation: an
"Override" row appears with a "Supersede unparsed state" checkbox, and a save
without it fails with "Error: unparsed tracking state". Ticking it lets one save
through, and the value you write then supersedes the unreadable one.

A snapshot from a schema this build does not understand puts the panel into read
only: the editor is replaced by "Update the extension to edit". The values that
could be read still display.

The role labels on the comments themselves are GitHub's own. The extension adds
only the warning chips above.

## Preserving the original report

Maintainers rewrite an advisory's title and description for publication, in
place, over the reporter's words. Nothing on GitHub recovers what was there for
the title, and the description's revision history is the only trace.

The "Original report" row offers a "Preserve" button, with the note "Preserve
the title and description in a comment." Pressing it posts one comment holding
the advisory's current title and description, verbatim, inside a collapsed
block whose summary reads "Original report preserved by Better GHSA".

This works only before the rewrite. Pressing it afterward preserves the rewrite.
Nothing recovers the original once it is gone.

The button is offered at most once per advisory. Once a preservation comment
exists, the row reads "Preserved" and links to it. A press whose result the
extension could not confirm leaves the row reading "Reload page" and offers no
second press, because a duplicate permanent comment would be visible to the
reporter.

The row is not shown on published or closed advisories. Those are dealt with,
and capturing the reporter's wording then serves nothing.

The extension refuses to write when it cannot tell whether the description on
the page is the reporter's original text.

## Who sees all this

Both comments the extension writes are ordinary advisory comments, posted under
your GitHub account. Everyone who can read the advisory's conversation reads
them, the reporter included, on a published advisory as much as on one in
triage. Posting a comment notifies the advisory's participants.

Nothing in the vocabulary is encoded or obfuscated. Every value it can store is
one a maintainer should be willing to say to the reporter.

## On a repository the settings do not list

There is no panel. Nothing about the advisory is read or stored, and the page is
GitHub's own. Adding the repository in the settings puts the panel on the page,
and removing it takes the panel off.

## What the panel never touches

The extension writes its two comment types and nothing else. It does not change
an advisory's title, description, severity, CVSS vector, CWEs, CVE, state, or
collaborators, and it has no control that would.
