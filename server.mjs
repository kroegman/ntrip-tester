import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { RtcmStreamParser, haversineMeters } from './rtcm.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8080);
const MAX_CONNECTIONS = Math.max(1, Number(process.env.MAX_CONNECTIONS || 1000));
const START_RATE = Math.max(1, Number(process.env.START_RATE_PER_SECOND || 20));
const MAX_CHURN_PER_TICK = Math.max(1, Number(process.env.MAX_CHURN_PER_TICK || 50));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

export function nmeaCoordinate(value, positive, negative, latitude = true) {
  const n = Number(value);
  const degrees = Math.floor(Math.abs(n));
  const minutes = (Math.abs(n) - degrees) * 60;
  return {
    value: `${String(degrees).padStart(latitude ? 2 : 3, '0')}${minutes.toFixed(4).padStart(7, '0')}`,
    hemisphere: n >= 0 ? positive : negative
  };
}

function checksum(sentence) {
  let value = 0;
  for (const char of sentence) value ^= char.charCodeAt(0);
  return value.toString(16).toUpperCase().padStart(2, '0');
}

export function makeGga(latitude, longitude) {
  const now = new Date();
  const time = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}.00`;
  const lat = nmeaCoordinate(latitude, 'N', 'S', true);
  const lon = nmeaCoordinate(longitude, 'E', 'W', false);
  const body = `GPGGA,${time},${lat.value},${lat.hemisphere},${lon.value},${lon.hemisphere},1,12,1.0,0.0,M,0.0,M,,`;
  return `$${body}*${checksum(body)}\r\n`;
}

export class LoadTest extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map();
    this.config = null;
    this.running = false;
    this.startedAt = null;
    this.totals = { bytes: 0, errors: 0, reconnects: 0 };
    this.samples = [];
    this.lastBytes = 0;
    this.churnTimer = null;
    this.tick = setInterval(() => this.sample(), 1000);
    this.tick.unref();
  }

  publicStatus() {
    const streams = [...this.clients.values()].map(c => ({
      id: c.id, state: c.state, bytes: c.bytes, rate: c.rate, connectedAt: c.connectedAt,
      latency: c.latency, error: c.error || '', reconnects: c.reconnects, account: c.account.label || c.account.username,
      rover: { latitude: c.account.latitude ?? this.config?.latitude, longitude: c.account.longitude ?? this.config?.longitude },
      baseStation: c.rtcm?.baseStation ? {
        messageType: c.rtcm.baseStation.messageType, stationId: c.rtcm.baseStation.stationId,
        latitude: c.rtcm.baseStation.latitude, longitude: c.rtcm.baseStation.longitude,
        receivedAt: c.rtcm.baseStation.receivedAt
      } : null, rtcmFrames: c.rtcm?.frames || 0, rtcmTypes: c.rtcm?.counts.size || 0,
      churnEvents: c.churnEvents
    }));
    const publicConfig = this.config ? {
      host: this.config.host, port: this.config.port, mountpoint: this.config.mountpoint,
      connections: this.config.connections, accountMode: this.config.accountMode,
      latitude: this.config.latitude, longitude: this.config.longitude,
      tls: this.config.tls, sendGga: this.config.sendGga, ggaInterval: this.config.ggaInterval,
      autoReconnect: this.config.autoReconnect, parseRtcm: this.config.parseRtcm,
      randomChurn: this.config.randomChurn, churnInterval: this.config.churnInterval,
      churnPercent: this.config.churnPercent, churnDowntime: this.config.churnDowntime
    } : null;
    return {
      running: this.running, startedAt: this.startedAt,
      config: publicConfig,
      summary: {
        requested: this.config?.connections || 0,
        active: streams.filter(s => s.state === 'streaming').length,
        connecting: streams.filter(s => ['queued', 'connecting', 'churn-paused'].includes(s.state)).length,
        failed: streams.filter(s => s.state === 'error').length,
        bytes: this.totals.bytes,
        rate: streams.reduce((n, s) => n + s.rate, 0),
        errors: this.totals.errors,
        uptime: this.startedAt ? Date.now() - this.startedAt : 0
      },
      samples: this.samples,
      streams
    };
  }

  broadcast() { this.emit('update', this.publicStatus()); }

  sample() {
    for (const c of this.clients.values()) {
      c.rate = c.bytes - c.lastBytes;
      c.lastBytes = c.bytes;
    }
    const rate = this.totals.bytes - this.lastBytes;
    this.lastBytes = this.totals.bytes;
    this.samples.push({ t: Date.now(), rate, active: [...this.clients.values()].filter(c => c.state === 'streaming').length });
    if (this.samples.length > 60) this.samples.shift();
    this.broadcast();
  }

  async start(config) {
    this.stop();
    this.config = config;
    this.running = true;
    this.startedAt = Date.now();
    this.totals = { bytes: 0, errors: 0, reconnects: 0 };
    this.samples = [];
    this.lastBytes = 0;
    for (let i = 1; i <= config.connections; i++) {
      const account = config.accounts?.[i - 1] || { username: config.username, password: config.password, label: config.username };
      const client = { id: i, account, state: 'queued', bytes: 0, lastBytes: 0, rate: 0, connectedAt: null, latency: null, error: '', reconnects: 0, churnEvents: 0, chaosPaused: false, socket: null, ggaTimer: null, retryTimer: null, chaosResumeTimer: null, rtcm: config.parseRtcm ? new RtcmStreamParser() : null };
      this.clients.set(i, client);
      setTimeout(() => this.connect(client), Math.floor((i - 1) / START_RATE) * 1000 + ((i - 1) % START_RATE) * (1000 / START_RATE));
    }
    if (config.randomChurn) this.churnTimer = setInterval(() => this.churn(), config.churnInterval * 1000);
    this.broadcast();
  }

  churn() {
    if (!this.running || !this.config.randomChurn) return;
    const candidates = [...this.clients.values()].filter(client => client.state === 'streaming' && !client.chaosPaused);
    const requested = Math.max(1, Math.ceil(this.config.connections * this.config.churnPercent / 100));
    const count = Math.min(requested, MAX_CHURN_PER_TICK, candidates.length);
    for (let i = 0; i < count; i++) {
      const pick = i + Math.floor(Math.random() * (candidates.length - i));
      [candidates[i], candidates[pick]] = [candidates[pick], candidates[i]];
      const client = candidates[i];
      client.chaosPaused = true; client.state = 'churn-paused'; client.error = ''; client.churnEvents++;
      clearInterval(client.ggaTimer); client.ggaTimer = null; client.socket?.destroy();
      client.chaosResumeTimer = setTimeout(() => {
        client.chaosResumeTimer = null;
        if (!this.running) return;
        client.chaosPaused = false; this.connect(client);
      }, this.config.churnDowntime * 1000 + i * Math.floor(1000 / START_RATE));
    }
    this.broadcast();
  }

  connect(client) {
    if (!this.running || client.chaosPaused) return;
    client.state = 'connecting'; client.error = '';
    const cfg = this.config;
    const started = Date.now();
    const socket = cfg.tls
      ? tls.connect({ host: cfg.host, port: cfg.port, rejectUnauthorized: cfg.verifyTls, servername: cfg.host })
      : net.createConnection({ host: cfg.host, port: cfg.port });
    client.socket = socket;
    socket.setTimeout(cfg.connectTimeout * 1000);
    let headersDone = false;
    let headerBuffer = Buffer.alloc(0);
    const closeWithError = message => {
      client.error = message; client.state = 'error'; this.totals.errors++;
      socket.destroy(); this.scheduleReconnect(client); this.broadcast();
    };
    socket.once(cfg.tls ? 'secureConnect' : 'connect', () => {
      client.latency = Date.now() - started;
      const auth = Buffer.from(`${client.account.username}:${client.account.password}`).toString('base64');
      const request = [
        `GET /${encodeURI(cfg.mountpoint.replace(/^\/+/, ''))} HTTP/1.1`,
        `Host: ${cfg.host}:${cfg.port}`,
        'Ntrip-Version: Ntrip/2.0',
        'User-Agent: NTRIP Load Console/1.0',
        `Authorization: Basic ${auth}`,
        'Connection: close', '', ''
      ].join('\r\n');
      socket.write(request);
    });
    socket.on('data', chunk => {
      if (!headersDone) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const marker = headerBuffer.indexOf('\r\n\r\n');
        const firstLineEnd = headerBuffer.indexOf('\r\n');
        const icyResponse = /^ICY 200/i.test(headerBuffer.subarray(0, Math.max(firstLineEnd, 0)).toString('latin1'));
        if (marker < 0 && !(icyResponse && firstLineEnd >= 0) && headerBuffer.length < 16384) return;
        const headerEnd = marker >= 0 ? marker + 4 : firstLineEnd + 2;
        const header = headerBuffer.subarray(0, headerEnd).toString('latin1');
        if (!/^(HTTP\/1\.[01] 200|ICY 200)/i.test(header)) return closeWithError(header.split('\r\n')[0] || 'Invalid caster response');
        headersDone = true; client.state = 'streaming'; client.connectedAt = Date.now();
        const body = headerBuffer.subarray(headerEnd);
        client.bytes += body.length; this.totals.bytes += body.length;
        client.rtcm?.push(body);
        if (cfg.sendGga) {
          const latitude = client.account.latitude ?? cfg.latitude;
          const longitude = client.account.longitude ?? cfg.longitude;
          socket.write(makeGga(latitude, longitude));
          client.ggaTimer = setInterval(() => socket.writable && socket.write(makeGga(latitude, longitude)), cfg.ggaInterval * 1000);
        }
        return this.broadcast();
      }
      client.bytes += chunk.length; this.totals.bytes += chunk.length;
      client.rtcm?.push(chunk);
    });
    socket.on('timeout', () => closeWithError('Connection timed out'));
    socket.on('error', err => { if (client.state !== 'error') closeWithError(err.message); });
    socket.on('close', () => {
      clearInterval(client.ggaTimer); client.ggaTimer = null;
      if (this.running && client.state === 'streaming' && !client.chaosPaused) { client.state = 'error'; client.error = 'Stream closed'; this.totals.errors++; this.scheduleReconnect(client); }
    });
  }

  scheduleReconnect(client) {
    if (!this.running || !this.config.autoReconnect || client.retryTimer || client.chaosPaused) return;
    client.reconnects++; this.totals.reconnects++;
    client.retryTimer = setTimeout(() => { client.retryTimer = null; this.connect(client); }, this.config.reconnectDelay * 1000);
  }

  stop() {
    this.running = false;
    clearInterval(this.churnTimer); this.churnTimer = null;
    for (const client of this.clients.values()) {
      clearInterval(client.ggaTimer); clearTimeout(client.retryTimer); clearTimeout(client.chaosResumeTimer); client.socket?.destroy();
    }
    this.clients.clear(); this.config = null; this.startedAt = null; this.broadcast();
  }

  rtcmDetails(id) {
    const client = this.clients.get(Number(id));
    if (!client) return null;
    const rover = { latitude: client.account.latitude ?? this.config.latitude, longitude: client.account.longitude ?? this.config.longitude };
    const details = client.rtcm?.details() || { frames: 0, crcErrors: 0, lastMessageAt: null, baseStation: null, messages: [] };
    return {
      id: client.id, account: client.account.label || client.account.username, rover,
      enabled: Boolean(client.rtcm), distanceMeters: details.baseStation ? haversineMeters(rover, details.baseStation) : null,
      ...details
    };
  }
}

const loadTest = new LoadTest();

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function authorized(req) { return !ADMIN_TOKEN || req.headers.authorization === `Bearer ${ADMIN_TOKEN}`; }
async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 1048576) throw new Error('Request too large'); }
  return JSON.parse(body || '{}');
}
function validate(input) {
  const rawAccounts = Array.isArray(input.accounts) ? input.accounts : [];
  const cfg = {
    host: String(input.host || '').trim(), port: Number(input.port || 2101), mountpoint: String(input.mountpoint || '').trim(),
    username: String(input.username || ''), password: String(input.password || ''), connections: Number(input.connections || 1),
    latitude: Number(input.latitude), longitude: Number(input.longitude), tls: Boolean(input.tls), verifyTls: input.verifyTls !== false,
    sendGga: input.sendGga !== false, ggaInterval: Number(input.ggaInterval || 10), connectTimeout: Number(input.connectTimeout || 10),
    autoReconnect: input.autoReconnect !== false, reconnectDelay: Number(input.reconnectDelay || 5),
    parseRtcm: Boolean(input.parseRtcm), randomChurn: Boolean(input.randomChurn),
    churnInterval: Number(input.churnInterval || 15), churnPercent: Number(input.churnPercent || 5), churnDowntime: Number(input.churnDowntime || 3)
  };
  if (!cfg.host || !cfg.mountpoint) throw new Error('Host and mountpoint are required');
  if (rawAccounts.length) {
    cfg.accounts = rawAccounts.map((row, index) => {
      const account = {
        label: String(row.label || '').trim(), username: String(row.username || '').trim(), password: String(row.password ?? ''),
        latitude: row.latitude === '' || row.latitude == null ? null : Number(row.latitude),
        longitude: row.longitude === '' || row.longitude == null ? null : Number(row.longitude)
      };
      if (!account.username) throw new Error(`CSV row ${index + 2}: username is required`);
      if (account.latitude != null && (!Number.isFinite(account.latitude) || account.latitude < -90 || account.latitude > 90)) throw new Error(`CSV row ${index + 2}: invalid latitude`);
      if (account.longitude != null && (!Number.isFinite(account.longitude) || account.longitude < -180 || account.longitude > 180)) throw new Error(`CSV row ${index + 2}: invalid longitude`);
      return account;
    });
    cfg.connections = cfg.accounts.length;
    cfg.accountMode = 'csv';
  } else {
    if (!cfg.username) throw new Error('Username is required');
    cfg.accountMode = 'single';
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error('Port must be between 1 and 65535');
  if (!Number.isInteger(cfg.connections) || cfg.connections < 1 || cfg.connections > MAX_CONNECTIONS) throw new Error(`Connections must be between 1 and ${MAX_CONNECTIONS}`);
  if (!Number.isFinite(cfg.latitude) || cfg.latitude < -90 || cfg.latitude > 90) throw new Error('Latitude must be between -90 and 90');
  if (!Number.isFinite(cfg.longitude) || cfg.longitude < -180 || cfg.longitude > 180) throw new Error('Longitude must be between -180 and 180');
  if (cfg.ggaInterval < 1 || cfg.ggaInterval > 3600) throw new Error('GGA interval must be 1–3600 seconds');
  if (cfg.churnInterval < 2 || cfg.churnInterval > 3600) throw new Error('Churn interval must be 2–3600 seconds');
  if (cfg.churnPercent < 1 || cfg.churnPercent > 100) throw new Error('Churn percentage must be 1–100');
  if (cfg.churnDowntime < 1 || cfg.churnDowntime > 300) throw new Error('Churn downtime must be 1–300 seconds');
  return cfg;
}

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/') && !authorized(req)) return json(res, 401, { error: 'Unauthorized' });
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { ...loadTest.publicStatus(), limits: { maxConnections: MAX_CONNECTIONS, startRate: START_RATE, maxChurnPerTick: MAX_CHURN_PER_TICK } });
    const rtcmMatch = url.pathname.match(/^\/api\/streams\/(\d+)\/rtcm$/);
    if (req.method === 'GET' && rtcmMatch) { const details = loadTest.rtcmDetails(rtcmMatch[1]); return details ? json(res, 200, details) : json(res, 404, { error: 'Stream not found' }); }
    if (req.method === 'POST' && url.pathname === '/api/test/start') { const cfg = validate(await readJson(req)); loadTest.start(cfg); return json(res, 202, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/test/stop') { loadTest.stop(); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send(loadTest.publicStatus()); loadTest.on('update', send); req.on('close', () => loadTest.off('update', send)); return;
    }
    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(PUBLIC, path.normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); fs.createReadStream(file).pipe(res);
  } catch (err) { json(res, 400, { error: err.message || 'Bad request' }); }
});

if (process.env.NODE_ENV !== 'test') server.listen(PORT, '0.0.0.0', () => console.log(`NTRIP Load Console listening on :${PORT}`));

export { validate };
