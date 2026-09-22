'use strict';

/**
 * @typedef {object} FakeStorage
 * @property {Record<string, unknown>} entries The current stored values.
 * @property {(string | string[] | null | undefined)[]} reads The keys requested by each get.
 * @property {Record<string, unknown>[]} writes A copy of each set argument.
 * @property {(string | string[])[]} removals The keys requested by each remove.
 * @property {(keys: string | string[] | null | undefined) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 */

/**
 * Simulate browser.storage.local with structured clones on reads and writes.
 * get(null) returns all entries. Methods can be replaced to simulate failures.
 *
 * @param {Record<string, unknown>} [held] The initial stored values.
 * @returns {FakeStorage}
 */
function fakeStorage(held = {}) {
  /** @type {Record<string, unknown>} */
  const entries = structuredClone(held);
  /** @type {(string | string[] | null | undefined)[]} */
  const reads = [];
  /** @type {Record<string, unknown>[]} */
  const writes = [];
  /** @type {(string | string[])[]} */
  const removals = [];
  return {
    entries,
    reads,
    writes,
    removals,
    get: async (keys) => {
      reads.push(keys);
      if (keys === null || keys === undefined) return structuredClone(entries);
      /** @type {Record<string, unknown>} */
      const answer = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (Object.hasOwn(entries, key)) answer[key] = structuredClone(entries[key]);
      }
      return answer;
    },
    set: async (items) => {
      writes.push(structuredClone(items));
      Object.assign(entries, structuredClone(items));
    },
    remove: async (keys) => {
      removals.push(keys);
      for (const key of Array.isArray(keys) ? keys : [keys]) delete entries[key];
    },
  };
}

module.exports = { fakeStorage };
