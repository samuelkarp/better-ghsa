'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cache = require('../src/common/cache.js');
const queues = require('../src/common/fetch.js');

// A stand-in for `browser.storage.local`. Two queues sharing one of these are
// two page loads sharing one browser profile.
const { fakeStorage } = require('../test-support/storage.js');

/** @typedef {import('../test-support/storage.js').FakeStorage} Fake */

/**
 * A clock a test moves by hand, and the wait the queue uses with it. Waiting
 * moves the clock and returns at once, so a pass of a hundred advisories costs
 * no time and the intervals are still exact.
 *
 * @param {number} [start]
 */
function fakeClock(start = 0) {
  let at = start;
  /** @type {number[]} */
  const waits = [];
  return {
    waits,
    now: () => at,
    /** @param {number} ms */
    advance: (ms) => {
      at += ms;
    },
    /** @param {number} ms */
    wait: async (ms) => {
      waits.push(ms);
      at += ms;
    },
  };
}

/** The repository every pass here reads. */
const REF = { owner: 'containerd', repo: 'containerd' };

const MINUTE = 60 * 1000;

/**
 * @param {string} suffix
 * @returns {string}
 */
function ghsa(suffix) {
  return `GHSA-${suffix}-${suffix}-${suffix}`;
}

/**
 * A fetch that answers every advisory page, recording the moment each request
 * went out on the clock the queue reads.
 *
 * @param {ReturnType<typeof fakeClock>} clock
 * @param {(url: string) => { status: number, body?: string }} [answer]
 */
function fakeFetch(clock, answer = () => ({ status: 200 })) {
  /** @type {string[]} */
  const urls = [];
  /** @type {number[]} */
  const at = [];
  /** @type {import('../src/common/write.js').WriteFetch} */
  const send = async (url) => {
    urls.push(url);
    at.push(clock.now());
    const { status, body } = answer(url);
    return { status, text: async () => body ?? '<html></html>' };
  };
  return { urls, at, send };
}

/**
 * A clock two queues share, whose waits resolve in time order. Time moves when
 * the pump moves it to the next wait that is due, so two passes running at once
 * interleave the way they do on a page and cost no real time.
 *
 * @param {number} [start]
 */
