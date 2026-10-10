"""data/(raw/)의 원자료 → data/districts.csv 변환 (pandas 없이 표준 라이브러리만 사용, Python 3.6+)

실행: python scripts/build_districts.py

입력 (파일 이름 앞부분으로 찾음, data/ 또는 data/raw/)
  등록인구(연령별_동별)*.xlsx          pop65, pop75        (가장 최근 분기, 계 = 내국인+등록외국인)
  독거노인+현황(성별_동별)*.xlsx        alone, alone_basic  (alone_basic = 국민기초생활보장 수급권자)
  서울시 병의원 위치 정보*.csv          clinic_n, hospital_n, general_n, ltch_n (의원/병원/종합병원/요양병원)
  서울시 사회복지시설(재가노인복지시설)*.json  homecare_fac
  노인의료+복지시설*.xlsx              ltc_fac, ltc_capacity(정원), ltc_residents(현원)
  노인여가+복지시설(구별)*.xlsx         community_fac (경로당·노인복지관·노인교실 합계)
"""
import collections
import csv
import glob
import io
import json
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import access_2sfca  # noqa: E402
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
OUT = os.path.join(DATA, 'districts.csv')
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'

# 병원분류명 → districts.csv 열 (치과·한의원·보건소 등은 제외)
CLINIC_TYPES = collections.OrderedDict([
    ('의원', 'clinic_n'), ('병원', 'hospital_n'), ('종합병원', 'general_n'), ('요양병원', 'ltch_n'),
])


def find(prefix):
    hits = sorted(glob.glob(os.path.join(DATA, prefix + '*')) + glob.glob(os.path.join(DATA, 'raw', prefix + '*')))
    if not hits:
        sys.exit('파일을 찾을 수 없습니다: data/ 또는 data/raw/ 에 "{}..." 를 넣어 주세요'.format(prefix))
    if len(hits) > 1:
        print('  ! 같은 종류 파일이 여러 개라 가장 마지막 것을 씁니다: ' + os.path.basename(hits[-1]))
    return hits[-1]


def col_index(ref):
    n = 0
    for ch in re.match(r'[A-Z]+', ref).group():
        n = n * 26 + ord(ch) - 64
    return n - 1


def read_xlsx(path, sheet=1):
    """첫 시트를 행 리스트(문자열 셀)로 반환. 통계표 형식이라 병합 헤더는 그대로 둔다."""
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).iter(NS + 'si'):
            shared.append(''.join(t.text or '' for t in si.iter(NS + 't')))
    rows = []
    for r in ET.fromstring(z.read('xl/worksheets/sheet{}.xml'.format(sheet))).iter(NS + 'row'):
        row = []
        for c in r.iter(NS + 'c'):
            j = col_index(c.get('r'))
            row.extend([''] * (j + 1 - len(row)))
            v, t = c.find(NS + 'v'), c.get('t')
            if t == 'inlineStr':
                row[j] = ''.join(x.text or '' for x in c.iter(NS + 't'))
            elif v is not None:
                row[j] = shared[int(v.text)] if t == 's' else v.text
        rows.append(row)

    return rows


def meta(path):
    """통계표 두 번째 시트(설명)에서 통계표 ID와 조회기간"""
    try:
        info = {r[0].strip('○ ').strip(): r[1] for r in read_xlsx(path, 2) if len(r) > 1}
        return '{} {}'.format(info.get('통계표ID', ''), info.get('조회기간', '').strip())
    except KeyError:
        return ''


def num(v):
    v = (v or '').strip()
    return 0.0 if v in ('', '-') else float(v)


def population(path):
    rows = read_xlsx(path)
    periods, ages = rows[0], rows[1]
    latest = sorted(set(p for p in periods[2:] if p))[-1]
    idx = [j for j, p in enumerate(periods) if p == latest]
    i65 = [j for j in idx if re.match(r'(6[5-9]|[7-9]\d|1\d\d)', ages[j])]
    i75 = [j for j in i65 if not ages[j].startswith(('65', '70'))]
    out, gu = {}, None
    for r in rows[2:]:
        gu = r[0] or gu
        if r[1] == '계' and gu != '합계':
            out[gu] = {'pop65': sum(num(r[j]) for j in i65), 'pop75': sum(num(r[j]) for j in i75)}
    return out, latest


def alone(path):
    rows = read_xlsx(path)
    head = rows[2]  # 소계 / 국민기초생활보장 수급권자 / 저소득노인 / 일반
    j_basic = head.index('국민기초생활보장 수급권자')
    out, dong, gu = {}, collections.defaultdict(dict), None
    for r in rows[5:]:
        if r[0]:  # 서울특별시 합계 행
            continue
        if r[1]:
            gu = r[1]
            out[gu] = {'alone': num(r[3]), 'alone_basic': num(r[j_basic])}
        else:
            dong[gu][r[2]] = num(r[3])
    bad = [g for g in out if dong[g] and sum(dong[g].values()) != out[g]['alone']]
    if bad:
        print('  ! 독거노인: 동별 합계가 구 소계와 다른 구 → ' + ', '.join(bad))
    return out, dong


