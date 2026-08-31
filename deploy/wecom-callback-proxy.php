<?php
declare(strict_types=1);

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
if (($_GET['asset'] ?? '') === 'login.css') {
    $asset = @file_get_contents('http://127.0.0.1:13000/enterprise-sso/assets/login.css');
    if (!is_string($asset)) {
        http_response_code(502);
        exit('Authentication asset unavailable');
    }
    header('Content-Type: text/css; charset=utf-8');
    echo $asset;
    exit;
}
$code = trim((string)($_GET['code'] ?? ''));
$state = trim((string)($_GET['state'] ?? ''));
if ($code === '' || $state === '' || strlen($code) > 512 || strlen($state) > 512) {
    http_response_code(400);
    exit('Invalid callback request');
}
$url = 'http://127.0.0.1:13000/enterprise-sso/wecom/callback?' . http_build_query(['code' => $code, 'state' => $state]);
$curl = curl_init($url);
curl_setopt_array($curl, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 3,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_FOLLOWLOCATION => false,
]);
$body = curl_exec($curl);
$status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
$contentType = (string)curl_getinfo($curl, CURLINFO_CONTENT_TYPE);
curl_close($curl);
if (!is_string($body) || $status < 200 || $status >= 600) {
    http_response_code(502);
    exit('Authentication callback unavailable');
}
http_response_code($status);
header('Content-Type: ' . ($contentType !== '' ? $contentType : 'text/html; charset=utf-8'));
echo str_replace('href="/enterprise-sso/assets/login.css"', 'href="?asset=login.css"', $body);
