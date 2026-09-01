/**
 * WBI 签名
 * ---------------------------------------------------------------
 * B 站 Web 端接口自 2023 年起要求 w_rid / wts 签名，否则返回 -403。
 * 这里内置纯 JS MD5（不引第三方库、不引 CDN，规避扩展 CSP 限制）。
 *
 * 流程：
 *   1) GET /x/web-interface/nav 取 data.wbi_img.img_url / sub_url
 *      的文件名主干作为 img_key / sub_key，缓存 6 小时
 *   2) 按官方 64 位乱序表重排 (img_key + sub_key)，取前 32 位得 mixin_key
 *   3) 参数按 key 升序、URL 编码后剔除 !'()*，拼上 wts 与 mixin_key 取 MD5
 */
(function () {
  'use strict';
  var NS = window.__BiliAllUpDot;

  // ---------------- MD5 ----------------
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c < 0xd800 || c >= 0xe000) {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else {
        i++;
        var c2 = str.charCodeAt(i);
        var cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
      }
    }
    return out;
  }

  var S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  var K = (function () {
    var arr = new Array(64);
    for (var i = 0; i < 64; i++) arr[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    return arr;
  })();

  function hexWord(n) {
    var s = '';
    for (var i = 0; i < 4; i++) {
      var b = (n >>> (i * 8)) & 0xff;
      s += (b < 16 ? '0' : '') + b.toString(16);
    }
    return s;
  }

  function md5(input) {
    var bytes = utf8Bytes(String(input));
    var bitLen = bytes.length * 8;
    var lo = bitLen >>> 0;
    var hi = Math.floor(bitLen / 0x100000000);

    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push(lo & 0xff, (lo >>> 8) & 0xff, (lo >>> 16) & 0xff, (lo >>> 24) & 0xff);
    bytes.push(hi & 0xff, (hi >>> 8) & 0xff, (hi >>> 16) & 0xff, (hi >>> 24) & 0xff);

    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

    for (var off = 0; off < bytes.length; off += 64) {
      var M = new Array(16);
      for (var j = 0; j < 16; j++) {
        var o = off + j * 4;
        M[j] = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
      }
      var A = a0, B = b0, C = c0, D = d0;
      for (var k = 0; k < 64; k++) {
        var F, g;
        if (k < 16) {
          F = (B & C) | (~B & D);
          g = k;
        } else if (k < 32) {
          F = (B & D) | (C & ~D);
          g = (5 * k + 1) % 16;
        } else if (k < 48) {
          F = B ^ C ^ D;
          g = (3 * k + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * k) % 16;
        }
        F = (F + A + K[k] + M[g]) >>> 0;
        A = D;
        D = C;
        C = B;
        B = (B + ((F << S[k]) | (F >>> (32 - S[k])))) >>> 0;
      }
      a0 = (a0 + A) >>> 0;
      b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }
    return hexWord(a0) + hexWord(b0) + hexWord(c0) + hexWord(d0);
  }

  // ---------------- WBI ----------------
  // 官方 mixin key 编码表（长度 64）
  var MIXIN_TABLE = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
  ];

  function getMixinKey(raw) {
    var out = '';
    for (var i = 0; i < 64; i++) out += raw.charAt(MIXIN_TABLE[i]);
    return out.slice(0, 32);
  }

  function keyOfUrl(url) {
    if (!url) return '';
    var name = String(url).split('/').pop() || '';
    return name.split('.')[0] || '';
  }

  var KEY_TTL = 6 * 60 * 60 * 1000; // 6 小时

  NS.wbi = {
    md5: md5,

    /** 获取（必要时刷新）wbi key；失败返回 null，调用方会退化为无签名请求 */
    ensureKeys: async function (force) {
      var w = NS.state.meta.wbi;
      var now = Date.now();
      if (!force && w && w.imgKey && w.subKey && now - w.fetchedAt < KEY_TTL) return w;

      var r = null;
      try {
        r = await NS.api.rawGet('https://api.bilibili.com/x/web-interface/nav', {});
      } catch (e) {
        NS.log('获取 wbi key 失败：', e && e.message);
      }

      var keys = null;
      if (r && r.code === 0 && r.data && r.data.wbi_img) {
        var imgKey = keyOfUrl(r.data.wbi_img.img_url);
        var subKey = keyOfUrl(r.data.wbi_img.sub_url);
        if (imgKey && subKey) keys = { imgKey: imgKey, subKey: subKey, fetchedAt: now };
      }

      if (keys) {
        NS.state.meta.wbi = keys;
        NS.persistMeta && NS.persistMeta();
        NS.log('wbi key 已更新', keys.imgKey, keys.subKey);
        return keys;
      }

      if (r && r.code === -101) NS.log('未登录（nav 返回 -101），将退化为无签名请求');
      return null;
    },

    /** 为参数对象附加 w_rid / wts，返回新对象 */
    sign: function (params, keys) {
      var p = {};
      var i;
      for (i in params) {
        if (Object.prototype.hasOwnProperty.call(params, i) && params[i] !== undefined && params[i] !== null && params[i] !== '') {
          p[i] = String(params[i]);
        }
      }
      var wts = Math.round(Date.now() / 1000);
      p.wts = String(wts);

      var keysSorted = Object.keys(p).sort();
      var query = [];
      for (i = 0; i < keysSorted.length; i++) {
        var k = keysSorted[i];
        var v = String(p[k]).replace(/[!'()*]/g, '');
        query.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      }
      var mixinKey = getMixinKey(keys.imgKey + keys.subKey);
      p.w_rid = md5(query.join('&') + mixinKey);
      return p;
    },
  };
})();
