"""병의원 공간 접근성: 향상된 2단계 유동 집수구역법 (E2SFCA; Luo & Wang 2003, Luo & Qi 2009)

  1단계  기관 j의 공급 대비 수요 비율   R_j = S_j / Σ_k P_k·W(d_kj)       (d_kj ≤ d0_j 인 수요점 k)
  2단계  수요점 i의 접근성             A_i = Σ_j R_j·W(d_ij)             (d_ij ≤ d0_j 인 기관 j)
  거리감쇠 W(d) = [exp(-½(d/d0)²) − exp(-½)] / [1 − exp(-½)]   (가우시안, d = d0에서 0)

S_j = 의원 1곳 환산 규모(유형별 가중치), d0_j = 유형별 집수 반경.
수요점 = 동 경계 안의 250m 격자. 동의 65세 이상 인구 = 구 인구 × (동 독거노인 / 구 독거노인)로 추정해 격자에 고르게 나눈다.

시뮬레이터에 넘기는 값: 기관 j의 용량이 각 구 주민에게 배분되는 몫 P_k·W(d_kj) / Σ P·W 를 구별로 더한
"구 주민이 실제로 쓸 수 있는 기관 수" (clinic_eff 등). 1단계 배분은 S_j와 무관하므로 가중치는 엔진에서 곱한다.
"""
import collections
import csv
import io
import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')

# 유형: (districts.csv 열 접두어, 집수 반경 km, 접근성 지수용 규모 S — 엔진 기본 가중치와 같게)
TYPES = collections.OrderedDict([
    ('의원', ('clinic', 1.5, 1.0)),
    ('병원', ('hospital', 3.0, 4.0)),
    ('종합병원', ('general', 10.0, 20.0)),
    ('요양병원', ('ltch', 5.0, 0.5)),
])
GRID_KM = 0.25

# 통계(2025)와 경계(2013)의 동 이름 차이. 값이 None이면 경계가 없어 구 안에서 비율대로 나눈다.
DONG_ALIAS = {
    '정능1동': '정릉1동', '정능2동': '정릉2동', '정능3동': '정릉3동', '정능4동': '정릉4동',
    '신설동': '용신동', '용두동': '용신동',      # 2025년 용신동 분동
    '상일1동': '상일동', '상일2동': '상일동',    # 상일동 분동
    '개포3동': '일원2동',                       # 일원2동 → 개포3동 명칭 변경
    '항동': None, '위례동': None,              # 2013년 이후 신설
}

LAT0, LON0 = 37.55, 126.98
KX, KY = 111.32 * math.cos(math.radians(LAT0)), 110.57


def xy(lon, lat):
    return (lon - LON0) * KX, (lat - LAT0) * KY


def decay(d, d0):
    e = math.exp(-0.5)
    return (math.exp(-0.5 * (d / d0) ** 2) - e) / (1 - e) if d < d0 else 0.0


def inside(x, y, rings):
    """짝-홀 규칙: 바깥 고리 안이면서 구멍 고리 밖"""
    hit = False
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                hit = not hit
    return hit


def norm(name):
    return name.replace('.', '·')


def demand_points(gu_pop65, dong_alone):
    """[(x, y, gu, dong, P)] — 동 격자점별 65세 이상 추정 인구"""
    gu_by_code = {f['properties']['code']: f['properties']['name']
                  for f in json.load(io.open(os.path.join(DATA, 'seoul_gu.geojson'), encoding='utf-8'))['features']}
    dongs = collections.defaultdict(dict)  # gu → dong → [rings]
    for f in json.load(io.open(os.path.join(DATA, 'seoul_dong.geojson'), encoding='utf-8'))['features']:
        p = f['properties']
        dongs[gu_by_code[p['code'][:5]]][p['name']] = [[xy(*c) for c in ring] for ring in f['geometry']['coordinates']]

    points = []
    for gu, pop65 in gu_pop65.items():
        weight = collections.Counter()
        for name, n in dong_alone.get(gu, {}).items():
            name = DONG_ALIAS.get(name, norm(name))
            if name in dongs[gu]:
                weight[name] += n
        if not weight:  # 동별 자료가 없으면 동 면적이 아니라 동 개수로 균등 배분
            weight = collections.Counter(dict.fromkeys(dongs[gu], 1))
        total = sum(weight.values())
        for name, rings in dongs[gu].items():
            if not weight[name]:
                continue
            xs = [x for x, _ in rings[0]]
            ys = [y for _, y in rings[0]]
            pts = [(x, y)
                   for x in frange(min(xs), max(xs), GRID_KM)
                   for y in frange(min(ys), max(ys), GRID_KM) if inside(x, y, rings)]
            if not pts:  # 격자보다 작은 동
                pts = [(sum(xs) / len(xs), sum(ys) / len(ys))]
            P = pop65 * weight[name] / total / len(pts)
            points.extend((x, y, gu, name, P) for x, y in pts)
    return points


def frange(lo, hi, step):
    v = lo + step / 2
    while v < hi:
        yield v
        v += step


def providers(path, types):
    out = []
    with io.open(path, encoding='cp949', errors='replace') as f:
        for r in csv.DictReader(f):
            if r['병원분류명'] in types:
                x, y = xy(float(r['병원경도']), float(r['병원위도']))
                out.append((x, y, r['병원분류명'], r['주소'].split()[1]))
    return out


def compute(gu_pop65, dong_alone, clinic_csv):
    """반환: (구별 유효 기관 수 {gu: {'clinic_eff':..}}, 동별 접근성 행, 점검용 합계)"""
    pts = demand_points(gu_pop65, dong_alone)
    cell = collections.defaultdict(list)
    for k, (x, y, _, _, _) in enumerate(pts):
        cell[(int(math.floor(x)), int(math.floor(y)))].append(k)

    eff = collections.defaultdict(lambda: collections.OrderedDict((v[0] + '_eff', 0.0) for v in TYPES.values()))
    A = [0.0] * len(pts)
    supply = 0.0
    for x, y, kind, own_gu in providers(clinic_csv, TYPES):
        prefix, d0, S = TYPES[kind]
        r = int(math.ceil(d0))
        near = []
        for cx in range(int(math.floor(x)) - r, int(math.floor(x)) + r + 1):
            for cy in range(int(math.floor(y)) - r, int(math.floor(y)) + r + 1):
                for k in cell.get((cx, cy), ()):
                    w = decay(math.hypot(pts[k][0] - x, pts[k][1] - y), d0)
                    if w > 0:
                        near.append((k, w))
        demand = sum(pts[k][4] * w for k, w in near)
        if demand <= 0:  # 반경 안에 수요점이 없으면(외곽) 소재 구에 전부
            eff[own_gu][prefix + '_eff'] += 1
            continue
        supply += S
        for k, w in near:
            eff[pts[k][2]][prefix + '_eff'] += pts[k][4] * w / demand
            A[k] += S / demand * w

    # 동별 접근성 (65세 이상 1만 명당 의원 환산 기관 수, 인구가중 평균)
    agg = collections.defaultdict(lambda: [0.0, 0.0])
    for (x, y, gu, dong, P), a in zip(pts, A):
        agg[(gu, dong)][0] += P
        agg[(gu, dong)][1] += a * P
    dong_rows = [collections.OrderedDict(gu=g, dong=d, pop65_est=round(P), access_per_10k=round(aP / P * 1e4, 2))
                 for (g, d), (P, aP) in agg.items()]
    check = {'supply': supply, 'allocated': sum(a * p[4] for a, p in zip(A, pts)), 'points': len(pts)}
    return eff, dong_rows, check
