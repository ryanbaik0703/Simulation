// 시뮬레이션 엔진 (DOM 의존 없음 → 화면과 Web Worker 양쪽에서 사용)
//
// 모델 구조
//  - 개인 기반 확률 미시모의(agent-based microsimulation). 에이전트 1명 = 실제 노인 `scale`명.
//  - 건강상태: 0 건강 · 1 허약 · 2 돌봄필요(재가) · 3 입원 · 4 시설 · 5 사망 (이산시간 마르코프 연쇄, 1일 단위)
//  - 전이확률 = 기준확률을 로지스틱 모형(오즈비)으로 개인 특성·서비스 충족 여부에 맞게 보정
//  - 서비스(외래, 방문진료, 재가돌봄, 시설)는 구별 용량 제약 하에서 매일 배분 → 미충족이 다시 위험을 높임(피드백)
//  - 1시간 단위 시계는 화면 연출용이며, 확률 계산은 하루 1회(자정) 수행

import { u, mulberry32, stochRound, annualToDaily, periodToDaily, applyLogOdds } from './stats.js';

export const S = { ROBUST: 0, FRAIL: 1, CARE: 2, HOSP: 3, INST: 4, DEAD: 5 };
export const STATE_LABELS = ['건강', '허약', '돌봄필요', '입원', '시설', '사망'];

const NEVER = -100000;

// 외래 공급을 "의원 1곳 환산 수"로: 유형별 기관 수 × 가중치.
// 우선순위: 2SFCA 유효 기관 수(*_eff, 구 경계를 넘는 이용을 거리로 반영) → 구 안의 유형별 수(*_n) → clinics 합계
export function clinicUnits(r, p) {
  const sfx = r.clinic_eff != null ? '_eff' : r.clinic_n != null ? '_n' : null;
  if (!sfx) return r.clinics;
  const n = (k) => r[k + sfx] ?? 0;
  return n('clinic') + n('hospital') * p.w_hospital + n('general') * p.w_general + n('ltch') * p.w_ltch;
}

// 시설 병상: 구별 정원 데이터가 있으면 그대로, 없으면 시설 수 × 1곳당 정원
const ltcBeds = (r, p) => r.ltc_capacity ?? r.ltc_fac * p.ltc_beds;

export class Simulation {
  /**
   * @param {Array} districts  구별 데이터 행 [{gu, pop65, pop75?, alone, alone_basic?, clinics, clinic_n?, hospital_n?, general_n?, ltch_n?,
   *                            homecare_fac, ltc_fac, ltc_capacity?, ltc_residents?, community_fac, entry_rate?}]
   * @param {object} params    PARAM 값
   * @param {object} policy    정책 레버 값
   * @param {object} opt       { seed, scale, years }
   */
  constructor(districts, params, policy, opt) {
    this.d = districts;
    this.G = districts.length;
    this.p = params;
    this.pol = policy;
    this.seed = opt.seed >>> 0;
    this.scale = opt.scale;
    this.day = 0;
    this.hour = 0;
    this.history = [];
    this.cum = { admissions: 0, deaths: 0, instEntries: 0, unmetCareDays: 0, medGapDays: 0, homeVisits: 0 };
    this.targetMask = new Uint8Array(this.G);
    for (let g = 0; g < this.G; g++) {
      this.targetMask[g] = !policy.targets || policy.targets.has(districts[g].gu) ? 1 : 0;
    }
    this._precompute();
    this._initPopulation(opt.years ?? 5);
    this._daily();
  }

