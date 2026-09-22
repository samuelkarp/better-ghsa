'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cache = require('../src/common/cache.js');

const { fakeStorage } = require('../test-support/storage.js');

/** @typedef {import('../test-support/storage.js').FakeStorage} Fake */

const REF = { owner: 'containerd', repo: 'containerd', ghsaId: 'GHSA-1234-5678-9abc' };

const KEY = 'adv:containerd/containerd:ghsa-1234-5678-9abc';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/**
 * @param {number} observedAt
 * @param {string | null} state
 * @param {number} [jitterMs] The stored jitter in milliseconds.
 * @returns {import('../src/common/cache.js').CacheEntry}
 */
function entry(observedAt, state, jitterMs = 0) {
  return { record: { state }, observedAt, state, jitterMs };
}

test('an advisory key names the owner, the repository, and the advisory', () => {
  assert.ok(cache.advisoryKey(REF) === KEY, `advisory key was ${cache.advisoryKey(REF)}`);
  assert.ok(
    cache.advisoryKey({ owner: 'Containerd', repo: 'ContainerD', ghsaId: 'ghsa-1234-5678-9ABC' }) ===
      KEY,
    'a differently spelled reference names a different key'
  );
  assert.ok(cache.advisoryKey({ owner: 'x', repo: '', ghsaId: 'y' }) === null, 'no repository');
  assert.ok(cache.advisoryKey(null) === null, 'no reference');
});

test('the list and progress entries are keyed by repository', () => {
  assert.ok(
    cache.listKey(REF) === 'list:containerd/containerd',
    `list key was ${cache.listKey(REF)}`
  );
  assert.ok(
    cache.progressKey(REF) === 'queue:containerd/containerd',
    `progress key was ${cache.progressKey(REF)}`
  );
  assert.ok(cache.isCacheKey(KEY), 'an advisory key belongs to the cache');
  assert.ok(cache.isCacheKey('list:containerd/containerd'), 'a list key belongs to the cache');
  assert.ok(cache.isCacheKey('queue:containerd/containerd'), 'a progress key belongs to the cache');
  assert.ok(!cache.isCacheKey('members'), 'the members entry is not the cache');
  assert.ok(!cache.isCacheKey('branches'), 'the branches entry is not the cache');
});

test('a draw puts off the two long thresholds and no others', () => {
  const drew = cache.staleAfter('published', 3 * DAY);
  assert.ok(drew === 33 * DAY, `a published entry that drew three days refreshed after ${drew}`);
  assert.ok(cache.staleAfter('withdrawn', DAY) === 31 * DAY, 'a withdrawn entry ignored its draw');
  for (const state of ['triage', 'draft', 'closed', null]) {
    assert.ok(
      cache.staleAfter(state, 3 * DAY) === cache.staleAfter(state),
      `${state} took a draw it is not meant to carry`
    );
  }
  assert.ok(
    cache.staleAfter('published', 400 * DAY) === 35 * DAY,
    'a draw beyond five days was not held to five'
  );
  for (const drawn of [Number.NaN, Number.POSITIVE_INFINITY, -5 * DAY]) {
    assert.ok(
      cache.staleAfter('published', drawn) === 30 * DAY,
      `a draw of ${drawn} was taken as a duration`
    );
  }
});

test('a drawn entry comes due at its threshold and its own draw', () => {
  for (const state of ['published', 'withdrawn']) {
    const drawn = entry(0, state, 3 * DAY);
    assert.ok(!cache.isStale(drawn, 30 * DAY), `${state} came due on the plain threshold`);
    assert.ok(!cache.isStale(drawn, 33 * DAY - 1), `${state} came due one millisecond early`);
    assert.ok(cache.isStale(drawn, 33 * DAY), `${state} was fresh at thirty-three days`);
  }
  // Jitter applies only to published and withdrawn advisories.
  assert.ok(cache.isStale(entry(0, 'closed', 3 * DAY), 7 * DAY), 'a closed entry took a draw');
});

