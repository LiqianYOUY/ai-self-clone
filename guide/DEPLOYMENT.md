# 部署与维护

当前部署分工为 Mac 运行本机模型、鉴权网关和专用 SSH 反向隧道，树莓派运行网站与 PostgreSQL。GitHub Pages 只托管网页入口；浏览器通过 HTTPS 访问 Pi，Pi 将分身参考资料和当前对话经加密隧道交给 Mac 生成回复。Mac 不运行线上网站或实验数据库，Pi 不启动本地模型或云端回退。实际上线进度和已完成的设备检查见 [验证记录](VERIFICATION.md)。

Mac 使用 `qwen3.5:27b`（Q4_K_M），模型清单摘要固定为 `7653528ba5cba4dd8e19da24aaddc7f4d0b5ecd93571c0825dfd4137958ec06e`。切换模型时须同时更新 Mac 配置的模型名和摘要、Pi 的精确模型名；本机质量与延迟另行验收，不能沿用旧 Pi 模型的数字。

## Mac 模型与私有连接

模型端口只绑定回环地址：Mac Ollama 为 `127.0.0.1:11440`，Mac 鉴权网关为 `127.0.0.1:11441`；Mac 发起 SSH 反向连接，在 Pi 上提供 `127.0.0.1:11441`。Pi 应用只调用这个本机入口，跨设备的数据由 SSH 加密；模型端口不开放到公网或局域网。所有查询和生成请求均需 Bearer 令牌，令牌只在服务端保存，不进入网页、URL、命令行参数或公开仓库。

Mac 将配置保存在项目 `.local/private-model/config.json`，文件须属于运行用户、权限 `0600`，且不能是符号链接。先核验模型、摘要并填写随机令牌，再启动服务；示意内容如下：

```json
{
  "upstream": "http://127.0.0.1:11440",
  "model": "qwen3.5:27b",
  "modelDigest": "填写已核验权重的64位SHA256摘要",
  "token": "填写自行生成的至少32字符私有随机令牌",
  "port": 11441
}
```

先准备专用 Ollama 运行时、已下载模型和核验后的权重摘要。网关没有 pull、create、delete 或任意转发接口，服务启动不会自动下载模型。专用 SSH 私钥和已核验的 Pi 主机公钥分别放在 `.local/private-model/ssh_ed25519` 与 `.local/private-model/known_hosts`，权限均为 `0600`。Pi 的授权公钥只允许项目反向端口，拒绝 shell 与其他端口；详细公钥选项见 [Mac 安装说明](../deploy/macos/README.md)。不要关闭主机公钥校验或自动接受未知主机。

在 Mac 项目根目录，以登录用户运行安装器，不使用 `sudo`：

```sh
python3 deploy/macos/install-model-service.py \
  --root "$PWD" \
  --config "$PWD/.local/private-model/config.json" \
  --pi-host YOUR_VERIFIED_PI_HOST
```

安装器创建 `com.ai-self.model` 和 `com.ai-self.model-tunnel` 两个用户 LaunchAgent，配置登录后启动和进程退出后重启。模型监督器只启动专用 Ollama，用不含对话的空请求预热并检查安装、驻留及配置摘要，然后启动网关；预热失败不会声称就绪。网关退出或模型连续失去就绪状态时，监督器退出，交给 launchd 重启。隧道固定主机公钥，带连接超时和心跳，断线后由 launchd 重连。为使后台 SSH 不依赖桌面目录权限，安装器将本项目凭据复制到 `~/.ssh/ai_self_model_ed25519` 和 `~/.ssh/ai_self_model_known_hosts`；遇到同名不同内容的文件会停止，不覆盖其他凭据。

这是登录后服务，不是登录前的系统守护进程。Mac 重启后需要用户登录，开机未登录、手动睡眠、系统升级、断电或网络中断均可能使 AI 暂时不可用。安装器不修改系统睡眠、FileVault 或断电开机策略。Mac 或隧道失联时，Pi 网站和既有记录仍可访问，主持人可整理资料，但不能创建新邀请；进行中的生成会按失败规则结束本局，不静默换模型。

```sh
launchctl print "gui/$(id -u)/com.ai-self.model"
launchctl print "gui/$(id -u)/com.ai-self.model-tunnel"
```

Mac 网关同时生成一条回复、最多排队两条；排队最长 10 秒，上游生成最长 45 秒，整次网关请求最长 55 秒。它们是限制资源和失败等待的配置值，不是实测响应时间。监督器与网关不记录参考资料、聊天、令牌或供应商原始错误，不要开启请求正文调试日志。日志目录与维护细节见 [Mac 安装说明](../deploy/macos/README.md)。

