import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  EXPORT_MAP_HEIGHT,
  EXPORT_MAP_PADDING,
  EXPORT_MAP_WIDTH,
  buildMapContext,
  projectMapPoint,
  renderMapImage,
} from "./minimap.js";

const EXPORT_MAP_X = 1880;
const EXPORT_MAP_Y = 1100;

function formatAssTimestamp(seconds) {
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const secs = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;

  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function escapeAssText(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\n/g, "\\N");
}

function buildMetadataLabel(point) {
  const speed = `${Math.round(point.speedMph)} mph`;
  const gear = point.gearLabel || "P";
  const autopilot = point.autopilotLabel || "None";
  const steering = `${Math.round(point.steeringWheelAngle || 0)} deg`;
  const brake = point.brakeApplied ? "Brake on" : "Brake off";
  return `Speed ${speed} | Gear ${gear} | AP ${autopilot} | Steering ${steering} | ${brake}`;
}

function buildMarkerArrow() {
  return "m 0 -28 l 15 16 l 0 7 l -15 16";
}

function buildMarkerDot() {
  return "m 0 -10 l 7 -7 l 10 0 l 7 7 l 0 10 l -7 7 l -10 0 l -7 -7";
}

function buildRangeTag(seconds) {
  return `${Math.round(seconds * 1000)}`.padStart(7, "0");
}

function clipDuration(segment) {
  return segment.offsetSeconds + segment.durationSeconds;
}

function buildTrimmedEvent(event, startSeconds = 0, endSeconds = event.totalDurationSeconds) {
  const start = Math.max(0, Math.min(startSeconds, event.totalDurationSeconds));
  const end = Math.max(start + 0.05, Math.min(endSeconds, event.totalDurationSeconds));
  const cameras = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"];
  const clipSourcesByCamera = Object.fromEntries(cameras.map((camera) => [camera, []]));

  for (const segment of event.segments) {
    const segmentStart = segment.offsetSeconds;
    const segmentEnd = clipDuration(segment);
    const overlapStart = Math.max(start, segmentStart);
    const overlapEnd = Math.min(end, segmentEnd);

    if (overlapEnd <= overlapStart) {
      continue;
    }

    const inpoint = overlapStart - segmentStart;
    const outpoint = overlapEnd - segmentStart;

    for (const cameraName of cameras) {
      const camera = segment.cameras.find((entry) => entry.cameraName === cameraName);
      if (!camera?.filePath) {
        continue;
      }

      clipSourcesByCamera[cameraName].push({
        filePath: camera.filePath,
        inpoint,
        outpoint,
      });
    }
  }

  return {
    ...event,
    exportStartSeconds: start,
    exportEndSeconds: end,
    totalDurationSeconds: end - start,
    metadataTimeline: event.metadataTimeline
      .filter((point) => point.timeSeconds >= start && point.timeSeconds <= end)
      .map((point) => ({ ...point, timeSeconds: point.timeSeconds - start })),
    clipSourcesByCamera,
  };
}

