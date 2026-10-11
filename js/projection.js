// 추계인구(구 × 연도) → 엔진 입력 (DOM 의존 없음: 화면·워커·배치 공용)
//
// 입력 행: { gu, year, age65, p65, ... }  (data/projection.csv)
//   age65 = 그 해 65세 인구 = 직전 1년 동안 65세가 된 사람 수
//   p65   = 그 해 65세 이상 인구
// 시뮬레이션 시작 시점은 baseYear 연앙(7월 1일)으로 본다.
//   entrants[gu][k] = 시작 후 k번째 해(0부터)에 65세가 되는 인원 = age65(baseYear + 1 + k)
//   pop65[gu][k]    = 시작 후 k년 시점의 65세 이상 추계 (검증·비교용)
// 추계와 등록인구는 집계 기준이 달라 수준이 조금 다르므로, 구별로
//   (입력 CSV의 pop65 ÷ 추계 baseYear의 p65) 비율을 곱해 등록인구 수준에 맞춘다.
export const PROJECTION_BASE_YEAR = 2026;

export function buildProjection(rows, districts, baseYear = PROJECTION_BASE_YEAR) {
  if (!rows || !rows.length || !districts) return null;
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.gu)) by.set(r.gu, new Map());
    by.get(r.gu).set(r.year, r);
  }
  const entrants = {}, pop65 = {};
  for (const d of districts) {
    const m = by.get(d.gu), b = m?.get(baseYear);
    if (!b || !(b.p65 > 0)) return null;
    const adj = d.pop65 / b.p65;
    const e = [], p = [];
    for (let y = baseYear; m.has(y); y++) p.push(m.get(y).p65 * adj);
    for (let y = baseYear + 1; m.has(y); y++) e.push(m.get(y).age65 * adj);
    if (!e.length) return null;
    entrants[d.gu] = e;
    pop65[d.gu] = p;
  }
  return { baseYear, entrants, pop65 };
}
