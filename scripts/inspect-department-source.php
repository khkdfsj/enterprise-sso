<?php
declare(strict_types=1);

require '/var/www/html/DepartmentIFO/member-platform/lib/bootstrap.php';

$summary = [
    'departments' => (int) db()->query('SELECT COUNT(*) FROM departments')->fetchColumn(),
    'members' => (int) db()->query('SELECT COUNT(*) FROM members')->fetchColumn(),
    'status' => db()->query('SELECT status,COUNT(*) count FROM members GROUP BY status ORDER BY status')->fetchAll(),
    'grades' => db()->query("SELECT COALESCE(NULLIF(grade,''),'unknown') grade,COUNT(*) count FROM members GROUP BY grade ORDER BY grade")->fetchAll(),
    'posts' => db()->query("SELECT COALESCE(NULLIF(posts,''),'unknown') posts,COUNT(*) count FROM members GROUP BY posts ORDER BY posts")->fetchAll(),
    'duplicate_student_numbers' => (int) db()->query('SELECT COUNT(*) FROM (SELECT stuno FROM members GROUP BY stuno HAVING COUNT(*)>1) d')->fetchColumn(),
    'missing_student_numbers' => (int) db()->query("SELECT COUNT(*) FROM members WHERE stuno IS NULL OR TRIM(stuno)=''")->fetchColumn(),
];

$special = db()->prepare("SELECT id,name,stuno,bm,posts,grade,status,tags,remark FROM members WHERE stuno IN ('2023195077','2007510002') OR name LIKE ? OR tags LIKE ? OR remark LIKE ? ORDER BY stuno");
$special->execute(['%多啦A梦%', '%多啦A梦%', '%多啦A梦%']);
$summary['special_matches'] = $special->fetchAll();

echo json_encode($summary, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), PHP_EOL;
