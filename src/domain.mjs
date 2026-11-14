// 日期使用本地日历字符串保存；跨日运算只对日期部分进行 UTC 日数计算。
const DAY = 86400000;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const integer = (value, min = 0, max = 1e12) => Number.isSafeInteger(value) && value >= min && value <= max;
const fail = message => { throw new Error(message); };

export function localDateTime(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export const today = () => localDateTime().slice(0, 10);

export function dayNumber(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('请选择有效日期');
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value || value < '1900-01-01' || value > '2200-12-31') fail('日期无效，请检查年月日');
  return stamp / DAY;
}

export const shiftDate = (value, days) => new Date((dayNumber(value) + days) * DAY).toISOString().slice(0, 10);

export function endDateForDuration(start, value, unit) {
  dayNumber(start);
  if (!integer(value, 1, 110000)) fail('时长须为大于 0 的整数');
  if (!['days', 'months', 'years'].includes(unit)) fail('请选择有效的时长单位');
  let end;
  if (unit === 'days') {
    end = shiftDate(start, value - 1);
  } else {
    const [year, month, day] = start.split('-').map(Number);
    const target = new Date(Date.UTC(year, month - 1 + value * (unit === 'years' ? 12 : 1), 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    // 生效日计入；目标月没有对应日期时，直接以该月最后一天到期。
    const boundary = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay));
    end = new Date(boundary - (day <= lastDay ? DAY : 0)).toISOString().slice(0, 10);
  }
  dayNumber(end);
  return end;
}

function validateTime(at) {
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(at)) fail('请选择有效的打卡时间');
  dayNumber(at.slice(0, 10));
}

export function moneyToCents(value) {
  const raw = String(value).trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) fail('金额须大于 0，最多保留两位小数');
  const [whole, fraction = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!integer(cents, 1)) fail('金额须大于 0，且不超过 100 亿元');
  return cents;
}

export function validateCard(input, now = localDateTime()) {
  if (!input || typeof input !== 'object' || !identifier(input.id)) fail('卡片标识无效');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 60) fail('卡片名称须为 1 至 60 个字符');
  if (!integer(input.amount, 1) || !integer(input.target, 1)) fail('卡费和目标单次成本须大于 0');
  if (!integer(input.initial, 0, 1000000)) fail('此前次数须为 0 至 1000000 的整数');
  if (dayNumber(input.end) < dayNumber(input.start)) fail('到期日期不能早于生效日期');
  if (!Array.isArray(input.visits) || input.visits.length > 50000) fail('打卡记录格式错误或记录过多');
  const seen = new Set();
  const visits = input.visits.map(value => {
    if (!value || !identifier(value.id) || seen.has(value.id)) fail('打卡记录标识无效或重复');
    seen.add(value.id);
    validateTime(value.at);
    const date = value.at.slice(0, 10);
    if (date < input.start || date > input.end) fail('打卡日期超出卡片有效期，请先调整日期或处理冲突记录');
    return { id: value.id, at: value.at };
  });
  return { id: input.id, name: input.name.trim(), amount: input.amount, target: input.target, start: input.start, end: input.end, initial: input.initial, visits };
}

export function validateState(input, now = localDateTime()) {
  if (!input || input.version !== 1 || !Array.isArray(input.cards) || input.cards.length > 1000) fail('这不是支持的「每次」备份文件');
  const cards = input.cards.map(value => validateCard(value, now));
  if (new Set(cards.map(value => value.id)).size !== cards.length) fail('存在重复的卡片标识');
  const sorted = [...cards].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= sorted[i - 1].end) fail('卡片有效期不能重叠，同一时间只能使用一张卡');
  }
  return { version: 1, cards };
}

export function addVisit(card, at, now = localDateTime(), id = crypto.randomUUID()) {
  validateTime(at);
  if (at > now) fail('不能记录未来的打卡时间');
  return validateCard({ ...card, visits: [...card.visits, { id, at }] }, now);
}

export function stats(card, date = today()) {
  const day = dayNumber(date);
  const monday = day - ((new Date(day * DAY).getUTCDay() + 6) % 7);
  const total = card.initial + card.visits.length;
  const required = Math.ceil(card.amount / card.target);
  const remaining = Math.max(0, required - total);
  const daysLeft = Math.max(0, dayNumber(card.end) - Math.max(day, dayNumber(card.start)) + 1);
  const status = date < card.start ? 'upcoming' : date > card.end ? 'expired' : 'active';
  const weekVisits = card.visits.filter(v => { const d = dayNumber(v.at.slice(0, 10)); return d >= monday && d < monday + 7; });
  return {
    total, required, remaining, daysLeft, status,
    cost: total ? card.amount / total : null,
    progress: Math.min(100, total / required * 100),
    week: weekVisits.length,
    month: card.visits.filter(v => v.at.startsWith(date.slice(0, 7))).length,
    days: new Set(card.visits.map(v => v.at.slice(0, 10))).size,
    weeklyNeeded: remaining === 0 ? 0 : daysLeft ? remaining * 7 / daysLeft : null,
    weekDates: Array.from({ length: 7 }, (_, i) => new Date((monday + i) * DAY).toISOString().slice(0, 10))
  };
}

export function parseBackup(raw, now = localDateTime()) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail('备份文件无法读取，请选择导出的 JSON 文件'); }
  const checked = validateState(parsed, now);
  if (checked.cards.some(card => card.visits.some(visit => visit.at > now))) fail('备份包含未来打卡，请核对手机时间和备份记录');
  return checked;
}

export function mergeBackup(local, incoming, now = localDateTime()) {
  const checkedLocal = validateState(local, now);
  const checkedIncoming = validateState(incoming, now);
  const cards = new Map(checkedLocal.cards.map(c => [c.id, c]));
  for (const card of checkedIncoming.cards) {
    const previous = cards.get(card.id);
    if (!previous) { cards.set(card.id, card); continue; }
    for (const key of ['name', 'amount', 'target', 'start', 'end', 'initial']) {
      if (previous[key] !== card[key]) fail('同一张卡的信息存在冲突，未导入。请先核对卡片信息');
    }
    const visits = new Map(previous.visits.map(v => [v.id, v]));
    for (const visit of card.visits) {
      if (visits.has(visit.id) && visits.get(visit.id).at !== visit.at) fail('打卡记录存在冲突，未导入');
      visits.set(visit.id, visit);
    }
    cards.set(card.id, { ...previous, visits: [...visits.values()] });
  }
  return validateState({ version: 1, cards: [...cards.values()] }, now);
}
