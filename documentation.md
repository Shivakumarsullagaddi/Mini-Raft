# MiniRAFT — Complete Project Documentation (v2)

## Project Overview
A **Distributed Real-Time Drawing Board** backed by a 4-node Mini-RAFT consensus cluster. Multiple users draw on a browser canvas; every stroke is replicated across all replicas before being committed and broadcast.

---

## Teammate Setup Guide
Welcome to the Mini-RAFT distributed drawing board project! To get this running on your local machine, follow these steps:

### 1. Prerequisites
- **Docker Desktop**: [Download here](https://www.docker.com/products/docker-desktop/) (Required for clustering)
- **Node.js (v18+)**: [Download here](https://nodejs.org/) (Optional, but good for local debugging)
- **Git**: To clone and manage your changes.

### 2. Setup & Run (Standard Method)
The easiest way to run the entire 4-node cluster + gateway + frontend is using Docker:
```bash
# Clone the repository
git clone <your-repo-url>
cd mini-project

# Start the cluster
docker compose up --build
```
Once it says `Listening on port 3000`, open **http://localhost:3000** in your browser.

### 3. Development Workflow
- **Frontend**: The `frontend/index.html` is served by the Gateway on port 3000.
- **Logs**: To see logs from a specific node (e.g., replica1):
  ```bash
  docker compose logs -f replica1
  ```
- **Changes**: If you modify code in any `replicaX/index.js`, the containers will auto-restart (thanks to `nodemon` in the Dockerfile).

### 4. Git Best Practices
- **.gitignore**: We have a root `.gitignore` that handles `node_modules`, `.env`, and IDE files. Do NOT manually commit `node_modules`.
- **Branches**: Please create a feature branch before making changes: `git checkout -b feature/your-feature-name`.

---

## Final File Structure
```
mini-project/
├── docker-compose.yml       — 4 replicas + gateway on raft-net
├── DEPLOY.md                — AWS / GCP cloud deployment guide
├── documentation.md         — This file
├── gateway/
│   ├── Dockerfile
│   ├── package.json
│   └── index.js             — WebSocket server, leader discovery, partition proxy
├── replica1/ replica2/ replica3/ replica4/
│   ├── Dockerfile
│   ├── package.json
│   └── index.js             — Full Mini-RAFT node (identical code, different env vars)
└── frontend/
    └── index.html           — Canvas UI + Dashboard + Undo/Redo + Partition controls
```

---

## System Flow

```
Browser ──WebSocket──► Gateway :3000
                          │
                          │ HTTP POST /stroke
                          ▼
                     Leader Replica
                    (replica1–4, one LEADER at a time)
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
           replica     replica     replica
         (follower)  (follower)  (follower)
              │
              └── When 3 of 4 confirm → COMMIT
                          │
                          ▼
                  Gateway /broadcast
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
        Browser Tab 1           Browser Tab 2
```

---

## Mini-RAFT Protocol

### Node States
| State | Behaviour |
|---|---|
| FOLLOWER | Waits for heartbeats (timeout: 500–800ms random) |
| CANDIDATE | Requests votes after timeout; increments term |
| LEADER | Sends heartbeats every 150ms; handles all writes |

### Election (4 nodes → majority = 3)
1. Follower misses heartbeat → becomes CANDIDATE, increments `term`
2. Sends `/request-vote` to 3 peers
3. Wins if `votes ≥ 3` (self + 2 peers)
4. Becomes LEADER, notifies Gateway

### Log Replication
1. Gateway sends event to Leader's `POST /stroke`
2. Leader appends to log, sends `/append-entries` to 3 followers
3. Followers append and ACK
4. When 3 ACKs received → commit → broadcast via Gateway

### Catch-Up (Restarted Node)
1. Restarted node starts with empty log at term 0
2. Receives heartbeat from Leader with higher term → becomes Follower
3. On next heartbeat: `needsSync: true` sent back
4. Leader calls `/sync-log` with all missing committed entries
5. Node is now in sync and participates normally

---

## All API Endpoints

### Replica Endpoints
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/stroke` | Accept log entry (leader only) |
| POST | `/request-vote` | RAFT vote request |
| POST | `/append-entries` | RAFT log replication |
| POST | `/heartbeat` | Leader keepalive |
| POST | `/sync-log` | Catch-up for restarted node |
| GET | `/status` | Returns: id, state, term, leaderId, logLength, commitIndex, partitioned |
| POST | `/simulate-partition` | **Bonus**: Simulate network partition |
| POST | `/heal-partition` | **Bonus**: Restore from partition |

### Gateway Endpoints
| Method | Endpoint | Purpose |
|---|---|---|
| WS | `/` | WebSocket for browsers |
| GET | `/gateway-status` | Returns leader, term, clients, all replica statuses |
| POST | `/leader-update` | Leader registers itself |
| POST | `/broadcast` | Broadcast committed event to all clients |
| POST | `/partition/:id` | **Bonus**: Proxy partition to replica |
| POST | `/heal/:id` | **Bonus**: Proxy heal to replica |

---

## Event Log Types (WebSocket Messages)

| Type | Fields | Description |
|---|---|---|
| `stroke` | id, color, size, points[], isEraser | Draw a stroke |
| `undo` | targetId | Log compensation — mark stroke as undone |
| `redo` | targetId | Re-apply previously undone stroke |
| `clear` | — | Clear entire canvas |

All events go through RAFT consensus before being broadcast.

---

## Bonus Features Implemented

### ✅ 4th Replica
- Added `replica4` (port 4004)
- Majority now = 3 out of 4
- Tolerates 1 failure (vs 1 before)

### ✅ Vector-Based Undo/Redo (Log Compensation)
- Every stroke gets a unique ID
- Undo adds a `{ type: 'undo', targetId }` entry to the RAFT log
- Redo adds a `{ type: 'redo', targetId }` entry
- Canvas re-renders by replaying the log, skipping undone strokes
- **Keyboard**: Ctrl+Z = Undo, Ctrl+Y = Redo

### ✅ Dashboard (Live RAFT Status)
- Shows all 4 replicas: state badge (LEADER/FOLLOWER/CANDIDATE/OFFLINE), term, log size, commit index
- Bar chart showing relative log sizes
- Auto-refreshes every 1.5 seconds
- Toggle with 📊 Dashboard button

### ✅ Network Partition Simulation (Split Brain)
- Click **⚡ Partition** on any replica in the Dashboard
- That replica stops responding to all peer RPCs (simulates network cut)
- With 4 nodes: partition 2 → remaining 2 cannot elect leader (needs 3); partition 1 → system still works
- Click **✅ Heal** to restore

### ✅ Eraser Fix (destination-out)
- Old eraser drew with background color `#0d0d14` → didn't sync properly
- New eraser uses `ctx.globalCompositeOperation = 'destination-out'` 
- Properly erases pixels on both local and remote canvases
- Erase strokes carry `isEraser: true` flag through RAFT log

### ✅ Clear Canvas Sync
- "Clear All" button sends `{ type: 'clear' }` through RAFT
- All clients clear simultaneously after consensus

### ☁️ Cloud Deploy
- See `DEPLOY.md` for AWS EC2 and Google Cloud step-by-step instructions

---

## Bugs Fixed in v2
| Bug | Root Cause | Fix |
|---|---|---|
| Friend can't see drawing | Express 100kb body limit rejected large strokes | `express.json({ limit: '10mb' })` |
| Eraser not synced | Used background color; remote canvas didn't match | `destination-out` composite + `isEraser` flag |
| Term 174 | Stopped 2 replicas → no majority → 174 failed elections | Never stop > 1 replica at a time |
| `version` warning | Obsolete field in docker-compose | Removed `version: '3.8'` |
| Clear not synced | `clearRect` was only local | `type: 'clear'` goes through RAFT |
| Strokes not broadcast | Leader didn't call /broadcast after commit | Leader calls `/broadcast` after every commit |

---

## Testing Procedures

### Basic Sync Test
```bash
docker compose up --build
# Open http://localhost:3000 in 2 tabs
# Draw in one → verify appears in other
```

### Failover Test
```bash
docker compose stop replica1     # Kill leader
# Watch logs: new election in ~600ms
docker compose start replica1    # Rejoin → sync-log catch-up
```

### Split-Brain Demo
1. Open Dashboard panel
2. Click ⚡ Partition on replica1 and replica2
3. Observe: those 2 can't reach majority
4. replica3 + replica4 still form quorum
5. Click ✅ Heal to restore

### Undo/Redo Test
1. Draw several strokes
2. Press Ctrl+Z → verify removed on all clients
3. Press Ctrl+Y → verify restored on all clients

### Hot-Reload Test
```bash
# Edit any replica/index.js → nodemon auto-restarts → RAFT re-election
# Clients stay connected throughout
```

---

## Real-World Parallels (VIVA)
| This Project | Production System |
|---|---|
| Leader election | etcd in Kubernetes control plane |
| 4-node cluster, majority=3 | Kafka broker quorum |
| Log compensation (undo) | Event sourcing / CQRS compensating transactions |
| Network partition simulation | Chaos Engineering (Netflix Chaos Monkey) |
| Heartbeat 150ms | Zookeeper session timeout keepalive |
| Hot-reload election | Kubernetes rolling update |
| Gateway re-routes | AWS ALB health-check failover |

---

## How to Run
```bash
# Start full cluster
docker compose up --build

# View logs of specific service
docker compose logs -f replica1

# Check replica status
curl http://localhost:4001/status | python3 -m json.tool

# Simulate partition
curl -X POST http://localhost:3000/partition/replica1

# Heal
curl -X POST http://localhost:3000/heal/replica1

# Tear down
docker compose down
```
