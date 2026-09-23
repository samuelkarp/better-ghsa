# Privacy policy for Better GHSA

Last updated: 2026-09-21.

Better GHSA adds triage tracking to GitHub Security Advisories. This policy
covers the extension's storage, requests, and writes to GitHub. GitHub's privacy
statement governs GitHub's handling of your data.

The extension runs in your browser. It does not use a backend or send data to
its author.

## Summary

- Everything the extension stores is kept on your device in browser extension
  storage.
- Requests go to `github.com`. GitHub redirects owner images to
  `avatars.githubusercontent.com`, where the browser loads them.
- The extension writes advisory comments under your GitHub account. Everyone
  with access to the conversation can read them, including the reporter.
- There is no telemetry, no analytics, no advertising, no tracking, and no
  transfer of data to any third party.

## What is stored on your device

The extension uses `browser.storage.local` (`chrome.storage.local` in Chrome)
in your browser profile. It does not encrypt or synchronize that storage.
Web pages cannot read it.

It does not store local data elsewhere or use its own cookies, `localStorage`,
or IndexedDB.
Local storage contains six kinds of entry.

**Repository settings**, under `allowlist`. This contains the lowercase
`owner/repo` names you enter in settings. The list starts empty. Advisory data
is collected only after you add a repository.

**Advisory reads**, under keys beginning `adv:`. Each entry contains parsed
advisory data and its observation time:

- The repository, the GHSA identifier, the advisory's state, its severity and
  CVSS vector, and its CVE identifier and CVE request state.
- The advisory's title and description, as source text.
- The login of the person who reported the advisory and the time they reported
  it.
- Every comment in the advisory's conversation: its identifier, its author's
  login, the role badges GitHub showed on it, its timestamp, and its text.
- Every event in the advisory's timeline: the actor, the time, and the text.
- The advisory's private fork, if one exists: its repository name, its clone
  URL, and each pull request in it with number, title, state, branches, author,
  and assignees.
- The logins of the advisory's collaborators.
- The login of the GitHub account the page was rendered for, which is yours.

Triage and draft advisories are private. Stored data can include details of
unfixed vulnerabilities.

**Advisory list reads**, under keys beginning `list:`. Each repository entry
contains row identifiers, titles, states, severities, opening dates, and
reporter logins, plus GitHub's state-tab counts and pagination progress.

**Refresh progress**, under keys beginning `queue:`. Each repository entry
records queued, in-flight, completed, and failed advisory reads, plus the last
request time. Refreshes resume from this progress after navigation.

**Observed organization members**, under `members`. Logins with an Owner or
Member badge are grouped by organization. The extension uses them for owner
suggestions and tracking-state trust decisions.

**Observed release branches**, under `branches`. The extension records branch
names beginning `release/` by repository for backport suggestions.

### Which repositories this covers

The extension reads advisory data on the advisory pages of repositories listed
in its settings. It also makes layout adjustments on their GHSA private forks.
On unlisted repositories, it shows only the settings button on advisory pages.
It does not read or store advisory data or fetch advisory pages.

Every advisory page includes a `Better GHSA settings` button, including pages
for unlisted repositories. The button opens the extension's settings without
reading advisory data, storing data, or sending a request.

### Retention

Entries persist until they are removed. Advisory and list reads are refreshed in
place as pages are re-read. A successful advisory read resets its missing-page
count. After three HTTP 404 responses without a successful read between them,
the extension removes the cached advisory entry. The `members` and `branches`
entries accumulate, and nothing ages them out.

`Clear cache` in settings immediately removes advisory reads, list reads,
refresh progress, observed members, and observed branches. It preserves your
repository list. Later advisory reads rebuild the cleared data.

Removing a repository clears its advisory reads, list read, refresh progress,
and observed branches. Organization members remain while another listed
repository belongs to that organization.

## What is transmitted, and to whom

The extension requests data from `https://github.com`. The browser follows
GitHub's redirects for owner images to its avatar host. Requests do not go to
the extension's author or other services.

The requests are:

- `GET` on a repository's advisory list pages,
  `https://github.com/{owner}/{repo}/security/advisories`.
- `GET` on an advisory page,
  `https://github.com/{owner}/{repo}/security/advisories/{GHSA-id}`.
- `GET` on an owner's profile image, `https://github.com/{login}.png?size=40`,
  for the advisory list's owner icons.