function sharedClock(start = 0) {
  let at = start;
  /** @type {{ due: number, resolve: () => void }[]} */
  const timers = [];

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  const wait = (ms) =>
    new Promise((resolve) => {
      timers.push({ due: at + ms, resolve: () => resolve() });
    });

  /** @returns {Promise<void>} lets every chain that can run without the clock run. */
  const settle = async () => {
    for (let round = 0; round < 40; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  /** @returns {Promise<void>} runs time forward until nothing is waiting on it. */
  const pump = async () => {
    await settle();
    while (timers.length > 0) {
      timers.sort((left, right) => left.due - right.due);
      const next = timers.shift();
      if (next === undefined) return;
      at = Math.max(at, next.due);
      next.resolve();
      await settle();
    }
  };

  return { now: () => at, wait, settle, pump };
}

/**
 * @param {{ now: () => number, wait: (ms: number) => Promise<void> }} clock
 * @param {Fake} storage
 * @param {Partial<import('../src/common/fetch.js').QueueOptions>} [extra]
 * @returns {import('../src/common/fetch.js').QueueOptions}
 */
function options(clock, storage, extra = {}) {
  return {
    ref: REF,
    storage,
    now: clock.now,
    wait: clock.wait,
    parse: (_html, ref) => ({ state: 'triage', ghsaId: ref.ghsaId }),
    // A draw of zero is the shortest spread there is, so a test that names no
    // draw sees the interval on its own. The tests about two queues waking
    // together name their own.
    random: () => 0,
    ...extra,
  };
}

test('a plan reads never-seen advisories first, then stalest first', () => {
  const at = 100 * MINUTE;
  /** @type {Map<string, import('../src/common/cache.js').CacheEntry>} */
  const entries = new Map([
    [ghsa('aaaa'), { record: {}, observedAt: at - 40 * MINUTE, state: 'triage' }],
    [ghsa('bbbb'), { record: {}, observedAt: at - 90 * MINUTE, state: 'triage' }],
    [ghsa('dddd'), { record: {}, observedAt: at - 4 * MINUTE, state: 'triage' }],
  ]);
  const { order, fresh } = queues.plan(
    [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc'), ghsa('dddd')],
    entries,
    at
  );
  assert.deepStrictEqual(order, [ghsa('cccc'), ghsa('bbbb'), ghsa('aaaa')]);
  assert.deepStrictEqual(fresh, [ghsa('dddd')]);
});

test('a plan orders advisories observed together by identifier', () => {
  const at = 100 * MINUTE;
  /** @type {Map<string, import('../src/common/cache.js').CacheEntry>} */
  const entries = new Map([
    [ghsa('dddd'), { record: {}, observedAt: at - 40 * MINUTE, state: 'triage' }],
    [ghsa('cccc'), { record: {}, observedAt: at - 40 * MINUTE, state: 'triage' }],
  ]);
  // Both pairs are given in the reverse of the order expected back: the two
  // never seen, and the two observed at the same moment. A comparator that
  // answers zero for a tie hands them back in the order they came in.
  const { order } = queues.plan(
    [ghsa('bbbb'), ghsa('aaaa'), ghsa('dddd'), ghsa('cccc')],
    entries,
    at
  );
  assert.deepStrictEqual(order, [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc'), ghsa('dddd')]);
});

test('an advisory observed four minutes ago is not fetched and five is', async () => {
  const clock = fakeClock(10 * MINUTE);
  const storage = fakeStorage();
  await cache.putAdvisory(
    { ...REF, ghsaId: ghsa('aaaa') },
    { state: 'triage' },
    { storage, at: clock.now() - 4 * MINUTE }
  );
  await cache.putAdvisory(
    { ...REF, ghsaId: ghsa('bbbb') },
    { state: 'triage' },
    { storage, at: clock.now() - 5 * MINUTE }
  );
  const fetch = fakeFetch(clock);
  /** @type {string[]} */
  const reported = [];
  const queue = queues.createQueue(
    options(clock, storage, { fetch: fetch.send, onEntry: (ghsaId) => reported.push(ghsaId) })
  );
  await queue.add([ghsa('aaaa'), ghsa('bbbb')]);
  const summary = await queue.run();

  assert.deepStrictEqual(fetch.urls, [
    `/containerd/containerd/security/advisories/${ghsa('bbbb')}`,
  ]);
  assert.ok(summary.fetched === 1, `${summary.fetched} advisories were fetched`);
  assert.ok(summary.skipped === 1, `${summary.skipped} advisories were skipped`);
  // The fresh one still reaches the caller, from the cache, so its row paints.
  assert.deepStrictEqual(reported.sort(), [ghsa('aaaa'), ghsa('bbbb')]);
});

test('requests go out one second apart on the injected clock', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(options(clock, storage, { fetch: fetch.send }));
  await queue.add([ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')]);
  await queue.run();

  assert.ok(fetch.at.length === 3, `${fetch.at.length} requests went out`);
  assert.deepStrictEqual(fetch.at, [0, 1000, 2000]);
  assert.deepStrictEqual(clock.waits, [1000, 1000]);
});

test('a queue that never saw another one waits out its request', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const first = fakeFetch(clock);
  const one = queues.createQueue(options(clock, storage, { fetch: first.send }));
  await one.add([ghsa('aaaa')]);
  await one.run();
  assert.deepStrictEqual(first.at, [0]);

  // A second queue on the same repository: another tab, or what a turbo
  // re-injection left on this page. It resumes nothing, so the request the
  // first one sent is known to it only through the progress entry.
  clock.advance(200);
  const second = fakeFetch(clock);
  const two = queues.createQueue(options(clock, storage, { fetch: second.send }));
  await two.add([ghsa('bbbb')]);
  const summary = await two.run();

  assert.deepStrictEqual(second.at, [1000], 'a second queue spent a request inside the second');
  assert.ok(summary.fetched === 1, `${summary.fetched} advisories were fetched`);
});

test('two queues running at once share one second between them', async () => {
  const clock = sharedClock(0);
  const storage = fakeStorage();
  const ids = [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')];

  /** @type {number[]} */
  const at = [];
  /** @type {string[]} */
  const asked = [];
  /** @type {import('../src/common/write.js').WriteFetch} */
  const send = async (url) => {
    at.push(clock.now());
    asked.push(String(url.split('/').pop()));
    return { status: 200, text: async () => '<html></html>' };
  };

  const one = queues.createQueue(options(clock, storage, { fetch: send }));
  await one.add(ids);
  const running = one.run();
  // The first request goes out, and the second queue starts after it, which is
  // the second tab opening.
  await clock.settle();
  const two = queues.createQueue(options(clock, storage, { fetch: send }));
  await two.add(ids);
  const both = Promise.all([running, two.run()]);
  await clock.pump();
  const [oneSummary, twoSummary] = await both;

  const intervals = at.slice(1).map((moment, index) => moment - Number(at[index]));
  assert.ok(
    intervals.every((interval) => interval >= 1000),
    `requests went out ${intervals.join(', ')} milliseconds apart`
  );
  assert.deepStrictEqual(asked.slice().sort(), ids, 'an advisory was read more than once');
  assert.ok(oneSummary.complete && twoSummary.complete, 'a pass did not finish');
});

test('two queues that wake together do not send inside one second', async () => {
  const clock = sharedClock(0);
  const storage = fakeStorage();
  const ids = [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')];

  /** @type {{ tab: string, at: number, ghsaId: string }[]} */
  const sent = [];
  /**
   * @param {string} tab
   * @returns {import('../src/common/write.js').WriteFetch}
   */
  const sender = (tab) => async (url) => {
    sent.push({ tab, at: clock.now(), ghsaId: String(String(url).split('/').pop()) });
    return { status: 200, text: async () => '<html></html>' };
  };

  // Two tabs on one repository, waking on the same claim: neither has sent
  // anything, so both compute the same moment to send at. They draw different
  // spreads, which is the only thing keeping them apart.
  const one = queues.createQueue(
    options(clock, storage, { fetch: sender('one'), random: () => 0.1 })
  );
  const two = queues.createQueue(
    options(clock, storage, { fetch: sender('two'), random: () => 0.9 })
  );
  await one.add(ids);
  await two.add(ids);
  const both = Promise.all([one.run(), two.run()]);
  await clock.pump();
  await both;

  const at = sent.map((request) => request.at);
  const intervals = at.slice(1).map((moment, index) => moment - Number(at[index]));
  assert.ok(
    intervals.every((interval) => interval >= 1000),
    `requests went out ${intervals.join(', ')} milliseconds apart`
  );
  assert.deepStrictEqual(
    sent.map((request) => request.ghsaId).sort(),
    ids,
    'an advisory was fetched more than once'
  );
});

test('a request time in the future costs one wait and not the difference', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  // What a clock moved back a day leaves behind: a request stamped a day
  // ahead of what the clock now reads.
  await cache.putProgress(
    REF,
    {
      pending: [ghsa('aaaa')],
      inFlight: null,
      done: [],
      failed: [],
      lastRequestAt: 24 * 60 * MINUTE,
      startedAt: 0,
      updatedAt: 0,
    },
    { storage, at: clock.now() }
  );
  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(options(clock, storage, { fetch: fetch.send }));
  await queue.load();
  await queue.run();

  assert.deepStrictEqual(clock.waits, [1000], 'the queue waited out the clock difference');
  assert.deepStrictEqual(fetch.at, [1000], 'the request went out at the wrong moment');
});

test('a pass interrupted in flight resumes without losing or repeating work', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();

  /** @type {(url: string) => void} */
  let reached = () => {};
  const arrived = new Promise((resolve) => {
    reached = /** @type {(url: string) => void} */ (resolve);
  });
  /** @type {string[]} */
  const asked = [];
  /** @type {import('../src/common/write.js').WriteFetch} */
  const stalls = async (url) => {
    asked.push(url);
    if (asked.length === 1) return { status: 200, text: async () => '<html></html>' };
    reached(url);
    // The page went away with this request in flight: it never answers.
    return new Promise(() => {});
  };

  const one = queues.createQueue(options(clock, storage, { fetch: stalls }));
  await one.add([ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')]);
  void one.run();
  await arrived;

  const held = queues.progressFrom(await cache.getProgress(REF, { storage, at: clock.now() }));
  assert.ok(held !== null, 'the interrupted pass left no progress');
  assert.ok(held.inFlight === ghsa('bbbb'), `the record named ${held?.inFlight} in flight`);
  assert.deepStrictEqual(held.done, [ghsa('aaaa')], 'the first read was not recorded done');
  assert.deepStrictEqual(held.pending, [ghsa('cccc')], 'the rest of the queue was not held');

  // The next page load. The advisory that was in flight goes back at the head,
  // and the one the first pass finished is fresh in the cache, so it is not
  // asked for a second time.
  const next = fakeFetch(clock);
  const two = queues.createQueue(options(clock, storage, { fetch: next.send }));
  const resumed = await two.load();
  assert.ok(resumed !== null, 'nothing was resumed');
  assert.deepStrictEqual(two.progress().pending, [ghsa('bbbb'), ghsa('cccc')]);

  const summary = await two.run();
  assert.deepStrictEqual(
    next.urls.map((url) => url.split('/').pop()),
    [ghsa('bbbb'), ghsa('cccc')],
    'the resumed pass asked for the wrong advisories'
  );
  assert.ok(summary.fetched === 2, `${summary.fetched} advisories were fetched on the resume`);
  assert.ok(summary.complete, 'the resumed pass did not finish');
});

test('an answer that landed before the page went away is not fetched again', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  // The entry was written and the progress record was not, which is the window
  // between the cache write and the progress write.
  await cache.putAdvisory(
    { ...REF, ghsaId: ghsa('bbbb') },
    { state: 'triage' },
    { storage, at: clock.now() }
  );
  await cache.putProgress(
    REF,
    {
      pending: [ghsa('cccc')],
      inFlight: ghsa('bbbb'),
      done: [ghsa('aaaa')],
      failed: [],
      lastRequestAt: clock.now(),
      startedAt: 0,
      updatedAt: clock.now(),
    },
    { storage, at: clock.now() }
  );

  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(options(clock, storage, { fetch: fetch.send }));
  await queue.load();
  const summary = await queue.run();

  assert.deepStrictEqual(
    fetch.urls.map((url) => url.split('/').pop()),
    [ghsa('cccc')],
    'the advisory whose answer had landed was fetched again'
  );
  assert.ok(summary.skipped === 1, `${summary.skipped} advisories were skipped`);
});

test('a finished pass leaves nothing to resume and the request time', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(options(clock, storage, { fetch: fetch.send }));
  await queue.add([ghsa('aaaa'), ghsa('bbbb')]);
  assert.ok(
    Object.hasOwn(storage.entries, 'queue:containerd/containerd'),
    'queueing left no progress'
  );
  const summary = await queue.run();
  assert.ok(summary.complete, 'the pass did not finish');

  const held = queues.progressFrom(await cache.getProgress(REF, { storage, at: clock.now() }));
  assert.ok(held !== null, 'a finished pass left no record of when it last asked');
  assert.deepStrictEqual(held.pending, [], 'a finished pass left work to resume');
  assert.ok(held.inFlight === null, 'a finished pass left a request in flight');
  assert.ok(held.lastRequestAt === 1000, `the last request was recorded at ${held?.lastRequestAt}`);
});

test('a stopped pass holds what is left for the next page', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(
    options(clock, storage, {
      fetch: fetch.send,
      onEntry: (ghsaId) => {
        if (ghsaId === ghsa('aaaa')) queue.stop();
      },
    })
  );
  await queue.add([ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')]);
  const summary = await queue.run();

  assert.ok(fetch.urls.length === 1, `${fetch.urls.length} requests went out`);
  assert.ok(!summary.complete, 'a stopped pass reported itself finished');
  assert.deepStrictEqual(summary.remaining, [ghsa('bbbb'), ghsa('cccc')]);
  const held = queues.progressFrom(await cache.getProgress(REF, { storage, at: clock.now() }));
  assert.deepStrictEqual(held?.pending, [ghsa('bbbb'), ghsa('cccc')]);
});

test('a stop during the wait spends no further request', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(
    options(clock, storage, {
      fetch: fetch.send,
      // The page goes away, or the list is torn down, while the queue is
      // waiting out the second. No request is in flight to finish.
      wait: async (ms) => {
        queue.stop();
        await clock.wait(ms);
      },
    })
  );
  await queue.add([ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')]);
  const summary = await queue.run();

  assert.ok(fetch.urls.length === 1, `${fetch.urls.length} requests went out`);
  assert.ok(!summary.complete, 'a stopped pass reported itself finished');
  assert.deepStrictEqual(
    summary.remaining,
    [ghsa('bbbb'), ghsa('cccc')],
    'the advisory that was waiting was dropped'
  );
  const held = queues.progressFrom(await cache.getProgress(REF, { storage, at: clock.now() }));
  assert.deepStrictEqual(held?.pending, [ghsa('bbbb'), ghsa('cccc')]);
  assert.ok(held?.inFlight === null, 'a stopped pass left a request in flight');
});

test('a failed read caches nothing and the pass carries on', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock, (url) =>
    url.endsWith(ghsa('aaaa')) ? { status: 404 } : { status: 200 }
  );
  /** @type {string[]} */
  const failures = [];
  const queue = queues.createQueue(
    options(clock, storage, {
      fetch: fetch.send,
      onFailure: (ghsaId, reason) => failures.push(`${ghsaId}: ${String(reason)}`),
    })
  );
  await queue.add([ghsa('aaaa'), ghsa('bbbb')]);
  const summary = await queue.run();

  assert.deepStrictEqual(summary.failed, [ghsa('aaaa')], 'the read that failed is named');
  assert.ok(summary.fetched === 1, `${summary.fetched} advisories were fetched`);
  assert.deepStrictEqual(failures, [`${ghsa('aaaa')}: GitHub answered 404.`]);
  assert.ok(
    (await cache.getAdvisory({ ...REF, ghsaId: ghsa('aaaa') }, { storage, at: clock.now() })) ===
      null,
    'a failed read was cached'
  );
  // A request went out for the failed read, so the next one still waits.
  assert.deepStrictEqual(fetch.at, [0, 1000]);
});

test('a cache write that fails still delivers what was fetched', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  // Every write is refused, which is what a quota does.
  storage.set = async () => {
    throw new Error('QuotaExceededError');
  };
  const fetch = fakeFetch(clock);
  /** @type {string[]} */
  const reported = [];
  /** @type {string[]} */
  const failures = [];
  const queue = queues.createQueue(
    options(clock, storage, {
      fetch: fetch.send,
      onEntry: (ghsaId, entry) => reported.push(`${ghsaId}:${String(entry.state)}`),
      onFailure: (ghsaId) => failures.push(ghsaId),
    })
  );
  await queue.add([ghsa('aaaa'), ghsa('bbbb')]);
  const summary = await queue.run();

  assert.ok(summary.fetched === 2, `${summary.fetched} advisories were fetched`);
  assert.deepStrictEqual(summary.failed, [], 'a read was reported failed');
  assert.deepStrictEqual(failures, [], 'a fetch that answered 200 was reported a failure');
  assert.deepStrictEqual(reported, [`${ghsa('aaaa')}:triage`, `${ghsa('bbbb')}:triage`]);
});

// The bound under test is the only thing that ends this pass, so the test
// carries a bound of its own: without one, a queue that never gives up on a
// request hangs the run in place of failing it.
test('a request that never answers fails and the pass carries on', { timeout: 5000 }, async (t) => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  /** @type {number[]} */
  const at = [];
  /** @type {AbortSignal | null} */
  let stalled = null;
  /** @type {import('../src/common/write.js').WriteFetch} */
  const send = async (url, init) => {
    at.push(clock.now());
    if (!url.endsWith(ghsa('aaaa'))) return { status: 200, text: async () => '<html></html>' };
    // Nobody answers this one: no status, no error, no close.
    stalled = init.signal ?? null;
    return new Promise(() => {});
  };
  /** @type {string[]} */
  const failures = [];
  const queue = queues.createQueue(
    options(clock, storage, {
      fetch: send,
      timeoutMs: 25,
      onFailure: (ghsaId, reason) => failures.push(`${ghsaId}: ${String(reason)}`),
    })
  );
  await queue.add([ghsa('aaaa'), ghsa('bbbb')]);
  // A page always has work of its own pending. This run has none, and the
  // queue's countdown does not by itself keep a Node loop turning, so the test
  // supplies the turning.
  const turning = setInterval(() => {}, 5);
  t.after(() => clearInterval(turning));
  const summary = await queue.run();

  assert.ok(summary.complete, 'the pass did not finish');
  assert.ok(!queue.isRunning(), 'the queue reported itself still running');
  assert.deepStrictEqual(summary.failed, [ghsa('aaaa')], 'the read that failed is named');
  assert.ok(summary.fetched === 1, `${summary.fetched} advisories were fetched`);
  assert.ok(
    failures.length === 1 && String(failures[0]).includes('did not answer within 25 ms'),
    `the failures were ${failures.join('; ')}`
  );
  assert.ok(
    /** @type {AbortSignal | null} */ (stalled)?.aborted === true,
    'the request that timed out was left running'
  );
  // The request that timed out spent its slot, so the next one waits it out.
  assert.deepStrictEqual(at, [0, 1000]);
});

test('a failure listener that throws does not end the pass', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock, (url) =>
    url.endsWith(ghsa('cccc')) ? { status: 200 } : { status: 500 }
  );
  /** @type {string[]} */
  const heard = [];
  const queue = queues.createQueue(
    options(clock, storage, {
      fetch: fetch.send,
      // A panel that throws on the way to painting a row, which the pass hears
      // through the failure listener that then throws in its turn.
      onEntry: (ghsaId) => {
        throw new Error(`the row for ${ghsaId} blew up`);
      },
      onFailure: (ghsaId) => {
        heard.push(ghsaId);
        throw new Error('the banner blew up');
      },
    })
  );
  await queue.add([ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')]);
  const summary = await queue.run();

  assert.ok(summary.complete, 'the pass did not finish');
  assert.deepStrictEqual(
    summary.failed,
    [ghsa('aaaa'), ghsa('bbbb')],
    'the reads that failed are named'
  );
  assert.ok(summary.fetched === 1, `${summary.fetched} advisories were fetched`);
  assert.deepStrictEqual(heard, [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')]);
});

test('an advisory refreshed mid-pass is dropped from the queue', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(
    options(clock, storage, {
      fetch: fetch.send,
      onEntry: async (ghsaId) => {
        // Reading the detail page of the next advisory refreshes its entry from
        // the live DOM while this pass is running.
        if (ghsaId !== ghsa('aaaa')) return;
        await cache.putAdvisory(
          { ...REF, ghsaId: ghsa('bbbb') },
          { state: 'draft' },
          { storage, at: clock.now() }
        );
      },
    })
  );
  await queue.add([ghsa('aaaa'), ghsa('bbbb')]);
  const summary = await queue.run();

  assert.deepStrictEqual(
    fetch.urls.map((url) => url.split('/').pop()),
    [ghsa('aaaa')],
    'the advisory refreshed mid-pass was fetched anyway'
  );
  assert.ok(summary.skipped === 1, `${summary.skipped} advisories were skipped`);
});

test('what a read holds is the parsed record, stamped with the read time', async () => {
  const clock = fakeClock(7 * MINUTE);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(
    options(clock, storage, {
      fetch: fetch.send,
      parse: (html, ref) => ({ state: 'Draft', ghsaId: ref.ghsaId, title: html.length }),
    })
  );
  await queue.add([ghsa('aaaa')]);
  await queue.run();

  const entry = await cache.getAdvisory(
    { ...REF, ghsaId: ghsa('aaaa') },
    { storage, at: clock.now() }
  );
  assert.ok(entry !== null, 'the read was not cached');
  assert.ok(entry.observedAt === 7 * MINUTE, `the entry was observed at ${entry?.observedAt}`);
  assert.ok(entry.state === 'draft', `the entry state was ${entry?.state}`);
  assert.ok(
    /** @type {{ ghsaId?: unknown }} */ (entry.record).ghsaId === ghsa('aaaa'),
    'the record is not what the parse returned'
  );
});

test('a progress record of another shape resumes nothing', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  await cache.putProgress(REF, { pending: 'everything' }, { storage, at: 0 });
  const queue = queues.createQueue(options(clock, storage, { fetch: fakeFetch(clock).send }));
  const held = await queue.load();
  assert.deepStrictEqual(held?.pending, [], 'a malformed pending list was taken as advisories');
  assert.ok(queues.progressFrom(null) === null, 'null read as progress');
  assert.ok(queues.progressFrom(12) === null, 'a number read as progress');
});

/** One page of the advisory list, as a crawl asks for it. */
const LIST_URL = '/containerd/containerd/security/advisories?state=triage';

test('a list page read and an advisory read share one second', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock, () => ({ status: 200, body: '<html>page one</html>' }));
  const queue = queues.createQueue(options(clock, storage, { fetch: fetch.send }));

  const page = await queue.page(LIST_URL);
  await queue.add([ghsa('aaaa')]);
  await queue.run();

  assert.ok(page.body === '<html>page one</html>', `the page body was ${page.body}`);
  assert.ok(page.status === 200, `the page status was ${page.status}`);
  assert.deepStrictEqual(fetch.urls, [
    LIST_URL,
    `/containerd/containerd/security/advisories/${ghsa('aaaa')}`,
  ]);
  // The rate limit counts requests, and a list page is one, so the advisory
  // read waits out the second the page read started.
  assert.deepStrictEqual(fetch.at, [0, 1000]);
});

test('a list page read leaves the claim the next page load waits out', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const first = fakeFetch(clock);
  const one = queues.createQueue(options(clock, storage, { fetch: first.send }));
  await one.page(LIST_URL);
  assert.deepStrictEqual(first.at, [0]);

  // Another tab, or what a turbo re-injection left behind: it knows of the page
  // read only through the claim in the progress entry.
  clock.advance(300);
  const second = fakeFetch(clock);
  const two = queues.createQueue(options(clock, storage, { fetch: second.send }));
  await two.add([ghsa('aaaa')]);
  await two.run();

  assert.deepStrictEqual(second.at, [1000], 'a crawl page read did not bound the next queue');
});

