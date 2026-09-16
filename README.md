# AI Self · 五轮猜真假

新增 `/play` 文字游戏：朋友通过邀请链接进入，与本人或 AI 分身聊五轮，再提交猜测并揭晓。直接复用项目已有的 Next.js、Postgres 和账号系统，不需要更换聊天模板。原来的 Research、Target、Friend 入口仍可使用。

## 试玩入口

1. 运行 `npm run dev`，打开 **http://127.0.0.1:3000/play**。
2. 注册一个主持人账号，或使用已有 Target 账号登录。自助注册的游戏账号不加入研究名单，也不阻止首次研究员初始化。
3. 保存一页分身资料：显示名、个人背景、说话习惯、可使用的记忆及精选对话示例。资料在创建房间时固定快照，后续编辑只影响新局。
4. 首次运行 `npm run model:setup`，准备本机 Ollama 和 Qwen3.5 4B 模型（约 3.4GB）。完成后重新运行 `npm run dev`，本地模型服务会自动启动。默认不需要 `.env` 或 API 密钥，模型未就绪时仍可编辑资料，但不能创建邀请。
5. 上线并创建邀请，将链接自行分享给朋友。朋友填昵称、了解玩法后加入，无须注册账号。每局随机分配本人或 AI，五问五答后猜测并揭晓。

主持人保持游戏页面打开，一次只进行一局。本人局在回复台发送消息，AI 局由模型自动回复。朋友端两种模式使用同一消息格式和轮询方式，不逐字展示生成过程。模型短暂失败或回复截断时最多重试一次；主持人离线、回复超时或重试后仍失败时结束本局，不切换回复来源。已完成的对局分别统计 AI 被猜成本人的比例和本人被正确认出的比例。

首版使用一个网页服务、现有 Postgres 和本机模型，无需新增 Redis、向量数据库或训练 GPU。默认模型处理不上传云端；模型与便携运行时保存在 `.local` 中，安装过程需要联网下载。也可通过 `.env` 显式选择其他兼容接口。默认链接仅本机可达，远程朋友试玩需配置可访问的 HTTPS 部署与 `APP_ORIGIN`。详见 [文字盲测说明](docs/PLAY_MVP.md)。

## 原有研究与参与门户

依据两份研究文档实现的研究平台，现有三个独立门户：Research 供研究人员与分析人员管理参与者及邀请；Target 管理个人资料、邀请好友并聊天；Friend 接受邀请后加入专属聊天。支持真实本地账号及持久化真人聊天；AI 模型调用尚未启用。原有冻结实验与演练数据保留在独立的研究演练入口。

研究文档中的业务约束用于实现；文档内面向 coding agent 的分阶段交付要求不替代用户的搭建请求。本轮按用户要求先完成三端入口和真人参与流程，没有代填正式研究批准或调用真实模型。

依赖锁定于 `package-lock.json`：Next.js 16.3.4、React 19.2.8、Prisma 6.19.3、Socket.IO 4.8.3、Tailwind 4.3.3、TypeScript 7.0.2。本地 PostgreSQL 二进制由 embedded-postgres 18.4.0-beta.17 提供，容器演练使用独立 PostgreSQL 17。当前 migrations 包含初始研究模型、evaluation / debrief 扩展及 portal enrollment 扩展，后续结构变更须追加 migration。

## 启动

需要 Node.js 22 和 npm。macOS Apple Silicon 环境支持自动管理的本地 PostgreSQL；其他环境也可配置已有 PostgreSQL。

```sh
npm ci
npm run dev
```

打开 **http://127.0.0.1:3000**。请使用这一完整地址，服务检查精确 origin。启动脚本初始化 PostgreSQL、应用 Prisma migrations、幂等填入合成记录，然后启动持久 Node / Next / Socket.IO 服务。

1. 进入 `/research`，首次本机启动时创建研究员账号（用户名 3–40 位，密码至少 12 位）。初始化仅在账号表为空且本机配置允许时开放。
2. 研究员生成 Target 邀请链接，自行分享给受邀者；也可邀请分析人员。
3. Target 通过 `/target/join#token=…` 独立注册、确认准备区参与说明，在自己的空间邀请最多三位 Friend。
4. Friend 通过 `/friend/join#token=…` 独立注册并同意参与；系统自动建立与邀请人的专属真人聊天室。
5. 两端支持发送消息、刷新历史、暂停/继续、结束、修改资料和退出。三端 Cookie 独立，同一浏览器可以同时登录 Research、Target 和 Friend。

