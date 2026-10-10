// 화면 연결: 데이터 로드, 두 시나리오 실행, 지도·차트·컨트롤
import { Simulation, S, clinicUnits } from './engine.js';
import { PARAM_DEFS, POLICY_DEFS, EFFECT_DEFS, defaultParams, defaultPolicy, nullPolicy } from './params.js';
import { MapView, rampColor, RAMP_STOPS } from './render.js';
import { LineChart } from './chart.js';
import { parseCSV, toCSV } from './csv.js';

const $ = (id) => document.getElementById(id);
const fmt = (v) => Math.round(v).toLocaleString('ko-KR');
const START = new Date(2026, 0, 1);
const CANDIDATES = ['강북구', '강서구', '중랑구', '구로구', '금천구'];

const app = {
  districts: null, geo: null, params: defaultParams(), policy: defaultPolicy(),
  scale: 100, seed: 2026, sims: null, maps: null, playing: false, acc: 0, hover: -1,
  placeholder: false,
  dongGeo: null, dongAccess: null, hoverDong: -1, // 2SFCA 동별 접근성 (없으면 null)
};
app.policy.targets = new Set(CANDIDATES);

// ---- 데이터 ----
async function load() {
  const [csv, geo] = await Promise.all([
    fetch('data/districts.csv').then((r) => r.text()),
    fetch('data/seoul_gu.geojson').then((r) => r.json()),
  ]);
  app.geo = geo;
  await loadDongAccess();
  setDistricts(parseCSV(csv), 'data/districts.csv');
}

// 동 경계 + 동별 접근성 (scripts/build_districts.py 결과). 없으면 동별 보기만 끔
async function loadDongAccess() {
  try {
    const [dongGeo, text] = await Promise.all([
      fetch('data/seoul_dong.geojson').then((r) => (r.ok ? r.json() : Promise.reject())),
      fetch('data/access_2sfca_dong.csv').then((r) => (r.ok ? r.text() : Promise.reject())),
    ]);
    const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1);
    const rows = lines.map((l) => { const [gu, dong, pop, a] = l.split(','); return { gu, dong, pop: +pop, access: +a }; });
    const sorted = [...rows].sort((a, b) => a.access - b.access);
    sorted.forEach((r, i) => { r.rank = i + 1; });
    app.dongGeo = dongGeo;
    app.dongAccess = { byKey: new Map(rows.map((r) => [`${r.gu}|${r.dong}`, r])), n: rows.length };
  } catch {
    $('colorMode').querySelector('[value=access_dong]').disabled = true;
  }
}

function setDistricts(rows, source) {
  app.districts = rows;
  app.placeholder = rows.some((r) => r.is_placeholder === 1);
  $('dataBadge').hidden = !app.placeholder;
  $('dataStatus').innerHTML = `불러온 데이터: <b>${source}</b> · ${rows.length}개 구` +
    (app.placeholder ? ' · <span class="tag assumed">임시값 포함</span>' : '');
  renderDataTable();
  app.maps = [new MapView($('mapBase'), app.geo, rows), new MapView($('mapPolicy'), app.geo, rows)];
  if (app.dongGeo) app.maps.forEach((m) => m.setDongs(app.dongGeo, app.geo));
  renderTargets();
  resize();
  reset();
}

// ---- 시뮬레이션 ----
function reset() {
  const opt = { seed: app.seed, scale: app.scale, years: 6 };
  app.sims = [
    new Simulation(app.districts, app.params, nullPolicy(app.policy), opt),
    new Simulation(app.districts, app.params, app.policy, opt),
  ];
  app.maps.forEach((m) => m.resetAgents());
  app.sims.forEach((s, k) => app.maps[k].syncAgents(s));
  $('btnReset').classList.remove('attention');
  app.acc = 0;
  updateCharts(true);
  updateKPIs();
  updateCost();
}

function applyPolicyLive() {
  if (!app.sims) return;
  app.sims[0].setPolicy(nullPolicy(app.policy));
  app.sims[1].setPolicy(app.policy);
  updateCost();
}

function advance(hours) {
  let dayChanged = false;
  for (let k = 0; k < hours; k++) {
    const d0 = app.sims[0].day;
    app.sims.forEach((s) => s.stepHour());
    if (app.sims[0].day !== d0) dayChanged = true;
  }
  if (dayChanged) {
    app.sims.forEach((s, k) => app.maps[k].syncAgents(s));
    updateCharts();
    updateKPIs();
  }
}

