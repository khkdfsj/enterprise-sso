import { pool } from '../db.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { decryptJson } from '../security/crypto.js';

function safeMessage(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 240);
}

export async function checkApplicationConnectivity(applicationId) {
  const [apps] = await pool.execute(
    `SELECT a.id,a.client_id,a.health_check_url,o.payload FROM applications a
     JOIN oidc_objects o ON o.model='Client' AND o.id=a.client_id
     WHERE a.id=? AND a.client_id<>'enterprise-sso-admin' LIMIT 1`,
    [applicationId],
  );
  const app = apps[0];
  if (!app?.health_check_url) throw new Error('请先配置连通检测地址');
  const started = Date.now();
  let status = 'failure';
  let httpStatus = null;
  let message = '';
  try {
    const response = await fetch(app.health_check_url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': 'Enterprise-SSO-Connectivity-Monitor/1.0', accept: 'application/json,text/plain,*/*' },
      signal: AbortSignal.timeout(5000),
    });
    httpStatus = response.status;
    if (response.status >= 200 && response.status < 300) {
      const data = await response.json();
      const client = decryptJson(JSON.parse(app.payload));
      const expected = createHmac('sha256', client.client_secret).update('enterprise-sso-connectivity-v1').digest('hex');
      const actual = String(data.signature ?? '');
      const matched = data.ok === true && data.client_id === app.client_id
        && actual.length === expected.length
        && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
      status = matched ? 'success' : 'failure';
      message = matched ? '业务系统和客户端凭据均已验证' : '检测文件已响应，但 Client ID 或签名不匹配';
    } else {
      message = `业务系统返回 HTTP ${response.status}`;
    }
  } catch (error) {
    message = safeMessage(error.name === 'TimeoutError' ? '连接超时' : error.message);
  }
  const responseMs = Date.now() - started;
  const checkedAt = new Date().toISOString();
  await pool.execute(
    `UPDATE applications SET last_check_at=?,last_check_status=?,last_check_http_status=?,
       last_check_message=?,integration_status=?,updated_at=? WHERE id=?`,
    [checkedAt, status, httpStatus, message, status === 'success' ? 'ready' : 'testing', checkedAt, applicationId],
  );
  await pool.execute(
    `INSERT INTO application_connectivity_checks
      (application_id,status,http_status,response_ms,message,checked_at) VALUES (?,?,?,?,?,?)`,
    [applicationId, status, httpStatus, responseMs, message, checkedAt],
  );
  return { status, httpStatus, responseMs, message, checkedAt };
}

export async function runDueApplicationChecks() {
  const [apps] = await pool.execute(
    `SELECT id FROM applications
     WHERE status='active' AND health_check_url IS NOT NULL
       AND monitor_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
       AND (last_check_at IS NULL OR last_check_at<datetime('now','-30 seconds'))
     ORDER BY last_check_at LIMIT 10`,
  );
  for (const app of apps) {
    try { await checkApplicationConnectivity(app.id); } catch { /* next scheduled check may recover */ }
  }
}