test('a done advisory refreshes on its own state, not on five minutes', () => {
  /** @type {[string, number][]} */
  const thresholds = [
    ['triage', 5 * MINUTE],
    ['draft', 5 * MINUTE],
    ['closed', 7 * DAY],
    ['published', 30 * DAY],
    ['withdrawn', 30 * DAY],
  ];
  for (const [state, threshold] of thresholds) {
    const held = entry(0, state);
    assert.strictEqual(cache.staleAfter(state), threshold, `the threshold for ${state}`);
    assert.ok(!cache.isStale(held, threshold - 1), `${state} went stale one millisecond early`);
    assert.ok(cache.isStale(held, threshold), `${state} was fresh at its own threshold`);
    assert.strictEqual(
      cache.isStale(held, 60 * MINUTE),
      state === 'triage' || state === 'draft',
      `${state} an hour on`
    );
  }
});

test('an entry naming no state this reader knows refreshes on five minutes', () => {
  assert.strictEqual(cache.staleAfter(null), cache.STALE_MS, 'no state');
  assert.strictEqual(cache.staleAfter('archived'), cache.STALE_MS, 'a state from a later GitHub');
  assert.ok(cache.isStale(entry(0, null), 5 * MINUTE), 'a stateless entry was fresh');
});

test('an entry within its life is read back with what was written', async () => {
  const storage = fakeStorage();
  const record = { state: 'Triage', ghsaId: REF.ghsaId, title: 'A hole' };
  const written = await cache.putAdvisory(REF, record, { storage, at: 1000 });
  assert.ok(written !== null && written.observedAt === 1000, 'the write did not stamp the time');
  assert.ok(written.state === 'triage', `the entry state was ${written?.state}`);

  const held = await cache.getEntry(KEY, { storage, at: 1000 + 4 * MINUTE });
  assert.ok(held !== null, 'the entry was not read back');
  assert.ok(held.observedAt === 1000, `the entry was observed at ${held?.observedAt}`);
  assert.ok(
    /** @type {{ title?: unknown }} */ (held.record).title === 'A hole',
    'the record did not survive the round trip'
  );
  assert.ok(!cache.isStale(held, 1000 + 4 * MINUTE), 'a four-minute-old entry was stale');
});

test('an entry a year old is answered and left in storage', async () => {
  const storage = fakeStorage();
  await cache.putAdvisory(REF, { state: 'triage' }, { storage, at: 0 });
  const held = await cache.getAdvisory(REF, { storage, at: 365 * DAY });
  assert.ok(held !== null, 'a year-old entry was not handed back');
  assert.ok(held.observedAt === 0, `the entry was observed at ${held?.observedAt}`);
  assert.ok(cache.isStale(held, 365 * DAY), 'a year-old triage entry was not stale');
  assert.ok(Object.hasOwn(storage.entries, KEY), 'the entry was taken out of storage');
  assert.deepStrictEqual(storage.removals, [], 'a removal went out for an entry within its life');
  assert.ok((await cache.clear({ storage })) === 1, 'the clear took no entry');
  assert.ok(storage.removals.length === 1, 'the removal went unrecorded');
});

test('many advisories are read in one call, however old they are', async () => {
  const storage = fakeStorage();
  const ids = ['GHSA-aaaa-aaaa-aaaa', 'GHSA-bbbb-bbbb-bbbb', 'GHSA-cccc-cccc-cccc'];
  await cache.putAdvisory({ ...REF, ghsaId: ids[0] }, { state: 'triage' }, { storage, at: 0 });
  await cache.putAdvisory({ ...REF, ghsaId: ids[1] }, { state: 'closed' }, { storage, at: 0 });

  const found = await cache.getAdvisories(REF, ids, { storage, at: 365 * DAY });
  assert.ok(found.size === 2, `${found.size} entries were held`);
  assert.ok(found.has(ids[0] ?? ''), 'the triage entry was dropped at a year old');
  assert.ok(found.has(ids[1] ?? ''), 'the closed entry was dropped at a year old');
  assert.ok(!found.has(ids[2] ?? ''), 'an advisory nothing wrote was handed back');
  assert.ok(storage.reads.length === 1, `storage saw ${storage.reads.length} reads`);
  assert.deepStrictEqual(storage.removals, [], 'a removal went out for an entry read in a pass');
  assert.ok((await cache.clear({ storage })) === 2, 'the clear took neither entry');
  assert.ok(storage.removals.length === 1, 'the removal went unrecorded');
});

