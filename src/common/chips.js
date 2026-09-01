'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./order.js');
}

/**
 * A chip the list row, the completed row and the detail panel carry. A tone
 * names a Primer state token, and a chip with no tone is dimmed. Every surface
 * draws it as `Label`, `Label--secondary`, and `bghsa-tone-{tone}`.
 *
 * @typedef {object} Chip
 * @property {string} text
 * @property {'attention' | 'danger' | 'done' | 'success'} [tone]
 */

/**
 * A chip as a surface draws it: what a producer here says, and what the surface
 * knows on top of it.
 *
 * @typedef {Chip & { severityClass?: string | null, dim?: boolean, fill?: boolean }} ChipSpec
 *   `severityClass` is the `Label--` modifiers GitHub painted the advisory's
 *   own severity chip with, which stands in for the neutral one, `dim` holds a
 *   chip back from its full color while keeping its hue, and `fill` paints that
 *   color as the chip's own fill.
 */

(() => {
  /**
   * A stored value as a chip reads it. GitHub sentence-cases its own chips, and
   * a derived state is named in the lower case REQUIREMENTS.md sets. Only the
   * first letter is touched, so a value this extension does not interpret still
   * reaches the reader as it stands.
   *
   * @param {string} value
   * @returns {string}
   */
  function sentenceCase(value) {
    return value === '' ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
  }

  /**
   * What the waiting chip reads and how it is colored. The text is the waiting
   * state the default order derives, so both surfaces say the one thing the
   * advisory is waiting on. Never reviewed and blocked on us are both work
   * nobody has done and take danger. The other two take attention.
   *
   * @param {import('./order.js').WaitingEntry} entry
   * @returns {Chip}
   */
  function waitingChip(entry) {
    const order = globalThis.bghsa.order;
    const state = order.waitingStateOf(entry);
    const undone = state === order.GROUPS.NEVER_REVIEWED || state === order.GROUPS.BLOCKED_ON_US;
    return { text: sentenceCase(state), tone: undone ? 'danger' : 'attention' };
  }

  /**
   * The state GitHub gives an advisory nobody has published or closed yet, as
   * GitHub words it. The patch chip stands on a draft and on no other: an
   * advisory in triage has not been accepted, so no patch is owed for it yet
   * and its absence says nothing.
   */
  const DRAFT_STATE = 'Draft';

  /** What the patch chip reads while the fork holds an open pull request. */
  const PATCH_IN_REVIEW = 'Patch in review';

  /** What the patch chip reads while the fork holds no pull request. */
  const NO_PATCH = 'No patch yet';

  /** What the patch chip reads where a pull request named a state nobody reads. */
  const PATCH_UNKNOWN = 'Unknown';

  /**
   * What the advisory's private fork says about the patch. REQUIREMENTS.md
   * section 6 has the fork's list show open pull requests only, so a fork
   * listing none reads the same as no fork at all. A pull request whose state
   * went unread reads `Unknown`, because a patch this reader could not judge is
   * not a patch that is not there.
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
   * How the patch chip is colored. A draft owes a patch, so no patch takes
   * danger and a patch under review takes attention. A state this reader could
   * not judge claims neither and is dimmed.
   *
   * @param {string} state What {@link patchStateOf} read.
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
   * How a tone is painted, as the rules a surface's own stylesheet carries.
   *
   * The chips sit beside GitHub's own `Label--secondary`, a neutral outline over
   * the page's background. `attention` and `danger` are muted fills, which carry
   * default-strength text; `done` and `success` are emphasis fills, which carry
   * `--fgColor-onEmphasis`. A muted fill falls back to a translucent color and
   * an emphasis fill to the opaque one GitHub paints it, so each lands in either
   * theme.
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
    '.bghsa-tone-done { color: var(--fgColor-onEmphasis, #ffffff);' +
      ' background-color: var(--bgColor-done-emphasis, #8250df);' +
      ' border-color: var(--bgColor-done-emphasis, #8250df); }',
    '.bghsa-tone-success { color: var(--fgColor-onEmphasis, #ffffff);' +
      ' background-color: var(--bgColor-success-emphasis, #1f883d);' +
      ' border-color: var(--bgColor-success-emphasis, #1f883d); }',
  ];

  /** What holds a chip back from its full color while keeping its hue. */
  const DIM_CLASS = 'bghsa-dim';

  /** What paints a chip's own color as its fill. */
  const FILL_CLASS = 'bghsa-fill';

  /**
   * How a filled chip is painted, as the rules a surface's own stylesheet
   * carries.
   *
   * The fill is the color the chip's text carries, which on a severity chip is
   * the one GitHub painted it, and the text over it is the page's own
   * background. Primer holds a foreground and the background it is read over
   * far enough apart to read either way round, so the pair carries its contrast
   * inverted in both themes. The text takes an element of its own, because
   * `currentColor` on the chip is the color the fill is taken from.
   *
   * @type {readonly string[]}
   */
  const FILL_RULES = [
    `.${FILL_CLASS} { background-color: currentColor; border-color: currentColor; }`,
    `.${FILL_CLASS} > span { color: var(--bgColor-default, #ffffff); }`,
  ];

  /**
   * One chip, as every surface draws it: `Label`, then GitHub's own color for
   * the advisory's severity or the neutral modifier, then the tone, then the
   * fill, then the dimming. A surface that builds one by hand is a surface that
   * can disagree with the others about what a chip is.
   *
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
    DIM_CLASS,
    FILL_CLASS,
    FILL_RULES,
    buildChip,
    waitingChip,
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
