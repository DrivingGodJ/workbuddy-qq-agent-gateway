**简体中文** | [English](README.en.md)

# Codex CLI 兼容模块

为网关保留 Codex app-server 兼容接入，实现在仓库根目录的 `src/codex/client.js`。主项目默认围绕 WorkBuddy 设计，两种引擎的能力不保证完全一致。

## 使用方式

默认 CLI 路径为 `/Applications/Codex.app/Contents/Resources/codex`。可在部署环境中覆盖：

```bash
CODEX_CLI_PATH=/path/to/codex
```

上例中的路径需替换为实际可执行文件；按[主项目配置说明](../../README.md)启用对应兼容路径。

## 会话与数据

每个 QQ 群映射到一条持久 Codex thread。群工作区与 WorkBuddy 使用相同的隔离目录 `runtime/group-workspaces/<groupId>/`；threadId 和 pending 消息保存在 `runtime/qq-only-data/group-sessions.json`。以上均相对仓库根目录，属于不应公开提交的运行数据。
