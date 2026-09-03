/**
 * 直播场次状态机回归测试（Node vm 等价 realm，无需登录/浏览器）
 * ---------------------------------------------------------------
 * 回归背景：旧逻辑每轮扫描对直播中的 UP 无条件 unread=true +
 * lastPubTs=Date.now()，导致蓝点点掉后 30 秒必复活。
 * 新逻辑：仅「新场次」（下播→开播跳变 / 场次键变化）才重新点亮。
 *
 * 覆盖场景：
 *   1. 首次开播点亮，场次键/lastPubTs 正确
 *   2. 同场次内点掉已读 → 多轮扫描不复活、lastPubTs 不膨胀
 *   3. 下播 → 未读清除
 *   4. 新场次（live_start_time 变化）→ 重新点亮
 *   5. 无 live_start_time 时：接口抖动（宽限期内）不误判新场次
 *   6. 无 live_start_time 时：超出宽限期再开播 → 判定新场次点亮
 *   7. cleanup() 无异常，persist 与 SCAN_DONE 正常执行
 *
 * 用法：node scripts/test-live-session.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'src/injected/scanner.js'), 'utf8');

let failCnt = 0;
let passCnt = 0;
function expect(cond, label) {
  if (cond) {
    passCnt++;
    console.log('  OK  ' + label);
  } else {
    failCnt++;
    console.log('  FAIL  ' + label);
  }
}

/**
 * 构建等价 realm 并加载 scanner.js。
 * liveRooms / feedItems 可在每轮扫描前替换，模拟开播/下播/接口抖动。
 */
function makeRealm() {
  const NS = {
    state: {
      config: { enabled: true },
      // 预置基线与游标，避免走进「首轮基线」分支
      meta: { baselineDone: true, lastScanAt: 1, seenIds: ['seed1'], tsById: {} },
      updates: {},
    },
    kindOf(type) {
      if (type === 'DYNAMIC_TYPE_AV') return 'av';
      if (type === 'DYNAMIC_TYPE_LIVE') return 'live';
      if (type === 'DYNAMIC_TYPE_DRAW') return 'draw';
      return 'other';
    },
    typeEnabled() {
      return true;
    },
    logs: [],
    log(...args) {
      NS.logs.push(args.join(' '));
    },
    api: {
      // feed 流只回一条已见过的种子动态，让翻页立即停止
      async getFeedPage() {
        return {
          code: 0,
          data: {
            has_more: false,
            items: [
              {
                id_str: 'seed1',
                type: 'DYNAMIC_TYPE_AV',
                modules: {
                  module_author: { mid: 1, name: '种子', pub_ts: 1000, pub_time: '1970-01-01 00:16' },
                },
              },
            ],
          },
        };
      },
      // 每个用例自行覆写
      async getLiveRooms() {
        return { code: 0, data: { list: [] } };
      },
    },
    bridge: {
      saved: 0,
      events: [],
      async call(type) {
        if (type === 'SAVE_STATE') NS.bridge.saved++;
        return true;
      },
      emit(type, payload) {
        NS.bridge.events.push({ type, payload });
      },
    },
  };

  const sandbox = {
    window: { __BiliAllUpDot: NS },
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'scanner.js' });
  return NS;
}

function liveRoom(overrides) {
  return Object.assign(
    {
      live_status: 1,
      uid: 5001,
      uname: '不死鸟总监',
      face: 'https://i0.hdslb.com/bfs/face/live.jpg',
      title: '测试直播',
      roomid: 777,
      // 用最近的开播时刻：太旧会被 cleanup() 按 90 天保留期淘汰，干扰用例
      live_start_time: Math.floor(Date.now() / 1000) - 3600,
    },
    overrides || {}
  );
}

function setLive(NS, rooms) {
  NS.api.getLiveRooms = async () => ({ code: 0, data: { list: rooms } });
}

async function scan(NS, label) {
  const r = await NS.scan(label || 'test');
  if (r === null) throw new Error('扫描异常（被 catch 吞掉），日志：' + NS.logs.join(' | '));
  return r;
}

const rec = (NS) => NS.state.updates['5001'];

