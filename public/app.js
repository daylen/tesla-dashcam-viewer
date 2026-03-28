const cameraOrder = [
  "front",
  "back",
  "left_pillar",
  "right_pillar",
  "left_repeater",
  "right_repeater",
];

const elements = {
  eventList: document.querySelector("#eventList"),
  eventTitle: document.querySelector("#eventTitle"),
  eventSubtitle: document.querySelector("#eventSubtitle"),
  exportButton: document.querySelector("#exportButton"),
  exportBanner: document.querySelector("#exportBanner"),
  exportStatusLabel: document.querySelector("#exportStatusLabel"),
  exportPercent: document.querySelector("#exportPercent"),
  exportProgressFill: document.querySelector("#exportProgressFill"),
  exportStatusDetail: document.querySelector("#exportStatusDetail"),
  refreshButton: document.querySelector("#refreshButton"),
  timelineRange: document.querySelector("#timelineRange"),
  timelinePosition: document.querySelector("#timelinePosition"),
  segmentLabel: document.querySelector("#segmentLabel"),
  speedTimelineCanvas: document.querySelector("#speedTimelineCanvas"),
  speedTimelineOverlay: document.querySelector("#speedTimelineOverlay"),
  speedTimelineLabel: document.querySelector("#speedTimelineLabel"),
  apTimelineCanvas: document.querySelector("#apTimelineCanvas"),
  apTimelineOverlay: document.querySelector("#apTimelineOverlay"),
  apTimelineLabel: document.querySelector("#apTimelineLabel"),
  selectionTrack: document.querySelector("#selectionTrack"),
  selectionWindow: document.querySelector("#selectionWindow"),
  selectionStartHandle: document.querySelector("#selectionStartHandle"),
  selectionEndHandle: document.querySelector("#selectionEndHandle"),
  selectionLabel: document.querySelector("#selectionLabel"),
  clearSelectionButton: document.querySelector("#clearSelectionButton"),
  videoWall: document.querySelector("#videoWall"),
  playbackGlyph: document.querySelector("#playbackGlyph"),
  telemetryStatus: document.querySelector("#telemetryStatus"),
  speedValue: document.querySelector("#speedValue"),
  autopilotValue: document.querySelector("#autopilotValue"),
  gearValue: document.querySelector("#gearValue"),
  steeringValue: document.querySelector("#steeringValue"),
  brakeValue: document.querySelector("#brakeValue"),
  blinkersValue: document.querySelector("#blinkersValue"),
  latitudeValue: document.querySelector("#latitudeValue"),
  longitudeValue: document.querySelector("#longitudeValue"),
  headingValue: document.querySelector("#headingValue"),
  miniMapImage: document.querySelector("#miniMapImage"),
  miniMapCanvas: document.querySelector("#miniMapCanvas"),
  miniMapStatus: document.querySelector("#miniMapStatus"),
  miniMapCaption: document.querySelector("#miniMapCaption"),
  segmentsPanel: document.querySelector("#segmentsPanel"),
  segmentsToggle: document.querySelector("#segmentsToggle"),
  segmentList: document.querySelector("#segmentList"),
  segmentCountLabel: document.querySelector("#segmentCountLabel"),
};

const videos = Object.fromEntries(
  cameraOrder.map((cameraName) => [cameraName, document.querySelector(`#video-${cameraName}`)]),
);
const videoCards = [...document.querySelectorAll(".video-card")];
const videoToggleButtons = [...document.querySelectorAll("[data-toggle-playback]")];

const state = {
  events: [],
  selectedEventId: null,
  event: null,
  activeSegmentIndex: 0,
  globalTime: 0,
  pendingSeekTime: 0,
  isPlaying: false,
  pollTimer: null,
  exportRequest: null,
  selection: null,
  dragSelection: null,
  playbackFlashGlyph: null,
  playbackFlashTimer: null,
};

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(value / 60);
  const secs = value % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatDate(info, fallbackId) {
  if (!info?.timestamp) {
    return fallbackId;
  }

  const date = new Date(info.timestamp);
  return date.toLocaleString();
}

function clamp01(value) {
  return Math.max(0, Math.min(value, 1));
}

function setExportBanner({ status = "idle", label, detail, detailHtml = null, progress = 0 }) {
  elements.exportBanner.classList.remove("is-idle", "is-running", "is-done", "is-failed");
  elements.exportBanner.classList.add(`is-${status}`);
  elements.exportStatusLabel.textContent = label;
  elements.exportPercent.textContent = `${Math.round(clamp01(progress) * 100)}%`;
  elements.exportProgressFill.style.width = `${clamp01(progress) * 100}%`;
  if (detailHtml !== null) {
    elements.exportStatusDetail.innerHTML = detailHtml;
  } else {
    elements.exportStatusDetail.textContent = detail;
  }
}

