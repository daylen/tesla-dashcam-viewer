import fs from "node:fs/promises";
import { PNG } from "pngjs";

export const VIEWER_MAP_WIDTH = 560;
export const VIEWER_MAP_HEIGHT = 300;
export const VIEWER_MAP_PADDING = 24;
export const EXPORT_MAP_WIDTH = 640;
export const EXPORT_MAP_HEIGHT = 300;
export const EXPORT_MAP_PADDING = 18;

const MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN ?? "";
const MAPBOX_STYLE_USER = process.env.MAPBOX_STYLE_USER ?? "mapbox";
const MAPBOX_STYLE_ID = process.env.MAPBOX_STYLE_ID ?? "light-v11";

function clampLatitude(latitude) {
  return Math.max(-85, Math.min(85, latitude));
}

function lonToMercatorX(longitude) {
  return (longitude + 180) / 360;
}

function latToMercatorY(latitude) {
  const radians = clampLatitude(latitude) * (Math.PI / 180);
  return (1 - Math.log(Math.tan(radians) + (1 / Math.cos(radians))) / Math.PI) / 2;
}

function mercatorXToLon(x) {
  return (x * 360) - 180;
}

function mercatorYToLat(y) {
  const n = Math.PI * (1 - (2 * y));
  return Math.atan(Math.sinh(n)) * (180 / Math.PI);
}

function getTrackPoints(metadataTimeline) {
  return metadataTimeline
    .filter((point) => (
      Number.isFinite(point.latitudeDeg)
      && Number.isFinite(point.longitudeDeg)
      && !(point.latitudeDeg === 0 && point.longitudeDeg === 0)
    ))
    .map((point) => ({
      latitudeDeg: point.latitudeDeg,
      longitudeDeg: point.longitudeDeg,
      headingDeg: point.headingDeg ?? 0,
      timeSeconds: point.timeSeconds,
    }));
}

function samplePoints(points, maxPoints = 240) {
  if (points.length <= maxPoints) {
    return points;
  }

  const sampled = [];
  const step = (points.length - 1) / (maxPoints - 1);

  for (let index = 0; index < maxPoints; index += 1) {
    sampled.push(points[Math.round(index * step)]);
  }

  return sampled;
}

function buildMercatorBounds(trackPoints, width, height, padding) {
  const mercatorPoints = trackPoints.map((point) => ({
    x: lonToMercatorX(point.longitudeDeg),
    y: latToMercatorY(point.latitudeDeg),
  }));

  let minX = Math.min(...mercatorPoints.map((point) => point.x));
  let maxX = Math.max(...mercatorPoints.map((point) => point.x));
  let minY = Math.min(...mercatorPoints.map((point) => point.y));
  let maxY = Math.max(...mercatorPoints.map((point) => point.y));

  let rangeX = Math.max(maxX - minX, 1e-6);
  let rangeY = Math.max(maxY - minY, 1e-6);

  minX -= rangeX * 0.08;
  maxX += rangeX * 0.08;
  minY -= rangeY * 0.08;
  maxY += rangeY * 0.08;

  rangeX = maxX - minX;
  rangeY = maxY - minY;

  const innerWidth = Math.max(width - (padding * 2), 1);
  const innerHeight = Math.max(height - (padding * 2), 1);
  const targetAspect = innerWidth / innerHeight;
  const currentAspect = rangeX / rangeY;

  if (currentAspect < targetAspect) {
    const expandedRangeX = rangeY * targetAspect;
    const centerX = (minX + maxX) / 2;
    minX = centerX - (expandedRangeX / 2);
    maxX = centerX + (expandedRangeX / 2);
  } else {
    const expandedRangeY = rangeX / targetAspect;
    const centerY = (minY + maxY) / 2;
    minY = centerY - (expandedRangeY / 2);
    maxY = centerY + (expandedRangeY / 2);
  }

  return { minX, maxX, minY, maxY };
}

function buildMapboxStaticUrl(context) {
  if (!MAPBOX_TOKEN) {
    return null;
  }

  const bbox = [
    mercatorXToLon(context.minMercatorX).toFixed(6),
    mercatorYToLat(context.maxMercatorY).toFixed(6),
    mercatorXToLon(context.maxMercatorX).toFixed(6),
    mercatorYToLat(context.minMercatorY).toFixed(6),
  ].join(",");

  const params = new URLSearchParams({
    padding: String(context.padding),
    attribution: "false",
    logo: "false",
    access_token: MAPBOX_TOKEN,
  });

  return `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE_USER}/${MAPBOX_STYLE_ID}/static/[${bbox}]/${context.width}x${context.height}?${params.toString()}`;
}

