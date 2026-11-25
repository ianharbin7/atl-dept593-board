const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Bump this on every release. Open boards (like the TV) reload themselves when it changes.
const BUILD_ID = '2026-10-30.3';
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
//   WE 1st   Fri-Sun 6:00a-6:00p      WE 3rd  Fri-Sun 6:00p-6:00a (next morning)   (weekend times changed from 6:30 on 11/05/26)
// Changeovers: Monday 6:00a belongs to Monday's 1st shift.
// shiftDate is the day the shift STARTED, so an overnight shift stays on one date.
function shiftFor(p) {
  const m = p.h * 60 + p.mi, dow = p.dow;
  let shift;
  if (dow === 1)               shift = m < 360 ? 'WE 3rd' : m < 840 ? '1st' : m < 1320 ? '2nd' : '3rd';
  else if (dow >= 2 && dow <= 4) shift = m < 360 ? '3rd'    : m < 840 ? '1st' : m < 1320 ? '2nd' : '3rd';
  else if (dow === 5)          shift = m < 360 ? '3rd'    : m < 1080 ? 'WE 1st' : 'WE 3rd';
  else                         shift = m < 360 ? 'WE 3rd' : m < 1080 ? 'WE 1st' : 'WE 3rd';
  const overnight = (shift === '3rd' || shift === 'WE 3rd') && m < 720;
  const sd = overnight ? prevDay(p.y, p.mo, p.d) : { y: p.y, mo: p.mo, d: p.d };
  return { shift, shiftDate: isoDate(sd.y, sd.mo, sd.d) };
}

// ── Persistent file storage ───────────────────────────────────────────────────
// Render's free tier only gives a temporary folder. Files survive normal operation but are
// wiped on every deploy/restart. The page itself keeps a copy and hands it back (see /api/restore).
const DATA_DIR     = process.env.DATA_DIR || '/tmp';
const DATA_FILE    = path.join(DATA_DIR, 'atl_jobs.json');
const HELD_FILE    = path.join(DATA_DIR, 'atl_held.json');
const DUE_FILE     = path.join(DATA_DIR, 'atl_due.json');
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
const SHIFT_START = { '1st': [6, 0], '2nd': [14, 0], '3rd': [22, 0], 'WE 1st': [6, 0], 'WE 3rd': [18, 0] };

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

// ── Held (later-date) shipments ──────────────────────────────────────────────
// A shipment typed for a later day waits here, off the board. It moves onto the board by itself
// HOLD_LEAD_HOURS before it is due (or at 6:00 AM Eastern on its day when no time was given).
// It is kept apart from `jobs` on purpose, so nothing that reads the board's list can count it early.
const HOLD_LEAD_HOURS = 6;
let held = loadJSON(HELD_FILE, []).map(normalizeHeld).filter(Boolean);
function holdTimes(holdDate, time) {
  const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(holdDate || '');
  if (!mm) return null;
  const t = timeNorm(time), hasTime = /^\d{4}$/.test(t);
  const h = hasTime ? +t.slice(0, 2) : 12, mi = hasTime ? +t.slice(2) : 0;
  if (h > 23 || mi > 59) return null;
  const dueMs = etWallToEpoch(+mm[1], +mm[2], +mm[3], h, mi);
  const showMs = hasTime ? dueMs - HOLD_LEAD_HOURS * 3600 * 1000 : etWallToEpoch(+mm[1], +mm[2], +mm[3], 6, 0);
  return { dueISO: new Date(dueMs).toISOString(), showAtISO: new Date(showMs).toISOString(), hasTime };
}
// A short record of every later-date shipment, kept after it moves onto the board, so the turnover sheet's
// "DUE TODAY" note can list it on the day it is due. Removed if the shipment is removed from Upcoming.
let dueLog = loadJSON(DUE_FILE, []).filter(d => d && d.dueISO);
// One record per later-date shipment (matched by key). It can come from the board push, from the turnover sheet's own
// "save this hold" call, or both - they are merged. `form` is the sheet's saved form (used to fill the turnover rows).
function upsertDue(h) {
  const cut = (v, n) => (v == null ? '' : String(v).slice(0, n));
  const key = cut(h.key, 300);
  let d = dueLog.find(x => (key && x.key === key) || (h.id && x.id === h.id));
  if (!d) { d = { id: 0, key: '' }; dueLog.push(d); }
  if (h.id) d.id = h.id;
  if (key) d.key = key;
  ['type', 'route', 'flt', 'time', 'awb', 'comments', 'holdDate', 'dueISO'].forEach(k => { if (h[k] != null && h[k] !== '') d[k] = cut(h[k], 500); });
  if (h.form) d.form = cut(h.form, 6000);
  if (h.section) d.section = cut(h.section, 8);
  return d;
}
function ensureDue(h) { upsertDue(h); }
// the operating day runs 6:00 AM to 6:00 AM Eastern (same as the turnover sheet), so 2:00 AM belongs to the day before
function opDate(iso) {
  const p = etParts(new Date(iso));
  const q = p.h < 6 ? prevDay(p.y, p.mo, p.d) : { y: p.y, mo: p.mo, d: p.d };
  return isoDate(q.y, q.mo, q.d);
}
held.forEach(ensureDue);
function normalizeHeld(raw) {
  const j = normalizeJob(raw);
  if (!j) return null;
  const sc = v => (v == null ? '' : String(v).slice(0, 40));
  j.holdDate = sc(raw.holdDate); j.dueISO = sc(raw.dueISO); j.showAtISO = sc(raw.showAtISO);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(j.holdDate) || !j.showAtISO) return null;
  return j;
}
const DEFAULT_REASONS = ['AOS', 'RON', 'LOAN', 'LOG', 'AOS LOAN', 'STS', 'ATS', 'STL', 'RTS'];
let reasons = loadJSON(REASONS_FILE, DEFAULT_REASONS.slice());
let lastId  = Math.max(jobs.reduce((m, j) => Math.max(m, j.id), 0), held.reduce((m, j) => Math.max(m, j.id), 0));

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

