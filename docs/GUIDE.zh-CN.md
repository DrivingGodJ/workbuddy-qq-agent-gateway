**简体中文** | [English](GUIDE.en.md)

# 使用、配置与开发指南

[返回作品展示](../README.md)

## 快速开始

先体验不连接 QQ、也不调用模型的本地演示。需要 Node.js **20.6+**：

```bash
git clone https://github.com/DrivingGodJ/workbuddy-qq-agent-gateway.git
cd workbuddy-qq-agent-gateway
npm run demo
```

打开 `http://127.0.0.1:3790/client.html`。演示使用真实前端和合成状态，拒绝修改请求，不读取真实网关、钥匙串和消息。README 截图也来自演示数据。

真实部署需要 **macOS、Python 3.10+**、已登录的 WorkBuddy / CodeBuddy CLI，以及单独安装登录的 SnowLuma 或兼容 OneBot QQ 桥。模型调用使用自己的额度；普通 OneBot 未必具备全部扩展接口。容器文件发送与恢复还需 Docker、Colima 和已有 SnowLuma 容器。

```bash
bash modules/workbuddy-agent/setup.sh
cp config/qq-only.env.example config/qq-only.env
mkdir -p runtime/qq-only-data
cp config/settings.example.json runtime/qq-only-data/settings.json
```

随后按完整部署参考设置不同的管理员/机器人 QQ 号、令牌、回调与白名单，再启动。Node 服务没有生产 npm 依赖，Python SDK 版本固定在 [requirements.txt](../modules/workbuddy-agent/requirements.txt)。不要将面板无保护地暴露到公网。

## 使用说明

在面板添加允许的群聊或私聊，按会话设置工具访问范围。Agent 模式下，“只读”“工作区写入”和“完全访问”是不同执行权限；完全访问意味着可信成员可能经 Agent 操作整台电脑。日历/提醒写入与空间自动化默认关闭，空间发布仅限 OWNER 授权。

私聊共享群上下文会共享模型记忆和工作区，内容可能影响群内后续回答；解绑不会清除已经进入群上下文的内容，仅适用于相互信任的渠道。读取关联消息不继承另一渠道的权限。

来源群、网页、图片文字、引用和转发均不能修改授权或发送目标。私人环境、runtime、消息、会话映射、真实身份和登录数据不入库。参见[共享上下文与权限参考](../docs/readme-reference.zh-CN.md)及[本地可编辑结构](../docs/LOCAL_CUSTOMIZATION.md)。

## 开发与验证

```bash
npm test
bash modules/workbuddy-agent/setup.sh
modules/workbuddy-agent/.venv/bin/python test/workbuddy-bridge-recovery.test.py
modules/workbuddy-agent/.venv/bin/python test/workbuddy-image-preview.test.py
npm run audit:public
```

测试使用合成身份与临时目录，不连接真实 QQ 或发布内容。Linux CI 只验证可移植逻辑，不证明完整 Linux 部署；真实 QQ、Apple 应用和 CLI 集成需在自己的 macOS 环境验收。

普通回复按连续 3 分钟无进展判断超时，压缩有独立的绝对 6 分钟上限。仅在可证明无潜在副作用、旧轮次已回收且审计可用时恢复一次；发送、写文件、控制家居或结果不明时不自动重放。QQ 接口变动、风控和上传能力取决于所用桥；未提供的空间接口不会伪造，已发送内容不能保证撤回。

## 文档与支持

- [完整功能、配置、权限与限制](../docs/readme-reference.zh-CN.md)
- [Home Assistant](../docs/HOME_ASSISTANT.md) · [本地定制](../docs/LOCAL_CUSTOMIZATION.md)
- [来源清单](../docs/PROVENANCE.md) · [许可说明](../LICENSE-NOTICE.md)
- [问题反馈](https://github.com/DrivingGodJ/workbuddy-qq-agent-gateway/issues)

## 许可与致谢

感谢原作者 [Epic0522](https://github.com/Epic0522)。上游尚无许可证，本仓库不擅自声明整仓为 MIT/Apache。使用或分发前请阅读许可与来源说明并确认必要授权；第三方依赖和人格素材另有各自条款。