- `POST` to an advisory's comment endpoint to create or edit a comment when
  you press a save or preservation button.

All of these are same-origin requests carrying the `github.com` session your
browser already has. The extension does not ask for a personal access token,
does not create one, does not read one, and does not store a credential of any
kind.

When saving a comment, the extension reads GitHub's comment-form fields,
including the CSRF token, and submits them back to GitHub. These fields are
not retained in extension storage.

Some of these requests are sent without a direct click. While a `github.com`
advisory page is open, the extension refreshes advisories in the background.
Background advisory reads are throttled to one request per second within each
queue. Requests from separate tabs can occur closer together. To GitHub, that traffic is
indistinguishable from your own browsing, and GitHub records it as it records
any other request from your session.

GitHub redirects profile image requests to `https://avatars.githubusercontent.com`.
The browser follows the redirect. The extension specifies the original
`github.com` image address.

The advisory list requests an icon for each displayed owner. The original
image request includes the owner's login and your `github.com` session.
GitHub can observe these requests along with advisory page requests.

The extension does not load remote code, remote fonts, or an analytics or
crash-reporting service. The owner icons are the only images it loads.

## What is written into GitHub, and who can see it

Saving writes a comment to the advisory conversation under your GitHub
account. The extension writes two types of comment.

**The tracking state comment**, at most one per advisory per maintainer. The
summary is "Better GHSA tracking state". Its JSON snapshot contains:

- Triage state and assigned owner logins.
- Backport targets, embargo status, and its lift date.
- Closure reason and any duplicate reference.
- Confirmations with the confirmer's login, timestamp, and value fingerprint.
- A sequence number and schema version.

A fingerprint uses the first twelve hexadecimal characters of SHA-256 to
detect changes to a confirmed value. It stores a digest of the value and does
not provide a security guarantee.

**The preserved original report comment**, at most one per advisory. It contains
the advisory's current title and description.

Both are ordinary advisory comments, visible to everyone with access to the
conversation, including the reporter. GitHub notifies advisory participants
when a comment is posted. Publishing makes the advisory data public while the
conversation remains restricted to collaborators.

The extension does not change any other part of an advisory. It does not modify
the title, description, severity, CVSS vector, CWEs, CVE, state, or
collaborators.

The extension cannot delete its comments. To remove one, use GitHub's interface.

## What is never collected

- No browsing history, and no data at all from pages outside
  `github.com/{owner}/{repo}/security/advisories` on a repository you listed.
  Private-fork layout adjustments do not collect page contents.
- No analytics, usage metrics, session recording, crash reports, or device,
  advertising, or user identifiers.
- No location data.
- No contact information. The extension records GitHub logins that appear on the
  advisory pages you open; it does not collect names, email addresses, or
  profile data beyond those logins.

The extension does not sell or share data. Its only transmissions are the
GitHub requests described above.

## Permissions the extension requests

- **`storage`**: for the local storage described above.
- **Access to `https://github.com/*`**: the extension's script is loaded on every
  `github.com` page to detect navigation when GitHub replaces content without a
  page load. Advisory features run on listed repositories' advisory pages, and
  layout adjustments apply on their GHSA private forks. The settings button is
  available on advisory pages for both listed and unlisted repositories.

The extension requests only storage and `github.com` access. Its code runs in
open GitHub tabs and the settings page, without a background script. It does
not have access to tabs, history, bookmarks, downloads, cookies, or other hosts.

The manifest lists the settings page as a web-accessible resource for
`https://github.com/*`. This allows the settings button on GitHub to open it.
The extension keeps the settings URL in its click handler, outside the page
DOM, to keep it private from page scripts.

The extension's content security policy prohibits other pages from framing
its settings page.

## Clearing everything

`Clear cache` removes observed data and preserves the repository list. See
[Retention](#retention) for details.

Uninstalling removes all local extension data, including the repository list.
In Firefox, remove Better GHSA from `about:addons`. In Chrome, remove it from
`chrome://extensions`.

Clearing site data for `github.com` does not clear extension storage. Use the
extension's settings or uninstall it.

Comments written to GitHub remain after local data is cleared or the extension
is removed. Delete those through GitHub.

## Changes to this policy

Policy revisions are published in this file with an updated date.

## Contact

Questions about this policy can be raised in the
[Better GHSA repository](https://github.com/samuelkarp/better-ghsa).
