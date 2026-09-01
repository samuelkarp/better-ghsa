# Better GHSA

![Better GHSA](docs/promo-small-440x280.png)

A Firefox and Chrome extension that adds triage tracking to GitHub Security
Advisories for the maintainers who work them.

## What it is for

A repository's security advisories arrive as private reports and stay private
while maintainers decide what to do with them. GitHub gives each advisory a
state (triage, draft, published, closed), a severity, and a comment thread. It
does not give a place to record who owns the report, whether anyone has checked
the title and the score the reporter proposed, which release branches need a
backport, whether an embargo applies and when it lifts, or why an advisory was
closed. Maintainers keep that in their heads, in chat, or nowhere.

This extension keeps it on the advisory.

## Where the state lives

Each maintainer's triage state is written into a comment on the advisory
itself: one comment per maintainer per advisory, created on that maintainer's
first save and edited on every save after that. The comment is a collapsed
`<details>` block holding a JSON snapshot. The extension reads every
maintainer's state comment on an advisory and merges them into one current
state.

There is no server and no database. Nothing is synchronized between browsers.
An advisory carries its own state. One maintainer can use the extension while
the others work through GitHub's own interface, and a maintainer who uninstalls
it loses nothing that was saved.

The reporter of an advisory can read the whole thread, state comments included.
The vocabulary the extension uses is written to be read that way: nothing is
encoded or obfuscated. Saving posts or edits a comment. Posting notifies the
advisory's participants, the reporter among them.

The extension keeps a local cache so pages draw immediately. The cache is never
authoritative and is always rebuildable by re-reading the advisories.

## The three surfaces

**The advisory detail panel** sits on an advisory page. It shows what the
extension derived from the page (patch progress in the private fork, CVE state,
how long the advisory has been waiting, whether anyone has reviewed it), shows
and edits the stored triage state, and offers a button that preserves the
reporter's original title and description in a comment before maintainers
rewrite them for publication. See [docs/detail-panel.md](docs/detail-panel.md).

**The advisory list** replaces the body of a repository's advisory list with a
table of open advisories, ordered so that the ones needing attention are at the
top, with chips for waiting state, patch progress, confirmations, CVE,
severity, and embargo, and with filters and sorts over them. A toggle restores
GitHub's own view. See [docs/advisory-list.md](docs/advisory-list.md).

**The completed view** lists published and closed advisories and records a
closure reason on each, including retroactively on advisories closed before the
extension existed. A statistics view sits beside it with counts and response
timings over the whole corpus and a CSV export. See
[docs/completed.md](docs/completed.md).

## Installing it

There is no build step and no store listing. The extension is the repository
contents, loaded from disk.

Firefox 140 or later:

1. Clone the repository.
2. Open `about:debugging#/runtime/this-firefox`.
3. Press "Load Temporary Add-on" and choose the `manifest.json` at the top of
   the clone.

A temporary add-on is removed when Firefox closes. These steps are repeated
each session.

Firefox 140 is the floor. The manifest declares that the extension collects no
data, in the key Firefox reads from 140 and Firefox for Android reads from 142.
Earlier versions neither read that declaration nor show it at install.

Chrome:

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Press "Load unpacked" and choose the top of the clone.

Chrome logs a warning about the Firefox-specific settings in the manifest and
loads the extension.

## Choosing the repositories it acts on

The extension acts only on repositories listed in its settings.

Every advisory list and every advisory page carries one control, a
`Better GHSA settings` button, which opens the settings in a new tab. On a
repository that is not listed that button is the whole of what the extension
does there.

The settings page is also reached from the browser's own add-on manager. In
Firefox, open `about:addons`, select Extensions, press the `...` button on the
Better GHSA entry, and choose Preferences (Options on Windows); the page opens
in a new tab. In Chrome, open `chrome://extensions`, press Details on the Better
GHSA card, and choose "Extension options".

An entry is `owner/repo`, for example `containerd/containerd`. Case does not
matter. Removing a repository stops the extension on it; a page already showing
that repository stops as soon as the entry goes.

## What it can reach

- It acts only on the repositories in its settings. On every other repository it
  does nothing at all: no panel, no table, nothing read, and nothing stored.
- The only things it ever writes to GitHub are its own two comment types: the
  state comment and the preserved original report. It never changes an
  advisory's title, description, severity, CVSS vector, CWEs, CVE, state, or
  collaborators.
- It works from the `github.com` session already logged in to the browser. It
  never asks for a token and never stores a credential.
- It contacts `github.com`. The owner icons in its advisory list are
  `github.com` image addresses that GitHub redirects to
  `avatars.githubusercontent.com`. The browser loads those images from there.
- It does not collect telemetry or send analytics.

[PRIVACY.md](PRIVACY.md) sets out what is stored and where. The settings page
carries a `Clear cache` button that empties it, and removing a repository from
the list empties what was stored for that repository.

## Limitations

The GitHub REST API exposes neither advisory comments nor the advisory timeline,
which is where all of this state and most of the derived state lives. So the
extension reads GitHub's HTML and posts through the same forms the page posts
through. It depends on undocumented endpoints and on the structure of GitHub's
pages, and GitHub's changes will break it. When that happens the visible
symptoms are missing values, an incomplete banner, or a refused write.

Everything it displays is a poll. Other maintainers write through their own
browsers and GitHub changes derived state without telling the extension. Every
row and panel carries the time its data was read.

Version 1 is built for one repository and one workflow: a containerd maintainer
working `containerd/containerd`. Cross-repository views, org-wide views, and a
configurable vocabulary are not in it.

## How this was written

This repository was written almost entirely by coding assistants, under the
direction of its author. That is worth knowing before installing it.

The test suite passes and the code type-checks. Neither fact establishes that
the design is coherent or that the implementation is trustworthy, and neither
substitutes for reading the code. This extension writes to real security
advisories, in front of the people who reported them.

## Documents

- [PRIVACY.md](PRIVACY.md), the privacy policy.
- [docs/](docs/), one page per surface, plus
  [docs/testing.md](docs/testing.md) on running the tests.
- [REQUIREMENTS.md](REQUIREMENTS.md), what the extension is required to do.

## License

Apache License 2.0. See [LICENSE](LICENSE).