test('the list entry and the progress entry round trip', async () => {
  const storage = fakeStorage();
  await cache.putList(REF, { rows: [{ ghsaId: REF.ghsaId }] }, { storage, at: 500 });
  const list = await cache.getList(REF, { storage, at: 600 });
  assert.ok(list !== null && list.observedAt === 500, 'the list entry was not read back');
  assert.ok(list.state === null, `the list entry state was ${list?.state}`);

  await cache.putProgress(REF, { pending: ['GHSA-aaaa-aaaa-aaaa'] }, { storage, at: 500 });
  const progress = await cache.getProgress(REF, { storage, at: 600 });
  const pending = /** @type {{ pending?: unknown }} */ (progress).pending;
  assert.ok(Array.isArray(pending) && pending.length === 1, 'the progress entry was not read back');

  await cache.clearProgress(REF, { storage });
  assert.ok((await cache.getProgress(REF, { storage, at: 600 })) === null, 'progress survived');
});

test('the clear takes the cache and leaves members and branches', async () => {
  const storage = fakeStorage({
    members: { containerd: ['samuelkarp'] },
    branches: { 'containerd/containerd': ['release/2.1'] },
  });
  await cache.putAdvisory(REF, { state: 'triage' }, { storage, at: 0 });
  await cache.putList(REF, { rows: [] }, { storage, at: 0 });
  await cache.putProgress(REF, { pending: [] }, { storage, at: 0 });

  const taken = await cache.clear({ storage });
  assert.ok(taken === 3, `the clear took ${taken} entries`);
  assert.ok(!Object.hasOwn(storage.entries, KEY), 'the advisory entry survived the clear');
  assert.ok(!Object.hasOwn(storage.entries, 'list:containerd/containerd'), 'the list entry survived');
  assert.ok(
    !Object.hasOwn(storage.entries, 'queue:containerd/containerd'),
    'the progress entry survived the clear'
  );
  assert.ok(Object.hasOwn(storage.entries, 'members'), 'the clear took the members entry');
  assert.ok(Object.hasOwn(storage.entries, 'branches'), 'the clear took the branches entry');
});

test('an entry of another shape reads as absent', async () => {
  const storage = fakeStorage({ [KEY]: { record: {}, observedAt: 'lately' } });
  assert.ok((await cache.getEntry(KEY, { storage, at: 0 })) === null, 'a bad entry was handed back');
  assert.ok(cache.entryFrom(null) === null, 'null read as an entry');
  assert.ok(cache.entryFrom({ record: {}, observedAt: 12 }) !== null, 'a good entry read as absent');
});

test('an entry stamped with no real moment reads as absent', async () => {
  const storage = fakeStorage({ [KEY]: { record: { state: 'triage' }, observedAt: Number.NaN } });
  assert.ok(
    (await cache.getEntry(KEY, { storage, at: 40 * DAY })) === null,
    'an entry stamped NaN was handed back'
  );
  assert.ok(cache.entryFrom({ record: {}, observedAt: Number.NaN }) === null, 'NaN read as a time');
  assert.ok(
    cache.entryFrom({ record: {}, observedAt: Number.POSITIVE_INFINITY }) === null,
    'an endless time read as a time'
  );

  // Invalid timestamps can prevent an entry from becoming due for refresh.
  const unreal = { record: {}, observedAt: Number.NaN, state: 'triage' };
  assert.ok(!cache.isStale(unreal, 40 * DAY), 'a NaN stamp read as stale');
});

test('storage failing is an absent entry and an unwritten one', async () => {
  /** @type {import('../src/common/cache.js').CacheStorage} */
  const storage = {
    get: async () => {
      throw new Error('storage is gone');
    },
    set: async () => {
      throw new Error('storage is gone');
    },
    remove: async () => {
      throw new Error('storage is gone');
    },
  };
  assert.ok((await cache.getAdvisory(REF, { storage })) === null, 'a failed read was not absent');
  assert.ok((await cache.putAdvisory(REF, {}, { storage })) === null, 'a failed write reported one');
  assert.ok((await cache.clear({ storage })) === 0, 'a failed clear reported entries taken');
  assert.ok((await cache.getAdvisories(REF, ['GHSA-a'], { storage })).size === 0, 'a failed read');
});