  _precompute() {
    const p = this.p;
    const L = Math.log;
    this.lo = {
      age: L(p.or_age), alone: L(p.or_alone), isolated: L(p.or_isolated), poor: L(p.or_poor),
      careHosp: L(p.or_unmet_care_hosp), careInst: L(p.or_unmet_care_inst), careDeath: L(p.or_unmet_care_death),
      medHosp: L(p.or_unmet_med_hosp), readmit: L(p.or_readmit), readmitLinked: L(this.pol.eff_discharge_readmit_or),
    };
    const D = annualToDaily;
    this.pd = {
      rf: D(p.p_robust_frail), fr: D(p.p_frail_robust), fc: D(p.p_frail_care), cf: D(p.p_care_frail), ci: D(p.p_care_inst),
      hosp: [D(p.p_hosp_robust), D(p.p_hosp_frail), D(p.p_hosp_care)],
      death: [D(p.p_death_robust), D(p.p_death_frail), D(p.p_death_care), periodToDaily(p.p_death_per_stay, p.los_mean), D(p.p_death_inst)],
      visit: [p.visits_robust / 365, p.visits_frail / 365, p.visits_care / 365],
    };
  }

  // ---- 가상 인구 생성 ----------------------------------------------------
  _initPopulation(years) {
    const rng = mulberry32(this.seed);
    const sc = this.scale;
    let n0 = 0;
    const counts = this.d.map((r) => { const c = Math.round(r.pop65 / sc); n0 += c; return c; });
    const growth = this.d.reduce((s, r) => s + (r.pop65 * (r.entry_rate ?? this.p.entry_rate)) / sc, 0);
    const cap = Math.ceil(n0 + growth * (years + 1) + 100);
    this.cap = cap;
    this.n = 0;
    this.gu = new Uint8Array(cap);
    this.age = new Float32Array(cap);
    this.alone = new Uint8Array(cap);
    this.poor = new Uint8Array(cap);
    this.state = new Uint8Array(cap);
    this.prevState = new Uint8Array(cap);
    this.hospLeft = new Int16Array(cap);
    this.lastMed = new Int32Array(cap);
    this.discharge = new Int32Array(cap).fill(NEVER);
    this.served = new Uint8Array(cap);      // 오늘 재가돌봄 배정 여부
    this.unmetCare = new Uint16Array(cap);  // 연속 돌봄 미충족 일수
    this.visit = new Uint8Array(cap);       // 오늘 의료이용: 0 없음, 1 외래, 2 방문진료, 3 외래 실패
    this.event = new Uint8Array(cap);       // 오늘 사건: 0 없음, 1 입원, 2 사망, 3 시설입소, 4 퇴원

    for (let g = 0; g < this.G; g++) {
      const r = this.d[g];
      const share75 = r.pop75 ? r.pop75 / r.pop65 : 0.55;
      const aloneRate = r.alone / r.pop65;
      const poorAlone = r.alone_basic != null ? r.alone_basic / Math.max(1, r.alone) : 0.25;
      const first = this.n;
      for (let k = 0; k < counts[g]; k++) {
        const i = this.n++;
        this.gu[i] = g;
        this.age[i] = rng() < share75 ? 75 + Math.min(30, -Math.log(1 - rng()) * 7) : 65 + rng() * 10;
        this.alone[i] = rng() < aloneRate ? 1 : 0;
        this.poor[i] = rng() < (this.alone[i] ? poorAlone : 0.05) ? 1 : 0;
        this.state[i] = this._initialState(this.age[i], rng());
        this.lastMed[i] = -Math.floor(rng() * 60);
      }
      if (r.ltc_residents != null) this._matchInstitution(g, first, r.ltc_residents / sc, rng);
    }
  }

  // 초기 시설 입소자 수를 실제 현원에 맞춤: 넘치면 무작위로 돌봄필요(재가)로, 모자라면 돌봄필요 중에서 입소.
  // 돌봄필요+시설 합계와 나이에 따른 분포는 그대로 유지된다.
  _matchInstitution(g, first, target, rng) {
    const inst = [], care = [];
    for (let i = first; i < this.n; i++) (this.state[i] === S.INST ? inst : this.state[i] === S.CARE ? care : null)?.push(i);
    const k = stochRound(target, rng());
    const [from, to, toState] = inst.length > k ? [inst, inst.length - k, S.CARE] : [care, k - inst.length, S.INST];
    for (let j = 0; j < Math.min(to, from.length); j++) {
      const pick = j + Math.floor(rng() * (from.length - j));
      [from[j], from[pick]] = [from[pick], from[j]];
      this.state[from[j]] = toState;
    }
  }

