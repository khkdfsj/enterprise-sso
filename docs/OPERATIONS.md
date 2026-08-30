# 生产运维、发布与回滚

## 服务拓扑

114：

- `enterprise-sso-tunnel.service`：`127.0.0.1:13000` 到 118 的受限隧道。
- `enterprise-sso-nginx.service`：独立 Nginx，只监听 8443。
- `enterprise-sso-cert-renew.timer`：内部服务器证书到期检查。

118：

- `enterprise-sso.service`：只监听 `127.0.0.1:3000`。

原 114 Nginx 的 80/443 配置不属于本系统，任何发布都不得修改或 reload 它。

## 日常检查

```bash
# 114
systemctl is-active enterprise-sso-tunnel.service enterprise-sso-nginx.service
curl -k https://127.0.0.1:8443/healthz

# 118
systemctl is-active enterprise-sso.service
curl http://127.0.0.1:3000/healthz
```

OIDC 验收还应检查 Discovery 的所有 URL 都包含 `:8443`，并确认响应没有 `Strict-Transport-Security`。同一 IP 仍承载 HTTP 系统，因此本项目禁止发送 HSTS。

## GitHub 为唯一源码基线

所有更新必须遵循：

1. 从 GitHub 拉取或建立功能分支；
2. 修改源码和对应手册；
3. 运行 `npm test`、`npm run check` 和相关端到端测试；
4. 提交并推送 GitHub；
5. 为生产发布创建 tag；
6. 从该 commit 构建新的只读 release 目录；
7. 备份当前 release、环境文件和数据库；
8. 原子切换 `/opt/enterprise-sso/current`；
9. 只重启本系统服务并执行真实链路验收；
10. 在变更记录中写入生产对应的 commit 和 tag。

禁止直接编辑 `/opt/enterprise-sso/current` 后不回推 GitHub。紧急修复也必须在恢复服务后立即补交 commit，并核对生产文件哈希。

## 回滚

程序回滚只把 `current` 符号链接切回上一个 release，然后重启 `enterprise-sso.service`。如果迁移改变了数据库结构，必须使用该版本对应的已验证数据库备份；不要假设新数据库可以被旧程序直接读取。

## 备份边界

- 备份 SQLite 时使用在线备份 API或短暂停写后的完整快照，不能只复制活动中的主文件而忽略 WAL。
- `/etc/enterprise-sso/enterprise-sso.env`、OIDC JWKS、密码 pepper、Cookie 密钥和 CA 私钥属于秘密，不进入 Git。
- 根证书 `.crt` 是公开材料，可以进入私有仓库供受管设备安装。