// ---- 지도 ----
function guValues(sim, mode) {
  const g = sim.gu_, out = new Float64Array(sim.G);
  for (let k = 0; k < sim.G; k++) {
    if (mode === 'unmet') out[k] = g.care[k] ? g.unmet[k] / g.care[k] : 0;
    else if (mode === 'medgap') out[k] = g.alive[k] ? g.medGap[k] / g.alive[k] : 0;
    else if (mode === 'care') out[k] = g.alive[k] ? g.care[k] / g.alive[k] : 0;
    else out[k] = g.opDemand[k] ? g.opUnmet[k] / g.opDemand[k] : 0;
  }
  return out;
}

const DOMAIN = { unmet: 0.6, medgap: 0.3, care: 0.2, opunmet: 0.5 };

// 구별 의료 접근성: 65세 이상 1만 명당 의원 환산 기관 수 (엔진의 외래 용량과 같은 식 → 가중치 변경이 바로 반영)
const guAccess = () => app.districts.map((r) => (clinicUnits(r, app.params) / r.pop65) * 1e4);

// 접근성은 낮을수록 나쁨 → 색을 뒤집고(낮을수록 진하게), 값 차이가 수십 배라 로그 척도
function accessScale(values) {
  const ok = values.filter((v) => v > 0);
  const lo = Math.min(...ok), hi = Math.max(...ok);
  const t = (v) => (v > 0 ? 1 - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1) : NaN);
  const legend = `높음 ${fmt1(hi)} <span class="bar" style="background:linear-gradient(90deg,${RAMP_STOPS.join(',')})"></span> ${fmt1(lo)} 낮음 <span class="unit">(65세+ 1만 명당 의원 환산)</span>`;
  return { t, legend };
}
const fmt1 = (v) => (v >= 100 ? Math.round(v).toLocaleString('ko-KR') : v.toFixed(1));

function dongValues() {
  const vals = app.maps[0].dongs.map((d) => app.dongAccess.byKey.get(d.key)?.access ?? NaN);
  const { t, legend } = accessScale(vals);
  return { values: vals.map(t), legend };
}

function drawMaps() {
  const mode = $('colorMode').value;
  const frac = app.acc % 1;
  let v, dong = null, legend;
  if (mode === 'access') {
    const s = accessScale(guAccess());
    v = guAccess().map(s.t);
    legend = s.legend;
  } else if (mode === 'access_dong' && app.dongAccess) {
    const d = dongValues();
    dong = { values: d.values, hover: app.hoverDong };
    legend = d.legend + ' · 동별 값은 기본 가중치 기준';
  }
  app.sims.forEach((sim, k) => {
    app.maps[k].frac = frac;
    app.maps[k].draw(sim, v ?? guValues(sim, mode).map((x) => x / DOMAIN[mode]), dong ? -1 : app.hover, dong);
  });
  $('rampLegend').innerHTML = legend ??
    `0% <span class="bar" style="background:linear-gradient(90deg,${RAMP_STOPS.join(',')})"></span> ${Math.round(DOMAIN[mode] * 100)}%+`;
  const sim = app.sims[0];
  const date = new Date(START.getTime() + sim.day * 86400000);
  $('clockDate').textContent = `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 · ${sim.day}일차`;
  $('clockTime').textContent = `${String(sim.hour).padStart(2, '0')}:00`;
}

function resize() {
  app.maps?.forEach((m) => m.resize());
  charts.forEach((c) => c.draw());
}

function showTip(e, k) {
  const rect = e.target.getBoundingClientRect();
  const g = app.maps[k].hitTest(e.clientX - rect.left, e.clientY - rect.top);
  app.hover = g;
  const tip = $('mapTip');
  const mode = $('colorMode').value;
  if (mode === 'access_dong' && app.dongAccess) return showDongTip(e, k, rect, tip);
  if (g < 0) { tip.hidden = true; return; }
  const sc = app.scale;
  const rows = app.sims.map((s) => {
    const x = s.gu_;
    return [x.alive[g] * sc, x.care[g] * sc, x.unmet[g] * sc, x.medGap[g] * sc, x.adm[g] * sc];
  });
  const lab = ['65세 이상', '돌봄필요 (재가)', '돌봄 미충족', '의료 공백', '오늘 입원'];
  let access = '';
  if (mode === 'access') {
    const a = guAccess(), rank = [...a].sort((x, y) => x - y).indexOf(a[g]) + 1;
    access = `<p class="tip-access">의료 접근성 <b>${fmt1(a[g])}</b> · 낮은 순 ${rank}/${a.length}위<br>` +
      `<span class="unit">구 안의 기관 ${fmt(app.districts[g].clinics ?? 0)}곳</span></p>`;
  }
  tip.innerHTML = `<b>${app.districts[g].gu}</b>${access}<table><tr><th></th><th>정책 없음</th><th>정책 적용</th></tr>` +
    lab.map((l, j) => `<tr><td>${l}</td><td>${fmt(rows[0][j])}</td><td>${fmt(rows[1][j])}</td></tr>`).join('') + '</table>';
  placeTip(e, tip);
}

