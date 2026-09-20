/* 循环闹钟 — 工具栏弹窗：快速查看 / 启用切换 / 删除 */
const L = globalThis.AlarmClock;

async function getState() {
  const obj = await chrome.storage.local.get('state');
  return obj.state || { groups: [] };
}

function groupNextTime(g, now) {
  let best = null;
  for (const a of g.alarms || []) {
    const t = L.nextFireTime(a, g, now);
    if (t != null && (best == null || t < best)) best = t;
  }
  return best;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function nextLabel(g, now) {
  if (g.enabled === false) return { text: '已停用', cls: 'off' };
  const t = groupNextTime(g, now);
  if (t == null) return { text: '—', cls: 'off' };
  if (t <= now) return { text: '即将提醒', cls: 'due' };
  const d1 = new Date(t), d0 = new Date(now);
  const sameDay = d1.getFullYear() === d0.getFullYear() && d1.getMonth() === d0.getMonth() && d1.getDate() === d0.getDate();
  return { text: sameDay ? L.formatHHMM(t) : (d1.getMonth() + 1) + '/' + d1.getDate() + ' ' + L.formatHHMM(t), cls: '' };
}

async function render() {
  const state = await getState();
  const now = Date.now();
  const list = document.getElementById('list');
  const summary = document.getElementById('summary');
  const enabledCount = state.groups.filter(g => g.enabled).length;
  summary.textContent = state.groups.length
    ? enabledCount + '/' + state.groups.length + ' 个分组启用中'
    : '还没有分组';

  list.innerHTML = '';
  if (!state.groups.length) {
    list.innerHTML = '<div class="empty">还没有分组<br>点击下方「＋ 新建分组」开始</div>';
    return;
  }
  for (const g of state.groups) {
    const nl = nextLabel(g, now);
    const row = document.createElement('div');
    row.className = 'group' + (g.enabled ? '' : ' off');
    row.innerHTML =
      '<input type="checkbox" title="启用/停用" ' + (g.enabled ? 'checked' : '') + '>' +
      '<div class="gname" title="点击在选项页编辑">' +
        '<b>' + esc(g.name || '（未命名）') + '</b>' +
        '<small>' + L.windowLabel(g) + ' · ' + (g.alarms || []).length + ' 个闹钟</small>' +
      '</div>' +
      '<span class="next ' + nl.cls + '">' + nl.text + '</span>' +
      '<button class="iconbtn" data-act="del" title="删除分组">✕</button>';

    const cb = row.querySelector('input');
    cb.addEventListener('change', async () => {
      const st = await getState();
      const gg = st.groups.find(x => x.id === g.id);
      if (!gg) return;
      gg.enabled = cb.checked;
      await chrome.storage.local.set({ state: st });
    });
    row.querySelector('.gname').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + '?group=' + g.id });
    });
    row.querySelector('[data-act=del]').addEventListener('click', async () => {
      if (!confirm('删除分组「' + (g.name || '（未命名）') + '」？其中的闹钟也会一并删除。')) return;
      const st = await getState();
      st.groups = st.groups.filter(x => x.id !== g.id);
      await chrome.storage.local.set({ state: st });
    });
    list.appendChild(row);
  }
}

document.getElementById('btnNew').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + '?new=1' });
});
document.getElementById('btnOptions').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
});
document.getElementById('btnTest').addEventListener('click', () => {
  // 立即在当前浏览的页面右上角弹出测试卡片（验证页面内提醒链路）
  chrome.runtime.sendMessage({ type: 'testReminder' }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state) render();
});

render();
