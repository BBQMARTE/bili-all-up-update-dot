/**
 * 实机自检工具：用本机 Chrome 以「加载已解压扩展」方式启动，连接 CDP 验证插件注入。
 * 用法：node scripts/cdp-probe.mjs
 *
 * 说明：未登录状态下动态页不会渲染头像条，因此这里验证的是
 *   ① content script 是否在 MAIN world 注入成功
 *   ② XMLHttpRequest.prototype 是否被插件接管
 *   ③ 用真实 XHR 请求一次 portal，确认拦截链路在真实页面上是通的
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXT_PATH = resolve(process.cwd());
// 注意：Google 品牌版 Chrome 从 137 起移除了 --load-extension 参数，
// 因此这里用 Chromium（Playwright 缓存内的非品牌版）来加载未打包扩展。
const CHROME =
  process.env.PROBE_CHROME ||
  join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
const PORT = 9223;

// ---------------- 最小 WebSocket 客户端（仅够 CDP 使用） ----------------
function wsConnect(url) {
  return new Promise((resolveP, rejectP) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + (u.search || ''),
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        Host: u.host,
      },
    });
    req.on('upgrade', (res, socket) => {
      const expect = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      if (res.headers['sec-websocket-accept'] !== expect) {
        return rejectP(new Error('WebSocket 握手校验失败'));
      }
      resolveP(makeWs(socket));
    });
    req.on('error', rejectP);
    req.end();
  });
}

function sendFrame(socket, opcode, payload) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  socket.write(Buffer.concat([header, mask, masked]));
}

function makeWs(socket) {
  const handlers = { message: [], close: [] };
  let buf = Buffer.alloc(0);
  socket.on('error', () => {
    /* Chrome 退出时连接被重置，属正常 */
  });
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len + (masked ? 4 : 0)) return;
      let maskKey = null;
      if (masked) {
        maskKey = buf.subarray(off, off + 4);
        off += 4;
      }
      let payload = Buffer.from(buf.subarray(off, off + len));
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      buf = buf.subarray(off + len);

      if (opcode === 0x1 || opcode === 0x2) handlers.message.forEach((f) => f(payload.toString('utf8')));
      else if (opcode === 0x8) {
        handlers.close.forEach((f) => f());
        socket.end();
      } else if (opcode === 0x9) sendFrame(socket, 0xa, payload);
    }
  });
  return {
    on(ev, fn) {
      handlers[ev].push(fn);
    },
    send(str) {
      sendFrame(socket, 0x1, Buffer.from(str, 'utf8'));
    },
  };
}

function getJson(path) {
  return new Promise((resolveP, rejectP) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path }, (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('end', () => {
          try {
            resolveP(JSON.parse(s));
          } catch (e) {
            rejectP(e);
          }
        });
      })
      .on('error', rejectP);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 主流程 ----------------
const profile = mkdtempSync(join(tmpdir(), 'bili-ext-probe-'));
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
    '--disable-features=ExtensionDisableUnsupportedDeveloper',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

try {
  // 等调试端口就绪
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      targets = await getJson('/json/list');
      if (targets && targets.length) break;
    } catch (e) {
      /* 未就绪 */
    }
  }
  if (!targets) throw new Error('Chrome 调试端口未就绪');

  // 用已存在的 page target，再通过 CDP 导航到动态页
  let page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到页面 target');

  const ws = await wsConnect(page.webSocketDebuggerUrl);
  ws.on('close', () => {});
  let msgId = 0;
  const pending = new Map();
  const consoleLogs = [];
  ws.on('message', (s) => {
    const m = JSON.parse(s);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || ''))
        .join(' ');
      if (txt) consoleLogs.push(txt);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolveP, rejectP) => {
      const id = ++msgId;
      pending.set(id, { resolve: resolveP, reject: rejectP });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'https://t.bilibili.com/' });
  await sleep(8000); // 等页面与扩展脚本跑完

  const expr = `(async () => {
    const NS = window.__BiliAllUpDot;
    if (!NS) return { injected: false, url: location.href };
    NS.state.config.debug = true;
    const desc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
    let portalCode = null, portalHasUpList = null;
    try {
      const r = await new Promise((res) => {
        const x = new XMLHttpRequest();
        x.onreadystatechange = () => { if (x.readyState === 4) { try { res(JSON.parse(x.responseText)); } catch(e){ res(null); } } };
        x.open('GET', '/x/polymer/web-dynamic/v1/portal', true);
        x.send();
      });
      portalCode = r && r.code;
      portalHasUpList = !!(r && r.data && ('up_list' in r.data));
    } catch (e) { portalCode = 'ERR:' + e.message; }
    return {
      injected: true,
      url: location.href,
      xhrPatched: !!(desc && desc.get),
      stateKeys: Object.keys(NS.state),
      seenIdsLen: (NS.state.meta.seenIds || []).length,
      updatesCount: Object.keys(NS.state.updates).length,
      portalCode, portalHasUpList,
      previewUpList: NS.buildUpList([]) === null ? null : NS.buildUpList([]).length,
    };
  })()`;

  const res = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });

  console.log('\n===== 实机检查结果 =====');
  console.log(JSON.stringify(res.result.value, null, 2));

  const logs = consoleLogs.filter((l) => l.indexOf('全UP蓝点') !== -1);
  console.log('\n===== 控制台中的插件日志 =====');
  console.log(logs.length ? logs.join('\n') : '(无)');

  const v = res.result.value || {};
  console.log('\n===== 结论 =====');
  console.log(v.injected ? 'OK  扩展已注入 MAIN world' : 'FAIL 扩展未注入');
  if (v.injected) {
    console.log(v.xhrPatched ? 'OK  XMLHttpRequest 已被接管' : 'FAIL XMLHttpRequest 未接管');
    console.log(
      typeof v.portalCode === 'number'
        ? `OK  真实 portal 请求往返成功（code=${v.portalCode}，未登录属预期）`
        : `FAIL portal 请求异常：${v.portalCode}`
    );
  }
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  try {
    chrome.kill();
  } catch (e) {}
  await sleep(400);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch (e) {}
}
