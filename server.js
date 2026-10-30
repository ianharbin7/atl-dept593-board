const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Bump this on every release. Open boards (like the TV) reload themselves when it changes.
const BUILD_ID = '2026-10-30.2';
const BOOT_ID = crypto.randomBytes(6).toString('hex');

// Everything about time on this board is Eastern (Atlanta), no matter where the server runs.
const TZ = 'America/New_York';

const app = express();
expressWs(app);

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Eastern-time helpers ──────────────────────────────────────────────────────
const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short'
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function etParts(d) {
  const p = {};
  etFmt.formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return { y: +p.year, mo: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute, dow: DOW[p.weekday] };
}

// Turn an Eastern wall-clock time into a real moment in time (handles daylight saving).
function etWallToEpoch(y, mo, d, h, mi) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = etParts(new Date(guess));
    guess += want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return guess;
}

const pad = n => String(n).padStart(2, '0');
const isoDate = (y, mo, d) => y + '-' + pad(mo) + '-' + pad(d);
function prevDay(y, mo, d) {
  const t = new Date(Date.UTC(y, mo - 1, d) - 86400000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// Shift windows (Eastern):
//   1st      Mon-Thu 6:00a-2:00p      2nd  Mon-Thu 2:00p-10:00p     3rd  Mon-Thu 10:00p-6:00a (next morning)
//   WE 1st   Fri-Sun 6:30a-6:30p      WE 3rd  Fri-Sun 6:30p-6:30a (next morning)
// Changeovers: Monday 6:00a belongs to Monday's 1st shift; Friday 6:00-6:30a (nobody scheduled) goes to WE 1st.
// shiftDate is the day the shift STARTED, so an overnight shift stays on one date.
function shiftFor(p) {
  const m = p.h * 60 + p.mi, dow = p.dow;
  let shift;
  if (dow === 1)               shift = m < 360 ? 'WE 3rd' : m < 840 ? '1st' : m < 1320 ? '2nd' : '3rd';
  else if (dow >= 2 && dow <= 4) shift = m < 360 ? '3rd'    : m < 840 ? '1st' : m < 1320 ? '2nd' : '3rd';
  else if (dow === 5)          shift = m < 360 ? '3rd'    : m < 1110 ? 'WE 1st' : 'WE 3rd';
  else                         shift = m < 390 ? 'WE 3rd' : m < 1110 ? 'WE 1st' : 'WE 3rd';
  const overnight = (shift === '3rd' || shift === 'WE 3rd') && m < 720;
  const sd = overnight ? prevDay(p.y, p.mo, p.d) : { y: p.y, mo: p.mo, d: p.d };
  return { shift, shiftDate: isoDate(sd.y, sd.mo, sd.d) };
}

// ── Persistent file storage ───────────────────────────────────────────────────
// Render's free tier only gives a temporary folder. Files survive normal operation but are
// wiped on every deploy/restart. The page itself keeps a copy and hands it back (see /api/restore).
const DATA_DIR     = process.env.DATA_DIR || '/tmp';
const DATA_FILE    = path.join(DATA_DIR, 'atl_jobs.json');
const HISTORY_FILE = path.join(DATA_DIR, 'atl_history.json');
const REASONS_FILE = path.join(DATA_DIR, 'atl_reasons.json');

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error('Load error', file, e.message); }
  return fallback;
}

function saveJSON(file, data) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) { console.error('Save error', file, e.message); }
}

// ── Job helpers ───────────────────────────────────────────────────────────────
const SHIFT_START = { '1st': [6, 0], '2nd': [14, 0], '3rd': [22, 0], 'WE 1st': [6, 30], 'WE 3rd': [18, 30] };

function legacyShiftDate(date) {
  const mm = /^(\d{1,2})\/(\d{1,2})$/.exec(date || '');
  const p = etParts(new Date());
  if (!mm) return isoDate(p.y, p.mo, p.d);
  const mo = +mm[1], d = +mm[2];
  const y = mo > p.mo + 1 ? p.y - 1 : p.y;
  return isoDate(y, mo, d);
}

function legacyAddedAt(j) {
  const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(j.shiftDate);
  const st = SHIFT_START[j.shift] || [12, 0];
  if (!mm) return new Date().toISOString();
  return new Date(etWallToEpoch(+mm[1], +mm[2], +mm[3], st[0], st[1])).toISOString();
}

