---
name: enterprise-sso-integration
description: Integrate an internal application with ESSO-DFSJ hosted login, UserID identity, unified logout, connectivity checks, or quick registration. Use when an application should stop owning a login page or password database.
---

# ESSO-DFSJ application integration

Prefer the authenticated Agent API and its generated package when an Agent credential is available. Otherwise use the ESSO onboarding wizard. Both paths generate the same package. The application must not build its own ESSO password form, receive an ESSO password, copy the central session cookie, or call WeCom directly.

## Agent API workflow

1. Ask the operator for the ESSO Issuer, an Agent token, and the stable identity assigned to that token. Never ask for an administrator password or a business Client Secret.
2. Choose a stable `agent_identity`, send it in `X-ESSO-Agent-Identity` and in registration JSON, and send a stable unique `X-Request-ID` for every logical operation. Do not silently change a request ID after an uncertain response.
3. Call `GET /api/v1/agent/capabilities`, then `POST /api/v1/agent/services` with the service name and browser-visible project root URL.
4. Download the one-time package from the returned link with `X-ESSO-Package-Token`. Do not print, log, or commit the Agent token, package token, generated `config.php`, or Client Secret.
5. Extract the complete `ESSO-DFSJ` directory into the project root without renaming it. Add `require_once .../ESSO-DFSJ/login.php` before protected-page output and use `$essoLogoutUrl` for logout.
6. Start monitoring and request the connectivity test through the Agent API. Then use the returned browser URLs for real login and logout tests. Poll service status until all three tests pass.
7. Delete only `test-login.php` and `test-logout.php` after acceptance; retain `health.php` for monitoring. Report the identity marker, service ID, Client ID, deployment path, and test results without secrets.

Read [references/integration-api.md](references/integration-api.md) before making Agent API calls. It defines headers, idempotency, endpoints, payloads, package handling, and error recovery.

## Before changing an application

Identify the application root, public URL root, framework, existing session and logout behavior, public routes, and routes that require authentication. Preserve public routes and application-specific authorization. ESSO establishes identity and application entry permission; it does not replace the application's internal business roles.

## PHP 7.4 package workflow

1. Register the service in the ESSO onboarding wizard using its browser-visible project root URL.
2. Download the one-time `ESSO-DFSJ.zip` generated for that service. Treat this package as the credential source of truth.
3. Extract the complete `ESSO-DFSJ` directory into the application root without renaming it or copying selected files by hand.
4. In each protected PHP entry point, before any output, load `ESSO-DFSJ/login.php`. Read the authenticated identity from `$ssoUser`; use `$ssoUser['sub']` as the canonical string UserID.
5. Point logout actions to the `$essoLogoutUrl` supplied by `login.php`. Do not implement logout as a page reload or local-session deletion alone.
6. Complete the wizard's signed health check, real hosted-login check, and unified-logout check.
7. After all three checks pass, delete only `test-login.php` and `test-logout.php`. Retain `health.php` for monitoring and retain every runtime file.

Never rename `ESSO-DFSJ`. Never commit its generated `config.php` or Client Secret to Git, logs, browser code, or error pages.

## Identity and session rules

Treat OIDC `sub` as the permanent identity key. In this enterprise it is the WeCom UserID and student/employee number. Store it as a string without numeric conversion. Names, departments, and positions can change and must not be identity keys.

Create only the application's own local session after callback. When sensitive application permissions are cached, use `authorization_version` to invalidate stale authorization data. A valid central SSO session can complete a fresh authorization without asking for credentials again.

## Non-PHP applications

If the generated PHP package cannot run in the target framework, use its registered values with the framework's maintained OIDC Authorization Code + PKCE client. Preserve the same callback, claims, logout, and acceptance rules. Read [references/integration-api.md](references/integration-api.md) for the package contract, endpoints, claims, non-PHP fallback, quick registration, errors, and acceptance checks.

## Quick registration

Use quick registration only after an administrator enables provisioning for the client. Redirect the browser to the short-lived registration URL returned by ESSO. Never collect or relay the new password inside the business application.
