// 자치구 CSV 읽기/쓰기 (브라우저·Node 공용)
export const REQUIRED = ['gu', 'pop65', 'alone', 'clinics', 'homecare_fac', 'ltc_fac', 'community_fac'];

export function parseCSV(text) {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const head = lines[0].split(',').map((s) => s.trim());
  const miss = REQUIRED.filter((k) => !head.includes(k));
  if (miss.length) throw new Error(`필수 열이 없습니다: ${miss.join(', ')}`);
  return lines.slice(1).filter(Boolean).map((line) => {
    const cells = line.split(',');
    const row = {};
    head.forEach((k, j) => {
      const v = (cells[j] ?? '').trim();
      row[k] = k === 'gu' ? v : v === '' ? undefined : Number(v);
    });
    return row;
  });
}

export function toCSV(rows) {
  const keys = Object.keys(rows[0]);
  const esc = (v) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v ?? '');
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n');
}

// 필수 열 검사 없는 일반 CSV 파서 (추계인구 등). gu 열만 문자열, 나머지는 숫자.
export function parseTable(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const head = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).filter(Boolean).map((line) => {
    const cells = line.split(',');
    const row = {};
    head.forEach((k, j) => {
      const v = (cells[j] ?? '').trim();
      row[k] = k === 'gu' ? v : v === '' ? undefined : Number(v);
    });
    return row;
  });
}
