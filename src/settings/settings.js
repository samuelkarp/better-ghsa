'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// Script tags order browser dependencies; Node loads them here.
if (typeof require === 'function') {
  require('../common/allowlist.js');
  require('../common/forget.js');
}

/**
 * @typedef {object} SettingsElements
 * @property {HTMLFormElement | null} form
 * @property {HTMLInputElement | null} input
 * @property {Element | null} error
 * @property {Element | null} empty
 * @property {Element | null} list
 * @property {Element | null} clear
 * @property {Element | null} status
 */

(() => {

  const MALFORMED_MESSAGE = 'Enter a repository as owner/repo.';

  const DUPLICATE_MESSAGE = 'That repository is already listed.';

  /**
   * Cache clearing needs a status message because the repository list stays
   * unchanged.
   */
  const CLEARED_MESSAGE = 'Cache cleared';

  /**
   * @param {Document} doc
   * @returns {SettingsElements}
   */
  function elementsOf(doc) {
    return {
      form: /** @type {HTMLFormElement | null} */ (doc.getElementById('add-form')),
      input: /** @type {HTMLInputElement | null} */ (doc.getElementById('add-input')),
      error: doc.getElementById('add-error'),
      empty: doc.getElementById('empty'),
      list: doc.getElementById('list'),
      clear: doc.getElementById('clear-button'),
      status: doc.getElementById('clear-status'),
    };
  }

  /**
   * @param {Document} doc
   * @param {string | null} message The error to display, or null to clear it.
   * @returns {void}
   */
  function showError(doc, message) {
    const error = elementsOf(doc).error;
    if (error === null) return;
    error.textContent = message ?? '';
    if (message === null) error.setAttribute('hidden', '');
    else error.removeAttribute('hidden');
  }

  /**
   * @param {Document} doc
   * @param {boolean} cleared Whether to show the cache-cleared status.
   * @returns {void}
   */
  function showCleared(doc, cleared) {
    const status = elementsOf(doc).status;
    if (status === null) return;
    status.textContent = cleared ? CLEARED_MESSAGE : '';
    if (cleared) status.removeAttribute('hidden');
    else status.setAttribute('hidden', '');
  }

  /**
   * @param {Document} doc
   * @param {string} entry
   * @returns {Element}
   */
  function buildRow(doc, entry) {
    const row = doc.createElement('li');
    row.className = 'row';
    const name = doc.createElement('span');
    name.className = 'row-name';
    name.textContent = entry;
    row.append(name);
    const button = doc.createElement('button');
    button.className = 'button button-danger';
    button.type = 'button';
    button.dataset.entry = entry;
    // Identify the repository when a screen reader navigates directly to buttons.
    button.setAttribute('aria-label', `Remove ${entry}`);
    button.textContent = 'Remove';
    row.append(button);
    return row;
  }

  /**
   * @param {Document} doc
   * @param {readonly string[]} entries
   * @returns {void}
   */
  function render(doc, entries) {
    const { list, empty } = elementsOf(doc);
    if (list !== null) {
      list.replaceChildren(...entries.map((entry) => buildRow(doc, entry)));
    }
    if (empty !== null) {
      if (entries.length === 0) empty.removeAttribute('hidden');
      else empty.setAttribute('hidden', '');
    }
  }

  /**
   * Preserve rejected input for correction.
   *
   * @param {Document} doc
   * @returns {Promise<boolean>} Whether the list changed.
   */
  async function submit(doc) {
    showCleared(doc, false);
    const { input } = elementsOf(doc);
    const typed = input?.value ?? '';
    const outcome = await globalThis.bghsa.allowlist.add(typed);
    if (!outcome.ok) {
      if (outcome.reason === 'empty') showError(doc, null);
      else showError(doc, outcome.reason === 'duplicate' ? DUPLICATE_MESSAGE : MALFORMED_MESSAGE);
      return false;
    }
    showError(doc, null);
    if (input !== null) input.value = '';
    render(doc, globalThis.bghsa.allowlist.current());
    return true;
  }

  /**
   * @param {Document} doc
   * @param {string} entry
   * @returns {Promise<void>}
   */
  async function drop(doc, entry) {
    showError(doc, null);
    showCleared(doc, false);
    const entries = await globalThis.bghsa.allowlist.remove(entry);
    render(doc, entries);
    await globalThis.bghsa.forget.repository(entry, entries);
  }

  /**
   * Clear cached observations while retaining the allowlist. Advisory reads
   * rebuild the cache (REQUIREMENTS.md section 2).
   *
   * @param {Document} doc
   * @returns {Promise<void>}
   */
  async function clear(doc) {
    showError(doc, null);
    await globalThis.bghsa.forget.everything();
    showCleared(doc, true);
  }

  /**
   * Subscribe to allowlist changes from other settings tabs as well as this page.
   *
   * @param {Document} [doc]
   * @returns {Promise<void>}
   */
  async function start(doc = globalThis.document) {
    const { form, list, clear: control } = elementsOf(doc);
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      void submit(doc);
    });
    list?.addEventListener('click', (event) => {
      const target = /** @type {Element | null} */ (event.target);
      const button = target?.closest?.('button[data-entry]');
      const entry = button?.getAttribute('data-entry');
      if (entry === null || entry === undefined) return;
      void drop(doc, entry);
    });
    control?.addEventListener('click', () => {
      void clear(doc);
    });
    const allowlist = globalThis.bghsa.allowlist;
    allowlist.watch();
    allowlist.subscribe((entries) => {
      render(doc, entries);
    });
    render(doc, await allowlist.load());
  }

  const exported = {
    MALFORMED_MESSAGE,
    DUPLICATE_MESSAGE,
    CLEARED_MESSAGE,
    render,
    submit,
    drop,
    clear,
    start,
  };

  if (typeof module !== 'undefined') {
    module.exports = exported;
  } else {
    void start();
  }
})();
