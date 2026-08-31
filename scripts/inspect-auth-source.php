<?php
declare(strict_types=1);

require '/var/www/html/DepartmentIFO/auth-monitor/lib/bootstrap.php';

$pdo = db();
$summary = [
    'users' => (int)$pdo->query('SELECT COUNT(*) FROM auth_users')->fetchColumn(),
];

$stmt = $pdo->prepare(
    "SELECT id, app_id, username, display_name, role, status
       FROM auth_users
      WHERE username IN ('2023195077', '2007510002')
         OR display_name LIKE :dora1
         OR display_name LIKE :dora2
         OR username LIKE :dora1
         OR username LIKE :dora2
      ORDER BY id"
);
$stmt->execute(['dora1' => '%多啦%', 'dora2' => '%哆啦%']);
$summary['special_matches'] = $stmt->fetchAll(PDO::FETCH_ASSOC);

echo json_encode($summary, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), PHP_EOL;
