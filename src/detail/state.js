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
 * @property {string | null} reason One of `allowlist`, `in-flight`, `fetch`,
 *   `mismatch`, `unreadable`, `stale`, `superseded`, `read-only`,
 *   `confirmation`, `ambiguous`, `invalid`, the reason a caller's `guard`
 *   named, the reasons a write of the comment itself carries, and null on
 *   success.
 * @property {number | null} status
 * @property {string} message What happened, in the words the panel shows.
 * @property {Record<string, unknown> | null} snapshot The snapshot this write
 *   put on the advisory, and null where nothing was written.
 * @property {MergedState | null} merged The state the fetched page carried,
 *   and null where the write never read one. A refused write hands this back
 *   so the panel reloads from what the advisory says now.
 * @property {ParsedDetail | null} advisory The advisory as this write read it.
 *   A write that landed carries the page with the comment it wrote on it; a
 *   write refused by what the page said carries the page as it stands, because
 *   the fetch was spent on reading it and nothing was written to it. Null where
 *   the write never got a page, and null once a request has gone out and not
 *   come back as a landed write.
 * @property {number | null} readAt When that page was read, epoch
 *   milliseconds. Everything in the advisory but a landed write's own comment
 *   was observed then, so it is the observation time a cache entry holding it
 *   carries.
 */

/**
 * @typedef {(envelope: { by: string, at: string }) => Record<string, unknown>} ChangesBuilder
 */

/**
 * Which snapshot holds current state, as far as anything outside the merge can
 * tell: the comment it sits in, and the account it belongs to. A state the
 * panel remembers from a write of its own names no comment in this document,
 * and the login it was written under stands for it.
 *
 * @typedef {object} SnapshotHolder
 * @property {string | null} commentId
 * @property {string | null} by
 */

/**
 * @typedef {object} StateWriteOptions
 * @property {AdvisoryRef} ref The advisory to write on, read from the page.
 * @property {number} loadedSeq The highest ordering claim the panel loaded
 *   with. A page that has moved past it refuses the write.
 * @property {SnapshotHolder} [loadedHolder] Which snapshot held state when the
 *   panel loaded. A sequence number is not on its own an identity: two
 *   maintainers writing at once claim the same one, and the tie sends state to
 *   one of them. A holder that is not the one the panel loaded with refuses
 *   the write, whatever the sequence says.
 * @property {Record<string, unknown> | ChangesBuilder} changes The panel's
 *   changes, as snapshot fields. A field named null is removed, and a field
 *   not named is carried forward whether or not this reader knows it. A
 *   builder is handed the login and the time this write stamps, which is what
 *   a record naming who did something binds to.
 * @property {boolean} [confirmed] Whether the maintainer has confirmed a write
 *   that supersedes a snapshot this reader could not interpret.
 * @property {(state: Record<string, unknown> | null, changes: Record<string,
 *   unknown>) => { reason: string, message: string } | null} [guard] A last
 *   look at the changes against the state this write builds on, which is the
 *   state its own fetch read and not the one the panel was loaded with. An
 *   objection refuses the write, and is what the panel says.
 * @property {string} [at] The write time. The clock is read when this is
 *   absent.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 * @property {() => void} [beforeSend] Called once the comment request is built
 *   and before it goes out.
 */

