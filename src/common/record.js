'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./trust.js');
  require('./schema.js');
}

/**
 * Validate cached fields and recompute trust and schema reports with the
 * current rules. The list table and completed view share this reader.
 */

(() => {
  /**
   * @param {unknown} value
   * @returns {string | null} The nonempty string, or null for other values.
   */
  function text(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  /**
   * @param {unknown} value
   * @returns {string[]} The nonempty strings in the array, or an empty array.
   */
  function strings(value) {
    if (!Array.isArray(value)) return [];
    /** @type {string[]} */
    const found = [];
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim() !== '') found.push(entry);
    }
    return found;
  }

  /**
   * @param {unknown} value
   * @returns {import('./parse-detail.js').ParsedComment | null}
   */
  function commentFrom(value) {
    const schema = globalThis.bghsa.schema;
    if (!schema.isPlainObject(value)) return null;
    const author = text(value.author);
    const role = text(value.role);
    const held = schema.isPlainObject(value.stateComment) ? text(value.stateComment.raw) : null;
    return {
      id: text(value.id) ?? '',
      elementId: text(value.elementId) ?? '',
      author,
      role,
      roles: strings(value.roles),
      trusted: globalThis.bghsa.trust.isTrustedAuthor(author, role),
      at: text(value.at),
      text: text(value.text) ?? '',
      stateComment: held === null ? null : schema.readSnapshot(held),
    };
  }

  /**
   * Writes initiated from cached data require the owner, repository, and
   * advisory ID to identify the destination.
   *
   * @param {unknown} value
   * @returns {import('./parse-detail.js').AdvisoryRef | null}
   */
  function refFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    const owner = text(value.owner);
    const repo = text(value.repo);
    const ghsaId = text(value.ghsaId);
    if (owner === null || repo === null || ghsaId === null) return null;
    return { owner, repo, ghsaId };
  }

  /**
   * @param {unknown} value
   * @returns {import('./parse-detail.js').TimelineEvent | null}
   */
  function eventFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    return {
      id: text(value.id),
      actor: text(value.actor),
      at: text(value.at),
      text: text(value.text) ?? '',
    };
  }

  /**
   * @param {unknown} value
   * @returns {import('./parse-detail.js').ForkPullRequest | null}
   */
  function pullFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    const number = value.number;
    return {
      number: typeof number === 'number' && Number.isFinite(number) ? number : null,
      url: text(value.url),
      title: text(value.title) ?? '',
      state: text(value.state),
      baseRef: text(value.baseRef),
      headRef: text(value.headRef),
      author: text(value.author),
      openedAt: text(value.openedAt),
      assignees: strings(value.assignees),
    };
  }

  /**
   * @param {unknown} value
   * @returns {import('./parse-detail.js').PrivateFork | null}
   */
  function forkFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    if (!Array.isArray(value.pullRequests)) return null;
    /** @type {import('./parse-detail.js').ForkPullRequest[]} */
    const pullRequests = [];
    for (const entry of value.pullRequests) {
      const pull = pullFrom(entry);
      if (pull !== null) pullRequests.push(pull);
    }
    return {
      cloneUrl: text(value.cloneUrl),
      repository: text(value.repository),
      deleteUrl: text(value.deleteUrl),
      pullRequests,
    };
  }

  /**
   * Require both comments and timeline arrays before deriving advisory state.
   *
   * @param {unknown} record
   * @returns {import('./parse-detail.js').ParsedDetail | null}
   */
  function advisoryFrom(record) {
    const schema = globalThis.bghsa.schema;
    if (!schema.isPlainObject(record)) return null;
    if (!Array.isArray(record.comments) || !Array.isArray(record.timeline)) return null;

    /** @type {import('./parse-detail.js').ParsedComment[]} */
    const comments = [];
    for (const entry of record.comments) {
      const comment = commentFrom(entry);
      if (comment !== null) comments.push(comment);
    }
    /** @type {import('./parse-detail.js').TimelineEvent[]} */
    const timeline = [];
    for (const entry of record.timeline) {
      const event = eventFrom(entry);
      if (event !== null) timeline.push(event);
    }

    return {
      ref: refFrom(record.ref),
      viewer: null,
      ghsaId: text(record.ghsaId),
      state: text(record.state),
      severity: text(record.severity),
      severityLabel: text(record.severityLabel),
      severityClass: text(record.severityClass),
      reportedAt: text(record.reportedAt),
      reporter: text(record.reporter),
      title: text(record.title),
      description: text(record.description),
      severityField: text(record.severityField),
      severityFieldPresent: record.severityFieldPresent === true,
      cvssV3: text(record.cvssV3),
      cvssV3Present: record.cvssV3Present === true,
      cveId: text(record.cveId),
      cveSelection: text(record.cveSelection),
      descriptionOriginal:
        typeof record.descriptionOriginal === 'boolean' ? record.descriptionOriginal : null,
      descriptionRevision: null,
      comments,
      timeline,
      fork: forkFrom(record.fork),
      collaborators: strings(record.collaborators),
    };
  }

  const exported = {
    text,
    advisoryFrom,
  };

  globalThis.bghsa.record = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
