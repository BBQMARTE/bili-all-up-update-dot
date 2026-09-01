/**
 * 极简 Chrome DevTools Protocol 客户端（无第三方依赖）
 * 仅用于本插件的实机自检脚本，不参与扩展运行。
 */
import http from 'node:http';
import crypto from 'node:crypto';

export function wsConnect(url) {
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
    /* 浏览器退出时连接被重置，属正常 */
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

export function getJson(host, port, path) {
  return new Promise((resolveP, rejectP) => {
    http
      .get({ host, port, path }, (res) => {
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 创建一个带消息分发与命令发送能力的 CDP 会话 */
export function createSession(ws) {
  let msgId = 0;
  const pending = new Map();
  const listeners = new Map();

  ws.on('message', (s) => {
    const m = JSON.parse(s);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
      return;
    }
    const fns = listeners.get(m.method);
    if (fns) fns.forEach((f) => f(m.params));
  });

  return {
    send(method, params = {}) {
      return new Promise((resolveP, rejectP) => {
        const id = ++msgId;
        pending.set(id, { resolve: resolveP, reject: rejectP });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
  };
}
