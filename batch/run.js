// 서버용 배치 실행기: 정책 시나리오 격자 × 반복 실행을 CPU 코어 수만큼 병렬 처리
//
// 사용법:
//   node batch/run.js --config batch/scenarios.example.json [--threads 32] [--reps 100] [--days 1825] [--out results/이름]
//
// 출력 (results/<이름>/):
//   summary.csv   시나리오 × 지표별 평균, 대응표본 차이, 95% 신뢰구간
//   raw.csv       반복 1회 = 1행 (R/Python으로 추가 분석용)
//   summary.json  위 내용 + 설정
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOne } from '../js/engine.js';
import { defaultParams, defaultPolicy, nullPolicy } from '../js/params.js';
import { parseCSV, parseTable, toCSV } from '../js/csv.js';
import { buildProjection } from '../js/projection.js';
import { meanCI } from '../js/stats.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (isMainThread) {
  main();
} else {
  // ---- 워커: 작업을 받아 실행하고 결과 반환 ----
  const { districts, projection } = workerData;
  parentPort.on('message', (task) => {
    if (task === null) { process.exit(0); }
    const policy = { ...task.policy, targets: task.policy.targets ? new Set(task.policy.targets) : null };
    const r = runOne(districts, task.params, policy, { seed: task.seed, scale: task.scale, days: task.days, years: Math.ceil(task.days / 365) + 1, projection });
    parentPort.postMessage({ id: task.id, result: r });
  });
}

function parseArgs() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1]?.startsWith('--') ? true : a[++i];
  return o;
}

// 격자 {a:[1,2], b:[x,y]} → [{a:1,b:x}, {a:1,b:y}, ...]
function expandGrid(grid) {
  return Object.entries(grid ?? {}).reduce(
    (acc, [k, vals]) => acc.flatMap((c) => vals.map((v) => ({ ...c, [k]: v }))),
    [{}],
  );
}

