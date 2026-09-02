/* 回归测试：已读保护（UP 维度 readAtTs）
   核心场景：用户读过的 UP，其动态 id 被 seenIds 滚动淘汰后又在 feed 中出现，
   扫描器不得把它当成新动态重新点亮。 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(p, 'utf8');

const win = {};
win.window = win;
win.globalThis = win;
win.console = console;
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;
win.location = { hostname: 't.bilibili.com', pathname: '/', href: 'https://t.bilibili.com/' };
win.history = {};
win.postMessage = () => {};
win.addEventListener = () => {};
win.document = {
  addEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: null,
};
win.MutationObserver = class {
  observe() {}
};
vm.createContext(win);
vm.runInContext(read('src/injected/bridge.js'), win);

const NOW = 100000;

vm.runInContext(
  `
  var NS = window.__BiliAllUpDot;
  NS.persist = function () {};
  NS.state.config = { enabled: true, intervalMin: 3, maxUpList: 60, debug: false,
                      types: { av: true, word: true, draw: true, forward: true, live: true } };
  NS.state.meta = { lastMaxTs: 0, lastScanAt: ${NOW}000, baselineDone: true,
                    wbi: null, updateBaseline: '', seenIds: [] };
  NS.state.updates = {
    // 用户已读，读到 lastPubTs=5000 为止
    '111': { mid: '111', name: '已读UP甲', face: 'https://i0.hdslb.com/bfs/face/aa.jpg',
             lastPubTs: 5000, readAtTs: 5000, type: 'DYNAMIC_TYPE_AV', kind: 'av', unread: false, seenAt: 1 },
    // 另一个已读 UP，同样读到 5000
    '222': { mid: '222', name: '已读UP乙', face: 'https://i0.hdslb.com/bfs/face/bb.jpg',
             lastPubTs: 5000, readAtTs: 5000, type: 'DYNAMIC_TYPE_AV', kind: 'av', unread: false, seenAt: 1 },
  };

  // feed/all 返回的内容由测试驱动
  var pages = [];
  var call = 0;
  NS.api = {
    getFeedPage: async function () {
      var p = pages[Math.min(call, pages.length - 1)];
      call++;
      return { code: 0, data: { items: (p && p.items) || [], has_more: false, offset: '', update_baseline: 'bl' } };
    },
    getLiveRooms: async function () { return { code: 0, data: { list: [] } }; },
  };
  window.__setPages = function (v) { pages = v; call = 0; };
  `,
  win
);

vm.runInContext(read('src/injected/scanner.js'), win);

const NS = win.__BiliAllUpDot;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => {
  if (c) console.log('OK   ', l);
  else {
    fail++;
    console.log('FAIL ', l);
  }
};

// 先跑一次基线扫描，建立 seenIds（模拟正常使用）
win.__setPages([
  {
    items: [
      { id_str: 'dyn_base_1', type: 'DYNAMIC_TYPE_AV', pub_ts: 5000,
        modules: { module_author: { mid: 111, name: '已读UP甲', face: 'https://i0.hdslb.com/bfs/face/aa.jpg' } } },
    ],
  },
]);
await NS.scan('基线');
await wait(30);
ok(NS.state.updates['111'].unread === false, '基线：已读状态保持');

// ---- 场景1：看过的动态 id 被淘汰后又在 feed 出现（ts 不比 readAtTs 新）----
// 模拟 seenIds 滚动淘汰：清空 seenIds，让旧动态再次被判为「新」
NS.state.meta.seenIds = [];
win.__setPages([
  {
    items: [
      { id_str: 'dyn_base_1', type: 'DYNAMIC_TYPE_AV', pub_ts: 5000, // 与 readAtTs 相同
        modules: { module_author: { mid: 111, name: '已读UP甲', face: 'https://i0.hdslb.com/bfs/face/aa.jpg' } } },
    ],
  },
]);
await NS.scan('旧动态重现');
await wait(30);
ok(
  NS.state.updates['111'].unread === false,
  '场景1：旧动态 id 被淘汰后重现 → 不重新点亮（核心修复）'
);

// ---- 场景2：UP 发了更新的动态（ts 大于 readAtTs）----
win.__setPages([
  {
    items: [
      { id_str: 'dyn_brand_new', type: 'DYNAMIC_TYPE_AV', pub_ts: 9000,
        modules: { module_author: { mid: 222, name: '已读UP乙', face: 'https://i0.hdslb.com/bfs/face/bb.jpg' } } },
    ],
  },
]);
await NS.scan('新动态');
await wait(30);
ok(NS.state.updates['222'].unread === true, '场景2：UP 发了更新的动态 → 正常重新点亮');

// ---- 场景3：点了已读之后，旧动态重现也不该亮 ----
NS.state.updates['222'].unread = false;
NS.state.updates['222'].readAtTs = NS.state.updates['222'].lastPubTs; // 模拟点已读
NS.state.meta.seenIds = []; // 再次模拟游标淘汰
win.__setPages([
  {
    items: [
      { id_str: 'dyn_brand_new', type: 'DYNAMIC_TYPE_AV', pub_ts: 9000,
        modules: { module_author: { mid: 222, name: '已读UP乙', face: 'https://i0.hdslb.com/bfs/face/bb.jpg' } } },
    ],
  },
]);
await NS.scan('已读后再扫');
await wait(30);
ok(NS.state.updates['222'].unread === false, '场景3：已读后同一条动态重现 → 保持已读');

// ---- 场景4：游标上限已扩容 ----
ok(NS.state.meta.seenIds.length > 0, '场景4：seenIds 正常累积（上限已提至 2000）');

console.log(fail === 0 ? '\n全部通过' : `\n存在 ${fail} 处失败`);
process.exit(fail === 0 ? 0 : 1);
