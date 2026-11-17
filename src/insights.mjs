import { costTrend, forecastCost, stats, today } from './domain.mjs';

const money = cents => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
const stamp = at => at.replace('T', ' ');

export function trendDetail(point) {
  return `${stamp(point.at)} · 累计 ${point.total} 次 · 重算成本 ¥${money(point.cost)} / 次`;
}

function trendChart(points) {
  const first = points[0], last = points.at(-1);
  const top = first.cost, bottom = last.cost;
  const left = Math.min(152, Math.max(75, (`¥${money(top)}`).length * 8 + 8));
  const right = 344, yTop = 18, yBottom = 132;
  const start = Date.parse(`${first.at}Z`), end = Date.parse(`${last.at}Z`);
  const position = point => {
    const x = start === end ? (left + right) / 2 : left + (Date.parse(`${point.at}Z`) - start) / (end - start) * (right - left);
    const y = top === bottom ? yTop : yTop + (top - point.cost) / (top - bottom) * (yBottom - yTop);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  };
  // 大量记录只简化绘图；滑块仍能逐条查看全部真实记录。
  const sampled = points.length <= 60 ? points : Array.from({ length: 60 }, (_, i) => points[Math.round(i * (points.length - 1) / 59)]);
  const coordinates = sampled.map(position);
  const markers = sampled.map((point, i) => {
    const [cx, cy] = coordinates[i].split(',');
    return `<circle cx="${cx}" cy="${cy}" r="3"><title>${trendDetail(point)}</title></circle>`;
  }).join('');
  return `<svg class="trend-chart" viewBox="0 0 360 150" role="img" aria-label="重算单次成本趋势，从 ${stamp(first.at)} 的 ${money(first.cost)} 元到 ${stamp(last.at)} 的 ${money(last.cost)} 元"><g class="trend-grid"><line x1="${left}" x2="${right}" y1="${yTop}" y2="${yTop}"/><line x1="${left}" x2="${right}" y1="${yBottom}" y2="${yBottom}"/></g><g class="trend-axis"><text x="0" y="${yTop + 4}">¥${money(top)}</text>${top === bottom ? '' : `<text x="0" y="${yBottom + 4}">¥${money(bottom)}</text>`}</g><polyline class="trend-line" points="${coordinates.join(' ')}"/>${markers}</svg><div class="trend-dates"><span>${first.at.slice(0, 10)}</span><span>${last.at.slice(0, 10)}</span></div>`;
}

export function renderInsights(card, range = 'month', date = today()) {
  const points = costTrend(card, range, date), s = stats(card, date);
  const trend = points.length ? `${trendChart(points)}<label class="trend-scrubber" for="trend-point">逐次查看 · ${points.length} 条记录<input type="range" id="trend-point" min="0" max="${points.length - 1}" value="${points.length - 1}" step="1" ${points.length < 2 ? 'disabled' : ''} aria-describedby="trend-detail"></label><output id="trend-detail" class="trend-detail" for="trend-point" aria-live="polite">${trendDetail(points.at(-1))}</output>` : '<p class="insight-empty">这个范围内还没有带日期的打卡记录。<br>打卡或补录后，就能看到成本变化。</p>';
  const forecast = s.status === 'expired' ? `<p class="insight-empty">这张卡已到期，${s.cost === null ? '尚无到场记录。' : `最终单次成本为 ¥${money(s.cost)} / 次。`}<br>仍可补录有效期内的记录，结果会随之更新。</p>` : `<p class="insight-description">${s.status === 'upcoming' ? '从生效日起' : '从今天起'}，按剩余 ${s.daysLeft} 天估算</p><div class="forecast-grid">${[2, 3, 4].map(weekly => {
    const f = forecastCost(card, weekly, date);
    return `<div class="forecast-option"><h4>每周 ${weekly} 次</h4><strong>${f.cost === null ? '—' : `¥${money(f.cost)}`}</strong><span>预计到期成本 / 次</span><p>预计再去 ${f.additional} 次<br>累计 ${f.total} 次</p><span class="forecast-status ${f.reachesTarget ? 'is-reachable' : ''}">${f.reachesTarget ? '预计可达标' : '预计未达标'}</span></div>`;
  }).join('')}</div><p class="insight-note">情景估算：保持当前卡费和已有次数，每周频率均匀折算到剩余有效期，新增次数向下取整；不代表实际到场或保证达标。</p>`;
  return `<section class="insight-section" aria-labelledby="trend-title"><div class="section-title"><h3 id="trend-title">每次成本，慢慢看见变化</h3></div><div class="trend-tabs" role="group" aria-label="成本趋势范围"><button type="button" data-trend-range="month" aria-pressed="${range === 'month'}">近 30 天</button><button type="button" data-trend-range="all" aria-pressed="${range === 'all'}">整个周期</button></div>${trend}<p class="insight-note">按当前卡费和累计次数重算，不代表当时显示的成本。${card.initial ? ` ${card.initial} 次无日期历史记录仅作为计算基数，不生成历史日期或曲线点。` : ''}</p></section><section class="insight-section" aria-labelledby="forecast-title"><div class="section-title"><h3 id="forecast-title">到期时，每次大约多少钱？</h3><span class="subtle">目标 ¥${money(card.target)}</span></div>${forecast}</section>`;
}