// Accepts jobs from disk, or from an older version of the board, and fills in anything missing.
function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.id);
  if (!Number.isFinite(id)) return null;
  const s = v => (v == null ? '' : String(v).slice(0, 500));
  const j = {
    id, date: s(raw.date), shift: s(raw.shift), shiftDate: s(raw.shiftDate), addedAtISO: s(raw.addedAtISO),
    type: s(raw.type), route: s(raw.route), ac: s(raw.ac), flt: s(raw.flt), time: s(raw.time),
    gate: s(raw.gate), tail: s(raw.tail), awb: s(raw.awb), comments: s(raw.comments),
    isTest: !!raw.isTest, done: !!raw.done, transit: !!raw.transit,
    clearedBy: s(raw.clearedBy), clearedAt: s(raw.clearedAt), clearedAtISO: s(raw.clearedAtISO),
    key: s(raw.key), source: s(raw.source), origTime: s(raw.origTime), timeChangedAtISO: s(raw.timeChangedAtISO)
  };
  if (!j.shiftDate) j.shiftDate = legacyShiftDate(j.date);
  if (!j.addedAtISO) j.addedAtISO = legacyAddedAt(j);
  return j;
}

function historyEntry(j) {
  return {
    jobId: j.id, shiftDate: j.shiftDate, month: j.shiftDate.slice(0, 7), shift: j.shift, type: j.type,
    route: j.route, ac: j.ac, flt: j.flt, time: j.time, gate: j.gate, tail: j.tail, awb: j.awb,
    comments: j.comments, clearedBy: j.clearedBy, clearedAt: j.clearedAt, clearedAtISO: j.clearedAtISO
  };
}

// ── Load state from disk on startup ──────────────────────────────────────────
const bootedEmpty = !fs.existsSync(DATA_FILE) && !fs.existsSync(HISTORY_FILE);
let jobs    = loadJSON(DATA_FILE, []).map(normalizeJob).filter(Boolean);
let history = loadJSON(HISTORY_FILE, []);
const DEFAULT_REASONS = ['AOS', 'RON', 'LOAN', 'LOG', 'AOS LOAN', 'STS', 'ATS', 'STL', 'RTS'];
let reasons = loadJSON(REASONS_FILE, DEFAULT_REASONS.slice());
let lastId  = jobs.reduce((m, j) => Math.max(m, j.id), 0);

// Ids are time-based so a new shipment can never collide with one restored from a backup.
function nextId() { lastId = Math.max(lastId + 1, Date.now()); return lastId; }

// Every completed real shipment must have exactly one history record.
function ensureHistory() {
  const have = new Set(history.map(h => h.jobId));
  let changed = false;
  jobs.forEach(j => {
    if (j.done && !j.isTest && j.clearedBy !== 'Stood down' && !have.has(j.id)) { history.push(historyEntry(j)); have.add(j.id); changed = true; }
  });
  return changed;
}

// Completed shipments stay on the board's list for 36 hours (so Undo works), then live only in history.
function sweep() {
  const cutoff = Date.now() - 36 * 3600 * 1000;
  const before = jobs.length;
  jobs = jobs.filter(j => {
    if (!j.done) return true;
    const t = j.clearedAtISO ? Date.parse(j.clearedAtISO) : 0;
    return t >= cutoff;
  });
  return jobs.length !== before;
}

function persist() { saveJSON(DATA_FILE, jobs); saveJSON(HISTORY_FILE, history); }

if (ensureHistory() | sweep()) persist();
console.log(`Loaded ${jobs.length} jobs, ${history.length} history entries (booted empty: ${bootedEmpty})`);

// ── Connected WebSocket clients ───────────────────────────────────────────────
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(ws => { try { ws.send(data); } catch (e) {} });
}

// Only the last 120 days of history are sent to pages (they keep it as a backup copy).
function recentHistory() {
  const p = etParts(new Date(Date.now() - 120 * 86400000));
  const cut = isoDate(p.y, p.mo, p.d);
  return history.filter(h => h.shiftDate >= cut);
}
const broadcastJobs    = () => broadcast({ type: 'jobs', jobs });
const broadcastHistory = () => broadcast({ type: 'history', history: recentHistory() });

// ── WebSocket endpoint ────────────────────────────────────────────────────────
app.ws('/live', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: 'init', jobs, reasons, history: recentHistory(),
    fresh: bootedEmpty, bootId: BOOT_ID, build: BUILD_ID
  }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// Keep connections alive through Render's proxy.
setInterval(() => {
  clients.forEach(ws => { try { ws.ping(); } catch (e) { clients.delete(ws); } });
}, 25000).unref();

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

// Hourly housekeeping
setInterval(() => { if (sweep()) { persist(); broadcastJobs(); } }, 3600 * 1000).unref();

