/**
 * Content scripts share their exports through this global namespace.
 * They run as classic scripts in the same isolated world.
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
  duplicate: typeof import('../src/common/duplicate.js');
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
  prLayout: typeof import('../src/common/pr-layout.js');
  content: typeof import('../src/content.js');
}

declare var bghsa: BghsaNamespace;