async function writeConcatList(filePath, clipSources) {
  const lines = [];
  for (const clipSource of clipSources) {
    lines.push(`file '${clipSource.filePath.replace(/'/g, "'\\''")}'`);
    if (Number.isFinite(clipSource.inpoint) && clipSource.inpoint > 0.001) {
      lines.push(`inpoint ${clipSource.inpoint.toFixed(3)}`);
    }
    if (Number.isFinite(clipSource.outpoint)) {
      lines.push(`outpoint ${clipSource.outpoint.toFixed(3)}`);
    }
  }
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

function buildMarkerDialogues(timeline, endTime, mapContext) {
  if (!mapContext) {
    return [];
  }

  const dialogues = [];
  const arrow = buildMarkerArrow();
  const dot = buildMarkerDot();

  for (let index = 0; index < timeline.length; index += 1) {
    const point = timeline[index];
    const next = timeline[index + 1];
    const start = point.timeSeconds;
    const finish = next ? next.timeSeconds : endTime;

    if (finish <= start || !Number.isFinite(point.latitudeDeg) || !Number.isFinite(point.longitudeDeg)) {
      continue;
    }

    const projected = projectMapPoint(mapContext, point.latitudeDeg, point.longitudeDeg);
    const x = EXPORT_MAP_X + projected.x;
    const y = EXPORT_MAP_Y + projected.y;
    const angle = Number.isFinite(point.headingDeg) ? point.headingDeg : 0;

    dialogues.push(
      `Dialogue: 3,${formatAssTimestamp(start)},${formatAssTimestamp(finish)},HUD,,0,0,0,,{\\an5\\pos(${x.toFixed(1)},${y.toFixed(1)})\\frz${angle.toFixed(1)}\\bord1\\shad0\\1c&H24D1FF&\\3c&H001018&\\p1}${arrow}`,
    );
    dialogues.push(
      `Dialogue: 2,${formatAssTimestamp(start)},${formatAssTimestamp(finish)},HUD,,0,0,0,,{\\an5\\pos(${x.toFixed(1)},${y.toFixed(1)})\\bord1\\shad0\\1c&H58D1B2&\\3c&H001018&\\p1}${dot}`,
    );
  }

  return dialogues;
}

async function writeAssFile(filePath, event, mapContext) {
  const timeline = event.metadataTimeline;
  const endTime = event.totalDurationSeconds;
  const dialogueLines = [];

  if (timeline.length === 0) {
    dialogueLines.push(
      `Dialogue: 0,${formatAssTimestamp(0)},${formatAssTimestamp(Math.max(endTime, 1))},HUD,,0,0,0,,${escapeAssText("No SEI metadata found in this event.")}`,
    );
  } else {
    for (let index = 0; index < timeline.length; index += 1) {
      const current = timeline[index];
      const next = timeline[index + 1];
      const start = current.timeSeconds;
      const finish = next ? next.timeSeconds : endTime;

      if (finish <= start) {
        continue;
      }

      dialogueLines.push(
        `Dialogue: 0,${formatAssTimestamp(start)},${formatAssTimestamp(finish)},HUD,,0,0,0,,${escapeAssText(buildMetadataLabel(current))}`,
      );
    }
  }

  if (mapContext) {
    dialogueLines.push(
      `Dialogue: 1,${formatAssTimestamp(0)},${formatAssTimestamp(Math.max(endTime, 1))},MAPATTR,,0,0,0,,{\\an7\\pos(${EXPORT_MAP_X + 14},${EXPORT_MAP_Y + 18})}Mini-map`,
    );
    dialogueLines.push(
      `Dialogue: 1,${formatAssTimestamp(0)},${formatAssTimestamp(Math.max(endTime, 1))},MAPATTR,,0,0,0,,{\\an1\\pos(${EXPORT_MAP_X + 12},${EXPORT_MAP_Y + mapContext.height - 10})}${escapeAssText(mapContext.attribution)}`,
    );
    dialogueLines.push(...buildMarkerDialogues(timeline, endTime, mapContext));
  }

  const content = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 2560",
    "PlayResY: 1440",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: HUD,Menlo,34,&H00F6F6F6,&H000000FF,&H00222222,&H64000000,1,0,0,0,100,100,0,0,1,2,0,1,40,40,40,1",
    "Style: MAPATTR,Menlo,16,&H00F6F6F6,&H000000FF,&H00162233,&H50000000,0,0,0,0,100,100,0,0,1,1,0,1,10,10,10,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ...dialogueLines,
    "",
  ].join("\n");

  await fs.writeFile(filePath, content, "utf8");
}

function parseFfmpegTimestamp(value) {
  const match = value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) {
    return 0;
  }

  const [, hours, minutes, seconds] = match;
  return (Number(hours) * 3600) + (Number(minutes) * 60) + Number(seconds);
}

function runFfmpeg(args, cwd, options = {}) {
  const durationSeconds = options.durationSeconds ?? 0;
  const onProgress = options.onProgress ?? null;

  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { cwd });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;

      if (onProgress && durationSeconds > 0) {
        const matches = [...text.matchAll(/time=(\d+:\d+:\d+(?:\.\d+)?)/g)];
        if (matches.length) {
          const encodedSeconds = parseFfmpegTimestamp(matches[matches.length - 1][1]);
          onProgress({
            encodedSeconds,
            durationSeconds,
            progress: Math.min(Math.max(encodedSeconds / durationSeconds, 0), 0.995),
          });
        }
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        if (onProgress && durationSeconds > 0) {
          onProgress({
            encodedSeconds: durationSeconds,
            durationSeconds,
            progress: 1,
          });
        }
        resolve();
        return;
      }

      reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
}

