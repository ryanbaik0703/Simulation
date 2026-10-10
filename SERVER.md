# 학교 서버(SSH)에서 실행하기

서버에서는 두 가지를 할 수 있습니다.

1. **배치 실행**: 정책 시나리오를 대량으로 반복 실행합니다. 서버 CPU 코어를 모두 써서 병렬 처리합니다.
2. **화면 띄우기**: 서버에서 웹 서버를 켜고, SSH 터널로 내 노트북 브라우저에서 엽니다.

아래 명령은 모두 **서버에 SSH로 접속한 터미널**에서 실행합니다. `<아이디>`, `<서버주소>`는 본인 것으로 바꾸세요.

## 1. 서버 확인

```bash
nproc
```

CPU 코어 수가 나옵니다. 많을수록 배치가 빠릅니다.

```bash
node -v
```

`v18` 이상이 나오면 2단계를 건너뛰세요.

## 2. Node.js 설치 (관리자 권한 없이, 내 계정에만)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

```bash
source ~/.bashrc
```

```bash
nvm install 20
```

## 3. 프로젝트 올리기

**내 PC(Windows)의 터미널**에서 실행합니다.

```bash
scp -r C:/Users/Keyhyun/Desktop/vscode/simulation <아이디>@<서버주소>:~/
```

## 4. 배치 실행

```bash
cd ~/simulation
```

먼저 작게 돌려서 동작을 확인합니다.

```bash
node batch/run.js --config batch/scenarios.example.json --reps 2 --days 90
```

문제가 없으면 본 실행을 합니다. SSH 연결이 끊겨도 계속 돌도록 `nohup`으로 실행합니다.

```bash
nohup node batch/run.js --config batch/scenarios.example.json > batch.log 2>&1 &
```

진행 상황은 이렇게 봅니다.

```bash
tail -f batch.log
```

공용 서버라면 다른 사람을 위해 코어 일부만 쓰는 것이 좋습니다(예: `--threads 16`).

### 설정 파일 (`batch/scenarios.example.json`)

| 항목 | 의미 |
|---|---|
| `days` | 시뮬레이션 기간 (1825 = 5년) |
| `reps` | 시나리오당 반복 횟수 (신뢰구간 계산용, 30회 이상 권장) |
| `scale` | 에이전트 1명 = 실제 몇 명 (작을수록 정밀하지만 느림) |
| `targets` | 정책 대상 자치구 (`"all"`이면 전체) |
| `params` | 파라미터 덮어쓰기 (예: `{"or_alone": 1.4}`) |
| `policy` | 모든 시나리오에 공통으로 적용할 정책 값 |
| `grid` | 바꿔가며 비교할 정책 값. 모든 조합을 실행 (예: 4 × 3 = 12개 시나리오) |

`grid`에 넣을 수 있는 값: `visit_teams`, `homecare_expand`, `outreach`, `ltc_expand`, `discharge_link`, `priority_alone`, `start_day`

### 결과 (`results/<이름>_<날짜시간>/`)

| 파일 | 내용 |
|---|---|
| `summary.csv` | 시나리오 × 지표별 평균, 정책 효과(대응표본 차이), 95% 신뢰구간, 유의성 |
| `cost.csv` | 시나리오별 총비용, 돌봄 미충족 1인·일 줄이는 데 드는 비용, 입원 1건 줄이는 데 드는 비용 |
| `raw.csv` | 반복 1회 = 1행. R이나 Python으로 추가 분석(회귀, 분포 그림)할 때 사용 |
| `summary.json` | 위 내용과 실행 설정 전체 |

결과를 내 PC로 가져오려면 **내 PC 터미널**에서 실행합니다.

```bash
scp -r <아이디>@<서버주소>:~/simulation/results C:/Users/Keyhyun/Desktop/vscode/simulation/
```

## 5. 화면을 서버에서 띄우고 내 브라우저로 보기 (선택)

서버에서:

```bash
cd ~/simulation && python3 serve.py 8765
```

**내 PC 터미널**에서 SSH 터널을 엽니다.

```bash
ssh -L 8765:localhost:8765 <아이디>@<서버주소>
```

그다음 내 브라우저에서 http://localhost:8765 를 엽니다.

참고로 화면 애니메이션은 계산을 **내 브라우저**에서 하므로, 이 방법은 공유용이지 속도 향상용이 아닙니다. 속도가 필요한 대량 계산은 4단계 배치로 하세요.