function persist() { saveJSON(DATA_FILE, jobs); saveJSON(HISTORY_FILE, history); saveJSON(HELD_FILE, held); saveJSON(DUE_FILE, dueLog); }

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
const broadcastHeld    = () => broadcast({ type: 'held', held });
const broadcastHistory = () => broadcast({ type: 'history', history: recentHistory() });

// ── WebSocket endpoint ────────────────────────────────────────────────────────
app.ws('/live', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: 'init', jobs, held, reasons, history: recentHistory(),
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

// Move held shipments onto the board when their time comes (checked every 30 seconds).
function promoteHeld(force) {
  const now = Date.now(); let moved = 0;
  held = held.filter(h => {
    if (!force && Date.parse(h.showAtISO) > now) return true;
    const d = new Date(), p = etParts(d), s = shiftFor(p);
    const j = Object.assign({}, h);
    delete j.holdDate; delete j.dueISO; delete j.showAtISO;
    j.date = p.mo + '/' + p.d; j.shift = s.shift; j.shiftDate = s.shiftDate; j.addedAtISO = d.toISOString();
    jobs.push(j); moved++;
    return false;
  });
  if (moved) { persist(); broadcastJobs(); broadcastHeld(); }
  return moved;
}
setInterval(() => promoteHeld(false), 30 * 1000).unref();
promoteHeld(false);

// Hourly housekeeping
setInterval(() => {
  const keep = Date.now() - 3 * 86400000, n = dueLog.length;
  dueLog = dueLog.filter(d => Date.parse(d.dueISO) >= keep);
  if (sweep() || dueLog.length !== n) { persist(); broadcastJobs(); }
}, 3600 * 1000).unref();

// ── Dangerous goods (DG) ─────────────────────────────────────────────────────
// feed:   today's DG tool list from Tool Recovery (TAB lines: toolId, mpn, description, DG note, battery info). Replaced whole each day.
// parked: DG shipments taken to the DG group and waiting for their booking; every shift's workbook lists them until someone finishes them.
const DGFEED_FILE = path.join(DATA_DIR, 'atl_dgfeed.tsv'), DGPARK_FILE = path.join(DATA_DIR, 'atl_dgpark.json');
let dgFeed = ''; try { dgFeed = fs.readFileSync(DGFEED_FILE, 'utf8'); } catch (e) {}
let dgPark = loadJSON(DGPARK_FILE, []).filter(p => p && p.id != null);
const dgSave = () => saveJSON(DGPARK_FILE, dgPark);
app.post('/api/dg/feed', express.text({ limit: '40mb', type: '*/*' }), (req, res) => {
  const t = typeof req.body === 'string' ? req.body : '';
  if (!t.trim()) return res.status(400).json({ error: 'empty feed' });
  dgFeed = t;
  try { fs.writeFileSync(DGFEED_FILE, dgFeed); } catch (e) { console.error('dg feed save', e.message); }
  res.json({ ok: true, lines: dgFeed.split('\n').filter(Boolean).length });
});
app.get('/api/dg/feed', (req, res) => { res.type('text/plain; charset=utf-8').send(dgFeed); });

app.post('/api/dg/park', (req, res) => {
  const b = req.body || {};
  if (!clean(b.route)) return res.status(400).json({ error: 'route is required' });
  const id = dgPark.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0) + 1;
  const p = { id, createdISO: new Date().toISOString(), route: clean(b.route).toUpperCase(), reason: clean(b.reason), tools: String(b.tools == null ? '' : b.tools).slice(0, 500),
    by: clean(b.by), shift: clean(b.shift), note: clean(b.note), form: String(b.form == null ? '' : b.form).slice(0, 8000) };
  dgPark.push(p); dgSave();
  res.json({ ok: true, id });
});
// TAB lines:  id, parked-at (ET), note line, form
app.get('/api/dg/parked', (req, res) => {
  const cf = v => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
  const out = dgPark.map(p => {
    const pt = etParts(new Date(p.createdISO));
    const hh = ((pt.h + 11) % 12) + 1, ap = pt.h >= 12 ? 'p' : 'a';
    const line = 'AT DG - AWAITING BOOKING:  ' + p.route.replace('-', ' to ') + (p.reason ? '  ' + p.reason : '') + '  |  ' + p.tools +
      '  |  to DG ' + pt.mo + '/' + pt.d + ' ' + hh + ':' + pad(pt.mi) + ap + (p.by ? ' by ' + p.by : '') + (p.note ? '  |  NOTE: ' + p.note : '');
    return [p.id, etStamp(Date.parse(p.createdISO)), line, p.form].map(cf).join('\t');
  });
  res.type('text/plain; charset=utf-8').send(out.join('\n'));
});
app.delete('/api/dg/park/:id', (req, res) => {
  const n = dgPark.length; dgPark = dgPark.filter(p => String(p.id) !== String(req.params.id));
  if (dgPark.length === n) return res.status(404).json({ error: 'not found' });
  dgSave(); res.json({ ok: true });
});
// weight / dimensions per MPN, learned from the DG paperwork so the next one fills in by itself
const DGSPEC_FILE = path.join(DATA_DIR, 'atl_dgspecs.json');
let dgSpecs = loadJSON(DGSPEC_FILE, {}); if (!dgSpecs || typeof dgSpecs !== 'object' || Array.isArray(dgSpecs)) dgSpecs = {};
app.post('/api/dg/specs', (req, res) => {
  const b = req.body || {}, k = clean(b.mpn).toUpperCase();
  if (!k) return res.status(400).json({ error: 'mpn is required' });
  dgSpecs[k] = { weight: clean(b.weight).slice(0, 30), dims: clean(b.dims).slice(0, 60), updISO: new Date().toISOString() };
  saveJSON(DGSPEC_FILE, dgSpecs); res.json({ ok: true });
});
app.get('/api/dg/specs', (req, res) => {
  const cf = v => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
  res.type('text/plain; charset=utf-8').send(Object.keys(dgSpecs).map(k => [k, dgSpecs[k].weight, dgSpecs[k].dims].map(cf).join('\t')).join('\n'));
});
setInterval(() => { const keep = Date.now() - 7 * 86400000, n = dgPark.length; dgPark = dgPark.filter(p => Date.parse(p.createdISO) >= keep); if (dgPark.length !== n) dgSave(); }, 3600 * 1000).unref();

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
  if (b.x && typeof b.x === 'object' && !Array.isArray(b.x)) d.x = b.x;   // extra detail for the wall (shipments, goals, tool-room activity)
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
  // A later-date shipment (holdDate = YYYY-MM-DD, Eastern) waits off the board until HOLD_LEAD_HOURS before it is due.
  const holdDate = clean(b.holdDate);
  if (holdDate) {
    const ht = holdTimes(holdDate, job.time);
    if (!ht) return res.status(400).json({ error: 'holdDate should look like 2026-11-14' });
    if (Date.parse(ht.showAtISO) > Date.now()) {
      const dupe = held.find(h => (key && h.key === key) || (h.route === job.route && h.holdDate === holdDate && awbTokens(h.awb).length && awbTokens(h.awb).some(t => awbTokens(job.awb).includes(t))));
      if (dupe) return res.json(Object.assign({}, dupe, { duplicate: true, held: true }));
      job.time = timeNorm(job.time);
      Object.assign(job, { holdDate, dueISO: ht.dueISO, showAtISO: ht.showAtISO });
      held.push(job);
      ensureDue(job);
      persist();
      broadcastHeld();
      return res.json(Object.assign({}, job, { held: true }));
    }
    // already inside the lead window: fall through and put it on the board now
  }
  jobs.push(job);
  persist();
  broadcastJobs();
  res.json(job);
});

