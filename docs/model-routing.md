# 模型接入与任务路由

PoopSense 在服务端统一适配模型接口，再按任务选择提供方。授权、记录事实、风险边界和允许动作仍由确定性规则管理。模型密钥只保存在本地服务端配置或部署平台的密钥管理中，不进入前端。

## 本地接入

安装后端依赖后，在仓库根目录运行：

```powershell
.\配置模型.ps1
```

助手依次提供 DeepSeek、百川医疗和通用 OpenAI-compatible 三种选择。预设会填好官方地址与模型名；通用兼容需要输入配置名称、API 基址和模型标识。密钥通过不回显的交互提示输入，不能放在命令行参数中；终端无法隐藏输入时会退出。

助手使用当前适配发送一次虚构的简短连通检查。只有 HTTP 200、`finish_reason=stop` 且正文非空才合并写入 `backend/.env.local`，保留其他配置。失败或检查期间文件被其他操作更新时不覆盖。连通检查可能产生供应商调用费用，也不代表医学能力验证。

```powershell
.\配置模型.ps1 list
.\配置模型.ps1 dry-run
.\配置模型.ps1 enable-auto
```

`list` 和 `dry-run` 只显示配置名称、是否配置及路由开关，不输入密钥、不发请求、不改文件。完成两种预设接入后，`enable-auto` 检查两种预设及当前路由所需密钥可用，再写入自动路由开关；已有自定义路由保留。它不会重复做付费连通检查。

也可在 `backend` 目录使用已安装依赖的 Python 运行 `python -X utf8 scripts/model_setup.py`，后接相同子命令。

本地服务必须重启才能读取新配置。进程环境变量优先于本地文件，同名变量也需保持一致。线上需通过平台安全配置相应变量并重新部署；本地保存不会更新 Vercel。示例文件默认 `POOPSENSE_LLM_ROUTING_ENABLED=false`，关闭时沿用既有单模型配置。

## 自动路由默认分工

| 任务 | 标识 | 默认来源 |
|---|---|---|
| 日常问答 | `general_chat` | DeepSeek V4 Pro |
| 产品使用帮助 | `product_help` | DeepSeek V4 Pro |
| 已有记录与趋势的解释 | `record_explanation` | DeepSeek V4 Pro |
| 周报文字总结 | `weekly_summary` | DeepSeek V4 Pro |
| 紧急情况的文字解释 | `urgent_care` | DeepSeek V4 Pro |
| 一般健康知识 | `health_knowledge` | 百川 M3-Plus |
| 单次记录报告 | `session_report` | 规则引擎，零模型调用 |
| 后台动作选择 | `structured_action` | 规则引擎，零模型调用 |

任务选择发生在服务端。紧急情况的模型解释不替代规则安全提醒；模型不能改写风险级别或扩大允许动作。规则任务不能通过路由配置改成模型任务。

## 增加兼容模型与自定义路由

内置预设分别读取 `DEEPSEEK_API_KEY` 和 `BAICHUAN_API_KEY`。既有单模型密钥只在地址和型号完全匹配时按注册表规则复用，不会借用其他供应商的密钥；显式配置为空的专用密钥不会被旧密钥覆盖。

`POOPSENSE_LLM_PROFILES` 是以配置 ID 为键的 JSON 对象。例如新增 `extra_model`：

```dotenv
POOPSENSE_LLM_PROFILES={"extra_model":{"adapter":"openai_compatible","base_url":"https://models.example.com/v1","model":"your-model-id","api_key_env":"POOPSENSE_MODEL_EXTRA_MODEL_API_KEY","max_tokens":1024,"timeout_seconds":30}}
POOPSENSE_MODEL_EXTRA_MODEL_API_KEY=
```

示例地址和型号需要替换。`api_key_env` 只写环境变量名称，实际密钥通过助手或平台密钥管理设置，不放进 JSON。助手会为新增配置生成独立密钥变量。当前端点校验要求公网 HTTPS 地址；带凭据、查询参数、私网地址等不被接受。

`POOPSENSE_LLM_ROUTES` 只覆盖明确列出的任务；未列出的任务保留默认值。例如把健康知识交给新增模型：

```dotenv
POOPSENSE_LLM_ROUTES={"health_knowledge":"extra_model"}
```

目标 ID 必须存在，`session_report` 和 `structured_action` 只能指向 `policy`。无效配置会被拒绝。更换路由后仍需重启本地服务或重新部署线上服务。

通用适配支持兼容 `chat/completions` 的接口。使用不同原生请求、响应或鉴权协议的提供方，需要新增并验证适配器；不能保证任意 API 填入地址即可工作。MCP 主要连接工具和数据，是另一层协议，不能代替模型适配与任务路由。

## 状态、回执与失败处理

“已配置”只表示所需配置和密钥存在，不代表当前网络可达、额度充足或模型服务正常。每条已完成消息使用该次调用的实际模型回执展示来源，历史消息不能套用当前默认模型。规则结果标识为 `policy-engine`。

选定供应商失败时不会静默切到另一家供应商。普通问答明确失败，支持用户重试；单次报告保留规则结果。周报样本不足时直接使用规则摘要，模型失败或解释守卫拒绝时也保留确定性摘要及其规则标识，不能把失败文本写成成功报告。

模型附带的文献来源只按提供方回包展示；带引用不等于已核验其真实性、相关性或支持程度。

## 本轮验证（2026-09-13）

- 定向模拟测试：路由相关 84 项、应用集成 8 项、接入助手 19 项已分别通过。还覆盖失败重试保持供应商、实际模型别名审计，以及阻止将 DeepSeek 备用密钥继承给其他供应商。助手测试使用虚构密钥、临时文件和 MockTransport，没有读取真实密钥或发送真实请求。
- 主代理本地真实调用记录：DeepSeek 一次 3.604 秒，百川两次分别 8.336 秒、12.226 秒；单次规则报告 0.051 秒、模型调用 0 次。

这些是单次或少量虚构输入的功能检查，不是长期速度基准、医学准确性评估或服务可用性承诺；模拟测试通过也不能替代线上验收。

## 发布状态

本轮多模型自动路由的公网发布仍在进行，尚未在本文确认上线。最终部署、提交、CI 和公网验收状态由发布负责人完成检查后更新。
