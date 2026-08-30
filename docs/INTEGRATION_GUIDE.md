# 应用接入指南

## 接入目标

业务系统不制作登录页，也不保存统一认证密码。未登录用户被重定向到认证中心，完成密码或企业微信扫码后返回原页面。

## 标准协议

- OpenID Connect
- Authorization Code
- PKCE S256
- 客户端认证：`client_secret_post`
- ID Token 签名：ES256
- Discovery：`https://210.47.163.114:8443/.well-known/openid-configuration`

禁止使用密码模式、隐式模式或自行模拟认证中心表单。

## 管理员登记应用

登记时需要：

- 应用名称；
- 精确的 HTTPS 回调地址；
- 是否允许所有有效人员进入，或按规则准入；
- 可选的固定 `client_id`。

系统返回 `client_id` 和只显示一次的 `client_secret`。密钥必须放入应用服务器的秘密配置，不得写入 Git、网页源码、前端 JavaScript 或日志。

## 应用处理流程

1. 为每次登录生成随机 `state`、PKCE verifier 和 challenge。
2. 将浏览器重定向到 Discovery 提供的 `authorization_endpoint`。
3. 回调时验证 `state`，以一次性授权码换取令牌。
4. 校验签名、`iss`、`aud`、过期时间和 nonce。
5. 使用 `sub` 作为本地永久人员主键。
6. 建立应用自己的 Session，并继续执行本应用的业务权限检查。

不要用姓名、账号、部门或职务作为人员主键；这些字段都会变化。

## 标准声明

- `sub`：永久人员 UUID。
- `name`：当前显示姓名。
- `preferred_username`：登录账号。
- `employee_no`：人员编号。
- `department`、`position`：当前主要任职。
- `authorization_version`：权限版本，可用于淘汰应用侧旧缓存。

## PHP 应用

PHP 7.4 项目优先使用仓库自带 SDK，参见 [QUICKSTART_PHP.md](QUICKSTART_PHP.md)。受保护页面第一行引入 `guard.php` 即可，不需要编写登录按钮和登录页面。

## 验收清单

- 未登录访问能回到原始页面；
- 回调地址与登记值逐字一致；
- 证书验证开启；
- `state` 和 PKCE 验证开启；
- 禁用应用后，现有 SSO 会话也不能进入；
- 退出只清理本应用 Session，不泄露令牌；
- 日志不记录授权码、令牌、密钥和完整 Cookie。