  // 나이에 따른 초기 상태 (로지스틱: 75세 기준 비율에서 나이 1세당 OR 적용)
  _initialState(age, r) {
    const lo = Math.log(1.09) * (age - 75);
    const pInst = applyLogOdds(0.012, lo);
    const pCare = applyLogOdds(0.09, lo);
    const pFrail = applyLogOdds(0.28, lo * 0.6);
    if (r < pInst) return S.INST;
    if (r < pInst + pCare) return S.CARE;
    if (r < pInst + pCare + pFrail) return S.FRAIL;
    return S.ROBUST;
  }

  _addEntrants() {
    const sc = this.scale;
    for (let g = 0; g < this.G; g++) {
      const r = this.d[g];
      const expected = (r.pop65 * (r.entry_rate ?? this.p.entry_rate)) / sc;
      const k = stochRound(expected, u(this.seed, g, this.day, 12));
      const aloneRate = (r.alone / r.pop65) * 0.6; // 신규 진입자는 독거 비율이 낮음 (가정)
      for (let j = 0; j < k && this.n < this.cap; j++) {
        const i = this.n++;
        this.gu[i] = g;
        this.age[i] = 65 + u(this.seed, i, 0, 20);
        this.alone[i] = u(this.seed, i, 0, 21) < aloneRate ? 1 : 0;
        this.poor[i] = u(this.seed, i, 0, 22) < 0.05 ? 1 : 0;
        this.state[i] = u(this.seed, i, 0, 23) < 0.12 ? S.FRAIL : S.ROBUST;
        this.lastMed[i] = this.day;
        this.discharge[i] = NEVER;
      }
    }
  }

  // ---- 시간 진행 ----------------------------------------------------------
  stepHour() {
    this.hour++;
    if (this.hour >= 24) {
      this.hour = 0;
      this.day++;
      this._daily();
    }
  }

  stepDay() {
    this.day++;
    this.hour = 0;
    this._daily();
  }

  // 실행 중 정책 변경 (다음 날부터 반영)
  setPolicy(policy) {
    this.pol = policy;
    for (let g = 0; g < this.G; g++) {
      this.targetMask[g] = !policy.targets || policy.targets.has(this.d[g].gu) ? 1 : 0;
    }
    this._precompute();
  }

  policyActive(g) {
    return this.day >= this.pol.start_day && this.targetMask[g] === 1;
  }

  // 구별 일일 용량 (에이전트 단위)
  _capacities() {
    const p = this.p, pol = this.pol, sc = this.scale, G = this.G;
    const c = {
      home: new Float64Array(G), bed: new Float64Array(G), clinic: new Float64Array(G),
      team: new Float64Array(G), community: new Float64Array(G), outreach: new Float64Array(G),
    };
    for (let g = 0; g < G; g++) {
      const r = this.d[g];
      const on = this.policyActive(g);
      c.home[g] = (r.homecare_fac * p.homecare_clients * (1 + (on ? pol.homecare_expand / 100 : 0))) / sc;
      c.bed[g] = (ltcBeds(r, p) * (1 + (on ? pol.ltc_expand / 100 : 0))) / sc;
      c.clinic[g] = (clinicUnits(r, p) * p.clinic_cap) / sc;
      c.team[g] = ((p.base_visit_teams + (on ? pol.visit_teams : 0)) * p.team_visits_day) / sc;
      c.community[g] = (r.community_fac * p.community_members) / sc;
      c.outreach[g] = on ? pol.outreach / 100 : 0;
    }
    return c;
  }