// Held shipments: bring one onto the board now, or take it off the list.
app.post('/api/held/:id/release', (req, res) => {
  const h = held.find(x => x.id === Number(req.params.id));
  if (!h) return res.status(404).json({ error: 'not found' });
  h.showAtISO = new Date(0).toISOString();
  promoteHeld(false);
  res.json({ ok: true });
});
app.delete('/api/held/:id', (req, res) => {
  const n = held.length;
  const hh = held.find(x => x.id === Number(req.params.id));
  dueLog = dueLog.filter(x => x.id !== Number(req.params.id) && !(hh && hh.key && x.key === hh.key));
  held = held.filter(x => x.id !== Number(req.params.id));
  if (held.length === n) return res.status(404).json({ error: 'not found' });
  persist(); broadcastHeld();
  res.json({ ok: true });
});
app.get('/api/held', (req, res) => res.json(held));

// The turnover sheet saves every later-date shipment here (even when it is NOT going on the Live Board),
// so every shift's workbook can list it, and the shift it arrives on can fill it in as a real row.
app.post('/api/holds/record', (req, res) => {
  const b = req.body || {};
  const holdDate = clean(b.holdDate), time = timeNorm(b.time);
  const ht = holdTimes(holdDate, time);
  if (!ht) return res.status(400).json({ error: 'holdDate should look like 2026-11-14' });
  if (!clean(b.key) || !clean(b.route)) return res.status(400).json({ error: 'key and route are required' });
  const d = upsertDue({ key: clean(b.key), type: clean(b.type), route: clean(b.route).toUpperCase(), flt: clean(b.flt), time, awb: clean(b.awb),
    comments: clean(b.comments), holdDate, dueISO: ht.dueISO, form: String(b.form == null ? '' : b.form).slice(0, 6000), section: clean(b.section) });
  cancelledHolds = cancelledHolds.filter(c => c.key !== d.key);      // entered again on purpose: it is no longer cancelled
  persist();
  res.json({ ok: true, id: d.id });
});

