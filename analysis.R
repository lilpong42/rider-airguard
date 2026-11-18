# ==============================================================================
# analysis.R
# 「제1회 동양AI빅데이터융합 아이디어 공모전(AI빅데이터분야)」 출품작 및
# 2학기 'R프로그래밍' 공공데이터 API 데이터 분석 실습 과제 증빙용 R 스크립트
#
# 프로젝트: Rider-AirGuard (도로변 측정망 가스 격차 분석 기반 배달 라이더 권역 순환 배차 AI)
# 데이터: fetch_data.py로 에어코리아 API 2종에서 수집·정제한 data.csv
# 산출물:
#   1) static/charts/chart1_network_gap.png   (동일 권역 내 도시대기 vs 도로변 가스 격차 막대그래프)
#   2) static/charts/chart2_hourly_exposure.png (24시간 도로변 가스 추이 및 배달 피크타임 노출 그래프)
# ==============================================================================

# 1. 데이터 로드 및 결측치 정제 검증
air_data <- read.csv("data.csv", stringsAsFactors = FALSE, fileEncoding = "UTF-8")
cat("=== [1] 데이터 기본 구조 및 결측치 점검 ===\n")
cat(sprintf("총 관측 행 수: %d행 | 측정소 수: %d개\n", nrow(air_data), length(unique(air_data$stationName))))
cat(sprintf("결측치(NA) 잔여 개수: %d개\n", sum(is.na(air_data))))

# 수치형 컬럼 변환 확인
num_cols <- c("pm10Value", "pm25Value", "o3Value", "no2Value", "coValue")
for (col in num_cols) {
  air_data[[col]] <- as.numeric(air_data[[col]])
}

# 2. 마스크 투과 가스 복합 위험지수 (Gas Composite Risk Index) 산출
# - KF94 마스크는 입자상 미세먼지(PM10/PM2.5)만 차단하며 가스상(NO2, CO, O3)은 100% 통과함
# - WHO 일평균 권고기준(NO2 0.0133ppm) 및 CO 혈중 헤모글로빈 결합 가중치를 반영한 복합 지수
air_data$gas_risk_index <- round(
  (air_data$no2Value / 0.0133) * 42.0 +
  (air_data$coValue / 0.5) * 22.0 +
  (air_data$o3Value / 0.05) * 12.0,
  2
)

# 측정망 유형별 요약 통계
cat("\n=== [2] 망구분(도시대기 vs 도로변대기) 평균 비교 ===\n")
mang_summary <- aggregate(
  cbind(pm10Value, pm25Value, no2Value, o3Value, coValue, gas_risk_index) ~ mangName,
  data = air_data,
  FUN = mean
)
print(mang_summary)

# 3. 3대 핵심 배달 권역(강남권, 마포·홍대권, 도심·동대문권) 격차 분석
regions <- list(
  list(name = "강남권\n(강남구 vs 강남대로)", urban = "강남구", road = "강남대로"),
  list(name = "마포·홍대권\n(마포구 vs 신촌로[홍대])", urban = "마포구", road = "신촌로"),
  list(name = "도심·동대문권\n(동대문구 vs 청계천로)", urban = "동대문구", road = "청계천로")
)

region_labels <- sapply(regions, function(r) r$name)
urban_no2 <- numeric(length(regions))
road_no2  <- numeric(length(regions))
urban_o3  <- numeric(length(regions))
road_o3   <- numeric(length(regions))
urban_co  <- numeric(length(regions))
road_co   <- numeric(length(regions))
urban_risk <- numeric(length(regions))
road_risk  <- numeric(length(regions))
no2_gap_pct <- numeric(length(regions))

