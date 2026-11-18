#!/usr/bin/env python3
"""
build_static.py
GitHub Pages 정적 배포용 JSON 스냅샷(live / fallback) 및 Fallback 차트 이미지를 생성하고,
templates/index.html을 루트 index.html과 동기화한다.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from app import build_dashboard_payload
from fetch_data import CSV_PATH, META_PATH, fetch_and_save_data
from generate_charts import generate_all_charts

BASE_DIR = Path(__file__).resolve().parent
STATIC_DATA_DIR = BASE_DIR / "static" / "data"
CHART_DIR = BASE_DIR / "static" / "charts"
STATIC_DATA_DIR.mkdir(parents=True, exist_ok=True)


def main() -> None:
    # 1. 현재 실측 data.csv / data_meta.json 백업 보관
    orig_csv = CSV_PATH.read_text(encoding="utf-8") if CSV_PATH.exists() else None
    orig_meta = META_PATH.read_text(encoding="utf-8") if META_PATH.exists() else None

    try:
        # 2. Fallback 스냅샷 & Fallback 차트 생성
        fetch_and_save_data(force_fallback=True, timeout=5.0)
        p1, p2 = generate_all_charts()
        shutil.copy2(p1, CHART_DIR / "chart1_fallback.png")
        shutil.copy2(p2, CHART_DIR / "chart2_fallback.png")
        fallback_payload = build_dashboard_payload()
        (STATIC_DATA_DIR / "dashboard_fallback.json").write_text(
            json.dumps(fallback_payload, ensure_ascii=False),
            encoding="utf-8",
        )
    finally:
        # 3. 실측 data.csv / data_meta.json 복원 (또는 live 재수집)
        if orig_csv and orig_meta:
            CSV_PATH.write_text(orig_csv, encoding="utf-8")
            META_PATH.write_text(orig_meta, encoding="utf-8")
        else:
            fetch_and_save_data(force_fallback=False, timeout=5.0)

    # 4. 실측 Live 스냅샷 & 실측 차트 재생성
    generate_all_charts()
    live_payload = build_dashboard_payload()
    (STATIC_DATA_DIR / "dashboard_live.json").write_text(
        json.dumps(live_payload, ensure_ascii=False),
        encoding="utf-8",
    )

    # 5. templates/index.html -> 루트 index.html 동기화
    tpl = BASE_DIR / "templates" / "index.html"
    root_idx = BASE_DIR / "index.html"
    shutil.copy2(tpl, root_idx)

    print("[build_static] 생성 완료:")
    print(" -", STATIC_DATA_DIR / "dashboard_live.json")
    print(" -", STATIC_DATA_DIR / "dashboard_fallback.json")
    print(" -", CHART_DIR / "chart1_fallback.png", CHART_DIR / "chart2_fallback.png")
    print(" -", root_idx)


if __name__ == "__main__":
    main()