def clinics(path):
    out = collections.defaultdict(lambda: dict.fromkeys(CLINIC_TYPES.values(), 0))
    with io.open(path, encoding='cp949', errors='replace') as f:
        for r in csv.DictReader(f):
            col = CLINIC_TYPES.get(r['병원분류명'])
            if col:
                out[r['주소'].split()[1]][col] += 1
    return out


def homecare(path):
    out = collections.Counter()
    for x in json.load(io.open(path, encoding='utf-8'))['DATA']:
        gu = x['jrsd_sgg_nm']
        if not gu.endswith('구'):  # 서울시 직영 시설은 주소의 구로
            gu = (x.get('fclt_addr') or '').split()[1]
        out[gu] += 1
    return out


def ltc(path):
    rows = read_xlsx(path)
    out = {}
    for r in rows[7:]:
        if r[1] and not r[0]:
            out[r[1]] = {'ltc_fac': num(r[2]), 'ltc_capacity': num(r[3]), 'ltc_residents': num(r[4])}
    return out, rows[0][2]


def community(path):
    rows = read_xlsx(path)
    return {r[1]: num(r[2]) for r in rows[5:] if r[1] and not r[0]}, rows[0][2]


def main():
    print('원자료 읽는 중...')
    f_pop = find('등록인구(연령별')
    f_alone = find('독거노인+현황')
    f_clin = find('서울시 병의원 위치 정보')
    f_home = find('서울시 사회복지시설(재가노인복지시설)')
    f_ltc = find('노인의료+복지시설')
    f_comm = find('노인여가+복지시설(구별)')

    pop, pop_period = population(f_pop)
    al, al_dong = alone(f_alone)
    cl = clinics(f_clin)
    hc = homecare(f_home)
    lt, ltc_year = ltc(f_ltc)
    cm, comm_year = community(f_comm)

    gus = list(pop)
    for name, d in [('독거노인', al), ('병의원', cl), ('재가시설', hc), ('노인의료시설', lt), ('여가시설', cm)]:
        miss = [g for g in gus if g not in d]
        if miss:
            sys.exit('{}: 자치구가 빠져 있습니다 → {}'.format(name, ', '.join(miss)))

    rows = []
    for g in gus:
        row = collections.OrderedDict(gu=g)
        row.update((k, int(v)) for k, v in pop[g].items())
        row.update((k, int(v)) for k, v in al[g].items())
        row.update(cl[g])
        row['clinics'] = sum(cl[g].values())  # 유형 구분 없는 합계 (지도 표시·구버전 호환)
        row['homecare_fac'] = hc[g]
        row.update((k, int(v)) for k, v in lt[g].items())
        row['community_fac'] = int(cm[g])
        rows.append(row)

    # 병의원 공간 접근성 (2SFCA): 구 경계를 넘는 이용을 거리 기준으로 반영한 "구 주민이 쓸 수 있는 기관 수"
    if os.path.exists(os.path.join(DATA, 'seoul_dong.geojson')):
        print('2SFCA 접근성 계산 중...')
        eff, dong_rows, chk = access_2sfca.compute({g: pop[g]['pop65'] for g in gus}, al_dong, f_clin)
        for row in rows:
            row.update((k, round(v, 2)) for k, v in eff[row['gu']].items())
        with io.open(os.path.join(DATA, 'access_2sfca_dong.csv'), 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(dong_rows[0]))
            w.writeheader()
            w.writerows(sorted(dong_rows, key=lambda r: r['access_per_10k']))
        print('  수요점 {:,}개, 공급 보존 확인 {:.1f} = {:.1f}'.format(chk['points'], chk['supply'], chk['allocated']))
        print('  동별 접근성: data/access_2sfca_dong.csv')
    else:
        print('  ! data/seoul_dong.geojson 이 없어 2SFCA를 건너뜁니다 (구 안의 기관 수만 사용)')

    if os.path.exists(OUT):
        with io.open(OUT, encoding='utf-8-sig') as f:
            if 'is_placeholder' in f.readline():
                os.replace(OUT, os.path.join(DATA, 'districts_placeholder.csv'))
                print('  기존 임시 데이터는 data/districts_placeholder.csv 로 보관')
    with io.open(OUT, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    t = lambda k: sum(r[k] for r in rows)
    print('\n저장: data/districts.csv ({}개 구)'.format(len(rows)))
    print('  인구      {:>10,}명 65세+, 75세+ {:.1%}   ← {} ({})'.format(t('pop65'), t('pop75') / t('pop65'), os.path.basename(f_pop), pop_period))
    print('  독거      {:>10,}명 (독거율 {:.1%}), 수급 {:.1%}   ← {}'.format(t('alone'), t('alone') / t('pop65'), t('alone_basic') / t('alone'), meta(f_alone)))
    print('  병의원    의원 {:,} / 병원 {:,} / 종합병원 {:,} / 요양병원 {:,}'.format(*(t(c) for c in CLINIC_TYPES.values())))
    print('  재가시설  {:>10,}곳'.format(t('homecare_fac')))
    print('  노인의료  {:>10,}곳, 정원 {:,} / 현원 {:,} (65세+의 {:.2%})   ← {}년'.format(t('ltc_fac'), t('ltc_capacity'), t('ltc_residents'), t('ltc_residents') / t('pop65'), ltc_year))
    print('  노인여가  {:>10,}곳   ← {}년'.format(t('community_fac'), comm_year))


if __name__ == '__main__':
    main()