(() => {
  /**
   * What the panel says while a write on this advisory is already going out.
   * The controls that started it are held still until it settles, so this is
   * the state of a disabled control and not a refusal a press can reach.
   *
   * The preservation press says the same and reports the same `in-flight`
   * reason, so one event reads the same however it was started.
   */
  const IN_FLIGHT_MESSAGE = globalThis.bghsa.write.SAVING_MESSAGE;

  /**
   * The advisories a write is going out for. A second write while one is in
   * flight would compute its sequence number from a page the first one has not
   * landed on yet, and both would claim the same one.
   *
   * @type {Set<string>}
   */
  const inFlight = new Set();

  /**
   * @param {string | null | undefined} left
   * @param {string | null | undefined} right
   * @returns {boolean} whether both name one GitHub account. Logins differ in
   *   case between places GitHub renders them and name one account.
   */
  function sameLogin(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    return left.toLowerCase() === right.toLowerCase();
  }

  /**
   * @param {MergedState} merged
   * @returns {SnapshotHolder} which snapshot this state came from.
   */
  function holderOf(merged) {
    const by = merged.state === null ? undefined : merged.state['by'];
    // A snapshot the extension wrote onto a comment it has not read back names
    // no identifier, and an empty one is that and not a comment of its own.
    const commentId = merged.source?.id ?? '';
    return {
      commentId: commentId === '' ? null : commentId,
      by: merged.source?.author ?? (typeof by === 'string' ? by : null),
    };
  }

  /**
   * Whether two readings name one snapshot. The comment id settles it where both
   * readings have one; a state remembered from a write of this panel's own names
   * no comment, and there the login it went out under is what there is to
   * compare.
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
   * The JSON a state comment carries. Two spaces of indent put every line under
   * a key, so no line of it can read as the end of the fence that holds it.
   *
   * @param {Record<string, unknown>} snapshot
   * @returns {string}
   */
  function snapshotJson(snapshot) {
    return JSON.stringify(snapshot, null, 2);
  }

  /**
   * The body of a state comment: the collapsed block REQUIREMENTS.md section 3
   * describes, holding the marker and the snapshot.
   *
   * The marker is a code span outside the fence, which is what says the comment
   * is a state comment whatever the fence holds. Everything the snapshot says is
   * inside the fence, so no value in it renders as markup.
   *
   * The block's own tags each stand on a line with a blank line between them and
   * what they wrap, which is the shape the summary's link is known to render in.
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
   * The state comments one maintainer wrote on this advisory. The write model
   * puts at most one there, and no maintainer writes to anyone else's.
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
   * @returns {string} the write time, to the second. `at` is informational
   *   because maintainer clocks differ, so nothing reads it finer than that.
   */
  function nowStamp() {
    return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  }

  /**
   * How long an advisory has been waiting is measured from `triageSince`, and
   * the triage value an advisory carries for the first time is where that
   * measurement starts. It starts at the most recent member action the page
   * carries, and at the report time where no member has acted, so an advisory a
   * maintainer has been working on does not read as having arrived at the moment
   * its triage value was set.
   *
   * @param {ParsedDetail} advisory The advisory as the write's own fetch read it.
   * @returns {string | null}
   */
  function seedTriageSince(advisory) {
    return globalThis.bghsa.derive.derive(advisory).lastMemberActivityAt ?? advisory.reportedAt;
  }

  /**
   * Stamps `triageSince` with the write time when this write changes the triage
   * value, and leaves it as the merged state carried it when it does not. A
   * write that names `triageSince` itself is left alone.
   *
   * A write that gives an advisory a triage value where the state it builds on
   * carries none stamps `seed`, whatever else has been written to that advisory.
   * REQUIREMENTS.md section 6 measures a first triage value from the most recent
   * maintainer action, and a maintainer who replied three weeks ago and saved an
   * owner yesterday has been waiting three weeks. The write time stands in where
   * the page offered nothing to seed from.
   *
   * A write that takes the triage value away takes the time with it. What
   * `triageSince` measures is how long the advisory has stood in its triage
   * value, and a snapshot with no triage value stands in none.
   *
   * @param {Record<string, unknown>} snapshot
   * @param {Record<string, unknown> | null} current
   * @param {Record<string, unknown>} changes
   * @param {string} at
   * @param {string | null} seed Where a first triage value measures from, and
   *   null where the page offered nothing to seed from.
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
   * @returns {WriteResult} what stops a write before a request is built.
   */
  function stopped(reason, message) {
    return { ok: false, reason, status: null, message };
  }

  /**
   * @param {string | null} reason
   * @param {number | null} status
   * @param {string} message
   * @param {MergedState | null} merged
   * @param {{ advisory: ParsedDetail, readAt: number } | null} read What this
   *   write's fetch read, and when, where the refusal was decided on it and no
   *   request went out. Null where there is no page to hand back.
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
   * The badge GitHub renders beside this account on this advisory, which is
   * what says whether its snapshots count toward state. A comment it already
   * holds carries the badge; where it holds none, a member badge this account
   * carried on another advisory in the same organization stands for it, and
   * that is the whole of what the extension has seen.
   *
   * @param {ParsedDetail} fresh The advisory as this write read it.
   * @param {string} viewer The account this write went out under.
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
   * The comment this write left on the advisory, in the shape a reader of the
   * page parses one into.
   *
   * A created comment names no identifier: GitHub minted one and the page this
   * write read does not carry it. The account it went out under is what stands
   * for it until the advisory is read again, which is what {@link holderOf}
   * falls back on.
   *
   * @param {ParsedDetail} fresh The advisory as this write read it.
   * @param {string} viewer The account this write went out under.
   * @param {ParsedComment | undefined} mine The comment this write edited, and
   *   undefined where it created one.
   * @param {import('../common/schema.js').SnapshotReport} report The snapshot
   *   this write put in that comment, as this extension reads it back.
   * @param {string} at The write time.
   * @returns {ParsedComment}
   */
  function writtenComment(fresh, viewer, mine, report, at) {
    const schema = globalThis.bghsa.schema;
    // What the collapsed block renders to: the summary, the marker in its code
    // span, and the fence. It is the text a reader of the page would collapse
    // out of the comment body.
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
   * The advisory as it stands once this write landed. REQUIREMENTS.md section
   * 2: a write this extension makes updates the cache entry to carry what was
   * written, and the page this write read is everything else that entry holds.
   *
   * @param {ParsedDetail} fresh
   * @param {ParsedComment} written The comment this write left.
   * @param {ParsedComment | undefined} mine The comment it replaced, and
   *   undefined where it created one.
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
   * @param {{ advisory: ParsedDetail, readAt: number }} read What this write's
   *   own fetch read, and when.
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
   * Writes this maintainer's state comment on one advisory.
   *
   * The snapshots it merges, the comment it edits, and the state it stamps all
   * come from the one document the write reads. A page that has moved past the
   * sequence number the panel loaded with refuses the write, and so does a page
   * where that sequence belongs to another snapshot than the one the panel
   * loaded, so a change is never applied to state the maintainer did not see.
   *
   * The comment this maintainer already wrote is edited, and one is created
   * where they have written none. Another maintainer's comment is never the
   * target: the edit form for it is in the page, and posting it would overwrite
   * what they wrote in front of the reporter.
   *
   * The advisory is held while the write is out and released once it settles,
   * whatever it settled as: a save GitHub did not confirm is one the maintainer
   * can make again.
   *
   * @param {StateWriteOptions} options
   * @returns {Promise<StateWriteResult>}
   */
  async function writeState(options) {
    const write = globalThis.bghsa.write;
    const { ref, loadedSeq } = options;

    /**
     * What the prepare step read, which the result carries back out of it.
     *
     * @type {{ merged: MergedState | null, snapshot: Record<string, unknown> | null,
     *   landed: (() => ParsedDetail) | null,
     *   fresh: { advisory: ParsedDetail, readAt: number } | null }}
     */
    const read = { merged: null, snapshot: null, landed: null, fresh: null };

    const { outcome, run } = await write.runWrite({
      ref,
      // Released whatever happened: an unconfirmed save is one the maintainer
      // can make again, and the advisory says what it says.
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
        // The page this fetch spent its request on. Every refusal below is
        // decided on it and sends nothing, so it is the advisory as it stands
        // and the result hands it back. It is dropped again once the write is
        // prepared, because a request that goes out can land and leave the page
        // this read behind.
        read.fresh = { advisory: fresh, readAt: context.readAt };
        // This write's comment is keyed to the maintainer it goes out under, so
        // an account this extension could not read is one it will not write as.
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
        // Before the holder gate, because a maintainer holding two state
        // comments is told to delete one and can act on that. Reading the
        // advisory again would find the same two, and the write model in
        // REQUIREMENTS.md section 3 puts one comment per maintainer on an
        // advisory.
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
        // The changes are asked for once the login and the time are settled, so
        // a record inside them names the account this write goes out under.
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

        // The snapshot goes through this extension's own reader before it goes
        // out. A payload the reader would exclude is one no reader takes as
        // state, and an advisory carrying a snapshot the extension that wrote it
        // refuses to read is one nobody can write from until it is superseded by
        // hand.
        const json = snapshotJson(built);
        const reading = globalThis.bghsa.schema.readSnapshot(json);
        if (!reading.valid) {
          console.warn(
            '[better-ghsa] the snapshot this extension built is one it would not read back',
            reading.problems
          );
          return stopped('invalid', globalThis.bghsa.write.INVALID_STATE_MESSAGE);
        }

        // The comment this maintainer already wrote is the one this replaces.
        // Another maintainer's comment is never the target: the edit form for it
        // is in the page, and posting it would overwrite what they wrote in
        // front of the reporter.
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
