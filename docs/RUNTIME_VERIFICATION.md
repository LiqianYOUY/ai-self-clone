# 运行与认证验收记录

## 三端扩展的补充验收（2026-09-06）

- migration003 已应用于本机数据库，原合成研究记录保留，真实 Account 表初始为空。
- `npm test`：31/31 通过，含固定门户身份、独立 Cookie、CSRF、实际字节限制、邀请 POST 预览和禁止真实参与者降级到旧演练 API。
- PostgreSQL 门户 11/11、原内核 19/19、评价 6/6，共 36/36 通过；新增并发初始化、邀请一次性/过期/配额、跨房间权限、幂等、停止、同意和删除墓碑及数据隔离。
- `PORTALS_SMOKE_BUILD_DIR=.next-build npm run test:portals:http`：实际生产 HTTP 9/9 通过，三端 Cookie 并存、双向聊天、越权拒绝、暂停恢复和退出销毁。未产生 AI Generation 或正式 Session / Message 记录。
- 最终 `.next-build` 编译/类型检查/页面生成/build traces 通过；38 个 HTML/RSC/浏览器产物检查通过，无已知 seed 身份和正文、无公开 source maps。
- 临时生产服务健康检查、页面、RSC、未登录 API 拒绝及服务器源码/.env/数据库密码不可下载验证通过。
- 原角色导航与禁止访问 34/34 仍通过。浏览器实测 1265px 桌面与 390px 手机布局、研究登录与名单、Target 发送、Friend 收到、暂停恢复和邀请注册表。邀请令牌被读取后从地址栏移除。
- 所有新测试账号和聊天位于临时 PostgreSQL schema；HTTP 测试及 3302 UI 测试服务器结束后自动删除，public 未留下测试账号。

## 原实验演练验收

2026-09-06，在本机 macOS / Node.js 22.15.0 的合成研究数据库完成以下验证。测试不使用真实参与者内容。

- 本地自动 PostgreSQL 初始化、两次 Prisma migration、合成 seed、持久 Node / Next / Socket.IO 启动通过；重启保留研究记录并应用新增 migration。
- `npm run typecheck` 通过。
- `npm test`：16 / 16 通过，包含 11 项领域测试与 5 项网关测试。
- `node --import tsx scripts/smoke-runtime.ts`：10 / 10 通过，并在第二次 migration 后重新通过。
- `node --import tsx scripts/smoke-navigation.ts`：四种角色的导航、开发子模块及禁止访问检查 34 / 34 通过；`/api/health` 返回不含研究信息的 `{ "status": "ok" }`。
- 最终产品修改及合成 fixture 修复后，`NEXT_DIST_DIR=.next-build npm run build` 完整通过编译、TypeScript、静态页面生成与 build traces；原有开发服务保持运行。
- `node --import tsx scripts/verify-production.ts` 通过：25 个 HTML / RSC / 浏览器构建产物未发现检查范围内的合成人名、消息、参与者 ID 或分配 seed；没有生成浏览器 `.map` 文件或 sourceMappingURL 引用。
- 实际生产构建以临时 loopback 3300 启动成功；健康检查、首页、RSC 请求正常，未登录研究 API 返回 401，浏览器 source map、服务器源码、环境文件和本地数据库密码路径均返回 404。临时生产进程已关闭，开发服务未停止。
- 单独设置 `STUDY_MODE=live` 的启动检查以退出码 1 拒绝启动，显示正式身份、治理与运行适配器未批准。

HTTP / Socket.IO 实测覆盖：未登录返回 401；缺失及恶意 origin 返回 403；不透明 HttpOnly / SameSite cookie；Friend 公共字段无私有条件、分配、epoch 或模型元数据；跨 dyad 及研究分配查询拒绝；伪造 actor 请求拒绝；HTTP 与 WebSocket 同一公共 DTO；WebSocket 每次订阅重新授权；Socket.IO polling fallback；退出后旧 cookie 与活跃 socket 失效。

网关测试另外验证伪造 Content-Length 的多字节正文仍受实际字节数限制、无效 JSON 和频率超限被拒绝、内部异常内容和堆栈不进入响应。

导航验收发现开发模块的越权异常曾被识别为普通内部异常并返回 500，现已统一为受控 `ApiError` 并实测返回 403。Target 的评价入口使用独立 evaluations 工作流；其不适用的 offline familiarity 接口仍拒绝访问。已有合成数据库的旧 DEV / HOLDOUT 近重复 fixture 与校准题 ID 已通过有条件 seed 升级修复，没有重置研究记录或修改正常导入内容。

这些结果覆盖实际执行的合成工程路径。正式研究的独立时序与 metadata 分类验收、机构部署、TLS / 密钥管理、真实身份服务、值守通知、供应商协议及备份清除流程仍需按批准方案完成。Docker 文件是待验证的容器脚手架，本记录不声称已运行容器或完成正式发布。
