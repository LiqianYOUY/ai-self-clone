# 部署与维护

完整应用需要持久 Node.js 服务、PostgreSQL 和 Ollama 或兼容模型接口。GitHub Pages 只托管网页入口；完成服务部署和公网验证后，参与者可从入口直接打开多人游戏。当前进度见 [验证记录](VERIFICATION.md)。

## 树莓派

使用 64 位 Raspberry Pi OS、Node.js 22，并在独立的 `~/ai-self-clone` 目录部署。运行时和模型置于项目 `.local/`，缓存置于 `.cache/`，不复用其他项目的数据库或端口。

部署设备为 Raspberry Pi 5 / 8GB。`ai-self-clone.service` 管理应用、项目 PostgreSQL 和 Ollama，网页监听 `127.0.0.1:3100`。服务使用两个 CPU 核等效配额和较低调度优先级，内存不足时优先终止该服务。配置中的 4GB 内存上限需要系统启用 memory cgroup；当前设备未启用，不能视为已生效的硬上限。

`ai-self-tunnel.service` 单独运行用户态 `tailscaled`，身份为 `ai-self-clone`，state 与 socket 均位于项目 `.local/tailscale/`。它使用独立节点的 HTTPS 443，不修改系统原有的 wheelchair Serve 或 smartbox 443。当前节点在线、证书有效，`https://ai-self-clone.tail3d8705.ts.net` 已通过公网 HTTPS 及浏览器页面检查。首次发布曾出现 DNS NODATA，后续已存在有效的 A/AAAA 记录；部分公共解析结果仍有差异，记录见验证文档。设备需保持开机和联网。

环境文件 `.env` 不提交版本控制，权限设为 `0600`。主要配置：

```dotenv
STUDY_MODE=synthetic
APP_HOST=127.0.0.1
PORT=3100
APP_ORIGIN=https://YOUR_DEVICE.YOUR_TAILNET.ts.net
PORTAL_BOOTSTRAP_ENABLED=false
PLAY_MODEL_PROVIDER=ollama
PLAY_MODEL_BASE_URL=http://127.0.0.1:11434
PLAY_MODEL_NAME=qwen3.5:0.8b
```

模型较小用于控制设备延迟和内存占用，不代表与 4B 模型相同的拟人质量。数据库密码由启动脚本随机生成；不要复用 SSH 密码作为网站或数据库凭据。

首次部署流程：

1. 从官方来源安装项目内 Node ARM64 和 Ollama ARM64，并校验发布文件 SHA-256。
2. `npm ci`，配置 `.env`，通过 `npm run model:setup` 下载模型。
3. 执行测试和 `npm run build`，验证真实模型与两个独立浏览器会话的完整流程。
4. 执行 `deploy/raspberry-pi/install-service.sh`，安装独立 `ai-self-clone` systemd 服务。
5. 执行 `deploy/raspberry-pi/install-tunnel.sh`，通过项目 socket 登录独立节点，再配置 Funnel 并验证公网 DNS、HTTPS、Cookie、邀请和模型回复。

从项目根目录操作独立隧道：

```sh
tailscale --socket="$PWD/.local/tailscale/tailscaled.sock" up \
  --login-server=https://login.tailscale.com:443 \
  --hostname=ai-self-clone --accept-dns=false --accept-routes=false
tailscale --socket="$PWD/.local/tailscale/tailscaled.sock" funnel --bg --https=443 http://127.0.0.1:3100
```

Tailnet 策略中的 Funnel 能力仅授予新节点（配置时将 `YOUR_IP` 替换为该节点地址），不扩大到其他节点。此实例不接管系统 DNS 或子网路由；所有项目隧道命令都必须使用上述 socket。

服务自动启动数据库、迁移、合成 seed 与项目本地模型；五轮游戏账号独立于研究员初始化。生产研究 live 模式仍被阻断。部署过程不导入开发机上的数据库或研究输入。

维护命令：

```sh
systemctl status ai-self-clone ai-self-tunnel
journalctl -u ai-self-clone -n 50 --no-pager
sudo systemctl restart ai-self-clone
```

更新按以下顺序执行：

