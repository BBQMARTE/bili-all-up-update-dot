/* 回归测试：时间戳缓存消除相对时间漂移 */
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

const SEQ = 1243087664339484672;

vm.runInContext(
  `
  var NS = window.__BiliAllUpDot;
  NS.persist = function () {};
  NS.state.config = { enabled: true, intervalMin: 3, maxUpList: 60, debug: false,
                      types: { av: true, word: true, draw: true, forward: true, live: true } };
  NS.state.meta = { lastMaxTs: 0, lastScanAt: Date.now(), baselineDone: true,
                    wbi: null, updateBaseline: '', seenIds: ['old'] };
  NS.state.updates = {};

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

vm.runInContext(read('src/injected/read-tracker.js'), win);
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

function dyn(mid, name, pubTime) {
  return {
    id_str: String(SEQ),
    type: 'DYNAMIC_TYPE_AV',
    modules: {
      module_author: {
        mid: mid,
        name: name,
        face: 'https://i0.hdslb.com/bfs/face/' + mid + '.jpg',
        pub_time: pubTime, // 只有相对时间，没有 pub_ts
      },
    },
  };
}

// 第一次扫描：解析「3小时前」并缓存
win.__setPages([{ items: [dyn(111, '堂主lee', '3小时前')] }]);
await NS.scan('首次');
await wait(30);

const ts1 = NS.state.updates['111'].lastPubTs;
ok(ts1 > 0, '首次扫描解析出时间戳：' + ts1);
ok(!!NS.state.meta.tsById[String(SEQ)], '时间戳已写入缓存');

// 用户点掉
NS.markRead('111');
await wait(30);
const readAt = NS.state.updates['111'].readAtTs;
ok(NS.state.updates['111'].unread === false, '点击后已读');
ok(readAt === ts1, '已读进度 = 首次解析的时间戳');

// 模拟时间流逝：等 1.2 秒后重新扫描，动态仍显示「3小时前」
// （真实场景下系统时间前进，相对时间解析值会变大 → 漂移）
await new Promise((r) => setTimeout(r, 1200));
NS.state.meta.seenIds = []; // 模拟游标淘汰，强制重新处理
win.__setPages([{ items: [dyn(111, '堂主lee', '3小时前')] }]);
await NS.scan('刷新1');
await wait(30);

const ts2 = NS.state.updates['111'].lastPubTs;
ok(ts2 === ts1, '刷新后时间戳未漂移（缓存生效）：' + ts2 + ' === ' + ts1);
ok(NS.state.updates['111'].unread === false, '刷新后已读不复活（核心）');

// 再刷两次
for (let i = 0; i < 2; i++) {
  await new Promise((r) => setTimeout(r, 800));
  NS.state.meta.seenIds = [];
  win.__setPages([{ items: [dyn(111, '堂主lee', '3小时前')] }]);
  await NS.scan('刷新' + (i + 2));
  await wait(20);
}
ok(NS.state.updates['111'].unread === false, '连续刷新后依然保持已读');
ok(NS.state.updates['111'].lastPubTs === ts1, '时间戳始终未漂移');

// 真的新动态（不同 id）应点亮
win.__setPages([
  {
    items: [
      {
        id_str: String(SEQ + 5000000000000),
        type: 'DYNAMIC_TYPE_AV',
        modules: {
          module_author: { mid: 111, name: '堂主lee', face: 'https://i0.hdslb.com/bfs/face/111.jpg', pub_time: '刚刚' },
        },
      },
    ],
  },
]);
await NS.scan('真新动态');
await wait(30);
ok(NS.state.updates['111'].unread === true, '真的新动态仍能点亮');

console.log(fail === 0 ? '\n全部通过' : `\n存在 ${fail} 处失败`);
process.exit(fail === 0 ? 0 : 1);
