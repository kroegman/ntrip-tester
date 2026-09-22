const CRC24Q_POLY = 0x1864cfb;
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i << 16;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x800000) ? CRC24Q_POLY : 0);
  CRC_TABLE[i] = crc & 0xffffff;
}

export function crc24q(buffer) {
  let crc = 0;
  for (const byte of buffer) crc = ((crc << 8) ^ CRC_TABLE[((crc >> 16) ^ byte) & 0xff]) & 0xffffff;
  return crc;
}

function unsignedBits(buffer, start, length) {
  let value = 0n;
  for (let i = 0; i < length; i++) {
    const offset = start + i;
    value = (value << 1n) | BigInt((buffer[offset >> 3] >> (7 - (offset & 7))) & 1);
  }
  return value;
}

function signedBits(buffer, start, length) {
  const value = unsignedBits(buffer, start, length);
  const sign = 1n << BigInt(length - 1);
  return value & sign ? value - (1n << BigInt(length)) : value;
}

export function ecefToGeodetic(x, y, z) {
  const a = 6378137.0;
  const e2 = 6.6943799901413165e-3;
  const longitude = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let latitude = Math.atan2(z, p * (1 - e2));
  let height = 0;
  for (let i = 0; i < 8; i++) {
    const sin = Math.sin(latitude);
    const n = a / Math.sqrt(1 - e2 * sin * sin);
    height = p / Math.cos(latitude) - n;
    latitude = Math.atan2(z, p * (1 - e2 * n / (n + height)));
  }
  return { latitude: latitude * 180 / Math.PI, longitude: longitude * 180 / Math.PI, ellipsoidHeight: height };
}

export function decodeReferenceStation(payload, messageType) {
  if ((messageType !== 1005 && messageType !== 1006) || payload.length < (messageType === 1006 ? 21 : 19)) return null;
  const stationId = Number(unsignedBits(payload, 12, 12));
  const x = Number(signedBits(payload, 34, 38)) * 0.0001;
  const y = Number(signedBits(payload, 74, 38)) * 0.0001;
  const z = Number(signedBits(payload, 114, 38)) * 0.0001;
  const position = ecefToGeodetic(x, y, z);
  return {
    messageType, stationId, x, y, z,
    antennaHeight: messageType === 1006 ? Number(unsignedBits(payload, 152, 16)) * 0.0001 : null,
    ...position
  };
}

export class RtcmStreamParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.counts = new Map();
    this.frames = 0;
    this.crcErrors = 0;
    this.lastMessageAt = null;
    this.baseStation = null;
  }

  push(chunk) {
    if (!chunk?.length) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    while (this.buffer.length >= 6) {
      const preamble = this.buffer.indexOf(0xd3);
      if (preamble < 0) { this.buffer = Buffer.alloc(0); return; }
      if (preamble > 0) this.buffer = this.buffer.subarray(preamble);
      if (this.buffer.length < 6) return;
      if (this.buffer[1] & 0xfc) { this.buffer = this.buffer.subarray(1); continue; }
      const payloadLength = ((this.buffer[1] & 0x03) << 8) | this.buffer[2];
      const frameLength = payloadLength + 6;
      if (this.buffer.length < frameLength) return;
      const frame = this.buffer.subarray(0, frameLength);
      const expected = (frame[frameLength - 3] << 16) | (frame[frameLength - 2] << 8) | frame[frameLength - 1];
      if (crc24q(frame.subarray(0, frameLength - 3)) !== expected) {
        this.crcErrors++;
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      const payload = frame.subarray(3, frameLength - 3);
      if (payload.length >= 2) {
        const messageType = (payload[0] << 4) | (payload[1] >> 4);
        this.frames++;
        this.lastMessageAt = Date.now();
        this.counts.set(messageType, (this.counts.get(messageType) || 0) + 1);
        const base = decodeReferenceStation(payload, messageType);
        if (base) this.baseStation = { ...base, receivedAt: this.lastMessageAt };
      }
      this.buffer = this.buffer.subarray(frameLength);
    }
    if (this.buffer.length > 4096) this.buffer = this.buffer.subarray(-4096);
  }

  details() {
    return {
      frames: this.frames, crcErrors: this.crcErrors, lastMessageAt: this.lastMessageAt,
      baseStation: this.baseStation,
      messages: [...this.counts].map(([type, count]) => ({ type, count })).sort((a, b) => a.type - b.type)
    };
  }
}

export function haversineMeters(a, b) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude), lat2 = radians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
