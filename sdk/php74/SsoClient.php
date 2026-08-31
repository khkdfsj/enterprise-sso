<?php

final class EnterpriseSsoClient
{
    private $issuer;
    private $clientId;
    private $clientSecret;
    private $redirectUri;
    private $discovery;
    private $idleSeconds;
    private $absoluteSeconds;
    private $caFile;
    private $cookieSecure;

    public function __construct(array $config)
    {
        foreach (array('issuer', 'client_id', 'client_secret', 'redirect_uri') as $key) {
            if (!isset($config[$key]) || !is_string($config[$key]) || $config[$key] === '') {
                throw new InvalidArgumentException('Missing SSO configuration: ' . $key);
            }
        }
        $this->issuer = rtrim($config['issuer'], '/');
        $this->clientId = $config['client_id'];
        $this->clientSecret = $config['client_secret'];
        $this->redirectUri = $config['redirect_uri'];
        $this->idleSeconds = isset($config['local_idle_seconds']) ? (int) $config['local_idle_seconds'] : 7200;
        $this->absoluteSeconds = isset($config['local_absolute_seconds']) ? (int) $config['local_absolute_seconds'] : 28800;
        $this->caFile = isset($config['ca_file']) && is_string($config['ca_file']) ? $config['ca_file'] : null;
        $this->cookieSecure = !isset($config['local_cookie_secure']) || (bool) $config['local_cookie_secure'];
        if (stripos($this->issuer, 'https://') !== 0) {
            throw new RuntimeException('SSO issuer must use HTTPS');
        }
        if ($this->idleSeconds <= 0 || $this->absoluteSeconds <= 0 || $this->idleSeconds > $this->absoluteSeconds) {
            throw new InvalidArgumentException('Invalid local SSO session lifetime');
        }
    }

    public function requireLogin()
    {
        $this->startSession();
        $now = time();
        $authenticatedAt = isset($_SESSION['enterprise_sso_authenticated_at']) ? (int) $_SESSION['enterprise_sso_authenticated_at'] : 0;
        $lastSeenAt = isset($_SESSION['enterprise_sso_last_seen_at']) ? (int) $_SESSION['enterprise_sso_last_seen_at'] : 0;
        if (isset($_SESSION['enterprise_sso_user']['sub'])
            && $authenticatedAt > $now - $this->absoluteSeconds
            && $lastSeenAt > $now - $this->idleSeconds) {
            $_SESSION['enterprise_sso_last_seen_at'] = $now;
            return $_SESSION['enterprise_sso_user'];
        }
        unset($_SESSION['enterprise_sso_user'], $_SESSION['enterprise_sso_authenticated_at'], $_SESSION['enterprise_sso_last_seen_at']);
        $this->beginLogin($this->currentRelativeUrl());
    }

    public function beginLogin($returnTo = '/')
    {
        $this->startSession();
        $state = $this->randomToken(32);
        $nonce = $this->randomToken(32);
        $verifier = $this->randomToken(48);
        $_SESSION['enterprise_sso_flow'] = array(
            'state' => $state,
            'nonce' => $nonce,
            'verifier' => $verifier,
            'return_to' => $this->safeReturnTo($returnTo),
            'created_at' => time(),
        );
        $discovery = $this->discovery();
        $query = http_build_query(array(
            'client_id' => $this->clientId,
            'redirect_uri' => $this->redirectUri,
            'response_type' => 'code',
            'scope' => 'openid profile enterprise',
            'state' => $state,
            'nonce' => $nonce,
            'code_challenge' => $this->base64Url(hash('sha256', $verifier, true)),
            'code_challenge_method' => 'S256',
        ), '', '&', PHP_QUERY_RFC3986);
        header('Location: ' . $discovery['authorization_endpoint'] . '?' . $query, true, 302);
        exit;
    }

