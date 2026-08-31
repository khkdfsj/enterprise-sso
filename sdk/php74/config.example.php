<?php

return array(
    'issuer' => 'https://auth.example.internal',
    'client_id' => 'replace-with-issued-client-id',
    'client_secret' => 'replace-with-issued-client-secret',
    'redirect_uri' => 'https://your-app.example.internal/sso/callback.php',
    'local_idle_seconds' => 7200,
    'local_absolute_seconds' => 28800,
    'ca_file' => '/etc/enterprise-sso/tls/ca.crt',
    // Set false only when this business application itself is intentionally HTTP-only.
    'local_cookie_secure' => true,
    'session_name' => 'MY_APP_SSO_SID',
    'session_path' => '/my-app/',
);
