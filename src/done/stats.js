'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/text.js');
  require('../common/trust.js');
  require('../common/derive.js');
  require('../common/merge.js');
  require('../common/parse-list.js');
  require('../detail/tracking.js');
  require('../detail/preserve.js');
  require('./corpus.js');
}

/**
 * Report counts with their sample sizes. `counted` includes supplied values;
 * `missing` counts absent values within `corpus`. `unread` identifies advisories
 * without a detail read and may include members excluded from a partial tally.
 *
 * @typedef {object} Tally
 * @property {Record<string, number>} counts Counts keyed by value.
 * @property {Record<string, number>} ratios Each count divided by counted.
 * @property {number} counted
 * @property {number} missing
 * @property {number} corpus The number of members in this sample.
 * @property {number} unread The number of members without detail data.
 */

/**
 * Measure durations in milliseconds. Missing events are omitted from the
 * sample (REQUIREMENTS.md section 10).
 *
 * @typedef {object} Timing
 * @property {number[]} values Durations sorted ascending.
 * @property {number} counted
 * @property {number} omitted
 * @property {number} corpus The number of members in this sample.
 * @property {number} unread The number of members without detail data.
 * @property {number | null} min
 * @property {number | null} median
 * @property {number | null} mean
 * @property {number | null} max
 */

/**
 * @typedef {object} Summary
 * @property {number} corpus The number of members in this sample.
 * @property {number} unread The number of members without detail data.
 * @property {boolean} complete Whether every selected state crawl reached its last page.
 * @property {Record<string, number | null>} expected Counts from GitHub's state tabs.
 * @property {Record<string, Tally>} counts Tallies by outcome, reason, open state,
 *   severity, and month. The outcome tally covers published and closed advisories; the
 *   reason tally covers read closed advisories; the open tally covers triage and draft
 *   advisories; the severity tally covers published advisories and drafts whose scoring
 *   a maintainer confirmed.
 * @property {Record<string, Timing>} timings Timings keyed by TIMINGS entries.
 * @property {Record<string, string>} uncomputed Unavailable metrics and their reasons.
 */

