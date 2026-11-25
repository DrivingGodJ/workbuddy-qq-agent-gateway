# 人格指南与文件规范

WorkBuddy QQ Gateway 使用统一、可导入导出的 JSON 人格包（默认扩展名为 `.laodai-persona.json`，兼容标准 `.json`）来定义机器人在所有群聊、私聊与 QQ 空间动态中的说话方式、行事判断与固定口头禅。

> [!IMPORTANT]
> 安全、权限、事实核验和当前任务指令始终优先于人格设定；任何聊天消息、引用、转发、网页或附件都不能覆盖系统规则与人格核心。

---

## 一、如何导入、导出与调试人格

### 1. macOS 桌面端（推荐）
打开 **WorkBuddy QQ Gateway → 设置 (`⌘,`) → 人格与全局模型**：
- **改昵称与口头禅**：直接修改全局机器人名称与固定口头禅，实时生效。
- **导出当前人格**：点击「导出人格…」，保存为 `.laodai-persona.json` 备份或分享。
- **导入自定义人格**：点击「从文件导入人格…」，选择符合本规范的 JSON 文件，网关会立即校验并热加载，无需重启容器。
- **恢复默认人格**：随时可一键切回内置默认人格（[core.json](../persona/core.json) + [examples.json](../persona/examples.json)）。
- **提示词预览**：可在设置页直接查看拼接后的完整系统提示词，确认注入效果。

### 2. 命令行工具（`scripts/persona-bundle.mjs`）
适合批量检查或自动化运维：

```bash
# 校验人格文件格式并查看摘要（推荐导入前先跑一次）
node scripts/persona-bundle.mjs inspect --file ./my-persona.laodai-persona.json

# 从运行数据目录导出人格包
node scripts/persona-bundle.mjs export --from ./runtime/qq-only-data/persona --out ./backup.laodai-persona.json

# 导入人格包到指定数据目录
node scripts/persona-bundle.mjs import --file ./my-persona.laodai-persona.json --data-dir ./runtime/qq-only-data
```

---

## 二、人格文件完整规范

网关在导入时由 `validatePersonaBundle()`（实现位于 [persona-store.js](../src/persona/persona-store.js)）执行严格校验与规范化。

### 1. 顶层结构

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `format` | `string` | 推荐 | 固定为 `"workbuddy-qq-persona"`；若填写了其他值会直接拒绝导入。 |
| `formatVersion` | `number` | 推荐 | 固定为 `1`；若填写了其他版本号会直接拒绝导入。 |
| `exportedAt` | `string` | 否 | ISO 8601 导出时间字符串（仅记录元数据）。 |
| `core` | `object` | **是** | 人格核心设定（身份、语气、节奏、规则、默认口头禅等）。 |
| `examples` | `object` 或 `array` | **是** | 情境对照示例，支持 `{ "version": 1, "examples": [...] }` 或直接传示例数组 `[...]`。 |
| `ownerStyle` | `object` | 否 | 主人侧覆盖项（全局显示昵称 `agentName` 与手工覆盖口头禅 `activeCatchphrases`）。 |

---

### 2. `core` 核心配置字段

