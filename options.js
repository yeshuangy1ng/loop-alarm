/*
 * 循环闹钟 — 选项页：分组 / 闹钟完整管理
 * 保存策略：修改即保存（chrome.storage.local）。
 *   - 文本框（名称/文案）：input 事件静默保存，不重渲染，避免丢焦点
 *   - 开关/时间/数值：change 事件保存后重渲染刷新“下次提醒”
 * 外部页面（popup）/ 后台（触发推进、稍后提醒）修改状态时按内容比对自动刷新本页面
 * （写入内容与自己上一次保存一致才视为自写，避免时间窗误判丢弃真实外部变更）。
 */
const L = globalThis.AlarmClock;
const params = new URLSearchParams(location.search);
let state = { groups: [] };
let selectedId = null;
let lastWrittenJson = null;

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function load() {
  const obj = await chrome.storage.local.get('state');
  state = obj.state || { version: 1, groups: [] };
  if (!Array.isArray(state.groups)) state.groups = [];
  return state;
}

async function persist() {
  lastWrittenJson = JSON.stringify(state);
  await chrome.storage.local.set({ state });
}

function selGroup() {
  return state.groups.find(g => g.id === selectedId) || null;
}

function tsToLocalInput(ts) {
  const d = new Date(ts);
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function renderSidebar() {
  const box = document.getElementById('groupList');
  box.innerHTML = '';
  if (!state.groups.length) {
    box.innerHTML = '<div style="color:#868e96;font-size:12px;padding:8px">还没有分组，点击上方「＋ 新建分组」</div>';
    return;
  }
  for (const g of state.groups) {
    const el = document.createElement('div');
    el.className = 'gitem' + (g.id === selectedId ? ' sel' : '');
    el.innerHTML =
      '<b><span class="dot ' + (g.enabled ? '' : 'off') + '"></span>' + esc(g.name || '（未命名）') + '</b>' +
      '<small>' + L.windowLabel(g) + ' · ' + (g.alarms || []).length + ' 个闹钟</small>';
    el.addEventListener('click', () => { selectedId = g.id; renderSidebar(); renderMain(); });
    box.appendChild(el);
  }
}

function nextLine(a, g) {
  if (g.enabled === false || a.enabled === false) return '已停用';
  const now = Date.now();
  const t = L.nextFireTime(a, g, now);
  if (t == null) return '—';
  let s = '下次提醒：' + L.formatDateTime(t);
  if (a.snoozedUntil != null) {
    s += '（稍后提醒至 ' + L.formatDateTime(a.snoozedUntil) + '）';
  } else {
    const due = L.dueTime(a);
    const win = { start: g.start, end: g.end };
    if (due > now && !L.inWindow(due, win)) {
      s += '（时刻在生效时间段外，将按间隔步进到段内再提醒）';
    }
  }
  return s;
}

function renderMain() {
  const main = document.getElementById('main');
  const g = selGroup();
  if (!g) {
    main.innerHTML = '<div class="emptyhint">在左侧选择或新建一个分组</div>';
    return;
  }
  const alarmsHtml = (g.alarms || []).map(a => {
    const h = Math.floor((a.intervalMinutes || 0) / 60);
    const m = (a.intervalMinutes || 0) % 60;
    return (
      '<div class="alarm" data-aid="' + a.id + '">' +
        '<div class="head">' +
          '<input type="text" data-f="name" value="' + esc(a.name) + '" placeholder="闹钟名称" title="闹钟名称">' +
          '<label style="display:flex;align-items:center;gap:4px;font-size:12px;flex-shrink:0"><input type="checkbox" data-f="enabled" ' + (a.enabled ? 'checked' : '') + '> 启用</label>' +
          '<button class="del" data-act="delalarm">删除</button>' +
        '</div>' +
        '<div style="margin-bottom:8px">' +
          '<div style="font-size:12px;color:#495057;margin-bottom:4px">提醒文案（可选）</div>' +
          '<textarea data-f="text" placeholder="要提醒的事项，如：起来活动 5 分钟">' + esc(a.text) + '</textarea>' +
        '</div>' +
        '<div class="grid">' +
          '<label>间隔 <input type="number" data-f="ih" value="' + h + '" min="0" max="999"> 小时 ' +
          '<input type="number" data-f="im" value="' + m + '" min="0" max="59"> 分钟</label>' +
          '<label>开始时间 <input type="datetime-local" data-f="start" value="' + (a.startTime ? tsToLocalInput(a.startTime) : '') + '" title="首次提醒时刻；留空 = 按间隔立即开始循环"> <a href="#" data-act="clearstart" style="font-size:12px">清空</a></label>' +
        '</div>' +
        '<div class="nextline">' + nextLine(a, g) + '</div>' +
      '</div>'
    );
  }).join('');

  main.innerHTML = (
    '<div class="card">' +
      '<div class="cardhead"><h2>分组设置</h2><button class="del" id="delGroup">删除该分组</button></div>' +
      '<p class="hint">分组仅在「生效时间段」内有效；提醒时刻落在段外时跳过该轮。开始 &gt; 结束 视为跨午夜；两者相同视为全天。</p>' +
      '<label class="f"><span>分组名称</span><input type="text" id="gname" value="' + esc(g.name) + '" style="flex:1"></label>' +
      '<label class="f"><span>生效时间段</span><input type="time" id="wstart" value="' + esc(g.start) + '"> 至 <input type="time" id="wend" value="' + esc(g.end) + '"></label>' +
      '<label class="f"><span>启用</span><input type="checkbox" id="genabled" ' + (g.enabled ? 'checked' : '') + '> <span style="font-size:12px;color:#868e96">停用后该分组所有闹钟暂停</span></label>' +
    '</div>' +
    '<div class="card">' +
      '<h2>闹钟</h2>' +
      '<p class="hint">每条闹钟按固定间隔循环提醒。「开始时间」= 首次提醒时刻；留空则从当前时刻起按间隔循环。</p>' +
      '<div id="alarmList">' + (alarmsHtml || '<div style="color:#868e96;font-size:12px;padding:8px 0">该分组还没有闹钟</div>') + '</div>' +
      '<button class="addalarm" id="addAlarm">＋ 添加闹钟</button>' +
    '</div>'
  );
  bindMain(g);
}

function bindMain(g) {
  const q = id => document.getElementById(id);

  // ---- 分组字段 ----
  q('gname').addEventListener('input', e => {
    g.name = e.target.value.trim() || '（未命名）';
    persist(); renderSidebar();
  });
  q('wstart').addEventListener('change', e => {
    g.start = e.target.value || '00:00';
    persist(); renderSidebar(); renderMain();
  });
  q('wend').addEventListener('change', e => {
    g.end = e.target.value || '00:00';
    persist(); renderSidebar(); renderMain();
  });
  q('genabled').addEventListener('change', e => {
    g.enabled = e.target.checked;
    persist(); renderSidebar(); renderMain();
  });
  q('delGroup').addEventListener('click', async () => {
    if (!confirm('删除分组「' + (g.name || '（未命名）') + '」？其中的闹钟也会一并删除。')) return;
    const st = await load();
    st.groups = st.groups.filter(x => x.id !== g.id);
    state = st;
    selectedId = (state.groups[0] || {}).id || null;
    await persist();
    renderSidebar(); renderMain();
  });
  q('addAlarm').addEventListener('click', async () => {
    const now = Date.now();
    g.alarms = g.alarms || [];
    g.alarms.push({
      id: L.uid('a'),
      name: '新闹钟',
      text: '',
      intervalMinutes: 30,
      startTime: null,
      enabled: true,
      nextFire: now + 30 * 60000,
      snoozedUntil: null
    });
    await persist();
    renderSidebar(); renderMain();
  });

  // ---- 闹钟字段（通过 data-aid 精确定位，重名也不冲突） ----
  document.querySelectorAll('.alarm').forEach(box => {
    const alarm = (g.alarms || []).find(x => x.id === box.dataset.aid);
    if (!alarm) return;
    const delBtn = box.querySelector('[data-act="delalarm"]');
    const nameInput = box.querySelector('[data-f="name"]');

    nameInput.addEventListener('input', e => {
      alarm.name = e.target.value;
      persist();
    });
    box.querySelector('[data-f="text"]').addEventListener('input', e => {
      alarm.text = e.target.value;
      persist();
    });
    box.querySelector('[data-f="enabled"]').addEventListener('change', e => {
      alarm.enabled = e.target.checked;
      persist(); renderMain();
    });

    const ih = box.querySelector('[data-f="ih"]');
    const im = box.querySelector('[data-f="im"]');
    const applyInterval = async () => {
      const total = (parseInt(ih.value, 10) || 0) * 60 + (parseInt(im.value, 10) || 0);
      if (total < 1) { alert('间隔至少要 1 分钟（小时和分钟不能同时为 0）'); return; }
      const now = Date.now();
      alarm.intervalMinutes = total;
      // 改间隔立即重新锚定，保证变更马上生效：
      // - 开始时间在未来 → 首次提醒仍是该开始时间（之后的循环用新间隔）
      // - 未设开始时间 / 开始时间已过（循环已在进行）→ 从当前时刻按新间隔重新起算
      //   （不重锚定的话下次提醒仍按旧锚点，用户会看到旧节奏继续，感觉“改间隔没生效”）
      if (alarm.startTime != null && alarm.startTime > now) alarm.nextFire = alarm.startTime;
      else alarm.nextFire = now + total * 60000;
      await persist();
      renderMain();
    };
    ih.addEventListener('change', applyInterval);
    im.addEventListener('change', applyInterval);

    box.querySelector('[data-f="start"]').addEventListener('change', e => {
      const v = e.target.value;
      const now = Date.now();
      // 显式设置/清空开始时间：取消挂起的「稍后提醒」。
      // 到期时间以稍后提醒优先，若不清除，新开始时间会被稍后时刻遮蔽，
      // 稍后触发后锚点 = 稍后时刻 + 间隔，新开始时间永远不会被用到（“设了开始时间不生效”）
      alarm.snoozedUntil = null;
      if (!v) {
        alarm.startTime = null;
        alarm.nextFire = now + alarm.intervalMinutes * 60000;
      } else {
        const t = new Date(v).getTime();
        alarm.startTime = Number.isFinite(t) ? t : null;
        alarm.nextFire = (Number.isFinite(t) && t > now) ? t : now; // 过去时刻 → 立即补提醒
      }
      persist(); renderMain();
    });

    box.querySelector('[data-act="clearstart"]').addEventListener('click', e => {
      e.preventDefault();
      alarm.startTime = null;
      alarm.snoozedUntil = null;
      alarm.nextFire = Date.now() + alarm.intervalMinutes * 60000;
      persist(); renderMain();
    });

    delBtn.addEventListener('click', async () => {
      if (!confirm('删除闹钟「' + (alarm.name || '（未命名）') + '」？')) return;
      g.alarms = g.alarms.filter(x => x.id !== alarm.id);
      await persist();
      renderSidebar(); renderMain();
    });
  });
}

// 外部变更（后台触发后推进 nextFire、其他页面稍后提醒等）→ 刷新本页面。
// “自己的写入”按内容判断而非 800ms 时间窗：
// 旧的定时判断会把恰好落在 800ms 内的后台变更误当自写丢弃，
// 导致本页面内存状态过期，下一次保存时整体覆盖后台的变更（定时器被设回旧值）。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.state) return;
  const nv = changes.state.newValue;
  if (nv && lastWrittenJson && JSON.stringify(nv) === lastWrittenJson) return; // 自己触发的写入
  refreshFromExternal();
});

