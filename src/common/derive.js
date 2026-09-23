'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') require('./trust.js');

/**
 * @typedef {object} CveState
 * @property {string | null} id The assigned CVE.
 * @property {boolean} assigned
 * @property {boolean} requested Whether the timeline records a CVE request.
 * @property {string | null} selection The advisory's stored CVE selection.
 * @property {'assigned' | 'requested' | 'not applicable' | 'none'} state
 */

/**
 * @typedef {object} BranchPatch
 * @property {string} branch
 * @property {number[]} pullRequests The numbers targeting this branch.
 * @property {boolean} open Whether one of them is open.
 */

/**
 * @typedef {object} PatchState
 * @property {boolean} hasFork
 * @property {import('./parse-detail.js').ForkPullRequest[]} pullRequests
 * @property {BranchPatch[]} branches In the order the branches first appear.
 * @property {number[]} open
 * @property {number[]} unknown Pull request numbers with an unreadable state.
 * @property {boolean} incomplete Whether a row has an unreadable state.
 *   Counts and branch flags are lower bounds when this is true.
 */

/**
 * @typedef {object} DerivedState
 * @property {string[]} members The logins the page shows to be org members.
 * @property {boolean} neverReviewed Whether the comments, timeline, and
 *   advisory state lack evidence of a maintainer review.
 * @property {boolean} newActivity The newest comment from a non-member is newer
 *   than the newest member comment or member action.
 * @property {string | null} lastMemberActivityAt
 * @property {string | null} lastNonMemberCommentAt
 * @property {CveState} cve
 * @property {PatchState} patch
 */