## 树莓派

使用 64 位 Raspberry Pi OS、Node.js 22，并在独立的 `~/ai-self-clone` 目录部署。项目运行时、数据库和隧道状态置于 `.local/`，缓存置于 `.cache/`，不复用其他项目的数据库或端口。当前私有模式不需要在 Pi 下载或运行模型。

部署设备为 Raspberry Pi 5 / 8GB。`ai-self-clone.service` 管理应用和项目 PostgreSQL，网页监听 `127.0.0.1:3100`。显式 `private-ollama` 会跳过 Pi 的 Ollama 启动；Mac 网关不就绪也不会触发本地回退。服务使用两个 CPU 核等效配额和较低调度优先级，内存不足时优先终止该服务。配置中的 4GB 内存上限需要系统启用 memory cgroup；此前设备检查未启用，不能视为已生效的硬上限。

`ai-self-tunnel.service` 单独运行用户态 `tailscaled`，身份为 `ai-self-clone`，state 与 socket 均位于项目 `.local/tailscale/`。它使用独立节点的 HTTPS 443，不修改系统原有的 wheelchair Serve 或 smartbox 443。当前节点在线、证书有效，`https://ai-self-clone.tail3d8705.ts.net` 已通过公网 HTTPS 及浏览器页面检查。首次发布曾出现 DNS NODATA，后续已存在有效的 A/AAAA 记录；部分公共解析结果仍有差异，记录见验证文档。设备需保持开机和联网。

环境文件 `.env` 不提交版本控制，权限设为 `0600`。主要配置：

```dotenv
STUDY_MODE=synthetic
APP_HOST=127.0.0.1
PORT=3100
APP_ORIGIN=https://YOUR_DEVICE.YOUR_TAILNET.ts.net
PORTAL_BOOTSTRAP_ENABLED=false
PLAY_MODEL_PROVIDER=private-ollama
PLAY_MODEL_BASE_URL=http://127.0.0.1:11441
PLAY_MODEL_NAME=qwen3.5:27b
PLAY_MODEL_API_KEY=填写Mac网关的私有随机令牌
PLAY_MODEL_RESIDENT=1
```

Pi 的精确模型名和令牌须与 Mac 配置一致。`PLAY_MODEL_RESIDENT=1` 不会在 Pi 启动模型，预热和驻留由 Mac 专用服务负责。私有就绪检查带认证访问 `/api/tags` 与 `/api/ps`，要求指定本地模型已安装且驻留；失联、认证失败或模型不一致都按不可用处理。模型或 provider 切换前须结束既有对局，不能在固定了旧模型的房间里静默切换。

数据库密码由启动脚本随机生成；不要复用 SSH 密码作为网站或数据库凭据。Pi 保留现有实验数据和口令，Mac 仅处理生成所需的参考与当前上下文，不复制或恢复 Mac 的开发数据库到线上。

首次部署流程：

1. 在 Mac 准备精确模型、私有配置和专用 SSH 公钥，按前述步骤安装两个 LaunchAgent；核验 Mac 网关与 Pi 回环隧道入口带认证可达。
2. 在 Pi 从官方来源安装项目内 Node ARM64，校验发布文件 SHA-256，执行 `npm ci`，配置私有模式 `.env`。Pi 不执行模型下载。
3. 在 Pi 执行隔离测试和 `npm run build`，再执行 `deploy/raspberry-pi/install-service.sh` 安装独立 `ai-self-clone` systemd 服务。
4. 执行 `deploy/raspberry-pi/install-tunnel.sh`，通过项目 socket 登录独立节点，再配置 Funnel 并验证公网 DNS、HTTPS、Cookie 和邀请。该公网网页隧道与 Mac 发起的 SSH 模型隧道是两个独立服务。
5. 用临时测试数据验证真实私有模型、五轮流程和断线不回退，再恢复接待；测试通过范围和模型质量分别记录。

从项目根目录操作独立隧道：

```sh
tailscale --socket="$PWD/.local/tailscale/tailscaled.sock" up \
  --login-server=https://login.tailscale.com:443 \
  --hostname=ai-self-clone --accept-dns=false --accept-routes=false
tailscale --socket="$PWD/.local/tailscale/tailscaled.sock" funnel --bg --https=443 http://127.0.0.1:3100
```