export async function exportMasterView(event, outputDir, options = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const trimmedEvent = buildTrimmedEvent(
    event,
    options.startSeconds ?? 0,
    options.endSeconds ?? event.totalDurationSeconds,
  );
  const isFullExport = (
    Math.abs(trimmedEvent.exportStartSeconds) < 0.001
    && Math.abs(trimmedEvent.exportEndSeconds - event.totalDurationSeconds) < 0.001
  );
  const nameStem = isFullExport
    ? event.id
    : `${event.id}-${buildRangeTag(trimmedEvent.exportStartSeconds)}-${buildRangeTag(trimmedEvent.exportEndSeconds)}`;

  const workDir = path.join(outputDir, `${nameStem}-work`);
  await fs.mkdir(workDir, { recursive: true });

  const cameras = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"];
  const concatFiles = {};

  for (const camera of cameras) {
    const clipSources = trimmedEvent.clipSourcesByCamera[camera] ?? [];
    if (!clipSources.length) {
      throw new Error(`Cannot export: missing clips for ${camera}.`);
    }

    const listPath = path.join(workDir, `${camera}.txt`);
    await writeConcatList(listPath, clipSources);
    concatFiles[camera] = listPath;
  }

  const mapContext = buildMapContext(trimmedEvent.metadataTimeline, {
    width: EXPORT_MAP_WIDTH,
    height: EXPORT_MAP_HEIGHT,
    padding: EXPORT_MAP_PADDING,
  });
  const mapPath = mapContext ? path.join(workDir, "mini-map.png") : null;
  if (mapContext && mapPath) {
    await renderMapImage(mapContext, mapPath);
  }

  const assPath = path.join(workDir, "metadata.ass");
  await writeAssFile(assPath, trimmedEvent, mapContext);

  const outputPath = path.join(outputDir, `${nameStem}-master.mp4`);
  const args = [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFiles.front,
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFiles.back,
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFiles.left_pillar,
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFiles.right_pillar,
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFiles.left_repeater,
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFiles.right_repeater,
  ];

  if (mapPath) {
    args.push("-loop", "1", "-i", mapPath);
  }

  const filterComplex = [
    "[0:v]scale=784:508:force_original_aspect_ratio=decrease,pad=784:508:(ow-iw)/2:(oh-ih)/2:black,setsar=1[front]",
    "[1:v]scale=784:508:force_original_aspect_ratio=decrease,pad=784:508:(ow-iw)/2:(oh-ih)/2:black,setsar=1[back]",
    "[2:v]scale=784:508:force_original_aspect_ratio=decrease,pad=784:508:(ow-iw)/2:(oh-ih)/2:black,setsar=1[leftpillar]",
    "[3:v]scale=784:508:force_original_aspect_ratio=decrease,pad=784:508:(ow-iw)/2:(oh-ih)/2:black,setsar=1[rightpillar]",
    "[4:v]scale=784:508:force_original_aspect_ratio=decrease,pad=784:508:(ow-iw)/2:(oh-ih)/2:black,setsar=1[leftrep]",
    "[5:v]scale=784:508:force_original_aspect_ratio=decrease,pad=784:508:(ow-iw)/2:(oh-ih)/2:black,setsar=1[rightrep]",
    "color=c=#101522:s=2560x1440:r=36[base]",
    "[base][leftpillar]overlay=40:40:shortest=1[tmp1]",
    "[tmp1][front]overlay=888:40:shortest=1[tmp2]",
    "[tmp2][rightpillar]overlay=1736:40:shortest=1[tmp3]",
    "[tmp3][leftrep]overlay=40:572:shortest=1[tmp4]",
    "[tmp4][back]overlay=888:572:shortest=1[tmp5]",
    "[tmp5][rightrep]overlay=1736:572:shortest=1[tmp6]",
  ];

  if (mapPath) {
    filterComplex.push("[tmp6][6:v]overlay=1880:1100:shortest=1[tmp7]");
    filterComplex.push(`[tmp7]subtitles='${assPath.replace(/'/g, "'\\''")}':force_style='Alignment=1,MarginV=30'[vout]`);
  } else {
    filterComplex.push(`[tmp6]subtitles='${assPath.replace(/'/g, "'\\''")}':force_style='Alignment=1,MarginV=30'[vout]`);
  }

  args.push(
    "-filter_complex",
    filterComplex.join(";"),
    "-map",
    "[vout]",
    "-c:v",
    "h264_videotoolbox",
    "-b:v",
    "18M",
    "-maxrate",
    "24M",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  );

  await runFfmpeg(args, workDir, {
    durationSeconds: trimmedEvent.totalDurationSeconds,
    onProgress: options.onProgress,
  });

  return outputPath;
}
