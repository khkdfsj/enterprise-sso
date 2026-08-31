# PHP 7.4 快速接入

接入应用不制作登录页面。未登录用户由统一认证中心显示密码与企业微信扫码入口；认证成功后返回原页面。

## 接入步骤

1. 管理员打开 `http://210.47.163.114/enterprise-sso/admin/applications`，登记应用名称和精确回调地址，取得 `client_id` 与只显示一次的 `client_secret`。
   认证中心地址固定为 `http://210.47.163.114/enterprise-sso`。本企业仅在受控校园网中启用 HTTP 例外，SDK 配置必须同时设置 `allow_insecure_http=true` 与 `local_cookie_secure=false`。
2. 将 `sdk/php74` 复制到应用的不可公开浏览目录，把 `config.example.php` 复制为 `config.php` 并填写认证中心签发的配置。为每个应用设置不同的 `session_name`，并把 `session_path` 限制到该应用目录。
3. 将 `callback.php` 暴露在登记的回调地址；其余 SDK 文件不得作为下载文件提供。
4. 在所有需要登录的 PHP 页面第一行加入：

   ```php
   require_once __DIR__ . '/sso/guard.php';
   ```

5. 当前人员信息直接读取 `$ssoUser`，稳定人员标识为 `$ssoUser['sub']`。不要使用姓名、职务或部门作为主键。

## 应用获得的资料

- `sub`：永久稳定的 UserID；本企业中也是企业微信 UserID 和学号/工号。
- `name`：姓名。
- `preferred_username`：登录账号。
- `employee_no`：人员编号。
- `department`、`position`：当前主要任职。
- `authorization_version`：授权版本；应用可用它主动淘汰旧权限缓存。

SDK 默认强制 HTTPS；只有显式配置 `allow_insecure_http=true` 才接受 HTTP Issuer。Authorization Code + PKCE、一次性 `state`、十分钟登录流程和本地 Session 校验仍保留。HTTP 不提供链路加密，密码和会话只适合受控内网；应用仍需管理自己的业务权限，统一认证只负责身份与应用入口准入。

认证中心不会发送 HSTS，也不会改变 80 端口上的其他路径。业务系统只需在需要保护的页面引入守卫，不需要制作登录页。

日常接入在网页“应用接入”模块完成，可继续维护回调地址、准入规则和轮换密钥。应急或自动化时也可设置 `APP_NAME`、`APP_REDIRECT_URI`，按需设置 `APP_ACCESS_MODE=all_active`，再执行 `npm run app:create`。生成的 `client_secret` 只显示一次。内网 HTTP 回调主机还必须由管理员逐项加入 `INTERNAL_HTTP_REDIRECT_HOSTS`，不接受通配符。
