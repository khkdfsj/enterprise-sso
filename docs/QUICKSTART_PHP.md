# PHP 7.4 快速接入

接入应用不制作登录页面。未登录用户由统一认证中心显示密码与企业微信扫码入口；认证成功后返回原页面。

## 接入步骤

1. 管理员在认证中心登记应用名称和精确回调地址，取得 `client_id` 与只显示一次的 `client_secret`。
   认证中心地址固定为 `https://210.47.163.114:8443`；应用服务器和使用者电脑需信任企业内部根证书。
2. 将 `sdk/php74` 复制到应用的不可公开浏览目录，把 `config.example.php` 复制为 `config.php` 并填写认证中心签发的配置。
3. 将 `callback.php` 暴露在登记的回调地址；其余 SDK 文件不得作为下载文件提供。
4. 在所有需要登录的 PHP 页面第一行加入：

   ```php
   require_once __DIR__ . '/sso/guard.php';
   ```

5. 当前人员信息直接读取 `$ssoUser`，稳定人员标识为 `$ssoUser['sub']`。不要使用姓名、职务或部门作为主键。

## 应用获得的资料

- `sub`：永久稳定的人员 UUID。
- `name`：姓名。
- `preferred_username`：登录账号。
- `employee_no`：人员编号。
- `department`、`position`：当前主要任职。
- `authorization_version`：授权版本；应用可用它主动淘汰旧权限缓存。

SDK 默认强制 HTTPS、证书校验、Authorization Code + PKCE、一次性 `state`、十分钟登录流程有效期和安全 Session Cookie。应用仍需在自身系统内管理业务权限；统一认证只负责身份与应用入口准入。

认证中心不会向同 IP 的其他系统发送 HSTS，也不会把 80/443 请求重定向到 8443。业务系统只需在需要保护的页面引入守卫，不需要制作登录页。

当前维护命令可直接登记应用：设置 `APP_NAME`、`APP_REDIRECT_URI`，按需设置 `APP_ACCESS_MODE=all_active`，然后执行 `npm run app:create`。生成的 `client_secret` 只显示一次；后续管理界面将调用同一套登记逻辑。
