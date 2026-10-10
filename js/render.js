// 서울 지도 렌더러: 낮/밤 조명, 구별 단계구분도, 에이전트(어르신) 점과 이동 연출
import { u } from './stats.js';
import { S } from './engine.js';

// 순차 색상 (주황 단일 색상, 연 → 진)
const RAMP = ['#fde7dc', '#f9c3a8', '#f39a73', '#eb6834', '#c44d1f', '#8f3410'];
export const STATE_COLORS = {
  robust: '#8a9099', frail: '#199e70', care: '#3987e5', unmet: '#e34948', hosp: '#d55181', inst: '#9085e9',
};

function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mixRGB(a, b, t) { return a.map((v, k) => Math.round(v + (b[k] - v) * t)); }
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

export function rampColor(t) {
  t = Math.max(0, Math.min(1, t));
  const x = t * (RAMP.length - 1);
  const k = Math.min(RAMP.length - 2, Math.floor(x));
  return mixRGB(hex(RAMP[k]), hex(RAMP[k + 1]), x - k);
}
export const RAMP_STOPS = RAMP;

// 시각(0~24) → 햇빛 세기 0(밤)~1(한낮). 일출 6시, 일몰 19시, 전후 1시간 박명
export function daylight(h) {
  const rise = 6, set = 19;
  if (h <= rise - 1 || h >= set + 1) return 0;
  if (h < rise + 1) return (h - (rise - 1)) / 2 * 0.6;
  if (h > set - 1) return (set + 1 - h) / 2 * 0.6;
  return 0.6 + 0.4 * Math.sin(Math.PI * (h - (rise + 1)) / (set - rise - 2));
}

const SKY_NIGHT = hex('#060a16'), SKY_TWILIGHT = hex('#3a2c4f'), SKY_DAY = hex('#dfe6ec');
const LAND_NIGHT = hex('#141a2b'), LAND_DAY = hex('#f4f2ec');

export class MapView {
  constructor(canvas, geo, districts) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.d = districts;
    this.G = districts.length;
    // 구 이름으로 GeoJSON 매칭
    this.polys = districts.map((r) => {
      const f = geo.features.find((f) => f.properties.name === r.gu);
      if (!f) throw new Error(`지도에서 '${r.gu}'를 찾을 수 없습니다`);
      return f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const mp of this.polys) for (const poly of mp) for (const [x, y] of poly[0]) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    this.bbox = { x0, y0, x1, y1, kx: Math.cos((37.55 * Math.PI) / 180) };
    this.centroids = this.polys.map((mp) => centroid(mp[0][0]));
    this.hx = new Float32Array(0); this.hy = new Float32Array(0); this.assigned = 0;
    this._facilities();
  }

  // 구별 시설 위치 (표시용, 결정적 난수)
  _facilities() {
    this.fac = this.d.map((r, g) => {
      const pt = (k) => this._randomPoint(g, 7000 + g * 50 + k);
      const nClinic = Math.max(2, Math.min(8, Math.round(r.clinics / 60)));
      return {
        clinics: Array.from({ length: nClinic }, (_, k) => pt(k)),
        hospital: pt(20), inst: pt(21), center: pt(22),
      };
    });
  }

