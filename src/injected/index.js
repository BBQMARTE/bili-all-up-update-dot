/**
 * MAIN world 入口：装配各模块、加载持久化状态、启动定时扫描
 */
(function () {
  'use strict';
  var NS = window.__BiliAllUpDot;

  var timer = null;

  function mergeConfig(loaded) {
    if (!loaded) return;
    var base = NS.clone(NS.DEFAULT_CONFIG);
    var next = {
      enabled: typeof loaded.enabled === 'boolean' ? loaded.enabled : base.enabled,
      intervalMin: Number(loaded.intervalMin) || base.intervalMin,
      maxUpList: Number(loaded.maxUpList) || base.maxUpList,
      debug: !!loaded.debug,
      types: Object.assign({}, base.types, loaded.types || {}),
    };
    NS.state.config = next;
  }

  function scheduleNext() {
    if (timer) clearTimeout(timer);
    var min = Math.max(1, Math.min(60, Number(NS.state.config.intervalMin) || 3));
    timer = setTimeout(function () {
      timer = null;
      // 页面不可见时跳过，回来立刻补一次
      if (document.visibilityState === 'hidden') {
        scheduleNext();
        return;
      }
      NS.scan('定时兜底').then(scheduleNext, scheduleNext);
    }, min * 60 * 1000);
  }

  /**
   * 廉价轮询：B 站前端自己就是每 30 秒打一次 /feed/all/update，
   * 只返回一个 update_num 数字。>0 才真正翻页扫描，
   * 这样几乎零开销就能做到准实时点亮蓝点。
   */
  var POLL_MS = 45000;
  var lastScanAt = 0;
  function cheapPoll() {
    if (!NS.state.config.enabled) return;
    if (document.visibilityState === 'hidden') return;
    // 距上次真正扫描太近就不重复触发
    if (Date.now() - lastScanAt < 60000) return;

    var bl = NS.state.meta.updateBaseline;
    if (!bl) return; // 还没有基线，交给定时兜底扫描

    NS.api
      .getUpdateNum(bl)
      .then(function (r) {
        if (r && r.code === 0 && r.data && Number(r.data.update_num) > 0) {
          NS.log('检测到 ' + r.data.update_num + ' 条新动态，开始扫描');
          NS.scan('检测到新动态');
        }
      })
      .catch(function (e) {
        NS.log('update 轮询失败：', e && e.message);
      });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && NS.state.config.enabled) {
      NS.scan('页面回到前台');
    }
  });

  // ---------------- 来自 ISOLATED world 的推送 ----------------
  NS.bridge.on('CONFIG', function (cfg) {
    mergeConfig(cfg);
    NS.log('配置已更新', cfg);
    scheduleNext();
    if (!NS.state.config.enabled) {
      // 停用时不改变已渲染的页面，下次刷新自然恢复官方行为
      NS.log('插件已停用');
    }
  });

  NS.bridge.on('REFRESH', function () {
    NS.log('收到立即刷新指令');
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    NS.scan('手动刷新').then(scheduleNext, scheduleNext);
  });

  // 记录「真正发起扫描」的时间，供廉价轮询做节流
  var rawScan = NS.scan;
  NS.scan = function (reason) {
    lastScanAt = Date.now();
    return rawScan(reason);
  };

  NS.bridge.on('MARK_ALL_READ', function () {
    NS.markAllRead();
  });

  // ---------------- 启动 ----------------
  (async function boot() {
    try {
      var saved = await NS.bridge.call('GET_STATE', null, 8000);
      if (saved) {
        mergeConfig(saved.config);
        if (saved.meta) {
          NS.state.meta = Object.assign(
            {
              lastMaxTs: 0,
              lastScanAt: 0,
              baselineDone: false,
              wbi: null,
              updateBaseline: '',
              seenIds: [],
            },
            saved.meta
          );
        }
        if (saved.updates && typeof saved.updates === 'object') {
          NS.state.updates = saved.updates;
        }
      }
    } catch (e) {
      NS.log('读取本地状态失败，使用默认值：', e && e.message);
    }

    NS.log(
      '启动完成｜已登录状态未知｜已存记录 ' +
        Object.keys(NS.state.updates || {}).length +
        ' 条｜基线 ' +
        (NS.state.meta.baselineDone ? '已完成' : '待建立')
    );

    // 直接进入某个 UP 的空间页：视为已读
    if (NS.checkLocationForRead) NS.checkLocationForRead();

    if (NS.state.config.enabled) {
      // 动态页立即扫；其它页面稍等 1.5s 再扫，避免与主文档请求抢带宽
      var delay = location.hostname === 't.bilibili.com' ? 0 : 1500;
      setTimeout(function () {
        NS.scan('启动').then(scheduleNext, scheduleNext);
      }, delay);
      // 廉价轮询：只在 B 站报告有新动态时才真正扫描
      setInterval(cheapPoll, POLL_MS);
    } else {
      scheduleNext();
    }
  })();

  // ---------------- 调试入口 ----------------
  // 控制台执行 __BiliAllUpDot.debugInfo() 可查看运行状态 + 页面 DOM 诊断
  NS.debugInfo = function () {
    var unread = [];
    var mid;
    for (mid in NS.state.updates) {
      var r = NS.state.updates[mid];
      if (r && r.unread) unread.push({ mid: mid, name: r.name, kind: r.kind, ts: r.lastPubTs });
    }
    unread.sort(function (a, b) {
      return b.ts - a.ts;
    });

    // 顺便打开日志，方便用户刷新页面后捕获 portal 改写过程
    NS.state.config.debug = true;

    var strip = document.querySelector('.bili-dyn-up-list');
    var items = document.querySelectorAll('.bili-dyn-up-list__item');
    var dots = document.querySelectorAll('.bili-dyn-up-list__item__face > span');
    var faces = document.querySelectorAll('.bili-dyn-up-list__item__face__img');

    var report = {
      version: '1.4.2',
      当前页面: location.href,
      配置: NS.state.config,
      meta: NS.state.meta,
      累计记录数: Object.keys(NS.state.updates).length,
      未读UP: unread.map(function (u) {
        return u.name + '（' + u.kind + '）';
      }),
      previewUpList: NS.buildUpList([]),
      页面DOM诊断: {
        头像条容器存在: !!strip,
        头像条item数量: items.length,
        头像img数量: faces.length,
        蓝点span数量: dots.length,
      },
    };

    console.log('%c[全UP蓝点] 诊断报告', 'color:#00AEEC;font-weight:bold;font-size:13px');
    console.log(report);

    if (report.页面DOM诊断.头像条item数量 === 0) {
      console.warn(
        '[全UP蓝点] 页面上没有找到头像条（.bili-dyn-up-list）。\n' +
          '可能原因：① 你不在动态页（需打开 t.bilibili.com）；② B 站改版换了组件类名。\n' +
          '请在动态页刷新后再执行一次本命令。'
      );
    } else if (report.页面DOM诊断.蓝点span数量 === 0 && unread.length > 0) {
      console.warn(
        '[全UP蓝点] 数据层有 ' + unread.length + ' 个未读，但页面一个蓝点都没渲染。\n' +
          '说明 portal 响应没有改写成功。请刷新页面后，把控制台里带「[全UP蓝点]」前缀的日志全部复制发我。'
      );
    }
    return report;
  };
})();
