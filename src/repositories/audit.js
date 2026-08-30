import { pool } from '../db.js';

export async function audit(req, eventType, result, options = {}) {
  const requestId = req.get?.('x-request-id') ?? null;
  const ip = req.ip ?? req.socket?.remoteAddress ?? null;
  const userAgent = String(req.get?.('user-agent') ?? '').slice(0, 500) || null;
  await pool.execute(
    `INSERT INTO audit_logs
      (request_id,actor_person_id,event_type,target_type,target_id,result,detail_json,ip_address,user_agent,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    [requestId, options.actorPersonId ?? null, eventType, options.targetType ?? null,
      options.targetId ?? null, result, options.detail ? JSON.stringify(options.detail) : null, ip, userAgent],
  );
}
