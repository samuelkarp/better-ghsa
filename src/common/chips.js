'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./order.js');
}

/**
 * Chips share Primer state tones across the lists and detail panel.
 *
 * @typedef {object} Chip
 * @property {string} text
 * @property {'attention' | 'danger' | 'done' | 'success' | 'success-muted'} [tone]
 */

/**
 * @typedef {Chip & { severityClass?: string | null, dim?: boolean, fill?: boolean,
 *   subject?: string }} ChipSpec
 *   `severityClass` supplies GitHub's severity label classes. `dim` reduces
 *   opacity. `fill` uses the text color as the background. `subject` identifies
 *   the chip.
 */

(() => {
  /**
   * Capitalize the first letter to match GitHub's chip labels.
   *
   * @param {string} value
   * @returns {string}
   */
  function sentenceCase(value) {
    return value === '' ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
  }

  /**
   * @param {string} state The derived waiting state.
   * @returns {Chip}
   */
  function derivedChip(state) {
    const order = globalThis.bghsa.order;
    const undone = state === order.GROUPS.NEVER_REVIEWED || state === order.GROUPS.BLOCKED_ON_US;
    return { text: sentenceCase(state), tone: undone ? 'danger' : 'attention' };
  }

  /**
   * Stored triage distinguishes evaluating from awaiting maintainer input.
   * Show it with the derived state only when that state adds review or activity
   * information. Every advisory gets at least one waiting chip.
   *
   * @param {import('./order.js').WaitingEntry} entry
   * @returns {Chip[]} The waiting chips, with the derived chip first if present.
   */
  function waitingChips(entry) {
    const order = globalThis.bghsa.order;
    const state = order.waitingStateOf(entry);
    const triage = typeof entry.triage === 'string' ? entry.triage : '';
    const blocked = order.classifyTriage(triage);
    /** @type {Chip[]} */
    const built = [];
    const unsaid = state === order.GROUPS.NEVER_REVIEWED || state === order.GROUPS.NEW_ACTIVITY;
    if (blocked === null || unsaid) built.push(derivedChip(state));
    if (blocked !== null) {
      built.push({ text: sentenceCase(triage), tone: blocked === 'us' ? 'danger' : 'attention' });
    }
    return built;
  }

  /**
   * Only draft advisories show a patch chip. Advisories in triage have not
   * been accepted for patch preparation.
   */
  const DRAFT_STATE = 'Draft';

  const PATCH_IN_REVIEW = 'Patch in review';

  const NO_PATCH = 'No patch yet';

  const PATCH_UNKNOWN = 'Unknown';

  /**
   * The private fork lists only open pull requests (REQUIREMENTS.md section 6).
   * An empty fork and an absent fork both mean no visible patch. An unreadable
   * pull request state is unknown unless another pull request is open.
   *
   * @param {import('./derive.js').PatchState} patch
   * @returns {string}
   */
  function patchStateOf(patch) {
    const states = patch.pullRequests.map((pull) => pull.state);
    if (states.includes('open')) return PATCH_IN_REVIEW;
    if (patch.incomplete) return PATCH_UNKNOWN;
    return NO_PATCH;
  }

  /**
   * @param {string} state The state returned by {@link patchStateOf}.
   * @returns {Chip}
   */
  function patchChip(state) {
    /** @type {Chip} */
    const chip = { text: state };
    if (state === PATCH_IN_REVIEW) chip.tone = 'attention';
    else if (state === NO_PATCH) chip.tone = 'danger';
    return chip;
  }

  /**
   * Muted backgrounds use the default text color. Emphasis backgrounds use
   * `--fgColor-onEmphasis`. Fallbacks preserve the translucent or opaque fill.
   *
   * @type {readonly string[]}
   */
  const TONE_RULES = [
    '.bghsa-tone-attention { color: var(--fgColor-default, currentColor);' +
      ' background-color: var(--bgColor-attention-muted, rgba(212, 167, 44, 0.2));' +
      ' border-color: var(--borderColor-attention-emphasis, #bf8700); }',
    '.bghsa-tone-danger { color: var(--fgColor-default, currentColor);' +
      ' background-color: var(--bgColor-danger-muted, rgba(207, 34, 46, 0.2));' +
      ' border-color: var(--borderColor-danger-emphasis, #cf222e); }',
    '.bghsa-tone-success-muted { color: var(--fgColor-default, currentColor);' +
      ' background-color: var(--bgColor-success-muted, rgba(74, 194, 107, 0.2));' +
      ' border-color: var(--borderColor-success-emphasis, #1a7f37); }',
    '.bghsa-tone-done { color: var(--fgColor-onEmphasis, #ffffff);' +
      ' background-color: var(--bgColor-done-emphasis, #8250df);' +
      ' border-color: var(--bgColor-done-emphasis, #8250df); }',
    '.bghsa-tone-success { color: var(--fgColor-onEmphasis, #ffffff);' +
      ' background-color: var(--bgColor-success-emphasis, #1f883d);' +
      ' border-color: var(--bgColor-success-emphasis, #1f883d); }',
  ];

  /**
   * Identify chips independently of their labels and colors.
   * `parseDetail.EXTENSION_CHIP_ATTRIBUTE` separately excludes extension chips
   * from GitHub role badge parsing.
   */
  const SUBJECT_ATTRIBUTE = 'data-bghsa-chip';

  const SEVERITY_SUBJECT = 'severity';

  const DIM_CLASS = 'bghsa-dim';

  const FILL_CLASS = 'bghsa-fill';

  /**
   * Use the chip's foreground color as its fill and the page background color
   * for its text. The text needs a separate element to preserve `currentColor`
   * on the outer chip.
   *
   * @type {readonly string[]}
   */
  const FILL_RULES = [
    `.${FILL_CLASS} { background-color: currentColor; border-color: currentColor; }`,
    `.${FILL_CLASS} > span { color: var(--bgColor-default, #ffffff); }`,
  ];

  /**
   * @param {Document} doc
   * @param {ChipSpec} spec
   * @returns {Element}
   */
  function buildChip(doc, spec) {
    const classes = ['Label', spec.severityClass ?? 'Label--secondary'];
    if (spec.tone !== undefined) classes.push(`bghsa-tone-${spec.tone}`);
    if (spec.fill === true) classes.push(FILL_CLASS);
    if (spec.dim === true) classes.push(DIM_CLASS);
    const node = doc.createElement('span');
    node.className = classes.join(' ');
    if (spec.subject !== undefined) node.setAttribute(SUBJECT_ATTRIBUTE, spec.subject);
    if (spec.fill !== true) {
      node.textContent = spec.text;
      return node;
    }
    const text = doc.createElement('span');
    text.textContent = spec.text;
    node.append(text);
    return node;
  }

  const exported = {
    sentenceCase,
    TONE_RULES,
    SUBJECT_ATTRIBUTE,
    SEVERITY_SUBJECT,
    DIM_CLASS,
    FILL_CLASS,
    FILL_RULES,
    buildChip,
    waitingChips,
    DRAFT_STATE,
    PATCH_IN_REVIEW,
    NO_PATCH,
    PATCH_UNKNOWN,
    patchStateOf,
    patchChip,
  };

  globalThis.bghsa.chips = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
