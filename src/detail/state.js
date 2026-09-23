'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/allowlist.js');
  require('../common/schema.js');
  require('../common/merge.js');
  require('../common/parse-detail.js');
  require('../common/derive.js');
  require('../common/write.js');
  require('../common/members.js');
  require('../common/cache.js');
}

/**
 * @typedef {import('../common/parse-detail.js').ParsedDetail} ParsedDetail
 * @typedef {import('../common/parse-detail.js').ParsedComment} ParsedComment
 * @typedef {import('../common/parse-detail.js').AdvisoryRef} AdvisoryRef
 * @typedef {import('../common/merge.js').MergedState} MergedState
 * @typedef {import('../common/write.js').WriteResult} WriteResult
 * @typedef {import('../common/write.js').WriteFetch} WriteFetch
 */

/**
 * @typedef {object} StateWriteResult
 * @property {import('../common/write.js').WriteDiagnostic} [diagnostic]
 * @property {boolean} ok
 * @property {string | null} reason The failure reason from validation, the caller's guard,
 *   or the comment request. Null on success.
 * @property {number | null} status
 * @property {string} message The displayed result message.
 * @property {Record<string, unknown> | null} snapshot The written snapshot, or null on
 *   failure.
 * @property {MergedState | null} merged State from the fetched page, or null before a
 *   successful read. Refusals return it for the panel to refresh.
 * @property {ParsedDetail | null} advisory The fetched page, updated with a confirmed
 *   write. Refusals before sending return the unchanged page. Null before a successful read
 *   or after an unconfirmed request.
 * @property {number | null} readAt The fetch time in epoch milliseconds. All returned data
 *   except the written comment was observed then.
 */

/**
 * @typedef {(envelope: { by: string, at: string }) => Record<string, unknown>} ChangesBuilder
 */

/**
 * A snapshot is identified by its comment and author. A newly written comment
 * has an unknown ID until the next page read; its author identifies it meanwhile.
 *
 * @typedef {object} SnapshotHolder
 * @property {string | null} commentId
 * @property {string | null} by
 */

/**
 * @typedef {object} StateWriteOptions
 * @property {AdvisoryRef} ref The advisory identified by the page.
 * @property {number} loadedSeq The sequence number loaded by the panel. A different fetched
 *   sequence prevents the write.
 * @property {SnapshotHolder} [loadedHolder] The loaded snapshot identity. A different
 *   holder prevents writes even when the sequence numbers match.
 * @property {Record<string, unknown> | ChangesBuilder} changes Snapshot field changes. Null
 *   removes a field; omitted fields are preserved, including unknown fields. A builder
 *   receives the write login and timestamp.
 * @property {boolean} [confirmed] Approval to supersede an unreadable snapshot.
 * @property {(state: Record<string, unknown> | null, changes: Record<string,
 *   unknown>) => { reason: string, message: string } | null} [guard] Checks changes
 *   against freshly fetched state. A returned objection prevents the write
 *   and supplies the displayed reason.
 * @property {string} [at] The explicit write time; defaults to the current time.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 * @property {() => void} [beforeSend] Called after building the comment request and before
 *   sending it.
 */

