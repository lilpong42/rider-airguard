#!/usr/bin/env python3
"""
fetch_data.py
Rider-AirGuard: 공공데이터포털 에어코리아(한국환경공단) 대기오염 API 2종 연동,
결측치('-') 망구분 평균 자동 정제(Imputation) 및 무중단 하이브리드 Fallback 데이터 생성 모듈.

- API 1: 시도별 실시간 측정정보 (getCtprvnRltmMesureDnsty, 서울 전체 측정소)
- API 2: 측정소별 24시간 시계열 측정정보 (getMsrstnAcctoRltmMesureDnsty)
- 출력: 루트 폴더 data.csv (8개 핵심 컬럼) 및 data_meta.json (수집/정제 메타데이터)
"""

from __future__ import annotations

import argparse
import json
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import pandas as pd
import requests

BASE_DIR = Path(__file__).resolve().parent
CSV_PATH = BASE_DIR / "data.csv"
META_PATH = BASE_DIR / "data_meta.json"
KST = timezone(timedelta(hours=9))

SERVICE_KEY = (
    os.environ.get("AIRKOREA_API_KEY", "").strip()
    or "e9d4a95c536a8636de2d9e0187ace7b7b6e5b33cd0aac623caac083c56b55347"
)
API1_URL = (
    "http://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty"
    f"?serviceKey={SERVICE_KEY}&returnType=json&numOfRows=100&pageNo=1"
    "&sidoName=%EC%84%9C%EC%9A%B8&ver=1.3"
)
API2_BASE = (
    "http://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty"
    f"?serviceKey={SERVICE_KEY}&returnType=json&numOfRows=24&pageNo=1"
)

# 비교 분석 대상 핵심 측정소 (홍대입구의 경우 에어코리아 공식 도로변 측정소 '신촌로'로 자동 매핑)
TARGET_STATIONS = [
    "강남대로",
    "강남구",
    "동대문구",
    "청계천로",
    "홍릉로",
    "홍대입구",
    "마포구",
]

REQUIRED_COLUMNS = [
    "dataTime",
    "stationName",
    "mangName",
    "pm10Value",
    "pm25Value",
    "o3Value",
    "no2Value",
    "coValue",
]

NUMERIC_COLUMNS = ["pm10Value", "pm25Value", "o3Value", "no2Value", "coValue"]


def _safe_float(val: Any) -> float | None:
    """에어코리아 '-' 또는 None 값을 결측(None)으로 변환한다."""
    if val is None:
        return None
    s = str(val).strip()
    if s in {"", "-", "null", "None", "nan", "NaN", "통신장애", "점검중"}:
        return None
    try:
        num = float(s)
        return None if math.isnan(num) or math.isinf(num) else num
    except (ValueError, TypeError):
        return None


def _parse_airkorea_response(resp_json: dict[str, Any]) -> list[dict[str, Any]]:
    """에어코리아 JSON 응답 검증 및 items 추출."""
    response = resp_json.get("response", {})
    header = response.get("header", {})
    result_code = str(header.get("resultCode", "00"))
    if header and result_code != "00":
        raise RuntimeError(f"AirKorea API error {result_code}: {header.get('resultMsg')}")
    body = response.get("body", {})
    items = body.get("items") or []
    if not isinstance(items, list):
        raise RuntimeError("Unexpected items format in AirKorea response")
    return items


def _fetch_api1(timeout: float = 5.0) -> list[dict[str, Any]]:
    """API 1: 서울시 시도별 실시간 측정정보 (도시대기 + 도로변대기 전체)."""
    resp = requests.get(API1_URL, timeout=timeout)
    resp.raise_for_status()
    items = _parse_airkorea_response(resp.json())
    rows: list[dict[str, Any]] = []
    for it in items:
        rows.append(
            {
                "dataTime": str(it.get("dataTime", "")).strip(),
                "stationName": str(it.get("stationName", "")).strip(),
                "mangName": str(it.get("mangName", "도시대기")).strip() or "도시대기",
                "pm10Value": it.get("pm10Value"),
                "pm25Value": it.get("pm25Value"),
                "o3Value": it.get("o3Value"),
                "no2Value": it.get("no2Value"),
                "coValue": it.get("coValue"),
            }
        )
    return rows


