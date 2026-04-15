# MiniRAFT — GCP Deployment Guide

## Why Compute Engine (not Cloud Run)?

| Feature | Cloud Run | Compute Engine ✅ |
|---|---|---|
| WebSockets | Limited | Full support |
| Multi-container networking | Not supported | Docker Compose bridge network |
| Inter-service HTTP (replica1→replica2) | Not possible | Works via container names |
| Persistent state.json | No | Yes (volume mounts) |

**Use a single GCP Compute Engine VM running Docker Compose.**

---

## Prerequisites

- GCP account with billing enabled
- `gcloud` CLI installed locally → [Install guide](https://cloud.google.com/sdk/docs/install)
- Project pushed to GitHub (or you'll SCP files)

---

## Step 1 — Prepare Your Code

### Fix docker-compose.yml for production (remove dev volumes)

The current `docker-compose.yml` mounts local source code via volumes — fine for dev, but on GCP the VM won't have your source. The `COPY . .` in Dockerfiles handles this. Remove the volume mounts:

```yaml
# In docker-compose.yml — remove ALL volume: blocks that mount ./replicaX:/app
# Keep only the node_modules exclusion volume if needed, or remove entirely

# REMOVE these blocks from every service:
#   volumes:
#     - ./replica1:/app        ← REMOVE
#     - /app/node_modules      ← REMOVE

# KEEP only this in gateway (for frontend):
#   volumes:
#     - ./frontend:/app/../frontend   ← actually bake this into Dockerfile instead
```

**Better: bake the frontend into the gateway image.**

Edit `gateway/Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
COPY ../frontend /frontend
CMD ["npm", "start"]
```

Wait — Docker can't `COPY` outside build context. Instead, update `gateway/index.js` path or restructure. **Easiest fix**: copy `frontend/` into `gateway/frontend/` and update the path reference:

```js
// gateway/index.js — line 97-98
app.use(express.static(path.join(__dirname, 'frontend')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'index.html')));
```

Then copy frontend files into gateway folder:
```bash
cp -r frontend/* gateway/frontend/
```

And update `gateway/Dockerfile`:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "start"]
```

### Clean docker-compose.yml for production

```yaml
networks:
  raft-net:
    driver: bridge

services:
  replica1:
    build: ./replica1
    container_name: replica1
    networks: [raft-net]
    ports: ["4001:4001"]
    environment:
      - REPLICA_ID=replica1
      - PORT=4001
      - PEERS=http://replica2:4002,http://replica3:4003,http://replica4:4004
      - GATEWAY_URL=http://gateway:3000
    restart: unless-stopped

  replica2:
    build: ./replica2
    container_name: replica2
    networks: [raft-net]
    ports: ["4002:4002"]
    environment:
      - REPLICA_ID=replica2
      - PORT=4002
      - PEERS=http://replica1:4001,http://replica3:4003,http://replica4:4004
      - GATEWAY_URL=http://gateway:3000
    restart: unless-stopped

  replica3:
    build: ./replica3
    container_name: replica3
    networks: [raft-net]
    ports: ["4003:4003"]
    environment:
      - REPLICA_ID=replica3
      - PORT=4003
      - PEERS=http://replica1:4001,http://replica2:4002,http://replica4:4004
      - GATEWAY_URL=http://gateway:3000
    restart: unless-stopped

  replica4:
    build: ./replica4
    container_name: replica4
    networks: [raft-net]
    ports: ["4004:4004"]
    environment:
      - REPLICA_ID=replica4
      - PORT=4004
      - PEERS=http://replica1:4001,http://replica2:4002,http://replica3:4003
      - GATEWAY_URL=http://gateway:3000
    restart: unless-stopped

  gateway:
    build: ./gateway
    container_name: gateway
    networks: [raft-net]
    ports: ["3000:3000"]
    environment:
      - PORT=3000
      - REPLICAS=http://replica1:4001,http://replica2:4002,http://replica3:4003,http://replica4:4004
    depends_on: [replica1, replica2, replica3, replica4]
    restart: unless-stopped
```

---

## Step 2 — Create a GCP VM

```bash
# Authenticate
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Create VM (e2-medium = 2vCPU, 4GB RAM — enough for 5 containers)
gcloud compute instances create miniraft-vm \
  --zone=us-central1-a \
  --machine-type=e2-medium \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --tags=miniraft-server
```

---

## High Performance Deployment (Using e2-medium)

For the **best possible performance and stability**, use the `e2-medium`:

### 1. Use e2-medium
The `e2-medium` (4GB RAM) provides plenty of "headroom." All 5 Node.js containers will run flawlessly with zero lag during Raft elections or large drawing broadcasts.

```bash
gcloud compute instances create miniraft-vm \
  --zone=us-central1-a \
  --machine-type=e2-medium \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --tags=miniraft-server
```

### 2. Swap Space (Optional Safety Net)
With 4GB RAM, swap is likely not needed, but it's still a good safety measure for long-term stability.

**Run these commands inside the VM:**
```bash
# Create a 1GB swap file
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

### 3. Production Optimizations (Already Applied)
The project is already optimized with:
- **`node` instead of `nodemon`**: Reduces CPU/Memory overhead per container.
- **Docker Resource Limits**: Each replica is limited to 128MB, ensuring they don't starve the OS.
- **Alpine Images**: Using `node:20-alpine` keeps the disk footprint small.

---

## Step 3 — Open Firewall Ports

```bash
# Allow port 3000 (frontend + gateway WebSocket)
gcloud compute firewall-rules create allow-miniraft \
  --allow=tcp:3000 \
  --target-tags=miniraft-server \
  --description="MiniRAFT gateway"

# Optional: open replica ports for debugging
gcloud compute firewall-rules create allow-miniraft-replicas \
  --allow=tcp:4001-4004 \
  --target-tags=miniraft-server \
  --description="MiniRAFT replicas"
```

---

## Step 4 — Install Docker on the VM

```bash
# SSH into the VM
gcloud compute ssh miniraft-vm --zone=us-central1-a

# Inside the VM — install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Install Docker Compose
sudo apt-get install -y docker-compose-plugin
docker compose version
```

---

## Step 5 — Upload Your Project

### Option A: SCP (from your local machine)
```bash
# Exit the VM first, run this locally
gcloud compute scp --recurse . miniraft-vm:~/miniraft --zone=us-central1-a
```

### Option B: Git clone (if repo is on GitHub)
```bash
# Inside the VM
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git miniraft
cd miniraft
```

---

## Step 6 — Build and Run

```bash
# Inside the VM
cd ~/miniraft

# Build and start all 5 containers
docker compose up --build -d

# Watch logs
docker compose logs -f

# Check all containers are running
docker compose ps
```

---

## Step 7 — Get the Public IP and Access the App

```bash
# From your local machine
gcloud compute instances describe miniraft-vm \
  --zone=us-central1-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

Open in browser: `http://YOUR_VM_IP:3000`

---

## Step 8 — Keep It Running After SSH Exits

The `-d` flag in `docker compose up -d` runs containers in the background. They will survive SSH disconnection and auto-restart on VM reboot (`restart: unless-stopped`).

To confirm after reconnecting:
```bash
docker compose ps         # all should show "running"
docker compose logs -f    # tail live logs
```

---

## Useful Commands on the VM

```bash
# Stop everything
docker compose down

# Restart a single replica (simulate crash)
docker compose restart replica1

# Check replica status
curl http://localhost:4001/status | python3 -m json.tool

# Simulate partition
curl -X POST http://localhost:3000/partition/replica1

# Heal
curl -X POST http://localhost:3000/heal/replica1

# Live logs of one service
docker compose logs -f replica1

# Rebuild after code changes
docker compose up --build -d
```

---

## Cost Estimate

| Resource | Type | Monthly Cost |
|---|---|---|
| VM | e2-medium (2vCPU, 4GB) | ~$25/month |
| Disk | 20GB standard | ~$1/month |
| Network egress | Minimal for lab | ~$0 |
| **Total** | | **~$26/month** |

> **Free Tier**: New GCP accounts get $300 free credits — this project runs free for 11+ months.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Port 3000 not accessible | Check firewall rule: `gcloud compute firewall-rules list` |
| Containers keep restarting | `docker compose logs replica1` — likely PEERS env var wrong |
| Can't draw (WebSocket fails) | Ensure `ws://YOUR_IP:3000` is reachable, not blocked |
| `state.json` lost on rebuild | Expected — containers are ephemeral; cluster re-elects leader |
| High term numbers (100+) | Normal — means elections happened; cluster is healthy |
 means elections happened; cluster is healthy |
