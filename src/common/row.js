'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./dom.js');
  require('./text.js');
  require('./chips.js');
}

/**
 * Metadata shared by the open and completed advisory lists.
 *
 * @typedef {object} RowMeta
 * @property {string | null} ghsaId
 * @property {string | null} openedAt
 * @property {string | null} reporter
 * @property {string | null} [ending] Describes how the advisory ended.
 * @property {string | number | null} [endedAt] When it ended.
 */

/**
 * Each list supplies its chips, additional lines, and cells.
 *
 * @typedef {object} RowSpec
 * @property {string} prefix The CSS class prefix: `bghsa-list` or `bghsa-done`.
 * @property {string | null} ghsaId Identifies the advisory for row updates.
 * @property {string | null} href The title link URL, if known.
 * @property {string} title The title text.
 * @property {string} meta The metadata line below the title.
 * @property {readonly import('./chips.js').ChipSpec[]} chips
 * @property {readonly Element[]} [lines] Appear below the chips in the main column.
 * @property {readonly Element[]} cells The cells beside the main column, in the
 *   order they are drawn.
 */

(() => {
  const element = globalThis.bghsa.dom.element;

  /**
   * Include the ending only when both its label and date are known.
   *
   * @param {RowMeta} row
   * @returns {string}
   */
  function metaTextOf(row) {
    const parts = [];
    if (row.ghsaId !== null) parts.push(row.ghsaId);
    const opened = globalThis.bghsa.text.formatDate(row.openedAt);
    if (opened !== null) parts.push(`opened ${opened}`);
    if (row.reporter !== null) parts.push(`by ${row.reporter}`);
    const ending = row.ending ?? null;
    const ended = globalThis.bghsa.text.formatDate(row.endedAt ?? null);
    if (ending !== null && ended !== null) parts.push(`${ending} ${ended}`);
    return parts.join(' ');
  }

  /**
   * @param {Document} doc
   * @param {string} className
   * @param {string} [text]
   * @returns {Element}
   */
  function cell(doc, className, text) {
    const classes = ['pl-2', 'flex-shrink-0'];
    if (className !== '') classes.push(className);
    return element(doc, 'div', classes.join(' '), text);
  }

  /**
   * Extension rows omit the classes `parse-list` uses to identify GitHub rows.
   *
   * @param {Document} doc
   * @param {RowSpec} spec
   * @returns {Element}
   */
  function buildRow(doc, spec) {
    const item = element(doc, 'li', `Box-row d-flex flex-items-start ${spec.prefix}-row`);
    if (spec.ghsaId !== null) item.setAttribute('data-bghsa-ghsa', spec.ghsaId);

    const main = element(doc, 'div', 'flex-auto lh-condensed');
    const link = element(doc, 'a', 'Link--primary v-align-middle no-underline h4', spec.title);
    if (spec.href !== null) link.setAttribute('href', spec.href);
    main.append(link);
    main.append(element(doc, 'div', `mt-1 text-small ${spec.prefix}-meta`, spec.meta));
    const chips = element(doc, 'div', `mt-1 ${spec.prefix}-chips`);
    for (const chip of spec.chips) chips.append(globalThis.bghsa.chips.buildChip(doc, chip));
    main.append(chips);
    for (const line of spec.lines ?? []) main.append(line);
    item.append(main);

    for (const beside of spec.cells) item.append(beside);
    return item;
  }

  const exported = {
    metaTextOf,
    cell,
    buildRow,
  };

  globalThis.bghsa.row = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