for (i in seq_along(regions)) {
  u_df <- subset(air_data, stationName == regions[[i]]$urban)
  r_df <- subset(air_data, stationName == regions[[i]]$road)

  urban_no2[i]  <- mean(u_df$no2Value) * 1000  # ppb 단위 환산
  road_no2[i]   <- mean(r_df$no2Value) * 1000
  urban_o3[i]   <- mean(u_df$o3Value) * 1000   # ppb 단위 환산
  road_o3[i]    <- mean(r_df$o3Value) * 1000
  urban_co[i]   <- mean(u_df$coValue) * 100    # x0.01 ppm 환산 (시각화 스케일 통일)
  road_co[i]    <- mean(r_df$coValue) * 100
  urban_risk[i] <- mean(u_df$gas_risk_index)
  road_risk[i]  <- mean(r_df$gas_risk_index)
  no2_gap_pct[i] <- round((road_no2[i] - urban_no2[i]) / urban_no2[i] * 100, 1)
}

cat("\n=== [3] 권역별 이산화질소(NO2) 및 복합 위험지수 격차 ===\n")
for (i in seq_along(regions)) {
  cat(sprintf(
    "%s | NO2: 도시 %.1f ppb vs 도로변 %.1f ppb (+%.1f%% 폭증) | 위험지수: %.1f vs %.1f\n",
    gsub("\n", " ", region_labels[i]), urban_no2[i], road_no2[i], no2_gap_pct[i], urban_risk[i], road_risk[i]
  ))
}

# 4. 고해상도 PNG 차트 생성 준비
dir.create("static/charts", recursive = TRUE, showWarnings = FALSE)

# OS 환경에 맞는 한글 폰트 설정
font_family <- ifelse(.Platform$OS.type == "windows", "Malgun Gothic", "Noto Sans CJK KR")

# ------------------------------------------------------------------------------
# Chart 1: static/charts/chart1_network_gap.png (측정망 간 가스 농도 격차 막대그래프)
# ------------------------------------------------------------------------------
png("static/charts/chart1_network_gap.png", width = 2400, height = 1350, res = 220)
par(mfrow = c(1, 2), mar = c(6, 5, 5, 2), oma = c(1, 0, 3, 0), family = font_family)

# 좌측: NO2(ppb) 도시대기 vs 도로변대기 비교
no2_mat <- rbind(urban_no2, road_no2)
bp1 <- barplot(
  no2_mat,
  beside = TRUE,
  names.arg = region_labels,
  col = c("#10B981", "#EF4444"),
  ylim = c(0, max(road_no2) * 1.35),
  ylab = "이산화질소(NO2) 평균 농도 (ppb)",
  main = "마스크 100% 투과 NO2 농도 격차",
  border = NA
)
grid(nx = NA, ny = NULL, lty = 3, col = "#CBD5E1")
legend("topright", legend = c("도시대기 (주거지)", "도로변대기 (대로변)"), fill = c("#10B981", "#EF4444"), bty = "n")
for (i in seq_along(regions)) {
  text(bp1[2, i], road_no2[i] + max(road_no2) * 0.08,
       labels = sprintf("+%.1f%% 폭증", no2_gap_pct[i]),
       col = "#DC2626", font = 2, cex = 0.95)
}

# 우측: 가스 복합 위험지수 (NO2 + CO + O3)
risk_mat <- rbind(urban_risk, road_risk)
bp2 <- barplot(
  risk_mat,
  beside = TRUE,
  names.arg = region_labels,
  col = c("#34D399", "#F97316"),
  ylim = c(0, max(road_risk, 100) * 1.25),
  ylab = "가스 복합 위험지수 (pt)",
  main = "마스크 투과 가스 복합 위험지수 비교",
  border = NA
)
abline(h = 80, col = "#DC2626", lty = 2, lwd = 2)
legend("topright", legend = c("도시대기 위험지수", "도로변대기 위험지수", "80점 순환배차 임계치"),
       fill = c("#34D399", "#F97316", NA), border = NA, lty = c(NA, NA, 2), col = c(NA, NA, "#DC2626"), bty = "n")
