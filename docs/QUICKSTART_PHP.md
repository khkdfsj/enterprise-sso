# PHP 7.4 最简接入

## 第一步：生成安装包

打开 `http://210.47.163.114/enterprise-sso/admin/applications/new`，填写项目名称和项目访问根地址。系统自动登记所有协议地址并生成 `ESSO-DFSJ.zip`。

## 第二步：部署固定目录

解压，把完整的 `ESSO-DFSJ` 文件夹放入项目根目录。不能更名。

```text
YourProject/
├── index.php
└── ESSO-DFSJ/
```

## 第三步：让页面要求登录

在需要保护的 PHP 页面第一行加入：

```php
<?php
require_once __DIR__ . '/ESSO-DFSJ/login.php';

$userId = $ssoUser['sub'];
$name = $ssoUser['name'];
$department = $ssoUser['department'] ?? null;
$position = $ssoUser['position'] ?? null;
```

页面不制作登录表单。未登录用户自动前往 ESSO，选择账号密码或企业微信扫码，成功后返回原页面。

## 第四步：提供统一退出

```php
<a href="<?= htmlspecialchars($essoLogoutUrl, ENT_QUOTES, 'UTF-8') ?>">退出登录</a>
```

该文件同时删除本应用 Session 和 ESSO 统一会话。不要用刷新页面代替注销。

## 第五步：完成验收

回到接入向导依次完成：

1. `health.php` 基础连通与签名凭据检测；
2. `test-login.php` 真实登录检测；
3. `test-logout.php` 真实注销与回跳检测。

全部通过后删除 `test-login.php`、`test-logout.php`，保留 `health.php` 用于持续监控。

## 文件作用

- `config.php`：基础配置和密钥，不得提交 Git；
- `SsoClient.php`：OIDC 协议客户端；
- `login.php`：登录保护和 `$ssoUser` 身份读取；
- `callback.php`：登录回调；
- `logout.php`：统一注销；
- `health.php`：持续连通检测；
- `test-login.php`、`test-logout.php`：临时验收文件；
- `README.txt`：随包说明。

完整原理、术语、安全要求和问题排查见 [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md)。