(() => {
  /**
   * @param {(string | null)[]} times
   * @returns {string | null} the latest of the ISO times given, ignoring nulls.
   */
  function latest(times) {
    /** @type {string | null} */
    let newest = null;
    for (const time of times) {
      if (time === null) continue;
      if (newest === null || time > newest) newest = time;
    }
    return newest;
  }

  /**
   * Only comment authors have role badges. {@link maintainerOnlyEvent}
   * identifies maintainer actions by people who have not commented.
   *
   * @param {import('./parse-detail.js').ParsedDetail} advisory
   * @returns {string[]}
   */
  function memberLogins(advisory) {
    const trust = globalThis.bghsa.trust;
    /** @type {string[]} */
    const members = [];
    for (const comment of advisory.comments) {
      if (!trust.isTrustedAuthor(comment.author, comment.role)) continue;
      const login = /** @type {string} */ (comment.author);
      if (!members.includes(login)) members.push(login);
    }
    return members;
  }

  /**
   * Timeline events begin with a login, which cannot contain spaces.
   * Remove it before matching the event phrase.
   *
   * @param {import('./parse-detail.js').TimelineEvent} event
   * @returns {string} The event phrase, or an empty string if the actor
   *   separator is missing.
   */
  function eventPhrase(event) {
    const space = event.text.indexOf(' ');
    return space === -1 ? '' : event.text.slice(space + 1);
  }

  /**
   * Exclude reporter and GitHub events before checking maintainer events
   * (REQUIREMENTS.md section 6). `added themselves as a collaborator` also
   * matches the pattern for a maintainer adding a collaborator.
   */
  const REPORTER_EVENTS = [
    /^was credited as a reporter\b/,
    /^accepted credit\b/,
    /^added themselves as a collaborator\b/,
    /^changed the title\b/,
    /^created the temporary private fork\b/,
    /^released this\b/,
    /^assigned\b/,
  ];

  const CVE_REQUEST_EVENT = /^requested a CVE\b/;

  /**
   * These events require a maintainer and count as reviews even if the actor
   * has not commented and therefore lacks a visible role badge.
   */
  const MAINTAINER_EVENTS = [
    /^accepted this report\b/,
    /^added\b.+\bas a collaborator\b/,
    CVE_REQUEST_EVENT,
    /^published this\b/,
    /^closed this\b/,
    /^deleted the temporary private fork\b/,
  ];

  /**
   * Match from the start of the event phrase to avoid matching user-supplied
   * titles inside `changed the title` events.
   *
   * @param {import('./parse-detail.js').TimelineEvent} event
   * @param {RegExp} pattern A phrase pattern, anchored with `^`.
   * @returns {boolean}
   */
  function eventIs(event, pattern) {
    const phrase = eventPhrase(event);
    if (REPORTER_EVENTS.some((reporter) => reporter.test(phrase))) return false;
    return pattern.test(phrase);
  }

  /**
   * @param {import('./parse-detail.js').TimelineEvent} event
   * @returns {boolean}
   */
  function maintainerOnlyEvent(event) {
    return MAINTAINER_EVENTS.some((pattern) => eventIs(event, pattern));
  }

  /**
   * Draft and published states require a maintainer action. A reporter can
   * withdraw an advisory. Closed state alone does not establish a review.
   *
   * @param {import('./parse-detail.js').ParsedDetail} advisory
   * @returns {boolean}
   */
  function reviewedByState(advisory) {
    const state = advisory.state === null ? null : advisory.state.toLowerCase();
    return state === 'draft' || state === 'published';
  }

  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

  /**
   * @param {string} lift A stored embargo lift date.
   * @returns {number | null} The embargo deadline, or null for an invalid date.
   *   Date-only values expire at the end of that day in UTC.
   */
  function liftInstant(lift) {
    const stamp = DATE_ONLY.test(lift) ? `${lift}T23:59:59.999Z` : lift;
    const parsed = Date.parse(stamp);
    return Number.isNaN(parsed) ? null : parsed;
  }

  /**
   * An embargo is overdue after its lift date unless the advisory is published.
   * Treat an unreadable advisory state as unpublished.
   *
   * @param {import('./parse-detail.js').ParsedDetail} advisory
   * @param {string | null} lift The stored embargo lift date, or null if unset.
   * @param {number} [now] The comparison time in epoch milliseconds.
   * @returns {boolean}
   */
  function embargoOverdue(advisory, lift, now = Date.now()) {
    if (lift === null) return false;
    if ((advisory.state === null ? null : advisory.state.toLowerCase()) === 'published') return false;
    const instant = liftInstant(lift);
    return instant !== null && now > instant;
  }

  /**
   * @param {import('./parse-detail.js').ParsedDetail} advisory
   * @returns {CveState}
   */
  function cveState(advisory) {
    const id = advisory.cveId;
    const assigned = id !== null;
    const requested = advisory.timeline.some((event) => eventIs(event, CVE_REQUEST_EVENT));
    /** @type {CveState['state']} */
    let state;
    if (assigned) state = 'assigned';
    else if (requested) state = 'requested';
    else if (advisory.cveSelection === 'not_applicable') state = 'not applicable';
    else state = 'none';
    return { id, assigned, requested, selection: advisory.cveSelection, state };
  }

  /**
   * The private fork lists only open pull requests (REQUIREMENTS.md section 6).
   * Any other row state counts as unknown and makes the patch state incomplete.
   *
   * @param {import('./parse-detail.js').ParsedDetail} advisory
   * @returns {PatchState}
   */
  function patchState(advisory) {
    const pullRequests = advisory.fork === null ? [] : advisory.fork.pullRequests;
    /** @type {BranchPatch[]} */
    const branches = [];
    /** @type {number[]} */
    const open = [];
    /** @type {number[]} */
    const unknown = [];
    let incomplete = false;

    for (const pull of pullRequests) {
      const isOpen = pull.state === 'open';
      if (!isOpen) incomplete = true;
      if (pull.number !== null) {
        if (isOpen) open.push(pull.number);
        else unknown.push(pull.number);
      }
      if (pull.baseRef === null) continue;
      let branch = branches.find((entry) => entry.branch === pull.baseRef);
      if (branch === undefined) {
        branch = { branch: pull.baseRef, pullRequests: [], open: false };
        branches.push(branch);
      }
      if (pull.number !== null) branch.pullRequests.push(pull.number);
      if (isOpen) branch.open = true;
    }

    return {
      hasFork: advisory.fork !== null,
      pullRequests,
      branches,
      open,
      unknown,
      incomplete,
    };
  }

  /**
   * @param {import('./parse-detail.js').ParsedDetail} advisory
   * @returns {DerivedState}
   */
  function derive(advisory) {
    const members = memberLogins(advisory);

    /** @type {(string | null)[]} */
    const memberActivity = [];
    /** @type {(string | null)[]} */
    const nonMemberComments = [];
    for (const comment of advisory.comments) {
      if (comment.trusted) memberActivity.push(comment.at);
      else nonMemberComments.push(comment.at);
    }
    for (const event of advisory.timeline) {
      const byMember = event.actor !== null && members.includes(event.actor);
      if (!byMember && !maintainerOnlyEvent(event)) continue;
      memberActivity.push(event.at);
    }

    const lastMemberActivityAt = latest(memberActivity);
    const lastNonMemberCommentAt = latest(nonMemberComments);

    return {
      members,
      neverReviewed: memberActivity.length === 0 && !reviewedByState(advisory),
      newActivity:
        lastNonMemberCommentAt !== null &&
        (lastMemberActivityAt === null || lastNonMemberCommentAt > lastMemberActivityAt),
      lastMemberActivityAt,
      lastNonMemberCommentAt,
      cve: cveState(advisory),
      patch: patchState(advisory),
    };
  }

  const exported = {
    CVE_REQUEST_EVENT,
    derive,
    maintainerOnlyEvent,
    eventIs,
    cveState,
    patchState,
    embargoOverdue,
  };

  globalThis.bghsa.derive = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