function refreshFromExternal() {
  const ae = typeof document !== 'undefined' ? document.activeElement : null;
  const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')
    && ae.type !== 'checkbox' && ae.type !== 'radio';
  if (typing) {
    // 正在输入文本（名称/文案逐字保存）时，等失焦再刷新，避免重建 DOM 打断输入
    ae.addEventListener('blur', () => refreshFromExternal(), { once: true });
    return;
  }
  load().then(() => {
    if (!selGroup()) selectedId = (state.groups[0] || {}).id || null;
    renderSidebar(); renderMain();
  });
}

// 新建分组（侧边栏按钮与 ?new=1 深链接共用）
function createGroup() {
  const g = { id: L.uid('g'), name: '新分组', enabled: true, start: '09:00', end: '17:00', alarms: [] };
  state.groups.push(g);
  selectedId = g.id;
  return g;
}

document.getElementById('btnNewGroup').addEventListener('click', async () => {
  createGroup();
  await persist();
  renderSidebar();
  renderMain();
});

// ---- 配置导入 / 导出 ----

function downloadJson(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const aEl = document.createElement('a');
  aEl.href = url;
  aEl.download = filename;
  document.body.appendChild(aEl);
  aEl.click();
  setTimeout(() => { aEl.remove(); URL.revokeObjectURL(url); }, 5000);
}

