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
 * @property {number} corpus The number of members in this sample.
 * @property {number} unread The number of members without detail data.
 * @property {number | null} min
 * @property {number | null} median
 * @property {number | null} mean
 * @property {number | null} max
 */

/**
 * A timing whose sample size is the read advisories. `counted` holds the
 * measured advisories. `read` counts the members with detail data. `waiting`
 * is the longest time in milliseconds since the report among the read
 * advisories still waiting for the event, or null when there is none or the
 * timing shows no wait.
 *
 * @typedef {Timing & { read: number, waiting: number | null }} ReadTiming
 */

/**
 * @typedef {'firstResponse' | 'accept' | 'close' | 'publish'} TimingKey
 */

/**
 * @typedef {object} Summary
 * @property {number} at The instant in milliseconds the summary is computed against.
 * @property {number} corpus The number of members in this sample.
 * @property {number} unread The number of members without detail data.
 * @property {boolean} complete Whether every selected state crawl reached its last page.
 * @property {Record<string, number | null>} expected Counts from GitHub's state tabs.
 * @property {Record<string, Tally>} counts Tallies by outcome, reason, open state,
 *   severity, report month, and publication month. The outcome tally covers published
 *   and closed advisories; the reason tally covers read closed advisories; the open
 *   tally covers triage and draft advisories; the severity tally covers published
 *   advisories and drafts whose scoring a maintainer confirmed; the publication-month
 *   tally covers published advisories, counting the read ones with a publication event
 *   in the UTC month of their first publication.
 * @property {Record<TimingKey, ReadTiming>} timings Timings keyed by TIMINGS
 *   entries. The close timing covers closed advisories and the publish timing
 *   published advisories.
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

  const TRIAGE_STATE = 'triage';

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
   * Each timing that shows a row beside its spread names that row.
   *
   * @type {readonly { key: TimingKey, name: string, omission?: string }[]}
   */
  const TIMINGS = [
    { key: 'firstResponse', name: 'Time to first response', omission: 'No response' },
    { key: 'accept', name: 'Time to accept', omission: 'Never accepted' },
    { key: 'close', name: 'Time to close' },
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
   * One year of report counts. `months` runs January to December; a month
   * after the end of the range holds null.
   *
   * @typedef {object} YearRow
   * @property {number} year
   * @property {(number | null)[]} months
   * @property {number} total
   */

  /**
   * Arrange a month tally into years, ascending. The range runs from the
   * year of the earliest month to its end, the later of the UTC month of `at`
   * and the latest month. Every month through the end holds its count, zero
   * when absent, so the totals sum to the tally.
   *
   * @param {Readonly<Record<string, number>>} counts Counts keyed by YYYY-MM.
   * @param {number} at The current instant in milliseconds.
   * @returns {YearRow[]} No rows when `counts` is empty.
   */
  function yearsOf(counts, at) {
    const keys = Object.keys(counts).sort();
    const earliest = keys[0];
    const latest = keys[keys.length - 1];
    if (earliest === undefined || latest === undefined) return [];
    const current = new Date(at).toISOString().slice(0, 7);
    const end = latest > current ? latest : current;
    const lastYear = Number(end.slice(0, 4));
    const lastMonth = Number(end.slice(5, 7)) - 1;
    /** @type {YearRow[]} */
    const rows = [];
    for (let year = Number(earliest.slice(0, 4)); year <= lastYear; year += 1) {
      /** @type {(number | null)[]} */
      const months = [];
      let total = 0;
      for (let month = 0; month < 12; month += 1) {
        if (year === lastYear && month > lastMonth) {
          months.push(null);
          continue;
        }
        const count = counts[`${year}-${String(month + 1).padStart(2, '0')}`] ?? 0;
        months.push(count);
        total += count;
      }
      rows.push({ year, months, total });
    }
    return rows;
  }

  /**
   * Sum a table of years down its columns. A blank month adds nothing.
   *
   * @param {readonly YearRow[]} rows
   * @returns {{ months: number[], total: number }} Twelve month sums, January
   *   first, and the sum of every row's total.
   */
  function monthTotalsOf(rows) {
    const months = Array(12).fill(0);
    let total = 0;
    for (const row of rows) {
      row.months.forEach((count, month) => {
        months[month] += count ?? 0;
      });
      total += row.total;
    }
    return { months, total };
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
   * Measure first response to the earlier of the earliest trusted member
   * comment, excluding state and preservation comments, and the earliest
   * timeline event only a maintainer can cause (derive.maintainerOnlyEvent).
   * Membership comes from the comment's role badge. Email is outside this
   * measurement (REQUIREMENTS.md section 10).
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {number | null} The first qualifying timestamp, or null if unavailable.
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
    for (const event of advisory.timeline) {
      if (!globalThis.bghsa.derive.maintainerOnlyEvent(event)) continue;
      const at = instantOf(event.at);
      if (at === null) continue;
      if (earliest === null || at < earliest) earliest = at;
    }
    return earliest;
  }

  /**
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {number} at The current instant in milliseconds.
   * @returns {number | null} Milliseconds from report to `at`, or null when the
   *   report time is missing, invalid, or after `at`.
   */
  function sinceReport(advisory, at) {
    const from = instantOf(advisory.reportedAt);
    if (from === null || from > at) return null;
    return at - from;
  }

  /**
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {number} at The current instant in milliseconds.
   * @returns {number | null} Milliseconds from report to `at` for an advisory
   *   without a response, or null when it has one or its report time is
   *   missing, invalid, or after `at`.
   */
  function waitOf(advisory, at) {
    if (firstResponseAt(advisory) !== null) return null;
    return sinceReport(advisory, at);
  }

  /**
   * @param {number | null} longest
   * @param {number | null} wait
   * @returns {number | null} The longer of the two, where null is none.
   */
  function longer(longest, wait) {
    if (wait === null) return longest;
    return longest === null || wait > longest ? wait : longest;
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
   * The publication-month tally covers published advisories and counts each
   * read one in the UTC month of its first publication event, the event the
   * publish timing measures to. A published advisory unread or without that
   * event is missing from the tally.
   *
   * The first-response and acceptance timings count read advisories. The
   * first-response timing holds the longest wait, to `at`, of read open
   * advisories without a response; the acceptance timing holds the longest
   * wait of read triage advisories without an acceptance event. The close
   * timing counts closed advisories and measures the read ones. The publish
   * timing counts published advisories, measures the read ones, and holds the
   * longest wait of read drafts.
   *
   * @param {import('./corpus.js').Corpus} held
   * @param {number} at The current instant in milliseconds.
   * @returns {Promise<Summary>}
   */
  async function summarize(held, at) {
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
    /** @type {(string | null)[]} */
    const publishedMonths = [];
    /** @type {(number | null)[]} */
    const firstResponses = [];
    let read = 0;
    /** @type {number | null} */
    let waiting = null;
    /** @type {number | null} */
    let acceptWaiting = null;
    /** @type {(number | null)[]} */
    const drafts = [];
    /** @type {(number | null)[]} */
    const closes = [];
    let closedRead = 0;
    /** @type {(number | null)[]} */
    const publishes = [];
    let publishedRead = 0;
    let publishedUnread = 0;
    /** @type {number | null} */
    let publishWaiting = null;

    for (const member of held.members) {
      const advisory = member.advisory;
      const state = advisory?.state ?? member.row.state ?? member.state;
      const named = state === null ? null : state.toLowerCase();
      if (named !== null && OPEN_STATES.includes(named)) {
        opens.push(named);
        if (advisory !== null) waiting = longer(waiting, waitOf(advisory, at));
      }
      if (named === TRIAGE_STATE && advisory !== null && draftAt(advisory) === null) {
        acceptWaiting = longer(acceptWaiting, sinceReport(advisory, at));
      }
      if (advisory !== null) read += 1;
      if (named === PUBLISHED_STATE || named === CLOSED_STATE) outcomes.push(named);
      if (named === CLOSED_STATE) {
        if (advisory === null) unreadReasons += 1;
        else {
          reasons.push(closureReasonOf(advisory));
          closedRead += 1;
        }
        closes.push(durationOf(advisory, closeAt));
      }
      if (named === PUBLISHED_STATE) {
        severities.push(advisory?.severity ?? member.row.severity);
        if (advisory === null) publishedUnread += 1;
        else publishedRead += 1;
        publishes.push(durationOf(advisory, publishAt));
        const published = advisory === null ? null : publishAt(advisory);
        publishedMonths.push(
          published === null ? null : new Date(published).toISOString().slice(0, 7)
        );
      }
      if (named === DRAFT_STATE && advisory !== null) {
        publishWaiting = longer(publishWaiting, sinceReport(advisory, at));
      }
      if (named === DRAFT_STATE) {
        if (advisory === null) unreadSeverities += 1;
        else if (await scoringConfirmed(advisory)) {
          severities.push(advisory.severity ?? member.row.severity);
        }
      }
      months.push(monthOf(advisory?.reportedAt ?? member.row.openedAt));
      firstResponses.push(durationOf(advisory, firstResponseAt));
      drafts.push(durationOf(advisory, draftAt));
    }

    /** @type {ReadTiming} */
    const response = { ...timing(firstResponses, over), read, waiting };
    /** @type {ReadTiming} */
    const accept = { ...timing(drafts, over), read, waiting: acceptWaiting };
    /** @type {ReadTiming} */
    const close = {
      ...timing(closes, { corpus: closes.length, unread: unreadReasons }),
      read: closedRead,
      waiting: null,
    };
    /** @type {ReadTiming} */
    const publish = {
      ...timing(publishes, { corpus: publishes.length, unread: publishedUnread }),
      read: publishedRead,
      waiting: publishWaiting,
    };

    return {
      at,
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
        publishedMonth: tally(publishedMonths, {
          corpus: publishedMonths.length,
          unread: publishedUnread,
        }),
      },
      timings: {
        firstResponse: response,
        accept,
        close,
        publish,
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
    yearsOf,
    monthTotalsOf,
    NO_FINGERPRINTS,
    closureReasonOf,
    scoringConfirmed,
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
