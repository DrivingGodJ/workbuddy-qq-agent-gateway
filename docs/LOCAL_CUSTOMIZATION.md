# 本地部署与可编辑结构

公开源码和自己的部署使用同一套代码。不要把账号、私人画像或运行数据写回公开模板；升级只同步源码，不覆盖实际配置与会话。

## 修改入口

| 想修改什么 | 编辑位置 | 何时生效 |
| --- | --- | --- |
| 网关网页与 Mac 客户端界面 | `modules/web-console/public/client.html`、`client.css`、`client.js` | 网页刷新；原生客户端重新构建 |
| 模型、模式、权限、通知订阅 | 网关面板 | 由后台保存；通常下一轮生效 |
| 可回复群聊 / 私聊白名单 | 网关左侧“Agent 群聊 / Agent 私聊”的“添加” | 加入后立即生效，写入私有 `runtime/qq-only-data/settings.json`；群聊须先让机器人入群 |
| 私聊共享群上下文 | 选择私聊 → 会话参数 → 共享群聊上下文 | 所有关联渠道空闲后保存；映射在私有 `context-links.json`，原私聊 thread 搁置保留，解绑恢复 |
| 私人身份、部署路径 | `config/qq-only.env` | 重启 Hub 与相关恢复服务 |
| 所有会话共用的人格核心和情境示例 | `config/private/persona/core.json`、`examples.json` | 重启 Hub 后加载到固定系统提示词，不逐轮追加为用户消息 |
| AI 昵称与固定口头禅 | 网关面板“人格” | 保存后从下一条消息 / 下一轮模型直接生效 |
| 通用人格模板 | `persona/core.json`、`examples.json` | 仅对未配置私人覆盖目录的部署生效 |
| QQ 工具与行为权限 | `src/qq`、`src/security` | 测试通过后重启 Hub |
| WorkBuddy 桥与执行参数 | `src/workbuddy`、`modules/workbuddy-agent/bridge.py` | 测试通过后重启 Hub |
| 日历 / 提醒事项动作 | `src/automation`、`scripts/macos-notification-action.js` | 相应脚本与权限检查生效 |

浏览器与原生客户端不再各存一份前端源文件。客户端构建只从网页目录复制资源到产物，不能反向覆盖源码。

## 私人人格覆盖

先创建以下文件，将自己的内容填进去：

~~~bash
mkdir -p config/private/persona
cp persona/core.json config/private/persona/core.json
cp persona/examples.json config/private/persona/examples.json
~~~

再在 `config/qq-only.env` 加入：

~~~bash
CODEX_REMOTE_CONTACT_PERSONA_DIR=config/private/persona
~~~

路径相对于项目根目录，也可用绝对路径。`core.json` 必须是包含非空 `name` 的 JSON 对象，`examples.json` 必须包含 `examples` 数组。配置缺失或损坏时拒绝启动，不悄悄回退至通用人格。

实际 env 按 Node 的 dotenv 格式读取，不执行 shell 命令或展开变量；路径应填写实际值。外部注入的同名环境变量优先。后台恢复与 Hub 均通过 Node 读取配置，避免 launchd shell 直接读取 Documents 时被 macOS 隐私保护拦截；这不绕过系统权限，Node 运行时本身仍需获得相应目录的读取授权。

PRIVATE 目录及实际 env 被 Git 忽略，公开发布审计也会拒绝收录。不要 `git add -f`。每日表达总结和样本采集已经移除；旧版 `persona-rules.json`、群关系与精力状态文件不再读取、写入或注入。升级后确认不需要恢复时，可自行将旧采样文件及旧备份移至项目外的废纸篓；不要删除在用的 WorkBuddy 会话上下文。

网关面板可修改共用 AI 昵称（2–16 个汉字、字母、数字或连接符）。保存后，纯文字喊名的激活词、机器人在消息中的称谓、系统人格提示一起更新；真实 @机器人仍按 QQ 账号识别。这里不修改 QQ 账号资料里的昵称，也不改写旧聊天记录。口头禅可增删并填写使用场景；保存后下一轮立即使用，空列表立即清空手工口头禅。昵称和口头禅只保存在本机私有偏好文件；升级会保留旧版待发布的手工编辑，但删除旧学习规则及统计副本。

## 固定系统人格与消息清理

