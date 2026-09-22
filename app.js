const $ = selector => document.querySelector(selector);
const form = $('#configForm');
let latest = null;
let csvAccounts = [];
let selectedStreamId = null;
let map = null, roverMarker = null, baseMarker = null, baselineLine = null, lastMapSignature = '';

const messageNames = {
  1005: 'Base ARP', 1006: 'Base ARP + height', 1007: 'Antenna descriptor', 1008: 'Antenna + serial',
  1019: 'GPS ephemeris', 1020: 'GLONASS ephemeris', 1033: 'Receiver descriptor',
  1074: 'GPS MSM4', 1075: 'GPS MSM5', 1076: 'GPS MSM6', 1077: 'GPS MSM7',
  1084: 'GLONASS MSM4', 1085: 'GLONASS MSM5', 1086: 'GLONASS MSM6', 1087: 'GLONASS MSM7',
  1094: 'Galileo MSM4', 1095: 'Galileo MSM5', 1096: 'Galileo MSM6', 1097: 'Galileo MSM7',
  1124: 'BeiDou MSM4', 1125: 'BeiDou MSM5', 1126: 'BeiDou MSM6', 1127: 'BeiDou MSM7', 1230: 'GLONASS bias'
};

function formatBytes(bytes, suffix = '') {
  if (!Number.isFinite(bytes) || bytes === 0) return `0 B${suffix}`;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}${suffix}`;
}

function duration(ms) {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
}

function esc(value) {
  const node = document.createElement('div');
  node.textContent = String(value);
  return node.innerHTML;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted && char === '"' && text[i + 1] === '"') { field += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some(value => value.trim())) rows.push(row);
  if (!rows.length) throw new Error('CSV is empty');
  const headers = rows.shift().map(value => value.trim().toLowerCase().replace(/^\ufeff/, ''));
  for (const required of ['username', 'password']) if (!headers.includes(required)) throw new Error(`Missing ${required} column`);
  return rows.map((values, index) => {
    const account = Object.fromEntries(headers.map((header, column) => [header, (values[column] ?? '').trim()]));
    if (!account.username) throw new Error(`Row ${index + 2}: username is required`);
    return { label: account.label || '', username: account.username, password: account.password, latitude: account.latitude || '', longitude: account.longitude || '' };
  });
}

function selectedMode() { return form.elements.credentialMode.value; }

function updateCredentialMode() {
  const csvMode = selectedMode() === 'csv';
  $('#singleCredentials').hidden = csvMode;
  $('#csvCredentials').hidden = !csvMode;
  $('#connectionField').hidden = csvMode;
  form.elements.username.required = !csvMode;
  form.elements.connections.required = !csvMode;
}

function initMap() {
  if (!window.L) { $('#mapEmpty').textContent = 'Map library could not be loaded. RTCM message inspection still works.'; return; }
  map = L.map('map', { zoomControl: true }).setView([52.3676, 4.9041], 10);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
}

function distanceMeters(a, b) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function formatDistance(value) { return value == null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${value.toFixed(1)} m`; }

function updateMap(stream) {
  if (!stream) { $('#mapEmpty').hidden = false; $('#mapEmpty').textContent = 'Enable RTCM diagnostics and select a connection.'; $('#baselineDistance').textContent = '—'; return; }
  const enabled = Boolean(latest?.config?.parseRtcm);
  $('#mapEmpty').hidden = enabled;
  if (!enabled) { $('#mapEmpty').textContent = 'RTCM diagnostics are disabled for this test.'; return; }
  if (!map) { $('#mapEmpty').hidden = false; $('#mapEmpty').textContent = 'Map tiles could not be loaded. RTCM message inspection still works.'; return; }
  if (!stream.rover) return;
  const rover = [stream.rover.latitude, stream.rover.longitude];
  const roverIcon = L.divIcon({ className: 'rover-marker', iconSize: [18, 18] });
  const baseIcon = L.divIcon({ className: 'base-marker', iconSize: [18, 18] });
  if (!roverMarker) roverMarker = L.marker(rover, { icon: roverIcon }).addTo(map).bindTooltip('Rover').on('click', () => refreshRtcmDetails());
  else roverMarker.setLatLng(rover);
  const base = stream.baseStation;
  if (base) {
    const baseLatLng = [base.latitude, base.longitude];
    if (!baseMarker) baseMarker = L.marker(baseLatLng, { icon: baseIcon }).addTo(map).bindTooltip('Base station');
    else baseMarker.setLatLng(baseLatLng);
    if (!baselineLine) baselineLine = L.polyline([rover, baseLatLng], { color: '#6ee7b7', weight: 2, dashArray: '7 7' }).addTo(map);
    else baselineLine.setLatLngs([rover, baseLatLng]);
    $('#baselineDistance').textContent = formatDistance(distanceMeters(stream.rover, base));
    const signature = `${stream.id}:${rover.join(',')}:${baseLatLng.join(',')}`;
    if (signature !== lastMapSignature) { map.fitBounds([rover, baseLatLng], { padding: [55, 55], maxZoom: 17 }); lastMapSignature = signature; }
  } else {
    if (baseMarker) { map.removeLayer(baseMarker); baseMarker = null; }
    if (baselineLine) { map.removeLayer(baselineLine); baselineLine = null; }
    $('#baselineDistance').textContent = 'Waiting for 1005/1006';
    const signature = `${stream.id}:${rover.join(',')}`;
    if (signature !== lastMapSignature) { map.setView(rover, 14); lastMapSignature = signature; }
  }
}

