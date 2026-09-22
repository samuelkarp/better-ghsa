# The advisory detail panel

On an advisory page,
`https://github.com/{owner}/{repo}/security/advisories/GHSA-xxxx-xxxx-xxxx`, the
extension adds a "Better GHSA" panel to the main column above the report.

The panel reads the open page. Rendering does not send requests; saving does.

## What it shows

### The header chips

The waiting chips match those on [the advisory list](advisory-list.md).
A stored triage value appears as a chip. Without a stored value, the chip shows
"Never reviewed", "New activity", or "Blocked on us", derived from the page.
When the derived state adds information, both chips appear with the derived
state first. The "Triage" row also shows the stored value and how long it has
been set. Waiting chips are hidden on published and closed advisories.

Draft advisories show a patch chip: "Patch in review" when the private fork
lists an open pull request, "No patch yet" when it does not, or "Unknown" when
a pull request's state could not be read.

An "Unknown" chip appears in place of the waiting chip when the advisory's state
could not be read.

Severity and CVE appear on GitHub's page outside the panel.

### Confirmations

The "Title", "Description", and "Severity" lines each show "Confirmed",
"Not confirmed", or "Unknown". "Unknown" means the extension could not read the
value on the page.

A confirmation applies to a specific value. Changing the title, description,
or score returns its line to "Not confirmed". A confirmed line names the
maintainer and confirmation time.

The "Description" line also shows whether the description is the reporter's
original text: "Not updated", "Updated", or "Unknown".

This block is hidden on published and closed advisories.

### Stored values

One row for each value that has been set:

- "Triage", the triage value and how long it has been set.
- "Owners", one chip per maintainer.
- "Backport targets", one chip per release branch.
- "Embargo", reading "No lift date", "Lifts 2026-04-01", or "Overdue since
  2026-04-01".
- "Closed as", the closure reason and, for a duplicate, its reference. An exact
  GHSA identifier links to that advisory in the current repository. An exact
  github.com issue or pull request URL becomes a link labeled "#412" within the
  current repository or "owner/repo#412" for another repository. Other values
  display as entered.

### Original report

The "Original report" row offers report preservation, described below. It is
hidden on published and closed advisories.

## Editing

"Edit tracking state" opens the editor. It stays open as you move around the
advisory.

- **Triage**: a dropdown of "Not set", "evaluating", "awaiting reporter",
  "awaiting maintainer input". Acceptance and rejection are not in this list;
  they are GitHub's own advisory states.
- **Owners**: a chip per owner with a "Remove" control, plus a text box and an
  "Add" button. Suggestions use observed organization members, falling back to
  the advisory's collaborators. Any maintainer can assign any login.
- **Backport targets**: the same shape, suggesting release branches seen on this
  repository, newest version first. GitHub's affected-version data can suggest
  branches, and containerd's supported branches are not contiguous, so the
  suggestion is not authoritative.
- **Embargo**: an "In force" checkbox and a lift date. Clearing the checkbox
  disables the date field and retains its value until you save. Checking it
  again before saving restores the date. Saving with the embargo off clears
  the stored date and empties the field.
- **Closed as**: a dropdown with "Not closed" and the seven closure reasons
  shown in the completed view. A box for the duplicated GHSA identifier is
  enabled only for "Duplicate".
- **Confirmed**: checkboxes for "Title", "Description", and "Severity".
  Checking a box records you and a fingerprint of the current value. If the
  extension cannot read a value, its checkbox is disabled and marked
  "Unavailable".

"Save" writes your changes. "Discard changes" clears them. The panel lists
pending changes, for example "Unsaved changes: Triage, Owners."

A value leaves the unsaved list when you restore its original value or another
maintainer saves the same value.

### Leaving with unsaved changes

Leaving with unsaved changes requires confirmation. Links handled by GitHub
within the current page ask "Better GHSA: Leave without saving your changes?"
Cancelling keeps you on the page. A full page load uses the browser's leave-site
dialog. Returning to an advisory after cancelling restores its pending changes.

### Saving

"Save" rereads the advisory, merges your changes with its current state, and
posts or edits your state comment. The first save creates your comment; later
saves edit it. Each maintainer's save changes only their own comment.

During a save, every control is disabled and the panel shows "Saving...".
It then shows "Saved." or an error:

- "Error: concurrent edits". Someone else wrote to this advisory between the
  read and the write. Nothing was written and nothing you typed is lost. The
  panel redraws with their values so you can reapply yours.
- "Error: update the extension". The advisory contains state from a newer
  version of the extension.
- "Error: unparsed tracking state". See untrusted and unreadable state below.
- "Error: {owner}/{repo} is not on this extension's allowlist." Writes to this
  repository are refused.
- "Error: failed to save", "Error: failed to validate save", and other failure
  messages. The extension could not confirm that the comment was saved.

Save failures caused by a missing new-comment form, a missing edit form, or
missing required edit-form fields include a collapsed "Diagnostic details"
section. "Copy diagnostic" copies the extension version, operation, diagnostic
code, missing form or field names, and whether a comment POST was sent. For a
missing edit form, it also reports whether the target comment was found. The
report excludes form values and advisory content. If copying fails, the details
remain visible for manual copying. The extension keeps these details in the page.

A successful HTTP response whose saved comment cannot be confirmed also includes
"Diagnostic details". The report gives the HTTP status, whether matching
response containers were found, and whether one contained all the expected
content. These containers can include the advisory description and preview.
Checks that could not run read "unknown". The report states that the POST was
sent and the comment may have been saved.

An unexpected comment-form destination includes the same "Diagnostic details"
control. Its report names the first failed check: URL syntax, GitHub origin,
embedded credentials, advisory endpoint, or target comment path. It identifies
whether the operation creates or edits a tracking comment and confirms that no
comment POST was sent. The report excludes the form's URL and identifiers.

When the page fetched before a save cannot be identified as the requested
advisory, "Diagnostic details" reports whether the advisory parser recognized
the page, whether it read an identity, and whether that identity matched.
Checks that could not run read "unknown". The report confirms that no comment
POST was sent and excludes URLs and advisory identifiers.

## Untrusted and unreadable state

Only snapshots from authors with GitHub's Owner or Member organization badge
count toward the advisory's state. Security advisors count as organization
members.

Excluded snapshots get a warning chip next to the comment's GitHub role badge:

- "Ignored: non-member state": the author is not an organization member.
- "Unable to parse tracking state": the author is trusted but the snapshot is
  unreadable. Hover over the chip for details.
- "Tracking state from a newer extension": the snapshot uses an unsupported
  schema.

An unreadable snapshot from a trusted author still has an ordering claim.
Saving over it requires explicit confirmation. Check "Supersede unparsed state"
in the "Override" row to allow one save. Otherwise, saving fails with
"Error: unparsed tracking state". The new snapshot supersedes the unreadable one.

An unsupported schema makes the panel read-only. The editor is replaced by
"Update the extension to edit". Readable values remain visible.

GitHub supplies the role labels. The extension adds the warning chips.

## Preserving the original report

Editing an advisory for publication replaces the reporter's title and
description. GitHub retains description revision history but does not provide
title recovery.

The "Original report" row offers a "Preserve" button, with the note "Preserve
the title and description in a comment." Pressing it posts one comment holding
the advisory's current title and description, verbatim, inside a collapsed
block whose summary reads "Original report preserved by Better GHSA".

Preserve the report before rewriting it. Afterward, the button preserves the
edited text. The original cannot be recovered once it is gone.

The button is offered at most once per advisory. When a preservation comment
exists, the row shows "Preserved" and links to it. An unconfirmed attempt shows
"Reload page" and disables another attempt until reload to prevent duplicate
comments.

The row is hidden on published and closed advisories.

The extension refuses to write when it cannot tell whether the description on
the page is the reporter's original text.

## Who sees all this

Both comment types are posted under your GitHub account. Everyone with access
to the advisory conversation can read them, including the reporter, on both
published and triage advisories. Posting a comment notifies the participants.

Stored values use plain language. Save only values you are willing to share
with the reporter.

## On a repository the settings do not list

The panel is hidden, and the extension does not read or store advisory data.
Adding the repository in settings displays the panel. Removing it hides the
panel.

## What the panel never touches

The extension writes tracking-state and preserved-report comments. It does not
change an advisory's title, description, severity, CVSS vector, CWEs, CVE, state,
or collaborators.
