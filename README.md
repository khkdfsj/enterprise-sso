# Enterprise SSO

全新的企业统一身份认证系统，与旧 `WeComVerificationSystem`、`DepartmentIFO` 和 `auth-monitor` 不共享代码、数据库、Session 或密钥。

核心能力：

- OpenID Connect Authorization Code + PKCE
- 统一托管登录页面，接入应用无需自行开发登录页
- 账号密码登录
- 企业微信扫码登录事务
- 有限时单点登录
- 应用准入权限
- 最小人员、届次和任职模型
- UserID（企业微信 UserID / 学号）作为人员唯一主键
- 网页人员后台、换届暂停/发布、永久账号
- 业务系统发起的一次性快捷注册
- PHP 7.4 快速接入 SDK：业务页面只需引入一个守卫文件

## 当前生产入口

- 认证中心：`https://210.47.163.114:8443`
- OIDC Discovery：`https://210.47.163.114:8443/.well-known/openid-configuration`
- 使用范围：企业内网、校园网和受控 VPN

受管终端必须先安装 [`deploy/enterprise-sso-internal-ca.crt`](deploy/enterprise-sso-internal-ca.crt)。该文件只有公开证书，不包含 CA 私钥。

## 文档导航

- [普通用户使用手册](docs/USER_GUIDE.md)
- [全部地址清单](docs/ENDPOINTS.md)
- [系统总说明](docs/SYSTEM_MANUAL.md)
- [应用快速接入总指南](docs/INTEGRATION_GUIDE.md)
- [PHP 7.4 一页接入](docs/QUICKSTART_PHP.md)
- [管理员手册](docs/ADMIN_GUIDE.md)
- [换届与人员管理设计](docs/PERSONNEL_AND_TURNOVER.md)
- [生产运维与发布回滚](docs/OPERATIONS.md)
- [安全边界](docs/SECURITY.md)
- [数据库选型与 118 MariaDB 评估](docs/DATABASE_DECISION.md)
- [系统架构](docs/ARCHITECTURE.md)
- [版本记录](CHANGELOG.md)
- [2026-08-31 实施与迁移验收](docs/IMPLEMENTATION_STATUS_2026-08-31.md)
- [供开发 Agent 使用的接入 Skill](skills/enterprise-sso-integration/SKILL.md)

## 当前阶段

`v0.2.2` 已部署。生产库已迁移 120 个 UserID、120 个当前任职和 3 名永久超级管理员；网页后台、年度换届、快捷注册与可回滚迁移已完成。生日祝福、enrollmentPhoto 和 StuReg 三个隔离入口已通过真实密码登录和跨应用免重复认证。企业微信扫码支持 `CorpSecret` 直连和内部集中 access token 两种令牌模式，生产启用状态以部署记录为准。

## 部署边界

- 114：独立 `8443` HTTPS 入口和受限 SSH 反向代理
- 118：认证后端与全新专用 SQLite 数据库（WAL、外键、OIDC 敏感载荷加密）
- 浏览器只访问 `https://210.47.163.114:8443`
- 新数据库不复用现有 MariaDB 5.5，不向公网暴露
- 不修改 114 原 Nginx 主配置，不占用或跳转原有 80/443，不发送 HSTS
- 使用企业内部 CA；受管电脑需预先信任 `/etc/enterprise-sso/tls/ca.crt`

## 本地启动（开发）

1. 复制 `.env.example` 为 `.env` 并填写开发配置。
2. 安装依赖：`npm install`。
3. 创建全新数据库并执行：`npm run migrate`。
4. 写入开发种子：`npm run seed:dev`。
5. 启动：`npm run dev`。

生产环境必须使用 HTTPS、独立密钥、受支持的 Node.js LTS 以及持久化 OIDC Adapter。数据库文件不得放在 Web 根目录。任何更新必须先提交并推送 GitHub，再从明确的 commit 或 tag 发布；禁止只修改生产服务器。
