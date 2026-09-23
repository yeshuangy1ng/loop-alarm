/* 核心调度逻辑单测：node test/test-logic.js */
const L = require('../shared/logic.js');
const assert = require('assert');

const D = s => Date.parse(s);

// ---------- parseHM ----------
assert.strictEqual(L.parseHM('09:00'), 540);
assert.strictEqual(L.parseHM('0:05'), 5);
assert.strictEqual(L.parseHM('23:59'), 23 * 60 + 59);
assert.strictEqual(L.parseHM('24:00'), null);
assert.strictEqual(L.parseHM('09:60'), null);
assert.strictEqual(L.parseHM('abc'), null);
assert.strictEqual(L.parseHM(''), null);

// ---------- inWindow：普通区间（左闭右开） ----------
const win = { start: '09:00', end: '17:00' };
assert.ok(L.inWindow(D('2024-01-01T09:00:00'), win), '起点含');
assert.ok(L.inWindow(D('2024-01-01T16:59:00'), win));
assert.ok(!L.inWindow(D('2024-01-01T17:00:00'), win), '终点不含');
assert.ok(!L.inWindow(D('2024-01-01T08:59:00'), win));
assert.ok(!L.inWindow(D('2024-01-01T23:00:00'), win));

// ---------- inWindow：全天（start == end） ----------
const all = { start: '08:00', end: '08:00' };
assert.ok(L.inWindow(D('2024-01-01T03:00:00'), all));
assert.ok(L.inWindow(D('2024-01-01T23:59:00'), all));

// ---------- inWindow：跨午夜（start > end） ----------
const wrap = { start: '22:00', end: '06:00' };
assert.ok(L.inWindow(D('2024-01-01T23:00:00'), wrap));
assert.ok(L.inWindow(D('2024-01-01T05:59:00'), wrap));
assert.ok(!L.inWindow(D('2024-01-01T06:00:00'), wrap));
assert.ok(!L.inWindow(D('2024-01-01T12:00:00'), wrap));
assert.ok(!L.inWindow(D('2024-01-01T21:59:00'), wrap));

// ---------- inWindow：非法时间视为全天 ----------
assert.ok(L.inWindow(D('2024-01-01T12:00:00'), { start: '', end: '' }));

// ---------- windowLabel ----------
assert.strictEqual(L.windowLabel({ start: '09:00', end: '17:00' }), '09:00 – 17:00');
assert.strictEqual(L.windowLabel({ start: '09:00', end: '09:00' }), '全天');
assert.ok(L.windowLabel({ start: '22:00', end: '06:00' }).includes('跨午夜'));

// ---------- skipToWindow ----------
// 18:00 在 09:00–17:00 之外，按 60 分钟步进 → 次日 09:00
assert.strictEqual(L.skipToWindow(D('2024-01-01T18:00:00'), 60, win), D('2024-01-02T09:00:00'));
// 段内时刻原样返回
assert.strictEqual(L.skipToWindow(D('2024-01-01T10:00:00'), 30, win), D('2024-01-01T10:00:00'));
// 跨午夜窗口：12:00 按 60 分钟步进 → 当天 22:00
assert.strictEqual(L.skipToWindow(D('2024-01-01T12:00:00'), 60, wrap), D('2024-01-01T22:00:00'));

// ---------- dueTime：稍后提醒优先 ----------
assert.strictEqual(L.dueTime({ nextFire: 5000, snoozedUntil: 1000 }), 1000, 'snooze 早于 nextFire 时以 snooze 为准');
assert.strictEqual(L.dueTime({ nextFire: 1000, snoozedUntil: 5000 }), 5000);
assert.strictEqual(L.dueTime({ nextFire: 5000, snoozedUntil: null }), 5000);
assert.strictEqual(L.dueTime({ nextFire: 5000, snoozedUntil: undefined }), 5000);
assert.strictEqual(L.dueTime({ nextFire: 0 }), 0);

