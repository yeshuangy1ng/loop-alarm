/*
 * 端到端模拟：复刻 background.handleTick 的触发逻辑，验证完整循环语义。
 * node test/test-simulate.js
 */
const L = require('../shared/logic.js');
const assert = require('assert');
const D = s => Date.parse(s);

/** 复刻 background.js fireDue 的核心判定 */
function tick(state, now) {
  const fired = [];
  for (const g of state.groups) {
    if (g.enabled === false) continue;
    const win = { start: g.start, end: g.end };
    for (const a of g.alarms || []) {
      if (a.enabled === false) continue;
      const due = L.dueTime(a);
      if (due <= now && L.inWindow(now, win)) {
        fired.push(a.id);
        L.advanceAfterFire(a, g, due, now); // 按计划时刻锚定（保持网格）
      }
    }
  }
  return fired;
}

const state = {
  groups: [{
    id: 'g1', name: '测试组', enabled: true, start: '09:00', end: '17:00',
    alarms: [{
      id: 'a1', name: '站立活动', text: '起来活动 5 分钟',
      intervalMinutes: 60,
      startTime: D('2024-01-01T10:00:00'),
      enabled: true,
      nextFire: D('2024-01-01T10:00:00'),
      snoozedUntil: null
    }]
  }]
};
const a = state.groups[0].alarms[0];

// 1) 到点触发，锚点 +1 小时
assert.deepStrictEqual(tick(state, D('2024-01-01T10:00:00')), ['a1']);
assert.strictEqual(a.nextFire, D('2024-01-01T11:00:00'));

// 2) 未到点不触发
assert.deepStrictEqual(tick(state, D('2024-01-01T10:30:00')), []);

// 3) 循环推进：11:00 → 12:00 → 13:05（含稍后提醒）
assert.deepStrictEqual(tick(state, D('2024-01-01T11:00:00')), ['a1']);
assert.deepStrictEqual(tick(state, D('2024-01-01T12:00:00')), ['a1']);
assert.strictEqual(a.nextFire, D('2024-01-01T13:00:00'));
a.snoozedUntil = D('2024-01-01T12:05:00'); // 12:00 触发后用户点「5 分钟后提醒」
assert.deepStrictEqual(tick(state, D('2024-01-01T12:05:00')), ['a1']);
assert.strictEqual(a.snoozedUntil, null, '触发后清除 snooze');
assert.strictEqual(a.nextFire, D('2024-01-01T13:05:00'), '循环从稍后时刻重新起算');

// 4) 段外轮次跳过：13:05→14:05→15:05→16:05 正常触发；16:05+1h=17:05 段外 → 步进到次日 09:05
assert.deepStrictEqual(tick(state, D('2024-01-01T13:05:00')), ['a1']);
assert.deepStrictEqual(tick(state, D('2024-01-01T14:05:00')), ['a1']);
assert.deepStrictEqual(tick(state, D('2024-01-01T15:05:00')), ['a1']);
assert.deepStrictEqual(tick(state, D('2024-01-01T16:05:00')), ['a1']);
assert.strictEqual(a.nextFire, D('2024-01-02T09:05:00'), '跳过段外轮次');

// 5) 错过 16:00 的轮次（如浏览器休眠）+ now 在段外：不触发，nextFireTime 按间隔步进到段内
a.nextFire = D('2024-01-01T16:00:00');
assert.deepStrictEqual(tick(state, D('2024-01-01T18:00:00')), [], '段外不触发，等段内');
const next = L.nextFireTime(a, state.groups[0], D('2024-01-01T18:00:00'));
assert.strictEqual(next, D('2024-01-02T09:00:00'), '18:00 段外按 60 分钟步进 → 次日 09:00');

// 6) 浏览器重启补提醒：次日 09:00 段内，due(16:00 昨天) <= now → 补提醒一次并重新锚定
assert.deepStrictEqual(tick(state, D('2024-01-02T09:00:00')), ['a1']);
assert.strictEqual(a.nextFire, D('2024-01-02T10:00:00'), '补提醒后循环重新锚定');

// 7) 分组停用后不触发
state.groups[0].enabled = false;
a.nextFire = D('2024-01-02T09:00:00');
assert.deepStrictEqual(tick(state, D('2024-01-02T09:00:00')), []);

// 8) 唤醒抖动不固化错位：计划 10:00、实际 10:00:37 才触发 → 锚点仍是网格点 11:00
//    （旧实现用实际触发时刻锚定，会得到 11:00:37，之后每轮都晚 37 秒）
state.groups[0].enabled = true;
a.snoozedUntil = null;
a.nextFire = D('2024-01-02T10:00:00');
assert.deepStrictEqual(tick(state, D('2024-01-02T10:00:37')), ['a1']);
assert.strictEqual(a.nextFire, D('2024-01-02T11:00:00'), '迟到 37 秒触发后锚点仍在计划网格');

// 9) 长时间错过（如浏览器休眠 3 小时）：补提醒一次后跳到下一个网格点
a.nextFire = D('2024-01-02T11:00:00');
assert.deepStrictEqual(tick(state, D('2024-01-02T14:00:00')), ['a1']);
assert.strictEqual(a.nextFire, D('2024-01-02T15:00:00'), '错过多个轮次后只补一次并落到下一个网格点');

console.log('✔ 端到端模拟测试全部通过');
