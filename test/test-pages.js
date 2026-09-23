/*
 * 页面 / Service Worker 冒烟测试：用 chrome API 与 DOM 桩运行每个脚本，
 * 检查 ReferenceError 类问题，并模拟：安装 → 到点 tick → 页面渲染
 * → 删除闹钟 / 删除分组（回归：load() 无 return 导致 st 为 undefined）。
 * node test/test-pages.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const now = Date.now();

// ---------- 模拟存储 ----------
const store = {
  state: {
    version: 1,
    groups: [{
      id: 'g1', name: '测试组', enabled: true, start: '00:00', end: '00:00', // 全天，避免受本机时区影响
      alarms: [{
        id: 'a1', name: '站立活动', text: '起来活动 5 分钟',
        intervalMinutes: 30, startTime: null, enabled: true,
        nextFire: now + 1800000, snoozedUntil: null
      }]
    }]
  },
  pendingReminders: {
    batches: { b1: { batchId: 'b1', firedAt: now, items: [{
      groupId: 'g1', groupName: '测试组', alarmId: 'a1', alarmName: '站立活动', text: '起来活动', firedAt: now
    }] } }
  }
};

// ---------- chrome API 桩 ----------
const listeners = { alarm: [], storageChanged: [], installed: [], startup: [] };
let lastAlarmCreate = null;
const createdTabs = [];
const sentMessages = [];
const sentRuntimeMessages = [];
const onMsgAll = [];
const alarmCreates = [];
const alerts = [];
/** 最近一次指定名字的闹钟创建（一个排程会创建主闹钟 + 兜底闹钟，按名字取用） */
const lastCreate = name => [...alarmCreates].reverse().find(c => c.name === name);
const chromeStub = {
  storage: {
    local: {
      get: async keys => {
        const ks = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys));
        const out = {};
        for (const k of ks) if (k in store) out[k] = store[k];
        return out;
      },
      set: async obj => { Object.assign(store, obj); },
      remove: async keys => { for (const k of (typeof keys === 'string' ? [keys] : keys)) delete store[k]; }
    },
    onChanged: { addListener: fn => listeners.storageChanged.push(fn) }
  },
  tabs: {
    create: async info => { createdTabs.push(info); return { id: 100 + createdTabs.length }; },
    query: async q => (q && q.active ? [{ id: 42, url: 'https://example.com/x' }] : []),
    sendMessage: async (tabId, msg) => { sentMessages.push({ tabId, msg }); }
  },
  runtime: {
    getURL: p => 'chrome-extension://test/' + p,
    openOptionsPage: async () => {},
    sendMessage: async msg => { sentRuntimeMessages.push(msg); return {}; },
    onMessage: { addListener: fn => onMsgAll.push(fn) },
    onInstalled: { addListener: fn => listeners.installed.push(fn) },
    onStartup: { addListener: fn => listeners.startup.push(fn) }
  },
  alarms: {
    create: async (name, info) => { lastAlarmCreate = { name, info }; alarmCreates.push({ name, info }); },
    clear: async () => {},
    get: async () => null,
    onAlarm: { addListener: fn => listeners.alarm.push(fn) }
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
};

// ---------- DOM 桩（记录监听器、缓存 querySelector 结果，便于触发事件） ----------
function makeEl(overrides) {
  const el = {
    dataset: {}, style: {}, innerHTML: '', textContent: '', value: '', checked: false, className: '',
    children: [],
    _listeners: {},
    _qcache: {},
    appendChild(c) { c._parent = this.children; this.children.push(c); },
    append(...cs) { for (const c of cs) this.appendChild(c); },
    remove() {
      if (this._parent) {
        const i = this._parent.indexOf(this);
        if (i >= 0) this._parent.splice(i, 1);
      }
    },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    click() { (this._clicks = this._clicks || []).push(Date.now()); },
    querySelector(sel) { if (!this._qcache[sel]) this._qcache[sel] = makeEl(); return this._qcache[sel]; },
    querySelectorAll(sel) {
      const key = 'all:' + sel;
      if (!this._qcache[key]) this._qcache[key] = [makeEl()];
      return this._qcache[key];
    },
    closest() { return makeEl(); }
  };
  return Object.assign(el, overrides || {});
}