def _fetch_station_24h(station: str, timeout: float = 5.0) -> tuple[str, list[dict[str, Any]]]:
    """API 2: 특정 측정소 24시간 시계열 측정정보 호출 (DAILY 우선 + 누락 시간 MONTH 보완)."""
    resolved_station = station
    url_daily = f"{API2_BASE}&stationName={quote(station)}&dataTerm=DAILY&ver=1.3"
    resp = requests.get(url_daily, timeout=timeout)
    resp.raise_for_status()
    items = _parse_airkorea_response(resp.json())

    # 에어코리아 공식 측정소명 매핑 처리 ('홍대입구' -> 마포구 공식 도로변 측정소 '신촌로')
    if not items and station == "홍대입구":
        resolved_station = "신촌로"
        url_daily = f"{API2_BASE}&stationName={quote(resolved_station)}&dataTerm=DAILY&ver=1.3"
        resp = requests.get(url_daily, timeout=timeout)
        resp.raise_for_status()
        items = _parse_airkorea_response(resp.json())

    # 24시간 완전성 확보: DAILY에서 누락된 시각(예: 02:00)이 있으면 MONTH(24건)에서 보완
    seen_times = {str(it.get("dataTime", "")).strip() for it in items}
    if len(items) < 24:
        try:
            url_month = f"{API2_BASE}&stationName={quote(resolved_station)}&dataTerm=MONTH&ver=1.3"
            resp_m = requests.get(url_month, timeout=timeout)
            resp_m.raise_for_status()
            m_items = _parse_airkorea_response(resp_m.json())
            for it in m_items:
                dt = str(it.get("dataTime", "")).strip()
                if dt and dt not in seen_times and len(items) < 24:
                    items.append(it)
                    seen_times.add(dt)
        except Exception:
            pass

    rows: list[dict[str, Any]] = []
    for it in items:
        rows.append(
            {
                "dataTime": str(it.get("dataTime", "")).strip(),
                "stationName": resolved_station,
                "mangName": str(it.get("mangName", "도시대기")).strip() or "도시대기",
                "pm10Value": it.get("pm10Value"),
                "pm25Value": it.get("pm25Value"),
                "o3Value": it.get("o3Value"),
                "no2Value": it.get("no2Value"),
                "coValue": it.get("coValue"),
            }
        )
    return resolved_station, rows


