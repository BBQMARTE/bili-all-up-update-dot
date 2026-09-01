/**
 * B 站接口封装（全部在 MAIN world 发起）
 * ---------------------------------------------------------------
 * 为什么必须在页面上下文发请求：
 *   - 自动携带 B 站 Cookie（SESSDATA），无需手动处理登录态
 *   - 与 B 站前端同源 CORS 行为一致，不会出现预检失败
 *   - 扩展 background 直连会有跨域 + Cookie 携带不可靠的问题
 */
(function () {
  'use strict';
  var NS = window.__BiliAllUpDot;

  function buildUrl(base, params) {
    var u = new URL(base);
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      u.searchParams.set(k, String(v));
    });
    return u.toString();
  }

  /** 原生 GET，返回 JSON；任何异常都向外抛，由调用方决定如何降级 */
  async function rawGet(base, params) {
    if (!NS.nativeFetch) throw new Error('当前环境不支持 fetch');
    var res = await NS.nativeFetch(buildUrl(base, params), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    var text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('响应不是合法 JSON');
    }
  }

  /**
   * 带 WBI 签名的 GET，失败自动降级：
   *   签名请求 -> 若返回 -403 / -352 / -401 或异常 -> 退化为无签名重试一次
   */
  async function signedGet(base, params) {
    var keys = null;
    try {
      keys = await NS.wbi.ensureKeys(false);
    } catch (e) {
      /* 取不到 key 就走无签名 */
    }

    if (keys) {
      var signed;
      try {
        signed = NS.wbi.sign(params, keys);
      } catch (e) {
        signed = null;
      }
      if (signed) {
        var r = null;
        try {
          r = await rawGet(base, signed);
        } catch (e) {
          r = null;
        }
        if (r && r.code === 0) return r;
        if (r && (r.code === -403 || r.code === -352 || r.code === -401)) {
          NS.log('WBI 签名被拒（' + r.code + '），退化为无签名重试');
          var r2 = null;
          try {
            r2 = await rawGet(base, params);
          } catch (e2) {
            r2 = null;
          }
          return r2 || r;
        }
        if (r) return r;
      }
    }

    return await rawGet(base, params);
  }

  NS.api = {
    rawGet: rawGet,
    signedGet: signedGet,

    /**
     * 关注动态流（时间倒序，包含全部关注 UP，非算法推荐）
     * GET /x/polymer/web-dynamic/v1/feed/all
     * 参数与 B 站前端一致：type / page / platform / offset（不加多余参数）
     */
    getFeedPage: async function (offset) {
      var base = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all';
      var p1 = { type: 'all', page: '1', platform: 'web' };
      if (offset) p1.offset = offset;
      var r = await signedGet(base, p1);
      if (r && r.code === 0) return r;

      // 兼容：部分账号/灰度下 type=all 不生效，去掉附加参数重试
      var p2 = { page: '1', platform: 'web' };
      if (offset) p2.offset = offset;
      var r2 = await signedGet(base, p2);
      return r2 || r;
    },

    /**
     * 新动态计数（B 站前端自己就是每 30 秒轮询它）
     * GET /x/polymer/web-dynamic/v1/feed/all/update?type=all&update_baseline=...
     * 返回 data.update_num，>0 表示关注流有新内容。
     * 用它做廉价轮询，只在必要时才真正翻页扫描。
     */
    getUpdateNum: async function (baseline) {
      return await signedGet(
        'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all/update',
        { type: 'all', update_baseline: baseline }
      );
    },

    /**
     * 关注列表中正在直播的房间
     * GET https://api.live.bilibili.com/xlive/web-ucenter/user/following
     * 该接口会把「正在直播」的排在最前面，因此只取前 2 页即可覆盖绝大多数情况。
     */
    getLiveRooms: async function (page) {
      var base = 'https://api.live.bilibili.com/xlive/web-ucenter/user/following';
      return await signedGet(base, {
        page: String(page || 1),
        page_size: '30',
        platform: 'web',
      });
    },
  };
})();
