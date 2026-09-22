import test from 'node:test';
import assert from 'node:assert/strict';
import { crc24q, ecefToGeodetic, haversineMeters, RtcmStreamParser } from '../rtcm.mjs';

function setBits(buffer, start, length, input) {
  let value = BigInt(input);
  if (value < 0) value += 1n << BigInt(length);
  for (let i = 0; i < length; i++) {
    const bit = Number((value >> BigInt(length - i - 1)) & 1n);
    const offset = start + i;
    buffer[offset >> 3] |= bit << (7 - (offset & 7));
  }
}

function referenceFrame(type = 1006) {
  const payload = Buffer.alloc(type === 1006 ? 21 : 19);
  setBits(payload, 0, 12, type); setBits(payload, 12, 12, 42);
  setBits(payload, 34, 38, BigInt(Math.round(3895234.1234 * 10000)));
  setBits(payload, 74, 38, BigInt(Math.round(306821.4567 * 10000)));
  setBits(payload, 114, 38, BigInt(Math.round(5027189.4321 * 10000)));
  if (type === 1006) setBits(payload, 152, 16, 12345);
  const header = Buffer.from([0xd3, (payload.length >> 8) & 3, payload.length & 255]);
  const body = Buffer.concat([header, payload]); const crc = crc24q(body);
  return Buffer.concat([body, Buffer.from([(crc >> 16) & 255, (crc >> 8) & 255, crc & 255])]);
}

test('ECEF conversion returns a plausible position', () => { const p=ecefToGeodetic(3895234.1234,306821.4567,5027189.4321); assert.ok(p.latitude>52&&p.latitude<53); assert.ok(p.longitude>4&&p.longitude<5); });
test('CRC-24Q matches the standard check vector', () => { assert.equal(crc24q(Buffer.from('123456789')),0xcde703); });
test('incremental RTCM parser counts and decodes 1006', () => { const frame=referenceFrame(); const parser=new RtcmStreamParser(); parser.push(frame.subarray(0,7)); parser.push(frame.subarray(7)); const d=parser.details(); assert.equal(d.frames,1); assert.deepEqual(d.messages,[{type:1006,count:1}]); assert.equal(d.baseStation.stationId,42); assert.ok(Math.abs(d.baseStation.antennaHeight-1.2345)<1e-9); });
test('RTCM 1005 has no antenna height', () => { const parser=new RtcmStreamParser(); parser.push(referenceFrame(1005)); assert.equal(parser.details().baseStation.messageType,1005); assert.equal(parser.details().baseStation.antennaHeight,null); });
test('distance calculation is stable', () => { const d=haversineMeters({latitude:52,longitude:4},{latitude:52.001,longitude:4}); assert.ok(d>111&&d<112); });
