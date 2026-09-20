/*
 * 循环闹钟 — 提醒卡片页
 * 由后台在到点时打开（?batch=<batchId>），展示本批次到期的闹钟。
 * 每条可「稍后提醒」（5/10/30 分钟，循环将从稍后时刻重新起算）；「关闭」结束本卡片。
 */
const PENDING_KEY = 'pendingReminders';
const params = new URLSearchParams(location.search);
const batchId = params.get('batch');
let items = [];
let firedAt = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  const box = document.getElementById('items');
  const timeEl = document.getElementById('time');
  document.title = items.length ? ('提醒（' + items.length + ' 项）') : '循环闹钟提醒';
  if (firedAt) {
    timeEl.textContent = '提醒时间：' + new Date(firedAt).toLocaleString('zh-CN', { hour12: false });
  } else {
    timeEl.textContent = '没有待处理的提醒';
  }
  if (!items.length) {
    box.innerHTML = '<div class="empty">本批提醒已全部处理 🎉</div>';
    return;
  }
  box.innerHTML = items.map(it => (
    '<div class="item" data-aid="' + esc(it.alarmId) + '">' +
      '<div class="gname">' + esc(it.groupName) + '</div>' +
      '<div class="name">' + esc(it.alarmName) + '</div>' +
      (it.text ? '<div class="text">' + esc(it.text) + '</div>' : '') +
      '<div class="snooze">' +
        '<button data-min="5">5 分钟后提醒</button>' +
        '<button data-min="10">10 分钟后提醒</button>' +
        '<button data-min="30">30 分钟后提醒</button>' +
      '</div>' +
    '</div>'
  )).join('');
  box.querySelectorAll('button[data-min]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.item');
      snooze(row.dataset.aid, Number(btn.dataset.min));
    });
  });
}

async function snooze(alarmId, min) {
  const obj = await chrome.storage.local.get(['state', PENDING_KEY]);
  const st = obj.state;
  const store = obj[PENDING_KEY];
  const batch = store && store.batches && store.batches[batchId];
  if (!st || !batch) return;
  // 设置稍后提醒：下次提醒 = 当前时刻 + N 分钟（循环随后重新起算）
  for (const g of st.groups || []) {
    const a = (g.alarms || []).find(x => x.id === alarmId);
    if (a) { a.snoozedUntil = Date.now() + min * 60000; break; }
  }
  batch.items = batch.items.filter(i => i.alarmId !== alarmId);
  items = items.filter(i => i.alarmId !== alarmId);
  const out = { state: st, [PENDING_KEY]: store };
  if (!batch.items.length) delete store.batches[batchId];
  await chrome.storage.local.set(out); // 后台监听状态变化后自动重新排程
  render();
}

function tryClose() {
  try { window.close(); } catch (e) { /* 某些情况下无法脚本关闭 */ }
  setTimeout(() => {
    const el = document.getElementById('closeHint');
    if (el) el.style.display = 'inline';
  }, 300);
}

(async function init() {
  const obj = await chrome.storage.local.get(PENDING_KEY);
  const store = obj[PENDING_KEY];
  const batch = store && store.batches && store.batches[batchId];
  if (batch) {
    items = batch.items || [];
    firedAt = batch.firedAt;
  }
  render();
  document.getElementById('btnClose').addEventListener('click', tryClose);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') tryClose(); });
})();
