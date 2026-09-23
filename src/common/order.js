'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./text.js');
}

/**
 * @typedef {object} OrderEntry
 * @property {string | null} ghsaId
 * @property {string | null} state The GitHub advisory state.
 * @property {boolean} neverReviewed Whether the advisory lacks evidence of maintainer review.
 * @property {boolean} newActivity Whether a non-member commented after the last
 *   member comment or action.
 * @property {string | null} triage The stored triage value.
 * @property {boolean} embargoOverdue The embargo lift date has gone by and the
 *   advisory is not published.
 * @property {string | null} severity The advisory severity.
 * @property {boolean} severityConfirmed Whether a maintainer confirmed that
 *   severity. The caller clears confirmations for changed values.
 * @property {string | null} waitingSince The time the advisory entered its
 *   current triage value.
 */

/**
 * @typedef {Pick<OrderEntry, 'neverReviewed' | 'newActivity' | 'triage'>} WaitingEntry
 */

(() => {
  /**
   * Group ordering follows REQUIREMENTS.md section 9.
   */
  const GROUPS = {
    EMBARGO_OVERDUE: 'embargo overdue',
    NEW_ACTIVITY: 'new activity',
    BLOCKED_ON_US: 'blocked on us',
    NEVER_REVIEWED: 'never reviewed',
    BLOCKED_ON_REPORTER: 'blocked on the reporter',
  };

  /**
   * Moving an advisory to draft requires a maintainer review.
   *
   * @type {readonly string[]}
   */
  const DRAFT_GROUPS = [
    GROUPS.EMBARGO_OVERDUE,
    GROUPS.NEW_ACTIVITY,
    GROUPS.BLOCKED_ON_US,
    GROUPS.BLOCKED_ON_REPORTER,
  ];

  /** @type {readonly string[]} */
  const TRIAGE_GROUPS = [
    GROUPS.EMBARGO_OVERDUE,
    GROUPS.BLOCKED_ON_US,
    GROUPS.NEVER_REVIEWED,
    GROUPS.NEW_ACTIVITY,
    GROUPS.BLOCKED_ON_REPORTER,
  ];

  /**
   * Chip and filter precedence is independent of the table's sort order.
   *
   * @type {readonly string[]}
   */
  const WAITING_STATES = [
    GROUPS.NEVER_REVIEWED,
    GROUPS.NEW_ACTIVITY,
    GROUPS.BLOCKED_ON_US,
    GROUPS.BLOCKED_ON_REPORTER,
  ];

  /** @type {Readonly<Record<string, 'us' | 'reporter'>>} */
  const BLOCKED_ON = {
    evaluating: 'us',
    'awaiting reporter': 'reporter',
    'awaiting maintainer input': 'us',
  };

  /**
   * Unknown and unset severities rank below known severities.
   *
   * @type {Readonly<Record<string, number>>}
   */
  const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1 };

  /**
   * @param {string | null | undefined} severity
   * @returns {number} The severity rank, or zero if unset or unknown.
   */
  function severityRank(severity) {
    if (typeof severity !== 'string') return 0;
    return SEVERITY_RANK[severity.trim().toLowerCase()] ?? 0;
  }

  /**
   * Unknown triage values require maintainer attention.
   *
   * @param {string | null | undefined} triage
   * @returns {'us' | 'reporter' | null} Null if triage is unset.
   */
  function classifyTriage(triage) {
    if (typeof triage !== 'string' || triage.trim() === '') return null;
    return BLOCKED_ON[triage.trim().toLowerCase()] ?? 'us';
  }

  /**
   * Draft advisories without stored triage require maintainer attention
   * (REQUIREMENTS.md section 9).
   *
   * @param {OrderEntry} entry
   * @returns {boolean}
   */
  function blockedOnUs(entry) {
    const blocked = classifyTriage(entry.triage);
    if (blocked === null) return stateOf(entry) === 'draft';
    return blocked === 'us';
  }

  /**
   * @param {OrderEntry} entry
   * @returns {boolean} Whether triage is unset.
   */
  function untriaged(entry) {
    return classifyTriage(entry.triage) === null;
  }

  /**
   * Use triage ordering for every state except draft.
   *
   * @param {OrderEntry} entry
   * @returns {'draft' | 'triage'}
   */
  function stateOf(entry) {
    if (typeof entry.state !== 'string') return 'triage';
    return entry.state.trim().toLowerCase() === 'draft' ? 'draft' : 'triage';
  }

  /**
   * @param {'draft' | 'triage'} state
   * @returns {readonly string[]} the groups of that state, most urgent first.
   */
  function groupsFor(state) {
    return state === 'draft' ? DRAFT_GROUPS : TRIAGE_GROUPS;
  }

  /** @type {Readonly<Record<string, (entry: OrderEntry) => boolean>>} */
  const MEMBER_OF = {
    [GROUPS.EMBARGO_OVERDUE]: (entry) => entry.embargoOverdue,
    [GROUPS.NEW_ACTIVITY]: (entry) => entry.newActivity,
    [GROUPS.BLOCKED_ON_US]: (entry) => blockedOnUs(entry),
    [GROUPS.NEVER_REVIEWED]: (entry) => entry.neverReviewed || untriaged(entry),
    [GROUPS.BLOCKED_ON_REPORTER]: (entry) => classifyTriage(entry.triage) === 'reporter',
  };

  /**
   * Choose the first matching group in the advisory state's priority order.
   *
   * @param {OrderEntry} entry
   * @returns {string} one of {@link GROUPS}.
   */
  function groupOf(entry) {
    const groups = groupsFor(stateOf(entry));
    const found = groups.find((group) => MEMBER_OF[group]?.(entry) === true);
    return found ?? GROUPS.BLOCKED_ON_REPORTER;
  }

  /**
   * @param {OrderEntry} entry
   * @returns {number} The group's index in the state's priority list, or the list
   *   length if the group is absent.
   */
  function groupRank(entry) {
    const groups = groupsFor(stateOf(entry));
    const rank = groups.indexOf(groupOf(entry));
    return rank === -1 ? groups.length : rank;
  }

  /**
   * The chip uses evidence of maintainer review. The never-reviewed sort group
   * also includes advisories without stored triage. A reviewed advisory without
   * stored triage can therefore show blocked on us while sorting as never reviewed.
   *
   * @param {WaitingEntry} entry
   * @returns {string}
   */
  function waitingStateOf(entry) {
    if (entry.neverReviewed) return GROUPS.NEVER_REVIEWED;
    if (entry.newActivity) return GROUPS.NEW_ACTIVITY;
    return classifyTriage(entry.triage) === 'reporter'
      ? GROUPS.BLOCKED_ON_REPORTER
      : GROUPS.BLOCKED_ON_US;
  }

  /**
   * @param {OrderEntry} entry
   * @returns {number} The confirmed severity rank, or zero if unconfirmed.
   */
  function confirmedRank(entry) {
    return entry.severityConfirmed ? severityRank(entry.severity) : 0;
  }

  /**
   * @param {OrderEntry} entry
   * @returns {number} The unconfirmed severity rank, or zero if confirmed.
   */
  function unconfirmedRank(entry) {
    return entry.severityConfirmed ? 0 : severityRank(entry.severity);
  }

  /**
   * @param {OrderEntry} entry
   * @returns {number | null} The waiting start time in epoch milliseconds,
   *   or null if unreadable.
   */
  function waitingAt(entry) {
    return globalThis.bghsa.text.instantOf(entry.waitingSince);
  }

  /**
   * Sort text lexicographically, with null values last.
   *
   * @param {string | null} left
   * @param {string | null} right
   * @returns {number}
   */
  function compareText(left, right) {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  /**
   * Sort numbers in ascending order, with null values last.
   *
   * @param {number | null} left
   * @param {number | null} right
   * @returns {number}
   */
  function compareNumber(left, right) {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return left - right;
  }

  /**
   * @param {OrderEntry} a
   * @param {OrderEntry} b
   * @returns {number}
   */
  function byWaiting(a, b) {
    return compareNumber(waitingAt(a), waitingAt(b));
  }

  /**
   * Use the advisory ID as the final tie-breaker, with missing IDs last.
   *
   * @param {OrderEntry} a
   * @param {OrderEntry} b
   * @returns {number}
   */
  function byId(a, b) {
    return compareText(a.ghsaId, b.ghsaId);
  }

  /**
   * Sort drafts before triage, then by each state's group priority. Within a
   * group, sort by confirmed severity, unconfirmed severity, waiting time, and
   * identifier (REQUIREMENTS.md section 9).
   *
   * @param {OrderEntry} a
   * @param {OrderEntry} b
   * @returns {number}
   */
  function compare(a, b) {
    const draft = Number(stateOf(b) === 'draft') - Number(stateOf(a) === 'draft');
    if (draft !== 0) return draft;

    const group = groupRank(a) - groupRank(b);
    if (group !== 0) return group;

    const confirmed = confirmedRank(b) - confirmedRank(a);
    if (confirmed !== 0) return confirmed;

    const unconfirmed = unconfirmedRank(b) - unconfirmedRank(a);
    if (unconfirmed !== 0) return unconfirmed;

    const waiting = byWaiting(a, b);
    if (waiting !== 0) return waiting;

    return byId(a, b);
  }

  /**
   * @template {OrderEntry} T
   * @param {readonly T[]} entries
   * @returns {T[]} A copy of `entries` sorted in the default order.
   */
  function sort(entries) {
    return entries.slice().sort(compare);
  }

  const exported = {
    GROUPS,
    WAITING_STATES,
    severityRank,
    classifyTriage,
    blockedOnUs,
    stateOf,
    groupsFor,
    groupOf,
    groupRank,
    waitingStateOf,
    compareText,
    compareNumber,
    compare,
    sort,
  };

  globalThis.bghsa.order = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