def generate_fallback_dataset() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """
    무중단 시연용 하이브리드 백업 데이터 생성기:
    동일 권역 내 도시대기 대비 도로변대기의 NO2, O3, CO가 2.5~3.8배 높게 나타나는
    실제 에어코리아 통계 패턴의 24시간 시계열 + 서울시 주요 측정소 데이터(150+행)를 생성한다.
    일부 통신점검 결측치('-')를 포함해 정제(Imputation) 로직을 동일하게 통과시킨다.
    """
    now = datetime.now().replace(minute=0, second=0, microsecond=0)
    base_day = now.strftime("%Y-%m-%d")

    station_profiles = [
        ("강남구", "도시대기", 1.00),
        ("강남대로", "도로변대기", 3.15),
        ("마포구", "도시대기", 1.05),
        ("신촌로", "도로변대기", 3.35),
        ("동대문구", "도시대기", 0.96),
        ("청계천로", "도로변대기", 2.85),
    ]

    # 시간대별 교통·배달 피크 계수 (00시~23시: 08~10시 출근, 11~14시 점심, 17~21시 저녁 피크)
    hourly_traffic = [
        0.58, 0.50, 0.46, 0.45, 0.50, 0.62,
        0.85, 1.15, 1.38, 1.42, 1.25, 1.32,
        1.48, 1.44, 1.26, 1.18, 1.24, 1.52,
        1.68, 1.62, 1.45, 1.22, 0.96, 0.74,
    ]

    rows: list[dict[str, Any]] = []
    for idx, (station, mang, factor) in enumerate(station_profiles):
        is_road = mang == "도로변대기"
        for hour in range(24):
            dt_str = f"{base_day} {hour:02d}:00" if hour > 0 else f"{base_day} 24:00"
            t = hourly_traffic[hour]

            if not is_road:
                pm10 = round(26 + 8 * t + (idx % 3), 1)
                pm25 = round(16 + 5 * t + (idx % 2), 1)
                no2 = round((0.011 + 0.005 * t) * factor, 4)
                o3 = round(0.018 + (0.014 if 11 <= hour <= 17 else 0.004), 4)
                co = round(0.28 + 0.08 * t, 2)
            else:
                # 도로변 측정망: 미세먼지(PM10)는 도시대기와 큰 차이가 없으나 가스상(NO2/O3/CO)이 2.5~3.8배 폭증
                pm10 = round(31 + 10 * t + (idx % 4), 1)
                pm25 = round(18 + 6 * t + (idx % 3), 1)
                no2 = round((0.011 + 0.005 * t) * factor * (1.08 if hour in (11, 12, 13, 18, 19, 20) else 0.95), 4)
                o3 = round((0.020 + (0.016 if 11 <= hour <= 18 else 0.006)) * (2.55 if hour in range(10, 21) else 1.85), 4)
                co = round((0.30 + 0.09 * t) * (factor * 0.88), 2)

            # 통신점검 결측치('-') 시뮬레이션 -> Imputation 파이프라인 검증
            if (station == "강남구" and hour in (11, 12)) or (station == "청계천로" and hour == 3):
                rows.append(
                    {
                        "dataTime": dt_str,
                        "stationName": station,
                        "mangName": mang,
                        "pm10Value": "-",
                        "pm25Value": "-",
                        "o3Value": "-",
                        "no2Value": "-",
                        "coValue": "-",
                    }
                )
            else:
                rows.append(
                    {
                        "dataTime": dt_str,
                        "stationName": station,
                        "mangName": mang,
                        "pm10Value": pm10,
                        "pm25Value": pm25,
                        "o3Value": o3,
                        "no2Value": no2,
                        "coValue": co,
                    }
                )

    # 서울시 추가 권역 최신 시간대 샘플 8개 추가 (총 152행)
    extra_stations = [
        ("중구", "도시대기", 29, 18, 0.021, 0.012, 0.3),
        ("종로구", "도시대기", 28, 17, 0.020, 0.011, 0.3),
        ("한강대로", "도로변대기", 36, 21, 0.052, 0.041, 1.0),
        ("홍릉로", "도로변대기", 35, 19, 0.049, 0.036, 0.9),
        ("도산대로", "도로변대기", 37, 20, 0.054, 0.042, 1.0),
        ("서초구", "도시대기", 27, 17, 0.022, 0.013, 0.3),
        ("영등포구", "도시대기", 30, 19, 0.021, 0.013, 0.3),
        ("양천구", "도시대기", "-", "-", "-", "-", "-"),
    ]
    latest_dt = f"{base_day} 18:00"
    for st, mang, pm10, pm25, o3, no2, co in extra_stations:
        rows.append(
            {
                "dataTime": latest_dt,
                "stationName": st,
                "mangName": mang,
                "pm10Value": pm10,
                "pm25Value": pm25,
                "o3Value": o3,
                "no2Value": no2,
                "coValue": co,
            }
        )

    meta = {
        "mode": "fallback",
        "status_label": "로컬 백업 Fallback 시연 모드 (에어코리아 통계 패턴 기반)",
        "station_aliases": {"홍대입구": "신촌로"},
    }
    return rows, meta


def clean_and_impute(raw_rows: list[dict[str, Any]]) -> tuple[pd.DataFrame, dict[str, Any]]:
    """
    결측치('-') 및 None을 해당 망구분('도시대기' 또는 '도로변대기')의 정상 평균값으로 자동 대체(Imputation)한다.
    """
    df = pd.DataFrame(raw_rows)
    for col in REQUIRED_COLUMNS:
        if col not in df.columns:
            df[col] = None
    df = df[REQUIRED_COLUMNS].copy()

    # 중복 제거: 동일 (dataTime, stationName) 행 정리
    df["dataTime"] = df["dataTime"].astype(str).str.strip()
    df["stationName"] = df["stationName"].astype(str).str.strip()
    df["mangName"] = df["mangName"].astype(str).str.strip()
    df.loc[~df["mangName"].isin(["도시대기", "도로변대기"]), "mangName"] = "도시대기"
    df = df.drop_duplicates(subset=["dataTime", "stationName"], keep="first").reset_index(drop=True)

    # 수치 변환 및 결측 탐지
    imputed_records: list[dict[str, Any]] = []
    for col in NUMERIC_COLUMNS:
        df[col] = df[col].apply(_safe_float)

    # 망구분별 정상 평균값 계산 (그룹이 비었을 경우 전체 평균으로 폴백)
    group_means: dict[str, dict[str, float]] = {}
    for mang in ["도시대기", "도로변대기"]:
        sub = df[df["mangName"] == mang]
        group_means[mang] = {}
        for col in NUMERIC_COLUMNS:
            valid = sub[col].dropna()
            if len(valid) > 0:
                group_means[mang][col] = float(valid.mean())
            else:
                overall = df[col].dropna()
                group_means[mang][col] = float(overall.mean()) if len(overall) > 0 else 0.0

    # 결측치 자동 대체 수행 및 이력 기록
    rounding = {
        "pm10Value": 1,
        "pm25Value": 1,
        "o3Value": 4,
        "no2Value": 4,
        "coValue": 2,
    }
    for idx, row in df.iterrows():
        mang = row["mangName"]
        for col in NUMERIC_COLUMNS:
            if pd.isna(row[col]):
                fill_val = round(group_means[mang][col], rounding[col])
                df.at[idx, col] = fill_val
                imputed_records.append(
                    {
                        "dataTime": row["dataTime"],
                        "stationName": row["stationName"],
                        "mangName": mang,
                        "column": col,
                        "imputedValue": fill_val,
                    }
                )
            else:
                df.at[idx, col] = round(float(row[col]), rounding[col])

    # 정렬 (측정소명, 측정일시 오름차순)
    df = df.sort_values(by=["stationName", "dataTime"]).reset_index(drop=True)

    impute_summary = {
        "imputed_cell_count": len(imputed_records),
        "imputed_station_count": len({r["stationName"] for r in imputed_records}),
        "group_means": {
            mang: {col: round(val, rounding[col]) for col, val in cols.items()}
            for mang, cols in group_means.items()
        },
        "imputed_samples": imputed_records[:15],
    }
    return df, impute_summary


