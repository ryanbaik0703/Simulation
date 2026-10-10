// 통계 유틸리티: 난수, 확률 변환, 로지스틱 보정, 대기행렬, 신뢰구간

// ---- 난수 ----------------------------------------------------------------

function mix(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

// 카운터 기반 난수 u(seed, 개인, 날짜, 용도) ∈ [0,1).
// 같은 (개인, 날짜, 용도)는 항상 같은 값을 주므로, 기준/정책 시나리오가
// 동일한 난수를 공유한다(공통난수법, Common Random Numbers) → 두 시나리오의
// 차이는 정책 효과만 반영하고 우연에 의한 차이는 상쇄된다.
export function u(seed, id, day, stream) {
  let h = mix(seed ^ 0x9e3779b9);
  h = mix(h ^ id);
  h = mix(h ^ Math.imul(day + 1, 0x27d4eb2d));
  h = mix(h ^ Math.imul(stream + 1, 0x165667b1));
  return h / 4294967296;
}

// 순차 난수 (인구 생성용)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 확률적 반올림: 2.3 → 30% 확률로 3, 70% 확률로 2 (기댓값 보존)
export function stochRound(x, r) {
  const f = Math.floor(x);
  return f + (r < x - f ? 1 : 0);
}

// ---- 확률 변환 -------------------------------------------------------------

// 연간 확률 → 일간 확률 (일정한 위험률 가정: 1-(1-p)^(1/365))
export function annualToDaily(p) {
  return 1 - Math.pow(1 - p, 1 / 365);
}

// 기간(일) 동안 발생확률 → 일간 확률
export function periodToDaily(p, days) {
  return 1 - Math.pow(1 - p, 1 / days);
}

export const logit = (p) => Math.log(p / (1 - p));
export const expit = (x) => 1 / (1 + Math.exp(-x));

// 로지스틱 모형으로 기준확률 p에 로그오즈 lo를 더한 확률
// p' = expit(logit(p) + Σ β·x),  β = ln(OR)
export function applyLogOdds(p, lo) {
  if (lo === 0) return p;
  return expit(logit(p) + lo);
}

// ---- 대기행렬 (M/M/c, Erlang C) ------------------------------------------

// λ: 도착률, μ: 서버 1개 처리율, c: 서버 수
// 반환: { rho: 가동률, pWait: 대기 확률, wq: 평균 대기시간(μ 단위) }
export function erlangC(lambda, mu, c) {
  c = Math.max(1, Math.round(c));
  const a = lambda / mu;
  const rho = a / c;
  if (rho >= 1) return { rho, pWait: 1, wq: Infinity };
  // 수치 안정성을 위해 점화식으로 Erlang B 계산 후 C로 변환
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  const pWait = b / (1 - rho + rho * b);
  return { rho, pWait, wq: pWait / (c * mu - lambda) };
}

// ---- 요약 통계 -------------------------------------------------------------

const T975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];

// 평균과 t분포 기반 95% 신뢰구간
export function meanCI(xs) {
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  if (n < 2) return { mean, lo: mean, hi: mean, sd: 0, n };
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const t = n - 1 <= 30 ? T975[n - 1] : 1.96;
  const half = (t * sd) / Math.sqrt(n);
  return { mean, lo: mean - half, hi: mean + half, sd, n };
}
