const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));

const REPLICA_ID = process.env.REPLICA_ID;
const PORT = parseInt(process.env.PORT);
const PEERS = process.env.PEERS ? process.env.PEERS.split(',').filter(Boolean) : [];
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway:3000';

let state = 'FOLLOWER';
let term = 0;
let votedFor = null;
let log = [];
let commitIndex = -1;
let leaderId = null;
let electionTimer = null;
let heartbeatTimer = null;
let partitioned = false;

const HEARTBEAT_INTERVAL = 150;
const electionTimeout = () => 500 + Math.floor(Math.random() * 300);
const majority = () => Math.floor((PEERS.length + 1) / 2) + 1;

function log_info(msg) {
  console.log(`[${REPLICA_ID}][Term:${term}][${state}] ${msg}`);
}

function resetElectionTimer() {
  clearTimeout(electionTimer);
  electionTimer = setTimeout(startElection, electionTimeout());
}

function stopElectionTimer() { clearTimeout(electionTimer); }
function stopHeartbeat() { clearInterval(heartbeatTimer); }

function becomeFollower(newTerm, newLeader = null) {
  state = 'FOLLOWER';
  term = newTerm;
  votedFor = null;
  leaderId = newLeader;
  stopHeartbeat();
  resetElectionTimer();
  log_info(`Became FOLLOWER. Leader=${newLeader}`);
}

async function startElection() {
  state = 'CANDIDATE';
  term++;
  votedFor = REPLICA_ID;
  let votes = 1;
  log_info(`Starting election for term ${term}`);

  const results = await Promise.all(PEERS.map(async (peer) => {
    try {
      const res = await axios.post(`${peer}/request-vote`, {
        term, candidateId: REPLICA_ID,
        lastLogIndex: log.length - 1,
        lastLogTerm: log.length > 0 ? log[log.length - 1].term : -1,
      }, { timeout: 300 });
      return res.data.voteGranted ? 1 : 0;
    } catch { return 0; }
  }));

  votes += results.reduce((a, b) => a + b, 0);
  if (state !== 'CANDIDATE') return;

  if (votes >= majority()) {
    becomeLeader();
  } else {
    log_info(`Lost election (${votes} votes). Back to FOLLOWER.`);
    becomeFollower(term);
  }
}

function becomeLeader() {
  state = 'LEADER';
  leaderId = REPLICA_ID;
  stopElectionTimer();
  log_info(`Became LEADER with term ${term}`);
  sendHeartbeats();
  heartbeatTimer = setInterval(sendHeartbeats, HEARTBEAT_INTERVAL);
  notifyGateway();
}

async function notifyGateway() {
  try {
    await axios.post(`${GATEWAY_URL}/leader-update`, {
      leaderId: REPLICA_ID,
      leaderUrl: `http://${REPLICA_ID}:${PORT}`,
      term,
    }, { timeout: 500 });
  } catch {}
}

async function sendHeartbeats() {
  if (state !== 'LEADER') return;
  for (const peer of PEERS) {
    try {
      const res = await axios.post(`${peer}/heartbeat`, {
        term, leaderId: REPLICA_ID,
        leaderUrl: `http://${REPLICA_ID}:${PORT}`,
        commitIndex,
      }, { timeout: 300 });
      if (res.data.term > term) { becomeFollower(res.data.term); return; }
      if (res.data.needsSync) syncFollower(peer, res.data.logLength);
    } catch {}
  }
  notifyGateway();
}

async function syncFollower(peerUrl, fromIndex) {
  const missing = log.slice(fromIndex).filter(e => e.index <= commitIndex);
  if (!missing.length) return;
  try {
    await axios.post(`${peerUrl}/sync-log`, { entries: missing, commitIndex }, { timeout: 1000 });
    log_info(`Synced ${missing.length} entries to ${peerUrl}`);
  } catch {}
}

async function replicateToFollowers(entry) {
  let acks = 1;
  const results = await Promise.all(PEERS.map(async (peer) => {
    try {
      const res = await axios.post(`${peer}/append-entries`, {
        term, leaderId: REPLICA_ID,
        prevLogIndex: log.length - 2,
        prevLogTerm: log.length >= 2 ? log[log.length - 2].term : -1,
        entries: [entry], leaderCommit: commitIndex,
      }, { timeout: 500 });
      return res.data.success ? 1 : 0;
    } catch { return 0; }
  }));
  acks += results.reduce((a, b) => a + b, 0);
  return acks >= majority();
}