def fetch_and_save_data(force_fallback: bool = False, timeout: float = 5.0) -> dict[str, Any]:
    """실제 에어코리아 API 호출 -> 실패 시 자동 Fallback -> 결측치 정제 -> data.csv 저장."""
    raw_rows: list[dict[str, Any]] = []
    meta_info: dict[str, Any] = {
        "mode": "live_api",
        "status_label": "한국환경공단 에어코리아 v1.3 연동 완료 (실시간 API 실측)",
        "station_aliases": {},
        "api_errors": [],
    }

    if force_fallback:
        raw_rows, fb_meta = generate_fallback_dataset()
        meta_info.update(fb_meta)
    else:
        try:
            api1_rows = _fetch_api1(timeout=timeout)
            raw_rows.extend(api1_rows)

            station_aliases: dict[str, str] = {}
            for st in TARGET_STATIONS:
                resolved, st_rows = _fetch_station_24h(st, timeout=timeout)
                if resolved != st:
                    station_aliases[st] = resolved
                raw_rows.extend(st_rows)

            meta_info["station_aliases"] = station_aliases
            if len(raw_rows) < 60:
                raise RuntimeError(f"Insufficient API rows ({len(raw_rows)} < 60)")
        except Exception as exc:
            meta_info["api_errors"].append(str(exc))
            raw_rows, fb_meta = generate_fallback_dataset()
            meta_info.update(fb_meta)

    df, impute_summary = clean_and_impute(raw_rows)
    df.to_csv(CSV_PATH, index=False, encoding="utf-8")

    meta_info.update(
        {
            "fetched_at": datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S KST"),
            "total_rows": int(len(df)),
            "station_count": int(df["stationName"].nunique()),
            "urban_rows": int((df["mangName"] == "도시대기").sum()),
            "road_rows": int((df["mangName"] == "도로변대기").sum()),
            "latest_data_time": str(df["dataTime"].max()) if len(df) else "",
            **impute_summary,
        }
    )
    META_PATH.write_text(json.dumps(meta_info, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta_info


def main() -> None:
    parser = argparse.ArgumentParser(description="Rider-AirGuard 에어코리아 데이터 수집 및 결측치 정제기")
    parser.add_argument("--fallback", action="store_true", help="로컬 백업 Fallback 모드로 강제 실행")
    parser.add_argument("--timeout", type=float, default=5.0, help="API 요청 타임아웃(초)")
    args = parser.parse_args()

    meta = fetch_and_save_data(force_fallback=args.fallback, timeout=args.timeout)
    print(f"[Rider-AirGuard] 수집 모드: {meta['mode']} | {meta['status_label']}")
    print(f"[Rider-AirGuard] 저장 완료: {CSV_PATH} (총 {meta['total_rows']}행, {meta['station_count']}개 측정소)")
    print(
        f"[Rider-AirGuard] 결측치('-') 자동 정제: {meta['imputed_cell_count']}건 "
        f"({meta['imputed_station_count']}개 측정소 망구분 평균 Imputation 완료)"
    )
    if meta.get("station_aliases"):
        print(f"[Rider-AirGuard] 측정소 매핑: {meta['station_aliases']}")


if __name__ == "__main__":
    main()
