/**
 * Service Worker：安装时写入默认配置 + 维护工具栏角标未读数
 */
const KEY_CONFIG = 'bud_config';
const KEY_META = 'bud_meta';
const KEY_UPDATES = 'bud_updates';

const DEFAULT_CONFIG = {
  enabled: true,
  intervalMin: 3,
  maxUpList: 60,
  debug: false,
  types: { av: true, word: true, draw: true, forward: true, live: true },
};

const DEFAULT_META = { lastMaxTs: 0, lastScanAt: 0, baselineDone: false, wbi: null };

function countUnread(updates) {
  if (!updates) return 0;
  return Object.keys(updates).filter((mid) => updates[mid] && updates[mid].unread).length;
}

async function refreshBadge() {
  try {
    const res = await chrome.storage.local.get([KEY_CONFIG, KEY_UPDATES]);
    const config = Object.assign({}, DEFAULT_CONFIG, res[KEY_CONFIG] || {});
    const n = config.enabled ? countUnread(res[KEY_UPDATES]) : 0;
    await chrome.action.setBadgeBackgroundColor({ color: '#00AEEC' });
    await chrome.action.setBadgeText({ text: n > 0 ? String(n > 99 ? '99+' : n) : '' });
  } catch (e) {
    /* 忽略 */
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const res = await chrome.storage.local.get([KEY_CONFIG, KEY_META, KEY_UPDATES]);
  const patch = {};
  if (!res[KEY_CONFIG]) patch[KEY_CONFIG] = DEFAULT_CONFIG;
  if (!res[KEY_META]) patch[KEY_META] = DEFAULT_META;
  if (!res[KEY_UPDATES]) patch[KEY_UPDATES] = {};
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(refreshBadge);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[KEY_UPDATES] || changes[KEY_CONFIG]) refreshBadge();
});

// 供 popup 直接查询（popup 也可自行读 storage，这里提供统一入口）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.__bud) return undefined;
  if (msg.action === 'GET_UNREAD') {
    chrome.storage.local.get([KEY_CONFIG, KEY_UPDATES], (res) => {
      const config = Object.assign({}, DEFAULT_CONFIG, res[KEY_CONFIG] || {});
      sendResponse({ ok: true, unread: config.enabled ? countUnread(res[KEY_UPDATES]) : 0 });
    });
    return true;
  }
  return undefined;
});
