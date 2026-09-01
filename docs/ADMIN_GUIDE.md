# 管理员手册

## 当前管理方式

日常管理统一使用：`http://210.47.163.114/enterprise-sso/admin`。后台只有三个一级模块：接入服务管理、部门人员管理、系统管理；具体功能放在二级菜单。后台自身也通过本系统的 OIDC 托管登录认证，不再显示独立密码表单。批量迁移、部署与应急操作继续使用 118 上的受控 CLI。生产环境文件位于：

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

当前纯数字 UserID 的初始化密码为 UserID 后六位，数据库只保存 Argon2id 哈希；非学号维护账号不套用此规则。正式交接后应要求管理员改用独立强密码，不要把密码、客户端密钥或配置文件复制到 GitHub。

## 登记接入应用

日常接入优先使用网页后台：

1. 打开“接入服务管理 → 新增接入服务”。
2. 在第一步填写服务名称和项目访问根地址，系统自动推导回调、退出和检测地址。
3. 第二步下载一次性 `ESSO-DFSJ.zip`，把完整的 `ESSO-DFSJ` 文件夹放到业务项目根目录，禁止更名。
4. 第三步完成基础连通与凭据、真实登录认证、统一注销回跳三项验收。基础连通会持续监控十分钟；登录和注销测试成功后自动返回向导点亮状态。
5. 全部通过后删除业务服务器上的 `test-login.php` 与 `test-logout.php`，保留 `health.php` 持续监控；再进入服务详情维护权限和运行配置。

接入服务的永久删除仅对当前部长及以上职级、老师或已授予后台角色的管理员开放。删除需要进入独立确认页并输入完整服务名称；系统不会远程删除业务服务器上的 `ESSO-DFSJ` 文件夹。
6. 如密钥泄露，在“密钥与注册”中轮换；旧密钥立即失效。只有确实需要业务系统发起开户时才开启快捷注册。

业务页面不需要自行编写登录页。完成 SDK 配置后，未登录用户自动进入统一认证页面，登录成功后回到登记的精确回调地址。

以下 CLI 仅用于自动化、批量初始化或网页后台不可用时的受控应急操作：

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

`https://syauinfo.syau.edu.cn/qywx/enterprise-sso/callback.php`

桌面扫码二维码入口使用：

`https://syauinfo.syau.edu.cn/qywx/enterprise-sso/qr.php`

二维码只编码这个可信域名入口，再由独立 PHP 文件进入新认证系统的扫码事务；不加载旧扫码系统代码。

配置前应确认企业微信管理后台是否允许 IP 回调地址。修改环境变量前先备份文件，修改后只重启 `enterprise-sso.service`。参数不完整时扫码入口自动隐藏，密码登录不受影响。

## 权限原则

- `super_admin` 不随届次自动失效，但应至少保留两名经过确认的负责人。
- 人员状态、账号状态、应用状态和应用准入是四个独立开关。
- 统一认证只决定身份和能否进入应用，应用内部角色仍由各应用管理。
- 删除人员不是正常离职流程，应停用账号并结束任职，保留审计历史。
