'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/text.js');
  require('../common/trust.js');
  require('../common/derive.js');
  require('../common/merge.js');
  require('../detail/tracking.js');
  require('../detail/preserve.js');
  require('./corpus.js');
}

/**
 * One count over the corpus, and what it is over.
 *
 * The three numbers beside the counts are what stops a partial count reading as
 * a whole one. `counted` is the members that carried a value, `missing` the
 * members that carried none, and `corpus` every member the crawl found.
 * `unread` says how many of the missing are advisories no read backs, which is
 * the difference between a value nobody set and a value nobody has looked up.
 *
 * @typedef {object} Tally
 * @property {Record<string, number>} counts By value, in no particular order.
 * @property {Record<string, number>} ratios Each count over `counted`.
 * @property {number} counted
 * @property {number} missing
 * @property {number} corpus
 * @property {number} unread
 */

/**
 * One timing over the corpus, in milliseconds.
 *
 * REQUIREMENTS.md section 10: a metric is omitted when the event it needs is
 * not observable, and it is not estimated. `omitted` counts the members that
 * contributed nothing, and none of them is in `values` as a zero.
 *
 * @typedef {object} Timing
 * @property {number[]} values Ascending.
 * @property {number} counted
 * @property {number} omitted
 * @property {number} corpus
 * @property {number} unread
 * @property {number | null} min
 * @property {number | null} median
 * @property {number | null} mean
 * @property {number | null} max
 */

/**
 * @typedef {object} Summary
 * @property {number} corpus How many advisories the counts are over.
 * @property {number} unread How many of them no advisory read backs.
 * @property {boolean} complete Whether the crawl reached the last page of both
 *   states. A summary over an incomplete crawl is over the advisories named
 *   here and not over the repository.
 * @property {Record<string, number | null>} expected What GitHub's own state
 *   tabs counted.
 * @property {Record<string, Tally>} counts By `reason`, `state`, `severity`,
 *   and `month`.
 * @property {Record<string, Timing>} timings By the keys in {@link TIMINGS}.
 * @property {Record<string, string>} uncomputed The section 10 timings this
 *   reader does not compute, each naming why. A caller displays these as
 *   unavailable; it does not display them as zero.
 */

