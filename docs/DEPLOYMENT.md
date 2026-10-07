# 部署补充说明

Apple Silicon Mac 的具体实施步骤与已核验配置见 [Colima + Docker + SnowLuma 部署实录](MACOS_VM_DEPLOYMENT.md)。本文保留各部署方式共用的边界说明。

## 本机与容器

网关默认 127.0.0.1:3789，OneBot API 默认 127.0.0.1:3000。容器 localhost 不是 Mac，应配置桥可达的宿主机地址和端口转发，并保持回调令牌或签名验证。

回调支持 Authorization Bearer、配置令牌和 X-Signature HMAC-SHA1。不同桥对反向连接、host 网络和上报格式支持不同，需单独核验。

## 上传与清理

默认使用 Docker context 和 SnowLuma container，把指定文件复制到容器专用临时前缀，成功或失败都清理副本，用户原件不动。消息图片仍跟随引用清理，识别表情不会提前删除主对话原图。

只有 HTTP OneBot、没有本机容器时，当前容器上传路径不可用，需适配自己的桥；文本收发成功不代表上传已验收。

## 登录后自启动

服务标签为 local.codexremotecontact.chat-hub 和 local.codexremotecontact.qq-runtime，属于当前用户会话，是登录后自启动，不是 FileVault 解锁前系统守护程序。

安装时替换模板的项目和 runner 路径，不提交生成的 plist。QQ 恢复只针对已有 Colima profile/容器；确认失效的 PID/socket 移入恢复备份，不删磁盘或登录状态。

macOS 更新后的首次登录可能需要数分钟恢复 Colima 虚拟机。Hub 会先独立启动，QQ 恢复任务每分钟重试；Colima 状态检查有 20 秒上限，若旧状态仍被活动进程占用或无法安全确认，则等待下一轮，不强行改动虚拟机。面板与 QQ 在线状态应分别检查。

已有同名部署时不要运行第二套安装和启动脚本，以免替换服务配置。

## 日历与提醒

先建立“学习”“社团”“活动”日历及“待办”提醒列表，在目标会话开启自动化，授予 macOS 系统权限。不要在 CI 或部署验收中自动写入真实事项。

## 费用与排障

聊天、通知、表情标注和空间任务都可能消耗模型额度。总开关关闭仍记录消息但不启动新模型请求。按面板的 Hub、OneBot、引擎及任务错误排查；日志可能含私人聊天，勿公开上传。发送结果不确定先核对 QQ，避免重复外部动作。
