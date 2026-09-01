---
name: enterprise-sso-integration
description: Integrate an internal web application with Enterprise SSO through OIDC hosted login, session reuse, authorization claims, or the optional quick-registration API. Use when an application must stop owning a login page or password database.
---

# Enterprise SSO integration

Use the authorization-code flow with PKCE. Redirect unauthenticated users to the central authorization endpoint; do not add an application-specific login form, accept Enterprise SSO passwords, or copy its session cookie.

Treat the OIDC `sub` claim as the canonical UserID. In this enterprise it is also the student number and WeCom UserID. Never join identities by display name. Store `sub` as a string without numeric conversion or truncation.

Before changing an application, identify its framework, current session mechanism, callback URL, logout behavior, and routes that need authentication. Preserve public routes. Add an authentication guard, callback, and logout route using the framework's maintained OIDC library when possible.

When the Enterprise SSO onboarding wizard is available, use its generated files as the source of truth. Deploy the signed health probe plus the generated login and logout verification pages, then complete all three checks in the wizard before declaring the integration complete.

Validate issuer, signature through JWKS, audience, expiration, `state`, `nonce`, and PKCE. Register exact callback URLs; do not use wildcards. Keep the client secret server-side and out of source control, browser code, logs, and error pages.

After callback, create only the application's own session. Keep the minimum claims it needs. Check `authorization_version` when sensitive permissions are cached, and require a new authorization round trip when the version changes. The central SSO session will normally complete that trip without asking the user to authenticate again.

If an application needs to onboard an unknown UserID, use quick registration only after an administrator enables provisioning for that client. The API returns a short-lived central registration URL; redirect the user there. Never collect or relay the new password in the application.

Read [references/integration-api.md](references/integration-api.md) for endpoints, claims, quick-registration calls, errors, and acceptance checks.