    public function handleCallback()
    {
        $this->startSession();
        $flow = isset($_SESSION['enterprise_sso_flow']) ? $_SESSION['enterprise_sso_flow'] : null;
        unset($_SESSION['enterprise_sso_flow']);
        if (!is_array($flow) || time() - (int) $flow['created_at'] > 600) {
            throw new RuntimeException('SSO login flow has expired');
        }
        $state = isset($_GET['state']) ? (string) $_GET['state'] : '';
        if ($state === '' || !hash_equals($flow['state'], $state)) {
            throw new RuntimeException('Invalid SSO state');
        }
        if (isset($_GET['error'])) {
            throw new RuntimeException('SSO denied the login request');
        }
        $code = isset($_GET['code']) ? (string) $_GET['code'] : '';
        if ($code === '') throw new RuntimeException('Missing SSO authorization code');

        $discovery = $this->discovery();
        $token = $this->postForm($discovery['token_endpoint'], array(
            'grant_type' => 'authorization_code',
            'code' => $code,
            'redirect_uri' => $this->redirectUri,
            'client_id' => $this->clientId,
            'client_secret' => $this->clientSecret,
            'code_verifier' => $flow['verifier'],
        ));
        if (!isset($token['access_token']) || !is_string($token['access_token'])) {
            throw new RuntimeException('SSO token response is incomplete');
        }
        $user = $this->getJson($discovery['userinfo_endpoint'], $token['access_token']);
        if (!isset($user['sub']) || !is_string($user['sub']) || $user['sub'] === '') {
            throw new RuntimeException('SSO user response is incomplete');
        }
        session_regenerate_id(true);
        $_SESSION['enterprise_sso_user'] = $user;
        $_SESSION['enterprise_sso_authenticated_at'] = time();
        $_SESSION['enterprise_sso_last_seen_at'] = time();
        header('Location: ' . $flow['return_to'], true, 303);
        exit;
    }

    public function logout($returnTo = '/')
    {
        $this->startSession();
        unset($_SESSION['enterprise_sso_user'], $_SESSION['enterprise_sso_authenticated_at'], $_SESSION['enterprise_sso_last_seen_at']);
        session_regenerate_id(true);
        header('Location: ' . $this->safeReturnTo($returnTo), true, 303);
        exit;
    }

    private function discovery()
    {
        if (is_array($this->discovery)) return $this->discovery;
        $data = $this->getJson($this->issuer . '/.well-known/openid-configuration');
        if (!isset($data['issuer']) || !hash_equals($this->issuer, rtrim($data['issuer'], '/'))) {
            throw new RuntimeException('SSO issuer mismatch');
        }
        foreach (array('authorization_endpoint', 'token_endpoint', 'userinfo_endpoint') as $key) {
            if (!isset($data[$key]) || stripos($data[$key], 'https://') !== 0) {
                throw new RuntimeException('Invalid SSO discovery document');
            }
        }
        $this->discovery = $data;
        return $data;
    }

    private function startSession()
    {
        if (session_status() === PHP_SESSION_NONE) {
            if (headers_sent()) throw new RuntimeException('SSO guard must run before any output');
            session_set_cookie_params(array(
                'lifetime' => 0,
                'path' => '/',
                'secure' => $this->cookieSecure,
                'httponly' => true,
                'samesite' => 'Lax',
            ));
            session_start();
        }
    }

    private function currentRelativeUrl()
    {
        return $this->safeReturnTo(isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/');
    }

    private function safeReturnTo($value)
    {
        $value = is_string($value) ? $value : '/';
        if ($value === '' || $value[0] !== '/' || substr($value, 0, 2) === '//') return '/';
        return preg_replace('/[\r\n]/', '', $value);
    }

    private function postForm($url, array $fields)
    {
        return $this->requestJson($url, array(
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => http_build_query($fields, '', '&', PHP_QUERY_RFC3986),
            CURLOPT_HTTPHEADER => array('Content-Type: application/x-www-form-urlencoded'),
        ));
    }

    private function getJson($url, $bearer = null)
    {
        $options = array();
        if ($bearer !== null) $options[CURLOPT_HTTPHEADER] = array('Authorization: Bearer ' . $bearer);
        return $this->requestJson($url, $options);
    }

    private function requestJson($url, array $options)
    {
        $handle = curl_init($url);
        $defaults = array(
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_TIMEOUT => 8,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        );
        if ($this->caFile !== null) {
            if (!is_readable($this->caFile)) throw new RuntimeException('SSO CA file is not readable');
            $defaults[CURLOPT_CAINFO] = $this->caFile;
        }
        curl_setopt_array($handle, $options + $defaults);
        $body = curl_exec($handle);
        $status = curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $error = curl_error($handle);
        curl_close($handle);
        if ($body === false || $status < 200 || $status >= 300) {
            throw new RuntimeException('SSO request failed' . ($error ? ': ' . $error : ''));
        }
        $data = json_decode($body, true);
        if (!is_array($data)) throw new RuntimeException('SSO returned invalid JSON');
        return $data;
    }

    private function randomToken($bytes)
    {
        return $this->base64Url(random_bytes($bytes));
    }

    private function base64Url($value)
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }
}
