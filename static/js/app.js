/* Rider-AirGuard Frontend Control & Spatial Driving Physics Simulator */
(() => {
  "use strict";

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const state = {
    dashboard: null,
    staticMode: false,
    activeRegionKey: "gangnam",
    simHour: 18, // 18시 저녁 피크 기본
    simSpeed: 1, // 1 | 3 | 5
    simRunning: false,
    simTimer: null,
    mapClickMode: false,
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
    tileMode: "dark", // "dark" | "osm"
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
    pill.textContent = `도로변 ${hd.road_risk}점 vs 도시 ${hd.urban_risk}점`;
    pill.classList.toggle("pill-cool", hd.road_risk < 75);
  }

  // --- 공간 좌표 기반 피폭 / 환기 변화율 계산 ---
  function evaluateSpatialExposure(region, pos, phase) {
    const hd = getHourData(region, state.simHour);
    const pocketR = region.pocket_radius_m || 600;
    const distPocket = haversineMeters(pos, region.road.coords);
    const distRoad = distanceToPolylineMeters(pos, region.danger_route);
    const trafficFactor = clamp(hd.road_risk / 68, 0.55, 1.5);
    const cleanFactor = clamp(65 / Math.max(hd.urban_risk, 35), 0.75, 1.35);

    // 1. 국소 실시간 흡입 NO2 (포켓 거리 기반 연속 보간)
    const pocketRatio = clamp(1 - distPocket / (pocketR * 1.4), 0, 1);
    const localNo2 = hd.urban_no2 + (hd.road_no2 * 1.12 - hd.urban_no2) * pocketRatio;

    if (phase === "recovered") {
      return {
        distPocket,
        rate: 0,
        localNo2: hd.urban_no2 * 0.92,
        zoneText: "청정 권역 안착 완료",
        zoneClass: "text-emerald",
        pocketBadge: `${Math.round(distPocket).toLocaleString()}m · 청정 외곽`,
      };
    }

    if (phase === "escaping") {
      if (distPocket <= pocketR * 0.65) {
        return {
          distPocket,
          rate: -0.75,
          localNo2,
          zoneText: "포켓 중심 이탈 중 (감소 전환)",
          zoneClass: "text-sky",
          pocketBadge: `${Math.round(distPocket).toLocaleString()}m · 탈출 시작`,
        };
      }
      if (distPocket <= pocketR) {
        return {
          distPocket,
          rate: -1.85,
          localNo2,
          zoneText: "포켓 경계 탈출 · 환기 개시",
          zoneClass: "text-emerald",
          pocketBadge: `${Math.round(distPocket).toLocaleString()}m · 경계 이탈`,
        };
      }
      return {
        distPocket,
        rate: -2.85 * cleanFactor,
        localNo2: hd.urban_no2 * 0.94,
        zoneText: "청정 외곽 순환 · 호흡기 환기",
        zoneClass: "text-emerald",
        pocketBadge: `${Math.round(distPocket).toLocaleString()}m · 청정 외곽`,
      };
    }

    // "idle" 또는 "danger" (혹은 지도 드래그 테스트)
    if (distPocket <= pocketR * 0.55) {
      return {
        distPocket,
        rate: 3.35 * trafficFactor,
        localNo2: hd.road_no2 * 1.15,
        zoneText: "🔴 가스 포켓 중심 관통 (피폭 급증)",
        zoneClass: "text-rose",
        pocketBadge: `${Math.round(distPocket).toLocaleString()}m · 포켓 코어`,
      };
    }
    if (distPocket <= pocketR) {
      return {
        distPocket,
        rate: 2.05 * trafficFactor,
        localNo2,
        zoneText: "🟠 히든 가스 포켓 진입 (피폭 상승)",
        zoneClass: "text-amber",
        pocketBadge: `${Math.round(distPocket).toLocaleString()}m · 포켓 내부`,
      };
    }
    if (distRoad <= 380) {
      return {
        distPocket,
        rate: 0.55 * trafficFactor,
        localNo2: hd.urban_no2 + (hd.road_no2 - hd.urban_no2) * 0.35,
        zoneText: "🟡 대로변 외곽 진입 (완만 누적)",
        zoneClass: "text-sky",
        pocketBadge: `${Math.round(distPocket).toLocaleString()}m · 포켓 외곽`,
      };
    }

    return {
      distPocket,
      rate: -1.75 * cleanFactor,
      localNo2: hd.urban_no2 * 0.92,
      zoneText: "🟢 청정 주거권역 (자연 환기)",
      zoneClass: "text-emerald",
      pocketBadge: `${Math.round(distPocket).toLocaleString()}m · 청정 외곽`,
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

    if (!isManual) {
      playEmergencyChime();
      addEventLog(
        state.simMinutes,
        `🚨 임계치 80점 돌파 (${Math.round(state.simScore)}점)! 지연 0분 외곽 순환 배차 자동 발동`,
        "ev-danger"
      );
    } else {
      playRecoveryChime();
      addEventLog(
        state.simMinutes,
        `🌿 수동 순환 배차 전환 (${Math.round(state.simScore)}점) — ${region.escape_call.shelter_name} 경유 시작`,
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
    const sliceSize = 0.4; // 0.4분 단위로 구간·포켓·쉼터 정밀 적분
    let rem = totalDtMin;

    if (state.routePhase === "idle") {
      state.routePhase = "danger";
      state.simHistory = [{ min: state.simMinutes, score: state.simScore, phase: "danger", event: null }];
      state.lastHistoryMin = state.simMinutes;
      addEventLog(state.simMinutes, `🛵 ${region.danger_waypoints[0]} 출발 — 대로변 배달 콜 주행 시작`, "");
    } else if (state.routePhase === "recovered") {
      // 다음 상권 콜 이어서 주행 시작
      resetRouteForNextRound(region, false);
      state.routePhase = "danger";
      addEventLog(state.simMinutes, `🛵 다음 상권 배달 콜 주행 개시 (${region.danger_waypoints[0]})`, "");
    }

    while (rem > 1e-4) {
      const dt = Math.min(sliceSize, rem);
      rem -= dt;

      // 1. 이동 처리
      if (state.customTarget) {
        const res = moveTowardTarget(state.riderLatLng, state.customTarget, 230 * dt);
        state.riderLatLng = res.pos;
        state.currentSegmentLabel = "사용자 지정 지점 주행 중";
        if (res.arrived) {
          state.customTarget = null;
          state.manualPositionHold = true;
          if (state.targetMarker && state.riderLayer) {
            state.riderLayer.removeLayer(state.targetMarker);
            state.targetMarker = null;
          }
          addEventLog(state.simMinutes, "📍 지정 목적지 도착 — 현재 구역 공기 노출/환기 측정 중", "ev-shelter");
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
          state.currentSegmentLabel = "수동 배치 지점 정밀 관측 중";
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
              `🛡️ ${region.shelters[0].name} 환기·산소 휴식 (-18점 즉시 회복!)`,
              "ev-shelter"
            );
            pushHistorySample(state.simMinutes + dt, state.simScore, "escaping", "shelter");
          }
        }

        if (res.finished) {
          // 외곽 청정단지 도착 후 20점 이하까지 자연 환기 마감
          if (state.simScore > 20) {
            state.currentSegmentLabel = `${region.escape_waypoints[region.escape_waypoints.length - 1]} (청정 환기 마감)`;
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
            `✅ ${region.escape_waypoints[region.escape_waypoints.length - 1]} 안착! 최종 ${Math.round(state.simScore)}점 회복 (+500P 지급)`,
            "ev-escape"
          );
          playRecoveryChime();
          stopContinuousLoop();
          break;
        }
      }

      // 이동 궤적 기록
      const lastTr = state.traveledPoints[state.traveledPoints.length - 1];
      if (!lastTr || haversineMeters(lastTr, state.riderLatLng) > 35) {
        state.traveledPoints.push([state.riderLatLng[0], state.riderLatLng[1]]);
        if (state.traveledPoints.length > 220) state.traveledPoints.shift();
      }

      // 2. 공간 가스 노출 / 환기 계산
      const evalRes = evaluateSpatialExposure(region, state.riderLatLng, state.routePhase);
      state.lastDeltaPerMin = evalRes.rate;
      const floorScore = state.peakScoreBeforeEscape > 0 ? 12 : 0;
      state.simScore = clamp(state.simScore + evalRes.rate * dt, floorScore, 100);
      state.simMinutes += dt;

      // 가스 포켓 첫 진입 로그
      const pocketR = region.pocket_radius_m || 600;
      if (state.routePhase === "danger" && !state.enteredPocketLogged && evalRes.distPocket <= pocketR) {
        state.enteredPocketLogged = true;
        addEventLog(
          state.simMinutes,
          `🔴 ${region.road.displayName} 가스 포켓(${pocketR}m) 진입 — 마스크 투과 피폭 가속`,
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
      btn.textContent = "⏸ 주행 일시정지";
    } else if (state.routePhase === "recovered") {
      btn.textContent = "🛵 다음 상권 콜 주행";
    } else if (state.routePhase === "idle") {
      btn.textContent = "▶ 실시간 구간 주행 시작";
    } else {
      btn.textContent = "▶ 실시간 주행 재개";
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
      state.currentSegmentLabel = `${region.danger_waypoints[0]} (출발 대기)`;
      state.traveledPoints = [[startPt[0], startPt[1]]];
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
          text: `${region ? region.danger_waypoints[0] : "출발지"} 대기 중 — 주행 시작 시 가스 포켓 통과에 따라 게이지가 실시간 반응합니다.`,
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
      color: "#1d4ed8",
      weight: 18,
      opacity: 0.16,
      interactive: false,
    }).addTo(state.map);

    setTileLayer("dark");
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
        color: "#38bdf8",
        fillColor: "#0ea5e9",
        fillOpacity: 0.5,
        weight: 2,
      })
        .bindTooltip("지정 목적지")
        .addTo(state.riderLayer);

      addEventLog(state.simMinutes, "📍 지도 클릭 목적지 설정 — 실시간 이동 중", "ev-shelter");
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

  // 정적 권역 레이어 렌더링 (측정소, 가스 포켓, 쉼터, 경로선, 구간 웨이포인트)
  function renderRegionBaseLayers(region) {
    if (!state.regionLayer || !region) return;
    state.regionLayer.clearLayers();
    const isEscaping = state.routePhase === "escaping" || state.routePhase === "recovered";
    const pocketR = region.pocket_radius_m || 600;

    // 1. 도로변 히든 가스 포켓 원 (핵심 + 외곽 2단 시각화)
    state.pocketCircle = L.circle(region.road.coords, {
      radius: pocketR,
      color: "#ef4444",
      weight: 1.6,
      dashArray: "6 6",
      fillColor: "#ef4444",
      fillOpacity: isEscaping ? 0.12 : 0.22,
    }).addTo(state.regionLayer);

    L.circle(region.road.coords, {
      radius: Math.round(pocketR * 0.55),
      color: "#f87171",
      weight: 1,
      dashArray: "3 4",
      fillColor: "#dc2626",
      fillOpacity: isEscaping ? 0.08 : 0.18,
      interactive: false,
    }).addTo(state.regionLayer);

    // 2. 도시대기 측정소
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

    // 3. 도로변 대기측정소 (펄스)
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

    // 4. 지자체 이동노동자 쉼터
    region.shelters.forEach((sh, idx) => {
      const shIcon = L.divIcon({
        className: "",
        html: `<div class="shelter-pin" title="${sh.name}">🛡️</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      const sm = L.marker(sh.coords, { icon: shIcon, zIndexOffset: 400 }).addTo(state.regionLayer);
      sm.bindTooltip(`이동노동자 쉼터: ${sh.name}${idx === 0 ? " (경유 시 -18점 환기)" : ""}`, {
        direction: "top",
        offset: [0, -12],
      });
      sm.bindPopup(
        `<strong>🛡️ ${sh.name}</strong><br/>` +
          `위치: ${sh.address}<br/>` +
          `운영: ${sh.hours}`
      );
    });

    // 5. 대로변 위험 루트 및 구간 노드
    L.polyline(region.danger_route, {
      color: "#ef4444",
      weight: isEscaping ? 3 : 5,
      opacity: isEscaping ? 0.32 : 0.88,
      dashArray: "10 8",
    })
      .bindTooltip("고농도 매연 노출 대로변 상권 루트", { sticky: true })
      .addTo(state.regionLayer);

    region.danger_route.forEach((pt, i) => {
      const wpName = (region.danger_waypoints && region.danger_waypoints[i]) || `구간 ${i + 1}`;
      L.circleMarker(pt, {
        radius: 4,
        color: "#fecaca",
        fillColor: "#ef4444",
        fillOpacity: isEscaping ? 0.35 : 0.85,
        weight: 1.5,
      })
        .bindTooltip(`대로변 거점: ${wpName}`, { direction: "top" })
        .addTo(state.regionLayer);
    });

    // 6. 외곽 청정 순환 배차 루트 (대기 중엔 은은한 미리보기 점선, 발동 후 선명한 초록 실선)
    const activeEsc = state.escapePath.length >= 2 ? state.escapePath : region.escape_route;
    L.polyline(activeEsc, {
      color: "#10b981",
      weight: isEscaping ? 6 : 2.5,
      opacity: isEscaping ? 0.95 : 0.32,
      dashArray: isEscaping ? null : "4 6",
    })
      .bindTooltip("지연 0분! 외곽 청정 주거권역 우선 순환 배차 루트", { sticky: true })
      .addTo(state.regionLayer);

    if (isEscaping && region.shelters[0]) {
      L.circle(region.shelters[0].coords, {
        radius: 170,
        color: "#38bdf8",
        weight: 2,
        fillColor: "#38bdf8",
        fillOpacity: 0.22,
      }).addTo(state.regionLayer);
    }

    region.escape_route.forEach((pt, i) => {
      const wpName = (region.escape_waypoints && region.escape_waypoints[i]) || `청정 거점 ${i + 1}`;
      L.circleMarker(pt, {
        radius: isEscaping ? 4.5 : 3.5,
        color: "#a7f3d0",
        fillColor: "#10b981",
        fillOpacity: isEscaping ? 0.9 : 0.45,
        weight: 1.5,
      })
        .bindTooltip(`청정 경로: ${wpName}`, { direction: "top" })
        .addTo(state.regionLayer);
    });
  }

  // 라이더 마커 및 주행 궤적 업데이트 (깜빡임 없이 부드럽게 위치/배지 갱신)
  function ensureRiderMarker(region) {
    if (!state.riderLayer || !region) return;
    if (!state.riderLatLng) {
      const startPt = region.danger_route[0];
      state.riderLatLng = [startPt[0], startPt[1]];
    }

    if (!state.dangerTrailPoly) {
      state.dangerTrailPoly = L.polyline(state.dangerTrailPoints, {
        color: "#fbbf24",
        weight: 3.2,
        opacity: 0.78,
      }).addTo(state.riderLayer);
    }

    if (!state.escapeTrailPoly) {
      state.escapeTrailPoly = L.polyline(state.escapeTrailPoints, {
        color: "#38bdf8",
        weight: 4,
        opacity: 0.9,
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
        "<strong>라이더 김성원 (드래그 가능)</strong><br/>지도의 붉은 가스 포켓 안팎으로 끌어당겨 피폭·환기 변화를 즉시 테스트할 수 있습니다."
      );

      state.riderMarker.on("drag", (ev) => {
        const ll = ev.target.getLatLng();
        state.riderLatLng = [ll.lat, ll.lng];
        if (state.routePhase === "idle") {
          state.routePhase = "danger";
        }
        state.manualPositionHold = true;
        state.customTarget = null;
        state.currentSegmentLabel = "수동 드래그 위치 관측 중";
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
    if (!svg) return;
    const hist = state.simHistory;
    const W = 360;
    const H = 78;
    const padX = 6;
    const yOf = (sc) => 73 - (clamp(sc, 0, 100) / 100) * 67; // 0->73, 100->6, 80->19.4

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
        ? `${toLine(arr)} L${arr[arr.length - 1].x.toFixed(1)},73 L${arr[0].x.toFixed(1)},73 Z`
        : "";

    const isEsc = state.routePhase === "escaping" || state.routePhase === "recovered";
    if (pathEl) {
      pathEl.setAttribute("d", toLine(dangerPts));
      pathEl.setAttribute("stroke", "#f87171");
    }
    if (areaEl) {
      areaEl.setAttribute("d", toArea(dangerPts));
      areaEl.setAttribute("fill", "rgba(239, 68, 68, 0.16)");
    }

    if (markersEl) {
      markersEl.innerHTML = "";
      if (escapePts.length >= 2) {
        const escArea = document.createElementNS("http://www.w3.org/2000/svg", "path");
        escArea.setAttribute("d", toArea(escapePts));
        escArea.setAttribute("fill", "rgba(16, 185, 129, 0.18)");
        markersEl.appendChild(escArea);

        const escPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        escPath.setAttribute("d", toLine(escapePts));
        escPath.setAttribute("fill", "none");
        escPath.setAttribute("stroke", "#10b981");
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
          c.setAttribute("fill", "#ef4444");
          c.setAttribute("stroke", "#fef08a");
          c.setAttribute("stroke-width", "1.5");
          markersEl.appendChild(c);
        } else if (p.event === "shelter") {
          const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          c.setAttribute("cx", p.x.toFixed(1));
          c.setAttribute("cy", p.y.toFixed(1));
          c.setAttribute("r", "4");
          c.setAttribute("fill", "#38bdf8");
          c.setAttribute("stroke", "#ffffff");
          c.setAttribute("stroke-width", "1.5");
          markersEl.appendChild(c);
        } else if (idx === pts.length - 1) {
          const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          c.setAttribute("cx", p.x.toFixed(1));
          c.setAttribute("cy", p.y.toFixed(1));
          c.setAttribute("r", "3.5");
          c.setAttribute("fill", isEsc ? "#34d399" : "#fb7185");
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

    // 헤더 배지
    const badgeEl = document.getElementById("simStepBadge");
    if (state.routePhase === "idle") {
      badgeEl.textContent = "대기 (0분)";
    } else if (state.routePhase === "danger") {
      badgeEl.textContent = `대로변 주행 (${minInt}분)`;
    } else if (state.routePhase === "escaping") {
      badgeEl.textContent = `청정 탈출 중 (${minInt}분)`;
    } else {
      badgeEl.textContent = `회복 완료 (${minInt}분)`;
    }

    // 상태 필 & ESG 누적 포인트
    const phasePill = document.getElementById("riderPhasePill");
    phasePill.className = "rider-tag";
    if (state.routePhase === "idle") {
      phasePill.textContent = "대기 중";
    } else if (state.routePhase === "danger") {
      phasePill.textContent = "대로변 피폭 관제";
      phasePill.classList.add("tag-danger");
    } else if (state.routePhase === "escaping") {
      phasePill.textContent = "청정 순환 탈출";
      phasePill.classList.add("tag-escape");
    } else {
      phasePill.textContent = "청정 안착 완료";
    }
    document.getElementById("esgScoreBadge").textContent =
      `누적 ${state.esgPoints.toLocaleString()}P · 탈출 ${state.escapeCount}회`;

    document.getElementById("simSegmentName").textContent =
      state.currentSegmentLabel || `${region.danger_waypoints[0]} (출발 대기)`;

    // 포켓 거리 & 변화율 바
    const distEl = document.getElementById("simPocketDist");
    distEl.textContent = evalRes.pocketBadge;
    distEl.className = `sp-val ${evalRes.zoneClass}`;

    const deltaEl = document.getElementById("simDeltaRate");
    if (state.routePhase === "idle") {
      deltaEl.textContent = "0.0점/분 (대기 중)";
      deltaEl.className = "sp-val text-slate";
    } else if (state.routePhase === "recovered") {
      deltaEl.textContent = "0.0점/분 (회복 완료)";
      deltaEl.className = "sp-val text-emerald";
    } else if (evalRes.rate > 0.05) {
      deltaEl.textContent = `+${evalRes.rate.toFixed(1)}점/분 ▲ 피폭 누적`;
      deltaEl.className = evalRes.rate > 2.2 ? "sp-val text-rose" : "sp-val text-amber";
    } else {
      deltaEl.textContent = `${evalRes.rate.toFixed(1)}점/분 ▼ 호흡기 환기`;
      deltaEl.className = "sp-val text-emerald";
    }

    // 게이지 바
    const scoreEl = document.getElementById("gaugeScoreText");
    scoreEl.textContent = `${scoreInt}점 / 100점`;
    scoreEl.style.color = scoreInt >= 80 ? "#f87171" : scoreInt >= 50 ? "#fbbf24" : "#34d399";
    document.getElementById("gaugeFill").style.width = `${clamp(state.simScore, 0, 100)}%`;

    // 텔레메트리 (국소 NO2, CO-Hb, 뇌 산소/졸음 경보)
    document.getElementById("teleNo2").textContent = `${evalRes.localNo2.toFixed(4)} ppm`;
    const cohb = (0.7 + (state.simScore / 100) * 4.9).toFixed(1);
    document.getElementById("teleCohb").textContent = `${cohb} %`;

    const alertEl = document.getElementById("teleAlertLevel");
    if (state.routePhase === "recovered" || (state.routePhase === "escaping" && scoreInt < 40)) {
      alertEl.textContent = "🟢 정상 회복 (환기 양호)";
      alertEl.className = "tele-val text-emerald";
    } else if (state.routePhase === "escaping") {
      alertEl.textContent = "🔵 환기 회복 중 (이탈)";
      alertEl.className = "tele-val text-sky";
    } else if (scoreInt >= 80) {
      alertEl.textContent = "🚨 위험 (졸음·추돌 고위험)";
      alertEl.className = "tele-val text-rose";
    } else if (scoreInt >= 55) {
      alertEl.textContent = "🟠 경고 (경미한 두통·피로)";
      alertEl.className = "tele-val text-amber";
    } else if (scoreInt >= 25) {
      alertEl.textContent = "🟡 주의 (초기 기도 자극)";
      alertEl.className = "tele-val text-sky";
    } else {
      alertEl.textContent = "🟢 정상 (집중 양호)";
      alertEl.className = "tele-val text-emerald";
    }

    // 수동 순환배차 버튼 활성화 여부
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
        ? "✅ 청정 권역 안착 & 호흡기 환기 완료"
        : "🚨 순환 배차 가동 · 외곽 청정 환기 중";
      pill.classList.toggle("pill-recovered", isRec);

      document.getElementById("dispatchHeadline").textContent = isRec
        ? `✅ 청정 권역 안착 완료! 가스 게이지 ${state.peakScoreBeforeEscape}점 → ${scoreInt}점 회복 (지연 0분)`
        : `🚨 순환 배차 전환 (${state.peakScoreBeforeEscape}점 → 현재 ${scoreInt}점 하락 중) · '${call.order_title}'`;
      document.getElementById("dispatchOrderTitle").textContent = call.order_title;
      document.getElementById("dispatchDelay").textContent = call.delay_note;
      document.getElementById("dispatchShelter").textContent = state.shelterVisited
        ? `${call.shelter_name} · 환기 휴식 -18점 완료`
        : `${call.shelter_name} · 경유 예정 (-18점 환기)`;
      document.getElementById("rewardPointsChip").textContent = isRec
        ? `🌿 그린 배차 포인트 ${call.green_points} 지급 완료`
        : `🌿 도착 시 그린 포인트 ${call.green_points} 지급`;

      document.getElementById("mapOverlayBadge").textContent = isRec
        ? "청정 권역 환기 회복 완료"
        : "AI 권역 탈출 순환 배차 가동";
      document.getElementById("mapOverlayTitle").textContent = isRec
        ? `[${region.name}] ${state.peakScoreBeforeEscape}점 → ${scoreInt}점 회복 완료 (+500P)`
        : `[${region.name}] 외곽 청정 순환 배차 주행 중 (현재 ${scoreInt}점 ▼)`;
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

    document.getElementById("mapSubtitle").textContent =
      `${region.name} · ${region.urban.stationName}(도시대기) vs ${region.road.displayName} 격차 분석`;
    document.getElementById("simZoneName").textContent = region.road.displayName;

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
      li.textContent = line;
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

    // 시간대 변경 (00시~23시 실측 data.csv 연동)
    document.getElementById("simHourSelect").addEventListener("change", (e) => {
      state.simHour = Number(e.target.value);
      if (state.dashboard) {
        const region = state.dashboard.regions[state.activeRegionKey];
        updateHourContextPill(region);
        const hd = getHourData(region, state.simHour);
        addEventLog(
          state.simMinutes,
          `🕒 운행 시간대 변경 → ${hd.label} (도로변 위험지수 ${hd.road_risk}점 반영)`,
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
