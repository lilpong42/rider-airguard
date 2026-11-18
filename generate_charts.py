#!/usr/bin/env python3
"""
generate_charts.py
Rider-AirGuard: data.csv를 읽어들여 제안서(서식 4) 및 대시보드용
고해상도(300 DPI) 통계 차트 이미지 2종을 static/charts/에 생성한다.
컨테이너 환경에서 한글 폰트 깨짐이 없도록 Noto Sans CJK KR 폰트를 직접 등록하여 렌더링한다.
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.font_manager as fm
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent
CSV_PATH = BASE_DIR / "data.csv"
META_PATH = BASE_DIR / "data_meta.json"
CHART_DIR = BASE_DIR / "static" / "charts"
CHART_DIR.mkdir(parents=True, exist_ok=True)


def setup_korean_font() -> None:
    """시스템에 설치된 Noto Sans CJK KR 폰트를 matplotlib에 등록한다."""
    font_paths = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    ]
    for fp in font_paths:
        if Path(fp).exists():
            fm.fontManager.addfont(fp)

    plt.rcParams["font.family"] = ["Noto Sans CJK KR", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False


def compute_gas_risk_index(df: pd.DataFrame) -> pd.Series:
    """
    마스크 투과 가스 복합 위험지수 (Gas Composite Risk Index):
    - NO2 (WHO 24시간 권고기준 0.0133ppm 대비 비중 * 42)
    - CO (배기가스 체감 및 뇌 산소 저하 지표 0.5ppm 대비 비중 * 22)
    - O3 (기도 점막 산화 손상 지표 0.05ppm 대비 비중 * 12)
    """
    return (
        (df["no2Value"] / 0.0133) * 42.0
        + (df["coValue"] / 0.5) * 22.0
        + (df["o3Value"] / 0.05) * 12.0
    )


def load_meta_badge() -> str:
    if META_PATH.exists():
        meta = json.loads(META_PATH.read_text(encoding="utf-8"))
        latest = meta.get("latest_data_time", "")
        mode = "에어코리아 실측 API" if meta.get("mode") == "live_api" else "백업 Fallback 통계"
        imputed = meta.get("imputed_cell_count", 0)
        return f"출처: 한국환경공단 {mode} (data.csv · {meta.get('total_rows', 0)}행 · 결측치 {imputed}건 정제 · 기준 {latest})"
    return "출처: 한국환경공단 에어코리아 API (data.csv)"


def generate_chart1_network_gap(df: pd.DataFrame) -> Path:
    """
    Chart 1: static/charts/chart1_network_gap.png
    동일 권역 내 일반 도시대기 vs 도로변 대기측정망 가스상 오염물질 농도 격차 비교 막대그래프.
    """
    regions = [
        ("강남권\n(강남구 vs 강남대로)", "강남구", "강남대로"),
        ("마포·홍대권\n(마포구 vs 신촌로[홍대입구])", "마포구", "신촌로"),
        ("도심·동대문권\n(동대문구 vs 청계천로)", "동대문구", "청계천로"),
    ]

    labels = []
    u_no2, r_no2 = [], []
    u_o3, r_o3 = [], []
    u_co, r_co = [], []
    u_risk, r_risk = [], []
    no2_gaps, risk_gaps = [], []

    for label, u_st, r_st in regions:
        du = df[df["stationName"] == u_st]
        dr = df[df["stationName"] == r_st]
        if dr.empty and r_st == "신촌로":
            dr = df[df["stationName"] == "홍대입구"]
        labels.append(label)

        un = float(du["no2Value"].mean()) * 1000.0  # ppb
        rn = float(dr["no2Value"].mean()) * 1000.0  # ppb
        uo = float(du["o3Value"].mean()) * 1000.0   # ppb
        ro = float(dr["o3Value"].mean()) * 1000.0   # ppb
        uc = float(du["coValue"].mean()) * 100.0    # x0.01 ppm (ppb*0.1 스케일 맞춤)
        rc = float(dr["coValue"].mean()) * 100.0
        ur = float(du["gas_risk"].mean())
        rr = float(dr["gas_risk"].mean())

        u_no2.append(un)
        r_no2.append(rn)
        u_o3.append(uo)
        r_o3.append(ro)
        u_co.append(uc)
        r_co.append(rc)
        u_risk.append(ur)
        r_risk.append(rr)

        no2_gaps.append(((rn - un) / un * 100.0) if un else 0.0)
        risk_gaps.append(((rr - ur) / ur * 100.0) if ur else 0.0)

    fig = plt.figure(figsize=(14.5, 7.6), dpi=300, facecolor="#0f172a")
    gs = fig.add_gridspec(1, 2, width_ratios=[1.25, 1.0], wspace=0.22, top=0.80, bottom=0.16, left=0.06, right=0.97)

    ax1 = fig.add_subplot(gs[0, 0])
    ax2 = fig.add_subplot(gs[0, 1])

    for ax in (ax1, ax2):
        ax.set_facecolor("#1e293b")
        ax.tick_params(colors="#cbd5e1", labelsize=10)
        for spine in ax.spines.values():
            spine.set_color("#334155")
        ax.grid(axis="y", linestyle="--", alpha=0.25, color="#94a3b8")
        ax.set_axisbelow(True)

    # --- 좌측 패널: 가스상 물질 3종 (NO2, CO, O3) 도시대기 vs 도로변대기 그룹 막대 ---
    x = np.arange(len(labels))
    w = 0.12

    b1 = ax1.bar(x - 2.5 * w, u_no2, width=w, color="#10b981", label="도시대기 NO₂ (ppb)", edgecolor="#064e3b", linewidth=0.6)
    b2 = ax1.bar(x - 1.5 * w, r_no2, width=w, color="#ef4444", label="도로변대기 NO₂ (ppb)", edgecolor="#7f1d1d", linewidth=0.6)
    b3 = ax1.bar(x - 0.3 * w, u_co, width=w, color="#06b6d4", alpha=0.85, label="도시대기 CO (×0.01ppm)")
    b4 = ax1.bar(x + 0.7 * w, r_co, width=w, color="#f97316", alpha=0.92, label="도로변대기 CO (×0.01ppm)")
    b5 = ax1.bar(x + 1.9 * w, u_o3, width=w, color="#60a5fa", alpha=0.78, label="도시대기 O₃ (ppb)")
    b6 = ax1.bar(x + 2.9 * w, r_o3, width=w, color="#a855f7", alpha=0.82, label="도로변대기 O₃ (ppb)")

    y1_max = max(max(r_no2), max(r_co), max(r_o3), max(u_co)) * 1.48
    ax1.set_ylim(0, y1_max)
    ax1.set_xticks(x)
    ax1.set_xticklabels(labels, color="#f1f5f9", fontsize=10, fontweight="bold")
    ax1.set_ylabel("가스 농도 (NO₂·O₃: ppb / CO: ×0.01 ppm)", color="#e2e8f0", fontsize=10.5, fontweight="bold")
    ax1.set_title("① 권역별 가스상 물질 3종(NO₂·CO·O₃) 평균 농도 비교", color="#f8fafc", fontsize=12, fontweight="bold", pad=12)

    for i in range(len(labels)):
        # NO2 수치 및 폭증 배지
        ax1.text(
            x[i] - 2.5 * w,
            u_no2[i] + 0.8,
            f"{u_no2[i]:.1f}",
            ha="center",
            va="bottom",
            color="#6ee7b7",
            fontsize=8.5,
            fontweight="bold",
        )
        ax1.text(
            x[i] - 1.5 * w,
            r_no2[i] + 0.8,
            f"{r_no2[i]:.1f}",
            ha="center",
            va="bottom",
            color="#fca5a5",
            fontsize=8.5,
            fontweight="bold",
        )
        # 도로변 NO2 괴리율 강조 콜아웃 (배기구 NO2 막대 바로 상단에 깔끔히 배치)
        gap_txt = f"NO₂ +{no2_gaps[i]:.1f}% 폭증"
        box_y = max(r_no2[i] + 10.0, max(r_co[i], r_o3[i]) + 4.5)
        ax1.annotate(
            gap_txt,
            xy=(x[i] - 1.5 * w, r_no2[i] + 3.5),
            xytext=(x[i] - 1.5 * w, box_y),
            ha="center",
            va="bottom",
            fontsize=9.2,
            fontweight="bold",
            color="#ffffff",
            bbox=dict(boxstyle="round,pad=0.30", facecolor="#dc2626", edgecolor="#fecaca", linewidth=1.0),
            arrowprops=dict(arrowstyle="->", color="#f87171", lw=1.3),
        )

    ax1.legend(
        loc="upper right",
        ncol=2,
        fontsize=8.1,
        facecolor="#0f172a",
        edgecolor="#334155",
        labelcolor="#e2e8f0",
    )

    # --- 우측 패널: 가스 복합 위험지수 (pt) 및 격차 ---
    w2 = 0.30
    br1 = ax2.bar(x - w2 / 2 - 0.02, u_risk, width=w2, color="#10b981", label="일반 도시대기 (날씨앱 기준)", edgecolor="#064e3b", zorder=3)
    br2 = ax2.bar(x + w2 / 2 + 0.02, r_risk, width=w2, color="#ef4444", label="도로변 대기측정망 (실제 라이더 호흡구역)", edgecolor="#7f1d1d", zorder=3)

    y2_max = max(max(r_risk), 100) * 1.28
    ax2.set_ylim(0, y2_max)
    ax2.axhline(80, color="#fbbf24", linestyle="--", linewidth=1.6, alpha=0.85, zorder=2)
    ax2.text(2.42, 82.0, "위험 임계치 (80점)", color="#fbbf24", fontsize=8.8, fontweight="bold", ha="right", zorder=4)

    ax2.set_xticks(x)
    ax2.set_xticklabels(labels, color="#f1f5f9", fontsize=10, fontweight="bold")
    ax2.set_ylabel("마스크 투과 가스 복합 위험지수 (점)", color="#e2e8f0", fontsize=10.5, fontweight="bold")
    ax2.set_title("② 마스크 100% 투과 가스 복합 위험지수 격차", color="#f8fafc", fontsize=12, fontweight="bold", pad=12)

    for i in range(len(labels)):
        ax2.text(
            x[i] - w2 / 2 - 0.02,
            u_risk[i] + 1.8,
            f"{u_risk[i]:.1f}점",
            ha="center",
            va="bottom",
            color="#6ee7b7",
            fontsize=9.3,
            fontweight="bold",
            zorder=5,
        )
        ax2.text(
            x[i] + w2 / 2 + 0.02,
            r_risk[i] + y2_max * 0.015,
            f"{r_risk[i]:.1f}점",
            ha="center",
            va="bottom",
            color="#fca5a5",
            fontsize=9.3,
            fontweight="bold",
            bbox=dict(boxstyle="round,pad=0.14", facecolor="#1e293b", edgecolor="none", alpha=0.92),
            zorder=5,
        )
        ax2.text(
            x[i] + w2 / 2 + 0.02,
            r_risk[i] + y2_max * 0.085,
            f"+{risk_gaps[i]:.1f}%↑",
            ha="center",
            va="bottom",
            color="#ffffff",
            fontsize=9.3,
            fontweight="bold",
            bbox=dict(boxstyle="round,pad=0.25", facecolor="#b91c1c", edgecolor="#fca5a5", linewidth=0.9),
            zorder=5,
        )

    ax2.legend(
        loc="upper left",
        fontsize=8.5,
        facecolor="#0f172a",
        edgecolor="#334155",
        labelcolor="#e2e8f0",
    )

    fig.suptitle(
        "동일 권역 내 일반 도시대기 vs 도로변 대기측정망 가스상 오염물질 농도 격차",
        color="#f8fafc",
        fontsize=15.5,
        fontweight="bold",
        y=0.95,
    )
    fig.text(
        0.5,
        0.89,
        "KF94 마스크는 미세먼지(PM)만 차단하며 대로변 가스(NO₂·CO·O₃)는 100% 투과 — 동일 행정구 내 숨겨진 가스 포켓(Gas Pocket) 규명",
        ha="center",
        color="#94a3b8",
        fontsize=10.5,
    )
    fig.text(0.5, 0.03, load_meta_badge(), ha="center", color="#64748b", fontsize=9.0)

    out_path = CHART_DIR / "chart1_network_gap.png"
    fig.savefig(out_path, dpi=300, facecolor=fig.get_facecolor())
    plt.close(fig)
    return out_path


def generate_chart2_hourly_exposure(df: pd.DataFrame) -> Path:
    """
    Chart 2: static/charts/chart2_hourly_exposure.png
    00시~23시 시간대별 도로변 가스 위험지수(빨간 실선) vs 도시대기(초록 점선) 및
    점심 피크(11~14시) · 저녁 피크(17~21시) 중첩 구간 강조.
    """
    work = df.copy()
    work["hour"] = work["dataTime"].str.slice(11, 13).astype(int) % 24

    # 핵심 비교 측정소 필터 (도시대기 3개 vs 도로변대기 3개)
    urban_df = work[work["stationName"].isin(["강남구", "마포구", "동대문구"])]
    road_df = work[work["stationName"].isin(["강남대로", "신촌로", "청계천로", "홍대입구"])]

    hours = np.arange(24)
    u_series = urban_df.groupby("hour")["gas_risk"].mean().reindex(hours).interpolate().values
    r_series = road_df.groupby("hour")["gas_risk"].mean().reindex(hours).interpolate().values

    fig, ax = plt.subplots(figsize=(14.0, 7.2), dpi=300, facecolor="#0f172a")
    fig.subplots_adjust(top=0.81, bottom=0.15, left=0.07, right=0.96)
    ax.set_facecolor("#1e293b")
    ax.tick_params(colors="#cbd5e1", labelsize=10)
    for spine in ax.spines.values():
        spine.set_color("#334155")
    ax.grid(True, linestyle="--", alpha=0.25, color="#94a3b8")
    ax.set_axisbelow(True)

    y_min = max(20.0, float(min(u_series.min(), r_series.min())) - 10.0)
    y_max = float(max(r_series.max(), 110.0)) * 1.16

    # 배달 피크타임 반투명 음영 박스 (점심 11~14시, 저녁 17~21시)
    ax.axvspan(11, 14, color="#facc15", alpha=0.16, zorder=1)
    ax.axvspan(17, 21, color="#f97316", alpha=0.19, zorder=1)

    ax.text(
        12.5,
        y_max * 0.94,
        "점심 배달 피크타임\n(11:00 ~ 14:00)",
        ha="center",
        va="top",
        color="#fde047",
        fontsize=10.5,
        fontweight="bold",
        bbox=dict(boxstyle="round,pad=0.35", facecolor="#422006", edgecolor="#facc15", alpha=0.85),
    )
    ax.text(
        19.0,
        y_max * 0.94,
        "저녁 배달 피크타임\n(17:00 ~ 21:00)",
        ha="center",
        va="top",
        color="#fdba74",
        fontsize=10.5,
        fontweight="bold",
        bbox=dict(boxstyle="round,pad=0.35", facecolor="#431407", edgecolor="#f97316", alpha=0.85),
    )

    # 두 측정망 사이의 숨겨진 가스 격차 영역 색칠
    ax.fill_between(
        hours,
        u_series,
        r_series,
        where=(r_series >= u_series),
        color="#ef4444",
        alpha=0.15,
        label="도로변 숨겨진 가스 노출 격차 (Hidden Gas Gap)",
        zorder=2,
    )

    # 임계치 라인 (80점)
    ax.axhline(80, color="#fbbf24", linestyle="-.", linewidth=1.8, alpha=0.9, zorder=3)
    ax.text(
        0.3,
        81.8,
        "순환배차 자동 발동 위험 임계치 (80점)",
        color="#fde047",
        fontsize=9.5,
        fontweight="bold",
    )

    # 도시대기 점선 (초록) & 도로변대기 굵은 실선 (빨강)
    ax.plot(
        hours,
        u_series,
        color="#10b981",
        linestyle="--",
        linewidth=2.8,
        marker="o",
        markersize=5.5,
        label="일반 도시대기 측정망 지수 (주거지·날씨앱 기준)",
        zorder=4,
    )
    ax.plot(
        hours,
        r_series,
        color="#ef4444",
        linestyle="-",
        linewidth=3.8,
        marker="o",
        markersize=7.0,
        markerfacecolor="#fee2e2",
        markeredgecolor="#dc2626",
        markeredgewidth=1.8,
        label="도로변 측정망 가스 복합 위험지수 (라이더 실주행 구간)",
        zorder=5,
    )

    # 점심/저녁 피크타임 중 최대 위험 지점 콜아웃
    lunch_slice = range(11, 15)
    lunch_peak_h = max(lunch_slice, key=lambda h: r_series[h])
    evening_slice = range(17, 22)
    evening_peak_h = max(evening_slice, key=lambda h: r_series[h])

    for pk_h, tag in [(lunch_peak_h, "점심 피크 노출"), (evening_peak_h, "저녁 피크 노출")]:
        gap_pct = (r_series[pk_h] - u_series[pk_h]) / u_series[pk_h] * 100.0
        ax.annotate(
            f"{pk_h:02d}시 {tag}\n도로변 {r_series[pk_h]:.1f}점 (도시 +{gap_pct:.1f}%)",
            xy=(pk_h, r_series[pk_h]),
            xytext=(pk_h + (0.6 if pk_h < 15 else -0.8), r_series[pk_h] + (y_max - y_min) * 0.11),
            ha="center",
            fontsize=9.0,
            fontweight="bold",
            color="#ffffff",
            bbox=dict(boxstyle="round,pad=0.3", facecolor="#991b1b", edgecolor="#fca5a5", linewidth=1.0),
            arrowprops=dict(arrowstyle="->", color="#f87171", lw=1.5),
            zorder=6,
        )

    ax.set_xlim(-0.3, 23.3)
    ax.set_ylim(y_min, y_max)
    ax.set_xticks(hours)
    ax.set_xticklabels([f"{h:02d}시" for h in hours], color="#e2e8f0", fontsize=9.0)
    ax.set_xlabel("측정 시간대 (00시 ~ 23시 · 24시간 시계열)", color="#e2e8f0", fontsize=11, fontweight="bold", labelpad=8)
    ax.set_ylabel("가스 복합 위험지수 (NO₂ · CO · O₃ 통합)", color="#e2e8f0", fontsize=11, fontweight="bold")

    ax.legend(
        loc="upper left",
        fontsize=9.3,
        facecolor="#0f172a",
        edgecolor="#334155",
        labelcolor="#f1f5f9",
    )

    fig.suptitle(
        "시간대별 도로변 가스 위험지수 추이 및 배달 콜 피크타임 노출 분석",
        color="#f8fafc",
        fontsize=15.5,
        fontweight="bold",
        y=0.95,
    )
    fig.text(
        0.5,
        0.89,
        "배달 콜이 집중되는 점심(11~14시)·저녁(17~21시) 피크와 도로변 가스 폭증 시간대가 완벽히 중첩되어 라이더 뇌 산소 저하·졸음사고 유발",
        ha="center",
        color="#94a3b8",
        fontsize=10.5,
    )
    fig.text(0.5, 0.03, load_meta_badge(), ha="center", color="#64748b", fontsize=9.0)

    out_path = CHART_DIR / "chart2_hourly_exposure.png"
    fig.savefig(out_path, dpi=300, facecolor=fig.get_facecolor())
    plt.close(fig)
    return out_path


def generate_all_charts() -> tuple[Path, Path]:
    setup_korean_font()
    df = pd.read_csv(CSV_PATH, encoding="utf-8")
    df["gas_risk"] = compute_gas_risk_index(df)
    p1 = generate_chart1_network_gap(df)
    p2 = generate_chart2_hourly_exposure(df)
    return p1, p2


if __name__ == "__main__":
    c1, c2 = generate_all_charts()
    print(f"[Rider-AirGuard] 차트 생성 완료: {c1}, {c2}")
