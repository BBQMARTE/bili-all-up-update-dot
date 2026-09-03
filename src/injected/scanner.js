/**
 * 增量扫描器 + 未读状态模型
 * ---------------------------------------------------------------
 * 核心：关注动态流 feed/all 是「时间倒序的全部关注」，不是算法推荐，
 * 所以只要沿时间轴增量翻页，就能覆盖到所有关注 UP（包括小众 / 低产 UP）。
 *
 * 停止条件（命中任一即停）：
 *   1) 某条动态 pub_ts <= meta.lastMaxTs（说明已追到上次的进度）
 *   2) data.has_more 为 false 或没有下一页 offset
 *   3) 翻页超过 MAX_PAGES（防御死循环）
 *
 * 首轮只建立基线（lastMaxTs），不打任何蓝点，避免一装上就满屏蓝点。
 */
(function () {
  'use strict';
  var NS = window.__BiliAllUpDot;

  var MAX_PAGES = 5; // 单次扫描最多翻页数（防御）
  var MAX_LIVE_PAGES = 2; // 直播列表最多翻页数
  var OLD_KEEP_SEC = 90 * 24 * 3600; // 已读条目保留 90 天
  var MAX_RECORDS = 1000; // 记录上限，超出按时间淘汰
  // 「已见动态 id」游标上限。关注 UP 多、动态密度高时会滚动淘汰，
  // 因此不能只靠它判重（已读保护由 UP 维度的 readAtTs 兜底）。
  var MAX_SEEN_IDS = 2000;
  var MAX_TS_CACHE = 3000; // 动态时间戳缓存上限（消除相对时间漂移用）

  // ---------------- 解析 ----------------
  function toSec(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function tsFromText(t) {
    if (typeof t !== 'string' || !t) return 0;
    // 绝对时间：2026-09-01 12:30 或 2026/09/01 12:30:00
    var abs = t.match(
      /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/
    );
    if (abs) {
      return Math.floor(
        new Date(+abs[1], +abs[2] - 1, +abs[3], +abs[4], +abs[5], +(abs[6] || 0)).getTime() / 1000
      );
    }
    // 相对时间兜底：「3分钟前」「2小时前」「昨天 20:11」
    var rel = t.match(/(\d+)\s*(秒|分钟|小时|天)前/);
    if (rel) {
      var mult = { 秒: 1, 分钟: 60, 小时: 3600, 天: 86400 }[rel[2]] || 60;
      return Math.floor(Date.now() / 1000) - Number(rel[1]) * mult;
    }
    return 0;
  }

  function parseItem(it) {
    if (!it) return null;
    var mods = it.modules || {};
    var author = mods.module_author || {};
    var mid = author.mid;
    if (!mid) return null;

    var type = it.type || '';
    // feed/all 里可能是 http://，注入 up_list 后会被浏览器按混合内容拦截
    var face = author.face || '';
    if (face.indexOf('http://') === 0) face = 'https://' + face.slice(7);

    // 动态 id：雪花序、单调递增、稳定不变
    var dynId =
      it.id_str || it.id || (it.basic && it.basic.rid_str) || '';

    // seq：比较「新不新」的唯一可靠基准。
    // id_str 是雪花算法生成的 64 位整数，随时间单调递增且永不重复、永不受
    // 相对时间（如「3小时前」）解析漂移影响。取不到时为 0，
    // 0 在任何比较中都会判定为「不比已读进度新」，因此不会误点亮。
    var seq = 0;
    if (dynId && /^\d+$/.test(String(dynId))) {
      var nv = Number(dynId);
      if (isFinite(nv) && nv > 0) seq = nv;
    }

    // 时间戳解析（带缓存，消除相对时间漂移）：
    // B 站很多动态只给相对时间（「3小时前」），每次解析都会得到一个更大的
    // 绝对值 —— 同一条动态的时间戳会不断「变新」，导致所有基于时间的
    // 已读判据失效。这里对同一条动态只解析一次并缓存，之后永远复用。
    var ts = 0;
    var cache = NS.state.meta && NS.state.meta.tsById;
    if (!cache) {
      cache = NS.state.meta.tsById = {};
    }
    if (dynId && cache[dynId]) {
      ts = cache[dynId];
    } else {
      ts = toSec(author.pub_ts);
      if (!ts) ts = tsFromText(author.pub_time);
      // 仍然不用 Date.now() 兜底：那会让时间戳自我膨胀，每次刷新都算新动态
      if (ts && dynId) cache[dynId] = ts;
    }

    return {
      mid: String(mid),
      name: author.name || '',
      face: face,
      ts: ts,
      seq: seq,
      type: type,
      kind: NS.kindOf(type),
      id: dynId ? String(dynId) : '',
    };
  }

  // ---------------- 持久化 ----------------
  var saveTimer = null;
  function schedulePersist() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      NS.persist();
    }, 400);
  }

  NS.persistMeta = function () {
    schedulePersist();
  };

  NS.persist = function () {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    NS.bridge
      .call(
        'SAVE_STATE',
        { meta: NS.state.meta, updates: NS.state.updates, config: NS.state.config },
        8000
      )
      .catch(function (e) {
        NS.log('持久化失败：', e && e.message);
      });
  };

  // ---------------- 清理 ----------------
  function cleanup() {
    var nowSec = Math.floor(Date.now() / 1000);
    var list = [];
    var mid;
    for (mid in NS.state.updates) {
      var r = NS.state.updates[mid];
      if (!r) {
        delete NS.state.updates[mid];
        continue;
      }
      if (!r.unread && r.lastPubTs && nowSec - r.lastPubTs > OLD_KEEP_SEC) {
        delete NS.state.updates[mid];
        continue;
      }
      list.push(r);
    }
    if (list.length > MAX_RECORDS) {
      list.sort(function (a, b) {
        return (b.lastPubTs || 0) - (a.lastPubTs || 0);
      });
      var keep = {};
      for (var i = 0; i < MAX_RECORDS; i++) keep[String(list[i].mid)] = list[i];
      NS.state.updates = keep;
    }

    // 时间戳缓存上限：雪花 id 越大越新，保留最大的 N 条即可
    var tsById = st.meta.tsById;
    if (tsById) {
      var ids = Object.keys(tsById);
      if (ids.length > MAX_TS_CACHE) {
        ids.sort(function (a, b) {
          return Number(b) - Number(a);
        });
        var kept = {};
        for (var k = 0; k < MAX_TS_CACHE; k++) kept[ids[k]] = tsById[ids[k]];
        st.meta.tsById = kept;
      }
    }
  }

  // ---------------- 主流程 ----------------
  NS.__scanning = null;

  NS.scan = function (reason) {
    if (NS.__scanning) return NS.__scanning;
    NS.__scanning = (async function () {
      try {
        return await doScan(reason);
      } catch (e) {
        NS.log('扫描异常：', e && e.message);
        return null;
      } finally {
        NS.__scanning = null;
      }
    })();
    return NS.__scanning;
  };

  async function doScan(reason) {
    var st = NS.state;
    if (!st.config.enabled) {
      NS.log('已停用，跳过扫描（' + (reason || '') + '）');
      return null;
    }

    // --- 1. 动态流增量翻页 ---
    // 关键：不能用 pub_ts 作为增量游标。
    // B 站 feed/all 的 pub_time 常是「1小时前」这类相对时间，解析出的 ts 会随
    // 当前时间漂移 —— 每次刷新都算出比上次更大的值，于是同一条动态永远被
    // 判成「新动态」，已读的蓝点刷新后又回来了。
    // 改用动态 id（id_str，雪花序、稳定不变）作为「已见过」的判定依据。
    var items = [];
    var offset = '';
    var pages = 0;
    var stop = false;
    var maxTs = st.meta.lastMaxTs || 0;
    var apiOk = false;

    // 基线：首次运行，或从旧版本升级过来 seenIds 还没建立时，都只记录不点蓝点
    var seenIds = Array.isArray(st.meta.seenIds) ? st.meta.seenIds : [];
    var baseline = !st.meta.baselineDone || seenIds.length === 0;
    var seenSet = {};
    for (var si = 0; si < seenIds.length; si++) seenSet[seenIds[si]] = 1;
    var newIds = [];

    while (!stop && pages < MAX_PAGES) {
      var r = null;
      try {
        r = await NS.api.getFeedPage(offset);
      } catch (e) {
        NS.log('feed/all 请求失败：', e && e.message);
        break;
      }
      if (!r || r.code !== 0 || !r.data) {
        NS.log('feed/all 返回异常，code =', r && r.code);
        break;
      }
      apiOk = true; // 至少有一次成功响应
      if (r.data.update_baseline) st.meta.updateBaseline = r.data.update_baseline;
      var list = r.data.items || [];
      if (!list.length) break;

      for (var i = 0; i < list.length; i++) {
        var p = parseItem(list[i]);
        if (!p) continue;
        if (p.ts > maxTs) maxTs = p.ts;

        if (!p.id) {
          // 拿不到稳定 id 就不要参与「新动态」判定，宁可漏报也不重复报
          continue;
        }
        if (seenSet[p.id]) {
          stop = true; // 追平上次进度
          continue;
        }
        seenSet[p.id] = 1;
        newIds.push(p.id);
        // 基线阶段也要记录 name/face（方便展示），只是不打蓝点
        p.isNew = !baseline;
        items.push(p);
      }

      pages++;
      if (!r.data.has_more || !r.data.offset) {
        stop = true;
      } else {
        offset = r.data.offset;
        if (baseline) {
          // 首轮基线最多 2 页即可建立 id 锚点，避免一次性拉太多
          if (pages >= 2) stop = true;
        }
      }
    }

    // --- 2. 落盘 seenIds（上限 500，超出淘汰最旧的） ---
    st.meta.seenIds = newIds
      .concat(seenIds)
      .slice(0, MAX_SEEN_IDS);

    // --- 3. 写入 updates ---
    items.sort(function (a, b) {
      return a.ts - b.ts;
    });
    var changed = items.length > 0;
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var rec = st.updates[it.mid];
      if (!rec) {
        rec = {
          mid: it.mid,
          name: it.name,
          face: it.face,
          lastPubTs: 0,
          type: it.type,
          kind: it.kind,
          unread: false,
          seenAt: 0,
        };
        st.updates[it.mid] = rec;
      }
      if (it.name) rec.name = it.name;
      if (it.face) rec.face = it.face;

      // 已读保护（UP 维度，独立于会淘汰的 seenIds 游标）：
      // 两个判据任一命中即判定「这条不比已读进度新」，不点亮：
      //   1) seq（首选）：雪花序 id，单调递增且永不漂移。用户读过后记下
      //      readAtSeq，同一条动态再次出现时 seq 不变，必然被判定为已读。
      //   2) ts（兜底）：老数据没有 readAtSeq 时用时间戳比较。
      // 只有真正更新的动态（seq 更大 / 时间更晚）才会重新点亮。
      // 注意：值为 0 表示「未知」，绝不能参与比较 —— 否则时间字段缺失的动态
      // 会被 ts=0 <= readAtTs 恒真地误判成已读，导致真新动态也点不亮。
      var alreadyRead =
        (rec.readAtSeq && it.seq > 0 && it.seq <= rec.readAtSeq) ||
        (rec.readAtTs && it.ts > 0 && it.ts <= rec.readAtTs);

      if (it.isNew && !alreadyRead && NS.typeEnabled(it.kind)) {
        // 复活追踪：把「用户明明点过却又被点亮」的完整判定依据打出来，
        // 便于一次性定位原因，而不是靠猜。
        if (rec.seenAt) {
          console.warn(
            '[全UP蓝点] 复活警告：准备重新点亮用户已读过的 UP\n' +
              '  UP：' + rec.name + '（mid=' + it.mid + '）\n' +
              '  本次动态：seq=' + it.seq + ' ts=' + it.ts + '（' + (it.ts ? new Date(it.ts * 1000).toISOString() : '未知') + '）\n' +
              '  已读进度：readAtSeq=' + (rec.readAtSeq || 0) + ' readAtTs=' + (rec.readAtTs || 0) + '\n' +
              '  该UP记录：lastSeq=' + (rec.lastSeq || 0) + ' lastPubTs=' + (rec.lastPubTs || 0) + '\n' +
              '  判定：seq判据=' + !!(rec.readAtSeq && it.seq > 0 && it.seq <= rec.readAtSeq) +
              ' 时间判据=' + !!(rec.readAtTs && it.ts > 0 && it.ts <= rec.readAtTs) +
              ' isNew=' + it.isNew
          );
        }
        rec.unread = true;
      }

      if (it.ts > (rec.lastPubTs || 0)) {
        rec.lastPubTs = it.ts;
        rec.type = it.type;
        rec.kind = it.kind;
      }
      if (it.seq > (rec.lastSeq || 0)) rec.lastSeq = it.seq;
    }

    // --- 3. 直播开播 ---
    var liveMids = {};
    if (NS.typeEnabled('live')) {
      var lp = 1;
      while (lp <= MAX_LIVE_PAGES) {
        var lr = null;
        try {
          lr = await NS.api.getLiveRooms(lp);
        } catch (e) {
          lr = null;
        }
        var rooms = lr && lr.code === 0 && lr.data && lr.data.list;
        if (!rooms || !rooms.length) break;
        for (var k = 0; k < rooms.length; k++) {
          var room = rooms[k] || {};
          if (room.live_status !== 1) continue;
          var uid = room.uid || room.mid;
          if (!uid) continue;
          liveMids[String(uid)] = {
            name: room.uname || room.title || '',
            face: room.face || '',
            title: room.title || '',
          };
        }
        if (rooms.length < 30) break;
        lp++;
      }

      var nowSecL = Math.floor(Date.now() / 1000);
      var midKey;
      for (midKey in liveMids) {
        var info = liveMids[midKey];
        var lr2 = st.updates[midKey];
        if (!lr2) {
          lr2 = {
            mid: midKey,
            name: info.name,
            face: info.face,
            lastPubTs: nowSecL,
            type: 'DYNAMIC_TYPE_LIVE',
            kind: 'live',
            unread: true,
            seenAt: 0,
          };
          st.updates[midKey] = lr2;
          changed = true;
        } else if (lr2.kind === 'live') {
          if (!lr2.unread) changed = true;
          lr2.unread = true;
          lr2.lastPubTs = nowSecL;
          if (info.name) lr2.name = info.name;
          if (info.face) lr2.face = info.face;
        } else {
          // 该 UP 最近有其它类型动态，直播状态不覆盖其记录
        }
      }
      // 已下播的：清掉由直播产生的未读
      for (midKey in st.updates) {
        var rr = st.updates[midKey];
        if (rr && rr.kind === 'live' && rr.unread && !liveMids[midKey]) {
          rr.unread = false;
          rr.seenAt = Date.now();
          changed = true;
        }
      }
    }

    // --- 4. 收尾 ---
    // 关键：只有真的拿到过数据才算「扫描成功」。
    // 否则一次接口失败就会把 baselineDone/lastScanAt 写成已就绪，
    // 导致 buildUpList 误以为扫描正常而错误清除官方蓝点。
    if (apiOk) {
      if (maxTs > (st.meta.lastMaxTs || 0)) st.meta.lastMaxTs = maxTs;
      st.meta.lastScanAt = Date.now();
      if (baseline) st.meta.baselineDone = true;
    } else {
      NS.log('本轮未取得任何数据（未登录 / 风控 / 接口异常），保持官方行为');
    }

    cleanup();
    if (apiOk && (changed || baseline)) NS.persist();

    var unreadCount = 0;
    for (var m in st.updates) {
      if (st.updates[m] && st.updates[m].unread) unreadCount++;
    }
    NS.log(
      '扫描完成（' + (reason || '') + '）：新增 ' +
        items.length + ' 条，未读 UP ' + unreadCount + ' 位' +
        (apiOk ? '' : '，接口未成功')
    );

    // 通知页面侧：数据已就绪
    NS.bridge.emit('SCAN_DONE', { unread: unreadCount, at: st.meta.lastScanAt, ok: apiOk });
    return { items: items.length, unread: unreadCount, ok: apiOk };
  }

  /**
   * 首次拦截 portal 前需要等扫描落地，否则会白放行一次官方数据。
   * 最多等 3 秒，超时按官方数据放行（绝不阻塞页面）。
   */
  NS.hasScanData = function () {
    return NS.state.meta.baselineDone === true;
  };

  NS.__scanReady = null;
  NS.ensureScanReady = function () {
    if (NS.hasScanData()) return Promise.resolve(true);
    if (!NS.__scanReady) {
      NS.__scanReady = new Promise(function (resolve) {
        var t0 = Date.now();
        (function tick() {
          if (NS.hasScanData() || Date.now() - t0 > 3000) return resolve(true);
          setTimeout(tick, 80);
        })();
      });
    }
    return NS.__scanReady;
  };
})();