async function selectStream(id) {
  selectedStreamId = Number(id);
  const stream = latest?.streams.find(item => item.id === selectedStreamId);
  $('#selectedStream').textContent = stream ? `#${String(stream.id).padStart(3, '0')} · ${stream.account}` : 'No connection';
  renderRows(latest?.streams || []);
  updateMap(stream);
  await refreshRtcmDetails();
}

async function refreshRtcmDetails() {
  if (!selectedStreamId || !latest?.running) return;
  try {
    const details = await api(`/api/streams/${selectedStreamId}/rtcm`);
    $('#messageSummary').textContent = details.enabled ? `${details.frames.toLocaleString()} valid frames · ${details.messages.length} types` : 'RTCM diagnostics disabled';
    $('#crcSummary').textContent = `${details.crcErrors.toLocaleString()} CRC errors`;
    if (details.baseStation) {
      const base = details.baseStation;
      $('#stationDetails').innerHTML = `<div><span>MESSAGE</span><strong>RTCM ${base.messageType}</strong></div><div><span>STATION ID</span><strong>${base.stationId}</strong></div><div><span>BASE POSITION</span><strong>${base.latitude.toFixed(7)}, ${base.longitude.toFixed(7)}</strong></div><div><span>BASELINE</span><strong>${formatDistance(details.distanceMeters)}</strong></div>`;
    } else $('#stationDetails').innerHTML = '<span>Waiting for RTCM 1005 or 1006.</span>';
    $('#messageTypes').innerHTML = details.messages.length ? details.messages.map(message => `<div class="message-chip"><strong>${message.type}</strong><span>${esc(messageNames[message.type] || 'RTCM message')}</span><span>${message.count.toLocaleString()} frames</span></div>`).join('') : '<p>No complete RTCM frames decoded for this connection yet.</p>';
  } catch (error) { $('#messageSummary').textContent = error.message; }
}

function render(status) {
  latest = status;
  const summary = status.summary;
  $('#activeCount').textContent = summary.active;
  $('#requestedCount').textContent = summary.requested;
  $('#connectingCount').textContent = summary.connecting;
  $('#errorCount').textContent = summary.errors;
  $('#throughput').textContent = formatBytes(summary.rate, '/s');
  $('#dataReceived').textContent = formatBytes(summary.bytes);
  $('#uptime').textContent = duration(summary.uptime);
  $('#activeMeter').style.width = `${summary.requested ? summary.active / summary.requested * 100 : 0}%`;
  $('#systemDot').className = `dot ${status.running ? 'running' : 'idle'}`;
  $('#systemLabel').textContent = status.running ? 'Test running' : 'Idle';
  $('#startBtn').disabled = status.running;
  $('#stopBtn').disabled = !status.running;
  [...form.elements].filter(element => element.name || element.id === 'accountCsv').forEach(element => element.disabled = status.running);
  drawChart(status.samples || []);
  renderRows(status.streams || []);
  if (!selectedStreamId && status.config?.parseRtcm && status.streams.length) selectedStreamId = status.streams[0].id;
  const selected = status.streams.find(stream => stream.id === selectedStreamId);
  if (selected) $('#selectedStream').textContent = `#${String(selected.id).padStart(3, '0')} · ${selected.account}`;
  updateMap(selected);
}

function drawChart(samples) {
  const values = samples.map(sample => sample.rate);
  const peak = Math.max(1, ...values);
  $('#chartPeak').textContent = `${formatBytes(peak, '/s')} peak`;
  const points = values.map((value, index) => `${index / Math.max(values.length - 1, 1) * 600},${125 - value / peak * 110}`);
  const line = points.length ? `M${points.join(' L')}` : '';
  $('#chart .chart-line').setAttribute('d', line);
  $('#chart .chart-area').setAttribute('d', points.length ? `${line} L600,130 L0,130 Z` : '');
}

