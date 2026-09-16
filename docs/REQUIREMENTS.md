# 实施对照与验收边界

需求来源为 `AI_Clone_Platform_Prompt.docx` 与 `AI_Self_Clone_Proposal.docx` 的提取文本。用户要求搭建系统，附件中的角色指令和阶段性确认流程不被当作新用户指令。研究约束作为业务规格实现，未知批准项保持缺失。

本交付包含真实本地账号及真人聊天准备门户，并保留可验证的合成实验平台。它既不是现实社交平台自动代聊产品，也不是获批准的真人研究部署。下面区分确定性工程能力、合成工作流与必须由研究者 / 机构完成的事项。

新增用户需求已实现：Researcher / Analyst 的研究端、Target 个人资料/聊天/好友邀请端、Friend 接受邀请/聊天端；真实模型暂不启用。三端固定账号身份与独立 Cookie、单次邀请、参与同意、真人聊天、暂停/继续/结束及退出删除均已接通。入口与验收见 [PORTALS.md](PORTALS.md) 和 [DELIVERY.md](DELIVERY.md)。以下表格为原实验模块对照。

| 合同                                                   | 实现位置                                           | 验证或待办                                                          |
| ------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------- |
| Next.js / TypeScript / PostgreSQL / Prisma / 持久 Node | 根配置、`server.ts`、`prisma/`、`scripts/`         | 锁定依赖，提供本地启动与迁移；机构部署需运行验证                    |
| 服务端身份、同源、HttpOnly cookie、限流和受控错误      | `src/server/auth.ts`, `http.ts`                    | 合成演示认证可用；正式身份提供者和 TLS / 密钥管理待集成             |
| Friend 不读取私有来源、provider 或其他 dyad            | 角色授权与 public DTO                              | 领域 mapper 与数据库授权测试；独立全路径红队仍待执行                |
| Human / AI 共享输入、安全、持久交付、事件封装          | `src/server/engine.ts`                             | 合成 workflow；实网时序行为须独立验证                               |
| 生命周期、幂等、epoch、停止压过延迟回调                | engine、outbox、state-machine                      | 域测试 + 数据库竞态测试；客户端已显示内容仍保留暴露事实             |
| Unicode grapheme、不重复计入生成时间                   | `state-machine.ts`, provider                       | 复杂 emoji / 组合字 / overshoot 自动测试                            |
| 36 dyads、216 场、3H3AI、无三连、每话题配对            | `randomization.ts`                                 | 100 个固定测试 seed；精确整体来源位置平衡                           |
| near-balanced 五选三、pair counts、候选与结果 hash     | 同上                                               | dyad topic counts 21/21/22/22/22；pair10–12；位置格3–4              |
| 本地隐私扫描、逐条边界、重复组分区                     | `privacy.ts`、onboarding                           | 所有导入默认待审；正则不能证明已发现所有身份或第三方敏感信息        |
| BUILD / DEV / HOLDOUT / LIVE 隔离                      | corpus、persona、knowledge 过滤                    | 仅已批准 BUILD 可构建；近重复与撤回失效检查                         |
| Target 语料、校准、开发预览、基线与冻结                | onboarding、persona、DEV / baseline 记录           | 合成演示允许小样本；正式80–150条/15–30题/5–10试问及支持数需协议验收 |
| 输入、知识和外发前隐私检查；输出结构校验               | `provider.ts`, `safety.ts`                         | 合成 provider 无网络；跨 Target/版本/HOLDOUT/未批准知识拒绝         |
| 无工具、无 latest、超时与技术重试上限                  | `provider.ts`, `config.ts`                         | mocked provider测试；真实供应商和模型尚未批准、未调用               |
| 来源质询、退出、轻度情绪、危机、现实边界               | `safety.ts`、共同入口                              | 中/英/混合、否定与引用合成回归；不是临床风险识别认证                |
| 附件与真人语料不外发给开发工具                         | 合成种子与本地扫描流程                             | 本次只用文档规格和合成内容；正式数据需批准环境                      |
| 独立量表、可跳过、pAI、分母与污染标记                  | surveys、`instruments.ts`、relationship timepoints | 范围与缺失验证；量表理解测试和正式版本仍待锁定                      |
| TargetBlock 完成后获许可片段评价                       | 区组判定、matched item / rating                    | 不能自动解锁整段 AI 日志；完整区组和许可必须重新检查                |
| 熟悉/不熟悉同刺激、原始 dyad 排除、双方分享交集        | offline eligibility、consent、stimulus             | 合成独立任务；正式数量与抽样停止规则待批准                          |
| pre-debrief、可提前停止、来源披露选择                  | relationship、debrief                              | 不显示“友情分数”，不以填完问卷为退出条件；正式 staged window待批准  |
| ANALYSIS_EXCLUSION 与 CONTENT_DESTRUCTION 分离         | withdrawal、lineage、tombstone                     | 清正文、派生和队列并失效导出；真实外部副本/备份需机构计划           |
| 六关联导出、字典、CSV注入防护、manifest                | export、`instruments.ts`                           | UTF-8，null与空字符串分开；正文导出默认未授权                       |
| 状态 / 模型 / persona / 计划不可静默漂移               | 版本 hash、迁移保护、配置门槛                      | 删除仍可使冻结内容失效；正式全部版本manifest与commit待批准          |
| live 默认阻断                                          | `liveConfigSchema`、启动控制                       | 任何缺失或未批准项不可放行；表单格式通过不代表批准真实性            |