/** 导出载荷：包裹 app 标识与导出时间，state 为完整配置 */
function exportPayload(state) {
  return JSON.stringify({
    app: 'alarmclock',
    version: 1,
    exportedAt: new Date().toISOString(),
    state
  }, null, 2);
}

/**
 * 把导入结构清洗为合法 groups 数组；无法识别返回 null。
 * 兼容三种格式：{state:{groups}} / {groups} / 裸 groups 数组。
 * 缺失字段补默认值，非法字段（时间格式、间隔、锚点）纠正或重置。
 */
function sanitizeGroups(raw, now) {
  let arr = null;
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === 'object') arr = raw.groups;
  if (!Array.isArray(arr)) return null;
  return arr.filter(g => g && typeof g === 'object').map(g => {
    const group = {
      id: (typeof g.id === 'string' && g.id) ? g.id : L.uid('g'),
      name: typeof g.name === 'string' ? g.name : '（未命名）',
      enabled: g.enabled !== false,
      start: /^\d{1,2}:\d{2}$/.test(String(g.start)) ? String(g.start) : '09:00',
      end: /^\d{1,2}:\d{2}$/.test(String(g.end)) ? String(g.end) : '17:00',
      alarms: []
    };
    if (Array.isArray(g.alarms)) {
      group.alarms = g.alarms.filter(a => a && typeof a === 'object').map(a => {
        const interval = Math.max(1, Math.floor(Number(a.intervalMinutes) || 60));
        let nextFire = Number(a.nextFire);
        if (!isFinite(nextFire) || nextFire < 0) nextFire = now + interval * 60000;
        let snoozed = a.snoozedUntil == null ? null : Number(a.snoozedUntil);
        if (!isFinite(snoozed)) snoozed = null;
        let start = a.startTime == null ? null : Number(a.startTime);
        if (!isFinite(start)) start = null;
        return {
          id: (typeof a.id === 'string' && a.id) ? a.id : L.uid('a'),
          name: typeof a.name === 'string' ? a.name : '（未命名）',
          text: typeof a.text === 'string' ? a.text : '',
          intervalMinutes: interval,
          startTime: start,
          enabled: a.enabled !== false,
          nextFire,
          snoozedUntil: snoozed
        };
      });
    }
    return group;
  });
}

