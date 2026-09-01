# ESSO-DFSJ integration reference

## Headless Agent registration API

Use this flow when the operator provides an Agent credential. All requests require these headers:

```http
Authorization: Bearer <secret-agent-token>
X-ESSO-Agent-Identity: <stable identity bound to that token>
X-Request-ID: <stable unique id for this logical operation>
```

Never place tokens in URLs, Git, chat output, shell history intended for sharing, or application frontend code. Registration JSON must repeat `agent_identity`; all identity values must match. Reuse the same request ID after an uncertain result so registration remains idempotent.

| Method and path | Purpose |
|---|---|
| `GET /api/v1/agent/capabilities` | Discover supported fields, package and tests |
| `POST /api/v1/agent/services` | Register one service and receive a one-time package token |
| `GET /api/v1/agent/services/{id}/package` | Download `ESSO-DFSJ.zip`; also send `X-ESSO-Package-Token` |
| `POST /api/v1/agent/services/{id}/monitor` | Enable temporary continuous connectivity monitoring |
| `POST /api/v1/agent/services/{id}/tests/connectivity` | Run the signed health check immediately |
| `GET /api/v1/agent/services/{id}` | Read endpoints and connectivity/login/logout status |

Registration body:

```json
{
  "agent_identity": "codex:team:dfsj-maintainer",
  "name": "Example Admin",
  "project_root_url": "http://210.47.163.114/qywx/Example/",
  "client_id": "optional-client-id",
  "access_mode": "rules",
  "provisioning_enabled": false
}
```

Required: `agent_identity`, `name`, `project_root_url`. `client_id` is optional. The API derives the exact callback, logout, health, login-test, and logout-test URLs. It returns only one package token; consume it within 15 minutes. Only the credential that created the service may query it through the Agent API.

The connectivity test is machine-executable. Login and logout are real browser acceptance tests: open the URLs returned in `tests.login.url` and `tests.logout.url`, then poll the service resource until all statuses are `passed`. Do not claim acceptance from HTTP reachability alone.

For complete request examples, error codes, and reporting requirements, read the repository document `docs/AGENT_INTEGRATION.md`.

## Preferred generated-package contract

The onboarding wizard takes the application's browser-visible root URL and derives all protocol URLs below it. It returns a one-time `ESSO-DFSJ.zip`; the extracted directory name is part of the integration contract and must not change.

```text
application-root/
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

| File | Purpose | Keep after acceptance |
| --- | --- | --- |
| `config.php` | Issuer, Client ID, Client Secret, callback, logout, and local-session settings | Yes; server-side secret |
| `SsoClient.php` | OIDC, state, PKCE, code exchange, UserInfo, and PHP Session client | Yes |
| `login.php` | Require authentication and expose `$ssoUser` plus `$essoLogoutUrl` | Yes |
| `callback.php` | Receive the registered authorization callback | Yes |
| `logout.php` | Clear the local identity and invoke central logout | Yes |
| `health.php` | Prove Client ID and secret possession with a signed health response | Yes |
| `test-login.php` | Report one real hosted-login acceptance result | Delete after all checks pass |
| `test-logout.php` | Report one real RP-initiated logout result | Delete after all checks pass |
| `README.txt` | Package-specific deployment and usage instructions | Recommended |

Do not independently reconstruct `config.php`; its secret is shown only through the one-time package. Do not expose the package as a public download.

## PHP usage

Run the guard before any HTML, whitespace, or output:

```php
<?php
require_once __DIR__ . '/ESSO-DFSJ/login.php';

$userId = $ssoUser['sub'];
$name = $ssoUser['name'];
$department = $ssoUser['department'] ?? null;
$position = $ssoUser['position'] ?? null;
```

For an entry point in a subdirectory, resolve the actual application root rather than duplicating the package:

```php
require_once dirname(__DIR__) . '/ESSO-DFSJ/login.php';
```

Use the generated absolute-path logout variable so nested pages do not create a broken relative link:

```php
<a href="<?= htmlspecialchars($essoLogoutUrl, ENT_QUOTES, 'UTF-8') ?>">退出登录</a>
```

If the legacy application has additional local session fields, clear those fields before redirecting to `$essoLogoutUrl`. Do not stop after local cleanup: otherwise the central session immediately signs the user back in.

## Claims

| Claim | Meaning |
| --- | --- |
| `sub` | Canonical string UserID; stable unique key |
| `name` | Display name; never use as a key |
| `preferred_username` | Login name, normally the UserID |
| `employee_no` | Student/employee number compatibility field |
| `department` | Active primary department object or `null` |
| `position` | Active primary position object or `null` |
| `authorization_version` | Incrementing permission revision |

ESSO decides application entry access during each authorization. The application must still enforce its own business permissions after login.

## Three acceptance checks

1. `health.php` returns the expected Client ID and HMAC proof, and the ESSO monitor marks connectivity successful.
2. `test-login.php` completes one real password or WeCom hosted login and returns a signed result to the wizard.
3. `test-logout.php` clears both local and central sessions and returns to the registered verification address.

Do not mark an integration complete from a health check alone. After all three pass, remove only the two `test-*.php` files and confirm ordinary login and logout still work.

## OIDC fallback for non-PHP frameworks

Use the Issuer supplied by the ESSO administrator. The current internal deployment is `http://210.47.163.114/enterprise-sso`; prefer Discovery instead of hard-coding individual endpoints.

- Discovery: `/.well-known/openid-configuration`
- Flow: Authorization Code with PKCE `S256`
- Scopes: `openid profile enterprise`
- Callback: exact registered URI; no wildcard
- Logout: Discovery `end_session_endpoint` with the registered post-logout redirect URI

The client must validate `state`, `nonce`, Issuer, audience, expiration, token signature through JWKS, and PKCE. Create the application's local session only after successful validation and UserInfo retrieval.

## Quick registration

Only a client explicitly enabled for provisioning may call:

```http
POST /api/v1/registrations
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/json

{"user_id":"2026999999","display_name":"示例用户"}
```

A successful `201` response contains a single-use registration URL that expires after 15 minutes. Redirect the browser to it. The business application must not proxy the registration form or password.

- `401 invalid_client`: credentials are wrong, the service is disabled, or provisioning is disabled.
- `400 invalid_request`: UserID or display-name validation failed.
- OIDC `access_denied`: identity succeeded but the application access rule rejected the user; show a permission message instead of another login form.

## Security and operational boundaries

- Never copy a Client Secret, token, authorization code, password, full Cookie, or generated `config.php` into Git or logs.
- Never create an application-specific ESSO password page.
- Never send CorpID, AgentID, CorpSecret, or WeCom access tokens to a business application; WeCom is an ESSO-internal identity source.
- Preserve public routes and existing application authorization unless the integration request explicitly changes them.
- Register exact URLs and keep the fixed package directory. A renamed or partially copied package is not a supported deployment.