  _daily() {
    const day = this.day, seed = this.seed, G = this.G, p = this.p, pol = this.pol;
    if (day > 0 && day % 365 === 0) {
      for (let i = 0; i < this.n; i++) if (this.state[i] !== S.DEAD) this.age[i] += 1;
    }
    if (day > 0 && day % 365 === 0) this._addEntrants();
    const year = Math.floor(day / 365);
    const cap = this._capacities();
    this.cap_ = cap;

    // 구별 목록 수집
    const careHome = Array.from({ length: G }, () => []);
    const due = Array.from({ length: G }, () => []);
    const opDemand = Array.from({ length: G }, () => []);
    const eligibleCommunity = new Float64Array(G);
    const instCount = new Float64Array(G);
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const s = this.state[i];
      this.visit[i] = 0;
      this.event[i] = 0;
      if (s === S.DEAD) continue;
      const g = this.gu[i];
      if (s === S.INST) instCount[g]++;
      if (s !== S.CARE) this.unmetCare[i] = 0;
      if (s === S.CARE) {
        // 공식 돌봄 필요: 독거는 전원, 동거는 일부 (나머지는 가족 돌봄) — 개인별 고정 난수
        if (this.alone[i] || u(seed, i, 0, 13) < p.need_formal_family) careHome[g].push(i);
        if (day - this.lastMed[i] >= p.homevisit_interval) due[g].push(i);
        // 거동이 불편해도 일부는 외래 이용 (독거는 동행 부재로 감소)
        const pv = this.pd.visit[2] * (this.alone[i] ? p.care_alone_mobility : 1);
        if (u(seed, i, day, 7) < pv) opDemand[g].push(i);
      } else if (s === S.ROBUST || s === S.FRAIL) {
        eligibleCommunity[g]++;
        if (u(seed, i, day, 7) < this.pd.visit[s]) opDemand[g].push(i);
      }
    }

    const prioAlone = pol.priority_alone && day >= pol.start_day;
    const m = {
      day, careHome: 0, unmetCare: 0, dueVisits: 0, homeVisits: 0, opDemand: 0, opUnmet: 0,
      admissions: 0, deaths: 0, instEntries: 0, instWaiting: 0,
    };
    const guUnmet = new Float64Array(G), guCare = new Float64Array(G), guMedGap = new Float64Array(G);
    const guAlive = new Float64Array(G), guAdm = new Float64Array(G), guDeaths = new Float64Array(G);
    const guOpUnmet = new Float64Array(G), guOpDemand = new Float64Array(G);
    const freeBeds = new Float64Array(G);

    for (let g = 0; g < G; g++) {
      // 재가돌봄: 기존 이용자 유지(연속성) → 독거 우선(정책) → 무작위
      const homeCap = stochRound(cap.home[g], u(seed, g, day, 31));
      const list = careHome[g];
      const key = new Map();
      for (const i of list) {
        const target = this.policyActive(g);
        key.set(i, (this.served[i] ? 0 : 2) + (prioAlone && target && this.alone[i] ? 0 : 1) + u(seed, i, day, 8));
      }
      list.sort((a, b) => key.get(a) - key.get(b));
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        if (k < homeCap) { this.served[i] = 1; this.unmetCare[i] = 0; }
        else { this.served[i] = 0; this.unmetCare[i] = Math.min(65000, this.unmetCare[i] + 1); guUnmet[g]++; }
      }
      m.careHome += list.length;
      m.unmetCare += Math.max(0, list.length - homeCap);

      // 방문진료: 오래 기다린 순
      const teamCap = stochRound(cap.team[g], u(seed, g, day, 32));
      const dl = due[g];
      dl.sort((a, b) => this.lastMed[a] - this.lastMed[b]);
      for (let k = 0; k < Math.min(teamCap, dl.length); k++) {
        const i = dl[k];
        this.lastMed[i] = day; this.visit[i] = 2;
      }
      m.dueVisits += dl.length;
      m.homeVisits += Math.min(teamCap, dl.length);

      // 외래: 용량 초과분은 일부 타 구에서 해소
      const clinicCap = stochRound(cap.clinic[g], u(seed, g, day, 33));
      const od = opDemand[g];
      for (let k = 0; k < od.length; k++) {
        const i = od[k];
        if (k < clinicCap || u(seed, i, day, 9) < p.cross_border) { this.lastMed[i] = day; this.visit[i] = 1; }
        else { this.visit[i] = 3; guOpUnmet[g]++; }
      }
      guOpDemand[g] = od.length;
      m.opDemand += od.length;
      m.opUnmet += guOpUnmet[g];