function showDongTip(e, k, rect, tip) {
  const i = app.maps[k].hitTestDong(e.clientX - rect.left, e.clientY - rect.top);
  app.hoverDong = i;
  const d = i >= 0 ? app.maps[k].dongs[i] : null;
  if (!d) { tip.hidden = true; return; }
  const r = app.dongAccess.byKey.get(d.key);
  tip.innerHTML = `<b>${d.gu} ${d.name}</b>` + (r
    ? `<p class="tip-access">의료 접근성 <b>${fmt1(r.access)}</b> · 낮은 순 ${r.rank}/${app.dongAccess.n}위<br>` +
      `<span class="unit">65세 이상 추정 ${fmt(r.pop)}명 · 65세+ 1만 명당 의원 환산 기관 수</span></p>`
    : '<p class="tip-access"><span class="unit">자료 없음</span></p>');
  placeTip(e, tip);
}

function placeTip(e, tip) {
  const box = document.querySelector('.maps').getBoundingClientRect();
  tip.hidden = false;
  let left = e.clientX - box.left + 14;
  if (left + 260 > box.width) left = e.clientX - box.left - 270;
  tip.style.left = `${left}px`;
  tip.style.top = `${e.clientY - box.top + 14}px`;
}

// ---- 차트 / KPI ----
const charts = [];
let chartTick = 0;
function initCharts() {
  const sc = () => app.scale;
  const defs = [
    ['chUnmet', '돌봄 미충족 인원 (일별)', (h) => h.unmetCare * sc()],
    ['chMedGap', '의료 공백 인원 (일별)', (h) => h.medGap * sc()],
    ['chAdm', '누적 입원', (h) => h.cum.admissions * sc()],
    ['chDeaths', '누적 사망', (h) => h.cum.deaths * sc()],
  ];
  for (const [id, title, get] of defs) {
    const c = new LineChart($(id), title);
    c.get = get;
    charts.push(c);
  }
}

function updateCharts(force = false) {
  const now = performance.now();
  if (!force && now - chartTick < 200) return;
  chartTick = now;
  for (const c of charts) {
    c.set(app.sims[0].history.map(c.get), app.sims[1].history.map(c.get));
    c.draw();
  }
}

function updateKPIs() {
  const sc = app.scale;
  const [a, b] = app.sims.map((s) => s.cum);
  const [ha, hb] = app.sims.map((s) => s.history[s.history.length - 1]);
  const items = [
    ['돌봄 미충족 (누적 인·일)', a.unmetCareDays, b.unmetCareDays],
    ['의료 공백 (누적 인·일)', a.medGapDays, b.medGapDays],
    ['누적 입원', a.admissions, b.admissions],
    ['누적 사망', a.deaths, b.deaths],
    ['현재 시설 입소', ha.states[S.INST], hb.states[S.INST]],
  ];
  $('kpis').innerHTML = items.map(([label, x, y]) => {
    const d = x ? (y - x) / x : 0;
    const cls = d < -0.0005 ? 'good' : d > 0.0005 ? 'bad' : '';
    return `<div class="kpi"><div class="label">${label}</div>
      <div class="value">${fmt(y * sc)}</div>
      <div class="sub">정책 없음 ${fmt(x * sc)} · <span class="${cls}">${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}%</span></div></div>`;
  }).join('');
}

function updateCost() {
  const c = app.sims[1].policyCost();
  const f = (v) => `${(v / 100).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}억 원`;
  $('costBox').innerHTML = `<div><span>방문진료팀</span><span>${f(c.visit)}</span></div>
    <div><span>재가돌봄 확충</span><span>${f(c.homecare)}</span></div>
    <div><span>안부·사회참여 연계</span><span>${f(c.outreach)}</span></div>
    <div><span>시설 정원 확충</span><span>${f(c.ltc)}</span></div>
    <div class="total"><span>합계 / 년</span><span>${f(c.total)}</span></div>`;
}

