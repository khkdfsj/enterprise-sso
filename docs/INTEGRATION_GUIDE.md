# ESSO-DFSJ 应用接入完整指南

AI Agent 自动登记和测试的请求契约见 [AGENT_INTEGRATION.md](AGENT_INTEGRATION.md)。图形向导和 Agent API 最终都下载并部署本文所述的同一个固定包。

## 1. 系统解决什么问题

ESSO 是 Enterprise Single Sign-On 的简称。业务系统不再制作登录页、不保存统一密码，也不直接处理企业微信 CorpSecret。用户在 ESSO 完成一次账号密码或企业微信扫码认证后，在会话有效期内可免密进入其他已授权系统。

接入分成两层：

1. 企业微信是 ESSO 的一种身份来源。ESSO 负责可信域名、扫码事务、临时 `code`、`access_token` 和 UserID 查询。
2. 业务系统通过 OpenID Connect（OIDC）接入 ESSO。业务系统只认识 ESSO，不直接调用企业微信。

因此，普通接入开发者不需要 CorpID、AgentID、CorpSecret，也不需要理解企业微信 API 的密钥管理。

## 2. 技术链路

### 2.1 密码登录

1. 业务页面引入 `ESSO-DFSJ/login.php`。
2. 没有本地会话时，SDK 生成 `state`、`nonce`、PKCE verifier/challenge，并跳转 ESSO。
3. ESSO 验证 UserID 与密码，检查账号、人员状态和应用准入规则。
4. ESSO 返回短时一次性 Authorization Code。
5. `callback.php` 使用 Client ID、Client Secret、PKCE verifier 换取令牌，再从 UserInfo 读取人员身份。
6. SDK 建立业务系统自己的 PHP Session，并返回用户原来访问的页面。

### 2.2 企业微信扫码登录

1. ESSO 为当前浏览器生成短时扫码事务和防伪 `state`。
2. 二维码只编码企业微信可信域名入口。
3. 企业微信授权后把一次性 `code` 和原 `state` 送到 ESSO 回调。
4. ESSO 校验事务、过期时间和 `state`，在服务端用 `code` 查询 UserID。
5. UserID 与 ESSO 人员主键匹配并通过应用准入检查后，完成同一个 OIDC 登录流程。

企业微信官方要求回调域与配置的可信域名一致，`state` 应用于防止 CSRF，成员还必须处于应用可见范围。参见：