邀请有效期 7 天，仅可使用一次，未接受的邀请可撤销。链接使用 URL fragment，页面读取后清除地址栏中的令牌，预览通过 POST 提交。系统只生成可复制链接，不自动发送邮件或消息。默认地址仅本机可达；如需异地好友访问，需要另行部署到可访问的 HTTPS 地址并正确配置 `APP_ORIGIN`。

详细入口、数据边界与接口见 [docs/PORTALS.md](docs/PORTALS.md)。`/research/sandbox` 保留研究流程演练，真实准备区聊天不会进入实验语料、评分或冻结分组。`/demo` 是原合成角色演练工具，与真实门户使用独立登录。

本地数据库监听 `127.0.0.1:55432`，网页监听 `127.0.0.1:3000`。密码随机生成并以权限 `0600` 保存在 `.local/database-password`；数据库保存在 `.local/postgres`。退出程序保留记录，再次启动不会重置研究。不要将 `.local`、环境文件或数据库备份提交到版本库。

已有 PostgreSQL 可在 `.env` 设置 `DATABASE_URL`，然后仍使用 `npm run dev` 自动迁移并启动。仅独立启动应用时须先执行迁移与 seed：

```sh
cp .env.example .env
# 编辑 .env，配置 DATABASE_URL
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev:app
```

## 已实现边界

研究端服务负责分配、会话状态、同意、冻结、公共消息投影、待发送队列、评价与撤回，数据库不接受客户端声明的 actor 身份。账号密码使用独立随机盐的 scrypt 散列；角色由服务端不透明 session cookie 解析，token 仅存 SHA-256 散列；cookie 为 HttpOnly / SameSite=Strict，HTTPS origin 会加 Secure。每次 HTTP 操作及 WebSocket 读取重新检查认证与目标权限。写请求检查 origin、类型、长度与频率；错误响应仅提供受控提示。

Socket.IO 使用相同 origin 的 `/socket.io`，保留 polling transport；HTTP 轮询也读取相同公共投影。订阅协议为 `session:watch { sessionId }`，服务端通过 `session:update` 发出经权限过滤的 DTO，绝不直接广播 Prisma 对象。停止后的 outbox 由事务及 epoch 检查决定可交付性，浏览器不是最终闸门。

合成登录仅在 `STUDY_MODE=synthetic` 下有效，只接受 `demo-` 参与者。默认程序绑定 loopback；外部绑定必须提供至少 24 字符 `DEMO_ACCESS_TOKEN`，登录通过 `x-demo-access-token` 请求头提交。这个入口不提供正式研究身份认证。

## 验证与构建

```sh
npm run typecheck
npm run test:all
# 以下为按模块运行的入口：
npm test
npm run test:kernel
npm run test:evaluation
npm run test:portals
npm run test:play
npm run test:portals:http
npm run build
# 另一个终端保持 npm run dev 后，可做 HTTP / WebSocket 演练：
node --import tsx scripts/smoke-runtime.ts
node --import tsx scripts/smoke-navigation.ts
```

数据库集成测试连接已启动的本地合成 PostgreSQL（自动读取本地密码），或使用提供的 `DATABASE_URL`。测试自动创建独立 schema 并在完成后删除，不修改界面演练研究记录。不要使用包含真实参与者数据的数据库。测试与独立伦理、统计、时序、人员值守审查是不同的验收事项。

`test:all` 自动包含 `tests/*.test.ts` 下所有测试。[GitHub Actions 模板](docs/github-actions-ci.yml) 使用临时 PostgreSQL 执行类型检查、全量测试、生产构建和 HTTP 验证。发布令牌缺少 `workflow` 权限，因此模板尚未启用；具备该权限时可将它移至 `.github/workflows/ci.yml`。最近一次问题核查及修复范围见 [代码审查处理记录](docs/REVIEW_FIXES.md)。

