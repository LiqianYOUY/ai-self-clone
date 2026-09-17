# Mac 模型服务

Mac 只运行 Ollama、鉴权网关和到树莓派的 SSH 反向隧道，不运行网站或数据库。网页入口、游戏记录和邀请仍由树莓派提供；当前资料和对话上下文通过加密连接交给 Mac 模型，界面据实说明这一数据路径。

固定端口为：Mac Ollama `127.0.0.1:11440`，Mac 网关 `127.0.0.1:11441`，树莓派隧道入口 `127.0.0.1:11441`。两端模型端口均不监听公网或局域网地址。树莓派使用显式 `private-ollama` provider；普通 `ollama` 仍只表示同一台机器的本机推理。

## 私有配置

Mac 将配置存为项目 `.local/private-model/config.json`，文件必须属于运行用户、权限为 `0600` 且不能是符号链接。示意结构如下；用自行生成的随机 token 和实际模型 digest 替换示意值，不提交到 Git：

```json
{
  "upstream": "http://127.0.0.1:11440",
  "model": "qwen3.5:9b",
  "modelDigest": "填写已核验模型的64位SHA256摘要",
  "token": "填写至少32字符的私有随机令牌",
  "port": 11441
}
```

树莓派 `.env` 使用同一个 token 和精确模型名：

```dotenv
PLAY_MODEL_PROVIDER=private-ollama
PLAY_MODEL_BASE_URL=http://127.0.0.1:11441
PLAY_MODEL_NAME=qwen3.5:9b
PLAY_MODEL_API_KEY=填写Mac网关的私有随机令牌
PLAY_MODEL_RESIDENT=1
```

私网 provider 不启动树莓派 Ollama，也不自动回退到其他模型。新房间固定 provider 和模型名；切换前确认没有进行中的对局。网关按配置 digest 核验已安装及驻留模型，防止同名标签在当前部署中指向未确认的权重。

## 受限 SSH 公钥

专用私钥放在 Mac `.local/private-model/ssh_ed25519`，权限 `0600`；已核验的 Pi 主机公钥放在同目录 `known_hosts`，禁止自动接受未知主机。树莓派对应公钥仅追加到该项目维护账号的 `authorized_keys`，保留其他条目。公钥选项为：

```text
restrict,port-forwarding,permitlisten="127.0.0.1:11441",permitopen="127.0.0.1:1",command="/bin/false" ssh-ed25519 公钥内容 ai-self-mac-model-forward
```

`permitlisten` 只允许项目反向端口；`permitopen` 将正向连接限制到未监听的回环端口 1，forced command 拒绝 shell。不要写 `permitopen="none"`，它不是 `authorized_keys` 此选项接受的 `host:port` 格式。验证专用 key 无法执行命令、反向监听其他端口或正向连接网页端口。参考 [OpenSSH 公钥选项](https://man.openbsd.org/sshd.8)。

## 常驻运行

先在专用端口准备模型并核验 digest。网关不提供 pull、create、delete 或任意代理接口，服务启动不会自动下载模型。确认 Node.js、项目依赖和 Mac Ollama 已安装，然后以登录用户运行：

```sh
python3 deploy/macos/install-model-service.py \
  --root "$PWD" \
  --config "$PWD/.local/private-model/config.json" \
  --pi-host 填写已核验的树莓派地址
```

安装器仅创建 `com.ai-self.model`、`com.ai-self.model-tunnel` 两个用户 LaunchAgent。为避免后台 SSH 依赖桌面目录访问许可，安装时将专用私钥和主机公钥分别写入 `~/.ssh/ai_self_model_ed25519` 与 `~/.ssh/ai_self_model_known_hosts`，权限为 `0600`；若已有同名不同内容的文件则停止，不覆盖其他凭据。监督进程先启动项目专用 Ollama、预热并验证模型，再启动网关；模型连续失去就绪状态或网关退出时，进程退出并由 launchd 重新拉起。SSH 连接使用心跳、连接超时、固定主机公钥和断线重连。

这些是登录后启动的用户服务，并非登录前系统守护服务。重启后需要用户登录；Mac 必须开机联网，手动睡眠、系统升级或断电会令 AI 暂时不可用。安装器不修改系统睡眠、FileVault 或断电开机策略。网页和既有记录仍可访问，模型恢复就绪前不能创建新的实验邀请。

```sh
launchctl print "gui/$(id -u)/com.ai-self.model"
launchctl print "gui/$(id -u)/com.ai-self.model-tunnel"
```

日志位于 Mac `.local/private-model/logs/`；监督器与网关不记录聊天、参考资料、认证令牌或供应商原始错误。Ollama 日志为项目 `.local/ollama.log`。不要开启会记录请求正文的代理或调试日志。

网关仅接受带令牌的 `/api/tags`、`/api/ps`、非流式 `/api/chat`；固定本地模型、关闭 thinking、温度 0 和内存驻留。聊天同时执行一条，最多等待两条，排队最长十秒；上游生成最长 45 秒、整次网关请求最长 55 秒。队列满、断线、取消或超时会返回受控失败，不能当作无限并发服务。

## 更新与验证

代码备份仅放 Mac `.local/code-backups/`。更新网关或切换模型前确认没有活动对局；重启 Mac 的模型服务并核验私网就绪，再更新树莓派配置。保留树莓派数据库和口令，不复制或恢复 Mac 开发数据库。

真实五轮检查在树莓派运行，使用临时 schema，不创建正式测试账号：

```sh
PLAY_SMOKE_PROVIDER=private-ollama \
PLAY_SMOKE_BUILD_DIR=.cache/next \
node --import tsx scripts/testing/smoke-play.ts
```

检查还应包括：错误 token 被拒、其他模型被拒、所有模型端口只绑定回环、Mac 网关和 SSH 进程退出后恢复、断开隧道时 provider 不就绪、测试结束后临时 schema 清理。真实吞吐、响应时间与模仿质量须另外测量；服务可用不等同于准确复刻本人。