      freeBeds[g] = Math.max(0, Math.floor(cap.bed[g]) - instCount[g]);
    }

    // 지역사회 프로그램 참여 확률 (구별, 연 단위로 고정)
    const coverage = new Float64Array(G);
    for (let g = 0; g < G; g++) coverage[g] = Math.min(1, cap.community[g] / Math.max(1, eligibleCommunity[g]));

    // ---- 상태 전이 ----
    const lo = this.lo, pd = this.pd;
    for (let i = 0; i < n; i++) {
      const s = this.state[i];
      if (s === S.DEAD) continue;
      const g = this.gu[i];
      const loAge = lo.age * (this.age[i] - 75);

      if (s === S.HOSP) {
        if (u(seed, i, day, 1) < pd.death[3]) { this._die(i, m, guDeaths); continue; }
        if (--this.hospLeft[i] <= 0) {
          let back = this.prevState[i];
          const linked = pol.discharge_link && this.policyActive(g);
          const pDown = p.p_downgrade_after_hosp * (linked ? pol.eff_discharge_downgrade : 1);
          if (u(seed, i, day, 6) < pDown && back < S.CARE) back++;
          this.state[i] = back;
          this.discharge[i] = day;
          this.event[i] = 4;
        }
        guAlive[g]++;
        continue;
      }

      if (s === S.INST) {
        if (u(seed, i, day, 1) < applyLogOdds(pd.death[4], loAge)) { this._die(i, m, guDeaths); continue; }
        guAlive[g]++;
        continue;
      }

      // 재가 상태 (건강/허약/돌봄필요)
      const unmetC = s === S.CARE && this.unmetCare[i] > 0;
      const gap = day - this.lastMed[i];
      const medGap = (s === S.FRAIL && gap > p.med_gap_frail) || (s === S.CARE && gap > p.med_gap_care);
      if (medGap) guMedGap[g]++;
      if (s === S.CARE) guCare[g]++;
      const member = u(seed, i, year, 10) < coverage[g];
      const reached = this.alone[i] && u(seed, i, year, 11) < cap.outreach[g];
      const isolated = this.alone[i] && !member && !reached;

      // 1) 사망
      let lod = loAge + (unmetC ? lo.careDeath : 0);
      if (u(seed, i, day, 1) < applyLogOdds(pd.death[s], lod)) { this._die(i, m, guDeaths); continue; }

      // 2) 입원
      let loh = (this.poor[i] ? lo.poor : 0) + (unmetC ? lo.careHosp : 0) + (medGap ? lo.medHosp : 0) + loAge * 0.5;
      if (day - this.discharge[i] < p.readmit_window) {
        loh += pol.discharge_link && this.policyActive(g) ? lo.readmitLinked : lo.readmit;
      }
      if (u(seed, i, day, 2) < applyLogOdds(pd.hosp[s], loh)) {
        this.prevState[i] = s;
        this.state[i] = S.HOSP;
        this.hospLeft[i] = Math.max(1, Math.ceil(-Math.log(1 - u(seed, i, day, 5)) * p.los_mean));
        this.served[i] = 0;
        this.event[i] = 1;
        m.admissions++; guAdm[g]++;
        guAlive[g]++;
        continue;
      }

      // 3) 상태 진행/회복
      const loRisk = loAge + (this.alone[i] ? lo.alone : 0) + (isolated ? lo.isolated : 0) + (this.poor[i] ? lo.poor : 0);
      const r = u(seed, i, day, 3);
      if (s === S.ROBUST) {
        if (r < applyLogOdds(pd.rf, loRisk)) this.state[i] = S.FRAIL;
      } else if (s === S.FRAIL) {
        const pUp = applyLogOdds(pd.fc, loRisk);
        const pDown = applyLogOdds(pd.fr, -loRisk);
        if (r < pUp) this.state[i] = S.CARE;
        else if (r < pUp + pDown) this.state[i] = S.ROBUST;
      } else if (s === S.CARE) {
        const pInst = applyLogOdds(pd.ci, loAge + (unmetC ? lo.careInst : 0));
        const pBack = applyLogOdds(pd.cf, -loAge);
        if (r < pInst) {
          if (freeBeds[g] >= 1) {
            freeBeds[g]--;
            this.state[i] = S.INST; this.served[i] = 0; this.event[i] = 3;
            m.instEntries++;
          } else {
            m.instWaiting++;
          }
        } else if (r < pInst + pBack) {
          this.state[i] = S.FRAIL;
        }
      }
      guAlive[g]++;
    }

    // ---- 기록 ----
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) counts[this.state[i]]++;
    m.alive = n - counts[S.DEAD];
    m.states = counts;
    m.medGap = guMedGap.reduce((a, b) => a + b, 0);
    this.cum.admissions += m.admissions;
    this.cum.deaths += m.deaths;
    this.cum.instEntries += m.instEntries;
    this.cum.unmetCareDays += m.unmetCare;
    this.cum.medGapDays += m.medGap;
    this.cum.homeVisits += m.homeVisits;
    m.cum = { ...this.cum };
    this.history.push(m);
    this.gu_ = { unmet: guUnmet, care: guCare, medGap: guMedGap, alive: guAlive, adm: guAdm, deaths: guDeaths, opUnmet: guOpUnmet, opDemand: guOpDemand };
  }

  _die(i, m, guDeaths) {
    this.state[i] = S.DEAD;
    this.served[i] = 0;
    this.event[i] = 2;
    m.deaths++;
    guDeaths[this.gu[i]]++;
  }

  // 정책 연간 비용 (백만원, 실제 인구 단위)
  policyCost() {
    const pol = this.pol, p = this.p;
    let teams = 0, slots = 0, outreachN = 0, beds = 0;
    for (let g = 0; g < this.G; g++) {
      if (!this.targetMask[g]) continue;
      const r = this.d[g];
      teams += pol.visit_teams;
      slots += r.homecare_fac * p.homecare_clients * pol.homecare_expand / 100;
      outreachN += r.alone * pol.outreach / 100;
      beds += ltcBeds(r, p) * pol.ltc_expand / 100;
    }
    const items = {
      visit: teams * pol.cost_team,
      homecare: slots * pol.cost_homecare_slot,
      outreach: outreachN * pol.cost_outreach,
      ltc: beds * pol.cost_ltc_bed,
    };
    items.total = items.visit + items.homecare + items.outreach + items.ltc;
    return items;
  }
}

