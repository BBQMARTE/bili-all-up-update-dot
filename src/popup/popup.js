/* 设置面板逻辑 */
(function () {
  'use strict';

  var KEY_CONFIG = 'bud_config';
  var KEY_UPDATES = 'bud_updates';

  var DEFAULT_CONFIG = {
    enabled: true,
    intervalMin: 3,
    maxUpList: 60,
    debug: false,
    types: { av: true, word: true, draw: true, forward: true, live: true },
  };

  var $ = function (sel) {
    return document.querySelector(sel);
  };

  var el = {
    app: $('.app'),
    statusPill: $('#statusPill'),
    switchEnabled: $('#switchEnabled'),
    unreadNum: $('#unreadNum'),
    btnReadAllTop: $('#btnReadAllTop'),
    btnReadAll: $('#btnReadAll'),
    btnRefresh: $('#btnRefresh'),
    seg: $('#segInterval'),
    hint: $('#hint'),
  };

  var config = Object.assign({}, DEFAULT_CONFIG);
  var originalRefreshText = el.btnRefresh.textContent;
  var originalReadAllText = el.btnReadAll.textContent;

  // ---------------- 渲染 ----------------
  function render() {
    el.app.classList.toggle('is-disabled', !config.enabled);
    el.switchEnabled.classList.toggle('is-on', !!config.enabled);
    el.switchEnabled.setAttribute('aria-checked', String(!!config.enabled));
    el.statusPill.textContent = config.enabled ? '已启用' : '已停用';
    el.statusPill.classList.toggle('is-off', !config.enabled);

    var types = config.types || {};
    Array.prototype.forEach.call(document.querySelectorAll('.cb'), function (cb) {
      cb.checked = types[cb.dataset.type] !== false;
    });

    Array.prototype.forEach.call(el.seg.querySelectorAll('.seg-item'), function (b) {
      b.classList.toggle('is-active', Number(b.dataset.v) === Number(config.intervalMin));
    });
  }

  function renderUnread(n) {
    el.unreadNum.textContent = String(n);
  }

  // ---------------- 存取 ----------------
  function saveConfig(patch) {
    var next = Object.assign({}, config, patch);
    if (patch.types) next.types = Object.assign({}, config.types, patch.types);
    config = next;
    render();
    chrome.storage.local.set({ [KEY_CONFIG]: config });
  }

  function load() {
    chrome.storage.local.get([KEY_CONFIG, KEY_UPDATES], function (res) {
      config = Object.assign({}, DEFAULT_CONFIG, res[KEY_CONFIG] || {});
      config.types = Object.assign({}, DEFAULT_CONFIG.types, (res[KEY_CONFIG] || {}).types || {});
      render();
      var ups = res[KEY_UPDATES] || {};
      renderUnread(
        Object.keys(ups).filter(function (mid) {
          return ups[mid] && ups[mid].unread;
        }).length
      );
    });
  }

  // ---------------- 与页面侧通信 ----------------
  // 不申请 "tabs" 权限（避免「读取浏览记录」警告），因此读不到 tab.url。
  // 改为向所有标签页广播 PING，只有注入了本插件的 B 站页面会应答。
  function findBiliTab(cb) {
    chrome.tabs.query({}, function (tabs) {
      var ids = (tabs || []).map(function (t) {
        return t.id;
      });
      var left = ids.length;
      var done = false;
      if (!left) {
        cb(null);
        return;
      }

      function finish(tab) {
        if (done) return;
        done = true;
        cb(tab);
      }
      function step() {
        left--;
        if (left <= 0) finish(null);
      }

      ids.forEach(function (id) {
        try {
          chrome.tabs.sendMessage(id, { __bud: true, action: 'PING' }, function (res) {
            var ok = !chrome.runtime.lastError && res && res.ok;
            if (ok) finish({ id: id });
            else step();
          });
        } catch (e) {
          step();
        }
      });
    });
  }

  function sendToTab(action, done) {
    findBiliTab(function (tab) {
      if (!tab) {
        done(false);
        return;
      }
      try {
        chrome.tabs.sendMessage(tab.id, { __bud: true, action: action }, function (res) {
          var ok = !chrome.runtime.lastError && res && res.ok;
          done(!!ok);
        });
      } catch (e) {
        done(false);
      }
    });
  }

  function flash(btn, text, original) {
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(function () {
      btn.textContent = original;
      btn.disabled = false;
    }, 1200);
  }

  function setHint(text, warn) {
    el.hint.textContent = text;
    el.hint.classList.toggle('is-warn', !!warn);
  }

  // ---------------- 事件 ----------------
  el.switchEnabled.addEventListener('click', function () {
    saveConfig({ enabled: !config.enabled });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.cb'), function (cb) {
    cb.addEventListener('change', function () {
      var patch = { types: {} };
      patch.types[cb.dataset.type] = cb.checked;
      saveConfig(patch);
    });
  });

  el.seg.addEventListener('click', function (e) {
    var b = e.target.closest('.seg-item');
    if (!b) return;
    saveConfig({ intervalMin: Number(b.dataset.v) });
  });

  el.btnRefresh.addEventListener('click', function () {
    flash(el.btnRefresh, '刷新中…', originalRefreshText);
    sendToTab('REFRESH', function (ok) {
      setHint(ok ? '正在刷新动态页…' : '未找到已打开的 B 站动态页，请先打开 t.bilibili.com', !ok);
    });
  });

  function markAllRead() {
    sendToTab('MARK_ALL_READ', function (ok) {
      if (ok) {
        renderUnread(0);
        flash(el.btnReadAll, '已清空', originalReadAllText);
        setHint('已全部标记为已读');
        return;
      }
      // 页面未打开时，直接改本地数据，下次打开动态页即生效
      chrome.storage.local.get([KEY_UPDATES], function (res) {
        var ups = res[KEY_UPDATES] || {};
        var n = 0;
        Object.keys(ups).forEach(function (mid) {
          if (ups[mid] && ups[mid].unread) {
            ups[mid].unread = false;
            ups[mid].seenAt = Date.now();
            n++;
          }
        });
        chrome.storage.local.set({ [KEY_UPDATES]: ups }, function () {
          renderUnread(0);
          flash(el.btnReadAll, '已清空', originalReadAllText);
          setHint(n ? '已清理 ' + n + ' 条未读记录' : '当前没有未读记录');
        });
      });
    });
  }

  el.btnReadAllTop.addEventListener('click', markAllRead);
  el.btnReadAll.addEventListener('click', markAllRead);

  load();
})();
