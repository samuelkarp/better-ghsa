'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./diag.js');
  require('./allowlist.js');
  require('./schema.js');
  require('./fetch.js');
}

/**
 * @typedef {object} ReviewOptions
 * @property {import('./write.js').WriteFetch} [fetch]
 * @property {number} [timeoutMs] The request timeout in milliseconds.
 */

(() => {
  const diag = globalThis.bghsa.diag.log;

  /**
   * GitHub answers 406 without `X-Requested-With`.
   */
  const MERGE_BOX_INIT = /** @type {RequestInit} */ ({
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'GitHub-Verified-Fetch': 'true',
    },
  });

  /** @type {import('./write.js').WriteFetch | null} */
  let injected = null;

  /**
   * @param {import('./write.js').WriteFetch | null} fetch The request function,
   *   or null for the browser's.
   * @returns {void}
   */
  function setFetch(fetch) {
    injected = fetch;
  }

  /**
   * The merge box of a pull request in the advisory's own temporary private
   * fork, `{owner}/{repo}-{ghsa}`, of an allowlisted repository. The path is
   * null for any other pull request.
   *
   * @param {import('./parse-detail.js').AdvisoryRef | null} ref
   * @param {import('./parse-detail.js').ForkPullRequest} pull
   * @returns {string | null} The path to request, or null.
   */
  function mergeBoxPath(ref, pull) {
    if (ref === null || pull.number === null) return null;
    if (!globalThis.bghsa.allowlist.isAllowed(`${ref.owner}/${ref.repo}`)) return null;
    const match = /^\/([^/?#]+)\/([^/?#]+)\/pull\/([1-9]\d*)\/?$/.exec(pull.url ?? '');
    if (match === null || Number(match[3]) !== pull.number) return null;
    const fork = `${ref.owner}/${ref.repo}-${ref.ghsaId}`.toLowerCase();
    if (`${match[1]}/${match[2]}`.toLowerCase() !== fork) return null;
    return `/${match[1]}/${match[2]}/pull/${pull.number}/page_data/merge_box`;
  }

  /**
   * @param {unknown} json The merge box data.
   * @returns {Record<string, unknown> | null} The `PULL_REQUEST` rule rollup's
   *   metadata, or null when the data does not carry one.
   */
  function rollupOf(json) {
    const schema = globalThis.bghsa.schema;
    if (!schema.isPlainObject(json) || !schema.isPlainObject(json.mergeRequirements)) return null;
    const conditions = json.mergeRequirements.conditions;
    if (!Array.isArray(conditions)) return null;
    for (const condition of conditions) {
      if (!schema.isPlainObject(condition) || condition.type !== 'PULL_REQUEST_RULES') continue;
      if (!Array.isArray(condition.ruleRollups)) continue;
      for (const rollup of condition.ruleRollups) {
        if (!schema.isPlainObject(rollup) || rollup.ruleType !== 'PULL_REQUEST') continue;
        if (schema.isPlainObject(rollup.metadata)) return rollup.metadata;
      }
    }
    return null;
  }

  /**
   * Count approvals and requests for changes the way GitHub does. The branch
   * rule's rollup carries GitHub's own count; without one, the latest review
   * of each reviewer with write access counts.
   *
   * @param {unknown} json The merge box data.
   * @returns {{ approvals: number, changesRequested: boolean } | null} null when
   *   the data does not carry the pull request's latest reviews.
   */
  function reviewResultOf(json) {
    const schema = globalThis.bghsa.schema;
    if (!schema.isPlainObject(json) || !schema.isPlainObject(json.pullRequest)) return null;
    const listed = json.pullRequest.latestOpinionatedReviews;
    if (!Array.isArray(listed)) return null;

    const rollup = rollupOf(json);
    const counted = rollup?.approvedReviewers;
    if (typeof counted === 'number' && Number.isSafeInteger(counted) && counted >= 0) {
      const reasons = rollup?.failureReasons;
      return {
        approvals: counted,
        changesRequested: Array.isArray(reasons) && reasons.includes('changes_requested'),
      };
    }

    /** @param {string} state @returns {number} */
    const writers = (state) =>
      listed.filter(
        (review) =>
          schema.isPlainObject(review) &&
          review.state === state &&
          review.authorCanPushToRepository === true
      ).length;
    return { approvals: writers('APPROVED'), changesRequested: writers('CHANGES_REQUESTED') > 0 };
  }

  /**
   * Read one pull request's merge box. A response that fails, times out, or
   * does not carry the reviews leaves the pull request without a result.
   *
   * @param {import('./parse-detail.js').AdvisoryRef | null} ref
   * @param {import('./parse-detail.js').ForkPullRequest} pull
   * @param {ReviewOptions} [options]
   * @returns {Promise<import('./cache.js').ReviewResult | null>}
   */
  async function readReview(ref, pull, options = {}) {
    const path = mergeBoxPath(ref, pull);
    const subject = `${ref?.ghsaId ?? 'unknown'} #${pull.number ?? '?'}`;
    if (path === null) {
      diag(`reviews skip ${subject}`);
      return null;
    }
    const send =
      options.fetch ??
      injected ??
      /** @type {import('./write.js').WriteFetch} */ (globalThis.fetch.bind(globalThis));
    const timeout = options.timeoutMs ?? globalThis.bghsa.fetch.REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let countdown;
    const expiry = new Promise((_resolve, reject) => {
      countdown = setTimeout(() => {
        controller.abort();
        reject(new Error(`GitHub did not answer within ${timeout} ms.`));
      }, timeout);
    });
    try {
      const json = await Promise.race([
        (async () => {
          const response = await send(path, { ...MERGE_BOX_INIT, signal: controller.signal });
          diag(`reviews answer ${subject} status=${response.status}`);
          if (!(response.status >= 200 && response.status < 300)) return null;
          return JSON.parse(await response.text());
        })(),
        expiry,
      ]);
      const result = reviewResultOf(json);
      if (result === null) {
        diag(`reviews unreadable ${subject}`);
        return null;
      }
      return { ...result, observedAt: Date.now() };
    } catch (error) {
      diag(`reviews failed ${subject} ${error instanceof Error ? error.name : 'error'}`);
      return null;
    } finally {
      clearTimeout(countdown);
    }
  }

  const exported = {
    setFetch,
    mergeBoxPath,
    reviewResultOf,
    readReview,
  };

  globalThis.bghsa.reviews = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