// 헤드리스 실행: 기준/정책 시나리오를 같은 시드로 실행 → 결과 요약
export function runPair(districts, params, basePolicy, policy, opt) {
  const a = new Simulation(districts, params, basePolicy, opt);
  const b = new Simulation(districts, params, policy, opt);
  for (let t = 0; t < opt.days; t++) { a.stepDay(); b.stepDay(); }
  return { base: summarize(a), policy: summarize(b) };
}

// 헤드리스 실행: 시나리오 하나. 같은 seed면 다른 시나리오와 공통난수를 공유
export function runOne(districts, params, policy, opt) {
  const sim = new Simulation(districts, params, policy, opt);
  for (let t = 0; t < opt.days; t++) sim.stepDay();
  return { ...summarize(sim), cost: sim.policyCost().total };
}

export function summarize(sim) {
  const last = sim.history[sim.history.length - 1];
  const sc = sim.scale;
  return {
    admissions: sim.cum.admissions * sc,
    deaths: sim.cum.deaths * sc,
    instEntries: sim.cum.instEntries * sc,
    unmetCareDays: sim.cum.unmetCareDays * sc,
    medGapDays: sim.cum.medGapDays * sc,
    careEnd: last.states[S.CARE] * sc,
    unmetEnd: last.unmetCare * sc,
  };
}
