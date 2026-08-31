<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function fail_response(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    fail_response(405, 'method_not_allowed');
}

$configPath = '/etc/enterprise-sso-wecom-bridge/bridge.env';
$config = is_file($configPath) ? parse_ini_file($configPath, false, INI_SCANNER_RAW) : false;
if (!is_array($config)) fail_response(503, 'bridge_not_configured');

$allowedSource = (string)($config['ALLOWED_SOURCE_IP'] ?? '');
if ($allowedSource === '' || !hash_equals($allowedSource, (string)($_SERVER['REMOTE_ADDR'] ?? ''))) {
    fail_response(403, 'source_not_allowed');
}

$expectedToken = (string)($config['BRIDGE_TOKEN'] ?? '');
$authorization = (string)($_SERVER['HTTP_AUTHORIZATION'] ?? '');
$providedToken = strpos($authorization, 'Bearer ') === 0 ? substr($authorization, 7) : '';
if (strlen($expectedToken) < 32 || !hash_equals($expectedToken, $providedToken)) {
    fail_response(403, 'invalid_bridge_token');
}

$body = json_decode((string)file_get_contents('php://input'), true);
$code = is_array($body) ? trim((string)($body['code'] ?? '')) : '';
if ($code === '' || strlen($code) > 512 || !preg_match('/^[A-Za-z0-9_-]+$/', $code)) {
    fail_response(400, 'invalid_code');
}

$tokenUrl = (string)($config['ACCESS_TOKEN_URL'] ?? '');
if (!preg_match('#^https?://#i', $tokenUrl)) fail_response(503, 'invalid_token_source');

$curl = curl_init($tokenUrl);
curl_setopt_array($curl, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 3,
    CURLOPT_TIMEOUT => 5,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
]);
$tokenPayload = curl_exec($curl);
$tokenStatus = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
curl_close($curl);
if (!is_string($tokenPayload) || $tokenStatus < 200 || $tokenStatus >= 300) fail_response(502, 'token_source_failed');
$token = trim($tokenPayload);
if (strpos($token, '{') === 0) {
    $tokenJson = json_decode($token, true);
    $token = is_array($tokenJson) ? (string)($tokenJson['access_token'] ?? '') : '';
}
if (!preg_match('/^[A-Za-z0-9_-]{20,2048}$/', $token)) fail_response(502, 'invalid_token_payload');

$userinfoUrl = 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?' . http_build_query([
    'access_token' => $token,
    'code' => $code,
]);
$curl = curl_init($userinfoUrl);
curl_setopt_array($curl, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 3,
    CURLOPT_TIMEOUT => 8,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
]);
$payload = curl_exec($curl);
$status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
curl_close($curl);
if (!is_string($payload) || $status < 200 || $status >= 300) fail_response(502, 'wecom_request_failed');
$data = json_decode($payload, true);
if (!is_array($data) || (int)($data['errcode'] ?? 0) !== 0) {
    fail_response(502, 'wecom_api_rejected');
}
$userId = trim((string)($data['userid'] ?? $data['UserId'] ?? $data['UserID'] ?? ''));
if ($userId === '') fail_response(502, 'userid_missing');

echo json_encode(['ok' => true, 'userid' => $userId], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
