/* Rider-AirGuard Frontend Control & Simulator Logic */
(() => {
  "use strict";

  const state = {
    dashboard: null,
    activeRegionKey: "gangnam",
    simStep: 0, // 0 -> 1(30점) -> 2(65점) -> 3(92점 임계치 돌파)
    simScore: 0,
    audioEnabled: true,
    tileMode: "dark", // "dark" | "osm"
    showAllStations: false,
    map: null,
    tileLayer: null,
    regionLayer: null,
    allStationsLayer: null,
    riderMarker: null,
    riderAnimTimer: null,
    rCodeCached: null,
  };

  const SIM_STEPS = [
    {
      score: 0,
      badge: "대기 (0분)",
      cohb: "0.8 %",
      alertText: "정상 (집중 양호)",
      alertClass: "text-emerald",
      no2Multiplier: 1.0,
    },
    {
      score: 30,
      badge: "누적 30분 운행",
      cohb: "1.9 %",
      alertText: "주의 (초기 기도 자극)",
      alertClass: "text-sky",
      no2Multiplier: 1.35,
    },
    {
      score: 65,
      badge: "누적 60분 운행",
      cohb: "3.4 %",
      alertText: "경고 (경미한 두통·피로)",
      alertClass: "text-amber",
      no2Multiplier: 1.85,
    },
    {
      score: 92,
      badge: "임계치 돌파 (90분)",
      cohb: "5.2 %",
      alertText: "🚨 위험 (졸음·추돌 고위험)",
      alertClass: "text-rose",
      no2Multiplier: 2.35,
    },
  ];

  // --- Web Audio API 경고음 합성 (외부 오디오 파일 없이 100% 브라우저 내장 Oscillator 사용) ---
  function playEmergencyChime() {
    if (!state.audioEnabled) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    try {
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      const pattern = [
        { freq: 880, start: 0.0, dur: 0.14 },
        { freq: 1174.66, start: 0.16, dur: 0.14 },
        { freq: 880, start: 0.34, dur: 0.14 },
        { freq: 1318.51, start: 0.50, dur: 0.28 },
      ];
      pattern.forEach((tone) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(tone.freq, now + tone.start);

        gain.gain.setValueAtTime(0.001, now + tone.start);
        gain.gain.exponentialRampToValueAtTime(0.22, now + tone.start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + tone.start + tone.dur);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + tone.start);
        osc.stop(now + tone.start + tone.dur + 0.02);
      });
    } catch (err) {
      console.warn("Web Audio alert suppressed:", err);
    }
  }

  function playStepTick(step) {
    if (!state.audioEnabled) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    try {
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(step === 1 ? 520 : 660, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.13);
    } catch (_) {}
  }

  // --- Leaflet 지도 초기화 ---
  function initMap() {
    state.map = L.map("dispatchMap", {
      center: [37.5015, 127.0335],
      zoom: 13.5,
      zoomSnap: 0.5,
      zoomControl: true,
    });
    // 타일 로딩 전/오프라인 대비 한강 및 주요 간선도로 초경량 벡터 배경 레이어
    const hanRiver = [
      [37.575, 126.805],
      [37.554, 126.865],
      [37.542, 126.905],
      [37.523, 126.935],
      [37.515, 126.978],
      [37.526, 127.022],
      [37.530, 127.065],
      [37.548, 127.115],
    ];
    L.polyline(hanRiver, {
      color: "#1d4ed8",
      weight: 18,
      opacity: 0.16,
      interactive: false,
    }).addTo(state.map);

    setTileLayer("dark");
    state.regionLayer = L.layerGroup().addTo(state.map);
    state.allStationsLayer = L.layerGroup();
  }

  function setTileLayer(mode) {
    state.tileMode = mode;
    if (state.tileLayer) {
      state.map.removeLayer(state.tileLayer);
    }
    const url = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    const attribution = "&copy; OpenStreetMap contributors (100% Free Open-Source)";

    state.tileLayer = L.tileLayer(url, {
      attribution,
      maxZoom: 19,
    }).addTo(state.map);

    const mapEl = document.getElementById("dispatchMap");
    if (mapEl) {
      mapEl.classList.toggle("map-dark-tiles", mode === "dark");
    }

    const btn = document.getElementById("btnTileToggle");
    if (btn) {
      btn.textContent = mode === "dark" ? "지도 테마: 다크" : "지도 테마: OSM 기본";
    }
  }

  function renderAllStationsLayer() {
    state.allStationsLayer.clearLayers();
    if (!state.dashboard || !state.showAllStations) {
      state.map.removeLayer(state.allStationsLayer);
      return;
    }
    state.dashboard.all_stations.forEach((st) => {
      const isRoad = st.mangName === "도로변대기";
      const marker = L.circleMarker(st.coords, {
        radius: isRoad ? 7 : 5,
        color: isRoad ? "#f87171" : "#34d399",
        fillColor: isRoad ? "#ef4444" : "#10b981",
        fillOpacity: 0.72,
        weight: 1.5,
      });
      marker.bindPopup(
        `<strong>${st.stationName}</strong> (${st.mangName})<br/>` +
          `측정시각: ${st.dataTime}<br/>` +
          `NO₂: <b>${st.no2Value} ppm</b> · CO: ${st.coValue} ppm · O₃: ${st.o3Value} ppm<br/>` +
          `PM10: ${st.pm10Value} ㎍/㎥ · 위험지수: <b>${st.gasRisk}점</b>`
      );
      marker.addTo(state.allStationsLayer);
    });
    state.allStationsLayer.addTo(state.map);
  }

  function animateRiderAlongRoute(coords) {
    if (state.riderAnimTimer) {
      clearInterval(state.riderAnimTimer);
      state.riderAnimTimer = null;
    }
    if (!coords || coords.length < 2) return;

    const riderIcon = L.divIcon({
      className: "",
      html: `<div class="rider-pin" title="라이더 김성원 실시간 위치">🛵</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });

    let segIdx = 0;
    let t = 0;
    state.riderMarker = L.marker(coords[0], { icon: riderIcon, zIndexOffset: 900 }).addTo(state.regionLayer);
    state.riderMarker.bindPopup("<strong>라이더 김성원</strong><br/>실시간 호흡기 가스 노출 관제 중");

    state.riderAnimTimer = setInterval(() => {
      if (!state.riderMarker) return;
      t += 0.05;
      if (t >= 1) {
        t = 0;
        segIdx = (segIdx + 1) % (coords.length - 1);
      }
      const p1 = coords[segIdx];
      const p2 = coords[segIdx + 1];
      const lat = p1[0] + (p2[0] - p1[0]) * t;
      const lng = p1[1] + (p2[1] - p1[1]) * t;
      state.riderMarker.setLatLng([lat, lng]);
    }, 120);
  }

  function renderRegionMap(region) {
    state.regionLayer.clearLayers();
    const isEscaped = state.simScore >= 80;

    // 1. 도로변 히든 가스 포켓 반투명 경고 원
    L.circle(region.road.coords, {
      radius: 520,
      color: "#ef4444",
      weight: 1.5,
      dashArray: "6 6",
      fillColor: "#ef4444",
      fillOpacity: isEscaped ? 0.12 : 0.24,
    }).addTo(state.regionLayer);

    // 2. 도시대기 측정소 (초록색 안전 마커)
    const urbanIcon = L.divIcon({
      className: "",
      html: `<div class="urban-pin"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    const urbanMarker = L.marker(region.urban.coords, { icon: urbanIcon }).addTo(state.regionLayer);
    urbanMarker.bindTooltip(
      `도시대기 [${region.urban.stationName}] · 일반 날씨앱 예보: ${region.urban.weather_grade}`,
      { direction: "top", offset: [0, -10] }
    );
    urbanMarker.bindPopup(
      `<strong>🟢 도시대기 측정소: ${region.urban.stationName}</strong><br/>` +
        `일반 날씨앱 예보: <b>${region.urban.weather_grade}</b> (PM10 ${region.urban.pm10_mean} ㎍/㎥)<br/>` +
        `NO₂ 평균: ${region.urban.no2_mean} ppm · CO: ${region.urban.co_mean} ppm<br/>` +
        `복합 가스 위험지수: <b>${region.urban.risk_mean}점</b>`
    );

    // 3. 도로변 대기측정소 (붉은색 펄스 마커)
    const roadIcon = L.divIcon({
      className: "",
      html: `<div class="pulse-marker-wrap"><div class="pulse-ring"></div><div class="pulse-core"></div></div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const roadMarker = L.marker(region.road.coords, { icon: roadIcon, zIndexOffset: 500 }).addTo(state.regionLayer);
    roadMarker.bindTooltip(
      `도로변 [${region.road.displayName}] · NO₂ +${region.road.gap_no2_pct}% 폭증 (마스크 투과 위험)`,
      { direction: "top", offset: [0, -14] }
    );
    roadMarker.bindPopup(
      `<strong>🔴 도로변 대기측정소: ${region.road.displayName}</strong><br/>` +
        `<span style="color:#fca5a5;">실제 도로변 가스: ${region.road.road_grade}</span><br/>` +
        `NO₂ 평균: <b>${region.road.no2_mean} ppm</b> (도시대기 대비 <b>+${region.road.gap_no2_pct}%</b>)<br/>` +
        `피크타임 NO₂: <b>${region.road.no2_peak} ppm</b> (+${region.road.gap_no2_peak_pct}%)<br/>` +
        `※ KF94 마스크 가스 방어율 0% (100% 투과)`
    );

    // 4. 지자체 이동노동자 쉼터 (파란색 쉴드 마커)
    region.shelters.forEach((sh) => {
      const shIcon = L.divIcon({
        className: "",
        html: `<div class="shelter-pin" title="${sh.name}">🛡️</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      const sm = L.marker(sh.coords, { icon: shIcon, zIndexOffset: 400 }).addTo(state.regionLayer);
      sm.bindTooltip(`이동노동자 쉼터: ${sh.name}`, { direction: "top", offset: [0, -12] });
      sm.bindPopup(
        `<strong>🛡️ ${sh.name}</strong><br/>` +
          `위치: ${sh.address}<br/>` +
          `운영: ${sh.hours}`
      );
    });

    // 5. 배차 경로 전환 (기본: 붉은 대로변 점선 / 80점 돌파: 초록·시안 청정 외곽 순환 배차)
    if (!isEscaped) {
      const dangerPoly = L.polyline(region.danger_route, {
        color: "#ef4444",
        weight: 5,
        opacity: 0.9,
        dashArray: "10 8",
      }).addTo(state.regionLayer);
      dangerPoly.bindTooltip("고농도 매연 노출 대로변 상권 반복 루트", { sticky: true });
      animateRiderAlongRoute(region.danger_route);
    } else {
      // 기존 위험 경로를 흐리게 남기고 청정 탈출 경로를 강렬하게 표시
      L.polyline(region.danger_route, {
        color: "#ef4444",
        weight: 3,
        opacity: 0.28,
        dashArray: "6 8",
      }).addTo(state.regionLayer);

      const escapePoly = L.polyline(region.escape_route, {
        color: "#10b981",
        weight: 6,
        opacity: 0.95,
      }).addTo(state.regionLayer);
      escapePoly.bindTooltip("지연 0분! 외곽 청정 주거권역 우선 순환 배차 루트", { sticky: true });

      // 쉼터 경유 하이라이트 서클
      L.circle(region.shelters[0].coords, {
        radius: 140,
        color: "#38bdf8",
        weight: 2,
        fillColor: "#38bdf8",
        fillOpacity: 0.22,
      }).addTo(state.regionLayer);

      animateRiderAlongRoute(region.escape_route);
    }
  }

  // --- 권역 UI & KPI & 브리핑 업데이트 ---
  function renderActiveRegion(fly = true) {
    if (!state.dashboard) return;
    const region = state.dashboard.regions[state.activeRegionKey];
    if (!region) return;

    // 탭 active 상태
    document.querySelectorAll(".region-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.region === state.activeRegionKey);
    });

    // KPI 업데이트
    document.getElementById("kpiUrbanName").textContent = region.urban.stationName;
    document.getElementById("kpiUrbanPm10").textContent = `${region.urban.pm10_mean} ㎍/㎥`;
    document.getElementById("kpiUrbanGrade").textContent = region.urban.weather_grade;
    document.getElementById("kpiUrbanSub").textContent =
      `NO₂ ${region.urban.no2_mean} ppm · 가스 위험지수 ${region.urban.risk_mean}점`;

    document.getElementById("kpiRoadName").textContent = region.road.displayName;
    document.getElementById("kpiRoadNo2").textContent = `${region.road.no2_mean} ppm`;
    document.getElementById("kpiGapBadge").textContent = `NO₂ +${region.road.gap_no2_pct}% 폭증`;
    document.getElementById("kpiRoadSub").textContent =
      `KF94 마스크 가스 방어율 0% · 피크 ${region.road.no2_peak} ppm (+${region.road.gap_no2_peak_pct}%)`;

    document.getElementById("kpiRiskPeak").textContent = `${region.road.risk_peak} 점`;
    document.getElementById("kpiRiskGrade").textContent = region.road.road_grade;
    document.getElementById("kpiRiskSub").textContent =
      `24h 평균 ${region.road.risk_mean}점 (도시대기 대비 +${region.road.gap_risk_pct}%)`;

    // 지도 부제 및 이동
    document.getElementById("mapSubtitle").textContent =
      `${region.name} · ${region.urban.stationName}(도시대기) vs ${region.road.displayName} 격차 분석`;
    document.getElementById("simZoneName").textContent = `도심 대로변 밀집 상권 (${region.road.displayName})`;

    if (fly && state.map) {
      state.map.flyTo(region.center, region.zoom, { duration: 0.7 });
    }
    renderRegionMap(region);

    // AI 브리핑 3줄 업데이트
    const list = document.getElementById("aiBriefingList");
    list.innerHTML = "";
    region.ai_briefing.forEach((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      list.appendChild(li);
    });

    renderSimulatorState(false);
  }

  // --- 시뮬레이터 게이지 및 80점 돌파 순환 배차 카드 ---
  function renderSimulatorState(triggerAudio = false) {
    if (!state.dashboard) return;
    const region = state.dashboard.regions[state.activeRegionKey];
    const stepInfo = SIM_STEPS[state.simStep];
    state.simScore = stepInfo.score;

    document.getElementById("simStepBadge").textContent = stepInfo.badge;

    const scoreEl = document.getElementById("gaugeScoreText");
    scoreEl.textContent = `${state.simScore}점 / 100점`;
    scoreEl.style.color =
      state.simScore >= 80 ? "#f87171" : state.simScore >= 60 ? "#fbbf24" : "#34d399";

    document.getElementById("gaugeFill").style.width = `${state.simScore}%`;

    const estNo2 = (region.road.no2_mean * stepInfo.no2Multiplier).toFixed(4);
    document.getElementById("teleNo2").textContent = `${estNo2} ppm`;
    document.getElementById("teleCohb").textContent = stepInfo.cohb;

    const alertEl = document.getElementById("teleAlertLevel");
    alertEl.textContent = stepInfo.alertText;
    alertEl.className = `tele-val ${stepInfo.alertClass}`;

    const approvalCard = document.getElementById("dispatchApprovalCard");
    const mapOverlay = document.getElementById("mapDispatchOverlay");

    if (state.simScore >= 80) {
      const call = region.escape_call;
      document.getElementById("dispatchHeadline").textContent =
        `🚨 가스 누적 임계치(${state.simScore}점) 도달! '외곽 청정 주거권역 행' 우선 순환 배차 발동`;
      document.getElementById("dispatchOrderTitle").textContent = call.order_title;
      document.getElementById("dispatchDelay").textContent = call.delay_note;
      document.getElementById("dispatchShelter").textContent = call.shelter_name;

      document.getElementById("mapOverlayTitle").textContent =
        `[${region.name}] 외곽 청정 주거권역 행 순환 배차 전환 완료`;
      document.getElementById("mapOverlayDesc").textContent =
        `배달 지연 ${call.delay_minutes}분 · ${call.shelter_name} · 그린 포인트 ${call.green_points}`;

      approvalCard.classList.remove("hidden");
      mapOverlay.classList.remove("hidden");

      if (triggerAudio) {
        playEmergencyChime();
      }
    } else {
      approvalCard.classList.add("hidden");
      mapOverlay.classList.add("hidden");
      if (triggerAudio && state.simStep > 0) {
        playStepTick(state.simStep);
      }
    }

    renderRegionMap(region);
  }

  // --- 헤더 메타 배지 & data.csv 테이블 렌더링 ---
  function renderMetaAndTable() {
    if (!state.dashboard) return;
    const meta = state.dashboard.meta || {};
    const badge = document.getElementById("apiStatusBadge");
    const isFallback = meta.mode === "fallback";
    badge.className = `status-badge ${isFallback ? "status-fallback" : "status-live"}`;
    badge.textContent = isFallback
      ? `API 상태: 로컬 백업 Fallback 가동 중 (data.csv · ${meta.total_rows || 0}행)`
      : `API 상태: 한국환경공단 에어코리아 v1.3 연동 완료 (data.csv · ${meta.total_rows || 0}행)`;

    document.getElementById("kpiRowsCount").textContent = `${meta.total_rows || 0} 행`;
    document.getElementById("kpiImputeBadge").textContent = `결측('-') ${meta.imputed_cell_count || 0}건 정제`;
    document.getElementById("kpiMetaFoot").textContent =
      `서울 ${meta.station_count || 40}개 측정소 · 망구분 평균 Imputation 완료 (기준 ${meta.latest_data_time || "-"})`;

    renderCsvTable();
  }

  function renderCsvTable() {
    if (!state.dashboard) return;
    const q = (document.getElementById("csvSearchInput").value || "").trim();
    const mangFilter = document.getElementById("csvMangFilter").value;
    const rows = state.dashboard.csv_rows || [];

    const filtered = rows.filter((r) => {
      if (mangFilter !== "ALL" && r.mangName !== mangFilter) return false;
      if (q && !r.stationName.includes(q) && !r.dataTime.includes(q)) return false;
      return true;
    });

    document.getElementById("tableSummary").textContent =
      `전체 ${rows.length}행 중 ${filtered.length}행 표시 중 (결측치 '-' 자동 평균 정제 완료)`;

    const tbody = document.getElementById("csvTableBody");
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-cell">검색 조건과 일치하는 측정 데이터가 없습니다.</td></tr>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    filtered.forEach((r) => {
      const tr = document.createElement("tr");
      const isRoad = r.mangName === "도로변대기";
      tr.innerHTML = `
        <td>${r.dataTime}</td>
        <td><strong>${r.stationName}</strong></td>
        <td><span class="badge-mang ${isRoad ? "badge-road" : "badge-urban"}">${r.mangName}</span></td>
        <td>${r.pm10Value}</td>
        <td>${r.pm25Value}</td>
        <td>${r.o3Value}</td>
        <td><strong>${r.no2Value}</strong></td>
        <td>${r.coValue}</td>
        <td><strong class="${r.gas_risk >= 80 ? "text-rose" : "text-emerald"}">${r.gas_risk}점</strong></td>
      `;
      fragment.appendChild(tr);
    });
    tbody.innerHTML = "";
    tbody.appendChild(fragment);
  }

  // --- 데이터 로드 및 새로고침 (Flask API 우선 + GitHub Pages 정적 스냅샷 자동 폴백) ---
  async function loadDashboard() {
    let loaded = false;
    const isGitHubPages = window.location.hostname.endsWith("github.io");
    if (!isGitHubPages) {
      try {
        const res = await fetch("api/dashboard-data");
        if (res.ok) {
          state.dashboard = await res.json();
          state.staticMode = false;
          loaded = true;
        }
      } catch (_) {}
    }
    if (!loaded) {
      state.staticMode = true;
      const res = await fetch("static/data/dashboard_live.json");
      state.dashboard = await res.json();
    }
    renderMetaAndTable();
    renderActiveRegion(true);
    renderAllStationsLayer();
  }

  async function refreshData(mode) {
    const btn = mode === "fallback" ? document.getElementById("btnTestFallback") : document.getElementById("btnRefreshLive");
    const origText = btn.textContent;
    btn.textContent = "수집·렌더링 중...";
    btn.disabled = true;

    try {
      if (!state.staticMode) {
        const res = await fetch(`api/refresh-data?mode=${mode}`, { method: "POST" });
        const data = await res.json();
        if (data.ok && data.dashboard) {
          state.dashboard = data.dashboard;
          renderMetaAndTable();
          renderActiveRegion(false);
          renderAllStationsLayer();
          const ts = Date.now();
          document.getElementById("imgChart1").src = `static/charts/chart1_network_gap.png?t=${ts}`;
          document.getElementById("imgChart2").src = `static/charts/chart2_hourly_exposure.png?t=${ts}`;
        }
      } else {
        const isFb = mode === "fallback";
        const jsonPath = isFb ? "static/data/dashboard_fallback.json" : "static/data/dashboard_live.json";
        const res = await fetch(jsonPath);
        state.dashboard = await res.json();
        renderMetaAndTable();
        renderActiveRegion(false);
        renderAllStationsLayer();
        document.getElementById("imgChart1").src = isFb
          ? "static/charts/chart1_fallback.png"
          : "static/charts/chart1_network_gap.png";
        document.getElementById("imgChart2").src = isFb
          ? "static/charts/chart2_fallback.png"
          : "static/charts/chart2_hourly_exposure.png";
      }
    } catch (err) {
      console.error("Refresh failed:", err);
    } finally {
      btn.textContent = origText;
      btn.disabled = false;
    }
  }

  // --- 이벤트 바인딩 ---
  function bindEvents() {
    document.querySelectorAll(".region-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeRegionKey = btn.dataset.region;
        renderActiveRegion(true);
      });
    });

    document.getElementById("btnSimStep").addEventListener("click", () => {
      if (state.simStep < SIM_STEPS.length - 1) {
        state.simStep += 1;
        renderSimulatorState(true);
      } else {
        // 92점 상태에서 다시 누르면 경고 재알림
        playEmergencyChime();
      }
    });

    document.getElementById("btnSimReset").addEventListener("click", () => {
      state.simStep = 0;
      renderSimulatorState(false);
    });

    document.getElementById("btnToggleAudio").addEventListener("click", (e) => {
      state.audioEnabled = !state.audioEnabled;
      e.target.textContent = state.audioEnabled ? "🔊 경고음 ON" : "🔇 경고음 OFF";
    });

    document.getElementById("btnTileToggle").addEventListener("click", () => {
      setTileLayer(state.tileMode === "dark" ? "osm" : "dark");
    });

    document.getElementById("btnToggleAllStations").addEventListener("click", (e) => {
      state.showAllStations = !state.showAllStations;
      e.target.textContent = state.showAllStations ? "서울 전체 숨기기" : "서울 전체 측정소";
      renderAllStationsLayer();
    });

    document.getElementById("btnRefreshLive").addEventListener("click", () => refreshData("live"));
    document.getElementById("btnTestFallback").addEventListener("click", () => refreshData("fallback"));

    document.getElementById("csvSearchInput").addEventListener("input", renderCsvTable);
    document.getElementById("csvMangFilter").addEventListener("change", renderCsvTable);

    // R 코드 모달 (Flask API 우선, GitHub Pages 정적 환경에서는 analysis.R 직접 로드)
    const rModal = document.getElementById("rCodeModal");
    document.getElementById("btnViewRCode").addEventListener("click", async () => {
      rModal.classList.remove("hidden");
      if (!state.rCodeCached) {
        if (!state.staticMode) {
          try {
            const res = await fetch("api/analysis-r");
            if (res.ok) {
              const data = await res.json();
              state.rCodeCached = data.code || "";
            }
          } catch (_) {}
        }
        if (!state.rCodeCached) {
          const res = await fetch("analysis.R");
          state.rCodeCached = await res.text();
        }
      }
      document.getElementById("rCodeContent").textContent = state.rCodeCached;
    });
    document.getElementById("btnCopyRCode").addEventListener("click", async (e) => {
      if (state.rCodeCached && navigator.clipboard) {
        await navigator.clipboard.writeText(state.rCodeCached);
        e.target.textContent = "복사 완료!";
        setTimeout(() => { e.target.textContent = "코드 복사"; }, 1500);
      }
    });
    document.getElementById("btnCloseRModal").addEventListener("click", () => rModal.classList.add("hidden"));
    document.getElementById("rModalBackdrop").addEventListener("click", () => rModal.classList.add("hidden"));

    // 차트 확대 모달
    const zoomModal = document.getElementById("chartZoomModal");
    ["imgChart1", "imgChart2"].forEach((id) => {
      document.getElementById(id).addEventListener("click", (e) => {
        document.getElementById("zoomChartImg").src = e.target.src;
        document.getElementById("zoomChartTitle").textContent = e.target.alt;
        zoomModal.classList.remove("hidden");
      });
    });
    document.getElementById("btnCloseZoomModal").addEventListener("click", () => zoomModal.classList.add("hidden"));
    document.getElementById("chartModalBackdrop").addEventListener("click", () => zoomModal.classList.add("hidden"));
  }

  document.addEventListener("DOMContentLoaded", async () => {
    initMap();
    bindEvents();
    await loadDashboard();
  });
})();
