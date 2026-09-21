# Reader 公网硬件联调说明

核对日期：2026-09-21（北京时间）。本说明随 `联调交付/Reader公网版/` 一起交付，不覆盖“本地展会版”。客户端需要 Python 3.10 及以上，全部使用标准库，不用安装第三方包。

**Reader 公网已实际接收一条明确标为 `simulated` 的合成采样，完成查询、网页认领和原始观测核对；测试家庭、设备和成员已登记。** 当前服务连接 PostgreSQL，仍是测试/demo 环境。另已验证服务重新部署后同一记录和归属保留，以及一次独立数据库备份恢复；没有建立自动定时备份。尚未收到队友真实采样文件，不代表 ESP32、USB、Mac 真机或现场采集链路已通过。手动采样链路不调用大模型；重新部署后另做了一次独立问答检查。

固定网站与 API 来源：[Reader](https://poopsense-reader-0912.vercel.app/)。工具固定使用该域名，不要求队友填写 BASE_URL，也不允许把设备密钥跟随重定向传往其他域名。

| 项目 | 固定地址或当前状态 |
|---|---|
| 上传 | `https://poopsense-reader-0912.vercel.app/api/v1/device-sessions` |
| 查询单条设备记录 | `https://poopsense-reader-0912.vercel.app/api/v1/devices/{device_id}/sessions/{session_id}` |
| 家庭单条查询 | `https://poopsense-reader-0912.vercel.app/api/v1/households/hh_hardware_test/sessions/{session_id}`；使用家庭授权 |
| 统一接口契约 | [实际在线 OpenAPI](https://poopsense-reader-0912.vercel.app/api/v1/openapi.json)，本目录附本次下载快照 |
| 设备鉴权 | `X-Device-Key`；设备密钥单独安全交付，不在本包中 |
| 已登记设备 / 家庭 | `dev_hardware_test_001` / `hh_hardware_test`；设备绑定该测试家庭 |
| 已登记测试成员 | `m_hardware_test_001`；在 Reader 中人工认领 |
| 网页家庭查看凭据 | `X-Household-Key`；另一份家庭访问密钥，由软件侧单独交付，填入网页家庭连接设置，不交给上传程序 |
| 大模型密钥 | 仅服务端使用，上传程序不需要 |

设备密钥与家庭访问密钥由软件负责人分别安全交付，目录不含这两份凭据。旧本地展会密钥和公开演示密钥不能用于本公网设备。设备 GET 不返回成员身份或私人资料。

## 目录文件与已验收记录

| 文件 | 用途 |
|---|---|
| `README-先看这里.md` | 本说明 |
| `reader_device.py` | 检查、保存原包、上传、按同 ID 查询 |
| `request-simulated.json` | 合成模板，保留 `simulated`；其中 `0.72 / unknown` 不是实测值或已知量纲 |
| `request-accepted-simulated-20260921.json` | 实际成功请求；文件字节 SHA256 与成功客户端补传原包一致 |
| `receipt-202-20260921.json` | 首次实际 202 回执，`duplicate: false` |
| `receipt-duplicate-20260921.json` | 客户端原包补传的实际 202 回执，`duplicate: true` |
| `device-result-200-20260921.json` | 认领前实际设备 GET 结果，不含成员身份 |
| `household-result-after-claim-20260921.json` | 网页认领后实际家庭 GET 结果，归属上述测试成员 |
| `openapi-reader-20260921.json` | 实际已部署主应用的完整 OpenAPI 快照 |
| `verification-20260921.json` | 脱敏验收摘要、时间、待完成项及文件校验值 |
| `SHA256SUMS.txt` | 上述交付文件的 SHA256 清单，不包含密钥、数据库备份或私有路径 |

已验收的记录 ID 是 **`reader_synthetic_f2ee7ca349474773`**，当前已经认领，不会再作为新待认领记录出现。设备 GET 文件是认领前快照，之后实时查询的状态可以变为 `confirmed`。这些文件证明合成数据走通真实公网，不是硬件实采证明。

## Mac：先离线检查和保存

在终端进入本目录，运行：

```sh
python3 --version
python3 reader_device.py check --file request-simulated.json
python3 reader_device.py save --file request-simulated.json --outbox reader-outbox
```

`check` 只检查 JSON、ID 和测试来源，**不代替服务端完整字段校验**。`save` 输出 `saved_file`，这是后续补传和查询使用的原包路径。原文件的空格、换行、时间、序号、ID、相似度均保持原字节，不改写。

从软件侧取得该设备的独立密钥后，再执行：

```sh
python3 reader_device.py upload --file request-simulated.json --outbox reader-outbox
```

按提示粘贴设备密钥，输入不显示。查询使用前一步 `saved_file` 的实际路径：

```sh
python3 reader_device.py status --file "reader-outbox/实际保存的文件名.json"
```

只想先查询已验收记录、不新上传时，运行：

```sh
python3 reader_device.py status --file request-accepted-simulated-20260921.json
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

只查询已验收记录时：

```powershell
py -3 reader_device.py status --file request-accepted-simulated-20260921.json
```

上传和查询会分别隐藏询问设备密钥。若电脑只有 `python` 而没有 `py`，把 `py -3` 改成 `python`。Mac/Windows 命令来自标准 Python 用法，当前没有完成 Mac 真机、USB 串口或硬件采集程序验收。

设备密钥也可以通过当前进程的 `POOPSENSE_DEVICE_KEY` 环境变量提供，便于接到采集程序。建议由进程的安全配置注入，不把密钥直接写入命令、代码、JSON、Git 或截图。不要把 `.env` 文件放进转发包；工具不会自动读取 `.env`。

## 从采集程序接入

这个工具只处理采集程序**已经输出**的约定 JSON，不读串口，不控制 ESP32，不做校准，也不自动猜测旧字段含义。每次独立采样先生成新 `session_id`、`correlation_id`，写入真实带时区起止时间和递增序号，再保存到文件。让采集程序以子进程调用 `reader_device.py upload --file 文件路径 --outbox reader-outbox`，通过环境给该进程提供设备密钥。

先用 `request-simulated.json` 合成样例验证软件路径，不能把它改一个标签就称为实采。再次演练独立待认领流程时另建新模拟文件、使用新 ID，仍填 `simulated`。拿到队友真实文件并完成字段映射后，真实传感试验另存新文件，使用新 `session_id` / `correlation_id`、真实时间、序号和版本，填 `hardware_test`，仍属于测试数据。不要修改已验收原包来制造一条“真实记录”。

| 实际数据 | 契约写法与限制 |
|---|---|
| 形状 | `elongated` / `compact` / `scattered` / `irregular`；不是布里斯托分类 |
| 颜色 | `red` / `green` / `blue` / `yellow`；`red` 不是出血结论 |
| 模板相似度 | 仅颜色的 `template_similarity`，有限数值原样保存；`similarity_scale` 为 `0_1`、`0_100` 或 `unknown`，已声明量纲须在对应范围内；不知道量纲就写 `unknown`，不转成百分比或置信度 |
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
6. 在 Reader 的同一测试家庭打开“健康 → 记录”，按下节步骤核对、认领和查看。202、规则处理完成和健康判断可靠是不同状态，不要互相替代。

## Reader 连接测试家庭、查找与认领

1. 打开 [Reader](https://poopsense-reader-0912.vercel.app/)。首次默认家庭不能读取时，页面会提供“连接你的测试家庭”；已进入页面则到“我的 → 开发连接设置”。
2. **API 地址留空**，使用当前 Reader 同域服务；家庭 ID 填 `hh_hardware_test`，家庭访问密钥填单独取得的家庭凭据。点“保存并重新连接”，程序先验证授权，通过后才切换。凭据只保存到当前浏览器会话，新会话可能需重新填写。
3. 打开“健康 → 记录”。展开待认领条目的“原始观测与处理状态”，核对完整 `session_id`；在“这是谁的记录？”中选择本次测试成员，点“确认归属”。
4. 也可在“查找记录 ID”粘贴上传回执的完整 ID，点“查找”。此处直接读取单条授权记录，不受最近 50 条列表限制。待认领结果可点“刷新待认领箱”；认领后显示“已归属”。
5. 展开原始观测，核对分类、模板相似度和量纲、缺失原因、手动采样时长、规则与大模型状态。点“刷新这条记录”重新读取同一个 ID。

本次实际样例应显示：条状 `elongated`、红色 `red`、模板相似度 **82.3，量纲 0–100**、气味 `sensor_disabled`、在场未知、手动采样 **10 秒**；规则已完成但无法可靠判断健康状态，大模型健康报告不适用。该样例在网页标为“模拟记录”。

待认领箱在页面可见时约每 5 秒检查一次，后台暂停，回来再检查；读取失败会显示局部提示。采集状态为 partial 仍能查看实际上传的形状、颜色，不需要提高置信度。认领不会把不可靠数据变可靠。

## 处理状态与常见错误

GET 结果的三个分组与本轮主后端契约一致：

| 分组 | 字段 |
|---|---|
| `raw_observations` | 每维含 `value`、`confidence`、`missing_reason`、`source`、`model_version`、`change_pct`、`template_similarity`、`similarity_scale` |
| `sampling` | `session_kind`、`duration_semantics`、`started_at`、`ended_at`、`duration_s`、`presence_state`、`collection_state`、`temperature_c`、`humidity_pct`；起止时间为带时区 UTC |
| `processing` | `analysis_complete`、`analysis_source`、`assessment_status`、`reliable`、`risk_level`、`message`、`reasons`、`llm_status` |

手动采样的 `llm_status` 为 `not_applicable`；规则可以 `analysis_complete: true`、`analysis_source: "rules"`，同时 `assessment_status: "unable_to_determine"`、`reliable: false`。POST 回执也包含 `processing`。这是当前手动采样的处理终点，不应循环等待它变成“身体正常”或“模型完成”；不将相似度转换成健康结论，不让手动采样进入可靠个人健康基线。

| 客户端提示 | 处理 |
|---|---|
| 401 `DEVICE_AUTH_FAILED` | 检查是否拿到该设备的新密钥；不要使用本地展会或公开演示密钥 |
| 403 `DEVICE_BINDING_DENIED` | 核对家庭 ID 与设备当前绑定 |
| 404 `RECORD_OR_ROUTE_NOT_FOUND` | 核对记录 ID、设备和固定 Reader 地址；联系软件侧核查，不能认为上传成功 |
| 409 `IDEMPOTENCY_CONFLICT_KEEP_ORIGINAL` | 保留原包与原记录，不覆盖；新一次采样才用新 ID |
| 422 `PAYLOAD_VALIDATION_FAILED` | 核对带时区时间、字段和嵌套枚举；工具不会把服务端原始错误内容直接写日志 |
| `OUTBOX_ID_ALREADY_HAS_DIFFERENT_BYTES` | 同标识归档已有另一份内容；找回原包，不删除原归档来强行覆盖 |
| `NETWORK_ERROR_RECEIPT_UNKNOWN_KEEP_ORIGINAL` | 原包已保存，查询或按原包补传 |
| `REDIRECT_REFUSED` | 不会转发密钥，交软件侧核查固定 Reader 路由 |

## 本次实际验收与待补充项

来源为同一 Reader 公网的实际 API 和浏览器证据，非 mock。首次 API 检查截至 **2026-09-21 23:10（北京时间）**，认领浏览器检查于 **23:07** 完成；重新部署验证及备份恢复于 **23:14–23:17** 完成。详见 `verification-20260921.json`。

| 检查 | 本次结果 |
|---|---|
| 服务与登记 | PostgreSQL 连接正常、按迁移管理结构；上述家庭/设备/成员已登记，demo 模式 |
| 上传与查询 | 实际 202、设备 GET 200；同包 202 去重、修改相似度 409 |
| 校验与隔离 | 未知嵌套字段/越界分数 422；错误密钥/其他设备 401、其他家庭 403 |
| Reader 闭环 | 同 ID 可见、人工认领至测试成员、原始观测核对、ID 查找及浏览器刷新后重读通过；320/390 宽度检查通过，最终未捕获 JS 错误 |
| 健康数据边界 | 本次手动采样未增加可靠个人基线；规则已完成、LLM 不适用，手动采样链路真实模型调用 0 |
| 服务重新部署后读取 | 23:14 实际后端重新部署后，同一 ID 的观测和认领归属保留，同包仍去重；23:17 独立浏览器再次查找和刷新通过 |
| 备份恢复 | 23:17:44 完成一次 PostgreSQL 快照导出→全新独立云库恢复→32 张表逐行内容摘要核对；同一记录和认领归属保留，仅临时恢复库已清理 |
| 原有问答 | 重新部署后额外 1 次 DeepSeek 问答 HTTP 200；它与手动采样不适用 LLM 的状态分开，不是采样健康报告 |
| 真实硬件、队友文件、Mac/现场 Windows、USB、长期稳定性 | 尚未验收 |

备份恢复使用 PostgreSQL 18.6 的 `pg_dump` / `pg_restore`，验证的是本次快照；**不是自动定时备份、持续恢复演练或长期保存承诺**。数据库备份包含环境数据，未放入本转发目录。

此前浏览器尝试有一次原因未确认的超时和一次点击位置被底栏遮挡；最终使用正常滚动完成，无强制点击。保留失败记录，不把最终单次通过说成长期稳定。当前 `production_ready: false`，独立用户身份和常驻后台处理仍有生产缺口；不影响已验证的测试上传与同步规则处理。

转发本文列出的交付文件即可；不附密钥、`.env`、`reader-outbox`、`__pycache__` 或其他本地运行目录。设备密钥和家庭访问密钥仍单独安全交付。
