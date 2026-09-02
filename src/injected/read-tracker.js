/**
 * 已读追踪
 * ---------------------------------------------------------------
 * 「点开该 UP 后蓝点消失」：
 *   a) 点击头像 / 昵称链接（a[href] 指向 space.bilibili.com/<mid> 或 t.bilibili.com/<mid>）
 *   b) 元素上带 data-mid / data-uid（B 站列表项常见属性）
 *   c) SPA 路由跳转（patch history.pushState / replaceState），进入空间页即视为已读
 *   d) 直接打开 space.bilibili.com/<mid>/* 页面（index.js 启动时判定）
 *
 * 标记已读后：
 *   1) 写入 state 并持久化（下次 portal 请求就不会再带这个 UP）
 *   2) 立即把当前页面上对应的小蓝点 DOM 隐藏掉，不用等刷新
 */
(function () {
  'use strict';
  var NS = window.__BiliAllUpDot;

  var hiddenMids = new Set();

  // ---------------- 标记已读 ----------------
  /**
   * @param {string} mid
   * @param {{name?:string, face?:string}} [info] 从 DOM 补的昵称/头像，
   *   用于「插件此前从未记录过这个 UP」时建档（官方常看列表里的人常属此类）
   */
  NS.markRead = function (mid, info) {
    mid = String(mid || '');
    if (!mid || !/^\d+$/.test(mid)) return false;

    var rec = NS.state.updates[mid];

    // 插件此前没记录过（多为官方常看列表里的 UP）：也要建一条「已读」记录，
    // 否则刷新后官方 has_update=true 会让他的蓝点复活。
    if (!rec) {
      rec = {
        mid: mid,
        name: (info && info.name) || '',
        face: (info && info.face) || '',
        lastPubTs: 0,
        type: '',
        kind: 'other',
        unread: false,
        seenAt: Date.now(),
      };
      NS.state.updates[mid] = rec;
      hiddenMids.add(mid);
      NS.persist();
      NS.log('新建已读记录（此前未记录过）：', rec.name || mid, mid);
      return true;
    }

    if (info && info.name && !rec.name) rec.name = info.name;
    if (info && info.face && !rec.face) rec.face = info.face;

    if (!rec.unread) return false;

    rec.unread = false;
    rec.seenAt = Date.now();
    hiddenMids.add(mid);
    NS.persist();
    hideDotForMid(mid, rec.face, rec.name);
    NS.log('已标记已读：', rec.name || mid, mid);
    return true;
  };

  /** 从点击到的头像条 item 提取身份并标记已读 */
  NS.markReadFromItem = function (item) {
    if (!item) return false;
    var mid = midFromItemElement(item);
    if (!mid) return false;
    var info = { name: '', face: '' };
    var nameEl = item.querySelector('.bili-dyn-up-list__item__name');
    if (nameEl) info.name = String(nameEl.textContent || '').trim();
    var img =
      item.querySelector('.bili-dyn-up-list__item__face__img') || item.querySelector('img');
    if (img) info.face = imgSrcOf(img);
    return NS.markRead(mid, info);
  };

  NS.markAllRead = function () {
    var n = 0;
    var mid;
    for (mid in NS.state.updates) {
      var r = NS.state.updates[mid];
      if (r && r.unread) {
        r.unread = false;
        r.seenAt = Date.now();
        hiddenMids.add(String(mid));
        n++;
      }
    }
    if (n) {
      NS.persist();
      NS.bridge.emit('SCAN_DONE', { unread: 0, at: Date.now() });
    }
    NS.log('全部已读，清除 ' + n + ' 个蓝点');
    return n;
  };

  /**
   * 一键自检（控制台执行 __BiliAllUpDot.testRead()）
   * 模拟「点击头像 → 已读 → 持久化 → 读回」全流程，逐步报告 PASS/FAIL，
   * 用于在真实登录环境下定位断点。
   */
  NS.testRead = async function () {
    var steps = [];
    var step = function (name, ok, detail) {
      steps.push({ 步骤: name, 结果: ok ? 'PASS' : 'FAIL', 说明: detail || '' });
      console.log((ok ? '%cPASS' : '%cFAIL') + ' %c' + name, ok ? 'color:#2F9E44' : 'color:#E13C3C;font-weight:bold', 'color:inherit', detail || '');
      return ok;
    };

    // 1. 找一位未读 UP
    var target = null;
    for (var mid in NS.state.updates) {
      var r = NS.state.updates[mid];
      if (r && r.unread) {
        target = r;
        break;
      }
    }
    if (!step(!!target, '存在未读 UP', target ? target.name + '（mid=' + target.mid + '）' : '没有未读记录 —— 请先等扫描跑完再测')) {
      return steps;
    }

    // 2. 页面上能否找到该 UP 的头像条 item（与点击处理器同路径：先昵称后 hash）
    var item = findAvatarItem(null, target.name) || findAvatarItem(faceKey(target.face));
    step(
      !!item,
      '页面上定位到该 UP 的头像',
      item ? '定位成功（昵称/hash）' : '头像条里没找到这位 UP（可能不在首屏）'
    );

    // 3. 反查 mid 是否正确（点击判定核心）
    var back = item ? midFromItemElement(item) : null;
    step(back === String(target.mid), '点击判定能反查出正确 mid', '反查结果=' + back + '，期望=' + target.mid);

    // 4. 蓝点 DOM 存在性
    var dotInItem = item ? item.querySelector(DOT_SELECTOR) : null;
    step(!!dotInItem, '该头像上确实有蓝点 span', dotInItem ? '找到' : '没有蓝点（has_update 未生效？）');

    // 5. 标记已读
    var before = document.querySelectorAll(DOT_SELECTOR).length;
    var marked = NS.markRead(target.mid);
    var after = document.querySelectorAll(DOT_SELECTOR + ':not([style*="display: none"]):not([style*="display:none"])').length;
    step(marked, 'markRead 执行成功', '未读标记已写入内存');
    step(after < before, '页面蓝点被即时隐藏', '隐藏前 ' + before + ' 个可见蓝点 → 隐藏后 ' + after + ' 个');

    // 6. 持久化 → 读回（刷新后不复活的关键）
    await new Promise(function (res) {
      setTimeout(res, 600); // 等 persist 落盘
    });
    var saved = null;
    try {
      saved = await NS.bridge.call('GET_STATE', null, 5000);
    } catch (e) {
      /* bridge 异常 */
    }
    var rec = saved && saved.updates && saved.updates[String(target.mid)];
    step(!!rec && rec.unread === false, '已读状态成功写入浏览器存储（刷新后不会复活）', rec ? '存储中 unread=' + rec.unread : '存储里读不到这条记录！');

    console.log('%c[全UP蓝点] 自检完成，共 ' + steps.length + ' 步', 'color:#00AEEC;font-weight:bold');
    console.log('把上面的输出完整复制发给开发者即可定位问题');
    return steps;
  };

  // ---------------- DOM: 隐藏蓝点 ----------------
  function faceKey(face) {
    if (!face) return '';
    var m = String(face).match(/bfs\/[^/]+\/([0-9a-f]{16,64})/i);
    if (m) return m[1];
    var m2 = String(face).match(/([0-9a-f]{24,64})\.(?:jpg|jpeg|png|webp)/i);
    return m2 ? m2[1] : '';
  }

  // 蓝点元素：B 站渲染为 .bili-dyn-up-list__item__face > span（无 class 的裸 span）
  var DOT_SELECTOR = '.bili-dyn-up-list__item__face > span';
  var ITEM_SELECTOR = '.bili-dyn-up-list__item';

  function findAvatarItem(key, name) {
    // 优先：按头像 URL 的唯一 hash 定位 img，再向上找 item 容器
    if (key) {
      var imgs = document.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) {
        var src = imgSrcOf(imgs[i]);
        if (src.indexOf(key) === -1) continue;
        if (imgs[i].closest) {
          var it = imgs[i].closest(ITEM_SELECTOR);
          if (it) return it;
        }
        return imgs[i].parentElement || imgs[i];
      }
    }
    // 兜底：按昵称文本定位（懒加载导致图片 hash 失效时仍可用）
    if (name) {
      var n = String(name).replace(/\s+/g, '');
      if (n) {
        var nameEls = document.querySelectorAll('.bili-dyn-up-list__item__name');
        for (var j = 0; j < nameEls.length; j++) {
          if (String(nameEls[j].textContent || '').replace(/\s+/g, '') === n) {
            var up = nameEls[j].closest(ITEM_SELECTOR);
            if (up) return up;
          }
        }
      }
    }
    return null;
  }

  /** 隐藏头像条 item 内的小圆点 */
  function hideDotsIn(item) {
    if (!item) return 0;
    item.setAttribute('data-bud-read', '1');
    var n = 0;

    // 精确路径：裸 span 蓝点
    var precise = item.querySelectorAll(DOT_SELECTOR);
    for (var i = 0; i < precise.length; i++) {
      precise[i].style.setProperty('display', 'none', 'important');
      n++;
    }
    if (n) return n;

    // 兜底：启发式（绝对定位 + 极小 + 有背景/边框）
    var nodes = item.querySelectorAll('*');
    for (var j = 0; j < nodes.length; j++) {
      var el = nodes[j];
      if (el.tagName === 'IMG') continue;
      var cs;
      try {
        cs = getComputedStyle(el);
      } catch (e) {
        continue;
      }
      if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.width > 20 || r.height > 20) continue;
      if (Math.abs(r.width - r.height) > 6) continue;
      var hasBg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
      var hasBorder = cs.borderTopWidth && cs.borderTopWidth !== '0px';
      if (!hasBg && !hasBorder) continue;
      el.style.setProperty('display', 'none', 'important');
      n++;
    }
    return n;
  }

  function hideDotForMid(mid, face, name) {
    var key = faceKey(face);
    var item = findAvatarItem(key, name);
    var n = hideDotsIn(item);
    NS.log('即时清除蓝点：mid=' + mid + ' 命中元素 ' + n + ' 个');
  }

  /** 页面重渲染后重新应用隐藏（防蓝点复活） */
  var reapplyTimer = null;
  function scheduleReapply() {
    if (reapplyTimer) return;
    reapplyTimer = setTimeout(function () {
      reapplyTimer = null;
      hiddenMids.forEach(function (mid) {
        var rec = NS.state.updates[mid];
        if (!rec || rec.unread) return;
        hideDotForMid(mid, rec.face, rec.name);
      });
    }, 400);
  }

  // ---------------- 保险：监听蓝点被移除 ----------------
  // 有些场景 B 站不经过点击就清掉蓝点（如 URL 带 host_mid 进入时，
  // handleSelectUp 直接把 has_update 置 false）。监听蓝点 DOM 被移除来兜底。
  //
  // 注意必须延迟复查：Vue 重渲染列表（v-for 移动节点）也会触发 childList
  // 移除，不能立刻判定为「已读」。这里记下候选，800ms 后确认该头像真的
  // 没有蓝点了才标记，避免把误报当成已读。
  var pendingDots = {};

  function considerDotRemoved(face) {
    var item = face.closest && face.closest('.bili-dyn-up-list__item');
    if (!item) return;
    var mid = midFromItemElement(item);
    if (!mid) return;
    if (pendingDots[mid]) clearTimeout(pendingDots[mid]);
    pendingDots[mid] = setTimeout(function () {
      delete pendingDots[mid];
      var rec = NS.state.updates[mid];
      if (!rec || !rec.unread) return; // 已读过，别重复写
      var it = findAvatarItem(faceKey(rec.face), rec.name);
      if (!it) return; // 头像条整体不在了，无法确认，宁可不标
      if (!it.querySelector('.bili-dyn-up-list__item__face > span')) NS.markRead(mid);
    }, 800);
  }

  if (window.MutationObserver) {
    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var mu = muts[i];
          if (mu.type !== 'childList' || !mu.removedNodes || !mu.removedNodes.length) continue;
          var face = mu.target;
          if (!face || !face.classList) continue;
          if (!face.classList.contains('bili-dyn-up-list__item__face')) continue;
          for (var j = 0; j < mu.removedNodes.length; j++) {
            var nd = mu.removedNodes[j];
            if (nd.nodeType === 1 && nd.tagName === 'SPAN') {
              considerDotRemoved(face);
              break;
            }
          }
        }
        scheduleReapply();
      });
      var start = function () {
        mo.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true,
        });
      };
      if (document.documentElement) start();
      else document.addEventListener('readystatechange', start, { once: true });
    } catch (e) {
      /* 忽略 */
    }
  }

  // ---------------- 事件: 点击 ----------------
  var MID_IN_URL = /(?:space|t)\.bilibili\.com\/(\d+)/;

  /**
   * 头像条 item 的 mid 反查。
   * 关键：B 站的 item 是 <div> + Vue @click，既没有 <a> 链接也没有 data-mid
   * 属性。按可靠性依次尝试：
   *   1) v-log 埋点指令会把 {mid: ...} 序列化进 data-* 属性（生产环境常缺失）
   *   2) 昵称文本反查 —— B 站把 uname 渲染成 .bili-dyn-up-list__item__name
   *      的纯文本，昵称在插件记录里都有，懒加载/改版都不影响（最可靠）
   *   3) 头像图 hash 反查 —— 受懒加载影响（未加载时 src 是占位图），
   *      读取 currentSrc/src/data-src/srcset 多个来源兜底
   */
  function midFromName(name) {
    if (!name) return null;
    var n = String(name).replace(/\s+/g, '');
    if (!n) return null;
    // 1) 插件记录里找
    for (var mid in NS.state.updates) {
      var r = NS.state.updates[mid];
      if (r && r.name && String(r.name).replace(/\s+/g, '') === n) return String(mid);
    }
    // 2) 官方 up_list 缓存兜底（针对插件从未记录过的官方常看 UP）
    var oc = NS.officialCache;
    if (oc && oc.byName && oc.byName[n]) return String(oc.byName[n]);
    return null;
  }

  function imgSrcOf(img) {
    if (!img) return '';
    var s = '';
    try {
      s = img.currentSrc || '';
    } catch (e) {}
    if (!s) s = img.getAttribute('src') || '';
    if (!s) s = img.getAttribute('data-src') || '';
    if (!s) s = img.srcset || '';
    return String(s);
  }

  function midFromItemElement(item) {
    if (!item) return null;

    // 路 1：解析 data-* 里的 JSON 埋点数据
    if (item.attributes) {
      for (var i = 0; i < item.attributes.length; i++) {
        var attr = item.attributes[i];
        if (attr.name.indexOf('data') !== 0) continue;
        var val = attr.value;
        if (!val || val.length < 8 || val.length > 800) continue;
        if (val.indexOf('{') === -1) continue;
        try {
          var o = JSON.parse(val);
          var m =
            (o && o.value && o.value.mid) ||
            (o && o.mid) ||
            (o && o.show && o.show.value && o.show.value.mid) ||
            (o && o.click && o.click.value && o.click.value.mid);
          if (m && /^\d+$/.test(String(m))) return String(m);
        } catch (e) {
          /* 不是 JSON，跳过 */
        }
      }
    }

    // 路 2（最可靠）：昵称文本反查
    // B 站把 uname 渲染为 .bili-dyn-up-list__item__name 的纯文本，
    // 与懒加载、埋点缺失、图片占位统统无关
    var nameEl = item.querySelector('.bili-dyn-up-list__item__name');
    if (nameEl) {
      var nm = midFromName(nameEl.textContent);
      if (nm) return nm;
    }

    // 路 3：头像图 hash 反查（懒加载时 src 可能是占位图，读多个来源兜底）
    var img = item.querySelector('.bili-dyn-up-list__item__face__img') || item.querySelector('img');
    if (img) {
      var src = imgSrcOf(img);
      var key = faceKey(src);
      if (key) {
        for (var mid in NS.state.updates) {
          var rec = NS.state.updates[mid];
          if (rec && rec.face && faceKey(rec.face) === key) return String(mid);
        }
      }
    }
    return null;
  }

  function midFromEventTarget(t) {
    if (!t || !t.closest) return null;

    var a = t.closest('a[href]');
    if (a) {
      // a.href 是解析后的绝对地址；部分包装元素只有 getAttribute 能取到原始值
      var href = a.href || a.getAttribute('href') || '';
      var m = String(href).match(MID_IN_URL);
      if (m) return m[1];
    }

    var holder = t.closest('[data-mid],[data-uid]');
    if (holder) {
      var v = holder.getAttribute('data-mid') || holder.getAttribute('data-uid');
      if (v && /^\d+$/.test(v)) return v;
    }

    // 头像条 item（最常见路径）
    var item = t.closest('.bili-dyn-up-list__item');
    if (item) {
      var mi = midFromItemElement(item);
      if (mi) return mi;
    }
    return null;
  }

  document.addEventListener(
    'click',
    function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      // 头像条 item：走 markReadFromItem，能把昵称/头像一并带进已读记录
      var item = t.closest('.bili-dyn-up-list__item');
      if (item) {
        if (NS.markReadFromItem(item)) return;
      }
      var mid = midFromEventTarget(t);
      if (mid) NS.markRead(mid);
    },
    true
  );

  // ---------------- 事件: SPA 路由 ----------------
  function checkLocation() {
    var host = location.hostname || '';
    if (host.indexOf('bilibili.com') === -1) return;
    var m = (location.pathname || '').match(/^\/(\d+)(?:\/|$)/);
    if (m) {
      NS.markRead(m[1]);
      return;
    }
    // B 站选中某个 UP 时会把 host_mid 写进查询参数（t.bilibili.com/?host_mid=xxx）
    var q = (location.search || '').match(/[?&]host_mid=(\d+)/);
    if (q) NS.markRead(q[1]);
  }

  if (history && history.pushState) {
    var nativePush = history.pushState;
    var nativeReplace = history.replaceState;
    history.pushState = function () {
      var r = nativePush.apply(this, arguments);
      setTimeout(checkLocation, 0);
      return r;
    };
    if (nativeReplace) {
      history.replaceState = function () {
        var r = nativeReplace.apply(this, arguments);
        setTimeout(checkLocation, 0);
        return r;
      };
    }
    window.addEventListener('popstate', function () {
      setTimeout(checkLocation, 0);
    });
  }

  NS.checkLocationForRead = checkLocation;
})();
