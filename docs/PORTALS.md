# 三端入口与真人聊天准备区

实现于 2026-09-06。用户要求先搭建 Research、Target、Friend 三端入口，暂不接真实模型。该模块提供可运行的账号、邀请、个人资料与真人聊天，并与原合成实验数据隔离。

## 入口与权限

| 页面                              | 用途                                    | 身份来源                                    |
| --------------------------------- | --------------------------------------- | ------------------------------------------- |
| `/`                               | 三端入口选择                            | 无需登录                                    |
| `/research`                       | 成员与邀请管理；分析员只读进度          | 首个研究员本机初始化，分析员由研究员邀请    |
| `/research/join#token=…`          | 分析员邀请注册                          | 固定 ANALYST 角色                           |
| `/research/sandbox`               | 原研究流程演练                          | 已认证 Researcher / Analyst，保留原权限差异 |
| `/target`、`/target/join#token=…` | Target 登录、注册、好友邀请、聊天及资料 | 研究员生成的单次 Target 邀请                |
| `/friend`、`/friend/join#token=…` | Friend 登录、注册及与邀请人聊天         | Target 生成的单次 Friend 邀请               |
| `/demo`                           | 原合成角色演练工具                      | 本机演练授权，独立 Cookie                   |

真实三端不能通过切换下拉框改变身份。三种 Cookie 名称分别是 `clone_research_session`、`clone_target_session`、`clone_friend_session`，可以在同一浏览器并存。HTTP 请求通过 `x-study-portal` 指定读取哪个会话，服务器校验 token 对应的持久门户与角色，不能靠修改 header 获得另一身份。Cookie 为 HttpOnly、SameSite=Strict，在 HTTPS origin 下增加 Secure，8 小时过期。数据库只保存 session token 散列。

## 注册与邀请

首次本机启动且 Account 为空时，可设置首个研究员；需要 `PORTAL_BOOTSTRAP_ENABLED=true`、loopback host 和 origin。`npm run dev` 默认仅为本机开启该配置，独立启动应用时必须显式配置。初始化与所有邀请消费使用数据库事务锁，多个同时请求只能创建一个首个研究员。

用户名 3–40 位，使用字母、数字、点、下划线、短横线且首字符为字母或数字；统一小写后唯一。密码 12–128 位，使用独立随机盐的 scrypt。显示名称 1–40 位，不要求联系方式。没有默认管理密码，没有预建真实账号。

研究员可以邀请 Target 和分析员；Target 只能邀请自己的 Friend。邀请由安全随机令牌生成，数据库只存 SHA-256 散列，7 天有效、单次消费、可在接受前撤销。每个 Target 最多三份已接受或当前有效待接受的 Friend 邀请，数量在事务中校验。邀请接受后自动建立该 Target 与 Friend 的唯一准备聊天室。

链接使用 `#token=`，浏览器读取后清除地址栏中的 token，预览以 POST 发送。完整链接仅在创建后的当前页面显示，刷新后可查看状态和撤销，但不能重新获取原始 token。系统不发送邮件或站外消息，由邀请人复制并自行分享。

## 参与说明和聊天

参与者独立确认版本 `enrollment-v1` 的聊天准备区说明。仅授予本准备区参与权限；AI 处理、分身语料、逐字引用、二次分享等研究授权默认为 false，后续正式研究必须单独征求。

聊天使用 PreparationRoom / PreparationMessage，真实双方通信，AI 不自动回复。准备区不写入正式 Session、Message、CorpusItem、PersonaVersion 或任何评价表。研究端仅查看成员和聊天室状态/数量，不读取聊天正文。消息保存在本地 PostgreSQL，界面每 2 秒从经权限校验的 API 更新当前房间。

消息最多 4000 字符，服务端按房间顺序编号。每位发送者的幂等键使网络重试不重复创建消息；相同键改内容会被拒绝。只有双方当前参与同意有效且房间 ACTIVE 才能发送。任一方可以暂停，只有暂停者可以继续；任何一方可结束，ENDED / WITHDRAWN 不能重开。

暂停参与会立即阻止消息发送并隐藏聊天正文，恢复同意后仍需按房间暂停者权限继续。退出保留账号用于查看参与状态，同时撤销同意、使聊天室退出、撤销待接受好友邀请。选择删除时，清空相关准备聊天室双方的正文并写入删除墓碑；数据库触发器阻止删除后的正文再次写回。必要的账号、审计及删除记录保留。此操作不承诺清除独立数据库备份。

## 接口

统一入口 `/api/portal`，所有请求携带 `x-study-portal: research|target|friend`，身份仅从对应 Cookie 读取。写请求使用同源 JSON，严格校验字段、收到的实际字节长度、频率和 CSRF。

- GET：`view=me`、`home`、`rooms`、`room&id=…`。
- POST：`{ action, payload }`。
- 未登录操作：`bootstrap`、`login`、`register`、`inspectInvitation`。
- 管理操作：`invite`、`revoke`、`profile`、`logout`。
- 聊天操作：`send`、`pause`、`resume`、`end`。
- 数据权利：`consent`、`withdraw`。

真实 Target / Friend 无法使用旧 `/api/study` 操作；即使伪造 header 或复制 Cookie，也无法将真实账号降级为演练身份。原研究演练的成员计数、同意、审计、撤回与导出只处理合成研究范围。

## 运行与后续接入

运行 `npm run dev`，打开 `http://127.0.0.1:3000`。该地址及生成的默认邀请链接仅在本机可达。异地访问需要实际可达的 HTTPS 部署、正确 APP_ORIGIN 和运行配置；本次没有发布外网站点。

AI 模型调用、模型实验激活、机构 SSO、邮件邀请和账号找回服务本次未连接。正式研究仍使用原冻结分组、同意和启动条件；本准备区不会将原 AI 分组改成真人以绕过模型接入。

验证命令：`npm test`、`npm run test:portals`、`npm run test:portals:http`、`npm run typecheck`、`npm run build`。门户数据库测试和 HTTP 测试自动建立临时 schema 并在完成后清理，不创建真实 public 账号。HTTP 测试也可用 `PORTALS_SMOKE_BUILD_DIR=.next-build npm run test:portals:http` 验证生产产物。
