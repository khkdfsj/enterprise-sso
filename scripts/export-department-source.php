<?php
declare(strict_types=1);

require '/var/www/html/DepartmentIFO/member-platform/lib/bootstrap.php';

$payload = [
    'source' => 'departmentifo_platform',
    'exported_at' => gmdate('c'),
    'departments' => db()->query('SELECT id,name,parent_id,leader_member_id,created_at,updated_at FROM departments ORDER BY id')->fetchAll(),
    'members' => db()->query('SELECT id,name,stuno,department_id,bm,posts,grade,phone,email,status,tags,remark,joined_at,left_at,created_at,updated_at FROM members ORDER BY id')->fetchAll(),
    'roles' => db()->query('SELECT id,name,label,permissions,created_at FROM roles ORDER BY id')->fetchAll(),
    'member_roles' => db()->query('SELECT member_id,role_id FROM member_roles ORDER BY member_id,role_id')->fetchAll(),
    'status_history' => db()->query('SELECT member_id,old_status,new_status,reason,actor,created_at FROM member_status_histories ORDER BY id')->fetchAll(),
];

echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), PHP_EOL;