Tailnet 策略中的 Funnel 能力仅授予新节点（配置时将 `YOUR_IP` 替换为该节点地址），不扩大到其他节点。此实例不接管系统 DNS 或子网路由；所有项目隧道命令都必须使用上述 socket。

Pi 服务自动启动数据库、迁移、合成 seed 与网站，私有模式跳过项目本地模型；五轮游戏账号独立于研究员初始化。生产研究 live 模式仍被阻断。部署过程不导入开发机上的数据库或研究输入。

维护命令：

```sh
systemctl status ai-self-clone ai-self-tunnel
journalctl -u ai-self-clone -n 50 --no-pager
sudo systemctl restart ai-self-clone
```

更新按以下顺序执行：

1. 核对没有 `WAITING`、`ACTIVE` 或 `GUESSING` 房间，再安排停止应用。不要中断正在参与的对局。
2. 在 Mac 按下方“代码备份”说明归档树莓派当前部署的 Git 提交，确认归档成功后再更新。
3. 在树莓派执行 `sudo systemctl stop ai-self-clone`，只更新版本化代码。保留 `.env`、原数据库与口令、项目运行时和隧道状态；不要覆盖或清空 `.local/`，也不要重置独立隧道。树莓派不保留旧源码副本或旧构建回滚目录。
4. 若更新模型或网关，在无活跃对局时先更新 Mac 服务，核验模型摘要、安装和驻留，再同步 Pi 的精确模型配置。模型令牌只通过私有文件或进程环境交给检查脚本，不写进终端参数或日志。
5. Pi 依赖锁有变化时先执行 `npm ci`，然后依次执行 `npm run db:generate`、`npm run test:isolated`、`npm run build`，通过后执行 `sudo systemctl start ai-self-clone`。不从 Mac 复制 `node_modules`。检查服务状态、HTTPS 页面及真实私有模型游戏流程后，恢复接待。

`npm run clean` 只在服务和测试停止时运行；它会删除生产构建，需要重新构建后启动。清理不删除 `.local/postgres`、数据库密码、模型或 Tailscale 状态；应用数据删除需使用专门的删除流程。

更新失败时，从 Mac 的代码归档重新发送既有代码到树莓派，在原环境中安装依赖、重新构建并启动；不依赖树莓派上的旧目录。先确认旧代码兼容当前数据库结构，必要时修复代码后重建。此恢复流程绝不恢复或覆盖参与数据库，也不回滚数据库迁移，避免重新引入已删除的参与资料。

风格提炼更新包含 migration `202609160002_play_style_distillation`，仅新增示例称呼与风格档案字段。树莓派停止 `ai-self-clone` 时，其自有 PostgreSQL 也会停止；此时先更新代码、运行隔离测试并构建 `.cache/next`，再启动服务，由 `start-local` 启动原数据库并执行迁移。只有数据库已运行且配置了 `DATABASE_URL` 时，才单独运行 `npm run db:migrate`。旧资料在读取时兼容提炼，重新保存后持久化，建议主持人核对识别对象并试聊。GitHub 代码推送本身不会更新正在运行的树莓派服务。

分组分配更新还会新增每位主持人的持久分配状态。部署时执行随版本提供的数据库迁移，保留旧资料和房间；新规则只用于更新后新建的邀请，旧房间身份不变、完成旧局不消耗新组名额。每组 5 局完整对话随机安排 1–2 局 HUMAN，其余为 AI，跨组最多连续 4 局 AI；同一局五轮身份始终固定。

第五条来源回复与分配进度在同一事务中保存，进入等待猜测即消耗名额。未完成五轮的取消、超时或删除不消耗，下次邀请沿用该身份；完整对话之后删除房间不回退。维护、资料更新或服务重启时不要重置分配状态，也不要根据剩余房间数量重建配额。删除整个游戏账号时该状态随账号一并清除。分配已改变旧版每局独立 50/50 的基线，分析和部署记录须区分版本；验收应覆盖真人和 AI 完成、重试、并发、取消、删除、旧局衔接及跨组连续 AI 上限。服务端保存的未来顺序不进入朋友响应或网页。

真实 HTTP 检查沿用生产构建，但自行创建并清理临时 schema，不在正式实验表创建测试账号。先在受控进程环境加载 Pi 的模型地址、令牌、精确模型名与数据库连接，再运行：

```sh
PLAY_SMOKE_PROVIDER=private-ollama \
PLAY_SMOKE_BUILD_DIR=.cache/next \
node --import tsx scripts/testing/smoke-play.ts
```