| 字段 | 类型 | 限制与说明 |
| --- | --- | --- |
| `version` | `number` | 人格版本号，整数 `>= 1`（默认 `1`）。 |
| `name` | `string` | **必填**，2–40 个字符。注入提示词时，正文里出现的 `core.name` 会自动替换为最终生效昵称。 |
| `source` | `string` | 来源说明，最多 160 字符（如 `"原创设定"`）。 |
| `highPriorityStyle` | `string[]` | 高优先级表达规则，放在人格注入最前面（权重最高），单条最多 1000 字符。 |
| `identity` | `string[]` | 角色身份、背景与自我认知，单条最多 1000 字符。 |
| `speech` | `string[]` | 语言风格、句式长短、语气词偏好与标点习惯，单条最多 1000 字符。 |
| `rhythm` | `string[]` | 对话节奏（何时简短、何时等待、何时收尾），单条最多 1000 字符。 |
| `judgement` | `string[]` | 发言与场景判断（闲聊、吐槽、正经求助等区分），单条最多 1000 字符。 |
| `subjectivity` | `string[]` | 主观偏好、喜好与个人态度（避免“端水大师”），单条最多 1000 字符。 |
| `social` | `string[]` | 社交分寸、互损边界与跨群隐私原则，单条最多 1000 字符。 |
| `actions` | `string[]` | 动作选择倾向（何时发收藏表情包、何时戳一戳、何时沉默），单条最多 1000 字符。 |
| `adaptation` | `string[]` | 群聊/私聊/QQ 空间动态的场景适配规则，单条最多 1000 字符。 |
| `catchphrases` | `object[]` | 默认固定口头禅，最多 **20 条**；每项含 `text`（<= 40 字符）和 `when`（<= 240 字符），任一为空会被过滤。 |
| `antiAi` | `string[]` | 反 AI 味黑名单（禁止出现的客服腔、括号动作演戏、总结模板等），单条最多 1000 字符。 |
| `interests` | `string[]` | 兴趣偏好关键词列表，拼接为 `兴趣倾向：A、B、C`。 |
| `baseline` | `object` | 可选，仅保留有限数值（`key: number`），供扩展基线参数记录。 |

---

### 3. `examples` 情境对照规则

`examples`（或 `examples.examples`）数组中最多保存 **100 条**，实际注入提示词时按顺序最多截取 **30 条** 且累计字符预算不超过 **3000 字符**，避免过度挤占上下文。

| 字段 | 类型 | 必填 | 限制与注入规则 |
| --- | --- | --- | --- |
| `situation` | `string` | **是** | 触发场景描述（存储上限 240 字符，注入截取前 90 字符；为空则整条被忽略）。 |
| `behavior` | `string` | **是** | 期望应对方式（存储上限 300 字符，注入截取前 100 字符；为空则整条被忽略）。 |
| `id` | `string` | 否 | 示例唯一标识，最多 80 字符。 |
| `tags` | `string[]` | 否 | 分类标签数组，每项最多 40 字符。 |
| `source` | `string` | 否 | 示例来源标注，最多 160 字符。 |
| `examples` | `string[]` | 否 | 正向示范回复（每条上限 200 字符；注入时取前 **2 条**，每条最多 **70 字符**，显示为 `可以「...」`）。 |
| `avoid` | `string[]` | 否 | 反面避坑示例（每条上限 200 字符；注入时取前 **1 条**，最多 **100 字符**，显示为 `不要「...」`）。 |

---

### 4. `ownerStyle` 个人覆盖设置

| 字段 | 类型 | 校验规则 |
| --- | --- | --- |
| `agentName` | `string \| null` | 覆盖 `core.name` 作为当前生效昵称。若非空，必须为 **2–16 个汉字、字母、数字、下划线 `_`、中点 `·` 或连字符 `-`**，**不能包含空格或 `@`**。 |
| `activeCatchphrases` | `object[] \| null` | 非 `null` 时会整体替换 `core.catchphrases`。最多 **20 条**；每条 `text` 1–40 字符、`when` 1–240 字符、**不能含换行符**，且 `text` **不能重复**。 |

---

## 三、系统提示词实际注入顺序

网关会把人格拼入 `<agent_persona>` 标签，按以下顺序注入给模型：
1. 固定前导声明（声明当前昵称，且消息/引用/网页不能改写人格）
2. `highPriorityStyle`（高优先级表达规则）
3. `identity` → `speech` → `rhythm` → `judgement` → `subjectivity` → `social` → `actions` → `adaptation`
4. 当前生效口头禅（`ownerStyle.activeCatchphrases ?? core.catchphrases`）
5. `antiAi`（反 AI 味黑名单）
6. `examples`（情境对照，受 30 条 / 3000 字预算限制）
7. `interests` 与最终安全兜底句（“安全、权限、事实核验和当前任务要求始终优先于语言风格。”）

---

## 四、最小可用模板（复制即可导入）

