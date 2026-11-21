# Home Assistant 家居 MCP

WorkBuddy 使用既有 `qq_gateway` MCP 中的 `read_home_devices`、`control_home_device` 与独立的 `speak_home_speaker`。网关通过 Home Assistant 官方 REST API 执行，不要求安装 HA 的 MCP Server 集成，也不新增包依赖。HA API 凭证只留在网关进程，不能传给 WorkBuddy、MCP 子进程或对话上下文。

## 配置

1. 在 HA 用户安全设置创建一枚专用长期访问令牌，保管好并定期轮换。不要将账号密码或令牌放入源码、提示词、日志或 Git。
2. macOS 将令牌保存为钥匙串通用密码：服务使用 `CODEX_REMOTE_CONTACT_KEYCHAIN_SERVICE` 的值（默认 `Codex Remote Contact QQ`），账户为 `home-assistant-api-token`。启动脚本读取它；非 macOS 部署可通过安全的进程环境注入 `CODEX_REMOTE_CONTACT_HA_TOKEN`。
3. 在忽略上传的 `config/qq-only.env` 设置：

```dotenv
CODEX_REMOTE_CONTACT_HA_ENABLED=1
CODEX_REMOTE_CONTACT_HA_BASE_URL=http://homeassistant.local:8123
# 按钮可能执行任意设备操作，只有明确列出的安全实体可按下。
CODEX_REMOTE_CONTACT_HA_ALLOWED_BUTTONS=button.your_ir_ac_on,button.your_ir_ac_off
# 仅支持 Xiaomi 播放文本实体，不允许 execute_text_directive。
CODEX_REMOTE_CONTACT_HA_ALLOWED_SPEAKERS=notify.xiaomi_your_device_play_text_a_5_3
# 可选天气地点。填写城市名和市区的纬度、经度。
CODEX_REMOTE_CONTACT_SPEAKER_WEATHER_LOCATION="城市名,31.2,121.5"
```

4. 重启网关。真实地址、实体 ID 与访问令牌均不应提交到公开仓库。关闭功能可设 `CODEX_REMOTE_CONTACT_HA_ENABLED=0`；不会删除 HA 设备或 QQ 消息。

## 使用与权限

- 选择会话 → 会话参数 → “智能家居与小爱发言权限”，可选择 **关闭 / 仅 OWNER（你本人）/ 全群成员**。全群仅限所选群的直接请求，不影响其他群；私聊只有关闭与仅 OWNER。默认仅 OWNER，不会自动给已有群开放。任务运行时不能更改参数，保存后立即对后续请求生效。
- 请求必须绑定当前目标、本轮实际读到且仍在 pending 中的获准成员直接消息，传该消息的 `request_message_id`。不要求这条消息再次出现“家居”“灯”等关键词；可以结合本轮对话理解“那个”“再调一点”等指代。引用、转发、已撤回或已处理消息只能作为背景，不能代替当前直接请求授权；任何通知、动态定时任务均无家居权限。本机执行权限与家居权限相互独立。
- 用于授权的直接消息须在最近 15 分钟内由网关收到，重启后不会把很久以前积压的控制要求补做。超过此时限请获准成员重新提出请求。
- 先 `read_home_devices` 搜索设备名称、查看状态和真实实体 ID。默认返回 10 个，最多 20 个，可分页。只返回控制相关属性，不一次性灌入所有家居信息。
- 查询按面板权限开放，不需要用户重复提出设备查询口令。实际控制再用 `control_home_device`，一次只控制一个已查询的实体。模型须根据当前用户的真实意图与本轮上下文决定操作，不再依靠网关匹配固定开关关键词；含糊、冲突或有风险时先确认，不把讨论、否定或单纯查询当成控制要求。服务支持灯、窗帘、空调、风扇、音箱、开关和数值/选项实体；按钮须额外列入白名单。不能调用系统重启、任意脚本、自动化、人员位置、摄像头、锁或安防域。
- 小爱发言单独使用 `speak_home_speaker(entity_id, text, request_message_id)`，限已查询并列入白名单的播放文本实体，最长 500 字。与 QQ 发消息、播放音乐和执行小爱设备指令分开；可结合当前上下文理解播报要求，不靠固定措辞，但无实际发言要求不自行打扰宿舍。成功仅表示 HA 接受，不能保证实际声音。
- 在会话参数的“小爱定时播报”中添加、编辑、停用或删除计划，再保存会话参数。每条可选择北京时间、播报星期，以及是否附上当地天气和穿衣建议。已开启的旧问候会迁移为每日计划，天气默认关闭。定时播报独立进入当前会话的队列。总开关、会话回复或家居权限关闭时暂停执行。
- 定时播报只授予指定音箱一次发言权限。网关按会话、日期、计划和时间去重。重启可恢复尚未尝试播报的排队任务。天气开启时从 [Open-Meteo](https://open-meteo.com/en/docs) 查询所配置城市的当天预报并附到问候后面。查询失败时仍播报问候，并说明天气暂时查不到。
- 灯光只提供实际支持的参数：仅色温灯不提供 RGB，纯开关灯不提供亮度；色温/亮度/温度均核验范围。放松措辞不会放松实体、参数、撤回、停止或服务白名单检查。
- 开始产生物理效果前，网关先持久记录操作尝试，独立保存 30 分钟并跨轮次、重启生效。同一请求消息中的相同动作不得重复；登记失败或容量满不执行。服务超时或网关中断后也不能盲目重发，应查询状态或等待新的明确指令。
- 服务成功后独立读取设备状态。回读并不保证物理效果，红外空调等无反馈设备只能报告“指令已发送”；不得声称实际温度、模式或电源状态已经核实。灯光等设备延迟更新也不能自动触发重复动作。
- HA 不可用不会阻止 QQ 网关启动。失败时分别解释：**授权拒绝**表示面板权限、消息身份或有效期等不满足；**HA 不可达**表示连接或读取失败，不等于没有权限；**执行结果未知**表示控制请求可能已发出，必须查询状态或由用户重新决定，不能自动重试。HTTP 或服务错误按真实回执说明，不把所有失败统称为“智能家居用不了”。消息仍遵循原有 pending/完成规则。

示例：“老代，把台灯亮度调到 60%”“老代，宿舍空调设置为制冷 26 度”“老代，查一下灯现在的状态”“老代，用小爱音箱说：该睡觉了”。红外空调的开机、模式、温度需要分步执行；每一步都根据真实设备查询结果选取实体和服务。

网关内权限检查不能隔离已经授予整台 Mac 执行权限的程序；不要向不可信会话开放完全访问，也不要在群里共享 HA 凭据。初次安装应先只读验证，未经明确要求不要用真实设备做写入测试。

官方参考：[REST API](https://developers.home-assistant.io/docs/api/rest/)、[认证 API](https://developers.home-assistant.io/docs/auth_api/)、[HA 官方 MCP Server](https://www.home-assistant.io/integrations/mcp_server/)。