1. 核对没有 `WAITING`、`ACTIVE` 或 `GUESSING` 房间，再安排停止应用。不要中断正在参与的对局。
2. 在 Mac 按下方“代码备份”说明归档树莓派当前部署的 Git 提交，确认归档成功后再更新。
3. 在树莓派执行 `sudo systemctl stop ai-self-clone`，只更新版本化代码。保留 `.env`、原数据库与口令、模型、项目运行时和隧道状态；不要覆盖或清空 `.local/`，也不要重置独立隧道。树莓派不保留旧源码副本或旧构建回滚目录。
4. 依赖锁有变化时先执行 `npm ci`，然后依次执行 `npm run db:generate`、`npm run test:isolated`、`npm run build`，通过后执行 `sudo systemctl start ai-self-clone`。不从 Mac 复制 `node_modules`。检查服务状态、HTTPS 页面及游戏流程后，恢复接待。

`npm run clean` 只在服务和测试停止时运行；它会删除生产构建，需要重新构建后启动。清理不删除 `.local/postgres`、数据库密码、模型或 Tailscale 状态；应用数据删除需使用专门的删除流程。

更新失败时，从 Mac 的代码归档重新发送既有代码到树莓派，在原环境中安装依赖、重新构建并启动；不依赖树莓派上的旧目录。先确认旧代码兼容当前数据库结构，必要时修复代码后重建。此恢复流程绝不恢复或覆盖参与数据库，也不回滚数据库迁移，避免重新引入已删除的参与资料。

风格提炼更新包含 migration `202609160002_play_style_distillation`，仅新增示例称呼与风格档案字段。树莓派停止 `ai-self-clone` 时，其自有 PostgreSQL 也会停止；此时先更新代码、运行隔离测试并构建 `.cache/next`，再启动服务，由 `start-local` 启动原数据库并执行迁移。只有数据库已运行且配置了 `DATABASE_URL` 时，才单独运行 `npm run db:migrate`。旧资料在读取时兼容提炼，重新保存后持久化，建议主持人核对识别对象并试聊。GitHub 代码推送本身不会更新正在运行的树莓派服务。

### 可选临时备用：Cloudflare Quick Tunnel

此备用方案**尚未启用**。官方 `cloudflared` 程序已下载并校验；启用前需确认允许昵称、聊天等网页请求经过 Cloudflare，并在参与说明中明确网络服务商的数据处理。确认后，由项目所有者从项目根目录执行：

```sh
deploy/raspberry-pi/start-quick-tunnel.sh
journalctl -u ai-self-quick-tunnel -n 40 --no-pager
```

脚本创建临时 `ai-self-quick-tunnel` 服务，将请求转发至 `127.0.0.1:3100`。将日志中的完整 HTTPS 源地址填入 `.env` 的 `APP_ORIGIN`，重启 `ai-self-clone`，核实外网 HTTPS、邀请、Cookie 与真实回复后，才能更新网页入口。此隧道重启会更换 URL，设备重启后不会自动恢复，不是固定的生产地址；届时也须让参与者知晓实际转发服务。

停止备用入口使用 `sudo systemctl stop ai-self-quick-tunnel`，不影响项目数据库或系统原有隧道。

## 参与资料与备份

中英文页面使用相同的数据政策：昵称或随机用户名参与，无需真实姓名、邮箱或手机号；资料仅用于本实验及相关分析，实验与分析完成后由项目负责人删除，个人信息不公开。主持人可删除自助注册的游戏账号及全部关联资料，朋友可删除当前整局数据，包括双方消息；两种删除均不可恢复。仅结束对局、退出登录或清理构建缓存不会删除参与数据。删除回归已通过，Mac 与 Pi 的完整自动化套件均为 150/150。

### 代码备份

旧代码备份只保存在 Mac 项目的 `.local/code-backups/`，该目录已被 `.local/` 忽略规则覆盖，不提交 GitHub。树莓派只保留当前运行所需的源码和构建，不保留旧源码、旧构建或本地回滚副本。

在 Mac 项目根目录执行；先将 `deployed_commit` 替换为已核实的树莓派当前部署提交号，而非尚未部署的 Mac 最新提交：

