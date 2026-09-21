# Reader 公网硬件测试客户端

准备日期：2026-09-21。此目录是新 Reader 客户端，不覆盖“本地展会版”。Python 3.10 及以上，全部使用标准库，不用安装第三方包。

**当前状态：客户端与合成样例已准备，用户已完成云服务条款确认；公网持久化、设备登记、部署与验收以软件侧随后提供的实际记录为准。没有收到队友真实采样文件，也没有在本包中伪造公网成功回执。** 本包存在不表示设备已经联网。客户端 34 项离线测试通过，合成样例通过本轮主后端 `DeviceSessionInput` 校验；这些不代替公网或硬件验收。

固定网站与 API 来源：[Reader](https://poopsense-reader-0912.vercel.app/)。工具固定使用该域名，不要求队友填写 BASE_URL，也不允许把设备密钥跟随重定向传往其他域名。

| 项目 | 固定地址或当前状态 |
|---|---|
| 上传 | `https://poopsense-reader-0912.vercel.app/api/v1/device-sessions` |
| 查询单条设备记录 | `https://poopsense-reader-0912.vercel.app/api/v1/devices/{device_id}/sessions/{session_id}` |
| 统一接口契约 | `https://poopsense-reader-0912.vercel.app/api/v1/openapi.json`；需与本次实际部署核对 |
| 设备鉴权 | `X-Device-Key`；设备密钥单独安全交付，不在本包中 |
| 样例设备 / 家庭 | `dev_hardware_test_001` / `hh_hardware_test`；拟登记标识，尚不是已登记证明 |
| 拟测试成员 | `m_hardware_test_001`；完成登记后再用于网页认领 |
| 网页家庭查看凭据 | 另一份凭据，由软件侧单独配置；不是设备密钥，不交给上传程序 |
| 大模型密钥 | 仅服务端使用，上传程序不需要 |

## Mac：先离线检查和保存

在终端进入本目录，运行：

```sh
python3 --version
python3 reader_device.py check --file request-simulated.json
python3 reader_device.py save --file request-simulated.json --outbox reader-outbox
```

`check` 只检查 JSON、ID 和测试来源，**不代替服务端完整字段校验**。`save` 输出 `saved_file`，这是后续补传和查询使用的原包路径。原文件的空格、换行、时间、序号、ID、相似度均保持原字节，不改写。

软件侧确认该环境已登记并提供独立设备密钥后，再执行：

```sh
python3 reader_device.py upload --file request-simulated.json --outbox reader-outbox
```

按提示粘贴设备密钥，输入不显示。查询使用前一步 `saved_file` 的实际路径：

```sh
python3 reader_device.py status --file "reader-outbox/实际保存的文件名.json"
```

## Windows：相同步骤

用 PowerShell 进入本目录，运行：

```powershell
py -3 --version
py -3 reader_device.py check --file request-simulated.json
py -3 reader_device.py save --file request-simulated.json --outbox reader-outbox
py -3 reader_device.py upload --file request-simulated.json --outbox reader-outbox
py -3 reader_device.py status --file "reader-outbox\实际保存的文件名.json"
```

上传和查询会分别隐藏询问设备密钥。若电脑只有 `python` 而没有 `py`，把 `py -3` 改成 `python`。Mac/Windows 命令来自标准 Python 用法，当前没有完成 Mac 真机、USB 串口或硬件采集程序验收。

设备密钥也可以通过当前进程的 `POOPSENSE_DEVICE_KEY` 环境变量提供，便于接到采集程序。建议由进程的安全配置注入，不把密钥直接写入命令、代码、JSON、Git 或截图。不要把 `.env` 文件放进转发包；工具不会自动读取 `.env`。

## 从采集程序接入

这个工具只处理采集程序**已经输出**的约定 JSON，不读串口，不控制 ESP32，不做校准，也不自动猜测旧字段含义。每次独立采样先生成新 `session_id`、`correlation_id`，写入真实带时区起止时间和递增序号，再保存到文件。让采集程序以子进程调用 `reader_device.py upload --file 文件路径 --outbox reader-outbox`，通过环境给该进程提供设备密钥。

先用 `request-simulated.json` 合成样例验证软件路径，不能把它改一个标签就称为实采。拿到队友真实文件并完成字段映射后，真实传感试验填 `hardware_test`，仍属于测试数据。

| 实际数据 | 契约写法与限制 |
|---|---|
| 形状 | `elongated` / `compact` / `scattered` / `irregular`；不是布里斯托分类 |
| 颜色 | `red` / `green` / `blue` / `yellow`；`red` 不是出血结论 |
| 模板相似度 | 仅颜色的 `template_similarity`，数值原样保存；`similarity_scale` 为 `0_1`、`0_100` 或 `unknown`；不知道量纲就写 `unknown`，不转成百分比或置信度 |
| 置信度 | 三维 `confidence: null`，不得将模板相似度填到这里 |
| 气味 | `value: null`，`missing_reason: "sensor_disabled"` |
| 温度、湿度 | `temperature_c: null`、`humidity_pct: null` |
| 在场 / 成员 | `presence_state: "unknown"`，`member_candidates: []`，不猜测是谁 |
| 时长 | `duration_s` 是手动采样窗口，非真实如厕时长；起止时间带时区 |
| 采集状态 | `partial` 或 `failed`；不改为 `completed` 来绕过质量门控 |
| 质量 | `overall_confidence: 0`，非空缺失原因，`session_kind: "manual_sampling"`、`duration_semantics: "manual_sampling_seconds"` |

顶层和嵌套未知字段按服务端契约拒绝。颜色或形状没采到时填 `value: null` 和真实 `missing_reason`。本样例的 `0.72`、时间和所有观测都是合成演示，不能作为硬件测量证据。

## 补传、查询和网页核对

1. `upload` 一律先保存原包，再发送保存副本。每次只发一请求，不自动重试。保留 `reader-outbox` 和采集原文件。
2. 收到 HTTP 202 后检查 `session_id`、`duplicate`、归属和评估状态。202 代表接收回执，不证明数据库已通过持久化验收，也不代表 LLM 报告完成。
3. 同 `device_id + session_id` 的同包补传仍是 202，`duplicate: true`；异包应为 409。本地工具还会拒绝覆盖同标识的不同字节，即使只是改了空格也请使用归档原包。
4. 超时、网络失败或 5xx 时结果未知。先用 `status --file 归档文件` 查询；必要时 `upload --file 归档文件 --outbox reader-outbox` 原样补传，不能重新生成 ID、时间、序号或相似度。
5. GET 返回 `raw_observations`、`sampling`、`processing`。同步规则已完成但资料不足可以同时成立；不要因为“无法可靠判断”就循环等待“正常”。设备查询不需要家庭管理密钥。
6. 在 Reader 的同一测试家庭打开“健康 → 记录”，按 `session_id` 核对待认领条目、认领给测试成员，再查看原始观测、相似度、手动采样时长和规则处理状态。网页新增查询/展示功能需以后续实际发布与验收记录为准，不以本说明代替发布。

GET 结果的三个分组与本轮主后端契约一致：

| 分组 | 字段 |
|---|---|
| `raw_observations` | 每维含 `value`、`confidence`、`missing_reason`、`source`、`model_version`、`change_pct`、`template_similarity`、`similarity_scale` |
| `sampling` | `session_kind`、`duration_semantics`、`started_at`、`ended_at`、`duration_s`、`presence_state`、`collection_state`、`temperature_c`、`humidity_pct`；起止时间为带时区 UTC |
| `processing` | `analysis_complete`、`analysis_source`、`assessment_status`、`reliable`、`risk_level`、`message`、`reasons`、`llm_status` |

手动采样的 `llm_status` 为 `not_applicable`；规则可以 `analysis_complete: true`，同时 `assessment_status: "unable_to_determine"`、`reliable: false`。POST 回执也包含 `processing`。不把“已处理”变成“身体正常”，不将相似度转换成健康结论。

| 客户端提示 | 处理 |
|---|---|
| 401 `DEVICE_AUTH_FAILED` | 检查是否拿到该设备的新密钥；不要使用本地展会或公开演示密钥 |
| 403 `DEVICE_BINDING_DENIED` | 核对家庭 ID 与设备当前绑定 |
| 404 `RECORD_OR_ROUTE_NOT_FOUND` | 可能记录不存在，也可能新查询路由尚未发布；联系软件侧核查，不能认为上传成功 |
| 409 `IDEMPOTENCY_CONFLICT_KEEP_ORIGINAL` | 保留原包与原记录，不覆盖；新一次采样才用新 ID |
| 422 `PAYLOAD_VALIDATION_FAILED` | 核对带时区时间、字段和嵌套枚举；工具不会把服务端原始错误内容直接写日志 |
| `OUTBOX_ID_ALREADY_HAS_DIFFERENT_BYTES` | 同标识归档已有另一份内容；找回原包，不删除原归档来强行覆盖 |
| `NETWORK_ERROR_RECEIPT_UNKNOWN_KEEP_ORIGINAL` | 原包已保存，查询或按原包补传 |
| `REDIRECT_REFUSED` | 不会转发密钥，交软件侧核查固定 Reader 路由 |

## 尚待补齐的实际验收

当前目录没有真实公网成功回执、GET 实收结果或已登记凭据文件。后续软件侧需要在同一 Reader 环境补齐：已迁移 PostgreSQL、设备/家庭登记与单独密钥交付、上传202与查询、同包去重和异包冲突、网页认领、服务重启/重新部署后读取、备份恢复。跨设备/跨家庭拒绝和非法值422也需保留对应实测证据。

USB 实采、队友真实文件、Mac 真机、现场 Windows 采集和稳定性仍需要硬件侧一起验收。客户端离线通过不等于以上事项完成。