// ---------------- 用例 1：首次开播点亮 ----------------
console.log('\n[1] 首次开播：点亮一次，场次键=live_start_time');
{
  const NS = makeRealm();
  const T0 = Math.floor(Date.now() / 1000) - 3600;
  setLive(NS, [liveRoom()]);
  await scan(NS);
  const r = rec(NS);
  expect(!!r && r.unread === true, '开播后 unread=true');
  expect(r.liveSessionKey === 's' + T0, '场次键 = s<live_start_time>');
  expect(r.lastPubTs === T0, 'lastPubTs = 开播时刻（非扫描时刻）');
  expect(r.liveUp === true, 'liveUp 置位');
}

// ---------------- 用例 2：同场次点掉后多轮扫描不复活 ----------------
console.log('\n[2] 同场次：点掉已读 → 连续 5 轮扫描不复活、lastPubTs 不膨胀');
{
  const NS = makeRealm();
  setLive(NS, [liveRoom()]);
  await scan(NS);

  // 模拟 markRead（read-tracker 逻辑）：readAtTs = lastPubTs（稳定值）
  const r0 = rec(NS);
  r0.unread = false;
  r0.seenAt = Date.now();
  r0.readAtTs = r0.lastPubTs;
  const savedLastPubTs = r0.lastPubTs;

  for (let i = 0; i < 5; i++) {
    await scan(NS, '轮次' + i);
  }
  const r = rec(NS);
  expect(r.unread === false, '5 轮扫描后仍未读=false（蓝点不复活）');
  expect(r.lastPubTs === savedLastPubTs, 'lastPubTs 不随扫描时刻膨胀');
  expect(r.liveUp === true, 'liveUp 保持 true（同场次在线）');
}

// ---------------- 用例 3：下播清除未读 ----------------
console.log('\n[3] 下播：未读清除、liveUp 复位、记录下播时刻');
{
  const NS = makeRealm();
  setLive(NS, [liveRoom()]);
  await scan(NS);
  setLive(NS, []); // 下播
  await scan(NS);
  const r = rec(NS);
  expect(r.unread === false, '下播后 unread=false');
  expect(r.liveUp === false, 'liveUp=false');
  expect(typeof r.liveDownAt === 'number' && r.liveDownAt > 0, '记录 liveDownAt');
}

// ---------------- 用例 4：新场次（live_start_time 变化）重新点亮 ----------------
console.log('\n[4] 新场次：live_start_time 变化 → 重新点亮');
{
  const NS = makeRealm();
  const T0 = Math.floor(Date.now() / 1000) - 7200;
  setLive(NS, [liveRoom({ live_start_time: T0 })]);
  await scan(NS);
  const r0 = rec(NS);
  r0.unread = false; // 用户点掉
  r0.readAtTs = r0.lastPubTs;

  const T1 = T0 + 3600; // 一小时后的新一场
  setLive(NS, [liveRoom({ live_start_time: T1 })]);
  await scan(NS);
  const r = rec(NS);
  expect(r.unread === true, '新场次 unread=true（重新点亮）');
  expect(r.liveSessionKey === 's' + T1, '场次键更新为新开播时刻');
  expect(r.lastPubTs === T1, 'lastPubTs 更新为新场次开播时刻');
}

// ---------------- 用例 5：无 start_ts + 接口抖动（宽限期内）不误判 ----------------
console.log('\n[5] 无 live_start_time：下播又立即出现（宽限期内）→ 同场次不复活');
{
  const NS = makeRealm();
  setLive(NS, [liveRoom({ live_start_time: undefined })]);
  await scan(NS);
  const r0 = rec(NS);
  expect(!!r0.liveSessionKey, '兜底场次键已写入（' + r0.liveSessionKey + '）');
  r0.unread = false;
  r0.readAtTs = r0.lastPubTs;

  setLive(NS, []); // 瞬时从列表消失
  await scan(NS);
  setLive(NS, [liveRoom({ live_start_time: undefined })]); // 下一轮又出现
  await scan(NS);
  const r = rec(NS);
  expect(r.unread === false, '宽限期内视为同场次，不重新点亮');
  expect(r.liveSessionKey === r0.liveSessionKey, '场次键不变');
}