function setSegmentsCollapsed(collapsed) {
  elements.segmentsPanel.classList.toggle("is-collapsed", collapsed);
  elements.segmentsToggle.setAttribute("aria-expanded", String(!collapsed));
}

function setVideoToggleDisabled(disabled) {
  for (const button of videoToggleButtons) {
    button.disabled = disabled;
  }
  for (const card of videoCards) {
    card.classList.toggle("is-toggle-disabled", disabled);
  }
}

function renderPlaybackOverlay() {
  const showPaused = Boolean(state.event) && !state.isPlaying;
  const isFlashing = Boolean(state.playbackFlashGlyph);
  const glyph = state.playbackFlashGlyph ?? "▶";

  elements.playbackGlyph.textContent = glyph;
  elements.videoWall.classList.toggle("is-paused", showPaused);
  elements.videoWall.classList.toggle("is-flashing", isFlashing);
}

function clearPlaybackFlash() {
  if (state.playbackFlashTimer) {
    window.clearTimeout(state.playbackFlashTimer);
    state.playbackFlashTimer = null;
  }
  state.playbackFlashGlyph = null;
}

function flashPlaybackOverlay(glyph) {
  clearPlaybackFlash();
  state.playbackFlashGlyph = glyph;
  renderPlaybackOverlay();
  state.playbackFlashTimer = window.setTimeout(() => {
    state.playbackFlashGlyph = null;
    state.playbackFlashTimer = null;
    renderPlaybackOverlay();
  }, 650);
}

function pauseAllVideos() {
  for (const video of Object.values(videos)) {
    video?.pause();
  }
}

function buildBlinkerMarkup(point) {
  const icons = [];
  if (point.blinkerOnLeft) {
    icons.push(`
      <span class="blinker-icon" title="Left blinker on" aria-label="Left blinker on">
        <svg viewBox="0 0 24 24" role="presentation" focusable="false">
          <path d="M11 5 3 12l8 7v-4h10v-6H11z"></path>
        </svg>
      </span>
    `);
  }
  if (point.blinkerOnRight) {
    icons.push(`
      <span class="blinker-icon" title="Right blinker on" aria-label="Right blinker on">
        <svg viewBox="0 0 24 24" role="presentation" focusable="false">
          <path d="M13 5v4H3v6h10v4l8-7z"></path>
        </svg>
      </span>
    `);
  }

  if (!icons.length) {
    return '<span class="blinker-off">Off</span>';
  }

  return `<span class="blinker-icons">${icons.join("")}</span>`;
}