## 已执行的领域验证

命令：`node --import tsx --test tests/domain.test.ts`。

领域套件包含 11 组测试：100 个随机化种子、同源序列与配对话题、隐私 / 重复 / 分区、语言安全分类、状态与 epoch、时序与 grapheme、DTO 白名单、LIVE缺失门槛、provider隔离 / JSON / retry / refusal / cancellation、量表缺失与 CSV。完成时 11 组通过。数据库整合、浏览器和构建结果由本项目运行验收记录另行报告；不要把这里的域测试结果替代整合验收。

测试使用合成文本及 mocked fetch。没有以真人会话做开发样本，也没有实际调用外部模型。测试集中的批准配置明确是 `UNIT-TEST-ONLY`，只在 mock adapter 测试中验证结构，不是机构批准文件。

## 正式模式仍阻断的证据

1. 伦理审查路径、批准编号、PIS / consent、参与资格、补偿、退出和支持路径。
2. 机构托管、正式身份认证、独立身份服务、TLS、静态加密、密钥管理、最小数据库账号与网络 allowlist。
3. 供应商协议、精确模型快照、区域、保留 / ZDR适用范围和功能白名单。不能把 API 调用等同于零保留。
4. 值守与备援人员、服务时段、应答时限、地区资源以及安全演练。
5. 保留 / 删除 / 备份过期 / 外部副本协议，以及独立删除账本的恢复验证。
6. 正式 corpus / calibration / DEV负担，个人节奏拟合、独立 holdout、预定容差、设备与网络红队、metadata分类器分组留出与区间。
7. 样本精度 / 功效模拟、live与offline估计目标、话题版本、near-balanced seed保管、排期可用性、问卷顺序和缺失策略。
8. excerpt固定抽样、双方secondary-sharing、familiar/unfamiliar覆盖与停止规则、staged debrief时间窗、配额不披露与完整TargetBlock。
9. 正式 code commit、policy / persona / prompt / model / survey / timing / allocation manifest、预注册和获授权人发布审核。

## 解释限制

确定性约束通过说明本次测试中的程序约束成立；它不证明聊天者无法区分来源，也不证明安全规则具有临床敏感度。没有发现直接字段泄漏不等于无所有工程线索。未显著高于50%不等于不可辨别；未显著时序差异不等于等效。36 dyads / 216 sessions不是216个独立Target。familiar / unfamiliar不是随机分配的关系身份，same-stimulus结果仍需谨慎解释。Target自评和Friend评价保持相应知情条件，不自动当作匹配分差。