(() => {

  const IN_FLIGHT_MESSAGE = globalThis.bghsa.write.SAVING_MESSAGE;

  /**
   * Serialize writes per advisory to prevent concurrent saves from choosing the
   * same sequence number.
   *
   * @type {Set<string>}
   */
  const inFlight = new Set();

  /**
   * @param {string | null | undefined} left
   * @param {string | null | undefined} right
   * @returns {boolean} Whether the logins match case-insensitively.
   */
  function sameLogin(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    return left.toLowerCase() === right.toLowerCase();
  }

  /**
   * @param {MergedState} merged
   * @returns {SnapshotHolder} The source snapshot's identity.
   */
  function holderOf(merged) {
    const by = merged.state === null ? undefined : merged.state['by'];
    // Newly created comments have an unknown ID until the next page read.
    const commentId = merged.source?.id ?? '';
    return {
      commentId: commentId === '' ? null : commentId,
      by: merged.source?.author ?? (typeof by === 'string' ? by : null),
    };
  }

  /**
   * Compare comment IDs when both are known. Otherwise compare authors to
   * identify a locally saved snapshot before its comment ID is available.
   *
   * @param {SnapshotHolder} left
   * @param {SnapshotHolder} right
   * @returns {boolean}
   */
  function sameHolder(left, right) {
    if (left.commentId !== null && right.commentId !== null) {
      return left.commentId === right.commentId;
    }
    if (left.by === null || right.by === null) return left.by === right.by;
    return sameLogin(left.by, right.by);
  }

  /**
   * Indent JSON to prevent its contents from closing the Markdown fence.
   *
   * @param {Record<string, unknown>} snapshot
   * @returns {string}
   */
  function snapshotJson(snapshot) {
    return JSON.stringify(snapshot, null, 2);
  }

  /**
   * Build the collapsed state block described in REQUIREMENTS.md section 3.
   * The marker outside the JSON fence identifies the comment even if its payload
   * is invalid. The fence prevents snapshot values from rendering as markup.
   *
   * @param {Record<string, unknown>} snapshot
   * @returns {string}
   */
  function buildBody(snapshot) {
    const schema = globalThis.bghsa.schema;
    return globalThis.bghsa.write.detailsBody(
      schema.STATE_COMMENT_SUMMARY,
      schema.STATE_COMMENT_MARKER,
      ['```json', snapshotJson(snapshot), '```']
    );
  }

  /**
   * Each maintainer may write only their own state comment.
   *
   * @param {readonly ParsedComment[]} comments
   * @param {string} login
   * @returns {ParsedComment[]}
   */
  function ownStateComments(comments, login) {
    return comments.filter(
      (comment) => comment.stateComment !== null && sameLogin(comment.author, login)
    );
  }

  /**
   * @returns {string} The write time, to the second.
   */
  function nowStamp() {
    return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  }

  /**
   * The first triage value measures waiting time from the latest member activity,
   * falling back to the report time.
   *
   * @param {ParsedDetail} advisory The freshly fetched advisory.
   * @returns {string | null}
   */
  function seedTriageSince(advisory) {
    return globalThis.bghsa.derive.derive(advisory).lastMemberActivityAt ?? advisory.reportedAt;
  }

  /**
   * Record when the triage value changes. Its first value uses `seed`, falling
   * back to the write time. Removing triage also removes `triageSince`.
   * An explicit `triageSince` change overrides this calculation.
   *
   * @param {Record<string, unknown>} snapshot
   * @param {Record<string, unknown> | null} current
   * @param {Record<string, unknown>} changes
   * @param {string} at
   * @param {string | null} seed The initial triage time, or null if unavailable.
   * @returns {void}
   */
  function stampTriageSince(snapshot, current, changes, at, seed) {
    if (Object.hasOwn(changes, 'triageSince')) return;
    const before = current === null ? undefined : current['triage'];
    if (snapshot['triage'] === before) return;
    if (snapshot['triage'] === undefined) {
      delete snapshot['triageSince'];
      return;
    }
    snapshot['triageSince'] = before === undefined ? (seed ?? at) : at;
  }

  /**
   * @param {string} reason
   * @param {string} message
   * @returns {WriteResult} The refusal result.
   */
  function stopped(reason, message) {
    return { ok: false, reason, status: null, message };
  }

  /**
   * @param {string | null} reason
   * @param {number | null} status
   * @param {string} message
   * @param {MergedState | null} merged
   * @param {{ advisory: ParsedDetail, readAt: number } | null} read The fetched page and
   *   timestamp for a refusal before sending, or null if unavailable.
   * @returns {StateWriteResult}
   */
  function refused(reason, status, message, merged, read) {
    return {
      ok: false,
      reason,
      status,
      message,
      snapshot: null,
      merged,
      advisory: read === null ? null : read.advisory,
      readAt: read === null ? null : read.readAt,
    };
  }

  /**
   * Use this account's role badges on the advisory to determine snapshot trust.
   * If none are present, use membership observed in the same organization.
   *
   * @param {ParsedDetail} fresh The freshly fetched advisory.
   * @param {string} viewer The account used for this write.
   * @returns {string | null}
   */
  function roleOf(fresh, viewer) {
    const trust = globalThis.bghsa.trust;
    /** @type {string[]} */
    const roles = [];
    for (const comment of fresh.comments) {
      if (!sameLogin(comment.author, viewer)) continue;
      for (const badge of comment.roles) if (!roles.includes(badge)) roles.push(badge);
    }
    const known = trust.ROLES.find((role) => roles.includes(role)) ?? roles[0] ?? null;
    if (known !== null) return known;
    return globalThis.bghsa.members.isKnown(fresh.ref, viewer) ? 'Member' : null;
  }

  /**
   * Represent a successful write as a parsed comment. A new comment's GitHub ID
   * is unknown until the next page read; {@link holderOf} uses its author meanwhile.
   *
   * @param {ParsedDetail} fresh The freshly fetched advisory.
   * @param {string} viewer The account used for this write.
   * @param {ParsedComment | undefined} mine The edited comment, or undefined for creation.
   * @param {import('../common/schema.js').SnapshotReport} report The validated snapshot.
   * @param {string} at The write time.
   * @returns {ParsedComment}
   */
  function writtenComment(fresh, viewer, mine, report, at) {
    const schema = globalThis.bghsa.schema;
    // Match the whitespace-normalized text the parser reads from the rendered body.
    const text = globalThis.bghsa.write.collapse(
      [schema.STATE_COMMENT_SUMMARY, schema.STATE_COMMENT_MARKER, report.raw].join(' ')
    );
    if (mine !== undefined) return { ...mine, text, stateComment: report };
    const role = roleOf(fresh, viewer);
    return {
      id: '',
      elementId: '',
      author: viewer,
      role,
      roles: role === null ? [] : [role],
      trusted: globalThis.bghsa.trust.isTrustedAuthor(viewer, role),
      at,
      text,
      stateComment: report,
    };
  }

  /**
   * Update the fetched advisory with the written comment for caching
   * (REQUIREMENTS.md section 2).
   *
   * @param {ParsedDetail} fresh
   * @param {ParsedComment} written The written comment.
   * @param {ParsedComment | undefined} mine The replaced comment, or undefined for creation.
   * @returns {ParsedDetail}
   */
  function withWrite(fresh, written, mine) {
    const comments =
      mine === undefined
        ? [...fresh.comments, written]
        : fresh.comments.map((comment) => (comment === mine ? written : comment));
    return { ...fresh, comments };
  }

  /**
   * @param {WriteResult} outcome
   * @param {Record<string, unknown>} snapshot
   * @param {MergedState} merged
   * @param {{ advisory: ParsedDetail, readAt: number }} read The fetched advisory and
   *   observation time.
   * @returns {StateWriteResult}
   */
  function settled(outcome, snapshot, merged, read) {
    return {
      ok: outcome.ok,
      reason: outcome.reason,
      status: outcome.status,
      message: outcome.message,
      snapshot: outcome.ok ? snapshot : null,
      merged,
      advisory: outcome.ok ? read.advisory : null,
      readAt: outcome.ok ? read.readAt : null,
    };
  }

  /**
   * Write this maintainer's state comment using a fresh advisory read.
   * Reject changes if the sequence number or snapshot holder differs from what
   * the panel loaded. GitHub exposes other authors' edit forms, but this writer
   * selects only the current maintainer's comment.
   *
   * @param {StateWriteOptions} options
   * @returns {Promise<StateWriteResult>}
   */
  async function writeState(options) {
    const write = globalThis.bghsa.write;
    const { ref, loadedSeq } = options;

    /**
     * The prepare step records the state returned to the caller.
     *
     * @type {{ merged: MergedState | null, snapshot: Record<string, unknown> | null,
     *   landed: (() => ParsedDetail) | null,
     *   fresh: { advisory: ParsedDetail, readAt: number } | null }}
     */
    const read = { merged: null, snapshot: null, landed: null, fresh: null };

    const { outcome, run } = await write.runWrite({
      ref,
      // Release the hold after every attempt, including an unconfirmed save,
      // to allow retries.
      hold: {
        held: (key) =>
          inFlight.has(key)
            ? { ok: false, reason: 'in-flight', status: null, message: IN_FLIGHT_MESSAGE }
            : null,
        take: (key) => {
          inFlight.add(key);
        },
        release: (key) => {
          inFlight.delete(key);
        },
      },
      now: () => globalThis.bghsa.cache.now(),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.parseDocument === undefined ? {} : { parseDocument: options.parseDocument }),
      ...(options.beforeSend === undefined ? {} : { beforeSend: options.beforeSend }),
      prepare: (context) => {
        const fresh = context.advisory;
        // Return the fetched page on refusals before sending. Clear it when the write
        // is prepared because a sent request may change the advisory.
        read.fresh = { advisory: fresh, readAt: context.readAt };
        // The logged-in account determines which state comment this write may edit.
        const viewer = fresh.viewer;
        if (viewer === null) {
          return {
            ...stopped('unreadable', 'Error: cannot identify logged-in user'),
            ...(write.findCommentForm(context.page) === null
              ? { diagnostic: /** @type {const} */ ({ code: 'comment-form-missing' }) }
              : {}),
          };
        }

        const merged = globalThis.bghsa.merge.mergeSnapshots(fresh.comments);
        read.merged = merged;
        if (merged.observedSeq !== loadedSeq) {
          return stopped('stale', globalThis.bghsa.write.STALE_MESSAGE);
        }
        // Report duplicate comments before checking the holder. The maintainer must
        // delete a duplicate; reloading alone cannot resolve this error.
        const own = ownStateComments(fresh.comments, viewer);
        if (own.length > 1) {
          return stopped('ambiguous', `Error: multiple tracking comments from ${viewer}`);
        }

        const expected = options.loadedHolder;
        if (expected !== undefined && !sameHolder(expected, holderOf(merged))) {
          return stopped('superseded', globalThis.bghsa.write.STALE_MESSAGE);
        }
        if (merged.readOnly) {
          return stopped('read-only', globalThis.bghsa.write.OUTDATED_MESSAGE);
        }
        if (merged.confirmationRequired && options.confirmed !== true) {
          return stopped('confirmation', 'Error: unparsed tracking state');
        }

        const at = options.at ?? nowStamp();
        // Confirmation records use the login and timestamp of this write.
        const changes =
          typeof options.changes === 'function'
            ? options.changes({ by: viewer, at })
            : options.changes;
        const objection = options.guard?.(merged.state, changes) ?? null;
        if (objection !== null) return stopped(objection.reason, objection.message);

        const built = globalThis.bghsa.merge.nextSnapshot(merged.state, changes, {
          by: viewer,
          at,
          seq: merged.nextSeq,
        });
        stampTriageSince(built, merged.state, changes, at, seedTriageSince(fresh));
        read.snapshot = built;

        // Validate the snapshot before sending to ensure the extension can read it.
        const json = snapshotJson(built);
        const reading = globalThis.bghsa.schema.readSnapshot(json);
        if (!reading.valid) {
          console.warn(
            '[better-ghsa] the snapshot this extension built is one it would not read back',
            reading.problems
          );
          return stopped('invalid', globalThis.bghsa.write.INVALID_STATE_MESSAGE);
        }

        const mine = own[0];
        read.landed = () => withWrite(fresh, writtenComment(fresh, viewer, mine, reading, at), mine);
        read.fresh = null;
        return {
          body: buildBody(built),
          expected: [globalThis.bghsa.schema.STATE_COMMENT_MARKER, json],
          ...(mine === undefined ? {} : { commentId: mine.id }),
        };
      },
    });

    const { merged, snapshot, landed, fresh } = read;
    if (!outcome.ok || run === null || landed === null || snapshot === null || merged === null) {
      return {
        ...refused(outcome.reason, outcome.status, outcome.message, merged, fresh),
        ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
      };
    }
    return settled(outcome, snapshot, merged, { advisory: landed(), readAt: run.readAt });
  }

  const exported = {
    IN_FLIGHT_MESSAGE,
    inFlight,
    sameLogin,
    buildBody,
    holderOf,
    sameHolder,
    stampTriageSince,
    writeState,
  };

  globalThis.bghsa.state = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
