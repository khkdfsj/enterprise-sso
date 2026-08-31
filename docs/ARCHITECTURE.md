# 架构边界

## 请求路径

```text
浏览器 -> 114:80 /enterprise-sso/ 精确子路径 -> 114:13000 回环隧道 -> 118:3000 回环服务 -> SQLite
```

114 不保存人员数据库、密码或 OIDC 签名密钥，只保存受限隧道密钥。118 后端只监听 `127.0.0.1:3000`；隧道公钥只能转发到该地址。SQLite 文件位于非 Web 目录，仅认证服务账号可读写，使用 WAL 和外键约束。备份使用 SQLite 在线备份或短暂停写后的数据库文件快照，不复制活动中的单个主文件。

114 原 Nginx 只增加一行独立 include；该文件只匹配 `/enterprise-sso` 和 `/enterprise-sso/`，不会接管其他路径，不开启 443、不做 HTTPS 跳转、不发送 HSTS。企业微信手机 OAuth 只复用已有可信域名，在 `qywx/enterprise-sso` 使用新系统自己的独立回调文件，不加载旧扫码系统代码；普通网页仍从校园网 IP 的 80 端口访问。

## 身份与权限

- `people`：永久人员主体。
- `accounts`：认证账号状态。
- `password_credentials`：密码凭据。
- `wecom_identities`：企业微信身份绑定。
- `organization_terms`：届次。
- `appointments`：某人在某届的部门和职务。
- `applications`：OIDC 接入应用。
- `application_access_rules`：能否进入应用。

认证方式只回答“此人是谁”；应用准入规则回答“能否进入应用”；应用内部 RBAC 回答“进入后能做什么”。

## 换届

人员和账号不因换届删除。新届在草稿中编制并原子发布；旧任职结束，新任职在同一时刻生效，权限版本递增，使旧授权失效。