如需明确覆盖模型，只设置 `PLAY_SMOKE_MODEL`，并使它与网关允许的模型一致。脚本会带认证核验指定模型已安装并驻留，保留本人和真实 AI 各五轮、幂等、盲态及清理检查；不可用时不会跳过 AI 或借用本地模型假通过。质量判断另用合成案例与真实本人保留样本检查，不能由流程通过推断。

### 旧 Pi 本机模型检查（历史记录）

2026-09-17 的上一架构由 Pi 运行 Qwen3.5 4B（Q4_K_M），此前为 0.8B。当时两核等效 CPU 配额不变，观察到模型驻留约占 3.7GB、设备可用内存约 2.5GB；独立预热约 51 秒。该版本七例合成检查约 24–52 秒，连续五轮 HTTP 验收约 9–44 秒/轮。这些只对应当时的 Pi、模型与请求，不能代表新的 Mac 模型、当前资源占用或模仿质量；完整历史限制保留在 [验证记录](VERIFICATION.md)。

### 可选临时备用：Cloudflare Quick Tunnel

此备用方案**尚未启用**。官方 `cloudflared` 程序已下载并校验；启用前需确认允许昵称、聊天等网页请求经过 Cloudflare，并在参与说明中明确网络服务商的数据处理。确认后，由项目所有者从项目根目录执行：

```sh
deploy/raspberry-pi/start-quick-tunnel.sh
journalctl -u ai-self-quick-tunnel -n 40 --no-pager
```

脚本创建临时 `ai-self-quick-tunnel` 服务，将请求转发至 `127.0.0.1:3100`。将日志中的完整 HTTPS 源地址填入 `.env` 的 `APP_ORIGIN`，重启 `ai-self-clone`，核实外网 HTTPS、邀请、Cookie 与真实回复后，才能更新网页入口。此隧道重启会更换 URL，设备重启后不会自动恢复，不是固定的生产地址；届时也须让参与者知晓实际转发服务。

停止备用入口使用 `sudo systemctl stop ai-self-quick-tunnel`，不影响项目数据库或系统原有隧道。

## 参与资料与备份

中英文页面使用相同的数据政策：昵称或随机用户名参与，无需真实姓名、邮箱或手机号；资料仅用于本实验及相关分析，实验与分析完成后由项目负责人删除，个人信息不公开。网页和实验记录保存在 Pi，参考资料和当前对话经加密连接送到项目 Mac 的本机模型，不使用云端模型。表达习惯归纳发生在语料和提示层，不训练基础模型权重；AI 回复不会自动成为表达示例或训练资料。

主持人可删除自助注册的游戏账号及全部关联资料，朋友可删除当前整局数据，包括双方消息；两种删除均不可恢复。仅结束对局、退出登录或清理构建缓存不会删除参与数据。删除回归及各版本完整套件的执行结果见 [验证记录](VERIFICATION.md)，历史测试计数不代表当前部署已完成同样检查。

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

Compose 将上述环境配置传入应用，默认模型模式为 `compatible`，需填写可访问的 HTTPS API 根地址、模型名和 API key。镜像不包含 Ollama，容器内 `127.0.0.1` 指向应用容器，不能直接复用宿主机的 Ollama 或 SSH 隧道回环地址。当前 Mac 模型 / Pi 网站采用前述主机上的 `start:local` 方式，不能仅把容器 provider 改为 `private-ollama` 就复用该隧道。

Compose 默认只绑定宿主机回环地址，异地部署还需 HTTPS 代理与匹配的 `APP_ORIGIN`。容器只含生产依赖，`npm start` 使用外部 PostgreSQL；`npm run start:local` 自动管理项目内 PostgreSQL。

## GitHub

- `docs/` 作为 Pages 发布目录；源代码仓库保持独立 public。
- `docs/index.html` 直接提供游戏和完整隐私链接，不依赖脚本切换“待上线”状态；更换游戏地址时更新 HTML 中的对应链接，脚本会沿用主入口并附加语言参数。
- 页面引用的 JS/CSS 带内容版本参数。修改静态资源后，同步更新 `index.html` 中的 `?v=` 值，避免 GitHub Pages 的旧缓存延迟显示新内容。首页按钮下的副文案已移除。
- `deploy/github-actions-ci.yml` 是 CI 模板。当前发布凭据缺少 `workflow` 权限，未启用自动工作流；本地完整验收不依赖它。
- `.env`、`.local/`、密钥、数据库和模型不会上传。原始研究输入统一保存在被忽略的 `.local/research-inputs/`。