let registry = {};
let docAll = {};
const doc = {
  body: makeEl(),
  getElementById: id => registry[id] || (registry[id] = makeEl()),
  createElement: () => makeEl(),
  querySelectorAll: sel => {
    if (!docAll[sel]) docAll[sel] = sel === '.alarm' ? [makeEl({ dataset: { aid: 'a1' } })] : [makeEl()];
    return docAll[sel];
  },
  addEventListener: () => {},
  title: ''
};

let rejected = [];
process.on('unhandledRejection', err => rejected.push(err));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runScript(file) {
  registry = {}; docAll = {}; // 每个脚本独立的 DOM 注册表
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const fn = new Function('chrome', 'document', 'location', 'history', 'confirm', 'alert', 'importScripts', code);
  fn(
    chromeStub,
    doc,
    { search: file === 'reminder.js' ? '?batch=b1' : '' },
    { replaceState: () => {} },
    () => true,
    m => alerts.push(m),
    rel => (0, eval)(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
  );
  await sleep(100); // 等待 async IIFE
  assert.strictEqual(rejected.length, 0, file + ' 存在未捕获异常：' + (rejected[0] && (rejected[0].stack || rejected[0].message)));
  rejected = [];
}

(async () => {
  // ---- Service Worker ----
  await runScript('background.js');
  assert.ok(listeners.alarm.length, 'background 注册了 onAlarm');
  assert.ok(listeners.installed.length, 'background 注册了 onInstalled');
  assert.ok(listeners.startup.length, 'background 注册了 onStartup');
  for (const fn of listeners.installed) await fn({ reason: 'install' });
  await sleep(50);
  assert.ok(alarmCreates.some(c => c.name === 'badge-tick' && c.info && c.info.periodInMinutes === 1),
    '安装后创建 1 分钟周期角标闹钟');

  // ---- 模拟到点 tick：把闹钟改为已到期 ----
  const a = store.state.groups[0].alarms[0];
  a.nextFire = now - 1000;
  for (const fn of listeners.alarm) fn({ name: 'clock-tick' });
  await sleep(50);
  assert.ok(Object.keys(store.pendingReminders.batches).length > 1, 'tick 生成了新的提醒批次');
  assert.ok(Math.abs(a.nextFire - (now + 1800000)) < 60000, '触发后锚点 ≈ now + 30 分钟');
  assert.strictEqual(a.snoozedUntil, null);
  const tickCreate = lastCreate('clock-tick');
  assert.ok(tickCreate && tickCreate.info && tickCreate.info.when != null,
    'one-shot 模式：排程一次性闹钟（when）');
  assert.ok(Math.abs(tickCreate.info.when - (a.nextFire - 20000)) < 2000,
    '唤醒点 = 目标时刻 − 20 秒（预唤醒）');
  const backupCreate = lastCreate('clock-backup');
  assert.ok(backupCreate && backupCreate.info.when >= a.nextFire, '同时排程目标时刻之后的兜底闹钟');
  assert.ok(store.scheduleInfo && store.scheduleInfo.mode === 'when', '排程方式记录为 when（诊断可见）');

  // ---- 角标闹钟独立触发：只刷新角标，无未捕获异常 ----
  for (const fn of listeners.alarm) fn({ name: 'badge-tick' });
  await sleep(50);
  assert.strictEqual(rejected.length, 0, 'badge-tick 触发无未捕获异常：' + (rejected[0] || ''));

  // ---- 回归：浏览器不支持一次性闹钟（when / delayInMinutes 都报 Unexpected property）
  //      → 降级为 30 秒周期轮询 ----
  chromeStub.alarms.create = async (name, info) => {
    lastAlarmCreate = { name, info };
    if (info && ('when' in info || 'delayInMinutes' in info)) {
      const prop = ('when' in info) ? 'when' : 'delayInMinutes';
      throw new TypeError("Error at parameter 'alarmInfo': Unexpected property: '" + prop + "'");
    }
  };
  listeners.storageChanged.forEach(fn => fn({ state: {} }, 'local'));
  await sleep(100);
  assert.ok(lastAlarmCreate && lastAlarmCreate.info && lastAlarmCreate.info.periodInMinutes === 0.5,
    '降级后创建 30 秒周期轮询闹钟');
  assert.strictEqual(store.scheduleInfo.mode, 'poll', '排程方式记录为 poll');

  // ---- 提醒投递：前台标签页可接收 → 页面内卡片，不新建标签页 ----
  assert.strictEqual(createdTabs.length, 0, '前台标签页可接收时不新建标签页');
  assert.ok(sentMessages.some(m => m.msg && m.msg.type === 'showReminder' && m.msg.batch && m.msg.batch.items.length === 1),
    '提醒卡片消息发送到前台标签页');

  // ---- 投递回退：前台页面无内容脚本（sendMessage 失败）且无 scripting → 新标签页 ----
  chromeStub.tabs.query = async q => (q && q.active ? [{ id: 43, url: 'chrome://extensions/' }] : []);
  chromeStub.tabs.sendMessage = async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); };
  a.nextFire = now - 1000;
  for (const fn of listeners.alarm) fn({ name: 'clock-tick' });
  await sleep(50);
  assert.strictEqual(createdTabs.length, 1, '前台无法显示卡片时回退新标签页');
  assert.ok(/reminder\.html\?batch=/.test(createdTabs[0].url), '回退新标签页为提醒卡片页');

  // ---- content.js：页面内提醒卡片渲染 + 稍后提醒 / 关闭消息 ----
  await runScript('content.js');
  const contentListener = onMsgAll[onMsgAll.length - 1];

  // (a) 单条目批次：点「稍后提醒」→ 发 snooze 消息，卡片自动关闭
  contentListener({ type: 'showReminder', batch: store.pendingReminders.batches.b1 }, {}, () => {});
  await sleep(50);
  const cardEl = doc.body.children[doc.body.children.length - 1];
  assert.ok(cardEl, 'content 脚本渲染了提醒卡片');
  const headEl = cardEl.children[0];
  const boxEl = cardEl.children[cardEl.children.length - 1];
  const btnRowEl = boxEl.children[boxEl.children.length - 1];
  btnRowEl.children[0]._listeners.click.forEach(fn => fn({})); // 稍后 5 分钟
  await sleep(300); // 等待 200ms 淡出
  assert.ok(sentRuntimeMessages.some(m => m.type === 'snooze' && m.alarmId === 'a1' && m.minutes === 5),
    '页面内卡片「稍后提醒 5 分钟」向后台发消息');
  assert.ok(!doc.body.children.includes(cardEl), '点击「稍后提醒」后卡片自动关闭');

  // (b) 「✕ 关闭」按钮 → 发 dismiss 消息并移除卡片
  store.pendingReminders.batches.b2 = { batchId: 'b2', firedAt: now, items: [{
    groupId: 'g1', groupName: '测试组', alarmId: 'a1', alarmName: '站立活动', text: '', firedAt: now
  }] };
  contentListener({ type: 'showReminder', batch: store.pendingReminders.batches.b2 }, {}, () => {});
  await sleep(50);
  const cardEl2 = doc.body.children[doc.body.children.length - 1];
  const closeBtnEl = cardEl2.children[0].children[cardEl2.children[0].children.length - 1];
  closeBtnEl._listeners.click.forEach(fn => fn({})); // 关闭
  await sleep(50);
  assert.ok(sentRuntimeMessages.some(m => m.type === 'dismiss' && m.batchId === 'b2'),
    '页面内卡片「关闭」向后台发消息');
  assert.ok(!doc.body.children.includes(cardEl2), '点击「关闭」后卡片移除');

  // (c) 多条目批次：稍后提醒某条 → 该条目收起、卡片保留；全部处理 → 卡片自动关闭
  store.pendingReminders.batches.b3 = { batchId: 'b3', firedAt: now, items: [
    { groupId: 'g1', groupName: '测试组', alarmId: 'a1', alarmName: '站立活动', text: '', firedAt: now },
    { groupId: 'g1', groupName: '测试组', alarmId: 'a2', alarmName: '喝水', text: '', firedAt: now }
  ] };
  contentListener({ type: 'showReminder', batch: store.pendingReminders.batches.b3 }, {}, () => {});
  await sleep(50);
  const cardEl3 = doc.body.children[doc.body.children.length - 1];
  const boxA = cardEl3.children[1];
  const boxB = cardEl3.children[2];
  const rowA = boxA.children[boxA.children.length - 1];
  rowA.children[0]._listeners.click.forEach(fn => fn({})); // 条目 A 稍后 5 分钟
  await sleep(300);
  assert.ok(doc.body.children.includes(cardEl3), '多条目：稍后提醒一条后卡片保留');
  assert.ok(!cardEl3.children.includes(boxA), '稍后提醒的条目收起');
  const rowB = boxB.children[boxB.children.length - 1];
  rowB.children[0]._listeners.click.forEach(fn => fn({})); // 条目 B 稍后 5 分钟
  await sleep(300);
  assert.ok(!doc.body.children.includes(cardEl3), '全部条目稍后提醒后卡片自动关闭');
  assert.ok(sentRuntimeMessages.filter(m => m.type === 'snooze' && m.alarmId === 'a2' && m.minutes === 5).length >= 1,
    '多批次条目的「稍后提醒」逐条向后台发消息');

  // ---- background onMessage：稍后提醒写 snoozedUntil 并删除批次；关闭删除批次 ----
  const bgListener = onMsgAll[0];
  store.pendingReminders.batches.b6 = { batchId: 'b6', firedAt: now, items: [{ groupId: 'g1', groupName: '测试组', alarmId: 'a1', alarmName: '站立活动', text: '', firedAt: now }] };
  bgListener({ type: 'snooze', batchId: 'b6', alarmId: 'a1', minutes: 10 }, {}, () => {});
  await sleep(100);
  assert.ok(Math.abs(store.state.groups[0].alarms[0].snoozedUntil - (now + 600000)) < 3000,
    '页面内卡片「稍后提醒」写入 snoozedUntil');
  assert.strictEqual(store.pendingReminders.batches.b6, undefined, '「稍后提醒」后批次条目删除（批次清空即删除）');
  store.pendingReminders.batches.b7 = { batchId: 'b7', firedAt: now, items: [] };
  bgListener({ type: 'dismiss', batchId: 'b7' }, {}, () => {});
  await sleep(50);
  assert.strictEqual(store.pendingReminders.batches.b7, undefined, '「关闭」删除批次');

  // ---- background onMessage: 测试提醒（popup 触发，走完整投递流程）----
  bgListener({ type: 'testReminder' }, {}, () => {});
  await sleep(100);
  const testBatch = Object.values(store.pendingReminders.batches).find(b => b.items[0] && b.items[0].alarmId === null);
  assert.ok(testBatch, '测试提醒生成批次');
  assert.strictEqual(createdTabs.length, 2, '测试提醒走投递流程（当前桩：前台无接收端 → 回退新标签页）');

  // ---- 页面 ----
  await runScript('popup.js');
  await runScript('options.js');

  // ---- 回归：删除闹钟（options 页） ----
  const alarmBox = docAll['.alarm'][0];
  const delAlarmBtn = alarmBox.querySelector('[data-act="delalarm"]');
  assert.ok(delAlarmBtn._listeners.click && delAlarmBtn._listeners.click.length, '删除闹钟按钮已绑定监听器');
  delAlarmBtn._listeners.click.forEach(fn => fn({}));
  await sleep(100);
  assert.strictEqual(store.state.groups[0].alarms.length, 0, '删除闹钟后存储中该分组无闹钟');

  // ---- 回归：删除分组（options 页）—— load() 无 return 时此处 st 为 undefined ----
  const delGroupEl = registry['delGroup'];
  assert.ok(delGroupEl && delGroupEl._listeners.click && delGroupEl._listeners.click.length, '删除分组按钮已绑定监听器');
  delGroupEl._listeners.click.forEach(fn => fn({}));
  await sleep(100);
  assert.strictEqual(store.state.groups.length, 0, '删除分组后存储中分组为空');

  // ---- 回归：options 页「＋ 新建分组」按钮（此前未绑定监听器，点击无反应）----
  const newGroupBtn = registry['btnNewGroup'];
  assert.ok(newGroupBtn && newGroupBtn._listeners.click && newGroupBtn._listeners.click.length, '新建分组按钮已绑定监听器');
  newGroupBtn._listeners.click.forEach(fn => fn({}));
  await sleep(100);
  assert.strictEqual(store.state.groups.length, 1, '点击新建分组后存储中新增分组');
  assert.strictEqual(store.state.groups[0].alarms.length, 0, '新分组无闹钟');
  assert.strictEqual(store.state.groups[0].enabled, true, '新分组默认启用');

  // ---- options 页：导出配置（触发下载）----
  const exportBtn = registry['btnExport'];
  assert.ok(exportBtn && exportBtn._listeners.click && exportBtn._listeners.click.length, '导出配置按钮已绑定');
  exportBtn._listeners.click.forEach(fn => fn({}));
  await sleep(50);
  const dlAnchor = doc.body.children.find(el => el.download && /循环闹钟-配置-/.test(String(el.download)));
  assert.ok(dlAnchor, '导出配置触发下载');

  // ---- options 页：导入配置（覆盖 + 字段清洗）----
  const importFileEl = registry['importFile'];
  assert.ok(importFileEl && importFileEl._listeners.change && importFileEl._listeners.change.length, '导入文件输入已绑定');
  const importPayload = {
    app: 'alarmclock', version: 1, exportedAt: 'x',
    state: { version: 1, groups: [
      { id: 'g9', name: '导入组', enabled: true, start: '08:00', end: '18:00',
        alarms: [{ id: 'a9', name: '导入闹钟', text: 't', intervalMinutes: 45, startTime: null, enabled: true, nextFire: now + 2700000, snoozedUntil: null }] },
      { name: '缺字段组' }
    ] }
  };
  const okTarget = { files: [{ text: async () => JSON.stringify(importPayload) }], value: '' };
  importFileEl._listeners.change.forEach(fn => fn({ target: okTarget }));
  await sleep(100);
  assert.strictEqual(store.state.groups.length, 2, '导入覆盖现有分组');
  assert.strictEqual(store.state.groups[0].name, '导入组');
  assert.strictEqual(store.state.groups[0].alarms[0].intervalMinutes, 45);
  assert.ok(store.state.groups[1].id && store.state.groups[1].alarms.length === 0, '缺失字段清洗为默认值');

  // ---- options 页：导入无效文件 → 提示且不改配置 ----
  const groupCountBefore = store.state.groups.length;
  const badTarget = { files: [{ text: async () => '{invalid json' }], value: '' };
  importFileEl._listeners.change.forEach(fn => fn({ target: badTarget }));
  await sleep(50);
  assert.strictEqual(store.state.groups.length, groupCountBefore, '无效文件不修改配置');
  assert.ok(alerts.some(m => /导入失败/.test(String(m))), '无效文件触发错误提示');

  // ---- options 页：配置变更重新锚定 + 外部变更刷新（内容判断）----
  const g1 = { id: 'g1', name: '测试组', enabled: true, start: '00:00', end: '00:00',
    alarms: [{ id: 'a1', name: '站立活动', text: '', intervalMinutes: 30,
      startTime: now - 3600000, enabled: true,
      nextFire: now + 600000, snoozedUntil: now + 600000 }] };
  store.state = { version: 1, groups: [g1] };
  // 模拟后台外部写入（如提醒触发后推进 nextFire）。
  // 该事件落在上一次自写（导入 persist）的 800ms 内：旧的定时判断会误判为自写丢弃，
  // 导致页面内存状态过期、下一次保存覆盖后台变更；新的内容判断必须正常刷新
  listeners.storageChanged.forEach(fn => fn({ state: { oldValue: null, newValue: store.state } }, 'local'));
  await sleep(150);
  const a1 = g1.alarms[0];
  const box = docAll['.alarm'][0];
  const ih = box.querySelector('[data-f="ih"]');
  const im = box.querySelector('[data-f="im"]');
  const startInp = box.querySelector('[data-f="start"]');
  assert.ok(ih._listeners.change && ih._listeners.change.length, '间隔输入已绑定 change 监听');

  // (1) 改间隔（开始时间已过、循环进行中）→ 从当前时刻重新锚定，变更立即生效
  ih.value = '2'; im.value = '0';
  ih._listeners.change.forEach(fn => fn({ target: ih }));
  await sleep(150);
  assert.strictEqual(a1.intervalMinutes, 120, '间隔变更已写入');
  assert.ok(Math.abs(a1.nextFire - (Date.now() + 120 * 60000)) < 90000, '改间隔后锚点重锚定到当前时刻 + 新间隔');

  // (2) 存在挂起的「稍后提醒」+ 设置开始时间（未来）→ 取消稍后提醒，首次提醒 = 开始时间
  const future = Date.now() + 2 * 3600000;
  const fd = new Date(future);
  const pad2 = n => (n < 10 ? '0' : '') + n;
  startInp.value = fd.getFullYear() + '-' + pad2(fd.getMonth() + 1) + '-' + pad2(fd.getDate())
    + 'T' + pad2(fd.getHours()) + ':' + pad2(fd.getMinutes());
  startInp._listeners.change.forEach(fn => fn({ target: startInp }));
  await sleep(150);
  assert.strictEqual(a1.snoozedUntil, null, '设置开始时间取消挂起的「稍后提醒」');
  assert.ok(Math.abs(a1.startTime - future) < 61000, '开始时间已写入');
  assert.strictEqual(a1.nextFire, a1.startTime, '首次提醒时间 = 开始时间');

  // (3) 再次改间隔（开始时间在未来）→ 首次提醒仍是开始时间
  ih.value = '3'; im.value = '30';
  ih._listeners.change.forEach(fn => fn({ target: ih }));
  await sleep(150);
  assert.strictEqual(a1.intervalMinutes, 210, '第二次间隔变更已写入');
  assert.strictEqual(a1.nextFire, a1.startTime, '开始时间在未来：首次提醒仍是开始时间');

  // ---- 提醒卡片页 ----
  await runScript('reminder.js');

  // ---- 提醒卡片页：「稍后提醒」移除条目，全部处理后自动关闭 ----
  const itemsEl = registry['items'];
  const reminderBtn = itemsEl.querySelectorAll('button[data-min]')[0];
  assert.ok(reminderBtn._listeners.click && reminderBtn._listeners.click.length, '提醒卡片页「稍后提醒」按钮已绑定');
  reminderBtn.closest = () => makeEl({ dataset: { aid: 'a1' } }); // 模拟按钮所属条目
  reminderBtn._listeners.click.forEach(fn => fn({}));
  await sleep(150);
  assert.strictEqual(store.pendingReminders.batches.b1, undefined, '提醒卡片页「稍后提醒」后批次清空即删除');
  await sleep(400); // tryClose：300ms 后显示关闭提示（测试环境 window.close 不可用）
  const hintEl = registry['closeHint'];
  assert.strictEqual(hintEl.style.display, 'inline', '全部条目处理后显示自动关闭提示');

  // ---- 精度：提前唤醒（when）+ 精确等待（毫秒级）+ 按计划网格锚定 ----
  // 恢复支持一次性闹钟的桩（前面的降级回归测试把它换成了拒绝 when/delayInMinutes）
  chromeStub.alarms.create = async (name, info) => { lastAlarmCreate = { name, info }; alarmCreates.push({ name, info }); };
  const gridDue = Date.now() + 400;   // 目标时刻：400ms 后（落在 MAX_WAIT 窗口内 → 走精确等待）
  store.state = { version: 1, groups: [{
    id: 'gp', name: '精度组', enabled: true, start: '00:00', end: '00:00',
    alarms: [{ id: 'ap', name: '精度', text: '', intervalMinutes: 30, startTime: null,
      enabled: true, nextFire: gridDue, snoozedUntil: null }]
  }] };
  store.pendingReminders = { batches: {} };
  // 配置变更触发重新排程：排程方式每轮从最优方式重新探测（浏览器升级/桩恢复后可自愈回 when）
  listeners.storageChanged.forEach(fn => fn({ state: { newValue: store.state } }, 'local'));
  await sleep(100);
  assert.strictEqual(store.scheduleInfo.mode, 'when', '排程方式重新探测回 when（自愈）');
  for (const fn of listeners.alarm) fn({ name: 'clock-tick' });
  await sleep(900);
  const ap = store.state.groups[0].alarms[0];
  const pBatch = Object.values(store.pendingReminders.batches)[0];
  assert.ok(pBatch, '目标进入等待窗口后精确等到点并触发（生成批次）');
  const pDelta = pBatch.firedAt - gridDue;
  assert.ok(pDelta >= 0 && pDelta < 150, '触发时刻与计划时刻误差 < 150ms（实际 +' + pDelta + 'ms）');
  assert.strictEqual(ap.nextFire, gridDue + 30 * 60000, '触发后锚点落在计划网格（due + 间隔）');
  const pCreate = lastCreate('clock-tick');
  assert.ok(pCreate && pCreate.info && pCreate.info.when != null, '支持一次性闹钟时用 when 排程');
  assert.ok(Math.abs(pCreate.info.when - (ap.nextFire - 20000)) < 2000, '唤醒点 = 目标 − 20 秒（预唤醒）');

  // 迟到触发不再固化错位：计划 10:00、实际晚 37 秒 → 锚点仍是网格点（due + 间隔）
  const lateDue = Date.now() - 37000;
  ap.nextFire = lateDue;
  for (const fn of listeners.alarm) fn({ name: 'clock-tick' });
  await sleep(300);
  assert.strictEqual(ap.nextFire, lateDue + 30 * 60000, '晚 37 秒触发后锚点仍在计划网格（不再固化错位）');
  assert.ok(store.fireStats && Math.abs(store.fireStats.last - 37000) < 600,
    '诊断记录触发偏差 ≈ 37 秒（实际 ' + (store.fireStats && store.fireStats.last) + 'ms）');
  // 兜底闹钟：未到期时为空操作（不会重复触发同一条提醒）
  const batchesBefore = Object.keys(store.pendingReminders.batches).length;
  for (const fn of listeners.alarm) fn({ name: 'clock-backup' });
  await sleep(200);
  assert.strictEqual(Object.keys(store.pendingReminders.batches).length, batchesBefore,
    '兜底闹钟在未到期时为空操作（不重复提醒）');

  const diagEl = registry['diagLine'];
  assert.ok(diagEl && /排程方式：/.test(String(diagEl.textContent)), '选项页运行诊断显示排程方式');

  console.log('✔ 页面/Service Worker 冒烟测试通过（安装 + tick + popup + options 删除回归 + reminder + 精度）');
})().catch(err => { console.error('✘ 冒烟测试失败：', err); process.exit(1); });