app.get('/ping', (req, res) => res.send('ok'));

// ── CT Hub numbers (/api/dashboard) ───────────────────────────────────────────
// The Tool Recovery workbook sends a summary of its numbers here; the CT Hub site shows them.
// Until the first push (and after every deploy wipes /tmp) the page falls back to
// the snapshot committed in public/dashboard/seed.json.
const DASH_FILE = path.join(DATA_DIR, 'atl_dashboard.json');
// The CT Hub site (a separate website) reads and updates these numbers, so allow it.
app.use('/api/dashboard', (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// The phone app (a separate site) updates shipments here, so let that site, and only that site, do it.
const APP_ORIGINS = ['https://atl-ct-hub.onrender.com'];
app.use('/api/jobs', (req, res, next) => {
  const o = req.get('Origin') || '';
  if (APP_ORIGINS.includes(o) || /^http:\/\/localhost(:\d+)?$/.test(o)) {
    res.set({ 'Access-Control-Allow-Origin': o, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/dashboard', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const d = JSON.parse(fs.readFileSync(DASH_FILE, 'utf8'));
    if (d && d.ct && d.atl) return res.json(d);
  } catch (e) {}
  try { return res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'dashboard', 'seed.json'), 'utf8'))); }
  catch (e) { return res.status(404).json({ error: 'no dashboard data' }); }
});
app.post('/api/dashboard', (req, res) => {
  const b = req.body || {};
  if (!b.ct || !b.atl || !b.all || typeof b.ct !== 'object' || !Array.isArray(b.ct.reasons) || !Array.isArray(b.atl.reasons)) {
    return res.status(400).json({ error: 'dashboard data needs ct, atl and all sections' });
  }
  const d = { asOf: String(b.asOf || new Date().toISOString()).slice(0, 40), ct: b.ct, atl: b.atl, all: b.all, trend: Array.isArray(b.trend) ? b.trend.slice(-400) : [] };
  const text = JSON.stringify(d);
  if (text.length > 300000) return res.status(413).json({ error: 'too large' });
  saveJSON(DASH_FILE, d);
  res.json({ ok: true });
});

// ── REST API ──────────────────────────────────────────────────────────────────
const timeNorm = t => { const s = String(t == null ? '' : t).replace(':', '').trim(); return s ? s.padStart(4, '0') : ''; };
const EDITABLE = ['type', 'route', 'ac', 'flt', 'time', 'gate', 'tail', 'awb', 'comments'];
const clean = v => (v == null ? '' : String(v).slice(0, 500));

app.post('/api/jobs', (req, res) => {
  const b = req.body || {};
  // A shipment sent from the turnover sheet may already be on the board (typed there first, or sent twice).
  // If so, fill in only what the board row is missing and never add a second row.
  const key = clean(b.key);
  if (key || b.source) {
    const route = clean(b.route).toUpperCase();
    const mine = awbTokens(b.awb);
    const same = jobs.find(j => (key && j.key === key) ||
      (!j.done && j.route === route && mine.length && awbTokens(j.awb).some(t => mine.includes(t))));
    if (same) {
      if (!same.done) ['ac', 'flt', 'time', 'awb'].forEach(k => { if (!same[k] && clean(b[k])) same[k] = clean(b[k]); });
      persist();
      broadcastJobs();
      return res.json(Object.assign({}, same, { duplicate: true }));
    }
  }
  const now = new Date();
  const p = etParts(now);
  const s = shiftFor(p);
  const job = {
    id: nextId(),
    date: p.mo + '/' + p.d,            // calendar date as entered (Eastern)
    shift: s.shift,                    // assigned here, by the server, from the Eastern clock
    shiftDate: s.shiftDate,            // the day this shift started
    addedAtISO: now.toISOString(),
    type: clean(b.type), route: clean(b.route).toUpperCase(),
    ac: clean(b.ac), flt: clean(b.flt), time: clean(b.time), gate: clean(b.gate),
    tail: clean(b.tail), awb: clean(b.awb), comments: clean(b.comments),
    isTest: !!b.isTest, done: false, transit: false,
    clearedBy: '', clearedAt: '', clearedAtISO: '',
    key: key, source: clean(b.source), origTime: '', timeChangedAtISO: ''
  };
  if (!job.type || !job.route) return res.status(400).json({ error: 'type and route are required' });
  if (fromSt(job.route) !== 'ATL' && toSt(job.route) !== 'ATL') return res.status(400).json({ error: 'one end of the route must be ATL' });
  jobs.push(job);
  persist();
  broadcastJobs();
  res.json(job);
});