for (i in seq_along(regions)) {
  gap_r <- round((road_risk[i] - urban_risk[i]) / urban_risk[i] * 100, 1)
  text(bp2[2, i], road_risk[i] + 5, labels = sprintf("+%.1f%%", gap_r), col = "#EA580C", font = 2, cex = 0.95)
}

mtext("동일 권역 내 일반 도시대기 vs 도로변 대기측정망 가스상 오염물질 농도 격차",
      outer = TRUE, cex = 1.35, font = 2)
dev.off()

# ------------------------------------------------------------------------------
# Chart 2: static/charts/chart2_hourly_exposure.png (24시간 추이 및 피크타임 분석)
# ------------------------------------------------------------------------------
air_data$hour <- as.integer(substr(air_data$dataTime, 12, 13)) %% 24

urban_target <- subset(air_data, stationName %in% c("강남구", "마포구", "동대문구"))
road_target  <- subset(air_data, stationName %in% c("강남대로", "신촌로", "청계천로"))

hourly_urban <- aggregate(gas_risk_index ~ hour, data = urban_target, FUN = mean)
hourly_road  <- aggregate(gas_risk_index ~ hour, data = road_target, FUN = mean)
hourly_merged <- merge(hourly_urban, hourly_road, by = "hour", suffixes = c("_urban", "_road"))
hourly_merged <- hourly_merged[order(hourly_merged$hour), ]

png("static/charts/chart2_hourly_exposure.png", width = 2400, height = 1350, res = 220)
par(mar = c(5, 5, 5, 2), family = font_family)

y_max <- max(hourly_merged$gas_risk_index_road, 110) * 1.15
plot(
  hourly_merged$hour, hourly_merged$gas_risk_index_road,
  type = "n",
  xlim = c(0, 23), ylim = c(25, y_max),
  xaxt = "n",
  xlab = "시간대 (00시 ~ 23시)",
  ylab = "가스 복합 위험지수 (NO2 · CO · O3 통합 지수)",
  main = "시간대별 도로변 가스 위험지수 추이 및 배달 콜 피크타임 노출 분석"
)
axis(1, at = 0:23, labels = sprintf("%02d시", 0:23), las = 2, cex.axis = 0.85)
grid(lty = 3, col = "#CBD5E1")

# 점심 피크 (11~14시) 및 저녁 피크 (17~21시) 반투명 음영 박스
rect(11, 25, 14, y_max, col = rgb(245/255, 158/255, 11/255, 0.18), border = NA)
rect(17, 25, 21, y_max, col = rgb(249/255, 115/255, 22/255, 0.20), border = NA)
text(12.5, y_max * 0.95, "점심 피크\n(11~14시)", col = "#B45309", font = 2, cex = 0.95)
text(19.0, y_max * 0.95, "저녁 피크\n(17~21시)", col = "#C2410C", font = 2, cex = 0.95)

# 위험 임계치 기준선 (80점)
abline(h = 80, col = "#DC2626", lty = 2, lwd = 2)
text(1.5, 83, "위험 임계치 (80pt) - 순환배차 발동", col = "#DC2626", pos = 4, font = 2, cex = 0.85)

# 시계열 꺾은선 그리기
lines(hourly_merged$hour, hourly_merged$gas_risk_index_urban,
      col = "#10B981", lty = 2, lwd = 2.6, type = "o", pch = 16, cex = 0.8)
lines(hourly_merged$hour, hourly_merged$gas_risk_index_road,
      col = "#EF4444", lty = 1, lwd = 3.5, type = "o", pch = 19, cex = 1.0)

legend(
  "topleft",
  legend = c("도로변 측정망 가스 복합 위험지수", "일반 도시대기 측정망 지수 (날씨앱 기준)"),
  col = c("#EF4444", "#10B981"),
  lty = c(1, 2),
  lwd = c(3.5, 2.6),
  pch = c(19, 16),
  bg = "white",
  box.col = "#CBD5E1"
)
dev.off()

cat("\n[완료] analysis.R 통계 분석 및 차트 PNG 2종 생성 코드 실행 완료.\n")