test('the clock is injectable and the entry stamps read from it', async () => {
  const storage = fakeStorage();
  let clock = 10_000;
  cache.setClock(() => clock);
  try {
    const written = await cache.putAdvisory(REF, { state: 'triage' }, { storage });
    assert.ok(written !== null && written.observedAt === 10_000, 'the injected clock was not read');
    clock += 4 * MINUTE;
    const fresh = await cache.getAdvisory(REF, { storage });
    assert.ok(fresh !== null && !cache.isStale(fresh, clock), 'a four-minute-old entry was stale');
    clock += MINUTE;
    const stale = await cache.getAdvisory(REF, { storage });
    assert.ok(stale !== null && cache.isStale(stale, clock), 'a five-minute-old entry was fresh');
  } finally {
    cache.setClock(null);
  }
});

test('the jitter is drawn once, at write time, and held on the entry', async () => {
  const storage = fakeStorage();
  /** @type {number[]} */
  const draws = [0.25, 0.75];
  cache.setClock(() => 0);
  cache.setRandom(() => draws.shift() ?? 0);
  try {
    const other = { ...REF, ghsaId: 'GHSA-dead-beef-cafe' };
    const first = await cache.putAdvisory(REF, { state: 'published' }, { storage });
    const second = await cache.putAdvisory(other, { state: 'published' }, { storage });
    assert.ok(first !== null && first.jitterMs === 1.25 * DAY, `the first drew ${first?.jitterMs}`);
    assert.ok(second !== null && second.jitterMs === 3.75 * DAY, `the second drew ${second?.jitterMs}`);

    // Stored jitter fixes the refresh deadline when the entry is written.
    const stored = storage.entries[KEY];
    const jitterMs = cache.entryFrom(stored)?.jitterMs;
    assert.ok(jitterMs === first.jitterMs, `storage held a draw of ${jitterMs}`);
    cache.setRandom(() => 0.99);
    const reread = await cache.getAdvisory(REF, { storage });
    assert.ok(reread !== null && reread.jitterMs === first.jitterMs, 'the draw moved between reads');

    const open = await cache.putAdvisory(other, { state: 'triage' }, { storage });
    assert.ok(open !== null && open.jitterMs === 0, `a triage entry drew ${open?.jitterMs}`);
  } finally {
    cache.setClock(null);
    cache.setRandom(null);
  }
});

test('a drawn entry read back from storage comes due at its own moment', async () => {
  const storage = fakeStorage();
  let clock = 0;
  cache.setClock(() => clock);
  cache.setRandom(() => 0.5);
  try {
    const written = await cache.putAdvisory(REF, { state: 'published' }, { storage });
    const drew = written?.jitterMs;
    assert.ok(written !== null && drew === 2.5 * DAY, `the entry drew ${drew}`);
    clock = 32.5 * DAY - 1;
    const before = await cache.getAdvisory(REF, { storage });
    assert.ok(before !== null && !cache.isStale(before, clock), 'came due one millisecond early');
    clock = 32.5 * DAY;
    const after = await cache.getAdvisory(REF, { storage });
    assert.ok(after !== null && cache.isStale(after, clock), 'was fresh at its own moment');
    assert.ok(Object.hasOwn(storage.entries, KEY), 'a due entry was taken out of storage');
  } finally {
    cache.setClock(null);
    cache.setRandom(null);
  }
});

test('an entry written before the draw comes due on the plain threshold', async () => {
  const held = { record: { state: 'published' }, observedAt: 0, state: 'published' };
  const early = fakeStorage({ [KEY]: { ...held } });
  const inside = await cache.getEntry(KEY, { storage: early, at: 30 * DAY - 1 });
  assert.ok(inside !== null, 'an entry carrying no draw was not handed back');
  assert.ok(inside.jitterMs === 0, `a missing draw read as ${inside?.jitterMs}`);
  assert.ok(!cache.isStale(inside, 30 * DAY - 1), 'it came due one millisecond early');
  assert.ok(cache.isStale(inside, 30 * DAY), 'an entry carrying no draw was fresh at thirty days');

  // Invalid jitter values can prevent an entry from becoming due for refresh.
  const unreal = fakeStorage({ [KEY]: { ...held, jitterMs: Number.NaN } });
  const read = await cache.getEntry(KEY, { storage: unreal, at: 30 * DAY });
  assert.ok(read !== null, 'an entry carrying a NaN draw was not handed back');
  assert.ok(cache.isStale(read, 30 * DAY), 'an entry carrying a NaN draw was fresh at thirty days');
});

