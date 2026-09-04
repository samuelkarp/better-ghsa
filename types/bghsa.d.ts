/**
 * The shared namespace every content script hangs its exports off. Content
 * scripts are classic scripts in one isolated world, so they reach each other
 * through this global.
 */
interface BghsaNamespace {
  dom: typeof import('../src/common/dom.js');
  text: typeof import('../src/common/text.js');
  storage: typeof import('../src/common/storage.js');
  allowlist: typeof import('../src/common/allowlist.js');
  settingsControl: typeof import('../src/common/settings-control.js');
  trust: typeof import('../src/common/trust.js');
  schema: typeof import('../src/common/schema.js');
  merge: typeof import('../src/common/merge.js');
  parseDetail: typeof import('../src/common/parse-detail.js');
  parseList: typeof import('../src/common/parse-list.js');
  record: typeof import('../src/common/record.js');
  derive: typeof import('../src/common/derive.js');
  order: typeof import('../src/common/order.js');
  chips: typeof import('../src/common/chips.js');
  row: typeof import('../src/common/row.js');
  members: typeof import('../src/common/members.js');
  branches: typeof import('../src/common/branches.js');
  cache: typeof import('../src/common/cache.js');
  forget: typeof import('../src/common/forget.js');
  write: typeof import('../src/common/write.js');
  fetch: typeof import('../src/common/fetch.js');
  crawl: typeof import('../src/common/crawl.js');
  tracking: typeof import('../src/detail/tracking.js');
  comments: typeof import('../src/detail/comments.js');
  preserve: typeof import('../src/detail/preserve.js');
  state: typeof import('../src/detail/state.js');
  edit: typeof import('../src/detail/edit.js');
  panel: typeof import('../src/detail/panel.js');
  table: typeof import('../src/list/table.js');
  corpus: typeof import('../src/done/corpus.js');
  stats: typeof import('../src/done/stats.js');
  csv: typeof import('../src/done/csv.js');
  view: typeof import('../src/done/view.js');
  statistics: typeof import('../src/stats/statistics.js');
  content: typeof import('../src/content.js');
}

declare var bghsa: BghsaNamespace;