// ---------------- 用例 6：无 start_ts + 超出宽限期 → 新场次点亮 ----------------
console.log('\n[6] 无 live_start_time：超出宽限期再开播 → 判定新场次');
{
  const NS = makeRealm();
  setLive(NS, [liveRoom({ live_start_time: undefined })]);
  await scan(NS);
  const r0 = rec(NS);
  const key0 = r0.liveSessionKey; // 字符串快照（r0 与后续 rec() 是同一引用）
  r0.unread = false;
  r0.readAtTs = r0.lastPubTs;

  setLive(NS, []);
  await scan(NS);
  // 把下播时刻拨回 11 分钟前，模拟超出 10 分钟宽限期
  rec(NS).liveDownAt = Math.floor(Date.now() / 1000) - 660;
  setLive(NS, [liveRoom({ live_start_time: undefined })]);
  await scan(NS);
  const r = rec(NS);
  expect(r.unread === true, '超出宽限期 → 新场次，重新点亮');
  expect(r.liveSessionKey !== key0, '场次键已更换');
}

// ---------------- 用例 7：cleanup 无异常、persist 与 SCAN_DONE 执行 ----------------
console.log('\n[7] 扫描链路完整：cleanup 无 ReferenceError、persist 与 SCAN_DONE 执行');
{
  const NS = makeRealm();
  // 塞满时间戳缓存，触发 cleanup 的 tsById 淘汰分支（旧代码在此抛 ReferenceError）
  for (let i = 0; i < 3010; i++) NS.state.meta.tsById['9' + String(i).padStart(10, '0')] = 1000 + i;
  setLive(NS, [liveRoom()]);
  const r = await scan(NS);
  expect(r !== null, '扫描正常返回（无扫描异常）');
  expect(NS.bridge.saved > 0, 'persist（SAVE_STATE）被调用');
  const done = NS.bridge.events.find((e) => e.type === 'SCAN_DONE');
  expect(!!done, 'SCAN_DONE 事件已发出（立即刷新按钮依赖它）');
  expect(Object.keys(NS.state.meta.tsById).length <= 3000, 'tsById 缓存淘汰生效');
  const crashed = NS.logs.some((l) => l.indexOf('扫描异常') !== -1);
  expect(!crashed, '日志中无「扫描异常」');
}

// ---------------- 用例 8：正在直播时发表新动态 → 动态分支正常点亮 ----------------
console.log('\n[8] 兼容：直播 UP 同时有新动态 → 动态分支照常点亮（直播状态不覆盖）');
{
  const NS = makeRealm();
  const now = Math.floor(Date.now() / 1000);
  setLive(NS, [liveRoom()]);
  // feed 里塞一条 5001 的新动态（比已读进度新）
  NS.api.getFeedPage = async () => ({
    code: 0,
    data: {
      has_more: false,
      items: [
        {
          id_str: 'seed1',
          type: 'DYNAMIC_TYPE_AV',
          modules: { module_author: { mid: 1, name: '种子', pub_ts: 1000 } },
        },
        {
          id_str: '100000000000000001',
          type: 'DYNAMIC_TYPE_AV',
          modules: {
            module_author: { mid: 5001, name: '不死鸟总监', pub_ts: now - 30, face: NS.state.updates['5001'] ? NS.state.updates['5001'].face : '' },
          },
        },
      ],
    },
  });
  await scan(NS, '先建直播档');
  rec(NS).unread = false;
  rec(NS).readAtTs = rec(NS).lastPubTs;
  // 第二轮：更晚的新动态
  NS.api.getFeedPage = async () => ({
    code: 0,
    data: {
      has_more: false,
      items: [
        {
          id_str: 'seed1',
          type: 'DYNAMIC_TYPE_AV',
          modules: { module_author: { mid: 1, name: '种子', pub_ts: 1000 } },
        },
        {
          id_str: '100000000000000002',
          type: 'DYNAMIC_TYPE_AV',
          modules: { module_author: { mid: 5001, name: '不死鸟总监', pub_ts: now + 60 } },
        },
      ],
    },
  });
  await scan(NS, '新动态');
  const r = rec(NS);
  expect(r.unread === true, '新动态点亮（动态不被直播状态吞掉）');
  expect(r.lastPubTs === now + 60, 'lastPubTs 跟随新动态时间');
}

