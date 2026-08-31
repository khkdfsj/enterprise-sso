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
- 完整网页管理后台：应用接入、回调地址、密钥轮换、准入规则、人员账号、换届和审计
- 业务系统发起的一次性快捷注册
- PHP 7.4 快速接入 SDK：业务页面只需引入一个守卫文件

## 当前生产入口

- 认证中心：`http://210.47.163.114/enterprise-sso`
- OIDC Discovery：`http://210.47.163.114/enterprise-sso/.well-known/openid-configuration`
- 使用范围：企业内网、校园网和受控 VPN

该入口复用校园网可达的 80 端口，不要求终端安装内部根证书。由于 HTTP 不加密，账号密码和会话在不可信网络中存在被窃听风险；仅限受控内网使用，扫码登录优先。

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

生产库已迁移 120 个 UserID、120 个当前任职和 3 名永久超级管理员；应用接入、人员账号、审计、年度换届、快捷注册与可回滚迁移均已提供网页管理能力。当前只以“生日祝福后台”作为业务接入试点，enrollmentPhoto、StuReg 和其他原系统继续使用各自原认证。企业微信扫码复用原 CorpID、AgentID、可信域名与集中 access token；新系统使用独立回调文件，不加载旧扫码系统代码。由于 118 不在企业微信可信 IP 列表内，UserID 查询通过 114 上受来源 IP 和共享密钥双重保护的单文件桥接完成。

## 部署边界

- 114：原有 80 端口下仅新增 `/enterprise-sso/` 精确子路径，并保留受限 SSH 反向代理
- 118：认证后端与全新专用 SQLite 数据库（WAL、外键、OIDC 敏感载荷加密）
- 浏览器只访问 `http://210.47.163.114/enterprise-sso/`
- 新数据库不复用现有 MariaDB 5.5，不向公网暴露
- 不新增 443、不强制 HTTPS、不发送 HSTS；除 `/enterprise-sso/` 外的现有路径不变

## 本地启动（开发）

1. 复制 `.env.example` 为 `.env` 并填写开发配置。
2. 安装依赖：`npm install`。
3. 创建全新数据库并执行：`npm run migrate`。
4. 写入开发种子：`npm run seed:dev`。
5. 启动：`npm run dev`。

通用生产环境应优先使用 HTTPS。本企业因校园网只放行 80，使用显式白名单开启受限 HTTP 例外；数据库文件不得放在 Web 根目录。任何更新必须先提交并推送 GitHub，再从明确的 commit 或 tag 发布；禁止只修改生产服务器。
