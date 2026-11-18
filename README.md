# Rider-AirGuard — 도로변 측정망 가스 격차 분석 기반 배달 라이더 권역 순환 배차 AI

> **제1회 동양AI빅데이터융합 아이디어 공모전 (AI빅데이터분야) 출품작**  
> **2학기 'R프로그래밍' 공공데이터 API 데이터 분석 실습 과제 발전형 결과물**

## 1. 프로젝트 배경 및 핵심 문제 해결

배달 라이더가 착용하는 KF94 마스크는 입자상 미세먼지($PM_{10}, PM_{2.5}$)만 여과할 뿐, 아스팔트 대로변의 차량 배기가스 유래 **가스상 오염물질($NO_2, O_3, CO$)**은 100% 통과합니다.  
일반 날씨 앱은 주거지 옥상의 **도시대기 측정망** 평균값만 보여주어 "보통"이라 알리지만, 실제 라이더가 주행하는 **도로변 대기측정망**에서는 $NO_2$·$CO$ 등 마스크 투과 가스가 크게 폭증해 만성 폐 질환 및 CO-헤모글로빈 결합에 따른 뇌 산소 저하(졸음·두통·추돌사고)를 유발합니다.

**Rider-AirGuard**는 100% 무료 오픈소스 스택(Python Flask, Leaflet.js, R/Matplotlib, Web Audio API)만으로:
1. 한국환경공단 에어코리아 실시간 API 2종(`시도별 측정정보` + `측정소별 24시간 시계열`)을 수집하고 통신점검 결측치(`-`)를 망구분 평균으로 자동 정제(`Imputation`)하여 `data.csv`를 생성합니다.
2. 라이더의 가스 누적 흡입 게이지가 임계치(80점)를 넘으면 **Web Audio API** 경고음과 함께 **배달 지연 0분으로 외곽 청정 주거 권역 행 배달 콜을 우선 매칭(권역 탈출 순환 배차)**하고 지자체 이동노동자 쉼터로 연계합니다.

---

## 2. 디렉터리 구조

```text
rider-airguard/
├── fetch_data.py          # 에어코리아 API 2종 호출, '-' 결측치 망구분 평균 정제, Fallback 자동 생성
├── data.csv               # 정제 완료된 대기오염 측정 데이터 (8개 핵심 컬럼)
├── data_meta.json         # API 상태, 결측치 정제 건수, 측정소 매핑 메타데이터
├── analysis.R             # R프로그래밍 과제 제출용 통계 분석 및 차트 시각화 스크립트
├── generate_charts.py     # 한글 폰트 깨짐 방지 300 DPI PNG 차트 2종 생성기
├── app.py                 # Python Flask 웹 관제 서버 (0.0.0.0:5000)
├── requirements.txt       # 오픈소스 Python 의존성
├── templates/index.html   # 다크 네이비 B2B/B2G 배차 관제 대시보드
└── static/
    ├── css/style.css
    ├── js/app.js
    ├── vendor/leaflet/    # 무료 오픈소스 Leaflet 1.9.4 로컬 번들
    └── charts/
        ├── chart1_network_gap.png      # 권역별 도시대기 vs 도로변대기 가스 격차 막대그래프
        └── chart2_hourly_exposure.png  # 24시간 도로변 가스 추이 및 배달 피크타임 중첩 그래프
```

---

## 3. 실행 방법

```bash
# 1. 가상환경 활성화 및 의존성 설치
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2. 공공데이터 API 수집 및 결측치 정제 (API 장애 시 자동 Fallback)
python fetch_data.py

# 3. 고해상도 통계 차트 2종 생성 (R 제출용 analysis.R 포함)
python generate_charts.py

# 4. Flask 웹 관제 서버 실행 (기본 포트 5000)
python app.py
```
