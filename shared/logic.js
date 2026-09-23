/*
 * 循环闹钟 — 核心调度逻辑（纯函数，无浏览器 API 依赖，可在 Node 中单测）
 * 浏览器端挂载到 globalThis.AlarmClock；Node 端通过 module.exports 导出。
 *
 * 数据模型：
 *   group: { id, name, enabled, start: 'HH:MM', end: 'HH:MM', alarms: [alarm] }
 *   alarm: { id, name, text, intervalMinutes, startTime (可空),
 *            enabled, nextFire (epoch ms 循环锚点), snoozedUntil (epoch ms 可空) }
 *
 * 调度语义：
 *   - 生效时间段：start < end 为每日区间；start > end 视为跨午夜；start == end 视为全天。
 *   - 到期时间 due = snoozedUntil（稍后提醒优先），否则为 nextFire。
 *   - 到期但当前不在生效时间段内：跳过本轮，按间隔步进到下一个段内时刻。
 *   - 触发后循环锚点 = 触发时刻 + 间隔，并跳过段外轮次。
 *   - 浏览器关闭期间错过的提醒：恢复后补提醒一次，并重新锚定循环。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AlarmClock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MS_MIN = 60 * 1000;
  // skipToWindow 的最大步进次数（按最小间隔 1 分钟计，约一年），防止死循环
  const MAX_SKIP_STEPS = 525600;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 'HH:MM' -> 一天中的分钟数；非法返回 null */
  function parseHM(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value == null ? '' : value).trim());
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function minutesOfDay(ts) {
    const d = new Date(ts);
    return d.getHours() * 60 + d.getMinutes();
  }

  /** 时间 ts 是否落在生效时间段内。无法解析的时间视为全天生效。 */
  function inWindow(ts, win) {
    const s = parseHM(win.start), e = parseHM(win.end);
    if (s === null || e === null) return true;
    if (s === e) return true; // 相等 = 全天
    const x = minutesOfDay(ts);
    return s < e ? (x >= s && x < e) : (x >= s || x < e);
  }

  function windowLabel(win) {
    const s = parseHM(win.start), e = parseHM(win.end);
    if (s === null || e === null) return '不限';
    if (s === e) return '全天';
    return win.start + ' – ' + win.end + (s > e ? '（跨午夜）' : '');
  }

  /** 按间隔步进，直到进入生效时间段（跳过段外轮次）。 */
  function skipToWindow(ts, intervalMinutes, win) {
    const step = Math.max(1, Math.round(Number(intervalMinutes) || 1)) * MS_MIN;
    let x = ts, guard = 0;
    while (!inWindow(x, win) && guard < MAX_SKIP_STEPS) {
      x += step;
      guard++;
    }
    return x;
  }

  /** 有效到期时间：稍后提醒（snoozedUntil）优先于循环锚点。 */
  function dueTime(alarm) {
    if (alarm.snoozedUntil != null) return alarm.snoozedUntil;
    return alarm.nextFire || 0;
  }

  /**
   * 下一次提醒时间（禁用返回 null）。
   * 已到期（due <= now）时返回 now（若 now 在段外则步进到段内）。
   */
  function nextFireTime(alarm, group, now) {
    if (!group || group.enabled === false || !alarm || alarm.enabled === false) return null;
    const win = { start: group.start, end: group.end };
    let t = dueTime(alarm);
    if (t <= now) t = now;
    return skipToWindow(t, alarm.intervalMinutes, win);
  }

  /** 在 fireAt 触发后推进循环：锚点 = fireAt + 间隔，并跳过段外轮次；清除稍后提醒。 */
  function advanceAfterFire(alarm, group, fireAt) {
    alarm.snoozedUntil = null;
    const win = { start: group.start, end: group.end };
    alarm.nextFire = skipToWindow(
      fireAt + Math.max(1, Math.round(Number(alarm.intervalMinutes) || 1)) * MS_MIN,
      alarm.intervalMinutes,
      win
    );
  }

  function formatHHMM(ts) {
    const d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 短倒计时（角标用，尽量 <= 4 字符；统一分钟级：实际触发精度只有约 1 分钟，秒级显示会误导） */
  function formatCountdown(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return '<1m';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    const h = Math.floor(s / 3600);
    if (h < 24) return h + 'h';
    return Math.floor(h / 24) + 'd';
  }

  function formatDateTime(ts) {
    const d = new Date(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + formatHHMM(ts);
  }

  function formatDateTimeFull(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + formatHHMM(ts);
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function intervalToLabel(minutes) {
    const m = Math.round(Number(minutes) || 0);
    if (m < 60) return m + ' 分钟';
    const h = Math.floor(m / 60), r = m % 60;
    return r ? h + ' 小时 ' + r + ' 分钟' : h + ' 小时';
  }

  return {
    MS_MIN,
    pad2,
    parseHM,
    minutesOfDay,
    inWindow,
    windowLabel,
    skipToWindow,
    dueTime,
    nextFireTime,
    advanceAfterFire,
    formatHHMM,
    formatCountdown,
    formatDateTime,
    formatDateTimeFull,
    uid,
    intervalToLabel
  };
});
