/*
 * 循环闹钟 — 后台 Service Worker
 * 职责：
 *  - 排程唤醒：按 when → delayInMinutes → periodInMinutes 顺序探测浏览器支持的方式
 *      · when / delayInMinutes：一次性闹钟，排程在「目标时刻 − PREWAKE_LEAD」提前唤醒
 *      · periodInMinutes：降级轮询（0.5 分钟优先，被浏览器钳制则为 1 分钟）
 *  - 精确等待：唤醒后若距目标时刻已进入 MAX_WAIT 窗口，用 setTimeout 精确等到点再触发
 *    （等待期间每 10 秒调一次扩展 API 心跳，避免 SW 被 30 秒空闲回收）。
 *    这样把「平台唤醒抖动」与「弹窗时刻」解耦：先粗略叫醒，再精确触发，弹窗误差降到毫秒级。
 *  - 到点触发：补提醒（错过补一次）、打开提醒卡片、按计划网格推进循环、重新排程
 *  - 角标倒计时：独立 1 分钟周期闹钟（badge-tick）每分钟刷新，
 *    保证一次性闹钟排程模式下（两次触发之间无 tick）角标也不会停更
 */
importScripts('shared/logic.js');

const L = globalThis.AlarmClock;
const STATE_KEY = 'state';
const PENDING_KEY = 'pendingReminders';
const TICK_ALARM = 'clock-tick';
const BADGE_ALARM = 'badge-tick';
// 兜底闹钟：排在目标时刻之后一点点。若 SW 在精确等待期间被回收、或提前唤醒闹钟丢失，
// 它仍会把 SW 叫醒并按"已到期"补提醒（最坏情况等于退回旧的一次性排程精度，不会漏提醒）
const BACKUP_ALARM = 'clock-backup';

// 提前唤醒量：早于目标时刻这么久叫醒 SW（给平台闹钟的抖动留余量）
const PREWAKE_LEAD_MS = 20000;
// 精确等待上限：必须明显小于 SW 30 秒空闲回收阈值
const MAX_WAIT_MS = 27000;
// 精确等待期间的心跳间隔（调一次扩展 API 即重置 SW 空闲计时）
const KEEPALIVE_MS = 10000;
// 一次性闹钟最长延迟（超过则先唤醒再链式重排），防极端远未来值
const MAX_CHAIN_WAKE_MS = 59.5 * 60000;
// 轮询周期（分钟）：0.5 = 30 秒，是 Chrome 支持的最小值，更小会被钳制
const POLL_MINUTES = 0.5;

// 最近一次成功的排程方式：'when' | 'delay' | 'poll' | 'idle'（诊断显示用）
let schedMode = null;

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

/** 排程串行化：连续的 config 变更依次执行，防止两次排程交错时
 *  最后一次 pending 的一次性闹钟对应过期状态（如改配置让下次提醒提前，
 *  却仍保留更早一次排程排出的更晚闹钟）。 */
let schedChain = Promise.resolve();

/** 记录排程方式与目标时刻（选项页「运行诊断」显示用） */
async function recordScheduleInfo(mode, target) {
  try {
    await chrome.storage.local.set({ scheduleInfo: { mode, target, at: Date.now() } });
  } catch (e) { /* 忽略 */ }
}

/** 累计触发偏差（实际触发时刻 − 计划时刻，正数 = 偏晚），供选项页诊断显示 */
async function recordFireStat(due, now) {
  try {
    const obj = await chrome.storage.local.get('fireStats');
    const s = obj.fireStats || { n: 0, sum: 0, last: 0, max: 0 };
    const delta = now - due;
    s.n += 1;
    s.sum += delta;
    s.last = delta;
    s.max = Math.max(s.max, Math.abs(delta));
    await chrome.storage.local.set({ fireStats: s });
  } catch (e) { /* 忽略 */ }
}

/**
 * 精确等待到目标时刻：循环校验（防 setTimeout 提前触发 / 系统时钟微调）
 * 等待期间每 KEEPALIVE_MS 调一次扩展 API 心跳，避免 SW 被 30 秒空闲回收。
 */
async function sleepUntil(target) {
  let hb = null;
  try {
    hb = setInterval(() => { chrome.storage.local.get('__keepalive').catch(() => {}); }, KEEPALIVE_MS);
  } catch (e) { /* 环境不支持 setInterval 时退化为纯等待 */ }
  try {
    for (let i = 0; i < 8; i++) {
      const d = target - Date.now();
      if (d <= 0) break;
      await new Promise(r => setTimeout(r, d));
    }
  } finally {
    if (hb != null) clearInterval(hb);
  }
  return Date.now();
}

/** 排程下一次唤醒：早于目标 PREWAKE_LEAD_MS 叫醒 SW（when / delayInMinutes），
 *  都不支持时降级为周期轮询。每次排程都从最优方式开始探测（自愈：浏览器升级后自动恢复）。 */
