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

const HEARTBEAT_INTERVAL = 150;
const electionTimeout = () => 500 + Math.floor(Math.random() * 300);

function log_info(msg) {
  console.log(`[${REPLICA_ID}][Term:${term}][${state}] ${msg}`);
}

function resetElectionTimer() {
  clearTimeout(electionTimer);
  electionTimer = setTimeout(startElection, electionTimeout());
}

function stopElectionTimer() {
  clearTimeout(electionTimer);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
}

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

  const voteRequests = PEERS.map(async (peer) => {
    try {
      const res = await axios.post(`${peer}/request-vote`, {
        term,
        candidateId: REPLICA_ID,
        lastLogIndex: log.length - 1,
        lastLogTerm: log.length > 0 ? log[log.length - 1].term : -1,
      }, { timeout: 300 });
      return res.data.voteGranted ? 1 : 0;
    } catch {
      return 0;
    }
  });

  const results = await Promise.all(voteRequests);
  votes += results.reduce((a, b) => a + b, 0);

  if (state !== 'CANDIDATE') return;

  if (votes >= 2) {
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
    log_info(`Notified gateway of leadership`);
  } catch {
    log_info(`Could not notify gateway (will retry on next heartbeat)`);
  }
}

async function sendHeartbeats() {
  if (state !== 'LEADER') return;
  for (const peer of PEERS) {
    try {
      const res = await axios.post(`${peer}/heartbeat`, {
        term,
        leaderId: REPLICA_ID,
        leaderUrl: `http://${REPLICA_ID}:${PORT}`,
        commitIndex,
      }, { timeout: 300 });
      if (res.data.term > term) {
        log_info(`Higher term detected from peer. Stepping down.`);
        becomeFollower(res.data.term);
        return;
      }
      if (res.data.needsSync) {
        syncFollower(peer, res.data.logLength);
      }
    } catch {}
  }
  notifyGateway();
}

async function syncFollower(peerUrl, fromIndex) {
  const missing = log.slice(fromIndex).filter(e => e.index <= commitIndex);
  if (missing.length === 0) return;
  try {
    await axios.post(`${peerUrl}/sync-log`, { entries: missing, commitIndex }, { timeout: 1000 });
    log_info(`Synced ${missing.length} entries to ${peerUrl} from index ${fromIndex}`);
  } catch {}
}

async function replicateToFollowers(entry) {
  let acks = 1;
  const reqs = PEERS.map(async (peer) => {
    try {
      const res = await axios.post(`${peer}/append-entries`, {
        term,
        leaderId: REPLICA_ID,
        prevLogIndex: log.length - 2,
        prevLogTerm: log.length >= 2 ? log[log.length - 2].term : -1,
        entries: [entry],
        leaderCommit: commitIndex,
      }, { timeout: 500 });
      return res.data.success ? 1 : 0;
    } catch {
      return 0;
    }
  });
  const results = await Promise.all(reqs);
  acks += results.reduce((a, b) => a + b, 0);
  return acks >= 2;
}

app.post('/stroke', async (req, res) => {
  if (state !== 'LEADER') {
    return res.status(403).json({ error: 'Not leader', leaderId });
  }
  const entry = { index: log.length, term, data: req.body, committed: false };
  log.push(entry);
  log_info(`Stroke received, log index ${entry.index}`);

  const committed = await replicateToFollowers(entry);
  if (committed) {
    log[entry.index].committed = true;
    commitIndex = entry.index;
    log_info(`Entry ${entry.index} committed`);
    try {
      await axios.post(`${GATEWAY_URL}/broadcast`, req.body, { timeout: 1000 });
    } catch { log_info('Could not broadcast to gateway'); }
    res.json({ success: true, index: entry.index });
  } else {
    log_info(`Failed to get majority for entry ${entry.index}`);
    res.status(500).json({ error: 'No majority' });
  }
});

app.post('/request-vote', (req, res) => {
  const { term: candidateTerm, candidateId, lastLogIndex, lastLogTerm } = req.body;
  if (candidateTerm > term) {
    becomeFollower(candidateTerm);
  }
  const myLastLogTerm = log.length > 0 ? log[log.length - 1].term : -1;
  const myLastLogIndex = log.length - 1;
  const logOk = lastLogTerm > myLastLogTerm ||
    (lastLogTerm === myLastLogTerm && lastLogIndex >= myLastLogIndex);
  const voteGranted = candidateTerm >= term && logOk &&
    (votedFor === null || votedFor === candidateId);
  if (voteGranted) {
    votedFor = candidateId;
    term = candidateTerm;
    resetElectionTimer();
  }
  log_info(`Vote request from ${candidateId}: ${voteGranted ? 'GRANTED' : 'DENIED'}`);
  res.json({ term, voteGranted });
});

app.post('/append-entries', (req, res) => {
  const { term: leaderTerm, leaderId: lid, entries, leaderCommit, prevLogIndex } = req.body;
  if (leaderTerm < term) {
    return res.json({ term, success: false });
  }
  if (leaderTerm > term || state !== 'FOLLOWER') {
    becomeFollower(leaderTerm, lid);
  } else {
    leaderId = lid;
    resetElectionTimer();
  }
  term = leaderTerm;

  if (prevLogIndex >= 0 && (log.length <= prevLogIndex)) {
    return res.json({ term, success: false, logLength: log.length });
  }

  for (const entry of entries) {
    if (log[entry.index] && log[entry.index].term !== entry.term) {
      log = log.slice(0, entry.index);
    }
    if (!log[entry.index]) {
      log.push(entry);
    }
  }

  if (leaderCommit > commitIndex) {
    commitIndex = Math.min(leaderCommit, log.length - 1);
    for (let i = 0; i <= commitIndex; i++) {
      if (log[i]) log[i].committed = true;
    }
  }
  res.json({ term, success: true });
});

app.post('/heartbeat', (req, res) => {
  const { term: leaderTerm, leaderId: lid, commitIndex: leaderCommit } = req.body;
  if (leaderTerm < term) {
    return res.json({ term, success: false });
  }
  if (leaderTerm > term || state !== 'FOLLOWER') {
    becomeFollower(leaderTerm, lid);
  } else {
    leaderId = lid;
    resetElectionTimer();
  }
  term = leaderTerm;
  const needsSync = log.length < (leaderCommit + 1);
  res.json({ term, success: true, needsSync, logLength: log.length });
});

app.post('/sync-log', (req, res) => {
  const { entries, commitIndex: leaderCommit } = req.body;
  for (const entry of entries) {
    if (!log[entry.index]) log.push(entry);
  }
  commitIndex = leaderCommit;
  for (let i = 0; i <= commitIndex; i++) {
    if (log[i]) log[i].committed = true;
  }
  log_info(`Synced. Log length now: ${log.length}`);
  res.json({ success: true });
});

app.get('/status', (req, res) => {
  res.json({ id: REPLICA_ID, state, term, leaderId, logLength: log.length, commitIndex });
});

app.listen(PORT, () => {
  log_info(`Replica started on port ${PORT}`);
  resetElectionTimer();
});

process.on('SIGTERM', () => {
  log_info('SIGTERM received — shutting down gracefully');
  stopElectionTimer();
  stopHeartbeat();
  process.exit(0);
});
