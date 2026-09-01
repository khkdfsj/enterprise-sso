# ESSO-DFSJ Agent 自动接入规范

本文定义 AI Agent 无需操作管理后台页面即可登记业务系统、下载标准接入包、启动监控并完成验收的唯一支持流程。Agent 仍然部署与图形向导完全相同的 `ESSO-DFSJ.zip`，不存在另一套 SDK 或简化认证协议。

## 1. 安全模型

管理员先在 ESSO 管理后台签发一枚 Agent 凭据。凭据包含：

- `agent_identity`：稳定、可审计的 Agent 身份标记，例如 `codex:team:dfsj-maintainer`；
- `agent_token`：只显示一次的高熵访问令牌，不得提交 Git、写入 Skill、日志、URL 或业务前端；
- 有效期和状态：过期或撤销后立即不能调用接口。

Agent 的每个请求必须同时提供：

```http
Authorization: Bearer <agent_token>
X-ESSO-Agent-Identity: codex:team:dfsj-maintainer
X-Request-ID: <本次操作的稳定唯一编号>
```

服务注册请求体还必须包含同一个 `agent_identity`。令牌所属身份、请求头身份和请求体身份三者不一致时，ESSO 返回 `403`。`X-Request-ID` 用于幂等和审计：网络超时后，Agent 应使用原编号查询或重试，不得换编号重复注册。

## 2. API 基础约定

- 基础地址：ESSO 的 Issuer，例如 `http://210.47.163.114/enterprise-sso`。
- 内容类型：除 ZIP 下载外均为 `application/json`。
- 时间：ISO 8601 UTC；后台展示时转换为北京时间（Asia/Shanghai）。
- UserID：字符串，是企业微信 UserID、学号和 ESSO 人员主键的同一值，禁止另造映射主键。
- 错误结构：`{"error":"错误代码","message":"中文说明","request_id":"..."}`。
- Agent 不得把 Client Secret、Agent Token 或 ZIP 内容回传到聊天正文；只报告脱敏 Client ID、服务 ID、状态和测试结果。

## 3. 标准执行顺序

### 第一步：读取能力

```bash
curl -sS "$ESSO_ISSUER/api/v1/agent/capabilities" \
  -H "Authorization: Bearer $ESSO_AGENT_TOKEN" \
  -H "X-ESSO-Agent-Identity: $ESSO_AGENT_IDENTITY" \
  -H "X-Request-ID: $REQUEST_ID-capabilities"
```

返回支持的包名、字段、端点和测试项目。Agent 必须确认 `package_name` 为 `ESSO-DFSJ`。

### 第二步：注册服务

```bash
curl -sS -X POST "$ESSO_ISSUER/api/v1/agent/services" \
  -H "Authorization: Bearer $ESSO_AGENT_TOKEN" \
  -H "X-ESSO-Agent-Identity: $ESSO_AGENT_IDENTITY" \
  -H "X-Request-ID: $REQUEST_ID-register" \
  -H "Content-Type: application/json" \
  --data '{
    "agent_identity":"codex:team:dfsj-maintainer",
    "name":"业务后台名称",
    "project_root_url":"http://210.47.163.114/qywx/Project/",
    "client_id":"可选，留空自动生成",
    "access_mode":"rules",
    "provisioning_enabled":false
  }'
```

必填字段：

| 字段 | 说明 |
|---|---|
| `agent_identity` | 与凭据及请求头完全一致的稳定身份标记 |
| `name` | 后台和登录页向用户显示的服务名称 |
| `project_root_url` | 浏览器可访问的项目根 URL，不是服务器磁盘路径 |

可选字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `client_id` | 自动生成 | 仅允许字母、数字、点、下划线和短横线 |
| `access_mode` | `rules` | `rules` 按规则授权；`all_active` 允许全部有效人员 |
| `provisioning_enabled` | `false` | 是否允许该业务系统发起快捷注册 |

成功返回 `201`；同一 Agent 使用相同 `X-Request-ID` 重试时返回同一个服务，不会重复创建。响应包含：

- `service.id`、`service.client_id` 和所有自动推导的 URL；
- 一次性 `package_token`，只用于下一步下载；
- `links.package`、`links.status`、`links.start_monitor`、`links.check_connectivity`；
- `tests.connectivity`、`tests.login`、`tests.logout` 当前状态及真实验收 URL。

### 第三步：下载并部署固定包

