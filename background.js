/*
 * 循环闹钟 — 后台 Service Worker
 * 职责：
 *  - 排程到点唤醒：优先 chrome.alarms 一次性闹钟（delayInMinutes，精度 30 秒）；
 *    部分 Chromium 内核浏览器不支持 time/delayInMinutes 属性（报 Unexpected property），
 *    此时自动降级为 periodInMinutes: 1 每分钟轮询（提醒最多延迟约 1 分钟）。
 *  - 到点触发：补提醒（错过补一次）、打开提醒卡片、推进循环、重新排程
 *  - 角标倒计时：独立 1 分钟周期闹钟（badge-tick）每分钟刷新，
 *    保证一次性闹钟排程模式下（两次触发之间无 tick）角标也不会停更
 */
importScripts('shared/logic.js');

const L = globalThis.AlarmClock;
const STATE_KEY = 'state';
const PENDING_KEY = 'pendingReminders';
const TICK_ALARM = 'clock-tick';
const BADGE_ALARM = 'badge-tick';

// 'one-shot' = delayInMinutes 一次性闹钟；'poll' = 每分钟轮询（降级模式）
let tickMode = 'one-shot';

async function loadState() {
  const obj = await chrome.storage.local.get(STATE_KEY);
  let state = obj[STATE_KEY];
  if (!state || !Array.isArray(state.groups)) state = { version: 1, groups: [] };
  return state;
}

async function saveState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

/** 全局下一次提醒时间 */
function nextOverall(state, now) {
  let best = null;
  for (const g of state.groups) {
    if (g.enabled === false) continue;
    for (const a of g.alarms || []) {
      const t = L.nextFireTime(a, g, now);
      if (t != null && (best == null || t < best)) best = t;
    }
  }
  return best;
}

async function updateBadge() {
  const state = await loadState();
  const now = Date.now();
  const t = nextOverall(state, now);
  try {
    if (t == null) {
      await chrome.action.setBadgeText({ text: '' });
    } else {
      await chrome.action.setBadgeBackgroundColor({ color: '#f76707' });
      await chrome.action.setBadgeText({ text: L.formatCountdown(t - now) });
    }
  } catch (e) { /* 特殊场景（如浏览器关闭中）忽略 */ }
}

/** 排程下一次到点唤醒（兼容不支持 time/delayInMinutes 的浏览器） */
async function scheduleTick() {
  const state = await loadState();
  const now = Date.now();
  const t = nextOverall(state, now);
  if (t == null) {
    try { await chrome.alarms.clear(TICK_ALARM); }
    catch (e) { console.warn('[循环闹钟] 清除闹钟失败', e); }
    return;
  }
  if (tickMode === 'one-shot') {
    try {
      // 一次性闹钟；Chrome 会将其钳制到最小 30 秒
      await chrome.alarms.create(TICK_ALARM, { delayInMinutes: Math.max(0.5, (t - now) / 60000) });
      console.info('[循环闹钟] 排程：' + L.formatDateTime(t) + '（' + tickMode + '）');
      return;
    } catch (e) {
      tickMode = 'poll';
      console.warn('[循环闹钟] 浏览器不支持 delayInMinutes，降级为每分钟轮询', e);
    }
  }
  try {
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
    console.info('[循环闹钟] 排程：每分钟轮询，最近提醒 ' + L.formatDateTime(t));
  } catch (e) {
    console.error('[循环闹钟] chrome.alarms 不可用，无法排程提醒', e);
  }
}

/** 到点处理：触发所有到期闹钟，打开提醒卡片，推进循环并重新排程 */
async function handleTick() {
  const state = await loadState();
  const now = Date.now();
  const fired = [];
  for (const g of state.groups) {
    if (g.enabled === false) continue;
    const win = { start: g.start, end: g.end };
    for (const a of g.alarms || []) {
      if (a.enabled === false) continue;
      // 触发条件：已到期 且 当前在生效时间段内（段外轮次跳过，等段内再触发）
      if (L.dueTime(a) <= now && L.inWindow(now, win)) {
        fired.push({
          groupId: g.id,
          groupName: g.name || '（未命名）',
          alarmId: a.id,
          alarmName: a.name || '（未命名）',
          text: a.text || '',
          firedAt: now
        });
        L.advanceAfterFire(a, g, now);
      }
    }
  }

  if (fired.length) {
    console.info('[循环闹钟] 触发提醒', fired);
    const batchId = L.uid('b');
    await saveState(state);
    const obj = await chrome.storage.local.get(PENDING_KEY);
    const storeP = obj[PENDING_KEY] || { batches: {} };
    const batch = { batchId, firedAt: now, items: fired };
    storeP.batches[batchId] = batch;
    await chrome.storage.local.set({ [PENDING_KEY]: storeP });
    await deliverReminder(batch);
  }
  if (tickMode === 'one-shot') await scheduleTick(); // 一次性闹钟需重新排程
  await updateBadge();
}