```sh
deployed_commit="填写当前树莓派部署对应的Git提交号"
git cat-file -e "${deployed_commit}^{commit}"
mkdir -p .local/code-backups
git archive --format=tar.gz \
  --output=".local/code-backups/ai-self-clone-${deployed_commit}.tar.gz" \
  "$deployed_commit"
tar -tzf ".local/code-backups/ai-self-clone-${deployed_commit}.tar.gz" >/dev/null
```

任一步失败都先停止更新并处理原因。`git archive` 仅归档指定提交中的版本化代码，不打包整个工作目录。参与数据、数据库、原始输入、`.env`、密钥、模型和 `.local/tailscale/` 身份状态不进入公开仓库或代码备份；代码恢复始终使用树莓派现有的参与数据库。

### 实验及分析结束后的集中删除

由项目负责人确认实验和分析均已结束后执行，系统没有自动定时删除任务。先停止接收新参与者，从项目根目录关闭本项目的公网入口，并确认没有活跃的本地参与会话；保留 `ai-self-clone.service` 运行，使它管理的 PostgreSQL 仍可访问：

```sh
tailscale --socket="$PWD/.local/tailscale/tailscaled.sock" funnel reset
tailscale --socket="$PWD/.local/tailscale/tailscaled.sock" funnel status
```

`reset` 清除该独立实例的 Funnel 配置，不操作系统原有节点。如之后启用了 Cloudflare 备用入口，还须执行 `sudo systemctl stop ai-self-quick-tunnel`，确保所有公开入口已关闭。[Tailscale 命令说明](https://tailscale.com/docs/reference/tailscale-cli/funnel)

`scripts/purge-play-data.ts` 通过 `npm run data:purge` 调用，默认只输出待删除数量，不修改数据。核对账号、资料、房间、消息、登录会话及审计计数后，再显式确认删除：

```sh
npm run data:purge
# 确认范围和数量后，执行不可恢复的删除：
npm run data:purge -- --confirm-purge
# 再次预览，确认所选范围已清空：
npm run data:purge -- --dry-run
```

脚本读取 `DATABASE_URL`，未设置时使用本项目 `.local/database-password` 连接本机数据库。范围仅为 `TARGET` 且 ID 以 `play-target-` 开头的游戏账号及关联资料，删除在一个事务中完成；研究门户账号及其他参与者不在范围内。此流程不重新开放公网入口。

## Docker 或其他服务器

配置 `.env` 中 `RESEARCH_DB_PASSWORD`、`DEMO_ACCESS_TOKEN`、`APP_ORIGIN` 和 `PLAY_MODEL_*` 变量后，使用：

```sh
docker compose --env-file .env -f deploy/compose.yaml up --build
```

Compose 将上述环境配置传入应用，默认模型模式为 `compatible`，需填写可访问的 HTTPS API 根地址、模型名和 API key。镜像不包含 Ollama，容器内 `127.0.0.1` 指向应用容器，不能直接复用宿主机的 Ollama 回环地址；树莓派本机模型使用前述 `start:local` 方式。

Compose 默认只绑定宿主机回环地址，异地部署还需 HTTPS 代理与匹配的 `APP_ORIGIN`。容器只含生产依赖，`npm start` 使用外部 PostgreSQL；`npm run start:local` 自动管理项目内 PostgreSQL。

## GitHub

- `docs/` 作为 Pages 发布目录；源代码仓库保持独立 public。
- `docs/index.html` 直接提供游戏和完整隐私链接，不依赖脚本切换“待上线”状态；更换游戏地址时更新 HTML 中的对应链接，脚本会沿用主入口并附加语言参数。
- 页面引用的 JS/CSS 带内容版本参数。修改静态资源后，同步更新 `index.html` 中的 `?v=` 值，避免 GitHub Pages 的旧缓存延迟显示新内容。首页按钮下的副文案已移除。
- `deploy/github-actions-ci.yml` 是 CI 模板。当前发布凭据缺少 `workflow` 权限，未启用自动工作流；本地完整验收不依赖它。
- `.env`、`.local/`、密钥、数据库和模型不会上传。原始研究输入统一保存在被忽略的 `.local/research-inputs/`。
