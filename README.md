# AI Self · 猜猜我是谁

用五轮文字对话，研究人与 AI、真人的互动。参与者判断回复来自本人还是 AI，结束后揭晓；页面支持中文与 English 切换。

**[打开网页](https://liqianyouy.github.io/ai-self-clone/)**

**[直接进入在线实验](https://ai-self-clone.tail3d8705.ts.net/play)**

网页入口由 GitHub Pages 展示，完整实验部署在独立树莓派服务，参与者直接用浏览器打开，无需下载项目或运行终端。Mac 与树莓派均通过 150 项回归和生产构建。Tailscale 公网 HTTPS 与游戏页面已验证可访问；此前部分公共 DNS 查询结果有差异，可能影响个别网络。Cloudflare 备用未启用。树莓派需要保持开机联网，详见 [验证记录](guide/VERIFICATION.md)。

## 使用

1. 主持人使用昵称或随机用户名注册，提供几段不含身份信息的对话示例。
2. 上线并创建邀请，把链接发给朋友。朋友无需注册，确认参与后进入聊天。
3. 每局随机由本人或 AI 回复，五轮后朋友提交猜测，再揭晓。

页面保持打开即可维持在线状态；小型本地模型不保证准确模仿真人。原有 Research / Target / Friend 门户保留，研究演练与五轮实验数据分开。

本人风格提炼已于 2026-09-17 部署到树莓派：保存时识别本人发言、提取表达习惯，回复时选择相关原话示例；主持人可试聊并手动纠正，保存后用于新局。树莓派继续使用本机 Qwen3.5 0.8B，Mac 的 4B 检查结果不能代替设备验证，详见[验证记录](guide/VERIFICATION.md)。这是语料与上下文层的学习，不是基础模型权重微调。

## 参与与数据

本实验仅用于 AI 与真人互动研究，不要求真实姓名、邮箱或手机号，请勿填写可识别身份的信息。资料仅用于本实验及相关分析，实验与分析结束后由项目负责人删除，个人信息不公开；参与者可随时结束。

主持人可删除自助注册的游戏账号及全部关联资料，朋友可删除当前整局数据；仅结束对局或退出登录不会删除记录。聊天保存在部署设备，由本机 Ollama 处理。前后端备份及 GitHub 发布仅包含代码，不上传参与数据、数据库、原始资料或密钥。正式研究仍受独立审批和配置门槛约束。

## 项目结构

| 目录       | 内容                                                  |
| ---------- | ----------------------------------------------------- |
| `src/`     | 网页、业务代码和服务入口 `src/server/main.ts`         |
| `prisma/`  | 数据模型和迁移                                        |
| `tests/`   | 回归测试源码                                          |
| `scripts/` | 启动、模型管理和清理；验收工具位于 `scripts/testing/` |
| `deploy/`  | Docker、Compose、树莓派服务和 CI 模板                 |
| `docs/`    | GitHub Pages 网页                                     |
| `guide/`   | 合并后的功能、架构、部署与验证文档                    |
| `.cache/`  | 可重新生成的构建和测试产物，已忽略                    |
| `.local/`  | 本机数据库、模型及原始资料，已忽略，清理命令不会删除  |

根目录仅保留 npm / Next.js 必需的配置入口。`package-lock.json` 固定依赖版本，不能当缓存删除。

## 本地开发与检查

需要 Node.js 22。仅开发者需要运行以下命令，在线访客不需要。

```sh
npm ci
npm run dev
```

打开 `http://127.0.0.1:3000`。首次准备本机模型使用 `npm run model:setup`。配置外部 PostgreSQL 或兼容 AI 接口时，参照 `.env.example`。

```sh
npm run typecheck
npm run test:isolated
npm run build:isolated
PORTALS_SMOKE_BUILD_DIR=.cache/production npm run test:isolated -- verify:production test:portals:http
# 停止本地服务与测试后清理所有可再生缓存和测试产物：
npm run clean
```

隔离测试会自动建立临时 PostgreSQL，结束后清除测试库，不连接用户的 `.local` 数据库。清理保留测试源码、依赖、数据库与模型；清理后启动生产服务前需重新 `npm run build`。

- [功能与流程](guide/FEATURES.md)
- [架构与数据边界](guide/ARCHITECTURE.md)
- [部署与维护](guide/DEPLOYMENT.md)
- [验证与修复记录](guide/VERIFICATION.md)