```bash
curl -sS "$ESSO_ISSUER/api/v1/agent/services/$SERVICE_ID/package" \
  -H "Authorization: Bearer $ESSO_AGENT_TOKEN" \
  -H "X-ESSO-Agent-Identity: $ESSO_AGENT_IDENTITY" \
  -H "X-Request-ID: $REQUEST_ID-package" \
  -H "X-ESSO-Package-Token: $PACKAGE_TOKEN" \
  -o ESSO-DFSJ.zip
```

下载令牌 15 分钟内、仅同一 Agent、仅成功下载一次有效。解压后必须把完整 `ESSO-DFSJ` 文件夹放入 `project_root_url` 对应的项目根目录，禁止更名或挑选文件复制。包内文件及调用方法见 [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md)。

### 第四步：启动监控并执行连通检测

```bash
curl -sS -X POST "$ESSO_ISSUER/api/v1/agent/services/$SERVICE_ID/monitor" \
  -H "Authorization: Bearer $ESSO_AGENT_TOKEN" \
  -H "X-ESSO-Agent-Identity: $ESSO_AGENT_IDENTITY" \
  -H "X-Request-ID: $REQUEST_ID-monitor"

curl -sS -X POST "$ESSO_ISSUER/api/v1/agent/services/$SERVICE_ID/tests/connectivity" \
  -H "Authorization: Bearer $ESSO_AGENT_TOKEN" \
  -H "X-ESSO-Agent-Identity: $ESSO_AGENT_IDENTITY" \
  -H "X-Request-ID: $REQUEST_ID-connectivity"
```

连通检测不仅要求 HTTP 2xx，还会用 Client Secret 校验 `health.php` 的 HMAC 签名，从而证明部署的包与登记服务一致。

### 第五步：真实登录和注销验收

```bash
curl -sS "$ESSO_ISSUER/api/v1/agent/services/$SERVICE_ID" \
  -H "Authorization: Bearer $ESSO_AGENT_TOKEN" \
  -H "X-ESSO-Agent-Identity: $ESSO_AGENT_IDENTITY" \
  -H "X-Request-ID: $REQUEST_ID-status"
```

Agent 打开或交给操作者打开响应中的：

1. `tests.login.url`：完成账号密码或企业微信扫码登录；
2. `tests.logout.url`：确认业务 Session 和 ESSO Session 均被清理。

两个测试页会用客户端密钥、五分钟时间戳和 HMAC 签名回报独立验收端点；它们不依赖管理后台 Session，也不接受 Agent 自报成功。Agent 轮询服务状态，直到三项测试均为 `passed`。测试完成后删除业务服务器中的 `ESSO-DFSJ/test-login.php` 和 `ESSO-DFSJ/test-logout.php`；长期保留 `health.php` 供监控使用。

## 4. Agent 完成报告

Agent 应向管理员报告：

- 自己的 `agent_identity`；
- 服务名称、服务 ID、Client ID（不得报告 Client Secret）；
- `ESSO-DFSJ` 部署路径和业务保护页面；
- 连通、登录、注销三项结果和北京时间；
- 两个测试文件是否已删除；
- 若失败，给出 ESSO 返回的错误代码和下一步修复，不泄露令牌或密钥。

## 5. 常见错误

| HTTP | 错误代码 | 含义 |
|---|---|---|
| 400 | `invalid_request` | 字段、URL、Client ID 或请求编号不合法 |
| 401 | `invalid_agent_token` | 未携带令牌、令牌错误、过期或已撤销 |
| 403 | `agent_identity_mismatch` | 身份标记与凭据不一致，或访问了其他 Agent 的服务 |
| 404 | `service_not_found` | 服务不存在或不属于当前 Agent |
| 409 | `client_id_exists` | Client ID 已存在；换一个或省略让系统生成 |
| 410 | `package_token_expired` | 接入包令牌过期或已成功使用 |
| 422 | `connectivity_failed` | `health.php` 未部署、不可访问或签名不匹配 |
| 429 | `rate_limited` | 调用过快，按响应头稍后重试 |

## 6. 安全边界

- Agent API 只登记和检测 ESSO 接入，不会通过 URL 自动修改业务服务器文件。
- Skill、README 和 GitHub 只记录通用流程，不记录本地 SSH 包装命令、生产令牌、Client Secret 或服务器口令。
- 删除服务、修改人员、换届和签发 Agent 凭据仍受部长以上、老师或相应后台角色权限控制；Agent 注册凭据不自动获得这些权限。
- 业务系统不得自建统一密码输入框，不得读取 ESSO Cookie，不得直接调用企业微信 CorpSecret。
