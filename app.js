const $ = s => document.querySelector(s);
const form = $('#configForm');
let latest = null;

function formatBytes(bytes, suffix = '') {
  if (!Number.isFinite(bytes) || bytes === 0) return `0 B${suffix}`;
  const units = ['B','KB','MB','GB']; const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}${suffix}`;
}
function duration(ms) { const s=Math.floor(ms/1000); return [Math.floor(s/3600),Math.floor(s%3600/60),s%60].map(n=>String(n).padStart(2,'0')).join(':'); }
function esc(value){ const d=document.createElement('div'); d.textContent=String(value); return d.innerHTML; }
function render(status) {
  latest = status; const s = status.summary;
  $('#activeCount').textContent=s.active; $('#requestedCount').textContent=s.requested; $('#connectingCount').textContent=s.connecting;
  $('#errorCount').textContent=s.errors; $('#throughput').textContent=formatBytes(s.rate,'/s'); $('#dataReceived').textContent=formatBytes(s.bytes);
  $('#uptime').textContent=duration(s.uptime); $('#activeMeter').style.width=`${s.requested ? s.active/s.requested*100 : 0}%`;
  $('#systemDot').className=`dot ${status.running?'running':'idle'}`; $('#systemLabel').textContent=status.running?'Test running':'Idle';
  $('#startBtn').disabled=status.running; $('#stopBtn').disabled=!status.running; [...form.elements].filter(e=>e.name).forEach(e=>e.disabled=status.running);
  drawChart(status.samples || []); renderRows(status.streams || []);
}
function drawChart(samples) {
  const values=samples.map(x=>x.rate); const peak=Math.max(1,...values); $('#chartPeak').textContent=`${formatBytes(peak,'/s')} peak`;
  const points=values.map((v,i)=>`${i/(Math.max(values.length-1,1))*600},${125-v/peak*110}`);
  const line=points.length?`M${points.join(' L')}`:''; $('#chart .chart-line').setAttribute('d',line); $('#chart .chart-area').setAttribute('d',points.length?`${line} L600,130 L0,130 Z`:'');
}
function renderRows(streams) {
  const q=$('#streamSearch').value.toLowerCase(); const rows=streams.filter(s=>String(s.id).includes(q)||s.state.includes(q)||s.error.toLowerCase().includes(q)).slice(0,500);
  $('#streamRows').innerHTML=rows.length?rows.map(s=>`<tr><td>#${String(s.id).padStart(3,'0')}</td><td><span class="state ${esc(s.state)}">${esc(s.state)}</span></td><td>${s.latency==null?'—':s.latency+' ms'}</td><td>${formatBytes(s.rate,'/s')}</td><td>${formatBytes(s.bytes)}</td><td>${s.reconnects}</td><td title="${esc(s.error)}">${esc(s.error|| (s.state==='streaming'?'Receiving RTCM':'Waiting'))}</td></tr>`).join(''):'<tr><td colspan="7" class="empty">No connections match this filter.</td></tr>';
}
async function api(path, options={}) { const response=await fetch(path,{headers:{'Content-Type':'application/json'},...options}); const data=await response.json(); if(!response.ok) throw new Error(data.error||'Request failed'); return data; }
form.addEventListener('submit',async e=>{e.preventDefault(); $('#message').textContent=''; const d=new FormData(form); const payload=Object.fromEntries(d); ['port','connections','latitude','longitude','ggaInterval'].forEach(k=>payload[k]=Number(payload[k])); ['sendGga','tls','autoReconnect'].forEach(k=>payload[k]=d.has(k)); try{await api('/api/test/start',{method:'POST',body:JSON.stringify(payload)});}catch(err){$('#message').textContent=err.message;}});
$('#stopBtn').addEventListener('click',()=>api('/api/test/stop',{method:'POST'}).catch(err=>$('#message').textContent=err.message));
$('#streamSearch').addEventListener('input',()=>latest&&renderRows(latest.streams));
$('#downloadCsv').addEventListener('click',()=>{if(!latest)return; const rows=[['client','status','latency_ms','rate_bytes_s','received_bytes','reconnects','message'],...latest.streams.map(s=>[s.id,s.state,s.latency??'',s.rate,s.bytes,s.reconnects,s.error])]; const csv=rows.map(r=>r.map(x=>`"${String(x).replaceAll('"','""')}"`).join(',')).join('\n'); const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`ntrip-streams-${Date.now()}.csv`;a.click();URL.revokeObjectURL(a.href);});
fetch('/api/status').then(r=>r.json()).then(s=>{$('#limitBadge').textContent=`Up to ${s.limits.maxConnections}`;form.connections.max=s.limits.maxConnections;render(s)});
const events=new EventSource('/api/events'); events.onmessage=e=>render(JSON.parse(e.data));
