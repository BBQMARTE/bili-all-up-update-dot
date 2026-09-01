/**
 * 图标生成脚本（无任何第三方依赖，仅用 Node 内置 zlib）
 * 用法： node scripts/gen-icons.mjs
 *
 * 图形：B站品牌蓝圆角方块 + 中心白色「小蓝点」，与插件功能语义一致。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'src', 'assets', 'icons');
const SIZES = [16, 32, 48, 128];
const SOURCE = 512; // 超采样后再降采样，保证小尺寸边缘平滑

const BRAND_BLUE = [0x00, 0xae, 0xec];
const WHITE = [0xff, 0xff, 0xff];

// ---------------- PNG 编码 ----------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    rgba.copy(raw, p, y * size * 4, (y + 1) * size * 4);
    p += size * 4;
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- 绘制 ----------------
function rgbaAt(x, y) {
  const s = SOURCE;
  const r = s * 0.24; // 圆角半径
  // 圆角矩形抗锯齿：用符号距离场
  const cx = Math.min(Math.max(x, r), s - r);
  const cy = Math.min(Math.max(y, r), s - r);
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy) - r; // <0 在内部
  const aa = 1.0;
  const inside = 1 - Math.min(Math.max((dist + aa / 2) / aa, 0), 1);

  if (inside <= 0) return [0, 0, 0, 0];

  // 中心白点
  const dotR = s * 0.155;
  const ddx = x - s / 2;
  const ddy = y - s / 2;
  const dd = Math.sqrt(ddx * ddx + ddy * ddy);
  const dotInside = 1 - Math.min(Math.max((dd - dotR + aa / 2) / aa, 0), 1);

  const c = [
    BRAND_BLUE[0] * (1 - dotInside) + WHITE[0] * dotInside,
    BRAND_BLUE[1] * (1 - dotInside) + WHITE[1] * dotInside,
    BRAND_BLUE[2] * (1 - dotInside) + WHITE[2] * dotInside,
  ];

  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), Math.round(255 * inside)];
}

function renderSource() {
  const s = SOURCE;
  const buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const [r, g, b, a] = rgbaAt(x + 0.5, y + 0.5);
      const i = (y * s + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  return buf;
}

/** 面积平均降采样（按 alpha 预乘，避免边缘发黑） */
function downsample(src, from, to) {
  const out = Buffer.alloc(to * to * 4);
  const step = from / to;
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(x * step), x1 = Math.min(from, Math.ceil((x + 1) * step));
      const y0 = Math.floor(y * step), y1 = Math.min(from, Math.ceil((y + 1) * step));
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * from + sx) * 4;
          const sa = src[i + 3] / 255;
          r += src[i] * sa;
          g += src[i + 1] * sa;
          b += src[i + 2] * sa;
          a += src[i + 3];
          n++;
        }
      }
      const o = (y * to + x) * 4;
      if (a > 0 && n > 0) {
        out[o] = Math.round(r / (a / 255) / 1);
        out[o + 1] = Math.round(g / (a / 255) / 1);
        out[o + 2] = Math.round(b / (a / 255) / 1);
      }
      out[o] = Math.min(255, out[o]);
      out[o + 1] = Math.min(255, out[o + 1]);
      out[o + 2] = Math.min(255, out[o + 2]);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

const source = renderSource();
mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const rgba = size === SOURCE ? source : downsample(source, SOURCE, size);
  writeFileSync(resolve(OUT_DIR, `icon-${size}.png`), encodePng(size, rgba));
  console.log(`生成 icon-${size}.png`);
}
console.log('完成：', OUT_DIR);
