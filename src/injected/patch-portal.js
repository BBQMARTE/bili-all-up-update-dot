/**
 * 接管 B 站动态页顶部头像条的数据源
 * ---------------------------------------------------------------
 * 动态页顶部那排 UP 头像来自：
 *   GET https://api.bilibili.com/x/polymer/web-dynamic/v1/portal
 *   data.up_list[] = { mid, uname, face, has_update, is_reserve_recall }
 *
 * 蓝点完全由 has_update 驱动。官方只返回「常看」的几十个 UP，
 * 所以这里把 up_list 换成插件算出的「全部有更新的 UP」，
 * 让 B 站自己的组件渲染出蓝点 —— 样式、间距、hover、点击跳转全部原生，
 * 插件不需要维护任何 CSS，B 站小改版也不容易崩。
 *
 * 兜底原则：任何一步出问题（URL 不匹配 / JSON 解析失败 / 未登录 /
 * 插件已停用 / 无未读），一律原样放行官方响应，绝不破坏原页面。
 */
(function () {
  'use strict';
  var NS = window.__BiliAllUpDot;
  var PORTAL_RE = /x\/polymer\/web-dynamic\/v1\/portal/;

  function isPortalUrl(u) {
    try {
      return PORTAL_RE.test(String(u || ''));
    } catch (e) {
      return false;
    }
  }

  /** 构造替换后的 up_list；返回 null 表示「不改动，走官方数据」 */
  NS.buildUpList = function (officialList) {
    var cfg = NS.state.config;
    if (!cfg || !cfg.enabled) return null;

    var all = NS.state.updates || {};
    var unread = [];
    var mid;
    for (mid in all) {
      var u = all[mid];
      if (!u || !u.unread) continue;
      if (!NS.typeEnabled(u.kind)) continue;
      unread.push(u);
    }

    if (!unread.length) {
      // 没有任何未读时：
      // 扫描近期正常完成过 -> 显式清掉官方蓝点，避免「已全部已读却仍有蓝点」
      // 扫描失败或从未扫描过   -> 原样放行官方数据，绝不误伤
      var meta = NS.state.meta || {};
      var graceMin = Math.max(30, (Number(cfg.intervalMin) || 3) * 6);
      var scanFresh =
        meta.baselineDone && meta.lastScanAt && Date.now() - meta.lastScanAt < graceMin * 60 * 1000;
      if (!scanFresh) return null;
      return (Array.isArray(officialList) ? officialList : []).map(function (x) {
        return Object.assign({}, x, { has_update: false });
      });
    }

    unread.sort(function (a, b) {
      return (b.lastPubTs || 0) - (a.lastPubTs || 0);
    });

    var mapped = unread.map(function (u) {
      return {
        mid: Number(u.mid),
        uname: u.name || '',
        face: u.face || '',
        has_update: true,
        is_reserve_recall: false,
      };
    });

    var used = new Set(
      mapped.map(function (m) {
        return m.mid;
      })
    );
    var rest = (Array.isArray(officialList) ? officialList : [])
      .filter(function (x) {
        return x && !used.has(Number(x.mid));
      })
      .map(function (x) {
        return {
          mid: x.mid,
          uname: x.uname,
          face: x.face,
          has_update: !!x.has_update,
          is_reserve_recall: !!x.is_reserve_recall,
        };
      });

    var merged = mapped.concat(rest);
    // 所有未读 UP 必须全部展示，故下限取未读数量；上限用于防止 DOM 过载
    var limit = Math.max(Number(cfg.maxUpList) || 60, mapped.length);
    return merged.slice(0, limit);
  };

  NS.patchPortalText = function (text) {
    if (!text || typeof text !== 'string') return text;
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      NS.log('portal 响应不是合法 JSON，原样放行');
      return text;
    }
    if (!obj || obj.code !== 0) {
      NS.log('portal 返回异常 code =', obj && obj.code, '，原样放行');
      return text;
    }
    if (!obj.data) {
      NS.log('portal 响应缺少 data，原样放行');
      return text;
    }

    // 兼容两种可能的数据形态：data.up_list 为数组，或为 { items: [...] }
    var officialList = null;
    var isWrapped = false;
    if (Array.isArray(obj.data.up_list)) {
      officialList = obj.data.up_list;
    } else if (obj.data.up_list && Array.isArray(obj.data.up_list.items)) {
      officialList = obj.data.up_list.items;
      isWrapped = true;
    } else {
      NS.log(
        'portal 响应中没有数组形态的 up_list（实际类型：' +
          typeof obj.data.up_list +
          '），原样放行。响应预览：',
        text.slice(0, 400)
      );
      return text;
    }

    var list = NS.buildUpList(officialList);
    if (!list) {
      NS.log('buildUpList 返回空（未启用 / 无未读 / 扫描未就绪），原样放行');
      return text;
    }

    if (isWrapped) obj.data.up_list.items = list;
    else obj.data.up_list = list;

    NS.log('portal 响应已改写，注入 ' + list.length + ' 个 UP');
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return text;
    }
  };

  // ---------------- fetch 拦截 ----------------
  // B 站主 bundle 中 XMLHttpRequest 出现 15 次、fetch 仅 2 次，实际走的是 XHR，
  // 这里保留 fetch 拦截作为兜底。
  var nativeFetch = NS.nativeFetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!isPortalUrl(url)) {
        // 非目标请求：零额外开销，直接放行（不 clone、不读 body）
        return nativeFetch.apply(window, arguments);
      }

      return nativeFetch.apply(window, arguments).then(async function (res) {
        try {
          var mirror = res.clone();
          var text = await res.text();
          var patched = NS.patchPortalText(text);
          if (patched === text) {
            NS.log('portal(fetch) 响应未改动，按官方数据放行');
            return mirror;
          }
          NS.log('portal(fetch) 响应已改写');
          return new Response(patched, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        } catch (e) {
          NS.log('portal 改写失败，降级放行：', e && e.message);
          return res;
        }
      });
    };
    NS.log('已接管 window.fetch');
  }

  // ---------------- XMLHttpRequest 拦截 ----------------
  // 关键：不能用「追加 readystatechange 监听」来改写响应。
  // B 站的请求封装在 r.open() 之前就赋好了 onreadystatechange，而监听器按
  // 注册顺序触发 —— 页面的处理器会先于我们读到未改写的 responseText，
  // 我们的补丁永远晚一步（v1.0.0 失效的根因）。
  //
  // 正确做法：覆写原型上的 responseText / response getter。
  // patchPortalText 是同步纯函数，在页面「读」的那一刻基于内存中的 state
  // 同步改写，与监听器顺序完全无关。
  var NativeXHR = NS.nativeXHR;
  if (NativeXHR && NativeXHR.prototype) {
    var XHRProto = NativeXHR.prototype;
    var dText = Object.getOwnPropertyDescriptor(XHRProto, 'responseText');
    var dResp = Object.getOwnPropertyDescriptor(XHRProto, 'response');

    // 记录每个实例请求的 URL，供 getter 判断是否为目标接口。
    // 注意：这里只「记录」，不改写，因此对页面完全无感。
    var nativeOpen = XHRProto.open;
    if (nativeOpen) {
      XHRProto.open = function (method, url) {
        try {
          this.__biliUrl = String(url || '');
        } catch (e) {
          this.__biliUrl = '';
        }
        var rest = Array.prototype.slice.call(arguments, 2);
        return nativeOpen.apply(this, [method, url].concat(rest));
      };
    }

    if (dText && dText.get) {
      Object.defineProperty(XHRProto, 'responseText', {
        configurable: true,
        enumerable: dText.enumerable,
        get: function () {
          var raw = dText.get.call(this);
          try {
            if (this.readyState === 4 && isPortalUrl(this.__biliUrl)) {
              return NS.patchPortalText(raw);
            }
          } catch (e) {
            /* 出错按原始值返回 */
          }
          return raw;
        },
      });
      NS.log('已接管 XMLHttpRequest.prototype.responseText');
    }

    if (dResp && dResp.get) {
      Object.defineProperty(XHRProto, 'response', {
        configurable: true,
        enumerable: dResp.enumerable,
        get: function () {
          var raw = dResp.get.call(this);
          try {
            var rt = this.responseType;
            if (
              this.readyState === 4 &&
              isPortalUrl(this.__biliUrl) &&
              (rt === '' || rt === 'text' || rt === 'json')
            ) {
              var src = rt === 'json' ? JSON.stringify(raw) : raw;
              var patched = NS.patchPortalText(src);
              if (patched !== src) {
                return rt === 'json' ? JSON.parse(patched) : patched;
              }
            }
          } catch (e) {
            /* 出错按原始值返回 */
          }
          return raw;
        },
      });
      NS.log('已接管 XMLHttpRequest.prototype.response');
    }
  }
})();
