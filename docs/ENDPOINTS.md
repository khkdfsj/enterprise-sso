# Enterprise SSO 全部地址清单

## 在职人员公开接口

`GET http://210.47.163.114/enterprise-sso/api/v1/public/people`

该接口无需登录或 Token，也不接收查询参数或请求体，允许跨域只读访问。它只返回状态为“启用”或“试用”且已启用“公开人员目录”的在职人员；自定义超级管理员、测试账号等管理身份可以单独隐藏。接口不返回部门、职位、手机号、密码、账号状态等其他信息。响应最多缓存 60 秒。

成功响应：

```json
{
  "ok": true,
  "request_id": "0b239ed3-10e6-4615-9fb8-9f3f83af7157",
  "count": 2,
  "people": [
    { "user_id": "2023195077", "name": "示例姓名" },
    { "user_id": "2024195001", "name": "示例姓名二" }
  ]
}
```

字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | boolean | 请求是否成功 |
| `request_id` | string | 本次请求编号；排障时提供给管理员 |
| `count` | number | 本次返回的人数 |
| `people[].user_id` | string | ESSO 唯一 UserID，即学号或工号 |
| `people[].name` | string | 人员姓名 |

请求频率超过限制时返回 HTTP 429；内部读取失败时返回 HTTP 500，并携带 `ESSO-PUBLIC-5000` 和问题编号。

## API 统一规范

- 所有业务 API 集中在 `/api/v1` 下，按领域划分为 `/public`、`/agent`、`/registrations` 和 `/integration-tests`。
- 资源名称使用小写复数名词；公开人员资源使用 `/public/people`，不在 URL 中使用动词。
- JSON 成功响应统一包含 `ok: true` 和 `request_id`；JSON 失败响应统一包含 `ok: false`、`request_id`、`error` 与 `message`。
- 客户端可发送 8 到 160 位合法 `X-Request-ID`；未发送时系统自动生成，并同时写入响应头 `X-Request-ID`。
- API 日期时间统一使用 ISO 8601 字符串；UserID 始终作为字符串处理，不能转换成数字。
- 浏览器页面和 OIDC 协议端点不归入业务 API：`/admin`、`/interaction`、`/register`、`/auth`、`/token` 等保持独立。

## Agent 自动接入 API

以下接口都要求 `Authorization: Bearer`、`X-ESSO-Agent-Identity` 和 `X-Request-ID`；完整请求体、幂等语义和错误码见 [AGENT_INTEGRATION.md](AGENT_INTEGRATION.md)。

- `GET /api/v1/agent/capabilities`：读取可用字段、固定包名和测试能力。
- `POST /api/v1/agent/services`：幂等登记服务并生成一次性包令牌。
- `GET /api/v1/agent/services/:id/package`：携带 `X-ESSO-Package-Token` 下载 `ESSO-DFSJ.zip`。
- `GET /api/v1/agent/services/:id`：查询服务地址和三项验收状态。
- `POST /api/v1/agent/services/:id/monitor`：启动 30 分钟持续连通监控。
- `POST /api/v1/agent/services/:id/tests/connectivity`：立即执行 Client Secret 签名连通检测。
- `GET /api/v1/integration-tests/:id/login`：接收 `test-login.php` 的短时 HMAC 登录验收回报。
- `GET /api/v1/integration-tests/:id/logout`：接收 `test-logout.php` 的短时 HMAC 注销验收回报。
- `GET /api/v1/integration-tests/:id/logout/start`：校验客户端 HMAC 并建立五分钟注销验收状态。

## 用户访问地址

| 用途 | 地址 | 说明 |
|---|---|---|
| 认证中心基础地址 | `http://210.47.163.114/enterprise-sso` | 校园网内使用 |
| OIDC 配置发现 | `http://210.47.163.114/enterprise-sso/.well-known/openid-configuration` | 接入应用自动读取端点 |
| 登录授权入口 | `http://210.47.163.114/enterprise-sso/auth` | 应用按 OIDC 参数跳转，不建议手工打开 |
| 退出入口 | `http://210.47.163.114/enterprise-sso/session/end` | 由接入应用调用 |
| 健康检查 | `http://210.47.163.114/enterprise-sso/healthz` | 正常返回 `{"ok":true}` |
| 管理后台 | `http://210.47.163.114/enterprise-sso/admin` | 统一认证管理员使用 |
| 快捷注册 | `http://210.47.163.114/enterprise-sso/register/{一次性令牌}` | 由业务系统生成后跳转，15 分钟单次有效 |

用户平时不需要先打开认证中心。应直接访问业务系统，由业务系统自动跳转到统一登录页面。

## OIDC 接入端点

以下地址以 Discovery 实际返回值为准：