  _randomPoint(g, id) {
    const { x0, y0, x1, y1 } = this.bbox;
    const mp = this.polys[g];
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const [x, y] of mp[0][0]) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
    for (let k = 0; k < 60; k++) {
      const x = bx0 + (bx1 - bx0) * u(1234, id, k, 41);
      const y = by0 + (by1 - by0) * u(1234, id, k, 42);
      if (mp.some((poly) => pip(x, y, poly[0]))) return [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)];
    }
    const c = this.centroids[g];
    return [(c[0] - x0) / (x1 - x0), (c[1] - y0) / (y1 - y0)];
  }

  // 새 에이전트 집 위치 배정 (지도상 해당 구 내부 무작위 점)
  syncAgents(sim) {
    if (this.hx.length < sim.cap) {
      const hx = new Float32Array(sim.cap), hy = new Float32Array(sim.cap);
      hx.set(this.hx.subarray(0, this.assigned)); hy.set(this.hy.subarray(0, this.assigned));
      this.hx = hx; this.hy = hy;
    }
    for (let i = this.assigned; i < sim.n; i++) {
      const [x, y] = this._randomPoint(sim.gu[i], i);
      this.hx[i] = x; this.hy[i] = y;
    }
    this.assigned = sim.n;
  }

  resetAgents() { this.assigned = 0; }

  // 동 경계 (2SFCA 동별 접근성 표시용). keys[i] = '구|동'
  setDongs(dongGeo, guGeo) {
    const guByCode = Object.fromEntries(guGeo.features.map((f) => [f.properties.code, f.properties.name]));
    this.dongs = dongGeo.features.map((f) => ({
      key: `${guByCode[f.properties.code.slice(0, 5)]}|${f.properties.name}`,
      gu: guByCode[f.properties.code.slice(0, 5)], name: f.properties.name,
      rings: f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat(),
    }));
    if (this.w) this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { x0, y0, x1, y1, kx } = this.bbox;
    const gw = (x1 - x0) * kx, gh = y1 - y0;
    const pad = 14;
    const s = Math.min((w - pad * 2) / gw, (h - pad * 2 - 10) / gh);
    this.W = (x1 - x0) * kx * s; this.H = (y1 - y0) * s;
    this.ox = (w - this.W) / 2; this.oy = (h - this.H) / 2 + 6;
    this.w = w; this.h = h;
    this.paths = this.polys.map((mp) => {
      const path = new Path2D();
      for (const poly of mp) for (const ring of poly) {
        ring.forEach(([x, y], k) => {
          const [px, py] = this.projLL(x, y);
          k ? path.lineTo(px, py) : path.moveTo(px, py);
        });
        path.closePath();
      }
      return path;
    });
    this.dongPaths = this.dongs?.map((d) => {
      const path = new Path2D();
      for (const ring of d.rings) {
        ring.forEach(([x, y], k) => {
          const [px, py] = this.projLL(x, y);
          k ? path.lineTo(px, py) : path.moveTo(px, py);
        });
        path.closePath();
      }
      return path;
    });
  }

  hitTestDong(x, y) {
    if (!this.dongPaths) return -1;
    const dpr = window.devicePixelRatio || 1;
    return this.dongPaths.findIndex((p) => this.ctx.isPointInPath(p, x * dpr, y * dpr));
  }

  projLL(x, y) {
    const { x0, y0, x1, y1 } = this.bbox;
    return this.proj((x - x0) / (x1 - x0), (y - y0) / (y1 - y0));
  }
  proj(nx, ny) { return [this.ox + nx * this.W, this.oy + (1 - ny) * this.H]; }

  hitTest(x, y) {
    if (!this.paths) return -1;
    for (let g = 0; g < this.G; g++) if (this.ctx.isPointInPath(this.paths[g], x * (window.devicePixelRatio || 1), y * (window.devicePixelRatio || 1))) return g;
    return -1;
  }

  /**
   * @param sim     Simulation
   * @param values  구별 값 (0~1로 정규화된 단계구분 값)
   * @param hover   강조할 구 인덱스
   * @param dong    { values: 동별 0~1 (NaN = 자료 없음), hover: 강조할 동 인덱스 } — 있으면 구 대신 동을 채색
   */
  draw(sim, values, hover = -1, dong = null) {
    const ctx = this.ctx, hour = sim.hour + (this.frac ?? 0);
    const dl = daylight(hour);
    const tw = Math.max(0, 1 - Math.abs(dl - 0.3) / 0.3) * (dl < 0.6 ? 1 : 0);
    // 하늘
    let sky = mixRGB(SKY_NIGHT, SKY_DAY, dl);
    sky = mixRGB(sky, SKY_TWILIGHT, tw * 0.5);
    ctx.fillStyle = rgb(sky);
    ctx.fillRect(0, 0, this.w, this.h);

    // 구 채색: 낮에는 선명, 밤에는 어둡게
    const land = mixRGB(LAND_NIGHT, LAND_DAY, dl);
    const strength = 0.25 + 0.6 * dl;
    if (dong && this.dongPaths) {
      ctx.lineWidth = 0.4;
      ctx.strokeStyle = dl > 0.4 ? 'rgba(20,20,20,0.15)' : 'rgba(180,190,220,0.12)';
      this.dongPaths.forEach((path, i) => {
        const v = dong.values[i];
        ctx.fillStyle = rgb(Number.isFinite(v) ? mixRGB(land, rampColor(v), strength) : land);
        ctx.fill(path);
        ctx.stroke(path);
      });
    } else {
      for (let g = 0; g < this.G; g++) {
        ctx.fillStyle = rgb(mixRGB(land, rampColor(values[g]), strength));
        ctx.fill(this.paths[g]);
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = dl > 0.4 ? 'rgba(20,20,20,0.35)' : 'rgba(180,190,220,0.25)';
    for (let g = 0; g < this.G; g++) ctx.stroke(this.paths[g]);
    if (hover >= 0) {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = dl > 0.4 ? '#0b0b0b' : '#ffffff';
      ctx.stroke(this.paths[hover]);
    }
    if (dong?.hover >= 0 && this.dongPaths) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = dl > 0.4 ? '#0b0b0b' : '#ffffff';
      ctx.stroke(this.dongPaths[dong.hover]);
    }

    this._drawAgents(sim, hour, dl);
    this._drawLabels(dl);
    this._drawSun(hour, dl);
  }

  _drawAgents(sim, hour, dl) {
    const ctx = this.ctx;
    const n = sim.n, st = sim.state, sz = n > 15000 ? 1.6 : n > 6000 ? 2 : 2.6;
    const night = 1 - dl;
    const P = (nx, ny) => this.proj(nx, ny);
    const jitter = (i, k) => (u(99, i, k, 50) - 0.5) * 0.018;

    // 밤: 집 불빛 (가산 혼합)
    if (night > 0.05) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,200,110,${0.35 * night})`;
      for (let i = 0; i < n; i++) {
        const s = st[i];
        if (s > S.CARE) continue;
        // 늦은 밤엔 일부만 불이 켜져 있음
        if (hour >= 23 || hour < 5) { if (u(7, i, sim.day, 51) > 0.25) continue; }
        const [x, y] = P(this.hx[i], this.hy[i]);
        ctx.fillRect(x - sz * 0.6, y - sz * 0.6, sz * 1.4, sz * 1.4);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    const alpha = 0.35 + 0.65 * dl;
    const byColor = { robust: [], frail: [], care: [], unmet: [], hosp: [], inst: [] };
    const moving = []; // [x, y, kind]
    for (let i = 0; i < n; i++) {
      const s = st[i];
      if (s === S.DEAD) {
        if (sim.event[i] === 2 && hour < 20) moving.push([...P(this.hx[i], this.hy[i]), 'death', 1 - hour / 20]);
        continue;
      }
      const g = sim.gu[i], f = this.fac[g];
      if (s === S.HOSP) {
        // 오늘 입원 → 시간대에 맞춰 집에서 병원으로 이송
        if (sim.event[i] === 1) {
          const h0 = 7 + (i % 13);
          const t = Math.max(0, Math.min(1, hour - h0));
          if (t <= 0) { byColor.unmet.push(P(this.hx[i], this.hy[i])); continue; }
          if (t < 1) { moving.push([...P(lerp(this.hx[i], f.hospital[0], t), lerp(this.hy[i], f.hospital[1], t)), 'amb', 1]); continue; }
        }
        byColor.hosp.push(P(f.hospital[0] + jitter(i, 0) * 0.6, f.hospital[1] + jitter(i, 1) * 0.6));
        continue;
      }
      if (s === S.INST) {
        byColor.inst.push(P(f.inst[0] + jitter(i, 0) * 0.8, f.inst[1] + jitter(i, 1) * 0.8));
        continue;
      }
      let nx = this.hx[i], ny = this.hy[i];
      const v = sim.visit[i];
      if (v === 1 || v === 3) {
        // 외래: 9~11시 출발, 14~16시 귀가 (개인별 시차)
        const c = f.clinics[i % f.clinics.length];
        const off = (i % 5) * 0.4;
        const go = clamp01((hour - 9 - off) / 1.2), back = clamp01((hour - (v === 3 ? 11 : 14) - off) / 1.2);
        const t = go - back;
        nx = lerp(nx, c[0], t); ny = lerp(ny, c[1], t);
      } else if (v === 2) {
        // 방문진료팀: 거점 → 집 → 거점
        const off = (i % 6) * 0.7;
        const go = clamp01((hour - 9 - off) / 1), back = clamp01((hour - 11 - off) / 1);
        if (go > 0 && go < 1) moving.push([...P(lerp(f.center[0], nx, go), lerp(f.center[1], ny, go)), 'team', 1]);
        if (back > 0 && back < 1) moving.push([...P(lerp(nx, f.center[0], back), lerp(ny, f.center[1], back)), 'team', 1]);
        if (go >= 1 && back <= 0) moving.push([...P(nx, ny), 'teamhere', 1]);
      }
      const key = s === S.ROBUST ? 'robust' : s === S.FRAIL ? 'frail' : sim.unmetCare[i] > 0 ? 'unmet' : 'care';
      byColor[key].push(P(nx, ny));
    }

    ctx.globalAlpha = alpha;
    for (const [key, pts] of Object.entries(byColor)) {
      ctx.fillStyle = STATE_COLORS[key];
      const r = key === 'robust' ? sz * 0.8 : sz;
      for (const [x, y] of pts) ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
    ctx.globalAlpha = 1;

    for (const [x, y, kind, a] of moving) {
      if (kind === 'amb') {
        ctx.fillStyle = '#ff4d4d';
        ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,77,77,0.5)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
      } else if (kind === 'team') {
        ctx.fillStyle = '#16c7c7';
        ctx.fillRect(x - 3, y - 1, 6, 2); ctx.fillRect(x - 1, y - 3, 2, 6);
      } else if (kind === 'teamhere') {
        ctx.strokeStyle = '#16c7c7'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.stroke();
      } else if (kind === 'death') {
        ctx.strokeStyle = `rgba(200,200,200,${0.7 * a})`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  _drawLabels(dl) {
    const ctx = this.ctx;
    ctx.font = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = dl > 0.4 ? 'rgba(11,11,11,0.75)' : 'rgba(230,232,240,0.7)';
    for (let g = 0; g < this.G; g++) {
      const [x, y] = this.projLL(...this.centroids[g]);
      ctx.fillText(this.d[g].gu.replace(/구$/, ''), x, y);
    }
  }

  _drawSun(hour, dl) {
    const ctx = this.ctx;
    const cx = this.w - 40, cy = 34, R = 24;
    ctx.strokeStyle = dl > 0.4 ? 'rgba(11,11,11,0.25)' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI, 0); ctx.stroke();
    const isDay = hour >= 6 && hour < 19;
    const t = isDay ? (hour - 6) / 13 : ((hour + 24 - 19) % 24) / 11;
    const a = Math.PI + t * Math.PI;
    const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
    if (isDay) {
      ctx.fillStyle = '#f5b301';
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = '#e8ecf5';
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgb(mixRGB(SKY_NIGHT, SKY_DAY, dl));
      ctx.beginPath(); ctx.arc(x + 2, y - 1.5, 3.8, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function pip(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}