test('counting a 404 against an advisory the cache does not hold does nothing', async () => {
  const storage = fakeStorage();
  const counted = await cache.noteMissing(REF, { storage, at: 0 });
  assert.deepStrictEqual(counted, { misses: 0, evicted: false });
  assert.deepStrictEqual(storage.removals, [], 'a removal went out for an entry nothing holds');

  await cache.noteMissing(REF, { storage, at: 0 });
  const third = await cache.noteMissing(REF, { storage, at: 0 });
  assert.ok(!third.evicted, 'an advisory the cache does not hold was evicted');

  await cache.putAdvisory(REF, { state: 'triage' }, { storage, at: 0 });
  assert.ok((await cache.clear({ storage })) === 1, 'the clear took no entry');
  assert.ok(storage.removals.length === 1, 'the removal went unrecorded');
});

test('three 404s in a row take the advisory out of the cache', async () => {
  // Eviction ends retries for deleted or withdrawn advisories.
  const storage = fakeStorage();
  await cache.putAdvisory(REF, { state: 'triage' }, { storage, at: 0 });

  const first = await cache.noteMissing(REF, { storage, at: MINUTE });
  assert.deepStrictEqual(first, { misses: 1, evicted: false });
  assert.strictEqual(
    (await cache.getAdvisory(REF, { storage, at: MINUTE }))?.misses,
    1,
    'the first 404 was not counted onto the entry'
  );

  const second = await cache.noteMissing(REF, { storage, at: 2 * MINUTE });
  assert.deepStrictEqual(second, { misses: 2, evicted: false });
  assert.ok(
    (await cache.getAdvisory(REF, { storage, at: 2 * MINUTE })) !== null,
    'the entry went on the second 404'
  );
  assert.deepStrictEqual(storage.removals, [], 'a removal went out before the third 404');

  const third = await cache.noteMissing(REF, { storage, at: 3 * MINUTE });
  assert.deepStrictEqual(third, { misses: 3, evicted: true });
  assert.strictEqual(
    await cache.getAdvisory(REF, { storage, at: 3 * MINUTE }),
    null,
    'the entry survived three 404s in a row'
  );
  assert.deepStrictEqual(storage.removals, [[KEY]], 'the eviction named another key');

  assert.deepStrictEqual(await cache.noteMissing(REF, { storage, at: 4 * MINUTE }), {
    misses: 0,
    evicted: false,
  });
});

test('a read between two 404s puts the count back to nothing', async () => {
  const storage = fakeStorage();
  await cache.putAdvisory(REF, { state: 'triage' }, { storage, at: 0 });
  await cache.noteMissing(REF, { storage, at: MINUTE });
  await cache.noteMissing(REF, { storage, at: 2 * MINUTE });

  await cache.putAdvisory(REF, { state: 'triage' }, { storage, at: 3 * MINUTE });
  assert.strictEqual(
    (await cache.getAdvisory(REF, { storage, at: 3 * MINUTE }))?.misses,
    0,
    'a page that came back left the count where it was'
  );

  const next = await cache.noteMissing(REF, { storage, at: 4 * MINUTE });
  assert.deepStrictEqual(next, { misses: 1, evicted: false }, 'the run was not broken');
  assert.deepStrictEqual(storage.removals, [], 'the entry was evicted on one 404');
});

test('counting a 404 the storage will not hold leaves the entry', async () => {
  const storage = fakeStorage();
  await cache.putAdvisory(REF, { state: 'triage' }, { storage, at: 0 });
  storage.set = async () => {
    throw new Error('QuotaExceededError');
  };
  const counted = await cache.noteMissing(REF, { storage, at: MINUTE });
  assert.deepStrictEqual(counted, { misses: 1, evicted: false });
  const held = await cache.getAdvisory(REF, { storage, at: MINUTE });
  assert.ok(held !== null, 'a count that could not be written took the entry');
  assert.strictEqual(held.misses, 0, 'a count that could not be written was read back');
});