// ---------- nextFireTime ----------
const now = D('2024-01-01T12:00:00');
const gAll = { enabled: true, start: '00:00', end: '00:00' };
const gWin = { enabled: true, start: '09:00', end: '17:00' };

// 已到期 → now
assert.strictEqual(L.nextFireTime({ nextFire: now - 1000, snoozedUntil: null, intervalMinutes: 30 }, gAll, now), now);
// 未到期 → 原时刻
assert.strictEqual(L.nextFireTime({ nextFire: D('2024-01-01T14:00:00'), snoozedUntil: null, intervalMinutes: 30 }, gAll, now), D('2024-01-01T14:00:00'));
// snooze 在未来 → snooze 时刻
assert.strictEqual(L.nextFireTime({ nextFire: now + 5 * 60000, snoozedUntil: now + 10 * 60000, intervalMinutes: 30 }, gAll, now), now + 10 * 60000);
// 闹钟禁用 → null
assert.strictEqual(L.nextFireTime({ nextFire: now, snoozedUntil: null, enabled: false }, gAll, now), null);
// 分组禁用 → null
assert.strictEqual(L.nextFireTime({ nextFire: now, snoozedUntil: null }, { ...gAll, enabled: false }, now), null);

// 已到期但 now 在段外 → 按间隔步进到段内（跳过本轮）
// 18:30 段外，间隔 60 分钟：19:30...次日 08:30（段外）→ 次日 09:30（段内）
const r1 = L.nextFireTime({ nextFire: D('2024-01-01T10:00:00'), snoozedUntil: null, intervalMinutes: 60 }, gWin, D('2024-01-01T18:30:00'));
assert.strictEqual(r1, D('2024-01-02T09:30:00'));

// 段内时刻原样返回
assert.strictEqual(L.nextFireTime({ nextFire: D('2024-01-01T10:00:00'), snoozedUntil: null, intervalMinutes: 60 }, gWin, D('2024-01-01T08:00:00')), D('2024-01-01T10:00:00'));

// ---------- advanceAfterFire ----------
const a5 = { nextFire: 0, snoozedUntil: 555, intervalMinutes: 30 };
L.advanceAfterFire(a5, gWin, D('2024-01-01T16:50:00'));
assert.strictEqual(a5.snoozedUntil, null, '触发后清除 snooze');
// 16:50 + 30 分钟 = 17:20（段外），按 30 分钟步进 → 次日 09:20
assert.strictEqual(a5.nextFire, D('2024-01-02T09:20:00'));

// 段内触发：锚点直接 + 间隔
const a6 = { nextFire: 0, snoozedUntil: null, intervalMinutes: 90 };
L.advanceAfterFire(a6, gWin, D('2024-01-01T10:00:00'));
assert.strictEqual(a6.nextFire, D('2024-01-01T11:30:00'));

// ---------- 格式化 ----------
assert.strictEqual(L.formatHHMM(D('2024-01-01T09:05:00')), '09:05');
assert.strictEqual(L.formatCountdown(0), '<1m');
assert.strictEqual(L.formatCountdown(45000), '<1m'); // 秒级不再显示，统一分钟级
assert.strictEqual(L.formatCountdown(60000), '1m');
assert.strictEqual(L.formatCountdown(59 * 60000), '59m');
assert.strictEqual(L.formatCountdown(900000), '15m');
assert.strictEqual(L.formatCountdown(3 * 3600000 + 30 * 60000), '3h');
assert.strictEqual(L.formatCountdown(2 * 24 * 3600000), '2d');
assert.strictEqual(L.intervalToLabel(90), '1 小时 30 分钟');
assert.strictEqual(L.intervalToLabel(30), '30 分钟');
assert.strictEqual(L.intervalToLabel(120), '2 小时');

console.log('✔ 核心调度逻辑测试全部通过（' + 52 + ' 项断言）');
