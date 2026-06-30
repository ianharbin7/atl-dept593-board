const express = require('express');
const expressWs = require('express-ws');
const path = require('path');

const app = express();
expressWs(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory store (persists as long as server is running) ─────────────────
let jobs = [];
let nextId = 1;
let reasons = ['AOS','RON','LOAN','LOG','AOS LOAN','STS','ATS','STL','RTS'];

// ── Connected WebSocket clients ──────────────────────────────────────────────
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(ws => { try { ws.send(data); } catch(e) {} });
}

// ── WebSocket endpoint ───────────────────────────────────────────────────────
app.ws('/live', (ws) => {
  clients.add(ws);
  // Send current state immediately on connect
  ws.send(JSON.stringify({ type: 'init', jobs, reasons }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ── REST API ─────────────────────────────────────────────────────────────────
// Add job
app.post('/api/jobs', (req, res) => {
  const job = { id: nextId++, ...req.body, done: false, transit: false, clearedBy: '', clearedAt: '' };
  jobs.push(job);
  broadcast({ type: 'jobs', jobs });
  res.json(job);
});

// Update job (edit fields)
app.put('/api/jobs/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  jobs[idx] = { ...jobs[idx], ...req.body };
  broadcast({ type: 'jobs', jobs });
  res.json(jobs[idx]);
});

// Mark done
app.post('/api/jobs/:id/done', (req, res) => {
  const id = parseInt(req.params.id);
  const j = jobs.find(x => x.id === id);
  if (!j) return res.status(404).json({ error: 'not found' });
  j.done = true;
  j.transit = false;
  j.clearedBy = req.body.label || 'Done';
  const n = new Date();
  j.clearedAt = String(n.getHours()).padStart(2,'0') + ':' + String(n.getMinutes()).padStart(2,'0');
  broadcast({ type: 'jobs', jobs });
  res.json(j);
});

// Mark in transit
app.post('/api/jobs/:id/transit', (req, res) => {
  const id = parseInt(req.params.id);
  const j = jobs.find(x => x.id === id);
  if (!j) return res.status(404).json({ error: 'not found' });
  j.transit = !j.transit; // toggle
  broadcast({ type: 'jobs', jobs });
  res.json(j);
});

// Undo done
app.post('/api/jobs/:id/undo', (req, res) => {
  const id = parseInt(req.params.id);
  const j = jobs.find(x => x.id === id);
  if (!j) return res.status(404).json({ error: 'not found' });
  j.done = false; j.transit = false; j.clearedBy = ''; j.clearedAt = '';
  broadcast({ type: 'jobs', jobs });
  res.json(j);
});

// Delete job
app.delete('/api/jobs/:id', (req, res) => {
  jobs = jobs.filter(j => j.id !== parseInt(req.params.id));
  broadcast({ type: 'jobs', jobs });
  res.json({ ok: true });
});

// Reasons
app.get('/api/reasons', (req, res) => res.json(reasons));
app.put('/api/reasons', (req, res) => {
  reasons = req.body.reasons;
  broadcast({ type: 'reasons', reasons });
  res.json(reasons);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ATL Dept 593 Live Board running on port ${PORT}`));
