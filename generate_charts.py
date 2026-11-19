#!/usr/bin/env python3
"""
generate_charts.py
Rider-AirGuard: data.csv를 읽어들여 제안서(서식 4) 및 대시보드용
고해상도(300 DPI) 통계 차트 이미지 2종을 static/charts/에 생성한다.
Toss급 가독성(화이트 세라믹 표면 + 정갈한 그리드 + 고대비 타이포그래피)과
한냥(Hannyang) 골드·옵시디언 포인트 컬러를 적용하여 제안서 및 웹에서 선명하게 읽힌다.
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.font_manager as fm
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent
CSV_PATH = BASE_DIR / "data.csv"
META_PATH = BASE_DIR / "data_meta.json"
CHART_DIR = BASE_DIR / "static" / "charts"
CHART_DIR.mkdir(parents=True, exist_ok=True)

# Toss × 한냥 Ceramic Light Palette
BG_FIG = "#FFFFFF"
BG_AXES = "#FAFBFD"
INK_PRIMARY = "#0F172A"
INK_SECONDARY = "#334155"
INK_MUTED = "#64748B"
BORDER_HAIRLINE = "#CBD5E1"
GRID_LINE = "#E2E8F0"

COLOR_URBAN = "#059669"      # Emerald Green
COLOR_ROAD = "#DC2626"       # Crimson Red
COLOR_CO_URBAN = "#0284C7"   # Sky Blue
COLOR_CO_ROAD = "#EA580C"    # Warm Orange
COLOR_O3_URBAN = "#64748B"   # Cool Slate
COLOR_O3_ROAD = "#7C3AED"    # Accent Violet (Chart sub-metric)
COLOR_GOLD = "#D97706"       # 한냥 Brass Gold
COLOR_GOLD_DEEP = "#92400E"  # 한냥 Deep Brass


def setup_korean_font() -> None:
    """시스템에 설치된 한글 폰트(Noto Sans CJK / NanumGothic)를 자동 탐색해 등록한다."""
    candidate_paths = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
        "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
    ]
    detected_families: list[str] = []
    for fp in candidate_paths:
        if Path(fp).exists():
            fm.fontManager.addfont(fp)
            try:
                fam = fm.FontProperties(fname=fp).get_name()
                if fam and fam not in detected_families:
                    detected_families.append(fam)
            except Exception:
                pass

    if detected_families:
        plt.rcParams["font.family"] = detected_families + ["DejaVu Sans"]
    else:
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
        mode = "에어코리아 실측 API" if meta.get("mode") == "live_api" else "로컬 백업 Fallback 통계"
        imputed = meta.get("imputed_cell_count", 0)
        return (
            f"출처: 한국환경공단 {mode} (data.csv · {meta.get('total_rows', 0)}행 · "
            f"결측치 {imputed}건 망구분 평균 정제 · 기준 {latest})"
        )
    return "출처: 한국환경공단 에어코리아 API (data.csv)"


def _style_axes(ax: plt.Axes) -> None:
    ax.set_facecolor(BG_AXES)
    ax.tick_params(colors=INK_SECONDARY, labelsize=10)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color(BORDER_HAIRLINE)
    ax.spines["bottom"].set_color(BORDER_HAIRLINE)
    ax.spines["left"].set_linewidth(1.1)
    ax.spines["bottom"].set_linewidth(1.1)
    ax.grid(axis="y", linestyle="--", alpha=0.85, color=GRID_LINE, linewidth=0.9)
    ax.set_axisbelow(True)


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

        un = float(du["no2Value"].mean()) * 1000.0
        rn = float(dr["no2Value"].mean()) * 1000.0
        uo = float(du["o3Value"].mean()) * 1000.0
        ro = float(dr["o3Value"].mean()) * 1000.0
        uc = float(du["coValue"].mean()) * 100.0
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

    fig = plt.figure(figsize=(14.5, 7.8), dpi=300, facecolor=BG_FIG)
    gs = fig.add_gridspec(1, 2, width_ratios=[1.25, 1.0], wspace=0.22, top=0.79, bottom=0.16, left=0.06, right=0.97)

    ax1 = fig.add_subplot(gs[0, 0])
    ax2 = fig.add_subplot(gs[0, 1])

    _style_axes(ax1)
    _style_axes(ax2)

    # --- 좌측 패널: 가스상 물질 3종 (NO2, CO, O3) ---
    x = np.arange(len(labels))
    w = 0.12

    ax1.bar(x - 2.5 * w, u_no2, width=w, color=COLOR_URBAN, label="도시대기 NO₂ (ppb)", zorder=3)
    ax1.bar(x - 1.5 * w, r_no2, width=w, color=COLOR_ROAD, label="도로변대기 NO₂ (ppb)", zorder=3)
    ax1.bar(x - 0.3 * w, u_co, width=w, color=COLOR_CO_URBAN, alpha=0.88, label="도시대기 CO (×0.01ppm)", zorder=3)
    ax1.bar(x + 0.7 * w, r_co, width=w, color=COLOR_CO_ROAD, alpha=0.92, label="도로변대기 CO (×0.01ppm)", zorder=3)
    ax1.bar(x + 1.9 * w, u_o3, width=w, color="#94A3B8", alpha=0.85, label="도시대기 O₃ (ppb)", zorder=3)
    ax1.bar(x + 2.9 * w, r_o3, width=w, color=COLOR_O3_ROAD, alpha=0.78, label="도로변대기 O₃ (ppb)", zorder=3)

    y1_max = max(max(r_no2), max(r_co), max(r_o3), max(u_co)) * 1.48
    ax1.set_ylim(0, y1_max)
    ax1.set_xticks(x)
    ax1.set_xticklabels(labels, color=INK_PRIMARY, fontsize=10, fontweight="bold")
    ax1.set_ylabel("가스 농도 (NO₂·O₃: ppb / CO: ×0.01 ppm)", color=INK_SECONDARY, fontsize=10.5, fontweight="bold")
    ax1.set_title("① 권역별 가스상 물질 3종(NO₂·CO·O₃) 평균 농도", color=INK_PRIMARY, fontsize=12, fontweight="bold", pad=12)

    for i in range(len(labels)):
        ax1.text(
            x[i] - 2.5 * w,
            u_no2[i] + 0.9,
            f"{u_no2[i]:.1f}",
            ha="center",
            va="bottom",
            color="#047857",
            fontsize=8.6,
            fontweight="bold",
        )
        ax1.text(
            x[i] - 1.5 * w,
            r_no2[i] + 0.9,
            f"{r_no2[i]:.1f}",
            ha="center",
            va="bottom",
            color="#B91C1C",
            fontsize=8.6,
            fontweight="bold",
        )
        gap_txt = f"NO₂ +{no2_gaps[i]:.1f}% 폭증"
        box_y = max(r_no2[i] + 10.5, max(r_co[i], r_o3[i]) + 4.8)
        ax1.annotate(
            gap_txt,
            xy=(x[i] - 1.5 * w, r_no2[i] + 3.6),
            xytext=(x[i] - 1.5 * w, box_y),
            ha="center",
            va="bottom",
            fontsize=9.1,
            fontweight="bold",
            color="#FFFFFF",
            bbox=dict(boxstyle="round,pad=0.32", facecolor=COLOR_ROAD, edgecolor="#B91C1C", linewidth=0.8),
            arrowprops=dict(arrowstyle="->", color=COLOR_ROAD, lw=1.4),
            zorder=5,
        )

    ax1.legend(
        loc="upper right",
        ncol=2,
        fontsize=8.2,
        facecolor="#FFFFFF",
        edgecolor=BORDER_HAIRLINE,
        labelcolor=INK_SECONDARY,
        framealpha=0.95,
    )

    # --- 우측 패널: 가스 복합 위험지수 (pt) ---
    w2 = 0.30
    ax2.bar(x - w2 / 2 - 0.02, u_risk, width=w2, color=COLOR_URBAN, label="일반 도시대기 (날씨앱 기준)", zorder=3)
    ax2.bar(x + w2 / 2 + 0.02, r_risk, width=w2, color=COLOR_ROAD, label="도로변 대기측정망 (실제 호흡구역)", zorder=3)

    y2_max = max(max(r_risk), 100) * 1.32
    ax2.set_ylim(0, y2_max)
    ax2.axhline(80, color=COLOR_GOLD, linestyle="--", linewidth=1.8, alpha=0.95, zorder=2)
    ax2.text(
        2.44,
        82.2,
        "순환배차 임계 (80점)",
        color=COLOR_GOLD_DEEP,
        fontsize=8.8,
        fontweight="bold",
        ha="right",
        bbox=dict(boxstyle="round,pad=0.18", facecolor="#FFFBEB", edgecolor="#FDE68A", linewidth=0.8),
        zorder=4,
    )

    ax2.set_xticks(x)
    ax2.set_xticklabels(labels, color=INK_PRIMARY, fontsize=10, fontweight="bold")
    ax2.set_ylabel("마스크 투과 가스 복합 위험지수 (점)", color=INK_SECONDARY, fontsize=10.5, fontweight="bold")
    ax2.set_title("② 마스크 100% 투과 가스 복합 위험지수 격차", color=INK_PRIMARY, fontsize=12, fontweight="bold", pad=12)

    for i in range(len(labels)):
        ax2.text(
            x[i] - w2 / 2 - 0.02,
            u_risk[i] + 2.0,
            f"{u_risk[i]:.1f}점",
            ha="center",
            va="bottom",
            color="#047857",
            fontsize=9.4,
            fontweight="bold",
            zorder=5,
        )
        # 도로변 막대 수치 (80점 기준선과 겹치지 않게 막대 상단 안쪽 혹은 깔끔한 흰 배경 캡슐)
        score_y = r_risk[i] - 6.5 if r_risk[i] > 30 else r_risk[i] + 2.0
        score_color = "#FFFFFF" if r_risk[i] > 30 else "#B91C1C"
        ax2.text(
            x[i] + w2 / 2 + 0.02,
            score_y,
            f"{r_risk[i]:.1f}점",
            ha="center",
            va="center" if r_risk[i] > 30 else "bottom",
            color=score_color,
            fontsize=9.5,
            fontweight="bold",
            zorder=5,
        )
        badge_y = max(r_risk[i] + 5.5, 89.0 if abs(r_risk[i] - 80) < 6 else r_risk[i] + 5.5)
        ax2.text(
            x[i] + w2 / 2 + 0.02,
            badge_y,
            f"+{risk_gaps[i]:.1f}%↑",
            ha="center",
            va="bottom",
            color="#B91C1C",
            fontsize=9.2,
            fontweight="bold",
            bbox=dict(boxstyle="round,pad=0.24", facecolor="#FEF2F2", edgecolor="#FCA5A5", linewidth=1.0),
            zorder=5,
        )

    ax2.legend(
        loc="upper left",
        fontsize=8.6,
        facecolor="#FFFFFF",
        edgecolor=BORDER_HAIRLINE,
        labelcolor=INK_SECONDARY,
        framealpha=0.95,
    )

    fig.suptitle(
        "동일 권역 내 일반 도시대기 vs 도로변 대기측정망 가스상 오염물질 농도 격차",
        color=INK_PRIMARY,
        fontsize=15.5,
        fontweight="bold",
        y=0.95,
    )
    fig.text(
        0.5,
        0.885,
        "KF94 마스크는 미세먼지(PM)만 차단하며 대로변 가스(NO₂·CO·O₃)는 100% 투과 — 동일 행정구 내 히든 가스 포켓 규명",
        ha="center",
        color=INK_MUTED,
        fontsize=10.5,
    )
    fig.text(0.5, 0.03, load_meta_badge(), ha="center", color=INK_MUTED, fontsize=9.0)

    out_path = CHART_DIR / "chart1_network_gap.png"
    fig.savefig(out_path, dpi=300, facecolor=BG_FIG)
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

    urban_df = work[work["stationName"].isin(["강남구", "마포구", "동대문구"])]
    road_df = work[work["stationName"].isin(["강남대로", "신촌로", "청계천로", "홍대입구"])]

    hours = np.arange(24)
    u_series = urban_df.groupby("hour")["gas_risk"].mean().reindex(hours).interpolate().values
    r_series = road_df.groupby("hour")["gas_risk"].mean().reindex(hours).interpolate().values

    fig, ax = plt.subplots(figsize=(14.0, 7.4), dpi=300, facecolor=BG_FIG)
    fig.subplots_adjust(top=0.80, bottom=0.15, left=0.07, right=0.96)
    _style_axes(ax)
    ax.grid(True, linestyle="--", alpha=0.85, color=GRID_LINE, linewidth=0.9)

    y_min = max(20.0, float(min(u_series.min(), r_series.min())) - 10.0)
    y_max = float(max(r_series.max(), 115.0)) * 1.18

    # 배달 피크타임 음영 박스 (한냥 Warm Gold & Soft Amber)
    ax.axvspan(11, 14, color="#FEF3C7", alpha=0.65, zorder=1)
    ax.axvspan(17, 21, color="#FFEDD5", alpha=0.70, zorder=1)

    ax.text(
        12.5,
        y_max * 0.945,
        "점심 배달 피크\n(11:00 ~ 14:00)",
        ha="center",
        va="top",
        color=COLOR_GOLD_DEEP,
        fontsize=10.2,
        fontweight="bold",
        bbox=dict(boxstyle="round,pad=0.34", facecolor="#FFFBEB", edgecolor="#FCD34D", linewidth=1.1),
    )
    ax.text(
        19.0,
        y_max * 0.945,
        "저녁 배달 피크\n(17:00 ~ 21:00)",
        ha="center",
        va="top",
        color="#9A3412",
        fontsize=10.2,
        fontweight="bold",
        bbox=dict(boxstyle="round,pad=0.34", facecolor="#FFF7ED", edgecolor="#FDBA74", linewidth=1.1),
    )

    # 두 측정망 사이의 숨겨진 가스 격차 영역 색칠
    ax.fill_between(
        hours,
        u_series,
        r_series,
        where=(r_series >= u_series),
        color="#FEE2E2",
        alpha=0.55,
        label="도로변 숨겨진 가스 노출 격차 (Hidden Gas Gap)",
        zorder=2,
    )

    # 임계치 라인 (80점 - 한냥 Gold)
    ax.axhline(80, color=COLOR_GOLD, linestyle="-.", linewidth=1.8, alpha=0.95, zorder=3)
    ax.text(
        0.35,
        82.2,
        "순환배차 자동 발동 위험 임계치 (80점)",
        color=COLOR_GOLD_DEEP,
        fontsize=9.3,
        fontweight="bold",
        bbox=dict(boxstyle="round,pad=0.20", facecolor="#FFFBEB", edgecolor="#FDE68A", linewidth=0.8),
        zorder=4,
    )

    # 도시대기 점선 (에메랄드) & 도로변대기 굵은 실선 (크림슨)
    ax.plot(
        hours,
        u_series,
        color=COLOR_URBAN,
        linestyle="--",
        linewidth=2.8,
        marker="o",
        markersize=5.5,
        markerfacecolor="#FFFFFF",
        markeredgecolor=COLOR_URBAN,
        markeredgewidth=1.6,
        label="일반 도시대기 측정망 지수 (주거지·날씨앱 기준)",
        zorder=4,
    )
    ax.plot(
        hours,
        r_series,
        color=COLOR_ROAD,
        linestyle="-",
        linewidth=3.6,
        marker="o",
        markersize=7.0,
        markerfacecolor="#FFFFFF",
        markeredgecolor=COLOR_ROAD,
        markeredgewidth=2.0,
        label="도로변 측정망 가스 복합 위험지수 (라이더 실주행 구간)",
        zorder=5,
    )

    lunch_slice = range(11, 15)
    lunch_peak_h = max(lunch_slice, key=lambda h: r_series[h])
    evening_slice = range(17, 22)
    evening_peak_h = max(evening_slice, key=lambda h: r_series[h])

    for pk_h, tag, dx in [(lunch_peak_h, "점심 피크", 0.5), (evening_peak_h, "저녁 피크", -0.6)]:
        gap_pct = (r_series[pk_h] - u_series[pk_h]) / u_series[pk_h] * 100.0
        ax.annotate(
            f"{pk_h:02d}시 {tag}\n도로변 {r_series[pk_h]:.1f}점 (+{gap_pct:.1f}%)",
            xy=(pk_h, r_series[pk_h]),
            xytext=(pk_h + dx, r_series[pk_h] + (y_max - y_min) * 0.115),
            ha="center",
            fontsize=9.0,
            fontweight="bold",
            color="#FFFFFF",
            bbox=dict(boxstyle="round,pad=0.32", facecolor=COLOR_ROAD, edgecolor="#B91C1C", linewidth=0.9),
            arrowprops=dict(arrowstyle="->", color=COLOR_ROAD, lw=1.5),
            zorder=6,
        )

    ax.set_xlim(-0.35, 23.35)
    ax.set_ylim(y_min, y_max)
    ax.set_xticks(hours)
    ax.set_xticklabels([f"{h:02d}시" for h in hours], color=INK_SECONDARY, fontsize=9.0, fontweight="normal")
    ax.set_xlabel("측정 시간대 (00시 ~ 23시 · 24시간 시계열)", color=INK_SECONDARY, fontsize=11, fontweight="bold", labelpad=8)
    ax.set_ylabel("가스 복합 위험지수 (NO₂ · CO · O₃ 통합)", color=INK_SECONDARY, fontsize=11, fontweight="bold")

    ax.legend(
        loc="upper left",
        fontsize=9.2,
        facecolor="#FFFFFF",
        edgecolor=BORDER_HAIRLINE,
        labelcolor=INK_PRIMARY,
        framealpha=0.96,
    )

    fig.suptitle(
        "시간대별 도로변 가스 위험지수 추이 및 배달 콜 피크타임 노출 분석",
        color=INK_PRIMARY,
        fontsize=15.5,
        fontweight="bold",
        y=0.95,
    )
    fig.text(
        0.5,
        0.885,
        "배달 콜이 집중되는 점심(11~14시)·저녁(17~21시) 피크와 도로변 가스 폭증 시간대가 중첩되어 라이더 졸음·추돌사고 유발",
        ha="center",
        color=INK_MUTED,
        fontsize=10.5,
    )
    fig.text(0.5, 0.03, load_meta_badge(), ha="center", color=INK_MUTED, fontsize=9.0)

    out_path = CHART_DIR / "chart2_hourly_exposure.png"
    fig.savefig(out_path, dpi=300, facecolor=BG_FIG)
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
