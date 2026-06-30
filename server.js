const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const fs = require('fs');

const app = express();
expressWs(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Persistent file storage ───────────────────────────────────────────────────
// Render gives us a writable /tmp directory. Data survives restarts within
// the same instance but resets on deploys. Good enough to survive spin-down.
const DATA_FILE    = '/tmp/atl_jobs.json';
const HISTORY_FILE = '/tmp/atl_history.json';
const REASONS_FILE = '/tmp/atl_reasons.json';

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch(e) { console.error('Load error', file, e.message); }
  return fallback;
}

function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data), 'utf8'); }
  catch(e) { console.error('Save error', file, e.message); }
}

// ── Load state from disk on startup ──────────────────────────────────────────
let jobs    = loadJSON(DATA_FILE, []);
let history = loadJSON(HISTORY_FILE, []);
let reasons = loadJSON(REASONS_FILE,
  ['AOS','RON','LOAN','LOG','AOS LOAN','STS','ATS','STL','RTS']);
let nextId  = jobs.length ? Math.max(...jobs.map(j => j.id)) + 1 : 1;

console.log(`Loaded ${jobs.length} jobs, ${history.length} history entries`);

// ── Connected WebSocket clients ───────────────────────────────────────────────
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(ws => { try { ws.send(data); } catch(e) {} });
}

function monthKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
}

// ── WebSocket endpoint ────────────────────────────────────────────────────────
app.ws('/live', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', jobs, reasons }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ── Keep-alive ping — prevents Render free tier spin-down ────────────────────
// Pings itself every 10 minutes so the server never goes to sleep
const BASE_URL = process.env.RENDER_EXTERNAL_URL || '';
if (BASE_URL) {
  setInterval(() => {
    const https = require('https');
    https.get(BASE_URL + '/ping', (r) => {
      console.log('Keep-alive ping:', r.statusCode);
    }).on('error', (e) => console.log('Ping error:', e.message));
  }, 10 * 60 * 1000); // every 10 minutes
}

app.get('/ping', (req, res) => res.send('ok'));

// ── REST API ──────────────────────────────────────────────────────────────────
app.post('/api/jobs', (req, res) => {
  const job = { id: nextId++, ...req.body,
                done: false, transit: false, clearedBy: '', clearedAt: '',
                isTest: !!req.body.isTest };
  jobs.push(job);
  saveJSON(DATA_FILE, jobs);
  broadcast({ type: 'jobs', jobs });
  res.json(job);
});

app.put('/api/jobs/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  jobs[idx] = { ...jobs[idx], ...req.body };
  saveJSON(DATA_FILE, jobs);
  broadcast({ type: 'jobs', jobs });
  res.json(jobs[idx]);
});

app.post('/api/jobs/:id/done', (req, res) => {
  const id = parseInt(req.params.id);
  const j = jobs.find(x => x.id === id);
  if (!j) return res.status(404).json({ error: 'not found' });
  j.done = true;
  j.transit = false;
  j.clearedBy = req.body.label || 'Done';
  const n = new Date();
  j.clearedAt = String(n.getHours()).padStart(2,'0') + ':' +
                String(n.getMinutes()).padStart(2,'0');

  // Only log real jobs to metrics history
  if (!j.isTest) {
    history.push({
      date: n.toISOString().slice(0,10),
      month: monthKey(n),
      shift: j.shift,
      type: j.type,
      route: j.route,
      awb: j.awb,
      completedAt: j.clearedAt
    });
    saveJSON(HISTORY_FILE, history);
  }

  saveJSON(DATA_FILE, jobs);
  broadcast({ type: 'jobs', jobs });
  res.json(j);
});

app.post('/api/jobs/:id/transit', (req, res) => {
  const id = parseInt(req.params.id);
  const j = jobs.find(x => x.id === id);
  if (!j) return res.status(404).json({ error: 'not found' });
  j.transit = !j.transit;
  saveJSON(DATA_FILE, jobs);
  broadcast({ type: 'jobs', jobs });
  res.json(j);
});

app.post('/api/jobs/:id/undo', (req, res) => {
  const id = parseInt(req.params.id);
  const j = jobs.find(x => x.id === id);
  if (!j) return res.status(404).json({ error: 'not found' });
  j.done = false; j.transit = false; j.clearedBy = ''; j.clearedAt = '';
  saveJSON(DATA_FILE, jobs);
  broadcast({ type: 'jobs', jobs });
  res.json(j);
});

app.delete('/api/jobs/:id', (req, res) => {
  jobs = jobs.filter(j => j.id !== parseInt(req.params.id));
  saveJSON(DATA_FILE, jobs);
  broadcast({ type: 'jobs', jobs });
  res.json({ ok: true });
});

app.get('/api/reasons', (req, res) => res.json(reasons));
app.put('/api/reasons', (req, res) => {
  reasons = req.body.reasons;
  saveJSON(REASONS_FILE, reasons);
  broadcast({ type: 'reasons', reasons });
  res.json(reasons);
});

// ── METRICS ───────────────────────────────────────────────────────────────────
app.get('/api/metrics', (req, res) => {
  const now = new Date();
  const curMonth = monthKey(now);
  const rows = history.filter(h => h.month === curMonth);

  const fromSt = r => (r||'').split('-')[0].trim().toUpperCase();
  const toSt   = r => (r||'').split('-').slice(1).join('-').trim().toUpperCase();

  const total    = rows.length;
  const awbs     = new Set(rows.map(h => h.awb).filter(Boolean)).size;
  const aos      = rows.filter(h => h.type === 'AOS').length;
  const inbound  = rows.filter(h => fromSt(h.route) !== 'ATL' && toSt(h.route) === 'ATL').length;
  const sts      = rows.filter(h => fromSt(h.route) !== 'ATL' && toSt(h.route) !== 'ATL').length;
  const activeDays = new Set(rows.map(h => h.date)).size;

  const shiftNames = ['1st','2nd','3rd','WE 1st','WE 3rd'];
  const byShift = {};
  shiftNames.forEach(s => {
    const sr = rows.filter(h => h.shift === s);
    const days = {};
    sr.forEach(r => { days[r.date] = (days[r.date]||0) + 1; });
    let peakDay = null, peakCount = 0;
    Object.entries(days).forEach(([d,c]) => { if (c > peakCount) { peakCount=c; peakDay=d; } });
    byShift[s] = {
      total: sr.length,
      aos: sr.filter(r => r.type==='AOS').length,
      ron: sr.filter(r => r.type==='RON').length,
      activeDays: new Set(sr.map(r => r.date)).size,
      peakDay, peakCount
    };
  });

  res.json({
    monthLabel: now.toLocaleDateString('en-US', { month:'long', year:'numeric' }),
    total, awbs, aos, inbound, sts, activeDays, byShift
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ATL Dept 593 Live Board on port ${PORT}`));
