'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./chips.js');
}

/**
 * @typedef {'Missing' | 'Incomplete' | 'Complete'} LineState
 */

/**
 * @typedef {object} BackportReadiness
 * @property {string} branch
 * @property {'success-muted' | 'danger' | undefined} tone Green for exactly one
 *   approved open pull request on the branch, red for more than one.
 */

/**
 * Whether a draft can be published (REQUIREMENTS.md section 6), and the chip
 * colors the panel and the list draw from it (sections 8 and 9).
 *
 * @typedef {object} Readiness
 * @property {boolean} ready
 * @property {boolean} detailReady Whether every condition the advisory page
 *   alone answers holds, which leaves only the reviews to read.
 * @property {{ package: LineState, affected: LineState, patched: LineState }} lines
 * @property {BackportReadiness[]} backports One per backport target, in order.
 * @property {boolean} backportsIncomplete Whether the patched versions
 *   outnumber the backport targets.
 * @property {boolean} patchApproved Whether every open pull request is
 *   approved, with at most one per branch.
 * @property {{ title: boolean, description: boolean, scoring: boolean }} confirmed
 *   Whether each value is confirmed with a fingerprint matching the current value.
 */

(() => {
  /**
   * @param {readonly import('./parse-detail.js').Package[]} packages
   * @param {(entry: import('./parse-detail.js').Package) => boolean} has
   * @returns {LineState} `Missing` when no package has the value,
   *   `Incomplete` when some do, and `Complete` when all do.
   */
  function lineOf(packages, has) {
    const chips = globalThis.bghsa.chips;
    const count = packages.filter(has).length;
    if (count === 0) return /** @type {LineState} */ (chips.MISSING);
    if (count < packages.length) return /** @type {LineState} */ (chips.INCOMPLETE);
    return /** @type {LineState} */ (chips.COMPLETE);
  }

  /**
   * Every comma-separated entry counts, empty ones included. An empty field
   * counts as zero.
   *
   * @param {readonly import('./parse-detail.js').Package[]} packages
   * @returns {number}
   */
  function patchedCount(packages) {
    let count = 0;
    for (const entry of packages) {
      if (entry.patched !== null) count += entry.patched.split(',').length;
    }
    return count;
  }

  /**
   * @param {import('./cache.js').ReviewResult | undefined} result
   * @param {number} required
   * @returns {boolean} Whether the pull request is approved. A pull request
   *   whose merge box was not read is not approved.
   */
  function approved(result, required) {
    return result !== undefined && result.approvals >= required && !result.changesRequested;
  }

  /**
   * @param {import('./parse-detail.js').ParsedDetail} advisory
   * @param {import('../detail/tracking.js').TrackingView} tracking
   * @param {Readonly<Record<string, import('./cache.js').ReviewResult>>} reviews
   *   Keyed by pull request number.
   * @param {number} required The approvals each pull request needs.
   * @returns {Readiness | null} null for an advisory that is not a draft.
   */
  function compute(advisory, tracking, reviews, required) {
    const chips = globalThis.bghsa.chips;
    if (advisory.state !== chips.DRAFT_STATE) return null;

    const pulls = advisory.fork === null ? [] : advisory.fork.pullRequests;
    const open = pulls.filter((pull) => pull.state === 'open');
    // A row whose state could not be read may be an open pull request.
    const unreadRow = pulls.some((pull) => pull.state !== 'open');
    /** @type {Map<string, typeof open>} */
    const byBranch = new Map();
    let unplaced = false;
    for (const pull of open) {
      if (pull.baseRef === null) {
        unplaced = true;
        continue;
      }
      byBranch.set(pull.baseRef, [...(byBranch.get(pull.baseRef) ?? []), pull]);
    }
    const onePerBranch = !unplaced && [...byBranch.values()].every((held) => held.length <= 1);
    /** @param {(typeof open)[number]} pull */
    const isApproved = (pull) =>
      pull.number !== null && approved(reviews[String(pull.number)], required);
    const allApproved = open.length > 0 && !unreadRow && open.every(isApproved);

    const backports = tracking.backports.map((branch) => {
      const held = byBranch.get(branch) ?? [];
      /** @type {BackportReadiness} */
      const entry = { branch, tone: undefined };
      if (held.length > 1) entry.tone = chips.READINESS_TONES.BROKEN;
      else if (held.length === 1 && isApproved(/** @type {(typeof open)[number]} */ (held[0]))) {
        entry.tone = chips.READINESS_TONES.MET;
      }
      return entry;
    });

    const packages = advisory.packages ?? [];
    const count = patchedCount(packages);
    const targets = tracking.backports.length;
    const countsMatch = targets === 0 || count === targets;
    const patchedLine = lineOf(packages, (entry) => entry.patched !== null);

    const confirmed = {
      title: tracking.title.status === 'confirmed',
      description: tracking.description.status === 'confirmed',
      scoring: tracking.scoring.status === 'confirmed',
    };

    const detailReady =
      confirmed.title &&
      confirmed.description &&
      confirmed.scoring &&
      open.length > 0 &&
      !unreadRow &&
      onePerBranch &&
      tracking.backports.every((branch) => byBranch.has(branch)) &&
      packages.length > 0 &&
      packages.every(
        (entry) =>
          entry.ecosystem !== null &&
          entry.name !== null &&
          entry.affected !== null &&
          entry.patched !== null
      ) &&
      countsMatch;

    return {
      ready: detailReady && allApproved,
      detailReady,
      lines: {
        package: lineOf(packages, (entry) => entry.ecosystem !== null && entry.name !== null),
        affected: lineOf(packages, (entry) => entry.affected !== null),
        patched: countsMatch ? patchedLine : /** @type {LineState} */ (chips.INCOMPLETE),
      },
      backports,
      backportsIncomplete: targets > 0 && count > targets,
      patchApproved: allApproved && onePerBranch,
      confirmed,
    };
  }

  const exported = {
    compute,
  };

  globalThis.bghsa.readiness = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