function renderRows(streams) {
  const query = $('#streamSearch').value.toLowerCase();
  const rows = streams.filter(stream => String(stream.id).includes(query) || stream.state.includes(query) || stream.account.toLowerCase().includes(query) || stream.error.toLowerCase().includes(query)).slice(0, 500);
  $('#streamRows').innerHTML = rows.length ? rows.map(stream => `<tr data-id="${stream.id}" class="${stream.id === selectedStreamId ? 'selected' : ''}">
    <td>#${String(stream.id).padStart(3, '0')}</td><td>${esc(stream.account)}</td>
    <td><span class="state ${esc(stream.state)}">${esc(stream.state)}</span></td>
    <td>${stream.latency == null ? '—' : `${stream.latency} ms`}</td><td>${formatBytes(stream.rate, '/s')}</td>
    <td>${stream.rtcmFrames ? `${stream.rtcmFrames.toLocaleString()} / ${stream.rtcmTypes} types` : '—'}</td><td>${formatBytes(stream.bytes)}</td><td>${stream.reconnects}</td><td>${stream.churnEvents}</td>
    <td title="${esc(stream.error)}">${esc(stream.error || (stream.state === 'streaming' ? 'Receiving RTCM' : 'Waiting'))}</td>
  </tr>`).join('') : '<tr><td colspan="10" class="empty">No connections match this filter.</td></tr>';
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

document.querySelectorAll('[name="credentialMode"]').forEach(input => input.addEventListener('change', updateCredentialMode));
form.elements.randomChurn.addEventListener('change', () => { $('#churnSettings').hidden = !form.elements.randomChurn.checked; });
$('#accountCsv').addEventListener('change', async event => {
  $('#message').textContent = '';
  try {
    const file = event.target.files[0];
    if (!file) { csvAccounts = []; $('#csvStatus').textContent = 'No file selected'; return; }
    csvAccounts = parseCsv(await file.text());
    if (!csvAccounts.length) throw new Error('CSV has no account rows');
    const max = Number(form.elements.connections.max);
    if (csvAccounts.length > max) throw new Error(`CSV contains ${csvAccounts.length} accounts; maximum is ${max}`);
    $('#csvStatus').textContent = `${csvAccounts.length} account${csvAccounts.length === 1 ? '' : 's'} ready`;
  } catch (error) {
    csvAccounts = [];
    $('#csvStatus').textContent = 'CSV could not be loaded';
    $('#message').textContent = error.message;
  }
});

$('#downloadTemplate').addEventListener('click', () => {
  const csv = 'label,username,password,latitude,longitude\nRover 01,user01,secret01,52.3676,4.9041\nRover 02,user02,secret02,,\n';
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  anchor.download = 'ntrip-accounts-template.csv';
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  $('#message').textContent = '';
  const data = new FormData(form);
  const payload = Object.fromEntries(data);
  ['port', 'connections', 'latitude', 'longitude', 'ggaInterval', 'churnInterval', 'churnPercent', 'churnDowntime'].forEach(key => payload[key] = Number(payload[key]));
  ['sendGga', 'tls', 'autoReconnect', 'parseRtcm', 'randomChurn'].forEach(key => payload[key] = data.has(key));
  if (selectedMode() === 'csv') {
    if (!csvAccounts.length) { $('#message').textContent = 'Load a valid account CSV first'; return; }
    payload.accounts = csvAccounts;
    payload.connections = csvAccounts.length;
    delete payload.username;
    delete payload.password;
  }
  delete payload.credentialMode;
  try { await api('/api/test/start', { method: 'POST', body: JSON.stringify(payload) }); }
  catch (error) { $('#message').textContent = error.message; }
});

$('#stopBtn').addEventListener('click', () => api('/api/test/stop', { method: 'POST' }).catch(error => $('#message').textContent = error.message));
$('#streamSearch').addEventListener('input', () => latest && renderRows(latest.streams));
$('#streamRows').addEventListener('click', event => { const row = event.target.closest('tr[data-id]'); if (row) selectStream(row.dataset.id); });
$('#downloadCsv').addEventListener('click', () => {
  if (!latest) return;
  const rows = [['client', 'account', 'status', 'latency_ms', 'rate_bytes_s', 'rtcm_frames', 'rtcm_types', 'received_bytes', 'reconnects', 'churn_events', 'message'], ...latest.streams.map(stream => [stream.id, stream.account, stream.state, stream.latency ?? '', stream.rate, stream.rtcmFrames, stream.rtcmTypes, stream.bytes, stream.reconnects, stream.churnEvents, stream.error])];
  const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  anchor.download = `ntrip-streams-${Date.now()}.csv`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});

fetch('/api/status').then(response => response.json()).then(status => {
  $('#limitBadge').textContent = `Up to ${status.limits.maxConnections}`;
  form.elements.connections.max = status.limits.maxConnections;
  render(status);
});
const events = new EventSource('/api/events');
events.onmessage = event => render(JSON.parse(event.data));
setInterval(() => { if (latest?.config?.parseRtcm && selectedStreamId) refreshRtcmDetails(); }, 2000);
updateCredentialMode();
initMap();