人格核心、口头禅、正反情境示例和 QQ 工具规则一起放在所有会话共用的系统提示词中，不逐轮追加人格运行态、社交精力或关系备注。公开模板参考 qq-bridge 的通用群友描述及二代节奏，不附带原角色专属身份、部署者问卷、兴趣或私人口头禅；来源及许可见 [人格材料许可](../persona/QQ-BRIDGE-NOTICE.txt)。

示例最多 30 组、共 3000 字符，包含原输入场景、行为判断、反例及正例；超限时按固定顺序选择。昵称、口头禅或文件配置改变时，WorkBuddy 在下一轮续接原 thread 使用新系统提示词，可能重新建立缓存；内容不变时维持相同前缀，不保证供应商缓存命中或不计费。面板的“临时任务模型”仅控制新表情识图和凌晨表情筛选，不更改聊天模型或清空上下文。

网关不另存已处理聊天历史：正常结束后按实际已读水位清理 pending（即使 AI 沉默），未读新消息和失败/取消轮次保留。面板保留上一次完整回复；撤回索引只存必要 ID 和时间。订阅消息仍等所有订阅目标完成后再清，群管触发所需的十条窗口仍按原规则保留。成功后的诊断输入正文立即清理，失败只保留有界的最近一轮诊断；状态事件与删除会话归档不存聊天正文。

长期上下文仍由 WorkBuddy 持久会话负责。此次移除的是网关重复副本，不会删除或替换原有 SDK 会话。

WorkBuddy 切换模型、推理强度或上下文阈值时，会重连并续接原持久会话，不在正在运行的 CLI 上热切模型。网关固定使用 Agent 模式，并从工具目录中同时移除进入和退出 Plan 的能力；只读执行权限通过受限工具集实现，不借用 CLI Plan 模式。普通模型轮次只有连续约 3 分钟没有任何真实进展时才会被中断并释放会话锁；推理、工具调用、浏览网页、查找文件和生成文字都会重新开始这 3 分钟，QQ 发送动作本身不作为特殊续时条件，整轮也没有固定总时长上限。上下文压缩使用独立的绝对 6 分钟上限，压缩期间的进展不会延长它。超时会保留未处理消息和已确认发送记录，也不会自动重放可能已产生外部动作的一轮。界面出现失败后可检查并手动重试，原 thread 不会因此被删除或新建。

## 目录边界

~~~text
项目根目录
├── src / modules / scripts / test    可发布、可编辑的程序
├── persona                          可发布的通用人格模板
├── config/*.example                 可发布的配置模板
├── config/qq-only.env                私人实际配置，不发布
├── config/private/persona           私人人格，不发布
├── runtime/qq-only-data              当前群、私聊、订阅与手工偏好
├── runtime/group-workspaces          各群工作区
├── runtime/qq-media / qq-stickers    活动消息附件和表情库
├── modules/workbuddy-agent/.venv     本机 SDK 环境
└── modules/workbuddy-agent/.session-map.json  本机持久会话映射
~~~

在已有部署升级时，不重新复制 `settings.example.json` 覆盖真实 settings，不删除运行目录、SDK 环境、会话映射或 QQ 容器。`vendor`、`build` 和旧项目 Git 历史不是公开发布内容，但不代表可随意删除正在使用的文件。

清理旧会话必须先以群与私聊原始存储中的真实 `threadId` 为保护名单，再核对 SDK 映射。共享上下文私聊的原 thread 虽不再运行，仍是需保留的搁置会话；不要只根据面板当前显示的共享 thread 清理。不能按日期或“看起来像测试”删除其他 WorkBuddy / Codex 会话。发现未引用的网关会话时，停止对应写入进程后，将明确的文件移到项目外的私人备份目录；验证当前 thread 仍能续接后再恢复调度。

## 更新与验收

1. 先关闭面板总开关：仍接收 QQ 消息，不触发模型。等待当前任务完成。
2. 私人备份代码、配置、运行状态和 SDK 映射；同步公开源码，排除上述私人目录。
3. 运行 `npm test` 与 Python 桥离线测试。Hub 停止期间不要并行启动第二份实例。
4. 用现有登录后自启动配置重启，核对 QQ 登录、所有原 thread、pending 和人格；再恢复总开关。

公开发布从独立脱敏 checkout 进行，运行 `npm run audit:public`。旧本地仓库可能已在历史中追踪私人数据：新增 `.gitignore` 无法消除旧历史，不能直接推送它作为公开仓库。
