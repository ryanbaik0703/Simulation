// 모델 파라미터 정의.
// status: 'assumed' = 임시 가정값(문헌·데이터로 교체 필요), 'data' = 데이터에서 산출, 'calibrated' = 실측 목표에 맞춰 보정
// 확률은 별도 표기가 없으면 "75세, 동거, 비수급자" 기준의 연간 확률이며,
// 개인 특성은 로지스틱 모형의 오즈비(OR)로 보정한다.

export const PARAM_DEFS = [
  // ---- 건강상태 전이 (마르코프 연쇄) ----
  { key: 'p_robust_frail', group: '건강상태 전이', label: '건강 → 허약', unit: '연간 확률', value: 0.07, status: 'assumed',
    note: '노인 노쇠 발생률 문헌값으로 교체 (예: 한국노인노쇠코호트)' },
  { key: 'p_frail_robust', group: '건강상태 전이', label: '허약 → 건강 (회복)', unit: '연간 확률', value: 0.15, status: 'assumed', note: '' },
  { key: 'p_frail_care', group: '건강상태 전이', label: '허약 → 돌봄필요', unit: '연간 확률', value: 0.02, status: 'calibrated',
    note: '인정자 수가 "연령별 인정률 고정 × 추계인구" 전망을 5년간 ±3% 안에서 따르도록 보정 (기존 가정 0.07)' },
  { key: 'p_care_frail', group: '건강상태 전이', label: '돌봄필요 → 허약 (호전)', unit: '연간 확률', value: 0.05, status: 'assumed', note: '' },
  { key: 'p_care_inst', group: '건강상태 전이', label: '돌봄필요 → 시설입소', unit: '연간 확률', value: 0.05, status: 'assumed',
    note: '시설급여 이용 전환율로 보정' },

  // ---- 입원 ----
  { key: 'p_hosp_robust', group: '입원', label: '입원 (건강)', unit: '연간 확률', value: 0.07, status: 'assumed', note: '' },
  { key: 'p_hosp_frail', group: '입원', label: '입원 (허약)', unit: '연간 확률', value: 0.18, status: 'assumed', note: '' },
  { key: 'p_hosp_care', group: '입원', label: '입원 (돌봄필요)', unit: '연간 확률', value: 0.30, status: 'assumed', note: '' },
  { key: 'los_mean', group: '입원', label: '평균 재원일수', unit: '일', value: 11, status: 'assumed',
    note: '건강보험통계 65세 이상 평균 재원일수' },
  { key: 'p_downgrade_after_hosp', group: '입원', label: '퇴원 시 상태 악화', unit: '확률', value: 0.20, status: 'calibrated',
    note: '위 인정자 전망에 함께 맞춘 값 (기존 가정 0.25)' },
  { key: 'readmit_window', group: '입원', label: '재입원 고위험 기간', unit: '일', value: 30, status: 'assumed', note: '' },
  { key: 'or_readmit', group: '입원', label: '퇴원 직후 재입원 OR', unit: 'OR', value: 1.8, status: 'assumed', note: '' },

  // ---- 사망 ----
  { key: 'p_death_robust', group: '사망', label: '사망 (건강)', unit: '연간 확률', value: 0.006, status: 'assumed',
    note: '통계청 생명표 연령별 사망확률로 교체' },
  { key: 'p_death_frail', group: '사망', label: '사망 (허약)', unit: '연간 확률', value: 0.02, status: 'assumed', note: '' },
  { key: 'p_death_care', group: '사망', label: '사망 (돌봄필요)', unit: '연간 확률', value: 0.06, status: 'assumed', note: '' },
  { key: 'p_death_inst', group: '사망', label: '사망 (시설)', unit: '연간 확률', value: 0.10, status: 'assumed', note: '' },
  { key: 'p_death_per_stay', group: '사망', label: '입원 1회당 사망', unit: '확률', value: 0.03, status: 'assumed', note: '' },

  // ---- 개인 위험요인 (로지스틱 오즈비) ----
  { key: 'or_age', group: '위험요인 (OR)', label: '나이 1세 증가', unit: 'OR', value: 1.10, status: 'calibrated',
    note: '진행·사망에 적용. 65세 이상 인구가 추계인구 경로를 5년간 ±1% 안에서 따르도록 보정 (기존 가정 1.07)' },
  { key: 'or_alone', group: '위험요인 (OR)', label: '독거', unit: 'OR', value: 1.2, status: 'assumed', note: '건강 악화에 적용' },
  { key: 'or_isolated', group: '위험요인 (OR)', label: '사회적 고립 (독거+프로그램 미참여)', unit: 'OR', value: 1.35, status: 'assumed', note: '' },
  { key: 'or_poor', group: '위험요인 (OR)', label: '기초수급', unit: 'OR', value: 1.3, status: 'assumed', note: '악화·입원에 적용' },
  { key: 'or_unmet_care_hosp', group: '위험요인 (OR)', label: '돌봄 미충족 → 입원', unit: 'OR', value: 1.8, status: 'assumed', note: '' },
  { key: 'or_unmet_care_inst', group: '위험요인 (OR)', label: '돌봄 미충족 → 시설입소', unit: 'OR', value: 2.5, status: 'assumed', note: '' },
  { key: 'or_unmet_care_death', group: '위험요인 (OR)', label: '돌봄 미충족 → 사망', unit: 'OR', value: 1.3, status: 'assumed', note: '' },
  { key: 'or_unmet_med_hosp', group: '위험요인 (OR)', label: '의료 공백 → 입원', unit: 'OR', value: 1.6, status: 'assumed', note: '' },

  // ---- 의료 이용과 공급 용량 ----
  { key: 'visits_robust', group: '의료·돌봄 용량', label: '외래 이용 (건강)', unit: '회/년', value: 14, status: 'assumed',
    note: '건강보험통계 65세 이상 1인당 내원일수로 보정' },
  { key: 'visits_frail', group: '의료·돌봄 용량', label: '외래 이용 (허약)', unit: '회/년', value: 26, status: 'assumed', note: '' },
  { key: 'visits_care', group: '의료·돌봄 용량', label: '외래 이용 (돌봄필요, 동거)', unit: '회/년', value: 12, status: 'assumed',
    note: '거동 불편으로 외래 감소. 독거는 아래 비율만큼 추가 감소' },
  { key: 'care_alone_mobility', group: '의료·돌봄 용량', label: '독거 돌봄필요 노인의 외래 접근 비율', unit: '배', value: 0.5, status: 'assumed', note: '동행할 가족 부재' },
  { key: 'need_formal_family', group: '의료·돌봄 용량', label: '가족 동거 시 공식 돌봄 필요 비율', unit: '비율', value: 0.55, status: 'assumed',
    note: '독거는 전원 공식 돌봄 필요로 가정 · 장기요양 재가급여 이용률로 보정' },
  { key: 'clinic_cap', group: '의료·돌봄 용량', label: '의원 1곳 노인 진료 용량', unit: '명/일', value: 12, status: 'assumed',
    note: '병원 유형은 아래 가중치(의원 = 1)를 곱함. 데이터에 유형별 열이 없으면 clinics 합계 × 이 값' },
  { key: 'w_hospital', group: '의료·돌봄 용량', label: '외래 가중치: 병원', unit: '의원 대비 배', value: 4, status: 'assumed',
    note: '심평원 병원정보서비스의 기관별 의사 수(또는 외래 내원일수) 비율로 교체' },
  { key: 'w_general', group: '의료·돌봄 용량', label: '외래 가중치: 종합병원', unit: '의원 대비 배', value: 20, status: 'assumed',
    note: '종합병원은 구 경계를 넘어 이용됨 → cross_border와 함께 해석' },
  { key: 'w_ltch', group: '의료·돌봄 용량', label: '외래 가중치: 요양병원', unit: '의원 대비 배', value: 0.5, status: 'assumed',
    note: '주 기능이 장기 입원이라 외래 기여는 작음' },
  { key: 'cross_border', group: '의료·돌봄 용량', label: '타 구 이용으로 해소되는 초과수요', unit: '비율', value: 0.5, status: 'assumed',
    note: '데이터에 2SFCA 열(*_eff)이 있으면 평소의 구 경계 넘는 이용은 이미 반영됨 → 이 값은 용량이 찼을 때 더 멀리 가는 비율' },
  { key: 'med_gap_frail', group: '의료·돌봄 용량', label: '의료 공백 기준 (허약)', unit: '일', value: 90, status: 'assumed', note: '진료 없이 지난 일수' },
  { key: 'med_gap_care', group: '의료·돌봄 용량', label: '의료 공백 기준 (돌봄필요)', unit: '일', value: 45, status: 'assumed', note: '' },
  { key: 'homevisit_interval', group: '의료·돌봄 용량', label: '재택 환자 방문진료 주기', unit: '일', value: 30, status: 'assumed', note: '' },
  { key: 'base_visit_teams', group: '의료·돌봄 용량', label: '기존 방문진료팀 (구당)', unit: '팀', value: 1, status: 'assumed', note: '재택의료센터 현황으로 교체' },
  { key: 'team_visits_day', group: '의료·돌봄 용량', label: '방문진료팀 1팀 처리량', unit: '건/일', value: 6, status: 'assumed', note: '' },
  { key: 'homecare_clients', group: '의료·돌봄 용량', label: '재가시설 1곳 이용자', unit: '명', value: 60, status: 'assumed',
    note: '재가시설 현원 ÷ 시설 수로 교체' },
  { key: 'ltc_beds', group: '의료·돌봄 용량', label: '노인의료복지시설 1곳 정원', unit: '명', value: 60, status: 'assumed',
    note: '데이터에 ltc_capacity(구별 정원)가 있으면 이 값 대신 그것을 씀' },
  { key: 'community_members', group: '의료·돌봄 용량', label: '지역사회시설 1곳 참여자', unit: '명', value: 35, status: 'assumed', note: '' },

  // ---- 장기요양 인정률 (실측) : CSV에 a65~a95, rec65 열이 있을 때 초기 상태에 사용 ----
  { key: 'rec_rate_65', group: '장기요양 인정률 (실측)', label: '65~69세 인정률', unit: '비율', value: 0.0152, status: 'data',
    note: '건보공단 등급판정 현황(2026.8.31) 1~5등급+인지지원 ÷ 등록인구(2026 2분기), 서울' },
  { key: 'rec_rate_70', group: '장기요양 인정률 (실측)', label: '70~74세 인정률', unit: '비율', value: 0.0312, status: 'data', note: '' },
  { key: 'rec_rate_75', group: '장기요양 인정률 (실측)', label: '75~79세 인정률', unit: '비율', value: 0.0771, status: 'data', note: '' },
  { key: 'rec_rate_80', group: '장기요양 인정률 (실측)', label: '80~84세 인정률', unit: '비율', value: 0.1843, status: 'data', note: '' },
  { key: 'rec_rate_85', group: '장기요양 인정률 (실측)', label: '85세 이상 인정률', unit: '비율', value: 0.3364, status: 'data',
    note: '구별 차이는 CSV의 rec65(구별 인정자 수)로 보정' },

  // ---- 인구 동태 ----
  { key: 'entry_rate', group: '인구 동태', label: '65세 신규 진입 (65세 이상 인구 대비)', unit: '연간 비율', value: 0.065, status: 'assumed',
    note: 'data/projection.csv(추계인구)가 있으면 이 값 대신 연도별·구별 65세 도달 인구를 사용' },
];