// ── Cancel a later-date shipment ─────────────────────────────────────────────
// /api/holds/list      TAB lines for the turnover sheet's cancel list:  key, line, route, awb, flight
// /api/holds/cancel    POST {key}: takes it off the hold list AND the held part of the board, and remembers it for 7 days
// /api/holds/cancelled TAB lines (route, awb, flight): every shift's sheet uses this to drop its own copy of the Notes line
// (a shipment already on the board itself is removed with the board's own delete)
let cancelledHolds = [];
const DOW3 = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
app.get('/api/holds/list', (req, res) => {
  const cf = v => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
  const rows = dueLog.filter(d => d.key).slice().sort((a, b) => Date.parse(a.dueISO) - Date.parse(b.dueISO)).map(d => {
    const tm = timeNorm(d.time), hasT = /^\d{4}$/.test(tm);
    const hd = /^\d{4}-\d{2}-\d{2}$/.test(d.holdDate || '') ? d.holdDate : opDate(d.dueISO);
    const dow = DOW3[new Date(Date.UTC(+hd.slice(0, 4), +hd.slice(5, 7) - 1, +hd.slice(8, 10))).getUTCDay()];
    const cm = String(d.comments || '').replace(/\s*\|\s*NOTE:\s*/i, '  |  NOTE: ');
    const line = dow + ' ' + (+hd.slice(5, 7)) + '/' + (+hd.slice(8, 10)) + (hasT ? ' ' + tm.slice(0, 2) + ':' + tm.slice(2) : '') + '   ' + d.route +
      (d.flt ? '  FLT ' + d.flt : '') + (d.awb ? '  AWB ' + d.awb : '') + (cm ? '  |  ' + cm : '');
    return [d.key, line.slice(0, 260), d.route || '', d.awb || '', d.flt || ''].map(cf).join('\t');
  });
  res.type('text/plain; charset=utf-8').send(rows.join('\n'));
});
app.post('/api/holds/cancel', (req, res) => {
  const key = clean((req.body || {}).key);
  if (!key) return res.status(400).json({ error: 'key is required' });
  const d = dueLog.find(x => x.key === key), h = held.find(x => x.key === key);
  const n1 = dueLog.length, n2 = held.length;
  dueLog = dueLog.filter(x => x.key !== key);
  held = held.filter(x => x.key !== key);
  const src = d || h;
  if (src) cancelledHolds.push({ key, route: src.route || '', awb: src.awb || '', flt: src.flt || '', atMs: Date.now() });
  if (dueLog.length === n1 && held.length === n2) return res.status(404).json({ error: 'not found' });
  persist(); broadcastHeld();
  res.json({ ok: true, removedDue: n1 - dueLog.length, removedHeld: n2 - held.length });
});
app.get('/api/holds/cancelled', (req, res) => {
  const keep = Date.now() - 7 * 86400000;
  cancelledHolds = cancelledHolds.filter(c => c.atMs >= keep);
  const cf = v => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
  res.type('text/plain; charset=utf-8').send(cancelledHolds.map(c => [c.route, c.awb, c.flt].map(cf).join('\t')).join('\n'));
});

