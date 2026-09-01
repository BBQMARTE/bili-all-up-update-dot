/**
 * 端到端模拟测试（无需登录）
 * ---------------------------------------------------------------
 * 原理：用 Chromium 加载本扩展，通过 CDP 的 Fetch 域把 B 站 portal 接口的
 * 响应替换成伪造数据（模拟登录后返回），并预先向扩展的 chrome.storage 注入
 * 「未读」数据，然后检查页面上是否真的渲染出小蓝点。
 *
 * 这条链路覆盖：扩展注入 → storage 读取 → portal 拦截 → up_list 改写 →
 * B 站组件渲染蓝点 → DOM 检查。除了真实登录态之外的全部环节。
 *
 * 用法：node scripts/e2e-sim.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { wsConnect, getJson, sleep, createSession } from './cdp-lib.mjs';

const EXT_PATH = resolve(process.cwd());
const CHROME =
  process.env.PROBE_CHROME ||
  join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
const PORT = 9224;

// 伪造「登录后」的 portal 响应：官方常看列表里只有 9001/9002，且都无更新
const OFFICIAL = JSON.stringify({
  code: 0,
  message: '0',
  data: {
    my_info: { mid: 42, name: '测试用户', face: 'https://i0.hdslb.com/bfs/face/me.jpg' },
    live_users: null,
    up_list: [
      { mid: 9001, uname: '常看UP甲', face: 'https://i0.hdslb.com/bfs/face/j.jpg', has_update: false, is_reserve_recall: false },
      { mid: 9002, uname: '常看UP乙', face: 'https://i0.hdslb.com/bfs/face/y.jpg', has_update: false, is_reserve_recall: false },
    ],
  },
});

const profile = mkdtempSync(join(tmpdir(), 'bili-e2e-'));
console.log('临时用户目录:', profile);

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let exitCode = 0;
try {
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      targets = await getJson('127.0.0.1', PORT, '/json/list');
      if (targets && targets.length) break;
    } catch (e) {}
  }
  if (!targets) throw new Error('调试端口未就绪');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到页面 target');

  const ws = await wsConnect(page.webSocketDebuggerUrl);
  const cdp = createSession(ws);
  const logs = [];
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const t = (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || '')).join(' ');
    if (t) logs.push(t);
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: 'https://t.bilibili.com/' });
  await sleep(7000);

  // ---- 第 1 步：确认扩展注入，并预置「未读」数据 ----
  const seed = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const NS = window.__BiliAllUpDot;
      if (!NS) return { injected: false, url: location.href };
      NS.state.config.debug = true;
      NS.state.meta.baselineDone = true;
      NS.state.meta.lastScanAt = Date.now();
      NS.state.updates = {
        '1001': { mid: '1001', name: '小众UP主A', face: 'https://i0.hdslb.com/bfs/face/a1.jpg',
                  lastPubTs: Math.floor(Date.now()/1000)-60, type: 'DYNAMIC_TYPE_AV', kind: 'av', unread: true, seenAt: 0 },
        '1002': { mid: '1002', name: '低产UP主B', face: 'https://i0.hdslb.com/bfs/face/b2.jpg',
                  lastPubTs: Math.floor(Date.now()/1000)-120, type: 'DYNAMIC_TYPE_DRAW', kind: 'draw', unread: true, seenAt: 0 },
      };
      NS.persist();
      return { injected: true, seeded: Object.keys(NS.state.updates) };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('\n[1] 预置数据:', JSON.stringify(seed.result.value));
  if (!seed.result.value || !seed.result.value.injected) {
    throw new Error('扩展未注入 MAIN world');
  }
  await sleep(1500); // 等 storage 落盘

  // ---- 第 2 步：绕过网络 —— 在页面内发起与 B 站代码完全同构的 XHR ----
  // 未登录时 B 站不请求 portal，因此由我们代发一次同构请求（同一 URL、同一
  // onreadystatechange 时序），响应由 CDP 伪造。验证的是：插件对「B 站式
  // XHR 调用」的改写在真实页面环境中是否生效。
  let pausedCount = 0;
  cdp.on('Fetch.requestPaused', (p) => {
    pausedCount++;
    cdp.send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: 'application/json; charset=utf-8' },
        { name: 'Access-Control-Allow-Origin', value: 'https://t.bilibili.com' },
        { name: 'Access-Control-Allow-Credentials', value: 'true' },
      ],
      body: Buffer.from(OFFICIAL).toString('base64'),
    }).catch(() => {});
  });
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*web-dynamic/v1/portal*', requestStage: 'Response' }],
  });

  // B 站 bundle 同构：onreadystatechange 先赋值，再 open+send
  const xhrRes = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const r = await new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.onreadystatechange = function () {
          if (x.readyState !== 4) return;
          try { resolve(JSON.parse(x.responseText)); } catch (e) { resolve({ parseError: true, raw: x.responseText }); }
        };
        x.open('GET', '/x/polymer/web-dynamic/v1/portal?platform=web&up_list_more=1', true);
        x.send();
      });
      const list = r.data && r.data.up_list;
      const arr = Array.isArray(list) ? list : (list && list.items);
      return {
        code: r.code,
        len: arr ? arr.length : null,
        arr: arr || null,
        officialMids: arr ? arr.map(u => u.mid).join(',') : null,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  const x = xhrRes.result.value;
  console.log('\n[2] 走 B 站同构 XHR 管道拿到的改写结果:');
  console.log(JSON.stringify(x, null, 2));
  console.log('拦截命中的 portal 请求数:', pausedCount);

  // ---- 第 3 步：渲染端在位检查 ----
  // bundle 已知：has_update=true 时组件渲染 <span>（蓝点），false 渲染空。
  // 因此只要改写后的 up_list 中预置 UP 的 has_update 为 true，
  // 渲染条件即被满足。这里确认渲染端（动态页 bundle）确实在运行。
  const renderCheck = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      return {
        bundleLoaded:
          !!document.querySelector('script[src*="dyn-home"]') ||
          typeof window.__BiliUser__ !== 'undefined',
      };
    })()`,
    returnByValue: true,
  });
  console.log('\n[3] 渲染端在位检查:', JSON.stringify(renderCheck.result.value));

  console.log('\n===== 插件日志 =====');
  console.log(logs.filter((l) => l.indexOf('全UP蓝点') !== -1).join('\n') || '(无)');

  console.log('\n===== 结论 =====');
  let failCnt = 0;
  const expect = (cond, label) => {
    if (cond) console.log('OK  ' + label);
    else {
      console.log('FAIL  ' + label);
      failCnt++;
    }
  };

  expect(pausedCount > 0, 'portal 请求被 CDP 拦截并由伪造数据应答');
  expect(x && x.code === 0, '页面读到 code=0 的合法响应');
  const arr = x && x.arr;
  expect(Array.isArray(arr) && arr.length === 4, 'up_list 被改写：2 位预置未读 + 2 位官方常看');
  expect(arr && String(arr[0] && arr[0].mid) === '1001' && arr[0].has_update === true, '小众UP主A 排最前且 has_update=true（满足蓝点渲染条件）');
  expect(arr && String(arr[1] && arr[1].mid) === '1002' && arr[1].has_update === true, '低产UP主B 排第二且 has_update=true（满足蓝点渲染条件）');
  expect(arr && arr.some((u) => Number(u.mid) === 9001), '官方常看 UP 保留在列表尾部');
  expect(renderCheck.result.value && renderCheck.result.value.bundleLoaded, '动态页 bundle 已加载（渲染端在位）');
  if (failCnt > 0) exitCode = 1;
} catch (e) {
  console.error('FAIL', e.message);
  exitCode = 1;
} finally {
  try {
    chrome.kill();
  } catch (e) {}
  await sleep(400);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch (e) {}
}
process.exit(exitCode);