/** 交付提醒卡片：优先在当前前台标签页右上角显示；无法显示时回退为新标签页 */
async function deliverReminder(batch) {
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  } catch (e) {
    console.warn('[循环闹钟] 查询前台标签页失败', e);
  }
  if (!tab || tab.id == null) {
    console.warn('[循环闹钟] 未找到前台标签页，回退新标签页');
  } else {
    const msg = { type: 'showReminder', batch };
    try {
      await chrome.tabs.sendMessage(tab.id, msg);
      console.info('[循环闹钟] 提醒卡片已显示在前台标签页（tab ' + tab.id + '）');
      return;
    } catch (e) {
      console.warn('[循环闹钟] 前台标签页（tab ' + tab.id + '）无内容脚本，尝试动态注入', e);
    }
    try {
      if (chrome.scripting) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await chrome.tabs.sendMessage(tab.id, msg);
        console.info('[循环闹钟] 动态注入后提醒卡片已显示（tab ' + tab.id + '）');
        return;
      }
      console.warn('[循环闹钟] 浏览器无 chrome.scripting，无法动态注入');
    } catch (e) {
      console.warn('[循环闹钟] 动态注入失败（tab ' + tab.id + '）', e);
    }
  }
  // 回退：新标签页提醒卡片
  console.info('[循环闹钟] 回退：打开新标签页提醒卡片');
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('reminder.html') + '?batch=' + batch.batchId });
  } catch (e) {
    console.warn('[循环闹钟] 打开提醒页失败', e);
  }
}

/** 测试提醒：立即生成一个测试批次并走完整投递流程（popup「测试提醒」按钮触发） */
async function testReminder() {
  const now = Date.now();
  const batchId = L.uid('b');
  const batch = {
    batchId,
    firedAt: now,
    items: [{
      groupId: 'test', groupName: '测试', alarmId: null, alarmName: '测试提醒',
      text: '这是测试提醒：卡片出现在当前页面右上角，说明页面内提醒正常工作。',
      firedAt: now
    }]
  };
  const obj = await chrome.storage.local.get(PENDING_KEY);
  const storeP = obj[PENDING_KEY] || { batches: {} };
  storeP.batches[batchId] = batch;
  await chrome.storage.local.set({ [PENDING_KEY]: storeP });
  console.info('[循环闹钟] 测试提醒（batch ' + batchId + '）');
  await deliverReminder(batch);
}

/** 页面内卡片「稍后提醒」：设置 snoozedUntil，删除批次中该条目 */
async function handleSnooze(batchId, alarmId, minutes) {
  const min = Math.max(1, Math.floor(Number(minutes) || 5));
  const state = await loadState();
  let found = false;
  for (const g of state.groups) {
    for (const a of g.alarms || []) {
      if (a.id === alarmId) {
        a.snoozedUntil = Date.now() + min * 60000;
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (found) {
    await saveState(state);
    await scheduleTick().catch(e => console.warn('[循环闹钟] 排程失败', e));
    await updateBadge();
  }
  const obj = await chrome.storage.local.get(PENDING_KEY);
  const storeP = obj[PENDING_KEY] || { batches: {} };
  const b = storeP.batches[batchId];
  if (b) {
    b.items = b.items.filter(i => i.alarmId !== alarmId);
    if (!b.items.length) delete storeP.batches[batchId];
    await chrome.storage.local.set({ [PENDING_KEY]: storeP });
  }
}

/** 页面内卡片「关闭」：删除批次 */
async function removeBatch(batchId) {
  const obj = await chrome.storage.local.get(PENDING_KEY);
  const storeP = obj[PENDING_KEY] || { batches: {} };
  if (!storeP.batches[batchId]) return;
  delete storeP.batches[batchId];
  await chrome.storage.local.set({ [PENDING_KEY]: storeP });
}

/** 页面内提醒卡片消息（稍后提醒 / 关闭 / 测试提醒） */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'snooze' && msg.batchId && msg.alarmId != null) {
    handleSnooze(msg.batchId, msg.alarmId, msg.minutes).catch(e => console.warn('[循环闹钟] 稍后提醒处理失败', e));
  } else if (msg.type === 'dismiss' && msg.batchId) {
    removeBatch(msg.batchId).catch(e => console.warn('[循环闹钟] 删除批次失败', e));
  } else if (msg.type === 'testReminder') {
    testReminder().catch(e => console.warn('[循环闹钟] 测试提醒失败', e));
  }
});

/** 确保 1 分钟周期角标闹钟存在。
 *  闹钟由浏览器持久化（SW 被杀、浏览器重启都在），安装/启动时创建一次即可长期生效。 */
async function ensureBadgeTimer() {
  try {
    await chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
  } catch (e) {
    console.warn('[循环闹钟] 角标闹钟创建失败', e);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) handleTick().catch(e => console.error('[循环闹钟] tick 处理失败', e));
  else if (alarm.name === BADGE_ALARM) updateBadge().catch(e => console.warn('[循环闹钟] 角标刷新失败', e));
});

/** 任意页面（popup/options/reminder）修改状态后：重新排程 + 更新角标 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STATE_KEY]) return;
  scheduleTick().then(() => updateBadge()).catch(e => console.warn('[循环闹钟] 排程失败', e));
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const obj = await chrome.storage.local.get(STATE_KEY);
  if (!obj[STATE_KEY]) await saveState({ version: 1, groups: [] });
  await ensureBadgeTimer();
  await scheduleTick().catch(e => console.warn('[循环闹钟] 排程失败', e));
  await updateBadge();
  if (details.reason === 'install') {
    try { await chrome.runtime.openOptionsPage(); } catch (e) { /* 忽略 */ }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureBadgeTimer();
  await scheduleTick().catch(e => console.warn('[循环闹钟] 排程失败', e));
  await updateBadge();
  // 浏览器重启：错过的提醒会在下一次 tick 补提醒一次
});
