**简体中文** | [English](README.en.md)

# Web 控制台模块

Hub 的网页控制台，macOS 客户端复用同一套前端资源。网关配置见[项目首页](../../README.md)。

## 使用方式

启动 Hub 后访问 `http://localhost:3789`。左侧“Agent 群聊”可从机器人已加入、且未作为只读通知源的群中加入白名单；“Agent 私聊”通过 QQ 号添加。变更立即保存到本机私有 `settings.json`，刷新与重启后仍保留。

## 开发与维护

本模块 `public/` 目录中的 `client.html`、`client.css` 和 `client.js` 是唯一可编辑前端源文件。构建客户端时单向复制到 app bundle，不在 Mac 客户端 Resources 内维护另一份源码。

Hub 的静态资源目录还包含 `modules/web-console/public/`；路径均相对仓库根目录。不要将真实白名单或运行配置提交到仓库。
