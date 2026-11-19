/* Rider-AirGuard Frontend Control & Spatial Driving Physics Simulator */
(() => {
  "use strict";

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const state = {
    dashboard: null,
    staticMode: false,
    activeRegionKey: "gangnam",
    simHour: 18, // 18시 저녁 피크 기본
    simSpeed: 3, // 1 | 3 | 5 (기본 3배속으로 즉각적 체감)
    simRunning: false,
    simTimer: null,
    mapClickMode: true,
    customTarget: null, // [lat, lng]
    manualPositionHold: false,
    routePhase: "idle", // "idle" | "danger" | "escaping" | "recovered"
    simMinutes: 0,
    simScore: 0,
    peakScoreBeforeEscape: 0,
    lastDeltaPerMin: 0,
    currentSegmentLabel: "",
    riderLatLng: null,
    dangerCursor: { segIdx: 0, t: 0, dir: 1 },
    escapePath: [],
    escapeNames: [],
    escapeSegIdx: 0,
    escapeT: 0,
    shelterVisited: false,
    enteredPocketLogged: false,
    esgPoints: 0,
    escapeCount: 0,
    simHistory: [], // [{ min, score, phase, event }]
    lastHistoryMin: -1,
    eventLog: [],
    dangerTrailPoints: [],
    escapeTrailPoints: [],
    audioEnabled: true,
    tileMode: "light", // "light" | "dark"
    showAllStations: false,
    map: null,
    tileLayer: null,
    regionLayer: null,
    riderLayer: null,
    pocketCircle: null,
    allStationsLayer: null,
    riderMarker: null,
    dangerTrailPoly: null,
    escapeTrailPoly: null,
    targetMarker: null,
    rCodeCached: null,
  };

  // --- 공간 거리 및 폴리라인 유틸리티 ---
  function haversineMeters(a, b) {
    const R = 6371000;
    const rad = Math.PI / 180;
    const p1 = a[0] * rad;
    const p2 = b[0] * rad;
    const dp = (b[0] - a[0]) * rad;
    const dl = (b[1] - a[1]) * rad;
    const x =
      Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.sqrt(clamp(x, 0, 1)));
  }

  function pointToSegmentMeters(p, a, b) {
    const latScale = 111320;
    const lngScale = 111320 * Math.cos(((a[0] + b[0]) * 0.5 * Math.PI) / 180);
    const ax = a[1] * lngScale;
    const ay = a[0] * latScale;
    const bx = b[1] * lngScale;
    const by = b[0] * latScale;
    const px = p[1] * lngScale;
    const py = p[0] * latScale;

    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 <= 1e-6) return Math.hypot(px - ax, py - ay);
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function distanceToPolylineMeters(p, poly) {
    if (!poly || poly.length === 0) return Infinity;
    if (poly.length === 1) return haversineMeters(p, poly[0]);
    let best = Infinity;
    for (let i = 0; i < poly.length - 1; i++) {
      const d = pointToSegmentMeters(p, poly[i], poly[i + 1]);
      if (d < best) best = d;
    }
    return best;
  }

  function advanceDangerCursor(route, names, cursor, distMeters) {
    let { segIdx, t, dir } = cursor;
    let remaining = distMeters;
    let safety = 0;

    while (remaining > 0 && safety < 24) {
      safety++;
      const a = route[segIdx];
      const b = route[segIdx + 1];
      const segLen = Math.max(haversineMeters(a, b), 1);

      if (dir > 0) {
        const avail = (1 - t) * segLen;
        if (remaining <= avail) {
          t += remaining / segLen;
          remaining = 0;
        } else {
          remaining -= avail;
          if (segIdx < route.length - 2) {
            segIdx += 1;
            t = 0;
          } else {
            t = 1;
            dir = -1;
          }
        }
      } else {
        const avail = t * segLen;
        if (remaining <= avail) {
          t -= remaining / segLen;
          remaining = 0;
        } else {
          remaining -= avail;
          if (segIdx > 0) {
            segIdx -= 1;
            t = 1;
          } else {
            t = 0;
            dir = 1;
          }
        }
      }
    }

    const p1 = route[segIdx];
    const p2 = route[segIdx + 1];
    const pos = [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t];
    const n1 = (names && names[segIdx]) || `구간 ${segIdx + 1}`;
    const n2 = (names && names[segIdx + 1]) || `구간 ${segIdx + 2}`;
    const segLabel = dir > 0 ? `${n1} → ${n2}` : `${n2} → ${n1}`;

    return { pos, cursor: { segIdx, t, dir }, segLabel };
  }

  function advanceEscapePath(path, names, segIdx, t, distMeters) {
    if (!path || path.length < 2) {
      return { pos: state.riderLatLng, segIdx: 0, t: 1, finished: true, segLabel: "청정 권역 도착" };
    }
    let idx = segIdx;
    let curT = t;
    let remaining = distMeters;
    let finished = false;
    let safety = 0;

    while (remaining > 0 && safety < 24) {
      safety++;
      const a = path[idx];
      const b = path[idx + 1];
      const segLen = Math.max(haversineMeters(a, b), 1);
      const avail = (1 - curT) * segLen;

      if (remaining <= avail) {
        curT += remaining / segLen;
        remaining = 0;
      } else {
        remaining -= avail;
        if (idx < path.length - 2) {
          idx += 1;
          curT = 0;
        } else {
          curT = 1;
          remaining = 0;
          finished = true;
        }
      }
    }

    const p1 = path[idx];
    const p2 = path[idx + 1];
    const pos = [p1[0] + (p2[0] - p1[0]) * curT, p1[1] + (p2[1] - p1[1]) * curT];
    const n1 = (names && names[idx]) || "청정 순환로";
    const n2 = (names && names[idx + 1]) || "외곽 주거권역";
    const segLabel = finished ? `${n2} 도착` : `${n1} → ${n2}`;

    return { pos, segIdx: idx, t: curT, finished, segLabel };
  }

  function moveTowardTarget(cur, target, distMeters) {
    const totalDist = haversineMeters(cur, target);
    if (totalDist <= distMeters || totalDist < 5) {
      return { pos: [target[0], target[1]], arrived: true };
    }
    const frac = distMeters / totalDist;
    return {
      pos: [cur[0] + (target[0] - cur[0]) * frac, cur[1] + (target[1] - cur[1]) * frac],
      arrived: false,
    };
  }

  // --- Web Audio API 경고음 및 회복음 합성 ---
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
        { freq: 1318.51, start: 0.5, dur: 0.28 },
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
    } catch (_) {}
  }

  function playRecoveryChime() {
    if (!state.audioEnabled) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    try {
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      const notes = [
        { freq: 523.25, start: 0.0, dur: 0.14 },
        { freq: 659.25, start: 0.12, dur: 0.14 },
        { freq: 783.99, start: 0.24, dur: 0.24 },
      ];
      notes.forEach((n) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(n.freq, now + n.start);
        gain.gain.setValueAtTime(0.001, now + n.start);
        gain.gain.exponentialRampToValueAtTime(0.14, now + n.start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + n.start + n.dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + n.start);
        osc.stop(now + n.start + n.dur + 0.02);
      });
    } catch (_) {}
  }

  // --- 시간대별 실측 데이터 조회 ---
  function getHourData(region, hour) {
    const list = region.hourly_readings || [];
    const found = list.find((h) => h.hour === hour);
    if (found) return found;
    return {
      hour,
      label: `${String(hour).padStart(2, "0")}시`,
      urban_no2: region.urban.no2_mean,
      urban_co: region.urban.co_mean,
      urban_o3: region.urban.o3_mean,
      urban_risk: region.urban.risk_mean,
      road_no2: region.road.no2_mean,
      road_co: region.road.co_mean,
      road_o3: region.road.o3_mean,
      road_risk: region.road.risk_mean,
    };
  }

  function populateHourSelect(region) {
    const select = document.getElementById("simHourSelect");
    if (!select || !region) return;
    const prevVal = state.simHour;
    select.innerHTML = "";
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement("option");
      opt.value = String(h);
      let tag = "";
      if (h >= 11 && h <= 14) tag = " · 점심 피크";
      else if (h >= 17 && h <= 20) tag = " · 저녁 피크";
      else if (h >= 1 && h <= 5) tag = " · 심야 저위험";
      else if (h >= 8 && h <= 9) tag = " · 출근 피크";
      opt.textContent = `${String(h).padStart(2, "0")}시${tag}`;
      select.appendChild(opt);
    }
    select.value = String(prevVal);
    updateHourContextPill(region);
  }

  function updateHourContextPill(region) {
    const pill = document.getElementById("simHourContext");
    if (!pill || !region) return;
    const hd = getHourData(region, state.simHour);
    const lvl =
      hd.road_risk >= 95
        ? "매우 심함"
        : hd.road_risk >= 75
        ? "매연 심함"
        : hd.road_risk >= 55
        ? "보통"
        : "공기 양호";
    pill.textContent = `${lvl} · ${Math.round(hd.road_risk)}점`;
    pill.title = `도로변 위험지수 ${hd.road_risk}점 vs 동네 ${hd.urban_risk}점`;
    pill.classList.toggle("pill-cool", hd.road_risk < 75);
  }

  function formatRiderDist(meters) {
    if (meters >= 1000) return `${(meters / 1000).toFixed(1)}km`;
    return `${Math.round(meters)}m`;
  }

  // --- 공간 좌표 기반 피폭 / 환기 변화율 계산 ---
  function evaluateSpatialExposure(region, pos, phase) {
    const hd = getHourData(region, state.simHour);
    const pocketR = region.pocket_radius_m || 600;
    const distPocket = haversineMeters(pos, region.road.coords);
    const distRoad = distanceToPolylineMeters(pos, region.danger_route);
    const trafficFactor = clamp(hd.road_risk / 68, 0.55, 1.5);
    const cleanFactor = clamp(65 / Math.max(hd.urban_risk, 35), 0.75, 1.35);

    // 1. 국소 실시간 흡입 가스 (포켓 거리 기반 연속 보간)
    const pocketRatio = clamp(1 - distPocket / (pocketR * 1.4), 0, 1);
    const localNo2 = hd.urban_no2 + (hd.road_no2 * 1.12 - hd.urban_no2) * pocketRatio;
    const baseUrbanNo2 = Math.max(hd.urban_no2, 0.006);

    if (phase === "recovered") {
      const cleanNo2 = hd.urban_no2 * 0.92;
      return {
        distPocket,
        rate: 0,
        localNo2: cleanNo2,
        ratioVsUrban: cleanNo2 / baseUrbanNo2,
        zoneText: "맑은 동네 도착 완료",
        zoneClass: "text-emerald",
        pocketBadge: `${formatRiderDist(distPocket)} · 맑은 동네`,
      };
    }

    if (phase === "escaping") {
      if (distPocket <= pocketR * 0.65) {
        return {
          distPocket,
          rate: -0.75,
          localNo2,
          ratioVsUrban: localNo2 / baseUrbanNo2,
          zoneText: "매연 구간 빠져나가는 중",
          zoneClass: "text-sky",
          pocketBadge: `${formatRiderDist(distPocket)} · 빠져나가는 중`,
        };
      }
      if (distPocket <= pocketR) {
        return {
          distPocket,
          rate: -1.85,
          localNo2,
          ratioVsUrban: localNo2 / baseUrbanNo2,
          zoneText: "매연 경계 탈출 · 공기 맑아짐",
          zoneClass: "text-emerald",
          pocketBadge: `${formatRiderDist(distPocket)} · 공기 맑아짐`,
        };
      }
      const escCleanNo2 = hd.urban_no2 * 0.94;
      return {
        distPocket,
        rate: -2.85 * cleanFactor,
        localNo2: escCleanNo2,
        ratioVsUrban: escCleanNo2 / baseUrbanNo2,
        zoneText: "맑은 동네 순환 · 숨 트이는 중",
        zoneClass: "text-emerald",
        pocketBadge: `${formatRiderDist(distPocket)} · 맑은 외곽`,
      };
    }

    // "idle" 또는 "danger" (혹은 지도 드래그 테스트)
    if (distPocket <= pocketR * 0.55) {
      const coreNo2 = hd.road_no2 * 1.15;
      return {
        distPocket,
        rate: 3.35 * trafficFactor,
        localNo2: coreNo2,
        ratioVsUrban: coreNo2 / baseUrbanNo2,
        zoneText: "매연 한가운데 관통 (가장 독함)",
        zoneClass: "text-rose",
        pocketBadge: `${formatRiderDist(distPocket)} · 한가운데!`,
      };
    }
    if (distPocket <= pocketR) {
      return {
        distPocket,
        rate: 2.05 * trafficFactor,
        localNo2,
        ratioVsUrban: localNo2 / baseUrbanNo2,
        zoneText: "큰길 매연 집중 구간 진입",
        zoneClass: "text-amber",
        pocketBadge: `${formatRiderDist(distPocket)} · 매연 집중구간`,
      };
    }
    if (distRoad <= 380) {
      const roadEdgeNo2 = hd.urban_no2 + (hd.road_no2 - hd.urban_no2) * 0.35;
      return {
        distPocket,
        rate: 0.55 * trafficFactor,
        localNo2: roadEdgeNo2,
        ratioVsUrban: roadEdgeNo2 / baseUrbanNo2,
        zoneText: "큰길 진입 (서서히 누적)",
        zoneClass: "text-sky",
        pocketBadge: `${formatRiderDist(distPocket)} · 큰길 진입`,
      };
    }

    const outCleanNo2 = hd.urban_no2 * 0.92;
    return {
      distPocket,
      rate: -1.75 * cleanFactor,
      localNo2: outCleanNo2,
      ratioVsUrban: outCleanNo2 / baseUrbanNo2,
      zoneText: "맑은 동네 (자연 회복)",
      zoneClass: "text-emerald",
      pocketBadge: `${formatRiderDist(distPocket)} 밖 · 맑음`,
    };
  }

  // --- 이벤트 로그 & 이력 관리 ---
  function addEventLog(minVal, text, cls = "") {
    const timeStr = `${Math.round(minVal)}분`;
    state.eventLog.unshift({ time: timeStr, text, cls });
    if (state.eventLog.length > 20) state.eventLog.pop();
    renderEventLog();
  }

  function renderEventLog() {
    const ul = document.getElementById("simEventLog");
    if (!ul) return;
    ul.innerHTML = "";
    state.eventLog.forEach((ev) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="ev-time">[${ev.time}]</span> <span class="${ev.cls}">${ev.text}</span>`;
      ul.appendChild(li);
    });
  }

  function pushHistorySample(min, score, phase, event = null) {
    state.simHistory.push({ min, score, phase, event });
    if (state.simHistory.length > 180) {
      state.simHistory.shift();
    }
    state.lastHistoryMin = min;
  }

  // --- 순환 배차 발동 (자동 80점 돌파 또는 수동 전환) ---
  function activateCircularEscape(region, isManual) {
    if (state.routePhase === "escaping" || state.routePhase === "recovered") return;

    state.routePhase = "escaping";
    state.manualPositionHold = false;
    state.customTarget = null;
    if (state.targetMarker && state.riderLayer) {
      state.riderLayer.removeLayer(state.targetMarker);
      state.targetMarker = null;
    }

    state.peakScoreBeforeEscape = Math.max(Math.round(state.simScore), isManual ? Math.round(state.simScore) : 80);
    state.shelterVisited = false;

    // 쉼터 인덱스 찾기 (쉼터 이전 최적 합류 지점을 선택해 텔레포트 없이 연결)
    const escapeRoute = region.escape_route || [];
    const escapeNames = region.escape_waypoints || [];
    let shelterIdx = escapeNames.findIndex((n) => n.includes("쉼터"));
    if (shelterIdx < 0) shelterIdx = Math.min(2, escapeRoute.length - 1);

    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i <= Math.min(shelterIdx, escapeRoute.length - 1); i++) {
      const d = haversineMeters(state.riderLatLng, escapeRoute[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    const startPt = [state.riderLatLng[0], state.riderLatLng[1]];
    if (bestDist > 80) {
      state.escapePath = [startPt, ...escapeRoute.slice(bestIdx)];
      state.escapeNames = ["현재 주행 위치", ...escapeNames.slice(bestIdx)];
    } else {
      state.escapePath = escapeRoute.slice(bestIdx);
      state.escapeNames = escapeNames.slice(bestIdx);
    }
    state.escapeSegIdx = 0;
    state.escapeT = 0;
    state.escapeTrailPoints = [startPt];

    if (!isManual) {
      playEmergencyChime();
      addEventLog(
        state.simMinutes,
        `80점 넘어서 맑은 동네 콜로 자동 전환! (${Math.round(state.simScore)}점 · 배달 지연 0분)`,
        "ev-danger"
      );
    } else {
      playRecoveryChime();
      addEventLog(
        state.simMinutes,
        `바로 맑은 동네 콜로 바꿨어요 (${Math.round(state.simScore)}점) — 쉼터 지나며 회복 중`,
        "ev-escape"
      );
    }

    pushHistorySample(state.simMinutes, state.simScore, "escaping", "dispatch");
    renderRegionBaseLayers(region);
  }

  // --- 물리 시뮬레이션 스텝 통합 (dtMin 단위 정밀 적분) ---
  function stepSimulation(totalDtMin, options = {}) {
    if (!state.dashboard) return;
    const region = state.dashboard.regions[state.activeRegionKey];
    if (!region) return;

    const { stopOnEscapeTrigger = false } = options;
    const sliceSize = 0.4; // 0.4분 단위로 구간·매연 반경·쉼터 정밀 적분
    let rem = totalDtMin;

    if (state.routePhase === "idle") {
      state.routePhase = "danger";
      state.simHistory = [{ min: state.simMinutes, score: state.simScore, phase: "danger", event: null }];
      state.lastHistoryMin = state.simMinutes;
      addEventLog(state.simMinutes, `🛵 ${region.danger_waypoints[0]} 출발 — 큰길 배달 시작`, "");
    } else if (state.routePhase === "recovered") {
      // 다음 배달 이어서 주행 시작
      resetRouteForNextRound(region, false);
      state.routePhase = "danger";
      addEventLog(state.simMinutes, `🛵 다음 배달 출발 (${region.danger_waypoints[0]})`, "");
    }

    while (rem > 1e-4) {
      const dt = Math.min(sliceSize, rem);
      rem -= dt;

      // 1. 이동 처리
      if (state.customTarget) {
        const res = moveTowardTarget(state.riderLatLng, state.customTarget, 230 * dt);
        state.riderLatLng = res.pos;
        state.currentSegmentLabel = "찍어둔 지점으로 이동 중";
        if (res.arrived) {
          state.customTarget = null;
          state.manualPositionHold = true;
          if (state.targetMarker && state.riderLayer) {
            state.riderLayer.removeLayer(state.targetMarker);
            state.targetMarker = null;
          }
          addEventLog(state.simMinutes, "📍 찍어둔 지점 도착 — 주변 공기 상태 확인 중", "ev-shelter");
        }
      } else if (state.routePhase === "danger") {
        if (!state.manualPositionHold) {
          const res = advanceDangerCursor(
            region.danger_route,
            region.danger_waypoints,
            state.dangerCursor,
            210 * dt
          );
          state.riderLatLng = res.pos;
          state.dangerCursor = res.cursor;
          state.currentSegmentLabel = res.segLabel;
        } else {
          state.currentSegmentLabel = "직접 옮긴 위치 확인 중";
        }
      } else if (state.routePhase === "escaping") {
        const res = advanceEscapePath(
          state.escapePath,
          state.escapeNames,
          state.escapeSegIdx,
          state.escapeT,
          265 * dt
        );
        state.riderLatLng = res.pos;
        state.escapeSegIdx = res.segIdx;
        state.escapeT = res.t;
        state.currentSegmentLabel = res.segLabel;

        // 쉼터 경유 체크 (230m 이내)
        if (!state.shelterVisited && region.shelters && region.shelters[0]) {
          const dShelter = haversineMeters(state.riderLatLng, region.shelters[0].coords);
          if (dShelter <= 230) {
            state.shelterVisited = true;
            state.simScore = Math.max(12, state.simScore - 18);
            playRecoveryChime();
            addEventLog(
              state.simMinutes + dt,
              `🛡️ ${region.shelters[0].name} 잠깐 휴식 (-18점 바로 회복!)`,
              "ev-shelter"
            );
            pushHistorySample(state.simMinutes + dt, state.simScore, "escaping", "shelter");
          }
        }

        if (res.finished) {
          // 맑은 동네 도착 후 20점 이하까지 자연 회복 마감
          if (state.simScore > 20) {
            state.currentSegmentLabel = `${region.escape_waypoints[region.escape_waypoints.length - 1]} (숨 돌리는 중)`;
            state.simScore = Math.max(16, state.simScore - 3.8 * dt);
            state.lastDeltaPerMin = -3.8;
            state.simMinutes += dt;
            if (state.simMinutes - state.lastHistoryMin >= 1.0) {
              pushHistorySample(state.simMinutes, state.simScore, state.routePhase, null);
            }
            continue;
          }

          state.routePhase = "recovered";
          state.esgPoints += 500;
          state.escapeCount += 1;
          state.lastDeltaPerMin = 0;
          state.simMinutes += dt;
          pushHistorySample(state.simMinutes, state.simScore, "recovered", "complete");
          addEventLog(
            state.simMinutes,
            `✅ ${region.escape_waypoints[region.escape_waypoints.length - 1]} 도착! 피로도 ${Math.round(state.simScore)}점 회복 (+500P 적립)`,
            "ev-escape"
          );
          playRecoveryChime();
          stopContinuousLoop();
          break;
        }
      }

      // 이동 궤적 기록 (위험 구간 vs 순환 탈출 구간 분리 기록)
      const isEscTrail = state.routePhase === "escaping" || state.routePhase === "recovered";
      const trailArr = isEscTrail ? state.escapeTrailPoints : state.dangerTrailPoints;
      const lastTr = trailArr[trailArr.length - 1];
      if (!lastTr || haversineMeters(lastTr, state.riderLatLng) > 35) {
        trailArr.push([state.riderLatLng[0], state.riderLatLng[1]]);
        if (trailArr.length > 220) trailArr.shift();
      }

      // 2. 공간 가스 노출 / 환기 계산
      const evalRes = evaluateSpatialExposure(region, state.riderLatLng, state.routePhase);
      state.lastDeltaPerMin = evalRes.rate;
      const floorScore = state.peakScoreBeforeEscape > 0 ? 12 : 0;
      state.simScore = clamp(state.simScore + evalRes.rate * dt, floorScore, 100);
      state.simMinutes += dt;

      // 매연 구간 첫 진입 로그
      const pocketR = region.pocket_radius_m || 600;
      if (state.routePhase === "danger" && !state.enteredPocketLogged && evalRes.distPocket <= pocketR) {
        state.enteredPocketLogged = true;
        addEventLog(
          state.simMinutes,
          `${region.road.stationName} 매연 집중구간 진입 — 피로도가 빠르게 올라가요`,
          "ev-danger"
        );
      }

      // 히스토리 샘플 기록 (1분 간격)
      if (state.simMinutes - state.lastHistoryMin >= 1.0) {
        pushHistorySample(state.simMinutes, state.simScore, state.routePhase, null);
      }

      // 3. 임계치 80점 돌파 -> 자동 순환 배차 발동!
      if (state.routePhase === "danger" && state.simScore >= 80) {
        activateCircularEscape(region, false);
        if (stopOnEscapeTrigger) {
          break;
        }
      }
    }

    updateAllSimulatorVisuals();
  }

  function startContinuousLoop() {
    if (state.simRunning) return;
    if (state.routePhase === "recovered" && state.dashboard) {
      resetRouteForNextRound(state.dashboard.regions[state.activeRegionKey], false);
    }
    state.simRunning = true;
    if (state.simTimer) clearInterval(state.simTimer);

    const tickMs = 150;
    state.simTimer = setInterval(() => {
      if (!state.simRunning) return;
      // 1× = 2.0 sim-min/sec (0.3 min per 150ms), 3× = 6.0 min/sec, 5× = 10.0 min/sec
      const dtMin = (2.0 * state.simSpeed * tickMs) / 1000;
      stepSimulation(dtMin, { stopOnEscapeTrigger: false });
    }, tickMs);

    updatePlayButtonUI();
  }

  function stopContinuousLoop() {
    state.simRunning = false;
    if (state.simTimer) {
      clearInterval(state.simTimer);
      state.simTimer = null;
    }
    updatePlayButtonUI();
  }

  function updatePlayButtonUI() {
    const btn = document.getElementById("btnSimPlayPause");
    if (!btn) return;
    btn.classList.toggle("is-running", state.simRunning);
    if (state.simRunning) {
      btn.textContent = "⏸ 잠깐 멈추기";
    } else if (state.routePhase === "recovered") {
      btn.textContent = "🛵 다음 배달 시작하기";
    } else if (state.routePhase === "idle") {
      btn.textContent = "▶ 실시간 주행 시작";
    } else {
      btn.textContent = "▶ 주행 이어서 하기";
    }
  }

  function resetRouteForNextRound(region, fullReset = true) {
    stopContinuousLoop();
    state.routePhase = "idle";
    state.manualPositionHold = false;
    state.customTarget = null;
    if (state.targetMarker && state.riderLayer) {
      state.riderLayer.removeLayer(state.targetMarker);
      state.targetMarker = null;
    }
    state.dangerCursor = { segIdx: 0, t: 0, dir: 1 };
    state.escapePath = [];
    state.escapeNames = [];
    state.escapeSegIdx = 0;
    state.escapeT = 0;
    state.shelterVisited = false;
    state.enteredPocketLogged = false;
    state.peakScoreBeforeEscape = 0;
    state.lastDeltaPerMin = 0;

    if (region) {
      const startPt = region.danger_route[0];
      state.riderLatLng = [startPt[0], startPt[1]];
      state.currentSegmentLabel = region.danger_waypoints[0];
      state.dangerTrailPoints = [[startPt[0], startPt[1]]];
      state.escapeTrailPoints = [];
    }

    if (fullReset) {
      state.simMinutes = 0;
      state.simScore = 0;
      state.esgPoints = 0;
      state.escapeCount = 0;
      state.simHistory = [{ min: 0, score: 0, phase: "idle", event: null }];
      state.lastHistoryMin = 0;
      state.eventLog = [
        {
          time: "대기",
          text: `${region ? region.danger_waypoints[0] : "출발지"} 대기 중 — 주행을 시작하면 매연 구간에 따라 피로도가 올라갑니다.`,
          cls: "",
        },
      ];
      renderEventLog();
    } else {
      // 다음 라운드는 방금 회복된 낮은 수치에서 자연 이어가기
      state.simScore = Math.min(state.simScore, 15);
      pushHistorySample(state.simMinutes, state.simScore, "idle", null);
    }

    if (region) {
      renderRegionBaseLayers(region);
    }
    updateAllSimulatorVisuals();
  }

  // --- Leaflet 지도 초기화 및 분리된 레이어 렌더링 ---
  function initMap() {
    state.map = L.map("dispatchMap", {
      center: [37.5015, 127.0335],
      zoom: 13.5,
      zoomSnap: 0.5,
      zoomControl: true,
    });

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
      color: "#0284C7",
      weight: 18,
      opacity: 0.14,
      interactive: false,
    }).addTo(state.map);

    setTileLayer("light");
    state.regionLayer = L.layerGroup().addTo(state.map);
    state.riderLayer = L.layerGroup().addTo(state.map);
    state.allStationsLayer = L.layerGroup();

    // 지도 클릭 주행 지원
    state.map.on("click", (e) => {
      if (!state.mapClickMode || !state.dashboard) return;
      const region = state.dashboard.regions[state.activeRegionKey];
      state.customTarget = [e.latlng.lat, e.latlng.lng];
      state.manualPositionHold = false;
      if (state.routePhase === "idle" || state.routePhase === "recovered") {
        state.routePhase = "danger";
      }
      if (state.targetMarker) {
        state.riderLayer.removeLayer(state.targetMarker);
      }
      state.targetMarker = L.circleMarker(state.customTarget, {
        radius: 7,
        color: "#0B0F17",
        fillColor: "#0284C7",
        fillOpacity: 0.75,
        weight: 2,
      })
        .bindTooltip("지정 목적지")
        .addTo(state.riderLayer);

      addEventLog(state.simMinutes, "지도 클릭 목적지 설정 — 실시간 이동 중", "ev-shelter");
      if (!state.simRunning) {
        startContinuousLoop();
      }
      updateAllSimulatorVisuals();
      if (region) updateRiderMapVisuals(region);
    });
  }

  function setTileLayer(mode) {
    state.tileMode = mode;
    if (state.tileLayer) {
      state.map.removeLayer(state.tileLayer);
    }
    state.tileLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors (100% Free Open-Source)",
      maxZoom: 19,
    }).addTo(state.map);

    const mapEl = document.getElementById("dispatchMap");
    if (mapEl) {
      mapEl.classList.toggle("map-dark-tiles", mode === "dark");
      mapEl.classList.toggle("map-light-tiles", mode !== "dark");
    }
    const btn = document.getElementById("btnTileToggle");
    if (btn) {
      btn.textContent = mode === "dark" ? "지도: 어둡게" : "지도: 밝게";
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
        color: isRoad ? "#B91C1C" : "#047857",
        fillColor: isRoad ? "#DC2626" : "#059669",
        fillOpacity: 0.78,
        weight: 1.5,
      });
      marker.bindPopup(
        `<strong>${st.stationName}</strong> (${isRoad ? "큰길 측정소" : "동네 측정소"})<br/>` +
          `피로 위험도: <b>${Math.round(st.gasRisk)}점</b> · ${st.gasRisk >= 80 ? "매연 주의" : "양호"}<br/>` +
          `<span style="color:#64748B;font-size:11px;">측정(${st.dataTime}): NO₂ ${st.no2Value}ppm · PM10 ${st.pm10Value}㎍/㎥</span>`
      );
      marker.addTo(state.allStationsLayer);
    });
    state.allStationsLayer.addTo(state.map);
  }

  // 정적 권역 레이어 렌더링 (동네 기준, 큰길 매연 구간, 쉼터, 경로선)
  function renderRegionBaseLayers(region) {
    if (!state.regionLayer || !region) return;
    state.regionLayer.clearLayers();
    const isEscaping = state.routePhase === "escaping" || state.routePhase === "recovered";
    const pocketR = region.pocket_radius_m || 600;
    const gapRatio = (1 + (region.road.gap_no2_pct || 0) / 100).toFixed(1);
    const peakRatio = (1 + (region.road.gap_no2_peak_pct || 0) / 100).toFixed(1);

    // 1. 큰길 매연 집중 구간 원 (핵심 + 외곽 2단 시각화, 클릭 이벤트 통과)
    state.pocketCircle = L.circle(region.road.coords, {
      radius: pocketR,
      color: "#DC2626",
      weight: 1.8,
      dashArray: "6 6",
      fillColor: "#DC2626",
      fillOpacity: isEscaping ? 0.10 : 0.18,
      interactive: false,
    }).addTo(state.regionLayer);

    L.circle(region.road.coords, {
      radius: Math.round(pocketR * 0.55),
      color: "#B91C1C",
      weight: 1.2,
      dashArray: "3 4",
      fillColor: "#DC2626",
      fillOpacity: isEscaping ? 0.06 : 0.14,
      interactive: false,
    }).addTo(state.regionLayer);

    // 2. 동네 공기 기준 (도시대기 측정소)
    const urbanIcon = L.divIcon({
      className: "",
      html: `<div class="urban-pin"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    const urbanMarker = L.marker(region.urban.coords, { icon: urbanIcon }).addTo(state.regionLayer);
    urbanMarker.bindTooltip(
      `동네 공기 [${region.urban.stationName}] · 날씨앱 예보: ${region.urban.weather_grade}`,
      { direction: "top", offset: [0, -10] }
    );
    urbanMarker.bindPopup(
      `<strong>동네 기준 (${region.urban.stationName})</strong><br/>` +
        `일반 날씨앱 예보: <b style="color:#047857;">${region.urban.weather_grade}</b> (주거지 공기는 맑아요)<br/>` +
        `<span style="color:#64748B;font-size:11px;">참고 측정: 미세먼지 ${region.urban.pm10_mean}㎍/㎥ · 가스지수 ${region.urban.risk_mean}점</span>`
    );

    // 3. 큰길 매연 집중지 (도로변 측정소)
    const roadIcon = L.divIcon({
      className: "",
      html: `<div class="pulse-marker-wrap"><div class="pulse-ring"></div><div class="pulse-core"></div></div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const roadMarker = L.marker(region.road.coords, { icon: roadIcon, zIndexOffset: 500 }).addTo(state.regionLayer);
    roadMarker.bindTooltip(
      `큰길 매연 [${region.road.stationName}] · 동네보다 ${gapRatio}배 독함 (마스크 통과)`,
      { direction: "top", offset: [0, -14] }
    );
    roadMarker.bindPopup(
      `<strong>큰길 매연 집중지: ${region.road.stationName}</strong><br/>` +
        `<span style="color:#B91C1C; font-weight:700;">동네보다 ${gapRatio}배(+${Math.round(region.road.gap_no2_pct)}%) 더 독해요 · ${region.road.road_grade}</span><br/>` +
        `바쁜 시간대 최대 <b>${peakRatio}배</b> · KF94 마스크 차단 0%<br/>` +
        `<span style="color:#64748B;font-size:11px;">참고 측정: NO₂ ${region.road.no2_mean}ppm · 피크 위험 ${region.road.risk_peak}점</span>`
    );

    // 4. 지자체 이동노동자 쉼터
    region.shelters.forEach((sh, idx) => {
      const shIcon = L.divIcon({
        className: "",
        html: `<div class="shelter-pin" title="${sh.name}">🛡️</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      const sm = L.marker(sh.coords, { icon: shIcon, zIndexOffset: 400 }).addTo(state.regionLayer);
      sm.bindTooltip(`라이더 쉼터: ${sh.name}${idx === 0 ? " (-18점 바로 회복)" : ""}`, {
        direction: "top",
        offset: [0, -12],
      });
      sm.bindPopup(
        `<strong>${sh.name}</strong><br/>` +
          `위치: ${sh.address}<br/>` +
          `이용: ${sh.hours}`
      );
    });

    // 5. 매연 많은 큰길 배달 루트
    L.polyline(region.danger_route, {
      color: "#DC2626",
      weight: isEscaping ? 3 : 4.5,
      opacity: isEscaping ? 0.32 : 0.85,
      dashArray: "10 8",
    })
      .bindTooltip("매연이 많이 쌓이는 큰길 배달 노선", { sticky: true })
      .addTo(state.regionLayer);

    region.danger_route.forEach((pt, i) => {
      const wpName = (region.danger_waypoints && region.danger_waypoints[i]) || `구간 ${i + 1}`;
      L.circleMarker(pt, {
        radius: 4.5,
        color: "#FFFFFF",
        fillColor: "#DC2626",
        fillOpacity: isEscaping ? 0.4 : 0.9,
        weight: 1.5,
      })
        .bindTooltip(`큰길 거점: ${wpName}`, { direction: "top" })
        .addTo(state.regionLayer);
    });

    // 6. 지연 0분 맑은 동네 순환 길
    const activeEsc = state.escapePath.length >= 2 ? state.escapePath : region.escape_route;
    L.polyline(activeEsc, {
      color: "#059669",
      weight: isEscaping ? 5.5 : 2.8,
      opacity: isEscaping ? 0.92 : 0.36,
      dashArray: isEscaping ? null : "4 6",
    })
      .bindTooltip("배달 지연 0분! 공기 맑은 동네 순환길", { sticky: true })
      .addTo(state.regionLayer);

    if (isEscaping && region.shelters[0]) {
      L.circle(region.shelters[0].coords, {
        radius: 170,
        color: "#0284C7",
        weight: 2,
        fillColor: "#0284C7",
        fillOpacity: 0.18,
      }).addTo(state.regionLayer);
    }

    region.escape_route.forEach((pt, i) => {
      const wpName = (region.escape_waypoints && region.escape_waypoints[i]) || `맑은 동네 ${i + 1}`;
      L.circleMarker(pt, {
        radius: isEscaping ? 4.5 : 3.5,
        color: "#FFFFFF",
        fillColor: "#059669",
        fillOpacity: isEscaping ? 0.92 : 0.5,
        weight: 1.5,
      })
        .bindTooltip(`맑은 길: ${wpName}`, { direction: "top" })
        .addTo(state.regionLayer);
    });
  }

  // 라이더 마커 및 주행 궤적 업데이트
  function ensureRiderMarker(region) {
    if (!state.riderLayer || !region) return;
    if (!state.riderLatLng) {
      const startPt = region.danger_route[0];
      state.riderLatLng = [startPt[0], startPt[1]];
    }

    if (!state.dangerTrailPoly) {
      state.dangerTrailPoly = L.polyline(state.dangerTrailPoints, {
        color: "#D97706",
        weight: 3.5,
        opacity: 0.85,
      }).addTo(state.riderLayer);
    }

    if (!state.escapeTrailPoly) {
      state.escapeTrailPoly = L.polyline(state.escapeTrailPoints, {
        color: "#0284C7",
        weight: 4,
        opacity: 0.92,
      }).addTo(state.riderLayer);
    }

    if (!state.riderMarker) {
      const icon = L.divIcon({
        className: "",
        html: `<div class="rider-marker-shell"><div id="mapRiderPin" class="rider-pin pin-safe">🛵</div><span id="mapRiderTag" class="rider-map-tag">0점</span></div>`,
        iconSize: [54, 54],
        iconAnchor: [18, 18],
      });
      state.riderMarker = L.marker(state.riderLatLng, {
        icon,
        draggable: true,
        zIndexOffset: 950,
      }).addTo(state.riderLayer);

      state.riderMarker.bindPopup(
        "<strong>라이더 김성원 (직접 끌기 가능)</strong><br/>빨간 매연 구간 안팎으로 옮겨 보시면 내 몸 피로도 변화를 바로 확인할 수 있어요."
      );

      state.riderMarker.on("drag", (ev) => {
        const ll = ev.target.getLatLng();
        state.riderLatLng = [ll.lat, ll.lng];
        if (state.routePhase === "idle") {
          state.routePhase = "danger";
        }
        state.manualPositionHold = true;
        state.customTarget = null;
        state.currentSegmentLabel = "직접 옮긴 위치 확인 중";
        updateAllSimulatorVisuals(false);
      });

      state.riderMarker.on("dragend", (ev) => {
        const ll = ev.target.getLatLng();
        state.riderLatLng = [ll.lat, ll.lng];
        state.manualPositionHold = true;
        const evalRes = evaluateSpatialExposure(
          state.dashboard.regions[state.activeRegionKey],
          state.riderLatLng,
          state.routePhase
        );
        addEventLog(
          state.simMinutes,
          `✋ 라이더 위치 이동 (${evalRes.pocketBadge}) — 변화율 ${evalRes.rate >= 0 ? "+" : ""}${evalRes.rate.toFixed(1)}점/분`,
          evalRes.rate >= 0 ? "ev-danger" : "ev-escape"
        );
        updateAllSimulatorVisuals(false);
      });
    }
  }

  function updateRiderBadgeAppearance() {
    const pinEl = document.getElementById("mapRiderPin");
    const tagEl = document.getElementById("mapRiderTag");
    const scoreInt = Math.round(state.simScore);
    if (pinEl) {
      pinEl.className = "rider-pin";
      if (state.routePhase === "escaping" || state.routePhase === "recovered") {
        pinEl.classList.add("pin-escape");
      } else if (scoreInt >= 80) {
        pinEl.classList.add("pin-danger");
      } else if (scoreInt >= 45) {
        pinEl.classList.add("pin-warn");
      } else {
        pinEl.classList.add("pin-safe");
      }
    }
    if (tagEl) {
      const rateSign = state.lastDeltaPerMin > 0.05 ? "▲" : state.lastDeltaPerMin < -0.05 ? "▼" : "";
      tagEl.textContent = `${scoreInt}점 ${rateSign}`;
    }
  }

  function updateRiderMapVisuals(region) {
    ensureRiderMarker(region);
    if (state.riderMarker && state.riderLatLng) {
      state.riderMarker.setLatLng(state.riderLatLng);
    }
    if (state.dangerTrailPoly) {
      state.dangerTrailPoly.setLatLngs(state.dangerTrailPoints);
    }
    if (state.escapeTrailPoly) {
      state.escapeTrailPoly.setLatLngs(state.escapeTrailPoints);
    }
    updateRiderBadgeAppearance();
  }

  // --- 실시간 SVG 피폭·환기 추이 그래프 렌더링 ---
  function renderTrendChart() {
    const svg = document.getElementById("simTrendSvg");
    const wrapEl = document.getElementById("trendChartWrap");
    if (!svg) return;
    const hist = state.simHistory;
    if (wrapEl) {
      wrapEl.classList.toggle("hidden", !hist || hist.length < 2);
    }

    const W = 360;
    const H = 66;
    const padX = 6;
    const yOf = (sc) => 61 - (clamp(sc, 0, 100) / 100) * 55; // 0->61, 100->6, 80->17.0

    // 동적 임계치 라인 위치 보정
    const threshLine = svg.querySelector("line");
    const threshText = svg.querySelector("text");
    if (threshLine) {
      const y80 = yOf(80).toFixed(1);
      threshLine.setAttribute("y1", y80);
      threshLine.setAttribute("y2", y80);
      if (threshText) threshText.setAttribute("y", (yOf(80) - 3).toFixed(1));
    }

    const areaEl = document.getElementById("simTrendArea");
    const pathEl = document.getElementById("simTrendPath");
    const markersEl = document.getElementById("simTrendMarkers");

    if (!hist || hist.length < 2) {
      if (areaEl) areaEl.setAttribute("d", "");
      if (pathEl) pathEl.setAttribute("d", "");
      if (markersEl) markersEl.innerHTML = "";
      return;
    }

    const maxMin = Math.max(hist[hist.length - 1].min, 15);
    const xOf = (m) => padX + (m / maxMin) * (W - padX * 2);

    const pts = hist.map((p) => ({
      x: xOf(p.min),
      y: yOf(p.score),
      phase: p.phase,
      event: p.event,
      score: p.score,
    }));

    const dispatchIdx = pts.findIndex((p) => p.event === "dispatch" || p.phase === "escaping" || p.phase === "recovered");
    const dangerPts = dispatchIdx > 0 ? pts.slice(0, dispatchIdx + 1) : dispatchIdx === 0 ? [] : pts;
    const escapePts = dispatchIdx >= 0 ? pts.slice(dispatchIdx) : [];

    const toLine = (arr) => arr.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const toArea = (arr) =>
      arr.length >= 2
        ? `${toLine(arr)} L${arr[arr.length - 1].x.toFixed(1)},61 L${arr[0].x.toFixed(1)},61 Z`
        : "";

    const isEsc = state.routePhase === "escaping" || state.routePhase === "recovered";
    if (pathEl) {
      pathEl.setAttribute("d", toLine(dangerPts));
      pathEl.setAttribute("stroke", "#DC2626");
    }
    if (areaEl) {
      areaEl.setAttribute("d", toArea(dangerPts));
      areaEl.setAttribute("fill", "rgba(220, 38, 38, 0.12)");
    }

    if (markersEl) {
      markersEl.innerHTML = "";
      if (escapePts.length >= 2) {
        const escArea = document.createElementNS("http://www.w3.org/2000/svg", "path");
        escArea.setAttribute("d", toArea(escapePts));
        escArea.setAttribute("fill", "rgba(5, 150, 105, 0.14)");
        markersEl.appendChild(escArea);

        const escPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        escPath.setAttribute("d", toLine(escapePts));
        escPath.setAttribute("fill", "none");
        escPath.setAttribute("stroke", "#059669");
        escPath.setAttribute("stroke-width", "2.4");
        escPath.setAttribute("stroke-linecap", "round");
        escPath.setAttribute("stroke-linejoin", "round");
        markersEl.appendChild(escPath);
      }

      pts.forEach((p, idx) => {
        if (p.event === "dispatch") {
          const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          c.setAttribute("cx", p.x.toFixed(1));
          c.setAttribute("cy", p.y.toFixed(1));
          c.setAttribute("r", "4");
          c.setAttribute("fill", "#DC2626");
          c.setAttribute("stroke", "#F59E0B");
          c.setAttribute("stroke-width", "1.6");
          markersEl.appendChild(c);
        } else if (p.event === "shelter") {
          const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          c.setAttribute("cx", p.x.toFixed(1));
          c.setAttribute("cy", p.y.toFixed(1));
          c.setAttribute("r", "4");
          c.setAttribute("fill", "#0284C7");
          c.setAttribute("stroke", "#FFFFFF");
          c.setAttribute("stroke-width", "1.6");
          markersEl.appendChild(c);
        } else if (idx === pts.length - 1) {
          const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          c.setAttribute("cx", p.x.toFixed(1));
          c.setAttribute("cy", p.y.toFixed(1));
          c.setAttribute("r", "3.8");
          c.setAttribute("fill", isEsc ? "#059669" : "#DC2626");
          c.setAttribute("stroke", "#FFFFFF");
          c.setAttribute("stroke-width", "1.2");
          markersEl.appendChild(c);
        }
      });
    }
  }

  // --- 시뮬레이터 패널 전체 UI 동기화 ---
  function updateAllSimulatorVisuals(syncMap = true) {
    if (!state.dashboard) return;
    const region = state.dashboard.regions[state.activeRegionKey];
    if (!region) return;

    const evalRes = evaluateSpatialExposure(
      region,
      state.riderLatLng || region.danger_route[0],
      state.routePhase
    );

    const scoreInt = Math.round(state.simScore);
    const minInt = Math.round(state.simMinutes);
    const pocketR = region.pocket_radius_m || 600;

    // 헤더 배지
    const badgeEl = document.getElementById("simStepBadge");
    if (state.routePhase === "idle") {
      badgeEl.textContent = "대기 · 0분";
    } else if (state.routePhase === "danger") {
      badgeEl.textContent = `큰길 · ${minInt}분`;
    } else if (state.routePhase === "escaping") {
      badgeEl.textContent = `맑은 콜 · ${minInt}분`;
    } else {
      badgeEl.textContent = `회복 완료 · ${minInt}분`;
    }

    // 대화형 라이더 상태 헤드라인
    const headlineEl = document.getElementById("simStatusHeadline");
    if (headlineEl) {
      if (state.routePhase === "idle") {
        headlineEl.textContent = "주행을 시작하면 큰길 매연 구간에서 피로도가 올라가요.";
      } else if (state.routePhase === "recovered") {
        headlineEl.textContent = "맑은 동네 콜에 도착해 매연 피로도가 안전 수준으로 내려갔어요.";
      } else if (state.routePhase === "escaping") {
        headlineEl.textContent = state.shelterVisited
          ? "라이더 쉼터에서 잠깐 쉬고 맑은 동네로 안전하게 이동 중이에요."
          : "배달 지연 0분으로 공기 맑은 동네 콜을 받아 빠져나가는 중이에요.";
      } else if (evalRes.distPocket <= pocketR * 0.55) {
        headlineEl.textContent = "매연 한가운데! 마스크로 걸러지지 않아 피로도가 빠르게 쌓여요.";
      } else if (evalRes.distPocket <= pocketR) {
        headlineEl.textContent = "큰길 매연 집중 구간 안을 달리고 있어 피로도가 계속 올라요.";
      } else if (evalRes.rate > 0.05) {
        headlineEl.textContent = "큰길 초입을 달리고 있어요. 중심부로 갈수록 피로도가 빨라져요.";
      } else {
        headlineEl.textContent = "매연 구간 밖 맑은 공기예요. 피로도가 서서히 내려갑니다.";
      }
    }

    // 상태 필 & ESG 누적 포인트
    const phasePill = document.getElementById("riderPhasePill");
    phasePill.className = "rider-tag";
    if (state.routePhase === "idle") {
      phasePill.textContent = "대기 중";
    } else if (state.routePhase === "danger") {
      phasePill.textContent = "매연 구간 주행";
      phasePill.classList.add("tag-danger");
    } else if (state.routePhase === "escaping") {
      phasePill.textContent = "맑은 콜 전환";
      phasePill.classList.add("tag-escape");
    } else {
      phasePill.textContent = "회복 완료";
    }
    document.getElementById("esgScoreBadge").textContent =
      `${state.esgPoints.toLocaleString()}P · 탈출 ${state.escapeCount}회`;

    document.getElementById("simSegmentName").textContent =
      state.currentSegmentLabel || region.danger_waypoints[0];

    // 매연 거리 & 피로 변화 속도
    const distEl = document.getElementById("simPocketDist");
    distEl.textContent = evalRes.pocketBadge;
    distEl.className = `mono-num ${evalRes.zoneClass}`;

    const deltaEl = document.getElementById("simDeltaRate");
    if (state.routePhase === "idle") {
      deltaEl.textContent = "대기 (0점/분)";
      deltaEl.className = "sim-dock-val mono-num text-slate";
    } else if (state.routePhase === "recovered") {
      deltaEl.textContent = "회복 끝 (안전)";
      deltaEl.className = "sim-dock-val mono-num text-emerald";
    } else if (evalRes.rate > 2.2) {
      deltaEl.textContent = `+${evalRes.rate.toFixed(1)}점/분 ▲ 빠름`;
      deltaEl.className = "sim-dock-val mono-num text-rose";
    } else if (evalRes.rate > 0.05) {
      deltaEl.textContent = `+${evalRes.rate.toFixed(1)}점/분 ▲ 누적`;
      deltaEl.className = "sim-dock-val mono-num text-amber";
    } else {
      deltaEl.textContent = `${evalRes.rate.toFixed(1)}점/분 ▼ 회복`;
      deltaEl.className = "sim-dock-val mono-num text-emerald";
    }

    // 게이지 바
    const scoreEl = document.getElementById("gaugeScoreText");
    scoreEl.textContent = `${scoreInt}점 / 100점`;
    scoreEl.style.color = scoreInt >= 80 ? "#DC2626" : scoreInt >= 50 ? "#B45309" : "#047857";
    document.getElementById("gaugeFill").style.width = `${clamp(state.simScore, 0, 100)}%`;

    // 통합 3열 핵심 수치 (지금 공기 / 피로 변화 / 졸음·두통)
    const no2El = document.getElementById("teleNo2");
    const ratio = evalRes.ratioVsUrban || 1.0;
    no2El.title = `실측 이산화질소(NO₂) 농도: ${evalRes.localNo2.toFixed(4)} ppm`;
    if (state.routePhase === "recovered" || (state.routePhase === "escaping" && ratio < 1.15)) {
      no2El.textContent = "상쾌·맑음";
      no2El.className = "sim-dock-val text-emerald";
    } else if (ratio >= 2.0) {
      no2El.textContent = `매우 독함 (${ratio.toFixed(1)}배)`;
      no2El.className = "sim-dock-val text-rose";
    } else if (ratio >= 1.4) {
      no2El.textContent = `매캐함 (${ratio.toFixed(1)}배)`;
      no2El.className = "sim-dock-val text-amber";
    } else if (ratio >= 1.15) {
      no2El.textContent = `탁함 (${ratio.toFixed(1)}배)`;
      no2El.className = "sim-dock-val text-sky";
    } else {
      no2El.textContent = `동네 수준 (${ratio.toFixed(1)}배)`;
      no2El.className = "sim-dock-val text-emerald";
    }

    const cohbVal = (0.7 + (state.simScore / 100) * 4.9).toFixed(1);
    const cohbEl = document.getElementById("teleCohb");
    cohbEl.title = `혈중 일산화탄소 헤모글로빈(CO-Hb) 추정: ${cohbVal}%`;
    if (state.routePhase === "recovered") {
      cohbEl.textContent = "전혀 없음";
      cohbEl.className = "sim-dock-val text-emerald";
    } else if (scoreInt >= 80) {
      cohbEl.textContent = "졸음·사고 위험!";
      cohbEl.className = "sim-dock-val text-rose";
    } else if (scoreInt >= 55) {
      cohbEl.textContent = "두통 시작 주의";
      cohbEl.className = "sim-dock-val text-amber";
    } else if (scoreInt >= 25) {
      cohbEl.textContent = "약간 나른함";
      cohbEl.className = "sim-dock-val text-sky";
    } else {
      cohbEl.textContent = "전혀 없음";
      cohbEl.className = "sim-dock-val text-emerald";
    }

    // 바로 전환 버튼 활성화 여부
    const manualBtn = document.getElementById("btnManualEscape");
    if (manualBtn) {
      manualBtn.disabled = state.routePhase === "escaping" || state.routePhase === "recovered";
    }

    // 순환 배차 승인 & 회복 카드
    const approvalCard = document.getElementById("dispatchApprovalCard");
    const mapOverlay = document.getElementById("mapDispatchOverlay");
    const call = region.escape_call;

    if (state.routePhase === "escaping" || state.routePhase === "recovered") {
      const isRec = state.routePhase === "recovered";
      const pill = document.getElementById("dispatchPill");
      pill.textContent = isRec
        ? "맑은 동네 도착 · 회복 끝!"
        : "맑은 동네 콜 배차 중";
      pill.classList.toggle("pill-recovered", isRec);

      document.getElementById("dispatchHeadline").textContent = isRec
        ? `맑은 동네에 도착해 피로도가 ${state.peakScoreBeforeEscape}점 → ${scoreInt}점으로 내려갔어요 (지연 0분)`
        : `매연 피하고 맑은 콜 이동 중 (${state.peakScoreBeforeEscape}점 → 현재 ${scoreInt}점) · ${call.order_title}`;
      document.getElementById("dispatchOrderTitle").textContent = call.order_title;
      document.getElementById("dispatchDelay").textContent = call.delay_note;
      document.getElementById("dispatchShelter").textContent = state.shelterVisited
        ? `${call.shelter_name} · 잠깐 쉬며 -18점 회복 완료`
        : `${call.shelter_name} · 지나며 -18점 바로 회복 예정`;
      document.getElementById("rewardPointsChip").textContent = isRec
        ? `그린 포인트 ${call.green_points} 적립 완료`
        : `도착 시 그린 포인트 ${call.green_points} 적립`;

      document.getElementById("mapOverlayBadge").textContent = isRec
        ? "맑은 동네 회복 완료"
        : "맑은 동네 콜 자동 전환";
      document.getElementById("mapOverlayTitle").textContent = isRec
        ? `[${region.name}] ${state.peakScoreBeforeEscape}점 → ${scoreInt}점 회복 완료 (+500P)`
        : `[${region.name}] 공기 맑은 동네 콜로 이동 중 (현재 ${scoreInt}점 ▼)`;
      document.getElementById("mapOverlayDesc").textContent =
        `배달 지연 ${call.delay_minutes}분 · ${call.shelter_name}`;

      approvalCard.classList.remove("hidden");
      mapOverlay.classList.remove("hidden");
    } else {
      approvalCard.classList.add("hidden");
      mapOverlay.classList.add("hidden");
    }

    updatePlayButtonUI();
    renderTrendChart();
    if (syncMap) {
      updateRiderMapVisuals(region);
    } else {
      updateRiderBadgeAppearance();
    }
  }

  // --- 권역 UI & KPI & 브리핑 업데이트 ---
  function renderActiveRegion(fly = true) {
    if (!state.dashboard) return;
    const region = state.dashboard.regions[state.activeRegionKey];
    if (!region) return;

    document.querySelectorAll(".region-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.region === state.activeRegionKey);
    });

    const ratio = (1 + (region.road.gap_no2_pct || 0) / 100).toFixed(1);
    const peakRatio = (1 + (region.road.gap_no2_peak_pct || 0) / 100).toFixed(1);
    const gapPctInt = Math.round(region.road.gap_no2_pct || 0);

    const heroBadge = document.getElementById("heroZoneBadge");
    if (heroBadge) heroBadge.textContent = region.name;

    const heroH1 = document.getElementById("heroRegionHeadline");
    const heroSub = document.getElementById("heroRegionSub");
    if (heroH1) {
      heroH1.textContent = "";
      heroH1.appendChild(
        document.createTextNode(`날씨앱엔 '${region.urban.weather_grade}'인데, ${region.road.stationName} 큰길 매연은 `)
      );
      const span = document.createElement("span");
      span.className = "hero-highlight mono-num";
      span.textContent = `${ratio}배(+${gapPctInt}%)`;
      heroH1.appendChild(span);
      heroH1.appendChild(document.createTextNode(" 더 독해요"));
    }
    if (heroSub) {
      heroSub.textContent =
        "KF94 마스크는 미세먼지만 막고 배기가스는 못 막아요. 피로도가 80점 넘기 전에 맑은 동네 콜로 바꿔드릴게요.";
    }

    document.getElementById("kpiUrbanName").textContent = region.urban.stationName;
    const urbanMainEl = document.getElementById("kpiUrbanPm10");
    urbanMainEl.textContent = region.urban.weather_grade;
    urbanMainEl.title = `참고 실측: 미세먼지 ${region.urban.pm10_mean} ㎍/㎥ · 가스지수 ${region.urban.risk_mean}점`;
    document.getElementById("kpiUrbanGrade").textContent =
      region.urban.pm10_mean <= 30 ? "안전" : "보통";
    document.getElementById("kpiUrbanSub").textContent = "일반 날씨앱 예보 기준";

    document.getElementById("kpiRoadName").textContent = region.road.stationName;
    const roadMainEl = document.getElementById("kpiRoadNo2");
    roadMainEl.textContent = `${ratio}배 독함`;
    roadMainEl.title = `참고 실측: NO₂ 평균 ${region.road.no2_mean} ppm · 피크 ${region.road.no2_peak} ppm`;
    document.getElementById("kpiGapBadge").textContent = `+${gapPctInt}%`;
    document.getElementById("kpiRoadSub").textContent = `마스크 차단 0% · 피크 ${peakRatio}배`;

    const riskPeakEl = document.getElementById("kpiRiskPeak");
    riskPeakEl.textContent = `${Math.round(region.road.risk_peak)}점`;
    riskPeakEl.title = `24시간 평균 위험지수 ${region.road.risk_mean}점 (동네 대비 +${region.road.gap_risk_pct}%)`;
    document.getElementById("kpiRiskGrade").textContent = region.road.road_grade;
    document.getElementById("kpiRiskSub").textContent = "80점 넘으면 맑은 콜 자동 배정";

    document.getElementById("mapSubtitle").textContent =
      `${region.name} · 동네(${region.urban.stationName})는 맑지만 ${region.road.stationName} 큰길은 매연이 ${ratio}배 높아요`;
    const zoneEl = document.getElementById("simZoneName");
    if (zoneEl) zoneEl.textContent = region.road.stationName;

    populateHourSelect(region);

    if (fly && state.map) {
      state.map.flyTo(region.center, region.zoom, { duration: 0.7 });
    }

    // 권역 전환 시 해당 권역 출발점으로 초기화
    resetRouteForNextRound(region, true);

    const list = document.getElementById("aiBriefingList");
    list.innerHTML = "";
    region.ai_briefing.forEach((line) => {
      const li = document.createElement("li");
      const sepIdx = line.indexOf(":");
      if (sepIdx > 0 && sepIdx < 32) {
        const lead = document.createElement("strong");
        lead.className = "briefing-lead";
        lead.textContent = line.slice(0, sepIdx).trim();
        const body = document.createElement("span");
        body.textContent = line.slice(sepIdx + 1).trim();
        li.appendChild(lead);
        li.appendChild(body);
      } else {
        li.textContent = line;
      }
      list.appendChild(li);
    });
  }

  // --- 헤더 메타 배지 & data.csv 테이블 렌더링 ---
  function renderMetaAndTable() {
    if (!state.dashboard) return;
    const meta = state.dashboard.meta || {};
    const badge = document.getElementById("apiStatusBadge");
    const isFallback = meta.mode === "fallback";
    badge.className = `status-badge ${isFallback ? "status-fallback" : "status-live"}`;
    badge.textContent = isFallback
      ? "백업 데이터 시연 중"
      : "에어코리아 실시간 연동";

    document.getElementById("kpiRowsCount").textContent = `${meta.total_rows || 0} 행`;
    document.getElementById("kpiImputeBadge").textContent = `결측 ${meta.imputed_cell_count || 0}건 정제`;
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
        <td class="mono-col">${r.dataTime}</td>
        <td><strong>${r.stationName}</strong></td>
        <td><span class="badge-mang ${isRoad ? "badge-road" : "badge-urban"}">${r.mangName}</span></td>
        <td class="mono-col">${r.pm10Value}</td>
        <td class="mono-col">${r.pm25Value}</td>
        <td class="mono-col">${r.o3Value}</td>
        <td class="mono-col"><strong>${r.no2Value}</strong></td>
        <td class="mono-col">${r.coValue}</td>
        <td class="mono-col"><strong class="${r.gas_risk >= 80 ? "text-rose" : "text-emerald"}">${r.gas_risk}점</strong></td>
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
    btn.textContent = "수집 중...";
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

    // 시간대 변경 (00시~23시 실측 data.csv 연동)
    document.getElementById("simHourSelect").addEventListener("change", (e) => {
      state.simHour = Number(e.target.value);
      if (state.dashboard) {
        const region = state.dashboard.regions[state.activeRegionKey];
        updateHourContextPill(region);
        const hd = getHourData(region, state.simHour);
        addEventLog(
          state.simMinutes,
          `운행 시간 변경 → ${hd.label} (큰길 위험 ${Math.round(hd.road_risk)}점 반영)`,
          ""
        );
        updateAllSimulatorVisuals(false);
      }
    });

    // 배속 버튼
    document.querySelectorAll(".speed-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.simSpeed = Number(btn.dataset.speed) || 1;
        document.querySelectorAll(".speed-btn").forEach((b) => {
          b.classList.toggle("active", b === btn);
        });
      });
    });

    // 실시간 연속 주행 시작/일시정지
    document.getElementById("btnSimPlayPause").addEventListener("click", () => {
      if (state.simRunning) {
        stopContinuousLoop();
      } else {
        startContinuousLoop();
      }
    });

    // +30분 구간 주행 (구간별 물리 적분 + 80점 돌파 시점에서 잠시 정지해 알림 확인 가능)
    document.getElementById("btnSimStep").addEventListener("click", () => {
      stepSimulation(30, { stopOnEscapeTrigger: true });
    });

    // 수동 순환배차 전환
    document.getElementById("btnManualEscape").addEventListener("click", () => {
      if (!state.dashboard) return;
      const region = state.dashboard.regions[state.activeRegionKey];
      activateCircularEscape(region, true);
      if (!state.simRunning) {
        startContinuousLoop();
      }
      updateAllSimulatorVisuals();
    });

    // 초기화
    document.getElementById("btnSimReset").addEventListener("click", () => {
      if (!state.dashboard) return;
      resetRouteForNextRound(state.dashboard.regions[state.activeRegionKey], true);
    });

    // 지도 클릭 주행 토글
    document.getElementById("btnMapClickDrive").addEventListener("click", (e) => {
      state.mapClickMode = !state.mapClickMode;
      e.target.textContent = state.mapClickMode ? "📍 지도 클릭 주행: ON" : "📍 지도 클릭 주행: OFF";
      e.target.classList.toggle("btn-mini-active", state.mapClickMode);
      const mapEl = document.getElementById("dispatchMap");
      if (mapEl) mapEl.classList.toggle("map-click-active", state.mapClickMode);
    });

    document.getElementById("btnToggleAudio").addEventListener("click", (e) => {
      state.audioEnabled = !state.audioEnabled;
      e.target.textContent = state.audioEnabled ? "🔊 경고음 ON" : "🔇 경고음 OFF";
    });

    document.getElementById("btnTileToggle").addEventListener("click", () => {
      setTileLayer(state.tileMode === "dark" ? "light" : "dark");
    });

    document.getElementById("btnToggleAllStations").addEventListener("click", (e) => {
      state.showAllStations = !state.showAllStations;
      e.target.textContent = state.showAllStations ? "서울 전체 숨기기" : "서울 전체 보기";
      renderAllStationsLayer();
    });

    document.getElementById("btnRefreshLive").addEventListener("click", () => refreshData("live"));
    document.getElementById("btnTestFallback").addEventListener("click", () => refreshData("fallback"));

    document.getElementById("csvSearchInput").addEventListener("input", renderCsvTable);
    document.getElementById("csvMangFilter").addEventListener("change", renderCsvTable);

    // R 코드 모달
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
        setTimeout(() => {
          e.target.textContent = "코드 복사";
        }, 1500);
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