function scheduleTick() {
  const run = async () => {
    const state = await loadState();
    const now = Date.now();
    const t = nextOverall(state, now);
    if (t == null) {
      try { await chrome.alarms.clear(TICK_ALARM); await chrome.alarms.clear(BACKUP_ALARM); }
      catch (e) { console.warn('[循环闹钟] 清除闹钟失败', e); }
      await recordScheduleInfo('idle', null);
      return;
    }
    // 提前唤醒点；封顶 MAX_CHAIN_WAKE_MS 防极端远未来值（到期后链式重排）
    const wakeAt = Math.min(Math.max(now + 1000, t - PREWAKE_LEAD_MS), now + MAX_CHAIN_WAKE_MS);
    for (const mode of ['when', 'delay', 'poll']) {
      try {
        if (mode === 'when') {
          await chrome.alarms.create(TICK_ALARM, { when: wakeAt });
        } else if (mode === 'delay') {
          await chrome.alarms.create(TICK_ALARM, { delayInMinutes: Math.max(0.5, (wakeAt - now) / 60000) });
        } else {
          await chrome.alarms.create(TICK_ALARM, { periodInMinutes: POLL_MINUTES });
        }
        if (mode === 'poll') {
          // 轮询本身就是兜底，不需要额外的兜底闹钟
          try { await chrome.alarms.clear(BACKUP_ALARM); } catch (e) { /* 忽略 */ }
        } else {
          try { await chrome.alarms.create(BACKUP_ALARM, { when: Math.max(now + 1000, t + 1000) }); }
          catch (e) { /* 兜底闹钟可选，失败不影响主排程 */ }
        }
        if (schedMode !== mode) {
          schedMode = mode;
          console.info('[循环闹钟] 排程方式：' + mode +
            (mode === 'poll' ? '（降级轮询 ' + (POLL_MINUTES * 60) + ' 秒）'
                             : '（提前 ' + (PREWAKE_LEAD_MS / 1000) + ' 秒唤醒，目标 ' + L.formatDateTime(t) + '）'));
        }
        await recordScheduleInfo(mode, t);
        return;
      } catch (e) {
        if (schedMode !== 'poll') console.warn('[循环闹钟] 排程方式 ' + mode + ' 不可用，尝试降级', e);
      }
    }
    console.error('[循环闹钟] chrome.alarms 不可用，无法排程提醒');
  };
  schedChain = schedChain.then(run, run);
  return schedChain;
}

/** 触发所有到期闹钟（now 在生效时间段内才触发），推进循环并投递提醒卡片。
 *  锚点按「计划时刻」重算（见 logic.advanceAfterFire），不把唤醒抖动写进后续轮次。 */
async function fireDue(now) {
  const state = await loadState();
  const fired = [];
  let firstDue = null;
  for (const g of state.groups) {
    if (g.enabled === false) continue;
    const win = { start: g.start, end: g.end };
    for (const a of g.alarms || []) {
      if (a.enabled === false) continue;
      const due = L.dueTime(a);
      // 触发条件：已到期 且 当前在生效时间段内（段外轮次跳过，等段内再触发）
      if (due <= now && L.inWindow(now, win)) {
        fired.push({
          groupId: g.id,
          groupName: g.name || '（未命名）',
          alarmId: a.id,
          alarmName: a.name || '（未命名）',
          text: a.text || '',
          firedAt: now,
          dueAt: due
        });
        L.advanceAfterFire(a, g, due, now);
        if (firstDue == null) firstDue = due;
      }
    }
  }
  if (!fired.length) return false;

  console.info('[循环闹钟] 触发提醒', fired);
  const batchId = L.uid('b');
  await saveState(state);
  const obj = await chrome.storage.local.get(PENDING_KEY);
  const storeP = obj[PENDING_KEY] || { batches: {} };
  const batch = { batchId, firedAt: now, items: fired };
  storeP.batches[batchId] = batch;
  await chrome.storage.local.set({ [PENDING_KEY]: storeP });
  if (firstDue != null) await recordFireStat(firstDue, now);
  await deliverReminder(batch);
  return true;
}

/** 到点处理（串行化，防并发重复触发）：
 *  1) 触发所有已到期闹钟（补提醒语义不变）
 *  2) 若下一个目标已进入 MAX_WAIT 窗口 → 精确等到点后回到 1) 触发（毫秒级精度）
 *  3) 一次性排程模式下按最新配置重新排程 + 刷新角标 */
let tickChain = Promise.resolve();
function handleTick() {
  const run = async () => {
    for (let guard = 0; guard < 3; guard++) {
      await fireDue(Date.now());
      const t = nextOverall(await loadState(), Date.now());
      if (t == null) break;
      const d = t - Date.now();
      if (d <= 0 || d > MAX_WAIT_MS) break;
      // 目标已在等待窗口内：精确等到点，再回到循环顶部按最新状态触发
      await sleepUntil(t);
    }
    if (schedMode !== 'poll') await scheduleTick(); // 一次性闹钟需重新排程
    await updateBadge();
  };
  tickChain = tickChain.then(run, run);
  return tickChain;
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
  if (alarm.name === TICK_ALARM || alarm.name === BACKUP_ALARM) {
    handleTick().catch(e => console.error('[循环闹钟] tick 处理失败', e)); // 未到期时为空操作，天然去重
  } else if (alarm.name === BADGE_ALARM) {
    updateBadge().catch(e => console.warn('[循环闹钟] 角标刷新失败', e));
  }
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