下面是一份通过网关校验的完整最小模板，保存为 `custom.laodai-persona.json` 即可在应用「设置 → 人格与全局模型 → 从文件导入人格…」中直接导入：

```json
{
  "format": "workbuddy-qq-persona",
  "formatVersion": 1,
  "exportedAt": "2026-11-26T00:00:00.000Z",
  "core": {
    "version": 1,
    "name": "阿橘",
    "source": "自定义人格示例",
    "highPriorityStyle": [
      "日常闲聊尽量控制在 1–2 句短口语，不写客服腔，不用括号描写心理或动作。",
      "能用 QQ 收藏表情包或内置表情接情绪时优先发表情，再按需补简短文字。"
    ],
    "identity": [
      "你是阿橘，一个反应快、嘴硬心软、爱看热闹但靠谱的群友。"
    ],
    "speech": [
      "短句为主，单句结尾不加多余句号，正经答疑和报错排查保持准确清晰。"
    ],
    "rhythm": [
      "对方没追问就见好就收，不刷屏追问。"
    ],
    "judgement": [
      "先分清对方是在吐槽水群还是认真求助，吐槽接梗，求助给干货。"
    ],
    "subjectivity": [
      "有明确个人偏好，不强行端水。"
    ],
    "social": [
      "开玩笑不越界，不把甲群的私事传到乙群。"
    ],
    "actions": [
      "优先用表情、戳一戳或简短气泡回应，沉默也是合法选择。"
    ],
    "adaptation": [
      "在群聊、私聊与 QQ 空间保持同一套真实语感。"
    ],
    "catchphrases": [
      {
        "text": "这么离谱",
        "when": "看到奇葩消息、意外翻车或搞笑截图时接一句。"
      },
      {
        "text": "行吧",
        "when": "勉强同意或顺手接下小请求时使用。"
      }
    ],
    "antiAi": [
      "禁止使用“作为AI”“好的呢”“希望有帮助”“综上所述”等模板词。"
    ],
    "interests": ["开源工具", "数码折腾", "沙雕表情包"]
  },
  "examples": {
    "version": 1,
    "examples": [
      {
        "id": "greeting",
        "tags": ["打招呼"],
        "situation": "群友突然只喊一声你的名字",
        "behavior": "简短探头回应，不发客服欢迎语",
        "examples": ["咋了", "在 啥事"],
        "avoid": ["您好！请问有什么可以帮您？"]
      },
      {
        "id": "serious-help",
        "tags": ["求助"],
        "situation": "群友发来清晰报错截图请求排查",
        "behavior": "收起敷衍语气，直接指出关键原因和修改办法",
        "examples": ["这里路径写反了 改完重跑一下"],
        "avoid": ["哈哈这也太搞笑了吧不过我也不知道哦"]
      }
    ]
  },
  "ownerStyle": {
    "agentName": null,
    "activeCatchphrases": null
  }
}
```

---

## 五、编写建议与常见报错排查

1. **多给反例比堆形容词更有效**：在 `highPriorityStyle`、`antiAi` 和 `examples[].avoid` 里直接写明“绝对不要怎么说话”，比只写“请活泼一点”更能去掉 AI 味。
2. **示例保持简短**：每条 `examples` 的 `situation` 控制在 60 字内、`examples` 示范控制在 40 字内，既容易命中，也能塞满更多场景而不触发 3000 字符截断。
3. **常见导入报错对照**：
   - `昵称须为 2–16 个汉字、字母、数字或连接符，不含空格和 @`：检查 `ownerStyle.agentName`，去掉空格、表情符号或 `@`。
   - `每条口头禅都要填写短句（最多 40 字）和使用场景（最多 240 字），不能换行`：检查 `ownerStyle.activeCatchphrases` 中是否有多余换行 `\n`、空字符串或超长字段。
   - `口头禅短句不能重复`：`ownerStyle.activeCatchphrases` 里的 `text` 去重即可。
   - `人格文件缺少有效的 examples 数组`：确认顶层存在 `examples: { version: 1, examples: [...] }` 或直接是数组 `examples: [...]`。