app.put('/api/jobs/:id', (req, res) => {
  const j = jobs.find(x => x.id === Number(req.params.id));
  if (!j) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const prevTime = timeNorm(j.time);
  EDITABLE.forEach(k => { if (k in b) j[k] = k === 'route' ? clean(b[k]).toUpperCase() : clean(b[k]); });
  // Changing a flight time that was already set = a delay (or an earlier time). Remember the original
  // so the board can show "DELAYED +45m"; changing it back to the original clears the tag.
  const newTime = timeNorm(j.time);
  if (prevTime && newTime !== prevTime) {
    if (!j.origTime) j.origTime = prevTime;
    if (newTime === timeNorm(j.origTime)) { j.origTime = ''; j.timeChangedAtISO = ''; }
    else j.timeChangedAtISO = new Date().toISOString();
  }
  const h = history.find(x => x.jobId === j.id);
  if (h) EDITABLE.forEach(k => { if (k in h) h[k] = j[k]; });
  persist();
  broadcastJobs();
  res.json(j);
});

app.post('/api/jobs/:id/done', (req, res) => {
  const j = jobs.find(x => x.id === Number(req.params.id));
  if (!j) return res.status(404).json({ error: 'not found' });
  const now = new Date();
  const p = etParts(now);
  j.done = true;
  j.transit = false;
  j.clearedBy = clean((req.body || {}).label) || 'Done';
  j.clearedAt = pad(p.h) + ':' + pad(p.mi);   // Eastern
  j.clearedAtISO = now.toISOString();

  // One history record per shipment, no matter how many times Done/Undo is clicked.
  history = history.filter(h => h.jobId !== j.id);
  if (!j.isTest && j.clearedBy !== 'Stood down') history.push(historyEntry(j));

  sweep();
  persist();
  broadcastJobs();
  broadcastHistory();
  res.json(j);
});

app.post('/api/jobs/:id/transit', (req, res) => {
  const j = jobs.find(x => x.id === Number(req.params.id));
  if (!j) return res.status(404).json({ error: 'not found' });
  j.transit = !j.transit;
  persist();
  broadcastJobs();
  res.json(j);
});

app.post('/api/jobs/:id/undo', (req, res) => {
  const j = jobs.find(x => x.id === Number(req.params.id));
  if (!j) return res.status(404).json({ error: 'not found' });
  j.done = false; j.transit = false; j.clearedBy = ''; j.clearedAt = ''; j.clearedAtISO = '';
  history = history.filter(h => h.jobId !== j.id);   // un-counts it from the metrics
  persist();
  broadcastJobs();
  broadcastHistory();
  res.json(j);
});

app.delete('/api/jobs/:id', (req, res) => {
  const id = Number(req.params.id);
  jobs = jobs.filter(j => j.id !== id);
  history = history.filter(h => h.jobId !== id);
  persist();
  broadcastJobs();
  broadcastHistory();
  res.json({ ok: true });
});

app.get('/api/reasons', (req, res) => res.json(reasons));
app.put('/api/reasons', (req, res) => {
  const list = (req.body || {}).reasons;
  if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'reasons must be a list' });
  reasons = list.map(clean).filter(Boolean);
  saveJSON(REASONS_FILE, reasons);
  broadcast({ type: 'reasons', reasons });
  res.json(reasons);
});

// ── Restore after a restart ───────────────────────────────────────────────────
// When the server starts with no saved files (every deploy on Render's free tier), any open page
// that still holds a recent copy hands it back here. It only ever ADDS missing records.
app.post('/api/restore', (req, res) => {
  if (!bootedEmpty) return res.status(409).json({ error: 'server did not start empty; nothing to restore' });
  const b = req.body || {};
  const haveJob = new Set(jobs.map(j => j.id));
  let addedJobs = 0, addedHistory = 0;

  (Array.isArray(b.jobs) ? b.jobs : []).forEach(raw => {
    const j = normalizeJob(raw);
    if (j && !haveJob.has(j.id)) { jobs.push(j); haveJob.add(j.id); addedJobs++; lastId = Math.max(lastId, j.id); }
  });
  const haveHist = new Set(history.map(h => h.jobId));
  (Array.isArray(b.history) ? b.history : []).forEach(h => {
    if (h && h.jobId != null && h.shiftDate && !haveHist.has(h.jobId)) {
      history.push(h); haveHist.add(h.jobId); addedHistory++;
    }
  });
  if (Array.isArray(b.reasons) && b.reasons.length && JSON.stringify(reasons) === JSON.stringify(DEFAULT_REASONS)) {
    reasons = b.reasons.map(clean).filter(Boolean);
    saveJSON(REASONS_FILE, reasons);
    broadcast({ type: 'reasons', reasons });
  }
  const histBefore = history.length;
  ensureHistory();
  addedHistory += history.length - histBefore;
  history.sort((a, c) => (a.jobId > c.jobId ? 1 : -1));
  sweep();
  persist();
  broadcastJobs();
  broadcastHistory();
  console.log(`Restore: +${addedJobs} jobs, +${addedHistory} history`);
  res.json({ ok: true, addedJobs, jobs: jobs.length, history: history.length });
});

