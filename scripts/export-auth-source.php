<?php
declare(strict_types=1);

require '/var/www/html/DepartmentIFO/auth-monitor/lib/bootstrap.php';

$payload = [
    'source' => 'departmentifo_auth_monitor',
    'exported_at' => gmdate('c'),
    'users' => db()->query(
        'SELECT id,app_id,username,display_name,role,status,created_at,updated_at FROM auth_users ORDER BY id'
    )->fetchAll(PDO::FETCH_ASSOC),
];

echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), PHP_EOL;
