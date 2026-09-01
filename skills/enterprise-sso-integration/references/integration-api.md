# Integration API reference

## Discovery and OIDC

Configure the issuer supplied by the Enterprise SSO administrator. The current internal deployment uses `http://210.47.163.114/enterprise-sso`; do not hard-code it when configuration is available.

- Discovery: `/.well-known/openid-configuration`
- Flow: authorization code with PKCE (`S256`)
- Scopes: `openid profile enterprise`
- Logout: use the discovery document's `end_session_endpoint`
- Callback URL: exact administrator-approved URI

Expected claims:

| Claim | Meaning |
|---|---|
| `sub` | Canonical UserID; stable unique key |
| `name` | Display name; never use as a key |
| `preferred_username` | Login name, normally the UserID |
| `employee_no` | UserID/student number compatibility field |
| `department` | Active primary department object or `null` |
| `position` | Active primary position object or `null` |
| `authorization_version` | Incrementing permission revision |

Access is decided by Enterprise SSO each time authorization runs. An OIDC `access_denied` response means the user authenticated but the application access rule rejected them; show a permission message rather than another login form.

## Quick registration

Only clients explicitly enabled for provisioning can call:

```http
POST /api/v1/registrations
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/json

{"user_id":"2026999999","display_name":"示例用户"}
```

Successful response (`201`):

```json
{
  "registration_id": "opaque-id",
  "user_id": "2026999999",
  "registration_url": "https://issuer/register/one-time-token",
  "expires_at": "2026-08-31T01:15:00.000Z"
}
```

Redirect the browser to `registration_url`. It expires after 15 minutes and is single use. The business application must not proxy the registration form or password. `401 invalid_client` means the credentials are wrong, the app is disabled, or provisioning is not enabled. `400 invalid_request` means UserID or display name validation failed.

## Session pattern

1. Save a random `state`, `nonce`, and PKCE verifier in the application's server-side session.
2. Redirect to the discovered authorization endpoint.
3. At callback, compare `state`, exchange the code with the verifier, validate the ID token, and create the local session keyed by `sub`.
4. Protect private routes with the local session. Redirect to OIDC when missing or when a permission refresh is required.
5. Clear the local session at logout, then redirect through the discovered end-session endpoint with the registered post-logout redirect URI.

## Acceptance checks

- A logged-out visit reaches the hosted Enterprise SSO page; the application has no password form.
- Password login and WeCom QR login both return the same `sub`.
- Opening a second registered application reuses the SSO session within its configured lifetime.
- A user without an allow rule receives `access_denied`.
- Disabling the person, account, app, or rule prevents a fresh authorization.
- Callback rejects wrong `state`, nonce, issuer, audience, expired tokens, and an unregistered redirect URI.
- Quick registration exposes no password or client secret in browser URLs or logs.
- The wizard's signed connectivity probe, real hosted-login test, and RP-initiated logout test all pass.