document.getElementById('btnExport').addEventListener('click', async () => {
  const st = await load();
  const d = new Date();
  const p = n => (n < 10 ? '0' : '') + n;
  const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  downloadJson('循环闹钟-配置-' + stamp + '.json', exportPayload(st));
});

document.getElementById('btnImport').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', async (ev) => {
  const input = ev.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { alert('导入失败：文件不是有效的 JSON'); return; }
  let raw = data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    raw = (data.state && typeof data.state === 'object') ? data.state.groups : data.groups;
  }
  const groups = sanitizeGroups(raw, Date.now());
  if (!groups) { alert('导入失败：无法识别配置结构（未找到 groups 数组）'); return; }
  const cur = await load();
  if (!confirm('导入将覆盖现有 ' + cur.groups.length + ' 个分组（本次导入 ' + groups.length + ' 个），继续？')) return;
  state = { version: 1, groups };
  selectedId = (groups[0] || {}).id || null;
  await persist();
  renderSidebar();
  renderMain();
});

(async function init() {
  await load();
  if (params.get('new')) {
    createGroup();
    await persist();
    history.replaceState(null, '', 'options.html');
  } else {
    const gid = params.get('group');
    selectedId = (gid && state.groups.some(x => x.id === gid)) ? gid : ((state.groups[0] || {}).id || null);
  }
  renderSidebar();
  renderMain();
})();
