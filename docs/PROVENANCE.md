# 代码来源与扩展范围

本项目为 WorkBuddy 定制，在代码来源上基于 [Epic0522/Codex-Remote-Contact](https://github.com/Epic0522/Codex-Remote-Contact) 扩展；GitHub 仓库独立发布，不保留 fork 关系或本机提交历史。这不意味着代码是从零重写，也不取消原作者署名与权利。

## 对比基准和口径

比对上游基准提交 [8412335](https://github.com/Epic0522/Codex-Remote-Contact/commit/8412335abbe38cd0633aff7cc1a6486283b7defc)。当前发布快照共有 115 个文件：

| 分类 | 文件数 | 含义 |
| --- | ---: | --- |
| 与上游同路径且字节完全相同 | 13 | 直接沿用 |
| 上游已有同路径、当前内容不同 | 18 | 改写或扩展，包含配置与文档 |
| 上游没有同路径 | 84 | 新增模块、测试、公开配置、文档和页面图 |

这是文件级盘点，不是原创代码百分比、贡献比例或逐行版权鉴定。新增文件也可能包含从上游旧文件拆分或改写的逻辑；修改文件不代表全部内容都原创。截图和通用演示数据计入新增文件。

## 直接沿用的 13 个文件

- modules/mac-client/Resources/Info.plist
- modules/mac-client/Sources/CodexRemoteContactClient.swift
- modules/mac-client/start-client.command
- modules/macos-launcher/Info.plist
- modules/macos-launcher/Sources/RoundIcon.swift
- modules/macos-launcher/build-launcher.command
- modules/system-control/README.md
- modules/system-control/backlight-off-keep-awake.command
- modules/system-control/backlight-restore.command
- modules/system-control/build-backlight-helper.command
- modules/system-control/keep-awake-display-off.command
- modules/system-control/src/codexremotecontact-backlight.c
- modules/system-control/stop-keep-awake.command

主要是 Mac 客户端壳、图标构建与本机系统控制。这些辅助模块仍有实际引用，不是 WorkBuddy 核心链路。

## 改写或扩展的 18 个文件

- .gitignore、README.md、package.json
- config/local.codexremotecontact.chat-hub.plist.example
- config/settings.example.json
- modules/chat-hub-start.command
- modules/codex-cli/README.md
- modules/install-launchd-plist.command
- modules/mac-client/script/build_and_run.sh
- modules/macos-launcher/Sources/CodexRemoteContactLauncher.swift
- modules/start-all.command、modules/stop-chat-hub.command
- modules/web-console/README.md、public/client.css、client.html、client.js、index.html
- src/server.js

包括网关入口、前端资源、后台启动配置与说明。这些不是完全独立于上游的新实现。

本次整理移除了旧 LLBot 说明、与网关无关的代理控制辅助模块、未引用样式表及 Mac 客户端的三份重复前端源码；改为单一网页源构建客户端。私人配置和人格可覆盖公开模板，详见 [本地可编辑结构](LOCAL_CUSTOMIZATION.md)。Codex 兼容适配及仍被使用的会话保留管理器未按名字误删。

## 后续新增的主要能力

- WorkBuddy Python SDK 桥、持久会话续接、模式/权限/压缩阈值适配。
- 当前会话 QQ MCP，读取消息/合并转发/公开链接，发送与等待动作。
- 每群、每私聊队列和状态存储，pending / cutoff / 失败保留及投递收据。
- 目标会话拥有的只读通知订阅，多目标引用、串行排队、摘要强制送达。
- 原生表情去重、临时识图、展示台、使用场景备注、黑名单及定时筛选。
- QQ 空间任务协调和增量动态读取，按会话绑定与 OWNER 发布权限控制。
- Apple 日历/提醒脚本、幂等校验与写后确认。
- 固定系统人格、手工昵称/口头禅和通用正反示例；无每日表达总结、聊天样本采集或逐轮社交状态，公开版不附带私人问卷或画像。
- 离线回归测试、脱敏演示服、公开配置校验、发布审计和跨平台 CI。

## 许可

通用人格描述与部分原文示例参考 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，固定来源为 `a56164e70a0521a7829138a42eee76066fde2b8b` 的小鲸鱼角色卡及 `qq-chat-v2` 预设。只选用适配本项目的通用描述和对话，不继承原角色身份、专属口头禅、DSH 工具名或权限策略。该材料的 MIT 声明保存在 [QQ-BRIDGE-NOTICE.txt](../persona/QQ-BRIDGE-NOTICE.txt)，不扩展到本项目其他来源代码。

上游没有声明开源许可证，公开独立仓库不自动带来完整开源授权。本项目不擅自给整仓添加 MIT / Apache 等许可，详见 [许可证说明](../LICENSE-NOTICE.md)。
