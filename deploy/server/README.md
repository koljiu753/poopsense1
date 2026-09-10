# PoopSense Linux / 七牛云部署

这套编排把 Web、FastAPI、PostgreSQL 和 outbox worker 分成四个服务。数据写入
Docker volume，Agent 主动行动由独立常驻 worker 消费，适合七牛云或普通 Linux 云主机。

## 当前可直接上线的口径

2026-09-07 最新公开演示部署：dpl_7r7KFXqN2NsgtZEPMvHRiiNQaFw2，poopsense.org 已显示传感器产品范围和临时数据警示。线上模拟写入曾出现后续查询退回种子记录，当前对 Vercel + SQLite 强制关闭该入口；本地自动报告/反馈跟进已浏览器验证，但不是线上持久化验收。下一步需获准接入持久演示数据库，不能仅靠域名/发布把演示升级为真实用户内测。

当前前端仍使用演示家庭密钥，因此默认配置是“持久化比赛演示”，不是真实用户试运营。
它解决 Vercel 临时盘和部分国内网络无法访问 `vercel.app` 的问题，但只能放虚构数据。

## 启动

### 当前域名接入（2026-09-07）

用户确认域名为 `poopsense.org`。本轮已绑定到 Vercel 项目 `poopsense-live-demo`，尚未迁至本 Docker 编排。
用户已在 Spaceship 添加根域名 `@` 的两条 A 记录：`216.198.79.1` 和 `64.29.17.1`，名称服务器保持不变。2026-09-07 Vercel 验证配置正确且关联到当前演示部署。起初 HTTPS 握手失败；执行 `vercel certs issue poopsense.org` 成功后，HTTPS 首页返回 200，`/health` 返回 `{"status":"ok"}`。本轮未重测完整交互、手机网络或长期生产能力。将来迁移服务器时须按实际服务器地址重新配置。

```bash
cd deploy/server
cp .env.example .env
# 编辑 .env，替换 PostgreSQL 密码、DeepSeek 密钥和域名
docker compose up -d --build
docker compose ps
curl http://127.0.0.1/health
curl http://127.0.0.1/ready
```

在七牛云安全组只开放 80/443 和必要的 SSH 端口，不要对公网开放 5432 或 8000。
域名 HTTPS 由七牛云负载均衡/CDN 或主机前置网关终止，再回源到本机 80。

## 更新与回滚

```bash
docker compose pull
docker compose build
docker compose run --rm migrate
docker compose up -d
docker compose logs --tail=100 api worker
```

发布前保留旧镜像标签和 PostgreSQL 备份。数据库只做 Alembic 向前迁移，不在 API 启动时自动改表。

## 切换真实试运营前

实施顺序与验收见 [生产迁移验收](生产迁移验收.md)。2026-09-07 用户已同意开发独立登录；服务器尚未开通。当前代码主动阻止缺少独立身份功能时通过生产检查，不能只修改环境变量上线真实用户服务。

1. 完成正式身份、同意和凭证迁移，去掉前端演示密钥。
2. 把 `POOPSENSE_APP_ENV` 设为 `production`，把两个 `BOOTSTRAP_DEMO` 设为 `false`。
3. 在发布镜像内运行 `python scripts/production_preflight.py`，确保没有 `blocker=`。
4. 配置备份、日志保留、异常监控和外部通知渠道后，才允许真实健康数据进入。
