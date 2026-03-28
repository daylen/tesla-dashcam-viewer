import fs from "node:fs/promises";
import path from "node:path";

const CAMERA_ORDER = [
  "front",
  "back",
  "left_pillar",
  "right_pillar",
  "left_repeater",
  "right_repeater",
];

const GEAR_NAMES = {
  0: "P",
  1: "D",
  2: "R",
  3: "N",
};

const AUTOPILOT_NAMES = {
  0: "None",
  1: "FSD",
  2: "Autosteer",
  3: "TACC",
};

function readAscii(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("ascii");
}

function findBox(buffer, start, end, name) {
  for (let position = start; position + 8 <= end; ) {
    let size = buffer.readUInt32BE(position);
    const type = readAscii(buffer, position + 4, 4);
    let headerSize = 8;

    if (size === 1) {
      size = Number(buffer.readBigUInt64BE(position + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - position;
    }

    if (size < 8) {
      return null;
    }

    if (type === name) {
      return {
        start: position + headerSize,
        end: position + size,
        size: size - headerSize,
        headerSize,
      };
    }

    position += size;
  }

  return null;
}

function stripEmulationBytes(data) {
  const bytes = [];
  let zeros = 0;

  for (const byte of data) {
    if (zeros >= 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }

    bytes.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }

  return Buffer.from(bytes);
}

function readVarint(data, offset) {
  let value = 0;
  let shift = 0;
  let current = offset;

  while (current < data.length) {
    const byte = data[current++];
    value += (byte & 0x7f) * (2 ** shift);

    if ((byte & 0x80) === 0) {
      return { value, nextOffset: current };
    }

    shift += 7;
    if (shift > 63) {
      break;
    }
  }

  return null;
}

function decodeSeiPayload(raw) {
  const payload = Buffer.from(raw);
  let offset = 0;

  const result = {
    version: 0,
    gearState: 0,
    frameSeqNo: 0,
    vehicleSpeedMps: 0,
    acceleratorPedalPosition: 0,
    steeringWheelAngle: 0,
    blinkerOnLeft: false,
    blinkerOnRight: false,
    brakeApplied: false,
    autopilotState: 0,
    latitudeDeg: 0,
    longitudeDeg: 0,
    headingDeg: 0,
    linearAccelerationX: 0,
    linearAccelerationY: 0,
    linearAccelerationZ: 0,
  };

  while (offset < payload.length) {
    const tag = readVarint(payload, offset);
    if (!tag) {
      break;
    }

    offset = tag.nextOffset;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x07;

    if (wireType === 0) {
      const value = readVarint(payload, offset);
      if (!value) {
        break;
      }

      offset = value.nextOffset;
      switch (fieldNumber) {
        case 1:
          result.version = value.value;
          break;
        case 2:
          result.gearState = value.value;
          break;
        case 3:
          result.frameSeqNo = value.value;
          break;
        case 7:
          result.blinkerOnLeft = value.value !== 0;
          break;
        case 8:
          result.blinkerOnRight = value.value !== 0;
          break;
        case 9:
          result.brakeApplied = value.value !== 0;
          break;
        case 10:
          result.autopilotState = value.value;
          break;
        default:
          break;
      }
      continue;
    }

    if (wireType === 1) {
      if (offset + 8 > payload.length) {
        break;
      }

      const value = payload.readDoubleLE(offset);
      offset += 8;

      switch (fieldNumber) {
        case 11:
          result.latitudeDeg = value;
          break;
        case 12:
          result.longitudeDeg = value;
          break;
        case 13:
          result.headingDeg = value;
          break;
        case 14:
          result.linearAccelerationX = value;
          break;
        case 15:
          result.linearAccelerationY = value;
          break;
        case 16:
          result.linearAccelerationZ = value;
          break;
        default:
          break;
      }
      continue;
    }

    if (wireType === 5) {
      if (offset + 4 > payload.length) {
        break;
      }

      const value = payload.readFloatLE(offset);
      offset += 4;

      switch (fieldNumber) {
        case 4:
          result.vehicleSpeedMps = value;
          break;
        case 5:
          result.acceleratorPedalPosition = value;
          break;
        case 6:
          result.steeringWheelAngle = value;
          break;
        default:
          break;
      }
      continue;
    }

    if (wireType === 2) {
      const length = readVarint(payload, offset);
      if (!length) {
        break;
      }

      offset = length.nextOffset + length.value;
      continue;
    }

    break;
  }

  return result;
}

function formatTelemetry(sei) {
  const speedMps = Number.isFinite(sei.vehicleSpeedMps) ? sei.vehicleSpeedMps : 0;
  const accelPedal = Number.isFinite(sei.acceleratorPedalPosition)
    ? sei.acceleratorPedalPosition
    : 0;

  return {
    version: sei.version,
    frameSeqNo: sei.frameSeqNo,
    speedMps,
    speedMph: speedMps * 2.2369362920544,
    speedKph: speedMps * 3.6,
    gearState: sei.gearState,
    gearLabel: GEAR_NAMES[sei.gearState] ?? "P",
    autopilotState: sei.autopilotState,
    autopilotLabel: AUTOPILOT_NAMES[sei.autopilotState] ?? "Unknown",
    acceleratorPedalPosition: accelPedal > 1 ? accelPedal / 100 : accelPedal,
    steeringWheelAngle: sei.steeringWheelAngle,
    blinkerOnLeft: sei.blinkerOnLeft,
    blinkerOnRight: sei.blinkerOnRight,
    brakeApplied: sei.brakeApplied,
    latitudeDeg: sei.latitudeDeg,
    longitudeDeg: sei.longitudeDeg,
    headingDeg: sei.headingDeg,
    linearAccelerationX: sei.linearAccelerationX,
    linearAccelerationY: sei.linearAccelerationY,
    linearAccelerationZ: sei.linearAccelerationZ,
  };
}

function parseSeiNal(nal) {
  if (nal.length < 4) {
    return null;
  }

  let index = 3;
  while (index < nal.length && nal[index] === 0x42) {
    index += 1;
  }

  if (index <= 3 || index + 1 >= nal.length || nal[index] !== 0x69) {
    return null;
  }

  const payload = stripEmulationBytes(nal.subarray(index + 1, nal.length - 1));
  const decoded = decodeSeiPayload(payload);

  if (!decoded.version && !decoded.vehicleSpeedMps && !decoded.frameSeqNo) {
    return null;
  }

  return formatTelemetry(decoded);
}

function extractTiming(buffer) {
  const moov = findBox(buffer, 0, buffer.length, "moov");
  if (!moov) {
    return { durationSeconds: 0, frameDurationsMs: [], fps: 0 };
  }

  const trak = findBox(buffer, moov.start, moov.end, "trak");
  const mdia = trak ? findBox(buffer, trak.start, trak.end, "mdia") : null;
  const mdhd = mdia ? findBox(buffer, mdia.start, mdia.end, "mdhd") : null;
  const minf = mdia ? findBox(buffer, mdia.start, mdia.end, "minf") : null;
  const stbl = minf ? findBox(buffer, minf.start, minf.end, "stbl") : null;
  const stts = stbl ? findBox(buffer, stbl.start, stbl.end, "stts") : null;

  if (!mdhd || !stts) {
    return { durationSeconds: 0, frameDurationsMs: [], fps: 0 };
  }

  const mdhdVersion = buffer[mdhd.start];
  const timescale = mdhdVersion === 1
    ? buffer.readUInt32BE(mdhd.start + 20)
    : buffer.readUInt32BE(mdhd.start + 12);
  const entryCount = buffer.readUInt32BE(stts.start + 4);
  const frameDurationsMs = [];
  let cursor = stts.start + 8;

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const sampleCount = buffer.readUInt32BE(cursor);
    const sampleDelta = buffer.readUInt32BE(cursor + 4);
    const durationMs = timescale ? (sampleDelta / timescale) * 1000 : 0;

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      frameDurationsMs.push(durationMs);
    }

    cursor += 8;
  }

  const durationSeconds = frameDurationsMs.reduce((total, value) => total + value, 0) / 1000;
  const fps = frameDurationsMs.length && durationSeconds
    ? frameDurationsMs.length / durationSeconds
    : 0;

  return { durationSeconds, frameDurationsMs, fps };
}