export function defaultParams() {
  return Object.fromEntries(PARAM_DEFS.map((d) => [d.key, d.value]));
}

// ---- 정책 레버 ----
export const POLICY_DEFS = [
  { key: 'visit_teams', label: '방문진료팀 추가', unit: '팀/구', min: 0, max: 15, step: 1, value: 4,
    note: '재택 돌봄필요 노인 정기 방문진료 → 의료 공백 감소' },
  { key: 'homecare_expand', label: '재가돌봄 정원 확충', unit: '%', min: 0, max: 100, step: 5, value: 30,
    note: '방문요양·주야간보호 등 재가서비스 용량 증가' },
  { key: 'outreach', label: '독거노인 안부·사회참여 연계', unit: '% 대상', min: 0, max: 100, step: 5, value: 50,
    note: '고립 해소 → 허약 진행 위험 감소' },
  { key: 'ltc_expand', label: '노인의료복지시설 정원 확충', unit: '%', min: 0, max: 100, step: 5, value: 0, note: '' },
  { key: 'discharge_link', label: '퇴원 후 통합돌봄 연계', unit: 'on/off', min: 0, max: 1, step: 1, value: 1,
    note: '퇴원 직후 재입원·상태악화 위험 감소' },
  { key: 'priority_alone', label: '독거노인 서비스 우선 배정', unit: 'on/off', min: 0, max: 1, step: 1, value: 1, note: '' },
  { key: 'start_day', label: '정책 시작일', unit: '일차', min: 0, max: 365, step: 15, value: 30, note: '' },
];

