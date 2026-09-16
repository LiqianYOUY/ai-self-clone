#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if [ ! -d node_modules ]; then
  npm ci
fi
printf '\n研究平台启动后，请打开 http://127.0.0.1:3000\n关闭本窗口将停止服务，研究数据会保留。\n\n'
npm run dev
