import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventRepository } from "./lib/event-index.js";
import { exportMasterView } from "./lib/export-master.js";
import {
  VIEWER_MAP_HEIGHT,
  VIEWER_MAP_PADDING,
  VIEWER_MAP_WIDTH,
  buildMapContext,
  renderMapImage,
} from "./lib/minimap.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3088;
const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const exportDir = path.join(rootDir, "exports");
const mapCacheDir = path.join(rootDir, ".map-cache");

const repository = new EventRepository(rootDir);
const exportJobs = new Map();

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(value / 60);
  const secs = value % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function parseExportRange(request, maxDuration) {
  const body = request.body ?? {};
  const rawStart = Number.isFinite(body.startSeconds) ? body.startSeconds : 0;
  const rawEnd = Number.isFinite(body.endSeconds) ? body.endSeconds : maxDuration;
  const startSeconds = Math.max(0, Math.min(rawStart, maxDuration));
  const endSeconds = Math.max(startSeconds + 0.05, Math.min(rawEnd, maxDuration));
  return { startSeconds, endSeconds };
}

function parseExportStatusRange(request, maxDuration) {
  const rawStart = Number.parseFloat(request.query.start ?? "0");
  const rawEnd = Number.parseFloat(request.query.end ?? `${maxDuration}`);
  const startSeconds = Number.isFinite(rawStart) ? Math.max(0, Math.min(rawStart, maxDuration)) : 0;
  const endSeconds = Number.isFinite(rawEnd)
    ? Math.max(startSeconds + 0.05, Math.min(rawEnd, maxDuration))
    : maxDuration;
  return { startSeconds, endSeconds };
}

function exportJobKey(eventId, startSeconds, endSeconds) {
  return `${eventId}:${startSeconds.toFixed(3)}:${endSeconds.toFixed(3)}`;
}

function buildViewerMapDescriptor(eventId, metadataTimeline) {
  const context = buildMapContext(metadataTimeline, {
    width: VIEWER_MAP_WIDTH,
    height: VIEWER_MAP_HEIGHT,
    padding: VIEWER_MAP_PADDING,
  });

  if (!context) {
    return null;
  }

  return {
    ...context,
    imageUrl: `/api/events/${encodeURIComponent(eventId)}/map.png?provider=${encodeURIComponent(context.provider)}&rev=2`,
  };
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

app.get("/api/events", async (_request, response, next) => {
  try {
    const events = await repository.listEvents();
    response.json({ events });
  } catch (error) {
    next(error);
  }
});

app.get("/api/events/:eventId", async (request, response, next) => {
  try {
    const event = await repository.getEvent(request.params.eventId);
    const map = buildViewerMapDescriptor(event.id, event.metadataTimeline);
    response.json({
      event: {
        id: event.id,
        info: event.info,
        totalDurationSeconds: event.totalDurationSeconds,
        telemetryCount: event.telemetryCount,
        map,
        cameras: event.cameras,
        segments: event.segments.map((segment) => ({
          ...segment,
          cameras: segment.cameras.map(({ filePath, ...camera }) => camera),
        })),
        metadataTimeline: event.metadataTimeline,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/events/:eventId/map.png", async (request, response, next) => {
  try {
    const event = await repository.getEvent(request.params.eventId);
    const context = buildViewerMapDescriptor(event.id, event.metadataTimeline);

    if (!context) {
      response.status(404).json({ error: "No GPS route available for this event." });
      return;
    }

    await fs.promises.mkdir(mapCacheDir, { recursive: true });
    const filePath = path.join(
      mapCacheDir,
      `${event.id}-${context.provider}-${context.width}x${context.height}.png`,
    );

    try {
      await fs.promises.access(filePath);
    } catch {
      await renderMapImage(context, filePath);
    }

    response.type("png");
    response.sendFile(filePath, { dotfiles: "allow" }, (error) => {
      if (error) {
        next(error);
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/events/:eventId/export", async (request, response, next) => {
  try {
    const eventId = request.params.eventId;
    const event = await repository.getEvent(eventId);
    const range = parseExportStatusRange(request, event.totalDurationSeconds);
    const job = exportJobs.get(exportJobKey(eventId, range.startSeconds, range.endSeconds));
    response.json({
      status: job?.status ?? "idle",
      label: job?.label ?? null,
      detail: job?.detail ?? null,
      progress: job?.progress ?? 0,
      outputUrl: job?.outputPath ? `/exports/${encodeURIComponent(path.basename(job.outputPath))}` : null,
      error: job?.error ?? null,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/events/:eventId/export", async (request, response, next) => {
  try {
    const eventId = request.params.eventId;
    const event = await repository.getEvent(eventId);
    const range = parseExportRange(request, event.totalDurationSeconds);
    const jobKey = exportJobKey(eventId, range.startSeconds, range.endSeconds);
    const existing = exportJobs.get(jobKey);

    if (existing?.status === "running") {
      response.status(409).json({ error: "Export already running for this event." });
      return;
    }

    exportJobs.set(jobKey, {
      status: "running",
      label: range.startSeconds > 0 || range.endSeconds < event.totalDurationSeconds
        ? "Exporting selected range"
        : "Exporting full event",
      detail: "Preparing overlays and map assets...",
      progress: 0,
      outputPath: null,
      error: null,
    });
    response.status(202).json({ status: "running" });

    try {
      const outputPath = await exportMasterView(event, exportDir, {
        ...range,
        onProgress: ({ progress, encodedSeconds, durationSeconds }) => {
          exportJobs.set(jobKey, {
            status: "running",
            label: range.startSeconds > 0 || range.endSeconds < event.totalDurationSeconds
              ? "Exporting selected range"
              : "Exporting full event",
            detail: `Encoded ${formatDuration(encodedSeconds)} of ${formatDuration(durationSeconds)}`,
            progress,
            outputPath: null,
            error: null,
          });
        },
      });
      exportJobs.set(jobKey, {
        status: "done",
        label: "Export ready",
        detail: "The encoded master view is ready to open.",
        progress: 1,
        outputPath,
        error: null,
      });
    } catch (error) {
      exportJobs.set(jobKey, {
        status: "failed",
        label: "Export failed",
        detail: "The encoder stopped before finishing.",
        progress: 0,
        outputPath: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } catch (error) {
    next(error);
  }
});

app.get("/thumb/:eventId", (request, response, next) => {
  const thumbPath = path.join(rootDir, request.params.eventId, "thumb.png");
  response.sendFile(thumbPath, (error) => {
    if (error) {
      next(error);
    }
  });
});

app.get("/exports/:fileName", (request, response, next) => {
  const filePath = path.join(exportDir, request.params.fileName);
  response.sendFile(filePath, (error) => {
    if (error) {
      next(error);
    }
  });
});

app.get("/media/:eventId/:clipId", async (request, response, next) => {
  try {
    const filePath = await repository.resolveClipPath(request.params.eventId, request.params.clipId);
    if (!filePath) {
      response.status(404).json({ error: "Clip not found." });
      return;
    }

    const stat = await fs.promises.stat(filePath);
    const range = request.headers.range;

    if (!range) {
      response.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(filePath).pipe(response);
      return;
    }

    const [startToken, endToken] = range.replace(/bytes=/, "").split("-");
    const start = Number(startToken);
    const end = endToken ? Number(endToken) : stat.size - 1;

    response.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": "video/mp4",
    });

    fs.createReadStream(filePath, { start, end }).pipe(response);
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  response.status(500).json({ error: message });
});

app.listen(port, () => {
  console.log(`Tesla dashcam viewer available at http://localhost:${port}`);
});