生产构建可通过 `npm run build` 后 `npm start` 本地运行；它仍受合成模式限制。日志默认不包含正文和供应商 prompt。不要启用复制正文的 telemetry、第三方 error SDK 或 session replay。

生产启动所需 `tsx` 与迁移所需 Prisma CLI 均属于运行依赖；构建完成后可以 `npm prune --omit=dev`。容器仅复制运行文件与生产依赖，应用服务通过 `/api/health` 检查就绪状态。

保留开发服务时，可用 `NEXT_DIST_DIR=.next-build npm run build` 构建到独立目录，再运行 `node --import tsx scripts/verify-production.ts` 验证生产产物；该脚本临时使用 loopback 3300 并自动关闭。`GET /api/health` 仅报告数据库连接就绪状态，不返回研究配置或参与者信息。

## 容器演练

提供 `Dockerfile` 与 `compose.yaml`。在 `.env` 配置随机 `RESEARCH_DB_PASSWORD` 和至少 24 字符的 `DEMO_ACCESS_TOKEN`，执行：

```sh
docker compose up --build
```

映射端口仍仅在宿主机 loopback 可访问。镜像包含持久 Node 服务和独立 PostgreSQL volume；migration / seed 由一次性服务执行。浏览器登录须提交配置的演练访问 token。正式容器发布前，应把 Node / PostgreSQL 镜像标签替换为机构批准的不可变 digest，并验证构建和恢复流程；本地演练没有完成这些审批。

`identity-scaffold` profile 仅为身份数据库隔离脚手架，位于独立内部网络。应用没有该数据库凭据，也未连接该网络。本轮已实现应用内用户名/密码账号、固定角色、单次邀请及相关审计。真实联系方式、通知、机构 SSO / MFA、独立 service account 和机构身份系统仍需在实际部署时集成；本地账号不等同于机构 Identity Service。

## 正式研究仍被阻断

`STUDY_MODE` 改成 live 不会开启正式实验，服务会拒绝启动。当前三个门户的真人账号和准备聊天是独立模块，不受这个演练模式名称影响，也不会自动成为正式实验数据。文档要求的伦理编号、协议与 consent、供应商精确 snapshot / region / retention 协议、托管与加密、值守及备援、保留和备份删除政策、冻结测量与随机化、offline 评分负担及 staged debrief、独立时序与泄漏验收等配置都不能由开发者代填批准。

目前的模型响应和安全演练只处理合成数据。关键词或规则检查不等于临床危机识别；本地测试不证明来源不可分辨。真实 provider、通知链、备份清除期限和机构密钥管理需完成单独集成及演练。正式实验的批准条件、数据接收者与责任人明确后，才能启用模型实验及相应运行适配器。

仓库公开应用源码、测试和实现文档；原始研究输入、环境文件、本地数据库与模型文件不提交。网站部署、模型调用和通知均需另行配置。实际实现清单与协议测试以 `docs` 中的设计与验收材料、`prisma/schema.prisma` 和测试文件为准。

## 交付入口与开发流程

macOS 可双击根目录的 `启动研究平台.command`。系统当前已运行时，请直接访问页面，不必再次启动服务。

Target 的“分身构建”页面包含校准问题、DEV 预览和节奏练习。先构建一个新的草稿，再用 DEV 问题预览，最后冻结；独立留出禁止用于开发预览。练习只保存粗粒度时间和设备信息，不保存输入正文。

“自我—他者评价”与 offline 片段评价使用独立入口。Friend 可先批准自己原始 dyad 的具体片段与固定上下文；完整 Target 区组结束、双方当前同意和逐片段许可都满足后，才开放来源知情评价。匹配与生态记录分别保存，不向参与者展示对方答案。

额外验证命令：

```sh
npm run test:evaluation
npm run test:runtime
node --import tsx scripts/smoke-navigation.ts
```

本次交付范围、已执行检查和未部署事项见 `docs/DELIVERY.md`。构建与生产隔离验证可使用 `NEXT_DIST_DIR=.next-build npm run build`，随后在同一环境设置下启动服务；默认常规构建仍使用 `.next`。