async function main() {
  const args = parseArgs();
  if (!args.config) { console.error('사용법: node batch/run.js --config <설정.json>'); process.exit(1); }
  const cfg = JSON.parse(readFileSync(resolve(args.config), 'utf8'));
  const days = Number(args.days ?? cfg.days ?? 365);
  const reps = Number(args.reps ?? cfg.reps ?? 20);
  const scale = Number(cfg.scale ?? 100);
  const seed = Number(cfg.seed ?? 2026);
  const threads = Math.max(1, Math.min(Number(args.threads ?? cpus().length), cpus().length * 2));
  const name = cfg.name ?? 'run';
  const outDir = resolve(args.out ?? join(ROOT, 'results', `${name}_${stamp()}`));

  const districts = parseCSV(readFileSync(resolve(ROOT, cfg.data ?? 'data/districts.csv'), 'utf8'));
  // 추계인구 파일이 있으면 65세 진입에 사용 (없으면 기존 고정 진입률)
  const projPath = resolve(ROOT, cfg.projection ?? 'data/projection.csv');
  const projection = existsSync(projPath) ? buildProjection(parseTable(readFileSync(projPath, 'utf8')), districts) : null;
  const params = { ...defaultParams(), ...(cfg.params ?? {}) };
  const allGu = districts.map((r) => r.gu);
  const targets = cfg.targets === 'all' || !cfg.targets ? allGu : cfg.targets;
  const unknown = targets.filter((g) => !allGu.includes(g));
  if (unknown.length) { console.error(`데이터에 없는 구: ${unknown.join(', ')}`); process.exit(1); }
  const policyBase = { ...defaultPolicy(), ...(cfg.policy ?? {}), targets };
  const scenarios = expandGrid(cfg.grid).map((g) => ({ grid: g, policy: { ...policyBase, ...g } }));
  const basePolicy = nullPolicy(policyBase);

  // 작업 목록: 반복마다 기준 1개 + 시나리오 N개 (같은 시드 → 공통난수)
  const tasks = [];
  for (let r = 0; r < reps; r++) {
    const s = seed + r * 7919;
    tasks.push({ id: tasks.length, scen: -1, rep: r, seed: s, policy: basePolicy });
    scenarios.forEach((sc, k) => tasks.push({ id: tasks.length, scen: k, rep: r, seed: s, policy: sc.policy }));
  }
  for (const t of tasks) Object.assign(t, { params, scale, days });

  console.log(`시나리오 ${scenarios.length}개 × 반복 ${reps}회 (+기준) = 작업 ${tasks.length}개`);
  console.log(`기간 ${days}일, 에이전트 1명 = ${scale}명, 스레드 ${threads}개`);
  console.log(`결과 폴더: ${outDir}\n`);

  const results = new Array(tasks.length);
  const t0 = Date.now();
  let next = 0, done = 0;
  const workers = [];
  await new Promise((resolveAll, reject) => {
    for (let w = 0; w < Math.min(threads, tasks.length); w++) {
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { districts, projection } });
      workers.push(worker);
      const feed = () => {
        if (next < tasks.length) {
          const t = tasks[next++];
          worker.postMessage({ ...t, policy: { ...t.policy, targets: [...t.policy.targets] } });
        } else worker.postMessage(null);
      };
      worker.on('message', ({ id, result }) => {
        results[id] = result;
        done++;
        if (done % Math.max(1, Math.floor(tasks.length / 40)) === 0 || done === tasks.length) {
          const el = (Date.now() - t0) / 1000;
          const eta = (el / done) * (tasks.length - done);
          process.stdout.write(`\r진행 ${done}/${tasks.length} (${((done / tasks.length) * 100).toFixed(0)}%) · 경과 ${fmtTime(el)} · 남은 시간 약 ${fmtTime(eta)}   `);
        }
        if (done === tasks.length) resolveAll();
        else feed();
      });
      worker.on('error', reject);
      feed();
    }
  });
  // 마지막 작업을 끝낸 워커는 종료 신호를 받지 못하므로 모두 직접 종료 (안 하면 프로세스가 끝나지 않음)
  await Promise.all(workers.map((w) => w.terminate()));
  console.log(`\n완료: ${fmtTime((Date.now() - t0) / 1000)}`);

  // ---- 집계 ----
  const base = [], byScen = scenarios.map(() => []);
  tasks.forEach((t, i) => (t.scen < 0 ? (base[t.rep] = results[i]) : (byScen[t.scen][t.rep] = results[i])));
  const metrics = Object.keys(base[0]).filter((k) => k !== 'cost');
  const years = days / 365;

  const summaryRows = [];
  const summary = scenarios.map((sc, k) => {
    const runs = byScen[k];
    const m = {};
    for (const key of metrics) {
      const b = meanCI(base.map((x) => x[key]));
      const p = meanCI(runs.map((x) => x[key]));
      const d = meanCI(runs.map((x, r) => x[key] - base[r][key]));
      m[key] = { base: b, policy: p, diff: d };
      summaryRows.push({
        ...sc.grid, metric: key,
        base_mean: r1(b.mean), policy_mean: r1(p.mean),
        diff_mean: r1(d.mean), diff_lo95: r1(d.lo), diff_hi95: r1(d.hi),
        pct_change: b.mean ? r3((d.mean / b.mean) * 100) : '',
        significant: d.lo > 0 || d.hi < 0 ? 1 : 0,
      });
    }
    const costTotal = runs[0].cost * years; // 백만원 (기간 전체)
    const avoided = -m.unmetCareDays.diff.mean;
    return {
      grid: sc.grid, metrics: m,
      cost_million_krw: r1(costTotal),
      cost_per_unmet_day_avoided_krw: avoided > 0 ? Math.round((costTotal * 1e6) / avoided) : null,
      cost_per_admission_avoided_million: -m.admissions.diff.mean > 0 ? r1(costTotal / -m.admissions.diff.mean) : null,
    };
  });

  const raw = [];
  tasks.forEach((t, i) => raw.push({ scenario: t.scen < 0 ? 'base' : t.scen, rep: t.rep, seed: t.seed, ...(t.scen < 0 ? {} : scenarios[t.scen].grid), ...results[i] }));
  const rawKeys = [...new Set(raw.flatMap((r) => Object.keys(r)))];
  const rawFilled = raw.map((r) => Object.fromEntries(rawKeys.map((k) => [k, r[k] ?? ''])));

  const costRows = summary.map((s) => ({ ...s.grid, cost_million_krw: s.cost_million_krw, cost_per_unmet_day_avoided_krw: s.cost_per_unmet_day_avoided_krw ?? '', cost_per_admission_avoided_million: s.cost_per_admission_avoided_million ?? '' }));

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'summary.csv'), '﻿' + toCSV(summaryRows));
  writeFileSync(join(outDir, 'cost.csv'), '﻿' + toCSV(costRows));
  writeFileSync(join(outDir, 'raw.csv'), '﻿' + toCSV(rawFilled));
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ config: { ...cfg, days, reps, scale, seed, threads }, params, policyBase, summary }, null, 1));
  console.log(`저장: summary.csv, cost.csv, raw.csv, summary.json → ${outDir}`);

  // 콘솔 요약: 시나리오별 돌봄 미충족 감소
  console.log('\n시나리오별 돌봄 미충족(누적 인·일) 변화 [95% CI]');
  for (const s of summary) {
    const d = s.metrics.unmetCareDays.diff;
    console.log(`  ${JSON.stringify(s.grid)}  ${fmtN(d.mean)} [${fmtN(d.lo)}, ${fmtN(d.hi)}]  비용 ${fmtN(s.cost_million_krw / 100)}억`);
  }
}

const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;
const fmtN = (x) => Math.round(x).toLocaleString('ko-KR');
function fmtTime(s) {
  if (!Number.isFinite(s)) return '-';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h ? `${h}시간 ${m}분` : m ? `${m}분 ${sec}초` : `${sec}초`;
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