test('a list page GitHub refused comes back with the status and no body', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock, () => ({ status: 404 }));
  const queue = queues.createQueue(options(clock, storage, { fetch: fetch.send }));

  const page = await queue.page(LIST_URL);
  assert.ok(page.body === null, `a refused page carried a body: ${page.body}`);
  assert.ok(page.status === 404, `the page status was ${page.status}`);
  assert.ok(page.reason === 'GitHub answered 404.', `the reason was ${String(page.reason)}`);
  assert.ok(page.stopped === false, 'a page GitHub refused was reported stopped');
});

test('a stopped queue sends no list page read', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(options(clock, storage, { fetch: fetch.send }));
  queue.stop();

  const page = await queue.page(LIST_URL);
  assert.deepStrictEqual(fetch.urls, [], 'a stopped queue spent a request');
  assert.ok(page.body === null, `a stopped queue answered with a body: ${page.body}`);
  // Nothing was asked of GitHub, and the answer says so: the caller counting
  // pages that would not answer has this one to leave out.
  assert.ok(page.stopped === true, 'a stop was not told apart from a page that would not answer');
});

/**
 * Runs one pass over some advisories, on a clock far enough on that whatever
 * the cache holds has gone stale and is read again. Each pass is a fresh queue,
 * which is what a page load is.
 *
 * @param {ReturnType<typeof fakeClock>} clock
 * @param {Fake} storage
 * @param {readonly string[]} ids
 * @param {(url: string) => { status: number, body?: string }} answer
 * @returns {Promise<void>}
 */