// ---- 컨트롤 ----
function renderPolicyControls() {
  $('policyControls').innerHTML = POLICY_DEFS.map((d) => {
    const isBool = d.max === 1 && d.step === 1;
    const v = app.policy[d.key];
    return `<div class="ctl"><div class="ctl-head"><span>${d.label}</span><b id="pv-${d.key}">${isBool ? (v ? '켜짐' : '꺼짐') : `${v} ${d.unit}`}</b></div>
      <input type="range" data-key="${d.key}" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}">
      ${d.note ? `<div class="note">${d.note}</div>` : ''}</div>`;
  }).join('');
  $('policyControls').querySelectorAll('input').forEach((el) => el.addEventListener('input', () => {
    const d = POLICY_DEFS.find((x) => x.key === el.dataset.key);
    const v = Number(el.value);
    app.policy[d.key] = v;
    $(`pv-${d.key}`).textContent = d.max === 1 && d.step === 1 ? (v ? '켜짐' : '꺼짐') : `${v} ${d.unit}`;
    applyPolicyLive();
  }));
}

function renderTargets() {
  const box = $('targetChips');
  box.innerHTML = app.districts.map((r) => `<button class="chip ${app.policy.targets.has(r.gu) ? 'on' : ''}" data-gu="${r.gu}">${r.gu}</button>`).join('');
  box.querySelectorAll('.chip').forEach((el) => el.addEventListener('click', () => {
    const t = app.policy.targets;
    t.has(el.dataset.gu) ? t.delete(el.dataset.gu) : t.add(el.dataset.gu);
    el.classList.toggle('on');
    applyPolicyLive();
  }));
}

function renderParamTable() {
  const groups = {};
  for (const d of PARAM_DEFS) (groups[d.group] ??= []).push(d);
  groups['정책 효과·비용'] = EFFECT_DEFS.map((d) => ({ ...d, isPolicy: true }));
  $('paramTable').innerHTML = Object.entries(groups).map(([g, defs]) => `<div class="pgroup"><h4>${g}</h4>` +
    defs.map((d) => `<div class="prow"><span>${d.label}${d.status === 'assumed' ? '<span class="tag assumed">가정</span>' : ''}<br><span class="unit">${d.unit}</span></span>
      <input type="number" step="any" data-key="${d.key}" data-policy="${d.isPolicy ? 1 : 0}" value="${d.isPolicy ? app.policy[d.key] : app.params[d.key]}">
      ${d.note ? `<span class="note">${d.note}</span>` : ''}</div>`).join('') + '</div>').join('');
  $('paramTable').querySelectorAll('input').forEach((el) => el.addEventListener('change', () => {
    const v = Number(el.value);
    if (!Number.isFinite(v)) return;
    if (el.dataset.policy === '1') { app.policy[el.dataset.key] = v; applyPolicyLive(); }
    else { app.params[el.dataset.key] = v; $('btnReset').classList.add('attention'); }
  }));
}

function renderDataTable() {
  const keys = Object.keys(app.districts[0]).filter((k) => k !== 'is_placeholder');
  $('dataTable').innerHTML = `<tr>${keys.map((k) => `<th>${k}</th>`).join('')}</tr>` +
    app.districts.map((r) => `<tr>${keys.map((k) => `<td>${typeof r[k] === 'number' ? fmt(r[k]) : r[k] ?? ''}</td>`).join('')}</tr>`).join('');
}

