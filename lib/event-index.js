import fs from "node:fs/promises";
import path from "node:path";
import { extractTeslaClipData, getCameraOrder } from "./tesla-sei.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".png", ".json"]);
const cameraOrder = getCameraOrder();
const EVENT_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

function parseClipName(fileName) {
  const match = fileName.match(
    /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(front|back|left_pillar|right_pillar|left_repeater|right_repeater)\.mp4$/i,
  );

  if (!match) {
    return null;
  }

  return {
    segmentKey: match[1],
    camera: match[2].toLowerCase(),
  };
}

function sortSegmentKeys(a, b) {
  return a.localeCompare(b);
}

function toSafeId(input) {
  return Buffer.from(input).toString("base64url");
}

async function maybeReadJson(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export class EventRepository {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.eventSummaries = null;
    this.eventCache = new Map();
  }

  async listEvents() {
    if (this.eventSummaries) {
      return this.eventSummaries;
    }

    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const folders = entries
      .filter((entry) => entry.isDirectory() && EVENT_FOLDER_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort(sortSegmentKeys);

    const summaries = [];

    for (const folderName of folders) {
      const folderPath = path.join(this.rootDir, folderName);
      const files = await fs.readdir(folderPath, { withFileTypes: true });
      const eventJson = await maybeReadJson(path.join(folderPath, "event.json"));
      const clipFiles = files
        .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => entry.name);

      const segmentKeys = new Set();
      for (const fileName of clipFiles) {
        const parsed = parseClipName(fileName);
        if (parsed) {
          segmentKeys.add(parsed.segmentKey);
        }
      }

      summaries.push({
        id: folderName,
        folderName,
        timestamp: eventJson?.timestamp ?? null,
        city: eventJson?.city ?? null,
        street: eventJson?.street ?? null,
        reason: eventJson?.reason ?? null,
        segmentCount: segmentKeys.size,
        cameraCount: cameraOrder.length,
        thumbUrl: clipFiles.includes("thumb.png") ? `/thumb/${encodeURIComponent(folderName)}` : null,
      });
    }

    this.eventSummaries = summaries.reverse();
    return this.eventSummaries;
  }

  async getEvent(eventId) {
    if (this.eventCache.has(eventId)) {
      return this.eventCache.get(eventId);
    }

    const folderPath = path.join(this.rootDir, eventId);
    const files = await fs.readdir(folderPath, { withFileTypes: true });
    const eventJson = await maybeReadJson(path.join(folderPath, "event.json"));
    const segmentMap = new Map();

    for (const entry of files) {
      if (!entry.isFile()) {
        continue;
      }

      const parsed = parseClipName(entry.name);
      if (!parsed) {
        continue;
      }

      if (!segmentMap.has(parsed.segmentKey)) {
        segmentMap.set(parsed.segmentKey, {
          key: parsed.segmentKey,
          cameras: {},
        });
      }

      segmentMap.get(parsed.segmentKey).cameras[parsed.camera] = {
        fileName: entry.name,
        clipId: toSafeId(entry.name),
        url: `/media/${encodeURIComponent(eventId)}/${toSafeId(entry.name)}`,
        filePath: path.join(folderPath, entry.name),
      };
    }

    const segments = [...segmentMap.values()].sort((left, right) => sortSegmentKeys(left.key, right.key));
    let offsetSeconds = 0;
    const metadataTimeline = [];
    let telemetryCount = 0;

    for (const segment of segments) {
      const frontCamera = segment.cameras.front ?? Object.values(segment.cameras)[0];
      let clipSummary = {
        durationSeconds: 0,
        fps: 0,
        timeline: [],
      };

      if (frontCamera) {
        clipSummary = await extractTeslaClipData(frontCamera.filePath);
      }

      segment.durationSeconds = clipSummary.durationSeconds;
      segment.fps = clipSummary.fps;
      segment.offsetSeconds = offsetSeconds;

      for (const cameraName of cameraOrder) {
        if (!segment.cameras[cameraName]) {
          continue;
        }

        segment.cameras[cameraName] = {
          ...segment.cameras[cameraName],
          cameraName,
        };
      }

      for (const point of clipSummary.timeline) {
        metadataTimeline.push({
          ...point,
          timeSeconds: point.timeSeconds + offsetSeconds,
          segmentKey: segment.key,
        });
      }

      telemetryCount += clipSummary.timeline.length;
      offsetSeconds += clipSummary.durationSeconds;
    }

    const event = {
      id: eventId,
      folderPath,
      info: eventJson,
      totalDurationSeconds: offsetSeconds,
      telemetryCount,
      segments: segments.map((segment) => ({
        key: segment.key,
        offsetSeconds: segment.offsetSeconds,
        durationSeconds: segment.durationSeconds,
        fps: segment.fps,
        cameras: cameraOrder
          .filter((cameraName) => segment.cameras[cameraName])
          .map((cameraName) => segment.cameras[cameraName]),
      })),
      metadataTimeline,
      segmentKeys: segments.map((segment) => segment.key),
      cameras: cameraOrder,
      clipPathsByCamera: cameraOrder.reduce((map, cameraName) => {
        map[cameraName] = segments
          .map((segment) => {
            const camera = segment.cameras[cameraName];
            return camera ? camera.filePath : null;
          })
          .filter(Boolean);
        return map;
      }, {}),
    };

    this.eventCache.set(eventId, event);
    return event;
  }

  async resolveClipPath(eventId, clipId) {
    const event = await this.getEvent(eventId);

    for (const segment of event.segments) {
      for (const camera of segment.cameras) {
        if (camera.clipId === clipId) {
          return camera.filePath;
        }
      }
    }

    return null;
  }
}