function buildTimeline(buffer, frameDurationsMs) {
  const mdat = findBox(buffer, 0, buffer.length, "mdat");
  if (!mdat) {
    return [];
  }

  const timeline = [];
  let cursor = mdat.start;
  let pendingSei = null;
  let frameIndex = 0;
  let elapsedMs = 0;

  while (cursor + 4 <= mdat.end) {
    const nalSize = buffer.readUInt32BE(cursor);
    cursor += 4;

    if (nalSize < 1 || cursor + nalSize > buffer.length) {
      break;
    }

    const nalType = buffer[cursor] & 0x1f;

    if (nalType === 6) {
      pendingSei = parseSeiNal(buffer.subarray(cursor, cursor + nalSize));
    } else if (nalType === 5 || nalType === 1) {
      if (pendingSei) {
        timeline.push({
          timeSeconds: elapsedMs / 1000,
          frameIndex,
          ...pendingSei,
        });
      }

      elapsedMs += frameDurationsMs[frameIndex] ?? 0;
      pendingSei = null;
      frameIndex += 1;
    }

    cursor += nalSize;
  }

  return timeline;
}

export async function extractTeslaClipData(filePath) {
  const buffer = await fs.readFile(filePath);
  const { durationSeconds, frameDurationsMs, fps } = extractTiming(buffer);
  const timeline = buildTimeline(buffer, frameDurationsMs);

  return {
    filePath,
    fileName: path.basename(filePath),
    durationSeconds,
    fps,
    timeline,
  };
}

export function getCameraOrder() {
  return [...CAMERA_ORDER];
}