- [企业微信网页授权登录](https://developer.work.weixin.qq.com/document/path/91022)
- [企业微信扫码授权登录](https://developer.work.weixin.qq.com/document/path/98151)

### 2.3 统一注销

退出不是简单跳回首页。`logout.php` 依次执行：

1. 删除当前业务系统的 PHP Session 身份；
2. 调用 Discovery 公布的 `end_session_endpoint`；
3. ESSO 删除统一认证会话；
4. 校验登记过的 `post_logout_redirect_uri` 后返回业务系统。

如果业务系统只删除自己的 Session，ESSO 会话仍在，刷新页面会立即免密登录，看起来就像“退出没有反应”。

## 3. 专有名词

| 名词 | 含义 |
| --- | --- |
| ESSO | 本系统 Enterprise Single Sign-On 的简称 |
| SSO | 单点登录；一次认证后访问多个已授权应用 |
| OAuth 2.0 | 授权框架，定义授权码、令牌等流程 |
| OIDC | OpenID Connect，在 OAuth 2.0 上增加标准身份认证 |
| Issuer | 身份签发方的唯一基础地址 |
| Discovery | `.well-known/openid-configuration`，自动公布所有协议端点 |
| Client ID | 接入应用的公开编号 |
| Client Secret | 接入应用的服务端密钥，不得进入浏览器、Git 或日志 |
| Redirect URI | 登录完成后允许回到的精确地址 |
| Post Logout Redirect URI | 统一注销后允许回到的精确地址 |
| Authorization Code | 短时、一次性授权码，只能由登记客户端交换一次 |
| PKCE | 将登录发起方和授权码交换绑定，降低授权码被截获后的风险 |
| state | 关联登录请求与回调，并防止 CSRF |
| nonce | 防止身份令牌重放 |
| Claim | 身份令牌或 UserInfo 中的一个字段 |
| sub | 稳定唯一主体标识；本企业等于企业微信 UserID 和学号 |
| Session | 浏览器登录状态；ESSO 和业务系统分别保存自己的会话 |
| CorpID | 企业微信企业编号 |
| AgentID | 企业微信自建应用编号 |
| 可信域名 | 企业微信允许授权回调的精确域名 |
| code | 企业微信授权完成后返回的短时一次性凭证 |
| access_token | ESSO 服务端调用企业微信接口的凭据，不提供给业务系统 |
| UserID | 企业内唯一成员标识，是 ESSO 的人员主键 |

## 4. 最简接入：下载固定目录安装包

打开 `http://210.47.163.114/enterprise-sso/admin/applications/new`，填写服务名称、项目访问根地址、访问范围和是否允许快捷注册。项目根地址示例：

`http://210.47.163.114/qywx/YourProject/`

这里填写的是浏览器访问 URL，不是 Linux 或 Windows 磁盘路径。系统会自动生成登录回调、注销返回、健康检查和验收地址，然后生成 `ESSO-DFSJ.zip`。

解压后把整个 `ESSO-DFSJ` 文件夹放进业务项目根目录。目录必须叫 `ESSO-DFSJ`，不得更名。

```text
YourProject/
├── index.php
├── Management.php
└── ESSO-DFSJ/
    ├── config.php
    ├── SsoClient.php
    ├── login.php
    ├── callback.php
    ├── logout.php
    ├── health.php
    ├── test-login.php
    ├── test-logout.php
    └── README.txt
```

## 5. 每个文件的作用

| 文件 | 作用 | 验收后处理 |
| --- | --- | --- |
| `config.php` | Issuer、Client ID、Client Secret、回调、Session 等基础配置 | 永久保留，禁止公开和提交 Git |
| `SsoClient.php` | OIDC、state、PKCE、令牌交换、UserInfo、Session 客户端 | 永久保留 |
| `login.php` | 保护业务页面，同时通过 `$ssoUser` 提供当前人员身份 | 永久保留 |
| `callback.php` | 接收 ESSO 一次性授权码并建立本地 Session | 永久保留，不由用户手工打开 |
| `logout.php` | 清除业务 Session 并退出 ESSO 统一会话 | 永久保留 |
| `health.php` | 用 Client Secret HMAC 签名证明部署和配置连通 | 永久保留，供持续监控 |
| `test-login.php` | 完成一次真实密码或企业微信登录验收 | 全部验收后可以删除 |
| `test-logout.php` | 完成一次真实统一注销和回跳验收 | 全部验收后可以删除 |
| `README.txt` | 随包部署说明和最小调用实例 | 建议保留 |

## 6. 业务代码如何调用

### 6.1 保护页面并读取身份

必须在页面第一行、任何 HTML、空格或 `echo` 输出之前引入：

```php
<?php
require_once __DIR__ . '/ESSO-DFSJ/login.php';

$userId = $ssoUser['sub'];
$name = $ssoUser['name'];
$username = $ssoUser['preferred_username'];
$department = $ssoUser['department'] ?? null;
$position = $ssoUser['position'] ?? null;
```

`sub` 是业务数据库关联人员时唯一允许使用的主键。姓名、部门和职位会随人员变动，不得作为唯一键。

如果页面位于子目录，应按 PHP 文件真实位置调整相对路径：

```php
require_once dirname(__DIR__) . '/ESSO-DFSJ/login.php';
```

### 6.2 提供退出按钮

```php
<a href="<?= htmlspecialchars($essoLogoutUrl, ENT_QUOTES, 'UTF-8') ?>">退出登录</a>
```

`$essoLogoutUrl` 由 `login.php` 按登记的项目根地址生成，因此根页面和子目录页面都能使用。若现有系统还维护自己的额外业务 Session，应先清理业务字段，再跳转该地址；不要只刷新页面。

### 6.3 标准身份字段

- `sub`：唯一 UserID；
- `preferred_username`：登录账号；
- `name`：姓名；
- `employee_no`：人员编号；
- `department`：当前主要部门；
- `position`：当前主要职位；
- `authorization_version`：权限版本，可用于淘汰业务侧旧缓存。

## 7. 三项验收

部署完成后，在后台向导点击“已部署，开始三项验收”。

1. 基础连通与凭据：ESSO 请求 `health.php`，验证 HTTP 状态、Client ID 和 HMAC 签名。
2. 真实登录：打开 `test-login.php`，用密码或企业微信扫码完成一次登录；签名结果自动回到向导。
3. 真实注销：打开 `test-logout.php`，同时清除本地和 ESSO 会话；成功回跳后向导自动点亮。

全部通过后，删除生产服务器上的 `test-login.php` 和 `test-logout.php`。保留 `health.php`，后台会继续监控。

## 8. 安全要求

- `config.php` 和 Client Secret 不得提交 GitHub、发送到前端或写入日志；
- 不得自己制作统一登录表单或收集统一密码；
- 回调地址必须精确登记，不允许通配符；
- `login.php` 必须在任何输出前执行，否则 PHP 无法安全建立 Session 或跳转；
- 不得关闭 state、nonce、PKCE、签名和 Issuer 校验；
- 生产系统删除接入服务前先确认业务已停止使用；
- 114 当前为获准内网 HTTP 主机，浏览器可能显示密码提交不安全警告；这属于浏览器保护机制。

## 9. 常见问题

### 页面提示 headers already sent

`login.php` 引入太晚。移动到 PHP 文件第一行，并检查文件开头是否有 BOM 或空格。

### 登录后循环跳转

检查 `ESSO-DFSJ` 是否改名、项目根地址是否填写错误、浏览器是否接受业务 Session Cookie。

### health.php 异常

检查完整目录是否已上传、PHP 是否可执行、`config.php` 是否可读。不要在后台重新复制旧 Secret。

### 退出后马上又登录

业务按钮没有调用 `ESSO-DFSJ/logout.php`，只删除了业务自己的 Session，统一会话仍然有效。

### 企业微信提示回调域错误

这是 ESSO 平台侧企业微信可信域名配置问题，不是普通业务接入包问题。不要把 CorpSecret 复制到业务系统。
