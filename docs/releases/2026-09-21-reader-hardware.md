# 2026-09-21 Reader 公网硬件测试链路

用户指定的 [Reader](https://poopsense-reader-0912.vercel.app/) 现可接收手动采样记录、保存到独立 PostgreSQL 测试库，在原页面认领和回看原始观测。旧 Family 页面没有作为本次验收入口，独立 Exhibition 本地包继续保留作备用。

## 已部署的行为

- `POST /api/v1/device-sessions` 接收 `manual_sampling`，严格校验顶层、quality 和 observation 字段。模板相似度、量纲、采样用途和数据来源均保存并参与去重；未知字段和非法值422，同设备同ID同包复用，异包409。
- `GET /api/v1/devices/{device_id}/sessions/{session_id}` 使用独立设备密钥，检查当前设备/家庭绑定，只返回该设备事实与处理状态，不返回成员资料。Reader同域的 `/api/v1/openapi.json` 提供实际契约。
- 原始形状/颜色、相似度、缺失原因和手动采样时长不再随健康质量门控被隐藏。规则处理完成与大模型报告状态分别显示；手动采样明确无法可靠判断，大模型报告不适用，认领后也不进入健康基线、红线或自动模型报告。
- Reader支持独立家庭连接、可见页面待认领自动刷新、精确ID查找、认领和历史查看。保留家庭权限与现有问答入口；连接失败不覆盖原连接，多设备重名ID返回409而不是任取一条。
- 云端使用免费 Neon PostgreSQL 18.6，执行迁移至 `b92f17c03a64`，32张表。一次性登记独立测试家庭/成员/设备和分离凭据，关闭自动建表与启动种子；演示家庭仅一次性放入虚构样例。未将旧临时SQLite实例的历史当作已迁移数据。

PostgreSQL外键检查暴露了旧问答同时写父子记录的顺序问题。修复为先flush会话/运行主记录，再写消息/步骤/交接，仍在原事务中提交；新增真实外键和事务回滚回归。

## 实际验收

2026-09-21（北京时间）上传的 `reader_synthetic_f2ee7ca349474773` 明确标为 `simulated`。它是本次合成样例，不是硬件队友提供的测量文件。

| 验收 | 本轮结果 |
| --- | --- |
| Reader同域上传、查询 | 首次202；设备GET200，保留elongated、red、相似度82.3及0–100量纲、sensor_disabled、unknown在场和10秒手动窗口 |
| 去重及校验 | 同包202/duplicate；修改相似度409；未知嵌套字段/越界值422 |
| 权限隔离 | 错误或其他设备密钥401，跨家庭403；含已有公共演示家庭的双向隔离 |
| 真实网页 | 不模拟响应，待认领出现同ID，认领给测试成员后按ID查找、刷新仍可读；320/390宽无横溢出 |
| 重新部署 | 后端换为新部署后，同记录原始观测、归属和处理状态一致，再上传原包仍duplicate |
| 云库备份恢复 | 23:11–23:17，实际Neon数据库pg_dump快照恢复至独立新建云库，32表行数/内容摘要一致，同条已认领记录恢复成功；仅临时恢复库已删除 |
| 问答回归 | 修复后一次实际DeepSeek请求200、1.901秒，返回deepseek-v4-pro；运行及步骤可读取。这是单次功能验收，不是稳定时延承诺 |

浏览器最终完成24个HTTP200（23读、1认领），认领约381毫秒，无模拟响应、捕获JS错误或已失败请求；收集证据时还有一个正常轮询未完成。首次浏览器查询超时未在后续重现，原因未证实，保留失败证据；另一次脚本点击落点被底栏遮挡，经正常滚动解决，未用强制点击或接口模拟代替验收。

重新部署后的新浏览器再次执行只读查询及刷新，19个真实GET200，同ID、同成员及观测保持不变。第一次复查脚本把状态误写为assigned，按源码的confirmed修正后通过，原失败证据保留。

云库恢复使用与服务端同主版本的pg_dump/pg_restore 18.6，导出一致性快照；恢复目标是新建的空数据库，未覆盖源库。备份141243字节，SHA256 `e8ccc9fb3d64f56e11caa7f9c61327169817a460cd98aabe69a89d40d27fc67c`。备份文件保存在本机私密目录，未公开或放入联调包。本次仅验证一次手动备份恢复，尚未设置自动备份任务或长期保留策略。

## 验证与发布

代码 `b9cd291` 本地完整后端582项通过，前端173项及TypeScript/生产构建通过。最终问答修复 `402d273` 新增6项开启外键的测试、既有86项问答回归均通过；[GitHub CI 35617226499](https://github.com/koljiu753/poopsense1/actions/runs/35617226499) 完整后端588项、前端173项、TypeScript/构建及postgres-demo均成功。独立PostgreSQL17容器实际验证迁移、初始化、跨进程读取、同包/异包两线程竞争、32表备份恢复以及问答父子记录约束；容器验收与下面的实际云库验收分别记录。

Reader部署 `dpl_FQueo9Y2kEF1pfgmaFFJGPh7W9ib`，最终后端部署 `dpl_Ah6CFfDwMjevcD2NAxSspe34sMi2` 均为READY，固定入口不变。公网前端资源与本地构建哈希一致：`index-BabM4JQs.js`、`index-DDUW1c__.css`。六类文字任务仍使用DeepSeek，单次记录与后台动作走规则；本次未重新切换模型。

## 交付与范围

硬件队友可下载 [Reader公网联调包（ZIP）](../hardware/PoopSense-Reader公网联调-20260921.zip)，按 [Python上传与查询说明](../../backend/scripts/README-reader-device.md) 操作，设备/家庭/成员均已登记。包内11文件包括实际OpenAPI、请求/回执和校验清单，SHA256 `510647f76fada9703a29a945bc1e279aefde618a71ea78be3bae257fdfbd352d`。设备密钥与家庭查看密钥分别另交，均不在Git、OpenAPI或转发包内。每次新采集生成新ID，补传保存的原文件；已收同ID异内容冲突时不要重新伪造时间绕过去重。

真实硬件文件、ESP32/USB采集、Mac运行与微信真机尚未验收。当前 `app_env=demo`、worker关闭、`production_ready=false`；独立用户登录和正式后台执行未上线。本次持久化测试不代表正式健康服务、医疗有效性或长期可用性承诺。

内部证据位于本地 `.codex-qa/reader-public-hardware-20260921.json`、`reader-public-browser-20260921-summary.json`、`reader-public-redeploy-20260921.json`、`reader-post-redeploy-browser-20260921-v2.json`、`reader-neon-backup-restore-20260921.json`、`reader-chat-fk-20260921-ci.json`；不将含私密环境配置、原始日志或数据库备份公开。