// Plain-text list for the turnover workbook: everything pending from one operating day on.
// One line per shipment, fields separated by TAB:  placeET, opDate, note line, section, form
const etStamp = ms => { const p = etParts(new Date(ms)); return isoDate(p.y, p.mo, p.d) + ' ' + pad(p.h) + ':' + pad(p.mi); };
app.get('/api/pending', (req, res) => {
  const from = String(req.query.from || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return res.status(400).send('from should look like 2026-11-14');
  const cleanF = v => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
  const rows = dueLog.map(d => {
    const tm = timeNorm(d.time), hasT = /^\d{4}$/.test(tm);
    const od = opDate(d.dueISO);
    const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.holdDate || '');
    const placeMs = hasT ? Date.parse(d.dueISO) : (mm ? etWallToEpoch(+mm[1], +mm[2], +mm[3], 6, 0) : Date.parse(d.dueISO));
    const cm = String(d.comments || '').replace(/\s*\|\s*NOTE:\s*/i, '  |  NOTE: ');
    const when = hasT ? tm.slice(0, 2) + ':' + tm.slice(2) : '(no time)';
    const hd = d.holdDate || od, mo = hd.slice(5, 7).replace(/^0/, ''), dy = hd.slice(8, 10).replace(/^0/, '');   // the real calendar date it is due
    const dowN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date(Date.UTC(+hd.slice(0, 4), +hd.slice(5, 7) - 1, +hd.slice(8, 10))).getUTCDay()];
    const fm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from), tmr = fm ? new Date(Date.UTC(+fm[1], +fm[2] - 1, +fm[3] + 1)).toISOString().slice(0, 10) : '';
    const pre = od === from ? 'DUE TODAY ' + when : (/-ATL$/i.test(d.route || '') ? 'TOOLING COMING IN ' : 'TOOLING GOING OUT ') + (hd === tmr ? 'TOMORROW (' + dowN + ' ' + mo + '/' + dy + ')' : dowN + ' ' + mo + '/' + dy) + ' ' + when;
    const line = pre + ':  ' + d.route + (d.flt ? '  FLT ' + d.flt : '') + (d.awb ? '  AWB ' + d.awb : '') + (d.type ? '  |  ' + d.type : '') + (cm ? '  |  ' + cm : '');
    return { placeMs, od, line: line.slice(0, 400), section: d.section || '', form: d.form || '' };
  }).filter(r => r.od >= from).sort((a, b) => a.placeMs - b.placeMs);
  res.type('text/plain').send(rows.map(r => [etStamp(r.placeMs), r.od, cleanF(r.line), r.section, cleanF(r.form)].join('\t')).join('\n'));
});

// What is due on one operating day (YYYY-MM-DD): one ready-to-write line each, for the turnover sheet's Notes.
app.get('/api/due', (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date should look like 2026-11-14' });
  const items = dueLog.filter(d => opDate(d.dueISO) === date).sort((a, b) => Date.parse(a.dueISO) - Date.parse(b.dueISO)).map(d => {
    const tm = timeNorm(d.time), hasT = /^\d{4}$/.test(tm);
    const cm = String(d.comments || '').replace(/\s*\|\s*NOTE:\s*/i, '  |  NOTE: ');
    const line = 'DUE TODAY ' + (hasT ? tm.slice(0, 2) + ':' + tm.slice(2) : '(no time)') + ':  ' + d.route +
      (d.flt ? '  FLT ' + d.flt : '') + (d.awb ? '  AWB ' + d.awb : '') + (d.type ? '  |  ' + d.type : '') + (cm ? '  |  ' + cm : '');
    return { id: d.id, line: line.slice(0, 400) };
  });
  res.json(items);
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
  const haveHeld = new Set(held.map(h => h.id).concat(jobs.map(j => j.id)));
  (Array.isArray(b.held) ? b.held : []).forEach(raw => {
    const h = normalizeHeld(raw);
    if (h && !haveHeld.has(h.id)) { held.push(h); ensureDue(h); haveHeld.add(h.id); lastId = Math.max(lastId, h.id); }
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
  broadcastHeld();
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
