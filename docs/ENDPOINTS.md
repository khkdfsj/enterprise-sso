# Enterprise SSO 全部地址清单

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
| 企业微信回调 | `http://210.47.163.114/qywx/WeComVerificationSystem/enterprise-sso-callback.php` | 仅企业微信手机回调使用 |
| 手机确认中间页 | `http://210.47.163.114/enterprise-sso/wecom/mobile` | 由扫码流程自动使用 |

企业微信参数未完整配置时，扫码入口自动隐藏，密码登录仍可使用。

## 管理后台

网页管理后台地址：`http://210.47.163.114/enterprise-sso/admin`

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