function resizeCanvasToDisplay(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function clearCanvas(canvas) {
  const { context, width, height } = resizeCanvasToDisplay(canvas);
  context.clearRect(0, 0, width, height);
}

function timelineMarkerX(width, timeSeconds, durationSeconds) {
  if (!durationSeconds) {
    return 0;
  }
  return (clampTime(timeSeconds) / durationSeconds) * width;
}

function isFsdActive(point) {
  return point?.autopilotState === 1 || point?.autopilotLabel === "FSD";
}

function sampleTimelinePoints(timeline, width) {
  if (!timeline.length) {
    return [];
  }

  const step = Math.max(1, Math.ceil(timeline.length / Math.max(width, 1)));
  const sampled = [];
  for (let index = 0; index < timeline.length; index += step) {
    sampled.push(timeline[index]);
  }
  if (sampled[sampled.length - 1] !== timeline[timeline.length - 1]) {
    sampled.push(timeline[timeline.length - 1]);
  }
  return sampled;
}

function drawSpeedTimelineBase() {
  const canvas = elements.speedTimelineCanvas;
  const { context, width, height } = resizeCanvasToDisplay(canvas);
  context.clearRect(0, 0, width, height);

  const timeline = state.event?.metadataTimeline ?? [];
  const duration = eventDuration();

  if (!timeline.length || !duration) {
    elements.speedTimelineLabel.textContent = "--";
    return;
  }

  const sampled = sampleTimelinePoints(timeline, width);
  const maxSpeed = Math.max(5, ...sampled.map((point) => point.speedMph || 0));
  const padX = 8;
  const padY = 8;
  const innerWidth = Math.max(width - (padX * 2), 1);
  const innerHeight = Math.max(height - (padY * 2), 1);

  context.strokeStyle = "rgba(255, 255, 255, 0.08)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, height - 0.5);
  context.lineTo(width, height - 0.5);
  context.moveTo(0, padY + 0.5);
  context.lineTo(width, padY + 0.5);
  context.stroke();

  const tracePoints = sampled.map((point) => {
    const x = padX + ((point.timeSeconds / duration) * innerWidth);
    const y = height - padY - (((point.speedMph || 0) / maxSpeed) * innerHeight);
    return { x, y };
  });

  if (tracePoints.length) {
    context.beginPath();
    context.moveTo(tracePoints[0].x, height - padY);
    for (const point of tracePoints) {
      context.lineTo(point.x, point.y);
    }
    context.lineTo(tracePoints[tracePoints.length - 1].x, height - padY);
    context.closePath();
    context.fillStyle = "rgba(36, 209, 255, 0.16)";
    context.fill();

    context.beginPath();
    context.moveTo(tracePoints[0].x, tracePoints[0].y);
    for (const point of tracePoints.slice(1)) {
      context.lineTo(point.x, point.y);
    }
    context.strokeStyle = "#24d1ff";
    context.lineWidth = 2;
    context.stroke();
  }

  elements.speedTimelineLabel.textContent = `${Math.round(maxSpeed)} mph max`;
}

function drawApTimelineBase() {
  const canvas = elements.apTimelineCanvas;
  const { context, width, height } = resizeCanvasToDisplay(canvas);
  context.clearRect(0, 0, width, height);

  const timeline = state.event?.metadataTimeline ?? [];
  const duration = eventDuration();

  if (!timeline.length || !duration) {
    elements.apTimelineLabel.textContent = "--";
    return;
  }

  let lastX = 0;
  for (let index = 0; index < timeline.length; index += 1) {
    const point = timeline[index];
    const nextPoint = timeline[index + 1];
    const startX = (point.timeSeconds / duration) * width;
    const endX = nextPoint ? (nextPoint.timeSeconds / duration) * width : width;

    if (endX <= startX) {
      continue;
    }

    context.fillStyle = isFsdActive(point) ? "rgba(52, 140, 255, 0.9)" : "rgba(130, 146, 166, 0.45)";
    context.fillRect(startX, 0, Math.max(endX - startX, 1), height);
    lastX = endX;
  }

  if (lastX < width) {
    context.fillStyle = "rgba(130, 146, 166, 0.45)";
    context.fillRect(lastX, 0, width - lastX, height);
  }

  context.strokeStyle = "rgba(255, 255, 255, 0.12)";
  context.lineWidth = 1;
  context.strokeRect(0.5, 0.5, width - 1, height - 1);

  elements.apTimelineLabel.textContent = "Blue = FSD";
}

function drawTelemetryTimelineOverlay(point) {
  const speedOverlay = resizeCanvasToDisplay(elements.speedTimelineOverlay);
  const apOverlay = resizeCanvasToDisplay(elements.apTimelineOverlay);
  speedOverlay.context.clearRect(0, 0, speedOverlay.width, speedOverlay.height);
  apOverlay.context.clearRect(0, 0, apOverlay.width, apOverlay.height);

  const duration = eventDuration();
  if (!state.event || !duration) {
    elements.speedTimelineLabel.textContent = "--";
    elements.apTimelineLabel.textContent = "--";
    return;
  }

  const speedX = timelineMarkerX(speedOverlay.width, state.globalTime, duration);
  speedOverlay.context.strokeStyle = "rgba(255, 255, 255, 0.9)";
  speedOverlay.context.lineWidth = 2;
  speedOverlay.context.beginPath();
  speedOverlay.context.moveTo(speedX, 0);
  speedOverlay.context.lineTo(speedX, speedOverlay.height);
  speedOverlay.context.stroke();

  const timeline = state.event.metadataTimeline ?? [];
  if (timeline.length && point) {
    const maxSpeed = Math.max(5, ...timeline.map((entry) => entry.speedMph || 0));
    const padX = 8;
    const padY = 8;
    const innerWidth = Math.max(speedOverlay.width - (padX * 2), 1);
    const innerHeight = Math.max(speedOverlay.height - (padY * 2), 1);
    const dotX = padX + ((point.timeSeconds / duration) * innerWidth);
    const dotY = speedOverlay.height - padY - (((point.speedMph || 0) / maxSpeed) * innerHeight);

    speedOverlay.context.fillStyle = "#58d1b2";
    speedOverlay.context.beginPath();
    speedOverlay.context.arc(dotX, dotY, 4.5, 0, Math.PI * 2);
    speedOverlay.context.fill();

    elements.speedTimelineLabel.textContent = `${Math.round(point.speedMph || 0)} mph`;
    elements.apTimelineLabel.textContent = point.autopilotLabel || "Off";
  }

  const apX = timelineMarkerX(apOverlay.width, state.globalTime, duration);
  apOverlay.context.strokeStyle = "rgba(255, 255, 255, 0.95)";
  apOverlay.context.lineWidth = 2;
  apOverlay.context.beginPath();
  apOverlay.context.moveTo(apX, 0);
  apOverlay.context.lineTo(apX, apOverlay.height);
  apOverlay.context.stroke();
}

function redrawTelemetryTimelines() {
  drawSpeedTimelineBase();
  drawApTimelineBase();
  drawTelemetryTimelineOverlay(getMetadataAtTime(state.globalTime));
}

function lonToMercatorX(longitude) {
  return (longitude + 180) / 360;
}

function latToMercatorY(latitude) {
  const clamped = Math.max(-85, Math.min(85, latitude));
  const radians = clamped * (Math.PI / 180);
  return (1 - Math.log(Math.tan(radians) + (1 / Math.cos(radians))) / Math.PI) / 2;
}

function eventDuration() {
  return state.event?.totalDurationSeconds ?? 0;
}

function clampTime(timeSeconds) {
  return Math.max(0, Math.min(timeSeconds, eventDuration()));
}

function exportRange() {
  if (!state.selection || Math.abs(state.selection.end - state.selection.start) < 0.05) {
    return { startSeconds: 0, endSeconds: eventDuration(), selected: false };
  }

  return {
    startSeconds: Math.min(state.selection.start, state.selection.end),
    endSeconds: Math.max(state.selection.start, state.selection.end),
    selected: true,
  };
}

function activeExportRange() {
  return state.exportRequest ?? exportRange();
}

function findSegmentIndexAtTime(timeSeconds) {
  if (!state.event) {
    return 0;
  }

  const segments = state.event.segments;
  const found = segments.findIndex((segment, index) => {
    const next = segments[index + 1];
    return timeSeconds >= segment.offsetSeconds && (!next || timeSeconds < next.offsetSeconds);
  });

  return found === -1 ? Math.max(segments.length - 1, 0) : found;
}

function getMetadataAtTime(timeSeconds) {
  const timeline = state.event?.metadataTimeline ?? [];
  if (!timeline.length) {
    return null;
  }

  let low = 0;
  let high = timeline.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (timeline[mid].timeSeconds <= timeSeconds) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return timeline[Math.max(high, 0)] ?? null;
}

function setMiniMapState(label, caption, imageUrl = "") {
  elements.miniMapStatus.textContent = label;
  elements.miniMapCaption.textContent = caption;
  if (imageUrl) {
    elements.miniMapImage.src = imageUrl;
  } else {
    elements.miniMapImage.removeAttribute("src");
  }
}

function projectMiniMapPoint(map, latitudeDeg, longitudeDeg, width, height) {
  const innerWidth = Math.max(map.width - (map.padding * 2), 1);
  const innerHeight = Math.max(map.height - (map.padding * 2), 1);
  const projectedX = map.padding + (
    ((lonToMercatorX(longitudeDeg) - map.minMercatorX) / (map.maxMercatorX - map.minMercatorX))
    * innerWidth
  );
  const projectedY = map.padding + (
    ((latToMercatorY(latitudeDeg) - map.minMercatorY) / (map.maxMercatorY - map.minMercatorY))
    * innerHeight
  );

  return {
    x: (projectedX / map.width) * width,
    y: (projectedY / map.height) * height,
  };
}

function drawMiniMap(point) {
  const map = state.event?.map;
  const canvas = elements.miniMapCanvas;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  if (!map || !point || !Number.isFinite(point.latitudeDeg) || !Number.isFinite(point.longitudeDeg)) {
    return;
  }

  const { x, y } = projectMiniMapPoint(map, point.latitudeDeg, point.longitudeDeg, rect.width, rect.height);
  const angle = (Number.isFinite(point.headingDeg) ? point.headingDeg : 0) * (Math.PI / 180);

  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.fillStyle = "rgba(0, 0, 0, 0.35)";
  context.beginPath();
  context.arc(0, 0, 17, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#58d1b2";
  context.beginPath();
  context.arc(0, 0, 10, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#24d1ff";
  context.beginPath();
  context.moveTo(0, -28);
  context.lineTo(14, 14);
  context.lineTo(0, 6);
  context.lineTo(-14, 14);
  context.closePath();
  context.fill();
  context.strokeStyle = "rgba(0, 16, 24, 0.85)";
  context.lineWidth = 3;
  context.stroke();
  context.restore();
}

function updateHud(point) {
  if (!point) {
    elements.telemetryStatus.textContent = "No telemetry";
    elements.speedValue.textContent = "--";
    elements.autopilotValue.textContent = "--";
    elements.gearValue.textContent = "--";
    elements.steeringValue.textContent = "--";
    elements.brakeValue.textContent = "--";
    elements.blinkersValue.innerHTML = '<span class="blinker-off">Off</span>';
    elements.latitudeValue.textContent = "--";
    elements.longitudeValue.textContent = "--";
    elements.headingValue.textContent = "--";
    drawMiniMap(null);
    drawTelemetryTimelineOverlay(null);
    return;
  }

  elements.telemetryStatus.textContent = "SEI live";
  elements.speedValue.textContent = `${Math.round(point.speedMph)} mph`;
  elements.autopilotValue.textContent = point.autopilotLabel;
  elements.gearValue.textContent = point.gearLabel;
  elements.steeringValue.textContent = `${Math.round(point.steeringWheelAngle || 0)} deg`;
  elements.brakeValue.textContent = point.brakeApplied ? "Applied" : "Off";
  elements.blinkersValue.innerHTML = buildBlinkerMarkup(point);
  elements.latitudeValue.textContent = point.latitudeDeg?.toFixed(6) ?? "--";
  elements.longitudeValue.textContent = point.longitudeDeg?.toFixed(6) ?? "--";
  elements.headingValue.textContent = `${Math.round(point.headingDeg || 0)} deg`;
  drawMiniMap(point);
  drawTelemetryTimelineOverlay(point);
}

function syncFollowers(masterTime) {
  for (const cameraName of cameraOrder) {
    if (cameraName === "front") {
      continue;
    }
    const video = videos[cameraName];
    if (!video?.src || video.readyState < 1) {
      continue;
    }
    if (Math.abs(video.currentTime - masterTime) > 0.2) {
      video.currentTime = masterTime;
    }
    if (state.isPlaying && video.paused) {
      video.play().catch(() => {});
    }
    if (!state.isPlaying && !video.paused) {
      video.pause();
    }
  }
}

function updateSelectionUi() {
  const duration = eventDuration();
  const selection = exportRange();
  elements.clearSelectionButton.disabled = !selection.selected;
  elements.selectionTrack.classList.toggle("is-disabled", !duration);

  if (!selection.selected || !duration) {
    elements.selectionWindow.classList.add("is-hidden");
    elements.selectionLabel.textContent = "Exporting the full event";
    elements.exportButton.textContent = "Encode Master View";
    return;
  }

  const startPct = (selection.startSeconds / duration) * 100;
  const endPct = (selection.endSeconds / duration) * 100;
  elements.selectionWindow.classList.remove("is-hidden");
  elements.selectionWindow.style.left = `${startPct}%`;
  elements.selectionWindow.style.width = `${Math.max(endPct - startPct, 0.5)}%`;
  elements.selectionLabel.textContent = `Selected ${formatDuration(selection.startSeconds)} to ${formatDuration(selection.endSeconds)} (${formatDuration(selection.endSeconds - selection.startSeconds)})`;
  elements.exportButton.textContent = "Export Selected Range";
}

function updateTransport() {
  const duration = eventDuration();
  elements.timelineRange.max = String(duration);
  elements.timelineRange.value = String(state.globalTime);
  elements.timelinePosition.textContent = `${formatDuration(state.globalTime)} / ${formatDuration(duration)}`;
  if (state.event) {
    const segment = state.event.segments[state.activeSegmentIndex];
    elements.segmentLabel.textContent = segment ? `${segment.key} · clip ${state.activeSegmentIndex + 1} of ${state.event.segments.length}` : "No clip loaded";
  } else {
    elements.segmentLabel.textContent = "No clip loaded";
  }
  updateSelectionUi();
}

function highlightActiveSegment() {
  for (const node of elements.segmentList.querySelectorAll("[data-segment-index]")) {
    node.classList.toggle("is-active", Number(node.dataset.segmentIndex) === state.activeSegmentIndex);
  }
}

async function loadSegment(index, localTime = 0, autoplay = false) {
  if (!state.event) {
    return;
  }

  const segment = state.event.segments[index];
  if (!segment) {
    return;
  }

  state.activeSegmentIndex = index;
  state.pendingSeekTime = localTime;
  const byCamera = Object.fromEntries(segment.cameras.map((camera) => [camera.cameraName, camera]));

  for (const cameraName of cameraOrder) {
    const clip = byCamera[cameraName];
    const video = videos[cameraName];
    if (!video) {
      continue;
    }
    if (!clip) {
      video.removeAttribute("src");
      video.load();
      continue;
    }
    if (video.dataset.clipId !== clip.clipId) {
      video.src = clip.url;
      video.dataset.clipId = clip.clipId;
      video.load();
    }
  }

  const frontVideo = videos.front;
  const onReady = () => {
    for (const cameraName of cameraOrder) {
      const video = videos[cameraName];
      if (video?.readyState >= 1) {
        try {
          video.currentTime = localTime;
        } catch {}
      }
    }
    if (autoplay) {
      state.isPlaying = true;
      for (const cameraName of cameraOrder) {
        videos[cameraName]?.play().catch(() => {});
      }
    }
    highlightActiveSegment();
    updateTransport();
    frontVideo.removeEventListener("loadedmetadata", onReady);
  };

  if (frontVideo.readyState >= 1) {
    onReady();
  } else {
    frontVideo.addEventListener("loadedmetadata", onReady);
  }
}

async function seekGlobalTime(timeSeconds, autoplay = state.isPlaying) {
  if (!state.event) {
    return;
  }
  const clamped = clampTime(timeSeconds);
  const segmentIndex = findSegmentIndexAtTime(clamped);
  const segment = state.event.segments[segmentIndex];
  const localTime = Math.max(0, clamped - segment.offsetSeconds);
  state.globalTime = clamped;
  await loadSegment(segmentIndex, localTime, autoplay);
  updateHud(getMetadataAtTime(clamped));
  updateTransport();
}

function renderEvents() {
  elements.eventList.innerHTML = "";
  for (const event of state.events) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "event-card";
    button.dataset.eventId = event.id;
    button.innerHTML = `
      ${event.thumbUrl ? `<img src="${event.thumbUrl}" alt="" />` : "<div class='thumb-placeholder'>No thumb</div>"}
      <div class="event-card-copy">
        <strong>${event.street || event.id}</strong>
        <span>${formatDate({ timestamp: event.timestamp }, event.id)}</span>
        <span>${event.city || "Unknown city"} · ${event.segmentCount} clips</span>
      </div>
    `;
    button.addEventListener("click", () => selectEvent(event.id));
    button.classList.toggle("is-active", event.id === state.selectedEventId);
    elements.eventList.append(button);
  }
}

function renderSegments() {
  elements.segmentList.innerHTML = "";
  const count = state.event?.segments.length ?? 0;
  elements.segmentCountLabel.textContent = `${count} clips`;
  if (!state.event) {
    return;
  }
  for (const [index, segment] of state.event.segments.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segment-item";
    button.dataset.segmentIndex = String(index);
    button.innerHTML = `
      <strong>${segment.key}</strong>
      <span>${formatDuration(segment.offsetSeconds)} · ${formatDuration(segment.durationSeconds)}</span>
    `;
    button.addEventListener("click", () => seekGlobalTime(segment.offsetSeconds, false));
    elements.segmentList.append(button);
  }
  highlightActiveSegment();
}

async function pollExportStatus() {
  if (!state.selectedEventId) {
    return;
  }

  const range = activeExportRange();
  const params = new URLSearchParams();
  params.set("start", range.startSeconds.toFixed(3));
  params.set("end", range.endSeconds.toFixed(3));
  const response = await fetch(`/api/events/${encodeURIComponent(state.selectedEventId)}/export?${params.toString()}`);
  const payload = await response.json();
  if (payload.status === "done" && payload.outputUrl) {
    setExportBanner({
      status: "done",
      label: "Export ready",
      detailHtml: `<a href="${payload.outputUrl}" target="_blank" rel="noreferrer">Open the encoded video</a>`,
      progress: 1,
    });
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.exportRequest = null;
    elements.exportButton.disabled = false;
    return;
  }
  if (payload.status === "failed") {
    setExportBanner({
      status: "failed",
      label: "Export failed",
      detail: payload.error || "The encoder stopped unexpectedly.",
      progress: payload.progress ?? 0,
    });
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.exportRequest = null;
    elements.exportButton.disabled = false;
    return;
  }
  setExportBanner({
    status: "running",
    label: payload.label || (range.selected ? "Exporting selected range" : "Exporting full event"),
    detail: payload.detail || (range.selected
      ? `Encoding ${formatDuration(range.startSeconds)} to ${formatDuration(range.endSeconds)}...`
      : "Encoding the full event..."),
    progress: payload.progress ?? 0,
  });
}

async function startExport() {
  if (!state.selectedEventId) {
    return;
  }

  const selection = exportRange();
  setExportBanner({
    status: "running",
    label: selection.selected ? "Starting selected export" : "Starting full export",
    detail: selection.selected
      ? `Preparing ${formatDuration(selection.startSeconds)} to ${formatDuration(selection.endSeconds)}...`
      : "Preparing the full event...",
    progress: 0,
  });

  const response = await fetch(`/api/events/${encodeURIComponent(state.selectedEventId)}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startSeconds: selection.startSeconds,
      endSeconds: selection.endSeconds,
    }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok && response.status !== 409) {
    throw new Error(payload.error || "Unable to start export.");
  }

  state.exportRequest = { ...selection };
  elements.exportButton.disabled = true;

  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
  }
  state.pollTimer = window.setInterval(pollExportStatus, 1000);
  pollExportStatus().catch(() => {});
}

function loadMiniMapForEvent(event) {
  if (!event?.map) {
    setMiniMapState("No track", "This event did not contain valid GPS coordinates for a mini-map.");
    drawMiniMap(null);
    return;
  }
  const caption = event.map.hasBaseMap
    ? `Basemap ${event.map.attribution}. The route comes from the embedded GPS timeline and the marker follows live heading.`
    : "No Mapbox token is configured, so this mini-map is a locally rendered route trace built from the embedded GPS and heading data.";
  setMiniMapState(event.map.hasBaseMap ? "Mapbox" : "Route trace", caption, event.map.imageUrl);
}

async function selectEvent(eventId) {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  state.selectedEventId = eventId;
  elements.eventTitle.textContent = "Loading event...";
  elements.eventSubtitle.textContent = "Parsing front-camera telemetry and building the synchronized clip manifest.";

  const response = await fetch(`/api/events/${encodeURIComponent(eventId)}`);
  const payload = await response.json();
  state.event = payload.event;
  state.activeSegmentIndex = 0;
  state.globalTime = 0;
  state.isPlaying = false;
  state.exportRequest = null;
  state.selection = null;
  clearPlaybackFlash();
  renderPlaybackOverlay();
  setExportBanner({
    status: "idle",
    label: "No export running",
    detail: "Select a range and export only the portion you need.",
    progress: 0,
  });

  elements.eventTitle.textContent = payload.event.info?.street || eventId;
  elements.eventSubtitle.textContent = [
    formatDate(payload.event.info, eventId),
    payload.event.info?.city || "Unknown city",
    payload.event.info?.reason || "No trigger reason",
  ].filter(Boolean).join(" · ");

  elements.exportButton.disabled = false;
  elements.timelineRange.disabled = false;
  setVideoToggleDisabled(false);
  loadMiniMapForEvent(payload.event);
  renderEvents();
  redrawTelemetryTimelines();
  updateHud(getMetadataAtTime(0));
  renderSegments();
  updateTransport();
  await loadSegment(0, 0, false);
}

function selectionPositionToTime(clientX) {
  const rect = elements.selectionTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return ratio * eventDuration();
}

function commitSelection(start, end) {
  const duration = eventDuration();
  if (!duration) {
    state.selection = null;
    updateSelectionUi();
    return;
  }
  const left = clampTime(Math.min(start, end));
  const right = clampTime(Math.max(start, end));
  if (right - left < 0.5) {
    state.selection = null;
  } else {
    state.selection = { start: left, end: right };
  }
  updateSelectionUi();
}

function attachSelectionEvents() {
  const beginDrag = (mode, event) => {
    if (!state.event || elements.selectionTrack.classList.contains("is-disabled")) {
      return;
    }
    event.preventDefault();
    const currentSelection = exportRange();
    state.dragSelection = {
      mode,
      anchor: selectionPositionToTime(event.clientX),
      start: currentSelection.startSeconds,
      end: currentSelection.endSeconds,
      selected: currentSelection.selected,
    };

    const onMove = (moveEvent) => {
      const current = selectionPositionToTime(moveEvent.clientX);
      if (state.dragSelection.mode === "new") {
        commitSelection(state.dragSelection.anchor, current);
        return;
      }
      if (state.dragSelection.mode === "start") {
        commitSelection(current, state.dragSelection.end);
        return;
      }
      if (state.dragSelection.mode === "end") {
        commitSelection(state.dragSelection.start, current);
        return;
      }
      if (state.dragSelection.mode === "move" && state.selection) {
        const width = state.dragSelection.end - state.dragSelection.start;
        const delta = current - state.dragSelection.anchor;
        let nextStart = state.dragSelection.start + delta;
        let nextEnd = state.dragSelection.end + delta;
        if (nextStart < 0) {
          nextEnd -= nextStart;
          nextStart = 0;
        }
        if (nextEnd > eventDuration()) {
          const overflow = nextEnd - eventDuration();
          nextStart -= overflow;
          nextEnd = eventDuration();
        }
        state.selection = { start: nextStart, end: nextEnd };
        updateSelectionUi();
      }
    };

    const onUp = () => {
      state.dragSelection = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  elements.selectionTrack.addEventListener("pointerdown", (event) => {
    if (elements.selectionTrack.classList.contains("is-disabled")) {
      return;
    }
    beginDrag("new", event);
  });

  elements.selectionStartHandle.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    beginDrag("start", event);
  });
  elements.selectionEndHandle.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    beginDrag("end", event);
  });
  elements.selectionWindow.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (event.target === elements.selectionStartHandle || event.target === elements.selectionEndHandle) {
      return;
    }
    beginDrag("move", event);
  });
}

function attachVideoEvents() {
  const frontVideo = videos.front;
  frontVideo.addEventListener("timeupdate", () => {
    if (!state.event) {
      return;
    }
    const segment = state.event.segments[state.activeSegmentIndex];
    state.globalTime = segment.offsetSeconds + frontVideo.currentTime;
    updateTransport();
    updateHud(getMetadataAtTime(state.globalTime));
    syncFollowers(frontVideo.currentTime);
  });

  frontVideo.addEventListener("ended", async () => {
    if (!state.event) {
      return;
    }
    const nextIndex = state.activeSegmentIndex + 1;
    if (nextIndex >= state.event.segments.length) {
      state.isPlaying = false;
      clearPlaybackFlash();
      renderPlaybackOverlay();
      return;
    }
    await loadSegment(nextIndex, 0, true);
  });
}

async function fetchEvents() {
  const response = await fetch("/api/events");
  const payload = await response.json();
  state.events = payload.events;
  renderEvents();
}

async function togglePlayback() {
  if (!state.event) {
    return;
  }
  if (state.isPlaying) {
    state.isPlaying = false;
    pauseAllVideos();
    clearPlaybackFlash();
    renderPlaybackOverlay();
    return;
  }
  state.isPlaying = true;
  await loadSegment(state.activeSegmentIndex, videos.front.currentTime || state.pendingSeekTime || 0, true);
  flashPlaybackOverlay("❚❚");
}

elements.timelineRange.addEventListener("input", (event) => {
  const value = Number(event.target.value);
  state.globalTime = value;
  updateHud(getMetadataAtTime(value));
  updateTransport();
});

elements.timelineRange.addEventListener("change", (event) => {
  seekGlobalTime(Number(event.target.value), state.isPlaying).catch(() => {});
});

elements.exportButton.addEventListener("click", () => {
  startExport().catch((error) => {
    setExportBanner({
      status: "failed",
      label: "Export failed",
      detail: error.message,
      progress: 0,
    });
    elements.exportButton.disabled = false;
  });
});

elements.clearSelectionButton.addEventListener("click", () => {
  state.selection = null;
  updateSelectionUi();
});

elements.refreshButton.addEventListener("click", () => {
  fetchEvents().catch(console.error);
});

elements.segmentsToggle.addEventListener("click", () => {
  setSegmentsCollapsed(!elements.segmentsPanel.classList.contains("is-collapsed"));
});

for (const button of videoToggleButtons) {
  button.addEventListener("click", () => {
    togglePlayback().catch(console.error);
  });
}

elements.miniMapImage.addEventListener("load", () => {
  drawMiniMap(getMetadataAtTime(state.globalTime));
});

window.addEventListener("resize", () => {
  drawMiniMap(getMetadataAtTime(state.globalTime));
  redrawTelemetryTimelines();
  updateSelectionUi();
});

attachSelectionEvents();
attachVideoEvents();
setSegmentsCollapsed(true);
setVideoToggleDisabled(true);
renderPlaybackOverlay();
setExportBanner({
  status: "idle",
  label: "No export running",
  detail: "Select a range and export only the portion you need.",
  progress: 0,
});
clearCanvas(elements.speedTimelineCanvas);
clearCanvas(elements.speedTimelineOverlay);
clearCanvas(elements.apTimelineCanvas);
clearCanvas(elements.apTimelineOverlay);
fetchEvents().catch(console.error);
