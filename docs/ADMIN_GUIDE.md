# 管理员手册

## 当前管理方式

当前版本的认证核心使用 CLI 管理，网页管理后台尚未完成。所有命令只在 118 上执行，生产环境文件位于：

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
read -r ADMIN_USERNAME
read -r ADMIN_DISPLAY_NAME
read -r ADMIN_EMPLOYEE_NO
read -r -s ADMIN_PASSWORD
export ADMIN_USERNAME ADMIN_DISPLAY_NAME ADMIN_EMPLOYEE_NO ADMIN_PASSWORD
/opt/node-enterprise-sso/bin/npm run admin:bootstrap
unset ADMIN_PASSWORD
```

初始化程序在已有有效超级管理员时会拒绝再次创建。当前版本没有首次登录强制改密页面，因此应直接设置正式强密码。

## 登记接入应用

```bash
cd /opt/enterprise-sso/current
set -a
source /etc/enterprise-sso/enterprise-sso.env
set +a
export APP_NAME='业务系统名称'
export APP_REDIRECT_URI='https://业务系统地址/sso/callback.php'
export APP_ACCESS_MODE='rules'
/opt/node-enterprise-sso/bin/npm run app:create
```

如确实允许所有有效人员进入，可将 `APP_ACCESS_MODE` 设为 `all_active`。输出的 `client_secret` 只显示一次，应立即写入目标应用的秘密配置。

## 企业微信扫码

在 `/etc/enterprise-sso/enterprise-sso.env` 中配置 `WECOM_CORP_ID`、`WECOM_AGENT_ID`、`WECOM_CORP_SECRET`，并在企业微信后台登记实际回调地址：

`https://210.47.163.114:8443/wecom/callback`

配置前应确认企业微信管理后台是否允许 IP 回调地址。修改环境变量前先备份文件，修改后只重启 `enterprise-sso.service`。参数不完整时扫码入口自动隐藏，密码登录不受影响。

## 权限原则

- `super_admin` 不随届次自动失效，但应至少保留两名经过确认的负责人。
- 人员状态、账号状态、应用状态和应用准入是四个独立开关。
- 统一认证只决定身份和能否进入应用，应用内部角色仍由各应用管理。
- 删除人员不是正常离职流程，应停用账号并结束任职，保留审计历史。