function createBlankMap(width, height) {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = ((width * y) + x) << 2;
      const band = ((x + y) % 48) < 2;
      png.data[index] = band ? 14 : 10;
      png.data[index + 1] = band ? 27 : 20;
      png.data[index + 2] = band ? 42 : 31;
      png.data[index + 3] = 255;
    }
  }

  return png;
}

function blendPixel(png, x, y, color) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
    return;
  }

  const index = ((png.width * y) + x) << 2;
  const alpha = (color.a ?? 255) / 255;
  const inverseAlpha = 1 - alpha;

  png.data[index] = Math.round((color.r * alpha) + (png.data[index] * inverseAlpha));
  png.data[index + 1] = Math.round((color.g * alpha) + (png.data[index + 1] * inverseAlpha));
  png.data[index + 2] = Math.round((color.b * alpha) + (png.data[index + 2] * inverseAlpha));
  png.data[index + 3] = 255;
}

function drawCircle(png, centerX, centerY, radius, color) {
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      if ((offsetX ** 2) + (offsetY ** 2) <= radius ** 2) {
        blendPixel(png, centerX + offsetX, centerY + offsetY, color);
      }
    }
  }
}

function drawLine(png, startX, startY, endX, endY, color, thickness = 4) {
  const steps = Math.max(Math.abs(endX - startX), Math.abs(endY - startY), 1);

  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    const x = Math.round(startX + ((endX - startX) * progress));
    const y = Math.round(startY + ((endY - startY) * progress));
    drawCircle(png, x, y, Math.max(1, Math.floor(thickness / 2)), color);
  }
}

async function loadBaseMapPng(context) {
  const mapboxUrl = buildMapboxStaticUrl(context);
  if (!mapboxUrl) {
    return createBlankMap(context.width, context.height);
  }

  try {
    const response = await fetch(mapboxUrl);
    if (!response.ok) {
      return createBlankMap(context.width, context.height);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return PNG.sync.read(buffer);
  } catch {
    return createBlankMap(context.width, context.height);
  }
}

export function buildMapContext(metadataTimeline, options = {}) {
  const width = options.width ?? VIEWER_MAP_WIDTH;
  const height = options.height ?? VIEWER_MAP_HEIGHT;
  const padding = options.padding ?? VIEWER_MAP_PADDING;
  const trackPoints = getTrackPoints(metadataTimeline);

  if (!trackPoints.length) {
    return null;
  }

  const bounds = buildMercatorBounds(trackPoints, width, height, padding);

  return {
    width,
    height,
    padding,
    minMercatorX: bounds.minX,
    maxMercatorX: bounds.maxX,
    minMercatorY: bounds.minY,
    maxMercatorY: bounds.maxY,
    route: samplePoints(trackPoints),
    provider: MAPBOX_TOKEN ? "mapbox" : "local",
    hasBaseMap: Boolean(MAPBOX_TOKEN),
    attribution: MAPBOX_TOKEN ? "Mapbox | OpenStreetMap" : "Locally rendered route trace",
  };
}

export function projectMapPoint(context, latitudeDeg, longitudeDeg) {
  const innerWidth = Math.max(context.width - (context.padding * 2), 1);
  const innerHeight = Math.max(context.height - (context.padding * 2), 1);
  const xRatio = (lonToMercatorX(longitudeDeg) - context.minMercatorX) / (context.maxMercatorX - context.minMercatorX);
  const yRatio = (latToMercatorY(latitudeDeg) - context.minMercatorY) / (context.maxMercatorY - context.minMercatorY);

  return {
    x: context.padding + (xRatio * innerWidth),
    y: context.padding + (yRatio * innerHeight),
  };
}

export async function renderMapImage(context, outputPath) {
  const png = await loadBaseMapPng(context);
  const routeColor = context.hasBaseMap
    ? { r: 14, g: 165, b: 233, a: 255 }
    : { r: 88, g: 209, b: 178, a: 255 };
  const shadowColor = { r: 4, g: 10, b: 16, a: 200 };

  let previous = null;
  for (const point of context.route) {
    const projected = projectMapPoint(context, point.latitudeDeg, point.longitudeDeg);

    if (previous) {
      drawLine(png, previous.x, previous.y, projected.x, projected.y, shadowColor, 8);
      drawLine(png, previous.x, previous.y, projected.x, projected.y, routeColor, 4);
    }

    previous = projected;
  }

  await fs.writeFile(outputPath, PNG.sync.write(png));
}
