<?php
declare(strict_types=1);

header('Cache-Control: no-store, private');
header('Pragma: no-cache');

$transactionId = isset($_GET['transaction_id']) ? trim((string)$_GET['transaction_id']) : '';
$state = isset($_GET['state']) ? trim((string)$_GET['state']) : '';

if (!preg_match('/^[A-Za-z0-9_-]{16,160}$/', $transactionId)
    || !preg_match('/^[A-Za-z0-9_-]{24,200}$/', $state)) {
    http_response_code(400);
    header('Content-Type: text/plain; charset=UTF-8');
    echo '二维码参数无效';
    exit;
}

$target = 'http://210.47.163.114/enterprise-sso/wecom/mobile?' . http_build_query([
    'transaction_id' => $transactionId,
    'state' => $state,
], '', '&', PHP_QUERY_RFC3986);

header('Location: ' . $target, true, 302);
exit;
