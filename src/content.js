/**
 * ISOLATED world：MAIN world 与扩展之间的桥
 * ---------------------------------------------------------------
 * - 转发 MAIN world 的 storage 读写请求
 * - 把 popup 的指令（立即刷新 / 全部已读）下发给 MAIN world
 * - 监听配置变化并推送给 MAIN world
 *
 * 注意：MAIN world 拿不到 chrome.* API，所有持久化必须经这里中转。
 */
(function () {
  'use strict';

  var KEY_CONFIG = 'bud_config';
  var KEY_META = 'bud_meta';
  var KEY_UPDATES = 'bud_updates';

  var DEFAULT_CONFIG = {
    enabled: true,
    intervalMin: 3,
    maxUpList: 60,
    debug: false,
    types: { av: true, word: true, draw: true, forward: true, live: true },
  };

  var DEFAULT_META = {
    lastMaxTs: 0,
    lastScanAt: 0,
    baselineDone: false,
    wbi: null,
    updateBaseline: '',
    seenIds: [],
  };

  function post(type, payload, id, ok, error) {
    window.postMessage(
      {
        __biliUpDot: true,
        dir: 'to-main',
        type: type,
        id: id || null,
        payload: payload,
        ok: ok !== false,
        error: error || null,
      },
      '*'
    );
  }

  function readAll() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([KEY_CONFIG, KEY_META, KEY_UPDATES], function (res) {
        resolve({
          config: Object.assign({}, DEFAULT_CONFIG, res[KEY_CONFIG] || {}),
          meta: Object.assign({}, DEFAULT_META, res[KEY_META] || {}),
          updates: res[KEY_UPDATES] || {},
        });
      });
    });
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'GET_STATE':
        return await readAll();

      case 'SAVE_STATE': {
        var patch = {};
        if (msg.payload && msg.payload.meta) patch[KEY_META] = msg.payload.meta;
        if (msg.payload && msg.payload.updates) patch[KEY_UPDATES] = msg.payload.updates;
        if (msg.payload && msg.payload.config) patch[KEY_CONFIG] = msg.payload.config;
        if (!Object.keys(patch).length) return { ok: true };
        return await new Promise(function (resolve) {
          chrome.storage.local.set(patch, function () {
            resolve({ ok: true });
          });
        });
      }

      case 'MARK_READ': {
        var mid = msg.payload && msg.payload.mid;
        if (!mid) return { ok: false };
        return await new Promise(function (resolve) {
          chrome.storage.local.get([KEY_UPDATES], function (res) {
            var ups = res[KEY_UPDATES] || {};
            if (ups[mid]) {
              ups[mid].unread = false;
              ups[mid].seenAt = Date.now();
            }
            chrome.storage.local.set({ [KEY_UPDATES]: ups }, function () {
              resolve({ ok: true });
            });
          });
        });
      }

      case 'LOG':
        console.log('[全UP蓝点]', msg.payload);
        return { ok: true };

      default:
        return { ok: false, error: 'unknown type: ' + msg.type };
    }
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || !d.__biliUpDot || d.dir !== 'to-ext') return;

    Promise.resolve()
      .then(function () {
        return handle(d);
      })
      .then(function (result) {
        if (d.id) post(d.type, result, d.id, true);
      })
      .catch(function (err) {
        if (d.id) post(d.type, null, d.id, false, String((err && err.message) || err));
      });
  });

  // 配置变化 -> 推送给 MAIN world
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes[KEY_CONFIG]) {
      post('CONFIG', Object.assign({}, DEFAULT_CONFIG, changes[KEY_CONFIG].newValue || {}));
    }
  });

  // popup 指令 -> MAIN world
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.__bud) return undefined;
    if (msg.action === 'REFRESH') {
      post('REFRESH', {});
      sendResponse({ ok: true });
      // 立即刷新必须配合页面重载才有可见效果：
      // 顶部头像条由 B 站组件持有，只有重新请求 portal 才会重绘。
      // 重载后 content script 会在 document_start 重新扫描并改写 portal。
      setTimeout(function () {
        try {
          location.reload();
        } catch (e) {
          /* 忽略 */
        }
      }, 120);
    } else if (msg.action === 'MARK_ALL_READ') {
      post('MARK_ALL_READ', {});
      sendResponse({ ok: true });
    } else if (msg.action === 'PING') {
      sendResponse({ ok: true });
    }
    return true;
  });
})();
