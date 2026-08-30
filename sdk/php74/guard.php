<?php

require_once __DIR__ . '/SsoClient.php';
$enterpriseSso = new EnterpriseSsoClient(require __DIR__ . '/config.php');
$ssoUser = $enterpriseSso->requireLogin();
