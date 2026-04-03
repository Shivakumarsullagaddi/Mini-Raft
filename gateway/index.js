const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const REPLICA_URLS = (process.env.REPLICAS || '').split(',').filter(Boolean);
const REPLICA_MAP = {};
REPLICA_URLS.forEach(url => {
  const id = url.split('//')[1].split(':')[0];
  REPLICA_MAP[id] = url;
});

const PORT = process.env.PORT || 3000;
let currentLeaderUrl = null;
let currentLeaderTerm = -1;
const clients = new Set();

function log_gw(msg) { console.log(`[GATEWAY] ${msg}`); }

async function discoverLeader() {
  for (const url of REPLICA_URLS) {
    try {
      const res = await axios.get(`${url}/status`, { timeout: 500 });
      const { state, term } = res.data;
      if (state === 'LEADER' && term >= currentLeaderTerm) {
        currentLeaderUrl = url;
        currentLeaderTerm = term;
        log_gw(`Leader: ${res.data.id} (term ${term})`);
        return;
      }
    } catch {}
  }
}

setInterval(async () => { if (!currentLeaderUrl) await discoverLeader(); }, 1000);

app.post('/leader-update', (req, res) => {
  const { leaderId, leaderUrl, term } = req.body;
  if (term >= currentLeaderTerm) {
    currentLeaderUrl = leaderUrl;
    currentLeaderTerm = term;
    log_gw(`Leader updated: ${leaderId} (term ${term})`);
  }
  res.json({ ok: true });
});

app.get('/gateway-status', async (req, res) => {
  const replicas = await Promise.all(REPLICA_URLS.map(async (url) => {
    try {
      const r = await axios.get(`${url}/status`, { timeout: 500 });
      return r.data;
    } catch {
      const id = url.split('//')[1].split(':')[0];
      return { id, state: 'OFFLINE', term: 0, logLength: 0, commitIndex: -1, partitioned: false };
    }
  }));
  res.json({ leaderUrl: currentLeaderUrl, term: currentLeaderTerm, clients: clients.size, replicas });
});

app.post('/broadcast', (req, res) => {
  const event = req.body;
  const msg = JSON.stringify(event);
  let count = 0;
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) { c.send(msg); count++; }
  }
  res.json({ ok: true, delivered: count });
});

app.post('/partition/:replicaId', async (req, res) => {
  const url = REPLICA_MAP[req.params.replicaId];
  if (!url) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await axios.post(`${url}/simulate-partition`, {}, { timeout: 1000 });
    log_gw(`Partitioned ${req.params.replicaId}`);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/heal/:replicaId', async (req, res) => {
  const url = REPLICA_MAP[req.params.replicaId];
  if (!url) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await axios.post(`${url}/heal-partition`, {}, { timeout: 1000 });
    log_gw(`Healed ${req.params.replicaId}`);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, '../frontend')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

wss.on('connection', (ws) => {
  clients.add(ws);
  log_gw(`Client connected. Total: ${clients.size}`);
  ws.send(JSON.stringify({ type: 'connected', message: 'Welcome to MiniRAFT Drawing Board!' }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (['stroke', 'undo', 'redo', 'clear'].includes(msg.type)) {
      await forwardToLeader(msg);
    }
  });

  ws.on('close', () => { clients.delete(ws); log_gw(`Client disconnected. Total: ${clients.size}`); });
  ws.on('error', () => clients.delete(ws));
});

async function forwardToLeader(event) {
  if (!currentLeaderUrl) await discoverLeader();
  if (!currentLeaderUrl) { log_gw('No leader, dropping event'); return; }
  try {
    await axios.post(`${currentLeaderUrl}/stroke`, event, { timeout: 1000 });
  } catch (err) {
    log_gw(`Leader unreachable: ${err.message}. Rediscovering...`);
    currentLeaderUrl = null; currentLeaderTerm = -1;
    await discoverLeader();
    if (currentLeaderUrl) {
      try { await axios.post(`${currentLeaderUrl}/stroke`, event, { timeout: 1000 }); } catch {}
    }
  }
}

server.listen(PORT, () => { log_gw(`Gateway on port ${PORT}`); discoverLeader(); });
process.on('SIGTERM', () => { for (const c of clients) c.close(); server.close(() => process.exit(0)); });
