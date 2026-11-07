**简体中文** | [English](README.en.md)

# WorkBuddy QQ Agent 网关

让本机 WorkBuddy Agent 进入 QQ 的日常对话：接住群聊和私聊里的任务，把消息、文件与工具操作连起来，在网页里看见它正在做什么。

![群聊控制台：待处理消息、上一条回复与实时生成内容](docs/screenshots/conversation.png)

## 对话可以继续，任务也有来处

每个群和私聊默认保留自己的持久会话，重启后继续。Agent 可以按当前对话读取消息、展开转发、查看图片，再发送文字、文件、图片和原生表情。需要时，也可明确让私聊关联某个群的上下文。

## 看得见进展，也能随时控制

在面板查看实时输出、待处理消息和队列，调整会话模型与执行权限。想暂停回复或中断当前任务时，直接在界面操作，不必把控制命令混进群消息。

![会话设置：模型、推理、压缩与执行权限](docs/screenshots/settings.png)

## 重要通知，不必每个群都盯着

为目标会话订阅只读通知来源，按等待窗口汇总，再分别发给需要的人。面板显示各订阅者的处理进度；通知仍有目标，不会变成无差别群发。

![通知来源与订阅者的处理状态](docs/screenshots/subscriptions.png)

## 也保留聊天里的表情与习惯

表情库可以检索、修改场景和整理黑名单。需要扩展时，还能按独立授权接入 Home Assistant、Apple 日历/提醒、小爱播报与 QQ 空间功能。

![表情展示台：浏览和管理可用表情](docs/screenshots/stickers.png)

*以上均为真实前端配合合成演示数据，不包含实际 QQ 聊天记录。*

## 先看演示，再接入自己的环境

项目提供不登录 QQ、不调用模型的本地演示，适合先看看面板与交互。真实部署面向 macOS，使用自己的 WorkBuddy 与 QQ 桥。

[打开演示与部署指南](docs/GUIDE.zh-CN.md)

## 进一步了解

| 想了解什么 | 去哪里看 |
| --- | --- |
| 本地演示、环境要求与部署 | [使用指南](docs/GUIDE.zh-CN.md) |
| 会话、订阅、共享上下文和自动化 | [完整功能参考](docs/readme-reference.zh-CN.md) |
| 权限、数据与安全 | [安全说明](SECURITY.md) |
| 本地修改与家居集成 | [定制结构](docs/LOCAL_CUSTOMIZATION.md) · [Home Assistant](docs/HOME_ASSISTANT.md) |
| 来源、许可与反馈 | [来源清单](docs/PROVENANCE.md) · [许可说明](LICENSE-NOTICE.md) · [Issues](https://github.com/DrivingGodJ/workbuddy-qq-agent-gateway/issues) |

基于 [Epic0522/Codex-Remote-Contact](https://github.com/Epic0522/Codex-Remote-Contact) 扩展，围绕 WorkBuddy 独立维护；上游许可未声明，使用与分发条件请先阅读许可说明。