| 用途 | 地址 |
|---|---|
| Authorization Endpoint | `http://210.47.163.114/enterprise-sso/auth` |
| Token Endpoint | `http://210.47.163.114/enterprise-sso/token` |
| UserInfo Endpoint | `http://210.47.163.114/enterprise-sso/me` |
| JWKS | `http://210.47.163.114/enterprise-sso/jwks` |
| Revocation Endpoint | `http://210.47.163.114/enterprise-sso/token/revocation` |
| Introspection Endpoint | `http://210.47.163.114/enterprise-sso/token/introspection` |
| Pushed Authorization Request | `http://210.47.163.114/enterprise-sso/request` |

接入程序不要硬编码除 Discovery 和 Issuer 以外的端点；应从 Discovery 自动读取。

## 企业微信地址

| 用途 | 地址 | 说明 |
|---|---|---|
| 企业微信回调 | `https://syauinfo.syau.edu.cn/qywx/enterprise-sso/callback.php` | 新系统独立回调，仅微信和企业微信使用 |
| 手机确认中间页 | `http://210.47.163.114/enterprise-sso/wecom/mobile` | 由扫码流程自动使用 |

企业微信参数未完整配置时，扫码入口自动隐藏，密码登录仍可使用。

## 管理后台

网页管理后台地址：`http://210.47.163.114/enterprise-sso/admin`

- 服务纵览：`http://210.47.163.114/enterprise-sso/admin/applications`
- 新增接入向导：`http://210.47.163.114/enterprise-sso/admin/applications/new`
- 连通与监控：`http://210.47.163.114/enterprise-sso/admin/monitoring`
- 人员与账号：`http://210.47.163.114/enterprise-sso/admin/people`
- 新增人员：`http://210.47.163.114/enterprise-sso/admin/people/new`
- 部门与职位：`http://210.47.163.114/enterprise-sso/admin/organization`
- 届次换届：`http://210.47.163.114/enterprise-sso/admin/terms`
- 开始五步换届：`http://210.47.163.114/enterprise-sso/admin/turnovers/new`
- 登录会话：`http://210.47.163.114/enterprise-sso/admin/sessions`
- 审计日志：`http://210.47.163.114/enterprise-sso/admin/audit`
- 接入文档：`http://210.47.163.114/enterprise-sso/admin/integration`

受控命令行仍可用于部署、应急恢复和批量操作：

- 首个超级管理员：`npm run admin:bootstrap`
- 登记应用：`npm run app:create`
- 发布届次：`npm run term:publish`
- 开始换届暂停：`npm run turnover:start`
- 设置或重置密码：`npm run account:set-password`
- DepartmentIFO 预演/迁移/回滚：`npm run personnel:import`

程序目录为 `/opt/enterprise-sso/current`，Node/npm 位于 `/opt/node-enterprise-sso/bin/`。具体命令参见 [ADMIN_GUIDE.md](ADMIN_GUIDE.md)。

## 快捷注册 API

| 用途 | 地址 |
|---|---|
| 创建快捷注册链接 | `POST http://210.47.163.114/enterprise-sso/api/v1/registrations` |

只有管理员明确启用 `provisioning_enabled` 的机密客户端可以调用。应用使用 HTTP Basic 客户端认证，提交 `user_id` 和 `display_name`；用户密码只在认证中心页面设置。

## 已接入业务入口

| 系统 | 入口 |
|---|---|
| 生日祝福后台 | `http://210.47.163.114/qywx/BirthdayWishes/admin/` |
enrollmentPhoto、StuReg 及其他业务保持原认证方式，不接入本次试点。

## 服务器内部地址

这些地址不提供给普通用户：

| 位置 | 地址 | 作用 |
|---|---|---|
| 114 回环代理 | `http://127.0.0.1:13000` | 受限 SSH 隧道入口 |
| 118 认证后端 | `http://127.0.0.1:3000` | Node.js 服务，仅回环监听 |
| 118 SQLite | `/var/lib/enterprise-sso/enterprise-sso.sqlite3` | 生产数据库，不在 Web 目录 |
| 114 企业微信 UserID 桥 | `/qywx/WeComVerificationSystem/sso-userinfo-bridge.php` | 只接受 118 POST，并同时校验共享密钥；不提供给用户或业务系统 |

## 证书文件

- 可分发根证书：`deploy/enterprise-sso-internal-ca.crt`
- 114 服务器根证书：`/etc/enterprise-sso/tls/ca.crt`
- CA 私钥：只保存在 114 的受限目录，禁止下载或提交 GitHub。

本系统仅占用 80 端口的 `/enterprise-sso/` 子路径，不重定向其他路径、不新增 443、不发送 HSTS。HTTP 不提供链路加密，仅限受控校园网使用，优先选择企业微信扫码登录。