function checkPartition(req, res, next) {
  if (partitioned) return res.status(503).json({ error: 'Simulated network partition' });
  next();
}

app.post('/stroke', async (req, res) => {
  if (state !== 'LEADER') return res.status(403).json({ error: 'Not leader', leaderId });
  const entryData = req.body;
  const entry = { index: log.length, term, data: entryData, committed: false };
  log.push(entry);
  log_info(`Entry [${entryData.type || 'stroke'}] at index ${entry.index}`);

  const committed = await replicateToFollowers(entry);
  if (committed) {
    log[entry.index].committed = true;
    commitIndex = entry.index;
    log_info(`Entry ${entry.index} committed`);
    try { await axios.post(`${GATEWAY_URL}/broadcast`, entryData, { timeout: 1000 }); } catch {}
    res.json({ success: true, index: entry.index });
  } else {
    res.status(500).json({ error: 'No majority' });
  }
});

app.post('/request-vote', checkPartition, (req, res) => {
  const { term: ct, candidateId, lastLogIndex, lastLogTerm } = req.body;
  if (ct > term) becomeFollower(ct);
  const myLLT = log.length > 0 ? log[log.length - 1].term : -1;
  const myLLI = log.length - 1;
  const logOk = lastLogTerm > myLLT || (lastLogTerm === myLLT && lastLogIndex >= myLLI);
  const voteGranted = ct >= term && logOk && (votedFor === null || votedFor === candidateId);
  if (voteGranted) { votedFor = candidateId; term = ct; resetElectionTimer(); }
  log_info(`Vote for ${candidateId}: ${voteGranted ? 'GRANTED' : 'DENIED'}`);
  res.json({ term, voteGranted });
});

app.post('/append-entries', checkPartition, (req, res) => {
  const { term: lt, leaderId: lid, entries, leaderCommit, prevLogIndex } = req.body;
  if (lt < term) return res.json({ term, success: false });
  if (lt > term || state !== 'FOLLOWER') becomeFollower(lt, lid);
  else { leaderId = lid; resetElectionTimer(); }
  term = lt;
  if (prevLogIndex >= 0 && log.length <= prevLogIndex)
    return res.json({ term, success: false, logLength: log.length });
  for (const entry of entries) {
    if (log[entry.index] && log[entry.index].term !== entry.term) log = log.slice(0, entry.index);
    if (!log[entry.index]) log.push(entry);
  }
  if (leaderCommit > commitIndex) {
    commitIndex = Math.min(leaderCommit, log.length - 1);
    for (let i = 0; i <= commitIndex; i++) if (log[i]) log[i].committed = true;
  }
  res.json({ term, success: true });
});

app.post('/heartbeat', checkPartition, (req, res) => {
  const { term: lt, leaderId: lid, commitIndex: lc } = req.body;
  if (lt < term) return res.json({ term, success: false });
  if (lt > term || state !== 'FOLLOWER') becomeFollower(lt, lid);
  else { leaderId = lid; resetElectionTimer(); }
  term = lt;
  res.json({ term, success: true, needsSync: log.length < (lc + 1), logLength: log.length });
});

app.post('/sync-log', checkPartition, (req, res) => {
  const { entries, commitIndex: lc } = req.body;
  for (const e of entries) if (!log[e.index]) log.push(e);
  commitIndex = lc;
  for (let i = 0; i <= commitIndex; i++) if (log[i]) log[i].committed = true;
  log_info(`Synced. Log length: ${log.length}`);
  res.json({ success: true });
});

app.get('/status', (req, res) => {
  res.json({ id: REPLICA_ID, state, term, leaderId, logLength: log.length, commitIndex, partitioned });
});

app.post('/simulate-partition', (req, res) => {
  partitioned = true;
  stopHeartbeat();
  log_info('⚡ NETWORK PARTITION SIMULATED');
  res.json({ ok: true, id: REPLICA_ID, partitioned });
});

app.post('/heal-partition', (req, res) => {
  partitioned = false;
  log_info('✅ PARTITION HEALED');
  if (state !== 'LEADER') resetElectionTimer();
  res.json({ ok: true, id: REPLICA_ID, partitioned });
});

app.listen(PORT, () => {
  log_info(`Replica started on port ${PORT}`);
  resetElectionTimer();
});

process.on('SIGTERM', () => {
  stopElectionTimer(); stopHeartbeat(); process.exit(0);
});
