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
  playPauseButton: document.querySelector("#playPauseButton"),
  exportButton: document.querySelector("#exportButton"),
  refreshButton: document.querySelector("#refreshButton"),
  timelineRange: document.querySelector("#timelineRange"),
  timelinePosition: document.querySelector("#timelinePosition"),
  segmentLabel: document.querySelector("#segmentLabel"),
  selectionTrack: document.querySelector("#selectionTrack"),
  selectionWindow: document.querySelector("#selectionWindow"),
  selectionStartHandle: document.querySelector("#selectionStartHandle"),
  selectionEndHandle: document.querySelector("#selectionEndHandle"),
  selectionLabel: document.querySelector("#selectionLabel"),
  clearSelectionButton: document.querySelector("#clearSelectionButton"),
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
  segmentList: document.querySelector("#segmentList"),
  segmentCountLabel: document.querySelector("#segmentCountLabel"),
  exportStatus: document.querySelector("#exportStatus"),
};

const videos = Object.fromEntries(
  cameraOrder.map((cameraName) => [cameraName, document.querySelector(`#video-${cameraName}`)]),
);

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
  context.arc(0, 0, 11, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#58d1b2";
  context.beginPath();
  context.arc(0, 0, 7, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#24d1ff";
  context.beginPath();
  context.moveTo(0, -18);
  context.lineTo(10, 10);
  context.lineTo(0, 4);
  context.lineTo(-10, 10);
  context.closePath();
  context.fill();
  context.strokeStyle = "rgba(0, 16, 24, 0.85)";
  context.lineWidth = 2;
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
    elements.blinkersValue.textContent = "--";
    elements.latitudeValue.textContent = "--";
    elements.longitudeValue.textContent = "--";
    elements.headingValue.textContent = "--";
    drawMiniMap(null);
    return;
  }

  elements.telemetryStatus.textContent = "SEI live";
  elements.speedValue.textContent = `${Math.round(point.speedMph)} mph`;
  elements.autopilotValue.textContent = point.autopilotLabel;
  elements.gearValue.textContent = point.gearLabel;
  elements.steeringValue.textContent = `${Math.round(point.steeringWheelAngle || 0)} deg`;
  elements.brakeValue.textContent = point.brakeApplied ? "Applied" : "Off";
  elements.blinkersValue.textContent = [point.blinkerOnLeft ? "Left" : null, point.blinkerOnRight ? "Right" : null].filter(Boolean).join(" / ") || "Off";
  elements.latitudeValue.textContent = point.latitudeDeg?.toFixed(6) ?? "--";
  elements.longitudeValue.textContent = point.longitudeDeg?.toFixed(6) ?? "--";
  elements.headingValue.textContent = `${Math.round(point.headingDeg || 0)} deg`;
  drawMiniMap(point);
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
      <span>${formatDuration(segment.offsetSeconds)} · ${segment.cameras.length} views · ${formatDuration(segment.durationSeconds)}</span>
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
    elements.exportStatus.innerHTML = `Export ready: <a href="${payload.outputUrl}" target="_blank" rel="noreferrer">open video</a>`;
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.exportRequest = null;
    elements.exportButton.disabled = false;
    return;
  }
  if (payload.status === "failed") {
    elements.exportStatus.textContent = `Export failed: ${payload.error}`;
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.exportRequest = null;
    elements.exportButton.disabled = false;
    return;
  }
  elements.exportStatus.textContent = range.selected
    ? `Encoding ${formatDuration(range.startSeconds)} to ${formatDuration(range.endSeconds)}...`
    : "Encoding the full event...";
}

async function startExport() {
  if (!state.selectedEventId) {
    return;
  }

  const selection = exportRange();
  elements.exportStatus.textContent = selection.selected
    ? `Starting export for ${formatDuration(selection.startSeconds)} to ${formatDuration(selection.endSeconds)}...`
    : "Starting full-event export...";

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
  state.pollTimer = window.setInterval(pollExportStatus, 3000);
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
  elements.playPauseButton.textContent = "Play";
  elements.exportStatus.textContent = "No export started.";

  elements.eventTitle.textContent = payload.event.info?.street || eventId;
  elements.eventSubtitle.textContent = [
    formatDate(payload.event.info, eventId),
    payload.event.info?.city || "Unknown city",
    payload.event.info?.reason || "No trigger reason",
  ].filter(Boolean).join(" · ");

  elements.playPauseButton.disabled = false;
  elements.exportButton.disabled = false;
  elements.timelineRange.disabled = false;
  loadMiniMapForEvent(payload.event);
  renderEvents();
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
      elements.playPauseButton.textContent = "Play";
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

elements.playPauseButton.addEventListener("click", async () => {
  if (!state.event) {
    return;
  }
  if (state.isPlaying) {
    state.isPlaying = false;
    for (const video of Object.values(videos)) {
      video?.pause();
    }
    elements.playPauseButton.textContent = "Play";
    return;
  }
  state.isPlaying = true;
  await loadSegment(state.activeSegmentIndex, videos.front.currentTime || state.pendingSeekTime || 0, true);
  elements.playPauseButton.textContent = "Pause";
});

elements.timelineRange.addEventListener("input", (event) => {
  const value = Number(event.target.value);
  state.globalTime = value;
  updateHud(getMetadataAtTime(value));
  updateTransport();
});

elements.timelineRange.addEventListener("change", (event) => {
  seekGlobalTime(Number(event.target.value), false).catch(() => {});
});

elements.exportButton.addEventListener("click", () => {
  startExport().catch((error) => {
    elements.exportStatus.textContent = `Export failed: ${error.message}`;
  });
});

elements.clearSelectionButton.addEventListener("click", () => {
  state.selection = null;
  updateSelectionUi();
});

elements.refreshButton.addEventListener("click", () => {
  fetchEvents().catch(console.error);
});

elements.miniMapImage.addEventListener("load", () => {
  drawMiniMap(getMetadataAtTime(state.globalTime));
});

window.addEventListener("resize", () => {
  drawMiniMap(getMetadataAtTime(state.globalTime));
  updateSelectionUi();
});

attachSelectionEvents();
attachVideoEvents();
fetchEvents().catch(console.error);