async function passOver(clock, storage, ids, answer) {
  clock.advance(10 * MINUTE);
  const fetch = fakeFetch(clock, answer);
  const queue = queues.createQueue(options(clock, storage, { fetch: fetch.send }));
  await queue.add([...ids]);
  await queue.run();
}

/**
 * @param {Fake} storage
 * @param {string} ghsaId
 * @param {number} at
 * @returns {Promise<import('../src/common/cache.js').CacheEntry | null>}
 */
function heldFor(storage, ghsaId, at) {
  return cache.getAdvisory({ ...REF, ghsaId }, { storage, at });
}

test('three 404 answers in a row take the advisory out of the cache', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const id = ghsa('aaaa');

  await passOver(clock, storage, [id], () => ({ status: 200 }));
  const written = await heldFor(storage, id, clock.now());
  assert.ok(written !== null, 'the read that answered was not cached');
  const observedAt = written.observedAt;

  for (const count of [1, 2]) {
    await passOver(clock, storage, [id], () => ({ status: 404 }));
    const held = await heldFor(storage, id, clock.now());
    assert.ok(held !== null, `the entry went after ${count} 404 answers`);
    assert.strictEqual(held.misses, count, `the count after ${count} 404 answers`);
    // A 404 read nothing, so the entry is no fresher for having been asked and
    // the next pass asks again.
    assert.strictEqual(held.observedAt, observedAt, 'a 404 moved the observation time');
  }

  await passOver(clock, storage, [id], () => ({ status: 404 }));
  assert.strictEqual(await heldFor(storage, id, clock.now()), null, 'it survived three 404s');
  const key = cache.advisoryKey({ ...REF, ghsaId: id }) ?? '';
  assert.ok(!Object.hasOwn(storage.entries, key), 'the evicted entry stayed in storage');
});

