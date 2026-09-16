#!/usr/bin/env bash
# Give this project its own userspace Tailscale identity and state directory.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
service_user="$(id -un)"
if [[ "$(uname -s)" != Linux || "$service_user" == root || ! -x /usr/sbin/tailscaled ]]; then
  echo "Run as the project owner on Linux with the official Tailscale runtime installed."
  exit 1
fi
if [[ "$project_root" == *[[:space:]]* || "$project_root" == *\"* || "$project_root" == *%* ]]; then
  echo "The service checkout path must not contain whitespace, quotes or %."
  exit 1
fi
mkdir -p "$project_root/.local/tailscale"
chmod 700 "$project_root/.local/tailscale"
unit_file="$(mktemp)"
trap 'rm -f "$unit_file"' EXIT
cat > "$unit_file" <<UNIT
[Unit]
Description=AI Self private network instance and public HTTPS tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$service_user
WorkingDirectory=$project_root
ExecStart=/usr/sbin/tailscaled --tun=userspace-networking --state=$project_root/.local/tailscale/tailscaled.state --statedir=$project_root/.local/tailscale --socket=$project_root/.local/tailscale/tailscaled.sock --port=0
Restart=on-failure
RestartSec=5
UMask=0077
Nice=10
CPUQuota=50%
OOMScoreAdjust=500
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
sudo install -m 644 "$unit_file" /etc/systemd/system/ai-self-tunnel.service
sudo systemctl daemon-reload
sudo systemctl enable --now ai-self-tunnel.service
printf 'Independent tunnel installed. Use tailscale --socket=%s/.local/tailscale/tailscaled.sock for this project.\n' "$project_root"
