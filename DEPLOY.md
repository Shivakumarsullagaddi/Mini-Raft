# Cloud Deployment Guide — AWS EC2

## Prerequisites
- AWS account (free tier works)
- SSH key pair created in AWS

## Step 1: Launch EC2 Instance
1. Go to **EC2 → Launch Instance**
2. Choose: **Ubuntu 24.04 LTS**
3. Instance type: **t2.micro** (free tier)
4. Security Group — open these ports:
   - 22 (SSH)
   - 3000 (Gateway/UI)
   - 4001–4004 (Replicas for debugging)
5. Launch and download `.pem` key

## Step 2: SSH Into Instance
```bash
chmod 400 your-key.pem
ssh -i your-key.pem ubuntu@<EC2-PUBLIC-IP>
```

## Step 3: Install Docker on EC2
```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker ubuntu
newgrp docker
```

## Step 4: Upload Project Files
From your local machine (WSL):
```bash
scp -i your-key.pem -r /mnt/d/sem\ 6/CC-lab/mini-project ubuntu@<EC2-IP>:~/mini-project
```

## Step 5: Build & Run on EC2
```bash
cd ~/mini-project
docker compose up --build -d
```

## Step 6: Access
Open browser: `http://<EC2-PUBLIC-IP>:3000`

## Step 7: Stop
```bash
docker compose down
```

---

# Google Cloud Deploy (Alternative)

## Step 1: Create VM
```bash
gcloud compute instances create miniraft \
  --machine-type=e2-micro \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --tags=http-server \
  --zone=us-central1-a
```

## Step 2: Open Firewall
```bash
gcloud compute firewall-rules create miniraft-ports \
  --allow tcp:3000,tcp:4001-4004 \
  --target-tags=http-server
```

## Step 3: SSH & Deploy
```bash
gcloud compute ssh miniraft --zone=us-central1-a
# Then follow same Docker install + scp steps as AWS
```
