const $ = selector => document.querySelector(selector);
const form = $('#configForm');
let latest = null;
let csvAccounts = [];

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
  $('#streamRows').innerHTML = rows.length ? rows.map(stream => `<tr>
    <td>#${String(stream.id).padStart(3, '0')}</td><td>${esc(stream.account)}</td>
    <td><span class="state ${esc(stream.state)}">${esc(stream.state)}</span></td>
    <td>${stream.latency == null ? '—' : `${stream.latency} ms`}</td><td>${formatBytes(stream.rate, '/s')}</td>
    <td>${formatBytes(stream.bytes)}</td><td>${stream.reconnects}</td>
    <td title="${esc(stream.error)}">${esc(stream.error || (stream.state === 'streaming' ? 'Receiving RTCM' : 'Waiting'))}</td>
  </tr>`).join('') : '<tr><td colspan="8" class="empty">No connections match this filter.</td></tr>';
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

document.querySelectorAll('[name="credentialMode"]').forEach(input => input.addEventListener('change', updateCredentialMode));
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
  ['port', 'connections', 'latitude', 'longitude', 'ggaInterval'].forEach(key => payload[key] = Number(payload[key]));
  ['sendGga', 'tls', 'autoReconnect'].forEach(key => payload[key] = data.has(key));
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
$('#downloadCsv').addEventListener('click', () => {
  if (!latest) return;
  const rows = [['client', 'account', 'status', 'latency_ms', 'rate_bytes_s', 'received_bytes', 'reconnects', 'message'], ...latest.streams.map(stream => [stream.id, stream.account, stream.state, stream.latency ?? '', stream.rate, stream.bytes, stream.reconnects, stream.error])];
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
updateCredentialMode();