(() => {
  /**
   * What a timeline event reads when a maintainer accepts a report, which is
   * what moves it out of triage and into draft.
   *
   * The wording is the event text an advisory page carries, and it is the whole
   * signal: an advisory a maintainer opened as a draft was never a report and
   * carries no such event, and neither does one whose page words it another
   * way. Either way the metric is omitted for that advisory.
   *
   * Every one of the three patterns here is a phrase pattern, read through
   * `derive.eventIs`, which matches it against the event's wording with the
   * actor taken off the front and refuses the phrases a reporter can cause.
   * Two things ride on that. An advisory page carries `accepted credit` as
   * well, which is a reporter accepting the credit they were given and is not a
   * state change. And the advisory's title is the reporter's text, repeated
   * into the timeline by a `changed the title` event, so a pattern matching
   * anywhere in the event text would let a title reading `accepted this report`
   * set the instant every timing here is measured to.
   */
  const DRAFT_EVENT = /^accepted this report\b/;

  /**
   * What a timeline event reads when an advisory is closed.
   *
   * A maintainer closes an advisory through the comment box, so the page words
   * a close one way, and REQUIREMENTS.md section 1 records that closing an
   * advisory stores no reason, so there is no wording that names why.
   *
   * It is read the way {@link DRAFT_EVENT} is. A timeline carries other events
   * opening with the same verb, and a match on the verb alone would take
   * whichever came first and read the wrong instant.
   */
  const CLOSE_EVENT = /^closed this\b/;

  /**
   * What a timeline event reads when an advisory is published.
   *
   * Closing and publishing are two different endings, and REQUIREMENTS.md
   * section 10 measures to each of them separately. A published advisory is one
   * a maintainer released to the world; a closed one is one nobody is going to.
   *
   * It is read the way {@link DRAFT_EVENT} is. The same timeline carries
   * `released this` from GitHub the day after the publication, which is the
   * advisory reaching the global database and not a maintainer publishing it.
   */
  const PUBLISH_EVENT = /^published this\b/;

  /**
   * The timings this reader computes, what each is measured between, and what
   * an advisory it could not measure is called.
   *
   * `omission` is the reason the metric is absent, which the reader is owed
   * beside the count of how many it is absent for. Every omission is one thing:
   * the event the timing needs never happened on the page.
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
   * The section 10 timings this reader does not compute, each naming why.
   *
   * All four of section 10's timings are read from the page, so this is empty.
   * A timing whose event stops being observable is named here with its reason,
   * and section 10 leaves it out of the statistics rather than estimating it.
   *
   * @type {Readonly<Record<string, string>>}
   */
  const UNCOMPUTED = {};

  /** The fingerprints a track read needs, where no value is being judged. */
  const NO_FINGERPRINTS = { title: null, description: null, scoring: null };

  /** How every reader here reads a stamp as an instant. */
  const instantOf = globalThis.bghsa.text.instantOf;

  /**
   * @param {string | null | undefined} at
   * @returns {string | null} the month that instant falls in, as `YYYY-MM` in
   *   UTC. One zone is picked and named so that two advisories an hour apart do
   *   not land in different months depending on who is looking.
   */
  function monthOf(at) {
    const parsed = instantOf(at);
    return parsed === null ? null : new Date(parsed).toISOString().slice(0, 7);
  }

  /**
   * The closure reason a maintainer stored on one advisory.
   *
   * It is a stored track, so it comes from the state comments on the advisory
   * and not from GitHub: GitHub's own close carries no reason. A value this
   * reader does not interpret is counted as it stands, because that is how
   * every other surface displays one.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {string | null}
   */
  function closureReasonOf(advisory) {
    const merged = globalThis.bghsa.merge.mergeSnapshots(advisory.comments);
    return globalThis.bghsa.tracking.read(merged.state, NO_FINGERPRINTS).closureReason;
  }

  /**
   * When an organization member first answered the reporter.
   *
   * REQUIREMENTS.md section 10 measures to the first comment by an org member
   * that this extension did not write. Both comment types it writes are passed
   * over, even where one is the only comment a member left: a state comment is
   * the extension writing to itself, and a preserved original report is the
   * reporter's own text copied back onto the thread. Neither is a maintainer
   * answering a reporter.
   *
   * Two things this does not see, both of them section 10's own terms. First
   * contact by email is not on the page and is not counted. And membership is
   * the role badge GitHub renders on a comment, the one member signal an
   * advisory page carries, so a member who acted on the advisory without ever
   * commenting is invisible here exactly as they are to `derive.js`. Such an
   * advisory contributes no first response.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {number | null} the instant, and null where no such comment is on
   *   the page.
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
   * @param {RegExp} phrase Which timeline event is being looked for, read the
   *   way {@link DRAFT_EVENT} is.
   * @returns {number | null} when that event first happened, and null where the
   *   timeline records it no time this reader can read.
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
   * When the advisory entered draft, which is when a maintainer accepted the
   * report.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {number | null} the instant, and null where the timeline records
   *   no acceptance.
   */
  function draftAt(advisory) {
    return earliestEvent(advisory, DRAFT_EVENT);
  }

  /**
   * When the advisory was closed.
   *
   * The earliest close is the one taken, the same as the earliest acceptance
   * is: an advisory closed, reopened, and closed again is measured to the close
   * that first resolved it.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {number | null} the instant, and null where the timeline records
   *   no close. An advisory nothing closed contributes to no timing, and not a
   *   duration of zero.
   */
  function closeAt(advisory) {
    return earliestEvent(advisory, CLOSE_EVENT);
  }

  /**
   * When the advisory was published.
   *
   * The earliest publication is the one taken, the same as the earliest close
   * is.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {number | null} the instant, and null where the timeline records no
   *   publication. An advisory nobody published contributes to no timing, and
   *   not a duration of zero.
   */
  function publishAt(advisory) {
    return earliestEvent(advisory, PUBLISH_EVENT);
  }

  /**
   * @param {import('../common/parse-detail.js').ParsedDetail | null} advisory
   * @param {(advisory: import('../common/parse-detail.js').ParsedDetail) => number | null} event
   * @returns {number | null} how long after the report that event happened, and
   *   null where either end is missing. An event the page stamps before the
   *   report leaves the two stamps disagreeing about the order they happened
   *   in, and no duration is read from them.
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
   * @param {readonly (string | null)[]} values One value per corpus member, and
   *   null for a member carrying none.
   * @param {{ corpus: number, unread: number }} over
   * @returns {Tally} the counts, held on an object with no prototype. A closure
   *   reason is a stored value, and one reading `__proto__` would otherwise set
   *   the object's prototype and be counted nowhere.
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
   * @param {readonly (number | null)[]} values One duration per corpus member,
   *   and null for a member the event was not observable on.
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
   * The counts, the ratios, and the timings of REQUIREMENTS.md section 10, over
   * one corpus. Every one of them is computed here, in the page, from what the
   * crawl and the reads already hold. Nothing is sent anywhere.
   *
   * The state, the severity, and the month of a member come from its advisory
   * read where one backs it and from the list row otherwise, because the list
   * page carries all three. The closure reason and the timings need the read.
   *
   * @param {import('./corpus.js').Corpus} held
   * @returns {Summary}
   */
  function summarize(held) {
    const over = { corpus: held.members.length, unread: held.unread.length };

    /** @type {(string | null)[]} */
    const reasons = [];
    /** @type {(string | null)[]} */
    const states = [];
    /** @type {(string | null)[]} */
    const severities = [];
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
      reasons.push(advisory === null ? null : closureReasonOf(advisory));
      const state = advisory?.state ?? member.row.state ?? member.state;
      states.push(state === null ? null : state.toLowerCase());
      severities.push(advisory?.severity ?? member.row.severity);
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
        reason: tally(reasons, over),
        state: tally(states, over),
        severity: tally(severities, over),
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
