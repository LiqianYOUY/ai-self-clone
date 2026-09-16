#!/usr/bin/env bash
# Temporary test access only. A new process receives a new public URL.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
service_user="$(id -un)"
if [[ "$(uname -s)" != Linux || "$service_user" == root || ! -x "$project_root/.local/cloudflared" ]]; then
  echo "Run as the project owner on Linux after installing verified official cloudflared in .local/."
  exit 1
fi
sudo systemd-run --unit=ai-self-quick-tunnel --collect \
  --uid="$service_user" --working-directory="$project_root" \
  --property=UMask=0077 --property=Nice=10 --property=CPUQuota=50% \
  --property=OOMScoreAdjust=500 --property=NoNewPrivileges=true \
  --property=ProtectSystem=full --property=PrivateTmp=true \
  "$project_root/.local/cloudflared" tunnel --no-autoupdate \
  --url http://127.0.0.1:3100 --protocol http2
printf '%s\n' \
  'Read the temporary URL: journalctl -u ai-self-quick-tunnel -n 40 --no-pager' \
  'Set APP_ORIGIN to that exact HTTPS origin in .env and restart ai-self-clone.' \
  'Verify external access before changing the links in docs/index.html. This tunnel does not survive a reboot.'