// ── METRICS ───────────────────────────────────────────────────────────────────
const fromSt = r => (r || '').split('-')[0].trim().toUpperCase();
const toSt   = r => (r || '').split('-').slice(1).join('-').trim().toUpperCase();

// Counts every AWB number in the field, so "0610/0611" is two AWBs and "CHARTER" is none.
function awbTokens(v) {
  return String(v || '').split(/[\s,\/;]+/).filter(t => (t.match(/\d/g) || []).length >= 6);
}

function computeMetrics(allRows) {
  // Station-to-station moves are not tracked on this board.
  const rows = allRows.filter(h => fromSt(h.route) === 'ATL' || toSt(h.route) === 'ATL');
  const total    = rows.length;
  const awbs     = new Set(rows.flatMap(h => awbTokens(h.awb))).size;
  const aos      = rows.filter(h => h.type === 'AOS').length;
  const outbound = rows.filter(h => fromSt(h.route) === 'ATL').length;
  const inbound  = rows.filter(h => fromSt(h.route) !== 'ATL' && toSt(h.route) === 'ATL').length;
  const sts      = rows.filter(h => fromSt(h.route) !== 'ATL' && toSt(h.route) !== 'ATL').length;
  const activeDays = new Set(rows.map(h => h.shiftDate)).size;

  const byShift = {};
  ['1st', '2nd', '3rd', 'WE 1st', 'WE 3rd'].forEach(sh => {
    const sr = rows.filter(h => h.shift === sh);
    const days = {};
    sr.forEach(r => { days[r.shiftDate] = (days[r.shiftDate] || 0) + 1; });
    let peakDay = null, peakCount = 0;
    Object.entries(days).forEach(([d, c]) => { if (c > peakCount) { peakCount = c; peakDay = d; } });
    byShift[sh] = {
      total: sr.length,
      aos: sr.filter(r => r.type === 'AOS').length,
      ron: sr.filter(r => r.type === 'RON').length,
      activeDays: new Set(sr.map(r => r.shiftDate)).size,
      peakDay, peakCount
    };
  });
  return { total, awbs, aos, outbound, inbound, sts, activeDays, byShift };
}

function monthParam(q) {
  if (/^\d{4}-\d{2}$/.test(q || '')) return q;
  const p = etParts(new Date());
  return p.y + '-' + pad(p.mo);
}

app.get('/api/metrics', (req, res) => {
  const month = monthParam(req.query.month);
  const rows = history.filter(h => h.month === month);
  const [y, m] = month.split('-').map(Number);
  const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  res.json({ monthLabel, month, ...computeMetrics(rows) });
});

// One row per completed shipment, for Excel (Data > From Web / Text) or for saving a month's record.
const CSV_COLS = [
  ['Shift Date', 'shiftDate'], ['Shift', 'shift'], ['Reason', 'type'], ['Route', 'route'],
  ['A/C', 'ac'], ['Flight', 'flt'], ['ETD/ETA', 'time'], ['Gate', 'gate'], ['Tail', 'tail'],
  ['AWB', 'awb'], ['Comments', 'comments'], ['Cleared By', 'clearedBy'], ['Cleared At (ET)', 'clearedAt']
];
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
app.get('/api/export.csv', (req, res) => {
  const month = monthParam(req.query.month);
  const rows = history.filter(h => h.month === month)
    .sort((a, b) => (a.shiftDate + (a.clearedAtISO || '')).localeCompare(b.shiftDate + (b.clearedAtISO || '')));
  const lines = [CSV_COLS.map(c => c[0]).join(',')]
    .concat(rows.map(r => CSV_COLS.map(c => csvCell(r[c[1]])).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="board-${month}.csv"`);
  res.send('\ufeff' + lines.join('\r\n') + '\r\n');
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`ATL Dept 593 Live Board on port ${PORT}`));
}
module.exports = { app, etParts, etWallToEpoch, shiftFor, computeMetrics, awbTokens, normalizeJob };
