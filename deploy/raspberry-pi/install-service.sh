#!/usr/bin/env bash
# Install this checkout as a separate, resource-limited service on 64-bit Linux.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
service_user="$(id -un)"
if [[ "$(uname -s)" != Linux || "$(uname -m)" != aarch64 || "$service_user" == root ]]; then
  echo "Run as the project owner on 64-bit Raspberry Pi OS."
  exit 1
fi
if [[ "$project_root" == *[[:space:]]* || "$project_root" == *\"* || "$project_root" == *%* ]]; then
  echo "The service checkout path must not contain whitespace, quotes or %."
  exit 1
fi
if [[ ! -f "$project_root/.env" || ! -f "$project_root/.cache/next/BUILD_ID" || ! -x "$project_root/.local/node/bin/node" ]]; then
  echo "Prepare .env, the project-local Node runtime and npm run build first."
  exit 1
fi
chmod 600 "$project_root/.env"
unit_file="$(mktemp)"
trap 'rm -f "$unit_file"' EXIT
cat > "$unit_file" <<UNIT
[Unit]
Description=AI Self online game
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$service_user
WorkingDirectory=$project_root
Environment=NODE_ENV=production
Environment=PATH=$project_root/.local/node/bin:$project_root/.local/ollama/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$project_root/.local/node/bin/node --import tsx scripts/start-local.ts
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
KillMode=mixed
UMask=0077
Nice=10
CPUQuota=200%
MemoryHigh=3G
MemoryMax=4G
OOMScoreAdjust=500
IOWeight=50
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
sudo install -m 644 "$unit_file" /etc/systemd/system/ai-self-clone.service
sudo systemctl daemon-reload
sudo systemctl enable --now ai-self-clone.service
printf 'Service installed. Status: systemctl status ai-self-clone\n'
