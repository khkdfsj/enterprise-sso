# 管理员手册

## 当前管理方式

日常人员、届次和换届管理使用：`https://210.47.163.114:8443/admin`。批量迁移、部署与应急操作继续使用 118 上的受控 CLI。生产环境文件位于：

- 程序：`/opt/enterprise-sso/current`
- 环境变量：`/etc/enterprise-sso/enterprise-sso.env`
- 数据库：`/var/lib/enterprise-sso/enterprise-sso.sqlite3`

不要用系统自带旧版 `sqlite3` 打开生产库；应使用项目的 Node.js 运行时和维护命令。

## 建立首个超级管理员

先进入 root 的受控交互终端，不要把密码直接写在命令行或聊天记录中：

```bash
cd /opt/enterprise-sso/current
set -a
source /etc/enterprise-sso/enterprise-sso.env
set +a
read -r ADMIN_USERID
read -r ADMIN_DISPLAY_NAME
read -r -s ADMIN_PASSWORD
export ADMIN_USERID ADMIN_DISPLAY_NAME ADMIN_PASSWORD
/opt/node-enterprise-sso/bin/npm run admin:bootstrap
unset ADMIN_PASSWORD
```

初始化程序在已有有效超级管理员时会拒绝再次创建。`ADMIN_USERID` 同时作为人员主键、学号/工号和默认登录名；企业微信绑定时也必须使用同一个 UserID。

已迁移人员设置初始密码：

```bash
read -r USER_ID
read -r -s NEW_PASSWORD
export USER_ID NEW_PASSWORD
/opt/node-enterprise-sso/bin/npm run account:set-password
unset NEW_PASSWORD
```

2026-08-31 首批三名永久超级管理员的初始凭据保存在 118 的 `/root/enterprise-sso-initial-admin-credentials-20260831.txt`，权限为 root-only。首次交接后应分别改密并安全删除该文件，不要复制到 GitHub、网页目录或普通聊天记录。

## 登记接入应用

```bash
cd /opt/enterprise-sso/current
set -a
source /etc/enterprise-sso/enterprise-sso.env
set +a
export APP_NAME='业务系统名称'
export APP_REDIRECT_URI='https://业务系统地址/sso/callback.php'
export APP_ACCESS_MODE='rules'
export APP_PROVISIONING_ENABLED='0'
/opt/node-enterprise-sso/bin/npm run app:create
```

如确实允许所有有效人员进入，可将 `APP_ACCESS_MODE` 设为 `all_active`。输出的 `client_secret` 只显示一次，应立即写入目标应用的秘密配置。

只有确实需要由业务系统发起新用户开通时，才将 `APP_PROVISIONING_ENABLED` 设为 `1`。业务系统仍不能接触用户密码，只能取得 15 分钟单次注册链接。

如现有业务系统仍使用内网 HTTP IP 回调，将其主机名/IP逐个加入 `INTERNAL_HTTP_REDIRECT_HOSTS`。这只允许登记精确回调地址，不会更改 114 的 80/443、不会跳转其他网站，也不会发送 HSTS。

## 换届

1. 在后台建立下一届草稿，录入并复核任职名单。
2. 点击“开始换届并暂停非永久账号”，系统原子暂停所有非永久账号；永久账号不受影响。
3. 将任职调整为待发布并复核数量、部门与职位。
4. 发布届次。新名单账号恢复，未进入新名单的非永久人员转为已卸任；授权版本递增，使应用刷新权限。
5. 发现名单错误时先停止继续操作，按审计记录修订；不要直接删除人员历史。

永久账号当前规则示例：`2023195077`、`2007510002`、`88487016`。修改永久标记和超级管理员角色是两项独立操作，均应审计。

## 企业微信扫码

在 `/etc/enterprise-sso/enterprise-sso.env` 中配置 `WECOM_CORP_ID`、`WECOM_AGENT_ID`，令牌来源二选一：

- 独立应用模式：配置 `WECOM_CORP_SECRET`，认证中心自行获取并缓存 access token。
- 兼容集中令牌模式：配置 `WECOM_ACCESS_TOKEN_URL`，读取企业内部现有的纯文本或 JSON access token；此时不需要把 CorpSecret 复制到认证中心。

两者同时存在时优先使用 `WECOM_ACCESS_TOKEN_URL`。令牌地址由服务器管理员维护，不要写进客户端程序或公开仓库。配置完成后执行 `npm run wecom:sync-identities`，为全部人员按 `UserID = people.id` 建立企业微信身份映射。

如果认证数据库服务器不在企业微信可信 IP 列表中，可在已受信任的内网前端机部署 `deploy/wecom-userinfo-bridge.php`，并在认证中心设置 `WECOM_USERINFO_BRIDGE_URL` 与至少 32 位的 `WECOM_USERINFO_BRIDGE_TOKEN`。桥接端同时校验来源 IP 和共享密钥，只接受 POST，不在 URL 或日志中携带临时 code。

随后在企业微信后台登记实际回调地址：

`https://210.47.163.114:8443/wecom/callback`

配置前应确认企业微信管理后台是否允许 IP 回调地址。修改环境变量前先备份文件，修改后只重启 `enterprise-sso.service`。参数不完整时扫码入口自动隐藏，密码登录不受影响。

## 权限原则

- `super_admin` 不随届次自动失效，但应至少保留两名经过确认的负责人。
- 人员状态、账号状态、应用状态和应用准入是四个独立开关。
- 统一认证只决定身份和能否进入应用，应用内部角色仍由各应用管理。
- 删除人员不是正常离职流程，应停用账号并结束任职，保留审计历史。
