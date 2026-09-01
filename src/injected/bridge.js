/**
 * MAIN world 基础层
 * ---------------------------------------------------------------
 * 1) 在运行环境被任何脚本污染之前，先把原生 fetch / XMLHttpRequest 存起来，
 *    后续插件自己的网络请求一律走原生引用，避免与拦截器互相递归。
 * 2) 建立 MAIN world <-> ISOLATED world 的消息桥（window.postMessage）。
 *    MAIN world 无法直接调用 chrome.* API（storage），必须借 ISOLATED 中转。
 * 3) 挂载全局命名空间 window.__BiliAllUpDot，所有模块共用同一份 state。
 */
(function () {
  'use strict';

  // 同一文档内重复注入时直接跳过，避免覆盖已装好的拦截器
  if (window.__BiliAllUpDot && window.__BiliAllUpDot.__bridgeReady) return;

  var NS = (window.__BiliAllUpDot = window.__BiliAllUpDot || {});
  NS.__bridgeReady = true;

  // ---------- 原生能力快照 ----------
  NS.nativeFetch =
    typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  NS.nativeXHR = window.XMLHttpRequest;

  // ---------- 默认配置 ----------
  var DEFAULT_CONFIG = {
    enabled: true, // 总开关
    intervalMin: 3, // 扫描间隔（分钟）
    maxUpList: 60, // 顶部头像条最多展示多少个 UP
    debug: false, // 控制台日志
    types: {
      av: true, // 视频投稿
      word: true, // 文字动态
      draw: true, // 图文动态
      forward: true, // 转发动态
      live: true, // 直播开播
    },
  };

  NS.DEFAULT_CONFIG = DEFAULT_CONFIG;

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }
  NS.clone = clone;

  // ---------- 运行时状态 ----------
  NS.state = {
    config: clone(DEFAULT_CONFIG),
    meta: {
      lastMaxTs: 0, // 已扫描到的最新动态时间戳（秒）
      lastScanAt: 0, // 上次扫描时间（毫秒）
      baselineDone: false, // 首轮基线是否已建立
      wbi: null, // { imgKey, subKey, fetchedAt }
    },
    updates: {}, // mid -> { mid, name, face, lastPubTs, type, kind, unread, seenAt }
  };

  // ---------- 消息桥 ----------
  var pending = new Map();
  var handlers = new Map();
  var seq = 1;
  var MSG_KEY = '__biliUpDot';
  var TAG = '[全UP蓝点]';

  NS.bridge = {
    /** 请求-响应式调用 ISOLATED world */
    call: function (type, payload, timeout) {
      return new Promise(function (resolve, reject) {
        var id = 'r' + seq++;
        var timer = setTimeout(function () {
          if (pending.has(id)) pending.delete(id);
          reject(new Error('bridge timeout: ' + type));
        }, timeout || 10000);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        try {
          window.postMessage(
            { __biliUpDot: true, dir: 'to-ext', type: type, id: id, payload: payload },
            '*'
          );
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          reject(e);
        }
      });
    },
    /** 单向通知 ISOLATED world */
    emit: function (type, payload) {
      try {
        window.postMessage(
          { __biliUpDot: true, dir: 'to-ext', type: type, id: null, payload: payload },
          '*'
        );
      } catch (e) {
        /* 忽略 */
      }
    },
    /** 注册来自 ISOLATED world 的推送 */
    on: function (type, fn) {
      handlers.set(type, fn);
    },
  };

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || !d.__biliUpDot || d.dir !== 'to-main') return;

    if (d.id && pending.has(d.id)) {
      var p = pending.get(d.id);
      pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.payload);
      else p.reject(new Error(d.error || 'bridge error'));
      return;
    }

    var fn = handlers.get(d.type);
    if (fn) {
      try {
        fn(d.payload);
      } catch (e) {
        /* 忽略，绝不影响页面 */
      }
    }
  });

  // ---------- 日志 ----------
  NS.log = function () {
    if (!NS.state.config || !NS.state.config.debug) return;
    try {
      console.log.apply(console, [TAG].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* 忽略 */
    }
  };
  NS.warn = function () {
    try {
      console.warn.apply(console, [TAG].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* 忽略 */
    }
  };

  // ---------- 动态类型归一 ----------
  NS.kindOf = function (type) {
    switch (type) {
      case 'DYNAMIC_TYPE_AV':
      case 'DYNAMIC_TYPE_UGC_SEASON':
      case 'DYNAMIC_TYPE_PGC':
      case 'DYNAMIC_TYPE_PGC_UNION':
        return 'av';
      case 'DYNAMIC_TYPE_WORD':
        return 'word';
      case 'DYNAMIC_TYPE_DRAW':
        return 'draw';
      case 'DYNAMIC_TYPE_FORWARD':
        return 'forward';
      case 'DYNAMIC_TYPE_LIVE':
      case 'DYNAMIC_TYPE_LIVE_RCMD':
        return 'live';
      default:
        return 'other';
    }
  };

  /** 该类型是否计入更新（other 恒定计入，避免漏报未知新类型） */
  NS.typeEnabled = function (kind) {
    if (kind === 'other') return true;
    var t = (NS.state.config && NS.state.config.types) || {};
    return t[kind] !== false;
  };
})();
