import { addVisit, costTrend, dayNumber, endDateForDuration, localDateTime, mergeBackup, moneyToCents, parseBackup, shiftDate, stats, today, validateState } from './domain.mjs';
import { backupStatus, BACKUP_KEY, loadData, prepareBackup, recordBackup, saveData, STORAGE_KEY } from './storage.mjs';
import { renderInsights, trendDetail } from './insights.mjs';

const $ = selector => document.querySelector(selector);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const currency = cents => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${({ plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="m5 12 4 4L19 6"/>', card: '<rect x="2" y="5" width="20" height="15" rx="3"/><path d="M2 10h20M6 15h4"/>', chart: '<path d="M4 4v16h16M8 15l4-5 4 2 4-7"/>', calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2"/>', download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>', upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 16v5h16v-5"/>' })[name]}</svg>`;
let state = { version: 1, cards: [] }, raw = null, blocked = false, selectedId = null;
let editId = null, editingRaw = null, recordMonth = today().slice(0, 7), recordDate = null, recordLimit = 40, visitCardId = null;
let toastTimer, undo = null, confirmAction = null, lastDay = today(), installPrompt = null;
let durationMode = '12';
let trendRange = 'month', renderVersion = 0, backupRefreshId = 0, exporting = false;

function syncDuration(recalculate = true) {
  const form = $('#card-form'), custom = durationMode === 'custom', manual = durationMode === 'dates';
  $('#duration-custom').hidden = !custom;
  form.elements.durationValue.disabled = !custom; form.elements.durationValue.required = custom;
  form.elements.durationUnit.disabled = !custom;
  form.elements.end.setCustomValidity('');
  document.querySelectorAll('[data-duration]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.duration === durationMode)));
  $('#end-date-label').textContent = manual ? '到期日期' : '到期日期（自动计算）';
  if (!manual && recalculate) {
    try {
      const value = custom ? Number(form.elements.durationValue.value) : Number(durationMode);
      const unit = custom ? form.elements.durationUnit.value : 'months';
      form.elements.end.value = endDateForDuration(form.elements.start.value, value, unit);
    } catch (error) {
      form.elements.end.value = ''; form.elements.end.setCustomValidity(error.message);
      $('#duration-hint').textContent = error.message;
      return;
    }
  }
  const start = form.elements.start.value, end = form.elements.end.value;
  let summary = '';
  if (start && end && end >= start) summary = `共 ${dayNumber(end) - dayNumber(start) + 1} 天，生效当天计入有效期。`;
  $('#duration-hint').textContent = manual ? `${summary}也可以选择上方时长自动计算。` : `${summary}月 / 年按日历计算，月底不足同日时在月底到期；可直接修改到期日期。`;
}

$('#card-form').addEventListener('click', event => {
  const button = event.target.closest('[data-duration]'); if (!button) return;
  const form = $('#card-form');
  if (button.dataset.duration === 'custom' && durationMode !== 'custom') {
    const start = form.elements.start.value, end = form.elements.end.value;
    form.elements.durationValue.value = start && end && end >= start ? dayNumber(end) - dayNumber(start) + 1 : 1;
    form.elements.durationUnit.value = 'days';
  }
  durationMode = button.dataset.duration;
  syncDuration();
});
$('#card-form').addEventListener('input', event => {
  if (event.target.name === 'end') { durationMode = 'dates'; syncDuration(false); }
  if (['start', 'durationValue'].includes(event.target.name)) syncDuration();
});
$('#card-form').addEventListener('change', event => {
  if (event.target.name === 'durationUnit') syncDuration();
});

function notify(message, undoAction = null) {
  clearTimeout(toastTimer); $('#toast-text').textContent = message; undo = undoAction;
  $('#toast-undo').hidden = !undoAction; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; undo = null; }, undoAction ? 10000 : 6000);
}
function errorIn(form, error) {
  const target = $(`#${form}-error`); target.textContent = error.message || '操作未完成，请重试'; target.hidden = false; target.focus();
}
function currentCard() {
  return state.cards.find(c => c.id === selectedId) || state.cards.find(c => c.start <= today() && c.end >= today()) || [...state.cards].sort((a, b) => b.start.localeCompare(a.start)).find(c => c.start <= today()) || [...state.cards].sort((a, b) => a.start.localeCompare(b.start))[0];
}
function persist(next, expected = raw) {
  if (blocked) throw new Error('本机数据尚未成功读取，已停止写入以保护原始记录');
  const saved = saveData(next, localStorage, expected); state = saved.state; raw = saved.raw;
}
function replaceCard(next, expected = raw) { persist({ ...state, cards: state.cards.map(c => c.id === next.id ? next : c) }, expected); }
function confirm(title, description, action, label = '确认') {
  $('#confirm-title').textContent = title; $('#confirm-description').textContent = description; $('#confirm-yes').textContent = label;
  confirmAction = action; $('#confirm-dialog').showModal(); $('#confirm-cancel').focus();
}
function cardPicker(card) {
  if (state.cards.length < 2) return '';
  return `<label class="card-selector">查看办卡周期<select id="period-select">${[...state.cards].sort((a, b) => b.start.localeCompare(a.start)).map(c => `<option value="${c.id}" ${c.id === card.id ? 'selected' : ''}>${escape(c.name)} · ${c.start} — ${c.end}</option>`).join('')}</select></label>`;
}
function backupNotice(withAction = true) {
  return `<aside class="backup-reminder" data-backup-notice hidden aria-label="备份提醒"><div><h3>给记录留一份备份</h3><p data-backup-message></p></div>${withAction ? `<button class="secondary-button" data-action="export">${icon('download')}导出备份</button>` : ''}</aside>`;
}
async function refreshBackupReminder(version = renderVersion) {
  if (blocked || !state.cards.length) return;
  const requestId = ++backupRefreshId;
  const result = await backupStatus(state);
  if (version !== renderVersion || requestId !== backupRefreshId) return;
  const label = result.exportedAt ? `上次生成备份：${new Date(result.exportedAt).toLocaleString('zh-CN')}` : '尚无本机导出记录';
  document.querySelectorAll('[data-backup-time]').forEach(el => { el.textContent = `${label}。生成下载后，请确认文件已保存。`; });
  const message = {
    never: '还没有本机导出记录，建议现在保存一份。',
    changed: '有新增或修改尚未导出，记得保存最新记录。',
    due: `距上次生成备份已 ${result.days} 天，建议再保存一份。`,
    unavailable: '暂时无法读取导出状态，你仍可手动导出备份。'
  }[result.reason];
  document.querySelectorAll('[data-backup-notice]').forEach(el => {
    el.hidden = !message;
    el.querySelector('[data-backup-message]').textContent = message || '';
  });
}
async function exportBackup() {
  if (exporting) return;
  exporting = true;
  document.querySelectorAll('[data-action="export"]').forEach(el => { el.disabled = true; });
  try {
    const prepared = await prepareBackup(state);
    download(prepared.content, `每次-健身备份-${today()}.json`);
    recordBackup(prepared.metadata);
    await refreshBackupReminder();
    notify('已生成备份，请在下载列表中确认保存');
  } catch (error) { notify(error.message); }
  finally {
    exporting = false;
    document.querySelectorAll('[data-action="export"]').forEach(el => { el.disabled = false; });
  }
}
function backupSection() {
  return `<section class="backup-section"><h3>数据只属于你</h3><p>记录保存在当前浏览器。换手机、清理浏览器数据前，记得导出一份备份。</p><p data-backup-time>正在读取上次导出时间…</p>${backupNotice(false)}<div class="backup-actions"><button class="secondary-button" data-action="export">${icon('download')}导出备份</button><button class="secondary-button" data-action="import">${icon('upload')}导入备份</button></div><p>导入会合并记录，不会删除现有数据；信息冲突时会停止导入。</p><div class="install-note">${installPrompt ? '<button class="secondary-button" data-action="install">添加到手机桌面</button>' : '添加到桌面：在安卓浏览器菜单中查找“安装应用”或“添加到主屏幕”。安装功能需要 HTTPS 访问。'}<br>本应用无账号，不会上传你的卡片或打卡记录。</div></section>`;
}
function empty(view) {
  return `<section class="empty-state"><div class="empty-illustration">${icon('card')}</div><h1>每次到场，都算数。</h1><p>花了多少钱，去了多少次。<br>从第一张健身卡开始，看见每次坚持的成本。</p><button class="primary-button" data-action="new-card">${icon('plus')}添加我的健身卡</button><div class="empty-note">已有历史记录？<button class="text-button" data-action="import">导入备份</button></div><div class="empty-preview"><div>${icon('chart')}每次成本，随着到场更新</div><div>${icon('calendar')}这一周、这个月，记录清清楚楚</div><div>${icon('check')}设定目标，看看还差几次</div></div></section>${view === 'cards' ? backupSection() : ''}`;
}
function home(card) {
  const s = stats(card);
  const dateLabel = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  const badge = s.status === 'expired' ? '已到期' : s.status === 'upcoming' ? '待生效' : s.remaining === 0 ? '已达标' : null;
  const costValue = s.cost === null ? '—' : currency(s.cost);
  const pace = s.weeklyNeeded === null ? '到期未达标，可继续补录有效期内的记录' : s.remaining === 0 ? '目标已达到，继续记录每一次到场' : `平均每周 <b>${s.weeklyNeeded.toFixed(1)}</b> 次${s.status === 'upcoming' ? '（生效后）' : ''}`;
  const week = s.weekDates.map((date, i) => {
    const count = card.visits.filter(v => v.at.startsWith(date)).length;
    return `<div class="week-day" aria-label="${date}，${count} 次"><span>${'一二三四五六日'[i]}</span><span class="day-dot ${count ? 'visited' : ''} ${date === today() ? 'is-today' : ''}">${count > 1 ? count : count ? '✓' : '—'}</span></div>`;
  }).join('');
  return `${cardPicker(card)}<div class="date-line">${escape(dateLabel)}</div><section class="cost-hero"><div class="cost-label">${s.status === 'expired' ? '最终单次成本' : '当前单次成本'}${badge ? `<span class="state-badge">${badge}</span>` : ''}</div><div class="money-display ${costValue.length > 8 ? 'long-money' : ''}"><span class="currency">¥</span><strong>${costValue}</strong><span class="unit">/ 次</span></div><div class="cost-target"><span><i class="orange-dot" aria-hidden="true"></i>目标 ¥${currency(card.target)} / 次</span>${s.cost === null ? '<span>从第一次到场开始</span>' : ''}</div></section><button class="primary-button check-button" data-action="check" ${s.status !== 'active' ? 'disabled' : ''}>${icon('plus')}${s.status === 'expired' ? '卡片已到期' : s.status === 'upcoming' ? '卡片尚未生效' : '打卡一次'}</button><div class="check-support"><span>同一天多次到场，也可以记录</span><button class="text-button" data-action="backfill">补录打卡</button></div><section class="stats-row" aria-label="到店次数"><div><span class="stat-number">${s.total}</span><span class="stat-label">累计次数</span></div><div><span class="stat-number">${s.week}</span><span class="stat-label">本周次数</span></div><div><span class="stat-number">${s.month}</span><span class="stat-label">本月次数</span></div></section><section class="goal-card"><div class="section-title"><h3>${s.remaining === 0 ? '每一次坚持，都有回响' : '离目标又近一步'}</h3><span class="subtle">${Math.floor(s.progress)}%</span></div><div class="goal-progress" role="progressbar" aria-label="目标次数完成比例" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${s.progress.toFixed(1)}"><span style="width:${s.progress}%"></span></div><p class="goal-detail">${s.remaining > 0 ? `还需 <b>${s.remaining}</b> 次<br>` : ''}${pace}</p><div class="foot-row"><span>卡费 ¥${currency(card.amount)}</span><span>${s.status === 'upcoming' ? `${card.start} 生效` : s.daysLeft ? `剩余 ${s.daysLeft} 天` : `${card.end} 已到期`}</span></div></section><section class="week-section"><div class="section-title"><h3>这一周</h3><a class="text-button" href="#records">全部记录</a></div><div class="week-grid">${week}</div><p class="week-caption">周一至周日 · 已记录 ${s.days} 个健身日${card.initial ? `，另有 ${card.initial} 次无日期历史记录` : ''}</p></section>`;
}
function records(card) {
  const all = card.visits.filter(v => v.at.startsWith(recordMonth)).sort((a, b) => b.at.localeCompare(a.at));
  const filtered = all.filter(v => !recordDate || v.at.startsWith(recordDate));
  const firstDate = `${recordMonth}-01`, firstDay = (new Date(`${firstDate}T00:00:00Z`).getUTCDay() + 6) % 7;
  const nextMonth = new Date(`${firstDate}T00:00:00Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const days = nextMonth.getTime() / 86400000 - dayNumber(firstDate);
  let lastDate = '';
  const list = filtered.slice(0, recordLimit).map(v => {
    const day = v.at.slice(0, 10);
    const heading = day !== lastDate ? `<div class="record-day"><span>${day.replaceAll('-', '.')}</span><span>${all.filter(x => x.at.startsWith(day)).length} 次到场</span></div>` : '';
    lastDate = day;
    return `${heading}<div class="record-row"><div class="record-left"><span class="record-icon">${icon('check')}</span><div><time datetime="${v.at}">${v.at.slice(11)}</time><p>到店打卡</p></div></div><button class="text-button" data-remove="${v.id}" aria-label="撤销 ${day} ${v.at.slice(11)} 的打卡">撤销</button></div>`;
  }).join('');
  const calendar = Array.from({ length: firstDay }, () => '<span></span>').join('') + Array.from({ length: days }, (_, i) => {
    const date = `${recordMonth}-${String(i + 1).padStart(2, '0')}`, count = all.filter(v => v.at.startsWith(date)).length;
    return `<button class="calendar-day ${count ? 'has-visits' : ''} ${recordDate === date ? 'selected' : ''} ${date === today() ? 'today' : ''}" type="button" data-date="${date}" aria-pressed="${date === recordDate}" aria-label="${date}，${count} 次打卡"><span>${i + 1}</span>${count ? `<small>${count} 次</small>` : '<small>·</small>'}</button>`;
  }).join('');
  return `<div class="page-heading"><div><h1>到场记录</h1><p class="subtle">每一次坚持，都有迹可循</p></div><button class="secondary-button" data-action="backfill">${icon('plus')}补录</button></div>${cardPicker(card)}<div class="pill-row"><label class="filter-label">月份<input id="month-filter" type="month" min="1900-01" max="2200-12" value="${recordMonth}" required></label>${recordDate ? '<button class="text-button" data-action="clear-date">查看整月</button>' : ''}</div><div class="calendar-grid"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span>${calendar}</div><div class="month-summary"><span>本月 <b>${all.length}</b> 次到场</span><span><b>${new Set(all.map(v => v.at.slice(0, 10))).size}</b> 个健身日</span></div>${card.initial ? `<div class="note-box">此前已去 ${card.initial} 次，已计入累计成本。由于没有具体日期，不在日历、周统计和月统计中显示。</div>` : ''}${list || `<div class="quiet-empty">${recordDate ? '这一天还没有到场记录' : '这个月还没有到场记录'}<br><button class="text-button" data-action="backfill">补上一次打卡</button></div>`}${filtered.length > recordLimit ? '<button class="secondary-button load-more" data-action="load-more">加载更多记录</button>' : ''}`;
}
function cards(card) {
  const s = stats(card), status = { active: '使用中', expired: '已到期', upcoming: '待生效' }[s.status];
  return `<div class="page-heading"><div><h1>我的卡片</h1><p class="subtle">每个周期，独立记录</p></div><button class="secondary-button" data-action="new-card">${icon('plus')}新周期</button></div>${cardPicker(card)}<section class="membership-card"><div class="section-title"><span class="subtle">健身会员卡</span><span class="state-badge">${status}</span></div><h2>${escape(card.name)}</h2><div class="card-price">¥${currency(card.amount)}</div><p class="date-range">${card.start.replaceAll('-', '.')} — ${card.end.replaceAll('-', '.')}</p></section><dl class="detail-list"><div class="detail-item"><dt>目标单次成本</dt><dd>¥${currency(card.target)} / 次</dd></div><div class="detail-item"><dt>${s.status === 'expired' ? '最终单次成本' : '当前单次成本'}</dt><dd>${s.cost === null ? '暂无打卡' : `¥${currency(s.cost)} / 次`}</dd></div><div class="detail-item"><dt>累计到场 / 目标次数</dt><dd>${s.total} / ${s.required} 次</dd></div><div class="detail-item"><dt>已记录的健身天数</dt><dd>${s.days} 天</dd></div><div class="detail-item"><dt>无日期历史次数</dt><dd>${card.initial} 次</dd></div><div class="detail-item"><dt>目标状态</dt><dd>${s.remaining === 0 ? '已达标' : s.status === 'expired' ? `到期未达标，还差 ${s.remaining} 次` : `还差 ${s.remaining} 次`}</dd></div></dl><button class="secondary-button" style="width:100%" data-action="edit-card">编辑卡片信息</button><p class="field-hint">停卡、延期时，可修改到期日期。已有打卡不能超出有效期。</p>${backupSection()}`;
}
function render() {
  const view = ['home', 'records', 'cards'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home', card = currentCard();
  $('#header-card').textContent = card?.name || '我的健身卡';
  document.querySelectorAll('[data-nav]').forEach(el => { if (el.dataset.nav === view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('#main').innerHTML = blocked ? '<section class="quiet-empty">原始数据已保留。请先导出原始数据，以便检查或恢复。</section>' : !card ? empty(view) : view === 'home' ? `${home(card)}${renderInsights(card, trendRange)}${backupNotice()}` : view === 'records' ? records(card) : cards(card);
  void refreshBackupReminder(++renderVersion);
}
function openCard(edit = false) {
  const card = edit ? currentCard() : null;
  editId = card?.id || null; editingRaw = raw;
  const form = $('#card-form'); form.reset(); $('#card-error').hidden = true;
  durationMode = '12';
  $('#card-dialog-title').textContent = card ? '编辑卡片' : state.cards.length ? '开始新的办卡周期' : '添加第一张卡';
  if (card) {
    for (const key of ['name', 'start', 'end', 'initial']) form.elements[key].value = card[key];
    form.elements.amount.value = (card.amount / 100).toFixed(2); form.elements.target.value = (card.target / 100).toFixed(2);
    durationMode = ['1', '3', '6', '12'].find(months => {
      try { return endDateForDuration(card.start, Number(months), 'months') === card.end; } catch { return false; }
    }) || 'dates';
  } else {
    const latest = [...state.cards].sort((a, b) => b.end.localeCompare(a.end))[0];
    const start = latest && latest.end >= today() ? shiftDate(latest.end, 1) : today();
    form.elements.name.value = latest ? '我的新健身卡' : '我的年卡';
    form.elements.start.value = start;
    form.elements.target.value = latest ? (latest.target / 100).toFixed(2) : '20';
  }
  syncDuration(!card);
  $('#card-dialog').showModal();
}
function openVisit() {
  const card = currentCard(); if (!card) return;
  if (card.start > today()) { notify('卡片尚未生效，生效后才可记录打卡'); return; }
  visitCardId = card.id; $('#visit-form').reset(); $('#visit-error').hidden = true;
  const input = $('#visit-form').elements.at;
  input.min = `${card.start}T00:00`; input.max = card.end < today() ? `${card.end}T23:59` : localDateTime(); input.value = input.max;
  $('#visit-hint').textContent = `有效期 ${card.start} 至 ${card.end}；到期当天仍可记录，不可记录未来时间。`;
  $('#visit-dialog').showModal();
}
function checkIn() {
  const card = currentCard(); if (!card || stats(card).status !== 'active') return;
  const before = stats(card).cost, next = addVisit(card, localDateTime());
  replaceCard(next); render();
  const cost = stats(next).cost, visitId = next.visits.at(-1).id;
  notify(before === null ? `首次打卡已记录，当前 ¥${currency(cost)} / 次` : `已记录，单次成本降低 ¥${currency(before - cost)}`, () => revoke(card.id, visitId, false));
}
function revoke(cardId, visitId, ask = true) {
  const card = state.cards.find(c => c.id === cardId), visit = card?.visits.find(v => v.id === visitId); if (!visit) return;
  const action = () => { const latest = state.cards.find(c => c.id === cardId); replaceCard({ ...latest, visits: latest.visits.filter(v => v.id !== visitId) }); render(); notify('已撤销这次打卡，统计已更新'); };
  if (ask) confirm('撤销这次打卡？', `${visit.at.replace('T', ' ')} 的记录将撤销，对应的次数和成本会重新计算。`, action, '撤销打卡'); else action();
}
function download(content, filename) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.addEventListener('click', event => {
  const rangeButton = event.target.closest('[data-trend-range]');
  if (rangeButton) {
    trendRange = rangeButton.dataset.trendRange; render();
    document.querySelector(`[data-trend-range="${trendRange}"]`)?.focus({ preventScroll: true });
    return;
  }
  const button = event.target.closest('[data-action], [data-remove], [data-date]'); if (!button) return;
  try {
    if (button.dataset.remove) return revoke(currentCard().id, button.dataset.remove);
    if (button.dataset.date) { recordDate = recordDate === button.dataset.date ? null : button.dataset.date; recordLimit = 40; render(); return; }
    switch (button.dataset.action) {
      case 'new-card': openCard(); break;
      case 'edit-card': openCard(true); break;
      case 'backfill': openVisit(); break;
      case 'check': checkIn(); break;
      case 'export': void exportBackup(); break;
      case 'import': $('#import-file').click(); break;
      case 'clear-date': recordDate = null; recordLimit = 40; render(); break;
      case 'load-more': recordLimit += 40; render(); break;
      case 'install': if (installPrompt) { installPrompt.prompt(); installPrompt = null; render(); } break;
    }
  } catch (error) { notify(error.message); }
});
document.addEventListener('input', event => {
  if (event.target.id !== 'trend-point') return;
  const point = costTrend(currentCard(), trendRange)[Number(event.target.value)];
  if (point) $('#trend-detail').textContent = trendDetail(point);
});
$('#card-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const fields = new FormData(event.target), previous = state.cards.find(c => c.id === editId), initial = String(fields.get('initial'));
    if (!/^\d+$/.test(initial)) throw new Error('此前次数须为非负整数');
    const card = { id: editId || crypto.randomUUID(), name: fields.get('name'), amount: moneyToCents(fields.get('amount')), target: moneyToCents(fields.get('target')), start: fields.get('start'), end: fields.get('end'), initial: Number(initial), visits: previous?.visits || [] };
    const cards = editId ? state.cards.map(c => c.id === editId ? card : c) : [...state.cards, card];
    persist(validateState({ version: 1, cards }), editingRaw); selectedId = card.id;
    $('#card-dialog').close(); render(); notify(editId ? '卡片已更新，统计已重新计算' : '卡片已添加，开始记录每次到场');
  } catch (error) { errorIn('card', error); }
});
$('#visit-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const card = state.cards.find(c => c.id === visitCardId); if (!card) throw new Error('卡片已发生变化，请重新打开补录');
    replaceCard(addVisit(card, event.target.elements.at.value)); $('#visit-dialog').close(); render(); notify('补录已保存，次数和成本已更新');
  } catch (error) { errorIn('visit', error); }
});
document.addEventListener('change', event => {
  if (event.target.id === 'period-select') { selectedId = event.target.value; recordDate = null; recordLimit = 40; render(); }
  if (event.target.id === 'month-filter') {
    const value = event.target.value;
    if (/^(19\d{2}|20\d{2}|21\d{2}|2200)-(0[1-9]|1[0-2])$/.test(value)) { recordMonth = value; recordDate = null; recordLimit = 40; render(); }
  }
});
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('备份文件超过 5 MB，请检查是否选对文件');
    const incoming = parseBackup(await file.text()), merged = mergeBackup(state, incoming);
    const before = state.cards.reduce((n, c) => n + c.visits.length, 0), after = merged.cards.reduce((n, c) => n + c.visits.length, 0), snapshot = raw;
    confirm('导入这份备份？', `新增 ${merged.cards.length - state.cards.length} 张卡片、${after - before} 条打卡记录。\n相同的记录会跳过，现有数据会保留。`, () => { persist(merged, snapshot); render(); notify('备份已合并导入'); }, '合并导入');
  } catch (error) { notify(error.message); }
});
$('#toast-undo').addEventListener('click', () => { const action = undo; undo = null; $('#toast').hidden = true; try { action?.(); } catch (error) { notify(error.message); } });
$('#confirm-yes').addEventListener('click', () => { $('#confirm-dialog').close(); const action = confirmAction; confirmAction = null; try { action?.(); } catch (error) { notify(error.message); } });
$('#confirm-cancel').addEventListener('click', () => { $('#confirm-dialog').close(); confirmAction = null; });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('#card-switch').addEventListener('click', () => { location.hash = 'cards'; });
window.addEventListener('hashchange', () => { render(); $('#main').focus({ preventScroll: true }); window.scrollTo(0, 0); });
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; render(); });
function load() {
  try { const loaded = loadData(); state = loaded.state; raw = loaded.raw; blocked = false; $('#storage-warning').hidden = true; }
  catch {
    blocked = true;
    $('#storage-warning').innerHTML = '本机数据未能读取，已暂停写入，原始内容不会被覆盖。<br><button class="secondary-button" id="raw-export" type="button">导出原始数据</button>';
    $('#storage-warning').hidden = false;
    $('#raw-export').addEventListener('click', () => { try { download(localStorage.getItem(STORAGE_KEY) || '{}', `每次-原始数据-${today()}.json`); } catch { notify('浏览器禁止访问本机存储，请检查浏览器设置'); } });
  }
}
window.addEventListener('storage', event => {
  if (event.key === BACKUP_KEY) { void refreshBackupReminder(); return; }
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); load(); render(); notify('已同步其他页面的本机数据，请重新打开未保存的编辑');
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && lastDay !== today()) { lastDay = today(); render(); } });
setInterval(() => { if (lastDay !== today()) { lastDay = today(); render(); } }, 30000);
load(); render();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => { notify('离线缓存未准备好，当前仍可在线使用'); });