test('a read that lands puts the 404 count back to none', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const id = ghsa('aaaa');

  await passOver(clock, storage, [id], () => ({ status: 200 }));
  for (const _ of [1, 2]) await passOver(clock, storage, [id], () => ({ status: 404 }));
  assert.strictEqual((await heldFor(storage, id, clock.now()))?.misses, 2, 'two 404s counted');

  await passOver(clock, storage, [id], () => ({ status: 200 }));
  assert.strictEqual((await heldFor(storage, id, clock.now()))?.misses, 0, 'the count carried on');

  // Two more. Without the reset the second of these is the third 404 the entry
  // has answered with and it would be gone.
  for (const count of [1, 2]) {
    await passOver(clock, storage, [id], () => ({ status: 404 }));
    const held = await heldFor(storage, id, clock.now());
    assert.ok(held !== null, `the entry went after ${count} 404s past a read that landed`);
    assert.strictEqual(held.misses, count, `the count after the read that landed and ${count}`);
  }
});

test('a failure that is not a 404 never counts against the advisory', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const id = ghsa('aaaa');
  await passOver(clock, storage, [id], () => ({ status: 200 }));

  // GitHub having a bad minute, three times over.
  for (const _ of [1, 2, 3]) await passOver(clock, storage, [id], () => ({ status: 500 }));
  assert.strictEqual((await heldFor(storage, id, clock.now()))?.misses, 0, 'a 500 counted');

  // A request that never reached GitHub at all, three times over.
  for (const _ of [1, 2, 3]) {
    await passOver(clock, storage, [id], () => {
      throw new Error('NetworkError when attempting to fetch resource.');
    });
  }
  const held = await heldFor(storage, id, clock.now());
  assert.ok(held !== null, 'six failures that were not 404s took the entry');
  assert.strictEqual(held.misses, 0, 'a request that never answered counted');

  // Three 404s through the same storage, the same clock, and the same queue.
  // Without this the assertions above would hold against a reader that counted
  // nothing at all, because no 404 was ever produced here.
  for (const _ of [1, 2, 3]) await passOver(clock, storage, [id], () => ({ status: 404 }));
  assert.strictEqual(await heldFor(storage, id, clock.now()), null, 'a 404 did not count');
});

test('a 404 on one advisory leaves another advisory alone', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const gone = ghsa('aaaa');
  const kept = ghsa('bbbb');
  await passOver(clock, storage, [gone, kept], () => ({ status: 200 }));

  // Two passes over both, and then the third 404 on its own. The advisory that
  // is evicted is the last thing read, so an eviction reaching past its own
  // entry has nothing after it to write the other one back.
  for (const _ of [1, 2]) {
    await passOver(clock, storage, [gone, kept], (url) =>
      url.endsWith(gone) ? { status: 404 } : { status: 200 }
    );
  }
  await passOver(clock, storage, [gone], () => ({ status: 404 }));

  assert.strictEqual(await heldFor(storage, gone, clock.now()), null, 'the missing one was kept');
  const held = await heldFor(storage, kept, clock.now());
  assert.ok(held !== null, "the other advisory went with its neighbor's 404s");
  assert.strictEqual(held.misses, 0, 'the other advisory carried a count of its own');
});
