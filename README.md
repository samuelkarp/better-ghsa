# Better GHSA

![Better GHSA](docs/promo-small-440x280.png)

A Firefox and Chrome extension that adds triage tracking to GitHub Security
Advisories for the maintainers who work them.

[![Get Better GHSA for Firefox](docs/store-badge-firefox-172x60.png)](https://addons.mozilla.org/firefox/addon/better-ghsa/) [![Get Better GHSA from the Chrome Web Store](docs/store-badge-chrome-206x58.png)](https://chromewebstore.google.com/detail/better-ghsa/khihhmkhgehggnbjdendcdhkjplcoljm)

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

Each maintainer saves triage state in one comment per advisory. The first save
creates the comment; later saves edit it. The comment contains a JSON snapshot
inside a collapsed `<details>` block. The extension merges the maintainers'
snapshots into the advisory's current state.

The advisory comments hold the shared state. The extension does not use a
separate server or database, or synchronize browser storage. You can use it
while other maintainers use GitHub's own interface. Saved comments remain on
GitHub after you uninstall the extension.

The reporter can read the state comments. Their values use plain language.
Saving posts or edits a comment. Posting notifies the advisory's participants,
including the reporter.

A local cache lets pages display data immediately. It is not authoritative
and can be rebuilt by rereading the advisories.

## The three surfaces

**The advisory detail panel** shows patch progress in the private fork,
waiting time, and review status. It lets you edit stored triage state
and preserve the reporter's title and description in a comment before you
rewrite them for publication.
See [docs/detail-panel.md](docs/detail-panel.md).

**The advisory list** replaces GitHub's list body with a table of open
advisories, with those needing attention first. Chips show waiting state, patch
progress, confirmations, CVE, severity, and embargo. Filters and sorts help you
choose what to work on.
A toggle restores GitHub's own view. See [docs/advisory-list.md](docs/advisory-list.md).

**The completed view** lists published and closed advisories. You can record
closure reasons, including on older advisories. The statistics view shows counts
and response timings across open and completed advisories and offers CSV and
JSON exports. See [docs/completed.md](docs/completed.md).

## Private-fork pull request diffs

On a GHSA private fork's Files changed page, the extension removes the outer
width limit and extra padding so the diff fills the page like a public PR.
This applies when the parent repository is listed in settings. The parent is
identified from the fork's `owner/repo-ghsa-xxxx-xxxx-xxxx` name. Removing the
parent from settings restores GitHub's layout.

## Installing it

### From a store

Firefox 140 or later: install it from
[addons.mozilla.org](https://addons.mozilla.org/firefox/addon/better-ghsa/).

Chrome: install it from the
[Chrome Web Store](https://chromewebstore.google.com/detail/better-ghsa/khihhmkhgehggnbjdendcdhkjplcoljm).

Firefox 140 and Firefox for Android 142 are the minimum supported versions.
During installation, these versions display the manifest's declaration that
the extension does not collect data. Earlier versions do not read or display
that declaration.

### From a clone, for working on the extension

Load the repository directly from disk; a build step is not required.

Firefox 140 or later:

1. Clone the repository.
2. Open `about:debugging#/runtime/this-firefox`.
3. Press "Load Temporary Add-on" and choose the `manifest.json` at the top of
   the clone.

Firefox removes temporary add-ons when it closes. Repeat these steps each session.

Chrome:

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Press "Load unpacked" and choose the top of the clone.

Chrome logs a warning about the Firefox-specific settings in the manifest and
loads the extension.

## Choosing the repositories it acts on

The extension acts only on repositories listed in its settings.

Every advisory list and detail page shows a `Better GHSA settings` button that
opens the settings in a new tab. On unlisted repositories, the extension shows
only this button.

You can also open the settings from the browser's add-on manager. In
Firefox, open `about:addons`, select Extensions, press the `...` button on the
Better GHSA entry, and choose Preferences (Options on Windows); the page opens
in a new tab. In Chrome, open `chrome://extensions`, press Details on the Better
GHSA card, and choose "Extension options".

An entry is `owner/repo`, for example `containerd/containerd`. Case does not
matter. Removing a repository stops the extension on its pages, including pages
already open.

## What it can reach

- On unlisted repositories, it shows only the settings button on advisory
  pages. It does not read or store advisory data or fetch advisory pages.
- It writes two comment types to GitHub: tracking state and preserved reports.
  It does not change an advisory's title, description, severity, CVSS vector,
  CWEs, CVE, state, or collaborators.
- It uses your existing `github.com` browser session. It does not ask for a token
  or store credentials.
- It contacts `github.com`. GitHub redirects owner images in the advisory list
  to `avatars.githubusercontent.com`, where the browser loads them.
- It does not collect telemetry or send analytics.

[PRIVACY.md](PRIVACY.md) describes stored data and its location. Use `Clear cache`
in settings to remove cached data. Removing a repository from settings also
removes its cached data.

## Limitations

The GitHub REST API does not expose advisory comments or timelines. The
extension reads GitHub's HTML and submits its comment forms. It depends on
undocumented endpoints and page structure, and GitHub's changes will break it.
Symptoms include missing values, an incomplete banner, or a refused write.

Other maintainers' changes appear when the extension next reads the advisory.
Every row and panel shows when its data was read.

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