// ---------------- 用例 9：时效护栏（72h 窗口）----------------
console.log('\n[9] 时效护栏：刚关注 UP 的旧动态不点亮，新动态正常点亮');
{
  const NS = makeRealm();
  const now = Math.floor(Date.now() / 1000);
  NS.api.getFeedPage = async () => ({
    code: 0,
    data: {
      has_more: false,
      items: [
        {
          id_str: 'seed1',
          type: 'DYNAMIC_TYPE_AV',
          modules: { module_author: { mid: 1, name: '种子', pub_ts: 1000 } },
        },
        {
          // 6 天前的旧动态：只建档，不点亮
          id_str: '100000000000000011',
          type: 'DYNAMIC_TYPE_AV',
          modules: { module_author: { mid: 6001, name: 'EdmundDZhang', pub_ts: now - 6 * 86400 } },
        },
        {
          // 1 小时前的新动态：正常点亮
          id_str: '100000000000000012',
          type: 'DYNAMIC_TYPE_AV',
          modules: { module_author: { mid: 6002, name: '新动态UP', pub_ts: now - 3600 } },
        },
        {
          // 无时间戳的条目：保守处理，不点亮
          id_str: '100000000000000013',
          type: 'DYNAMIC_TYPE_AV',
          modules: { module_author: { mid: 6003, name: '无时间UP', pub_ts: undefined, pub_time: '' } },
        },
      ],
    },
  });
  await scan(NS, '时效护栏');
  const old = NS.state.updates['6001'];
  const fresh = NS.state.updates['6002'];
  const noTs = NS.state.updates['6003'];
  expect(!!old && old.unread === false, '6 天前的旧动态：建档但不点亮（EdmundDZhang 场景）');
  expect(!!fresh && fresh.unread === true, '1 小时前的新动态：正常点亮');
  expect(!!noTs && noTs.unread === false, '无时间戳条目：不点亮（保守）');
  expect(
    NS.logs.some((l) => l.indexOf('跳过 2 条超窗旧动态') !== -1),
    '扫描日志报告跳过的超窗条数'
  );
}

// ---------------- 用例 10：自愈：历史错误点亮的超窗未读自动熄灭 ----------------
console.log('\n[10] 自愈：超窗旧未读自动熄灭，直播未读不受影响');
{
  const NS = makeRealm();
  const now = Math.floor(Date.now() / 1000);
  // 模拟旧版本残留：17 天前被错误点亮且未读（骚饼赛赛场景）
  NS.state.updates['7001'] = {
    mid: '7001', name: '骚饼赛赛', face: 'https://i0.hdslb.com/bfs/face/s.jpg',
    lastPubTs: now - 17 * 86400, type: 'DYNAMIC_TYPE_AV', kind: 'av',
    unread: true, seenAt: 0,
  };
  // 直播中点亮记录：自愈不得触碰（由下播逻辑负责）
  NS.state.updates['7002'] = {
    mid: '7002', name: '直播UP', face: '',
    lastPubTs: now - 10 * 86400, type: 'DYNAMIC_TYPE_LIVE', kind: 'live',
    unread: true, seenAt: 0, liveUp: true, liveSessionKey: 's' + (now - 3600),
  };
  setLive(NS, [liveRoom({ uid: 7002, uname: '直播UP', live_start_time: now - 3600 })]);
  await scan(NS, '自愈');
  expect(NS.state.updates['7001'].unread === false, '17 天前错误点亮的未读被自动熄灭（骚饼赛赛场景）');
  expect(NS.state.updates['7002'].unread === true, '直播中的未读不受自愈影响');
  expect(
    NS.logs.some((l) => l.indexOf('自动熄灭超窗旧未读：骚饼赛赛') !== -1),
    '自愈动作有日志'
  );
}

// ---------------- 用例 11：直播提醒关闭 → 不点亮 + 清残留 ----------------
console.log('\n[11] 直播提醒关闭：直播不再点亮，残留直播未读被清除');
{
  const NS = makeRealm();
  const now = Math.floor(Date.now() / 1000);
  NS.typeEnabled = function (k) {
    return k !== 'live';
  };
  // 残留：直播开着时点亮的记录
  NS.state.updates['8001'] = {
    mid: '8001', name: '虾仁不眨眼', face: '',
    lastPubTs: now - 3600, type: 'DYNAMIC_TYPE_LIVE', kind: 'live',
    unread: true, seenAt: 0, liveUp: true, liveSessionKey: 's' + (now - 3600),
  };
  setLive(NS, [liveRoom({ uid: 8001, uname: '虾仁不眨眼', live_start_time: now - 3600 })]);
  await scan(NS, '直播关闭');
  expect(NS.state.updates['8001'].unread === false, '关闭直播后残留未读被自动清除');
}

console.log('\n===== 结果：' + passCnt + ' 通过 / ' + failCnt + ' 失败 =====');
process.exit(failCnt > 0 ? 1 : 0);