function bind() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${t.dataset.tab}`));
  }));
  $('btnPlay').addEventListener('click', () => {
    app.playing = !app.playing;
    $('btnPlay').textContent = app.playing ? '⏸ 일시정지' : '▶ 재생';
  });
  $('btnReset').addEventListener('click', reset);
  $('scale').addEventListener('change', (e) => { app.scale = Number(e.target.value); reset(); });
  $('seed').addEventListener('change', (e) => { app.seed = Number(e.target.value) || 1; reset(); });
  document.querySelectorAll('[data-targets]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.targets;
    app.policy.targets = new Set(k === 'all' ? app.districts.map((r) => r.gu) : k === 'none' ? [] : CANDIDATES);
    renderTargets();
    applyPolicyLive();
  }));
  $('csvFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const rows = parseCSV(await f.text());
      const unknown = rows.filter((r) => !app.geo.features.some((x) => x.properties.name === r.gu)).map((r) => r.gu);
      if (unknown.length) throw new Error(`지도에 없는 구 이름: ${unknown.join(', ')}`);
      setDistricts(rows, f.name);
    } catch (err) {
      $('dataStatus').innerHTML = `<span style="color:var(--bad)">불러오기 실패: ${err.message}</span>`;
    }
  });
  $('btnTemplate').addEventListener('click', () => {
    const blob = new Blob(['﻿' + toCSV(app.districts)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'districts.csv'; a.click();
  });
  [['mapBase', 0], ['mapPolicy', 1]].forEach(([id, k]) => {
    $(id).addEventListener('mousemove', (e) => showTip(e, k));
    $(id).addEventListener('mouseleave', () => { app.hover = -1; app.hoverDong = -1; $('mapTip').hidden = true; });
  });
  $('btnMC').addEventListener('click', runMonteCarlo);
  window.addEventListener('resize', resize);
}

// ---- 몬테카를로 ----
function runMonteCarlo() {
  const reps = Math.max(2, Number($('mcReps').value) || 20);
  const days = Math.max(30, Number($('mcDays').value) || 365);
  const scale = Number($('mcScale').value);
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  $('btnMC').disabled = true;
  $('mcProgress').textContent = '실행 중…';
  worker.onmessage = (e) => {
    if (e.data.type === 'progress') { $('mcProgress').textContent = `${e.data.done} / ${e.data.reps}회`; return; }
    const r = e.data.result;
    const labels = {
      unmetCareDays: '돌봄 미충족 (누적 인·일)', medGapDays: '의료 공백 (누적 인·일)', admissions: '누적 입원',
      deaths: '누적 사망', instEntries: '시설 신규 입소', careEnd: '기간 말 돌봄필요 인원', unmetEnd: '기간 말 돌봄 미충족 인원',
    };
    $('mcTable').innerHTML = `<tr><th>지표 (${e.data.days}일, ${e.data.reps}회 반복)</th><th>정책 없음</th><th>정책 적용</th><th>차이 (정책−기준)</th><th>95% 신뢰구간</th><th>변화율</th></tr>` +
      Object.entries(labels).map(([k, l]) => {
        const x = r[k];
        const sig = x.diff.lo > 0 || x.diff.hi < 0;
        const pct = x.base.mean ? (x.diff.mean / x.base.mean) * 100 : 0;
        return `<tr><td>${l}</td><td>${fmt(x.base.mean)}</td><td>${fmt(x.policy.mean)}</td>
          <td>${x.diff.mean > 0 ? '+' : ''}${fmt(x.diff.mean)}</td>
          <td>[${fmt(x.diff.lo)}, ${fmt(x.diff.hi)}]${sig ? ' *' : ''}</td><td>${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</td></tr>`;
      }).join('') + `<tr><td colspan="6" class="hint">* 95% 신뢰구간이 0을 포함하지 않음 (통계적으로 유의한 차이)</td></tr>`;
    $('mcProgress').textContent = '완료';
    $('btnMC').disabled = false;
    worker.terminate();
  };
  worker.onerror = (err) => { $('mcProgress').textContent = `오류: ${err.message}`; $('btnMC').disabled = false; };
  const policy = { ...app.policy, targets: [...app.policy.targets] };
  worker.postMessage({
    districts: app.districts, params: app.params, basePolicy: { ...nullPolicy(app.policy), targets: policy.targets },
    policy, reps, days, scale, seed: app.seed,
  });
}

// ---- 루프 ----
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (app.playing && app.sims) {
    const before = Math.floor(app.acc);
    app.acc += dt * Number($('speed').value);
    const steps = Math.floor(app.acc) - before;
    if (steps > 0) advance(steps);
  }
  if (app.sims) drawMaps();
  requestAnimationFrame(frame);
}

// 콘솔 디버깅용
window.sim = { app, advance, drawMaps, reset };

renderPolicyControls();
renderParamTable();
initCharts();
bind();
load().then(() => requestAnimationFrame(frame)).catch((err) => {
  document.body.insertAdjacentHTML('afterbegin', `<p style="color:#d03b3b;padding:16px">데이터를 불러오지 못했습니다: ${err.message}. 로컬 서버로 열어주세요 (README 참고).</p>`);
});