// 정책 효과 크기 (정책이 바꾸는 확률) — 문헌값으로 교체 필요
export const EFFECT_DEFS = [
  { key: 'eff_outreach_or', label: '안부·사회참여 연계 시 고립 해소', unit: '(고립 OR 제거)', value: 1, status: 'assumed', note: '연계 대상은 고립 OR 미적용' },
  { key: 'eff_discharge_readmit_or', label: '퇴원 연계 시 재입원 OR', unit: 'OR', value: 1.15, status: 'assumed', note: '미연계 시 or_readmit 적용' },
  { key: 'eff_discharge_downgrade', label: '퇴원 연계 시 상태 악화 감소율', unit: '배', value: 0.7, status: 'assumed', note: '' },
  { key: 'cost_team', label: '방문진료팀 1팀 연간 비용', unit: '백만원', value: 250, status: 'assumed', note: '' },
  { key: 'cost_homecare_slot', label: '재가돌봄 1명 연간 공공부담', unit: '백만원', value: 12, status: 'assumed', note: '' },
  { key: 'cost_outreach', label: '안부·연계 1명 연간 비용', unit: '백만원', value: 0.6, status: 'assumed', note: '' },
  { key: 'cost_ltc_bed', label: '시설 1병상 연간 공공부담', unit: '백만원', value: 20, status: 'assumed', note: '' },
];

export function defaultPolicy() {
  const p = Object.fromEntries(POLICY_DEFS.map((d) => [d.key, d.value]));
  for (const d of EFFECT_DEFS) p[d.key] = d.value;
  p.targets = null; // null = 전체 구, 아니면 구 이름 Set
  return p;
}

// 정책 없음 시나리오
export function nullPolicy(policy) {
  return { ...policy, visit_teams: 0, homecare_expand: 0, outreach: 0, ltc_expand: 0, discharge_link: 0, priority_alone: 0 };
}
