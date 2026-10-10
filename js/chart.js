// 시계열 꺾은선 차트 (기준 vs 정책, 십자선 툴팁)
export const SERIES = [
  { key: 'base', label: '정책 없음', color: 'var(--series-1)' },
  { key: 'policy', label: '정책 적용', color: 'var(--series-2)' },
];

export class LineChart {
  constructor(el, title, fmt = (v) => Math.round(v).toLocaleString('ko-KR')) {
    this.el = el;
    this.fmt = fmt;
    el.classList.add('chart');
    el.innerHTML = `<div class="chart-title">${title}</div><canvas></canvas><div class="chart-tip" hidden></div>`;
    this.cv = el.querySelector('canvas');
    this.tip = el.querySelector('.chart-tip');
    this.ctx = this.cv.getContext('2d');
    this.data = [[], []];
    this.hoverX = -1;
    this.cv.addEventListener('mousemove', (e) => { this.hoverX = e.offsetX; this.draw(); });
    this.cv.addEventListener('mouseleave', () => { this.hoverX = -1; this.tip.hidden = true; this.draw(); });
  }

  set(a, b) { this.data = [a, b]; }

  draw() {
    const cs = getComputedStyle(this.el);
    const col = (v) => cs.getPropertyValue(v).trim();
    const dpr = window.devicePixelRatio || 1;
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    if (this.cv.width !== Math.round(w * dpr)) { this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr); }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const [a, b] = this.data;
    const n = Math.max(a.length, b.length);
    if (n < 2) return;
    let max = 0;
    for (const s of this.data) for (const v of s) max = Math.max(max, v);
    max = niceMax(max);
    const L = 44, R = 8, T = 6, B = 18;
    const X = (i) => L + (i / (n - 1)) * (w - L - R);
    const Y = (v) => T + (1 - v / max) * (h - T - B);

    ctx.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    for (let k = 0; k <= 3; k++) {
      const v = (max * k) / 3, y = Y(v);
      ctx.strokeStyle = col('--grid'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
      ctx.fillStyle = col('--text-muted'); ctx.textAlign = 'right';
      ctx.fillText(compact(v), L - 6, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const step = Math.max(1, Math.ceil(n / 5 / 30) * 30);
    for (let d = 0; d < n; d += step) ctx.fillText(`${d}일`, X(d), h - B + 4);

    this.data.forEach((s, k) => {
      ctx.strokeStyle = col(k ? '--series-2' : '--series-1');
      ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath();
      s.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
      ctx.stroke();
    });

    if (this.hoverX >= L) {
      const i = Math.max(0, Math.min(n - 1, Math.round(((this.hoverX - L) / (w - L - R)) * (n - 1))));
      ctx.strokeStyle = col('--text-muted'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(i), T); ctx.lineTo(X(i), h - B); ctx.stroke();
      this.data.forEach((s, k) => {
        if (s[i] == null) return;
        ctx.fillStyle = col(k ? '--series-2' : '--series-1');
        ctx.strokeStyle = col('--surface'); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(X(i), Y(s[i]), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      });
      const diff = b[i] != null && a[i] != null ? b[i] - a[i] : null;
      this.tip.hidden = false;
      this.tip.innerHTML = `<b>${i}일차</b>` +
        `<div><i style="background:var(--series-1)"></i>정책 없음 <span>${this.fmt(a[i] ?? 0)}</span></div>` +
        `<div><i style="background:var(--series-2)"></i>정책 적용 <span>${this.fmt(b[i] ?? 0)}</span></div>` +
        (diff != null ? `<div class="muted">차이 <span>${diff > 0 ? '+' : ''}${this.fmt(diff)}</span></div>` : '');
      const left = X(i) > w / 2 ? X(i) - 150 : X(i) + 10;
      this.tip.style.left = `${left}px`;
    }
  }
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 3, 4, 5, 6, 8, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
function compact(v) {
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  return `${+v.toFixed(v < 10 ? 1 : 0)}`;
}