(() => {
  /**
   * Match acceptance after derive.eventIs removes the actor and excludes
   * reporter-controlled phrases. Matching from the phrase start prevents title
   * changes containing this text from setting the acceptance time. Advisories
   * created as drafts may lack an acceptance event.
   */
  const DRAFT_EVENT = /^accepted this report\b/;

  const PUBLISHED_STATE = 'published';

  const CLOSED_STATE = 'closed';

  const DRAFT_STATE = 'draft';

  const OPEN_STATES = globalThis.bghsa.parseList.OPEN_STATES;

  /**
   * Match the close phrase after actor removal. Closure reasons are stored
   * separately in the extension's state comments.
   */
  const CLOSE_EVENT = /^closed this\b/;

  /**
   * Match maintainer publication. GitHub's later `released this` event marks
   * release to the global advisory database.
   */
  const PUBLISH_EVENT = /^published this\b/;

  /**
   * Each timing names its missing-event condition for display beside the sample
   * size.
   *
   * @type {readonly { key: string, name: string, omission: string }[]}
   */
  const TIMINGS = [
    { key: 'firstResponse', name: 'Time to first response', omission: 'No response' },
    { key: 'accept', name: 'Time to accept', omission: 'Never accepted' },
    { key: 'close', name: 'Time to close', omission: 'Never closed' },
    { key: 'publish', name: 'Time to publish', omission: 'Never published' },
  ];

  /**
   * List unavailable metrics and their reasons. All four required timings are
   * currently supported.
   *
   * @type {Readonly<Record<string, string>>}
   */
  const UNCOMPUTED = {};

  /**
   * Closure-reason reads do not evaluate confirmations.
   */
  const NO_FINGERPRINTS = { title: null, description: null, scoring: null };

  const instantOf = globalThis.bghsa.text.instantOf;

  /**
   * @param {string | null | undefined} at
   * @returns {string | null} The UTC month as YYYY-MM, or null for an invalid timestamp.
   */
  function monthOf(at) {
    const parsed = instantOf(at);
    return parsed === null ? null : new Date(parsed).toISOString().slice(0, 7);
  }

  /**
   * Read closure reasons from state comments. Count unknown stored values as
   * written.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {string | null}
   */
  function closureReasonOf(advisory) {
    const merged = globalThis.bghsa.merge.mergeSnapshots(advisory.comments);
    return globalThis.bghsa.tracking.read(merged.state, NO_FINGERPRINTS).closureReason;
  }

  /**
   * A draft's severity counts once a maintainer confirmed its current scoring,
   * the confirmation the open table shows on its severity chip.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {Promise<boolean>}
   */
  async function scoringConfirmed(advisory) {
    const merged = globalThis.bghsa.merge.mergeSnapshots(advisory.comments);
    const tracking = await globalThis.bghsa.tracking.readAdvisory(advisory, merged);
    return tracking.scoring.status === 'confirmed';
  }

  /**
   * Measure first response from the earliest trusted member comment, excluding
   * state and preservation comments. Membership comes from the comment's role
   * badge. Email and activity without a qualifying comment are outside this
   * measurement (REQUIREMENTS.md section 10).
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {number | null} The first qualifying comment timestamp, or null if unavailable.
   */
  function firstResponseAt(advisory) {
    /** @type {number | null} */
    let earliest = null;
    for (const comment of advisory.comments) {
      if (!globalThis.bghsa.trust.isTrustedAuthor(comment.author, comment.role)) continue;
      if (comment.stateComment !== null) continue;
      if (globalThis.bghsa.preserve.preservationComment([comment]) !== null) continue;
      const at = instantOf(comment.at);
      if (at === null) continue;
      if (earliest === null || at < earliest) earliest = at;
    }
    return earliest;
  }

  /**
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {RegExp} phrase A timeline phrase matched through derive.eventIs.
   * @returns {number | null} The earliest valid matching timestamp, or null.
   */
  function earliestEvent(advisory, phrase) {
    /** @type {number | null} */
    let earliest = null;
    for (const event of advisory.timeline) {
      if (!globalThis.bghsa.derive.eventIs(event, phrase)) continue;
      const at = instantOf(event.at);
      if (at === null) continue;
      if (earliest === null || at < earliest) earliest = at;
    }
    return earliest;
  }

  /**
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {RegExp} phrase A timeline phrase matched through derive.eventIs.
   * @returns {number | null} The latest valid matching timestamp, or null.
   */
  function latestEvent(advisory, phrase) {
    /** @type {number | null} */
    let latest = null;
    for (const event of advisory.timeline) {
      if (!globalThis.bghsa.derive.eventIs(event, phrase)) continue;
      const at = instantOf(event.at);
      if (at === null) continue;
      if (latest === null || at > latest) latest = at;
    }
    return latest;
  }

  /**
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {number | null} The event timestamp, or null if unavailable.
   */
  function draftAt(advisory) {
    return earliestEvent(advisory, DRAFT_EVENT);
  }

  /**
   * Measure time to close using the first closure, including reopened advisories.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {number | null} The event timestamp, or null if unavailable.
   */
  function closeAt(advisory) {
    return earliestEvent(advisory, CLOSE_EVENT);
  }

  /**
   * Measure time to publish using the first publication.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {number | null} The event timestamp, or null if unavailable.
   */
  function publishAt(advisory) {
    return earliestEvent(advisory, PUBLISH_EVENT);
  }

  /**
   * Display the latest closure as the end date. Statistics use the first
   * closure from {@link closeAt}.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {number | null} The event timestamp, or null if unavailable.
   */
  function lastCloseAt(advisory) {
    return latestEvent(advisory, CLOSE_EVENT);
  }

  /**
   * Display the latest publication as the end date. Statistics use the first
   * publication from {@link publishAt}.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {number | null} The event timestamp, or null if unavailable.
   */
  function lastPublishAt(advisory) {
    return latestEvent(advisory, PUBLISH_EVENT);
  }

  /**
   * @param {import('../common/parse-detail.js').ParsedDetail | null} advisory
   * @param {(advisory: import('../common/parse-detail.js').ParsedDetail) => number | null} event
   * @returns {number | null} Milliseconds from report to event, or null for missing,
   *   invalid, or reversed timestamps.
   */
  function durationOf(advisory, event) {
    if (advisory === null) return null;
    const from = instantOf(advisory.reportedAt);
    if (from === null) return null;
    const to = event(advisory);
    if (to === null || to < from) return null;
    return to - from;
  }

  /**
   * @param {readonly (string | null)[]} values One value per corpus member, or null if missing.
   * @param {{ corpus: number, unread: number }} over
   * @returns {Tally} Counts stored in a prototype-free object to handle stored values such
   *   as __proto__ as ordinary keys.
   */
  function tally(values, over) {
    /** @type {Record<string, number>} */
    const counts = Object.create(null);
    let counted = 0;
    for (const value of values) {
      if (value === null) continue;
      counts[value] = (counts[value] ?? 0) + 1;
      counted += 1;
    }
    /** @type {Record<string, number>} */
    const ratios = Object.create(null);
    for (const [value, count] of Object.entries(counts)) ratios[value] = count / counted;
    return {
      counts,
      ratios,
      counted,
      missing: over.corpus - counted,
      corpus: over.corpus,
      unread: over.unread,
    };
  }

  /**
   * @param {readonly (number | null)[]} values One duration per corpus member, or null if
   *   unavailable.
   * @param {{ corpus: number, unread: number }} over
   * @returns {Timing}
   */
  function timing(values, over) {
    /** @type {number[]} */
    const held = [];
    for (const value of values) {
      if (value !== null) held.push(value);
    }
    held.sort((left, right) => left - right);
    const counted = held.length;
    const middle = Math.floor(counted / 2);
    const median =
      counted === 0
        ? null
        : counted % 2 === 1
          ? /** @type {number} */ (held[middle])
          : (/** @type {number} */ (held[middle - 1]) + /** @type {number} */ (held[middle])) / 2;
    return {
      values: held,
      counted,
      omitted: over.corpus - counted,
      corpus: over.corpus,
      unread: over.unread,
      min: counted === 0 ? null : /** @type {number} */ (held[0]),
      median,
      mean: counted === 0 ? null : held.reduce((sum, value) => sum + value, 0) / counted,
      max: counted === 0 ? null : /** @type {number} */ (held[counted - 1]),
    };
  }

  /**
   * Compute statistics from the collected corpus. State, severity, and month
   * fall back to list data; reasons and timings require detail reads.
   *
   * The outcome tally counts published and closed advisories from list data.
   * The reason tally counts closure reasons of read closed advisories; unread
   * closed advisories are outside its corpus and counted in its `unread`.
   * Open advisories are excluded from both tallies. The open tally counts
   * triage and draft advisories by state.
   *
   * The severity tally counts published advisories and drafts whose scoring a
   * maintainer confirmed. Unread drafts are outside its corpus and counted in
   * its `unread`.
   *
   * @param {import('./corpus.js').Corpus} held
   * @returns {Promise<Summary>}
   */
  async function summarize(held) {
    const over = { corpus: held.members.length, unread: held.unread.length };

    /** @type {(string | null)[]} */
    const outcomes = [];

    /** @type {(string | null)[]} */
    const reasons = [];

    let unreadReasons = 0;
    /** @type {(string | null)[]} */
    const opens = [];
    /** @type {(string | null)[]} */
    const severities = [];

    let unreadSeverities = 0;
    /** @type {(string | null)[]} */
    const months = [];
    /** @type {(number | null)[]} */
    const firstResponses = [];
    /** @type {(number | null)[]} */
    const drafts = [];
    /** @type {(number | null)[]} */
    const closes = [];
    /** @type {(number | null)[]} */
    const publishes = [];

    for (const member of held.members) {
      const advisory = member.advisory;
      const state = advisory?.state ?? member.row.state ?? member.state;
      const named = state === null ? null : state.toLowerCase();
      if (named !== null && OPEN_STATES.includes(named)) opens.push(named);
      if (named === PUBLISHED_STATE || named === CLOSED_STATE) outcomes.push(named);
      if (named === CLOSED_STATE) {
        if (advisory === null) unreadReasons += 1;
        else reasons.push(closureReasonOf(advisory));
      }
      if (named === PUBLISHED_STATE) severities.push(advisory?.severity ?? member.row.severity);
      if (named === DRAFT_STATE) {
        if (advisory === null) unreadSeverities += 1;
        else if (await scoringConfirmed(advisory)) {
          severities.push(advisory.severity ?? member.row.severity);
        }
      }
      months.push(monthOf(advisory?.reportedAt ?? member.row.openedAt));
      firstResponses.push(durationOf(advisory, firstResponseAt));
      drafts.push(durationOf(advisory, draftAt));
      closes.push(durationOf(advisory, closeAt));
      publishes.push(durationOf(advisory, publishAt));
    }

    return {
      corpus: over.corpus,
      unread: over.unread,
      complete: held.complete,
      expected: held.expected,
      counts: {
        // The outcome needs no detail read, so no member of it is unread.
        outcome: tally(outcomes, { corpus: outcomes.length, unread: 0 }),
        reason: tally(reasons, { corpus: reasons.length, unread: unreadReasons }),
        open: tally(opens, { corpus: opens.length, unread: 0 }),
        severity: tally(severities, { corpus: severities.length, unread: unreadSeverities }),
        month: tally(months, over),
      },
      timings: {
        firstResponse: timing(firstResponses, over),
        accept: timing(drafts, over),
        close: timing(closes, over),
        publish: timing(publishes, over),
      },
      uncomputed: { ...UNCOMPUTED },
    };
  }

  const exported = {
    DRAFT_EVENT,
    PUBLISHED_STATE,
    CLOSED_STATE,
    CLOSE_EVENT,
    PUBLISH_EVENT,
    TIMINGS,
    UNCOMPUTED,
    monthOf,
    NO_FINGERPRINTS,
    closureReasonOf,
    firstResponseAt,
    draftAt,
    closeAt,
    publishAt,
    lastCloseAt,
    lastPublishAt,
    durationOf,
    tally,
    timing,
    summarize,
  };

  globalThis.bghsa.stats = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
