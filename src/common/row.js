'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./dom.js');
  require('./text.js');
  require('./chips.js');
}

/**
 * What the line under a row's title is built from. Both lists carry the same
 * line, and each holds these three off a row of its own shape.
 *
 * @typedef {object} RowMeta
 * @property {string | null} ghsaId
 * @property {string | null} openedAt
 * @property {string | null} reporter
 */

/**
 * One row of one of the extension's lists, as the surface drawing it describes
 * it. Everything a surface knows and this file does not arrives built: the
 * chips as specs, the lines under them and the cells beside them as elements.
 *
 * @typedef {object} RowSpec
 * @property {string} prefix What this surface names its own parts, as the stem
 *   its classes are built on: `bghsa-list` or `bghsa-done`.
 * @property {string | null} ghsaId The advisory the row stands for, which the
 *   surface finds the row again by, and null where nothing named it.
 * @property {string | null} href Where the title leads, and null where the row
 *   knows no address.
 * @property {string} title What the title reads.
 * @property {string} meta The line under it.
 * @property {readonly import('./chips.js').ChipSpec[]} chips
 * @property {readonly Element[]} [lines] What stands under the chips, in the
 *   main column.
 * @property {readonly Element[]} cells The cells beside the main column, in the
 *   order they are drawn.
 */

(() => {
  /** How every surface builds an element. */
  const element = globalThis.bghsa.dom.element;

  /**
   * The line GitHub's own row carries under the title. The lists replace those
   * rows, so they carry what those rows carried.
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
    return parts.join(' ');
  }

  /**
   * One cell beside the main column: the padding that parts it from what stands
   * to its left, and whatever the surface names it.
   *
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
   * One row of a list: the title as a link, the line GitHub's row carried, the
   * chips, whatever else the surface puts under them, and the cells beside.
   *
   * The row carries none of the classes `parse-list` keys on, so a re-read of
   * the page cannot take it for one of GitHub's.
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
