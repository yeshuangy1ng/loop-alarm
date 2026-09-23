/*
 * 循环闹钟 — 页面内提醒卡片（内容脚本）
 * 显示在当前页面右上角（position: fixed，高 z-index，全内联样式，避免受页面 CSS 影响）。
 * 后台通过 chrome.tabs.sendMessage 发送 { type: 'showReminder', batch }：
 *   - 每条提醒有「稍后 5 / 10 / 30 分钟」按钮 → 向后台发 snooze 消息，
 *     该条目随即收起；所有条目都处理后卡片自动关闭
 *   - 顶部「✕ 关闭」→ 向后台发 dismiss 消息（删除该批次）
 * 新提醒到达时先关闭旧卡片并清理旧批次。
 */
(function () {
  if (globalThis.__AC_TOAST_INSTALLED__) return;
  globalThis.__AC_TOAST_INSTALLED__ = true;

  let card = null;
  let currentBatchId = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'showReminder' || !msg.batch) return;
    render(msg.batch);
  });

  function makeEl(tag, styles, text) {
    const el = document.createElement(tag);
    Object.assign(el.style, styles);
    if (text != null) el.textContent = text;
    return el;
  }

  function render(batch) {
    // 先关闭旧卡片（并通知后台清理旧批次）
    if (card) {
      card.remove();
      card = null;
      const oldId = currentBatchId;
      currentBatchId = null;
      if (oldId) chrome.runtime.sendMessage({ type: 'dismiss', batchId: oldId }).catch(() => { });
    }

    const node = makeEl('div', {
      position: 'fixed',
      top: '16px',
      right: '16px',
      width: '320px',
      maxWidth: 'calc(100vw - 32px)',
      boxSizing: 'border-box',
      zIndex: '2147483647',
      background: '#ffffff',
      color: '#212529',
      borderRadius: '12px',
      border: '1px solid rgba(0,0,0,0.08)',
      boxShadow: '0 10px 36px rgba(0,0,0,0.3)',
      fontFamily: 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
      fontSize: '13px',
      lineHeight: '1.5',
      overflow: 'hidden'
    });

    // 顶栏
    const head = makeEl('div', {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      background: '#f76707',
      color: '#fff',
      padding: '10px 12px'
    });
    head.appendChild(makeEl('div', { fontWeight: '600', fontSize: '13px' },
      '🔔 循环闹钟 · ' + batch.items.length + ' 条提醒'));
    const closeBtn = makeEl('button', {
      border: 'none',
      background: 'rgba(255,255,255,0.25)',
      color: '#fff',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '13px',
      padding: '2px 8px',
      lineHeight: '1'
    }, '✕ 关闭');
    closeBtn.addEventListener('click', () => {
      const id = batch.batchId;
      node.remove();
      if (node === card) { card = null; currentBatchId = null; }
      chrome.runtime.sendMessage({ type: 'dismiss', batchId: id }).catch(() => { });
    });
    head.appendChild(closeBtn);
    node.appendChild(head);

    // 提醒条目
    const itemBoxes = [];
    // 稍后提醒后收起该条目；所有条目都处理完 → 整卡自动关闭
    // （后台已把该条目从批次中移除，批次清空时后台自动删除批次）
    function removeItem(box) {
      box.style.transition = 'opacity .2s';
      box.style.opacity = '0';
      setTimeout(() => {
        box.remove();
        const i = itemBoxes.indexOf(box);
        if (i >= 0) itemBoxes.splice(i, 1);
        if (itemBoxes.length === 0 && card === node) {
          node.remove();
          card = null;
          currentBatchId = null;
          console.info('[循环闹钟] 提醒已全部处理，卡片自动关闭');
        }
      }, 200);
    }

    for (const it of batch.items) {
      const box = makeEl('div', { padding: '10px 12px', borderTop: '1px solid #f1f3f5' });
      box.appendChild(makeEl('div', { fontWeight: '600', fontSize: '13px', marginBottom: '2px' },
        (it.alarmName || '（未命名）') + (it.groupName ? '（' + it.groupName + '）' : '')));
      if (it.text) {
        box.appendChild(makeEl('div', {
          color: '#495057',
          fontSize: '12px',
          marginBottom: '6px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }, it.text));
      }
      const row = makeEl('div', { display: 'flex', gap: '6px' });
      for (const min of [5, 10, 30]) {
        const b = makeEl('button', {
          flex: '1',
          border: '1px solid #f76707',
          background: '#fff',
          color: '#e8590c',
          borderRadius: '6px',
          padding: '4px 0',
          fontSize: '12px',
          cursor: 'pointer'
        }, '稍后 ' + min + ' 分钟');
        b.addEventListener('click', () => {
          b.disabled = true;
          b.style.color = '#868e96';
          b.style.borderColor = '#dee2e6';
          b.textContent = min + ' 分钟 ✓';
          chrome.runtime.sendMessage({ type: 'snooze', batchId: batch.batchId, alarmId: it.alarmId, minutes: min })
            .catch(() => { });
          removeItem(box);
        });
        row.appendChild(b);
      }
      box.appendChild(row);
      node.appendChild(box);
      itemBoxes.push(box);
    }

    card = node;
    currentBatchId = batch.batchId;
    (document.body || document.documentElement).appendChild(node);
    console.info('[循环闹钟] 提醒卡片已渲染（' + batch.items.length + ' 条）');
  }
  console.log('循环闹钟内容脚本已安装');
})();
