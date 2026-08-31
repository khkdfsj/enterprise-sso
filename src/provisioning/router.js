import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { sha256 } from '../security/crypto.js';
import { hashPassword, verifyPassword } from '../security/password.js';
import { messagePage } from '../views/html.js';
import { publicUrl } from '../public-url.js';

const router = express.Router();
const json = express.json({ limit: '16kb' });
const form = express.urlencoded({ extended: false, limit: '16kb' });
const USER_ID_PATTERN = /^[A-Za-z0-9_.@-]{2,120}$/;
const provisioningLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const registrationLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
async function client(req) {
  const encoded = String(req.headers.authorization ?? '').match(/^Basic\s+(.+)$/i)?.[1];
  if (!encoded) return null;
  let clientId; let secret;
  try {
    [clientId, secret] = Buffer.from(encoded, 'base64').toString('utf8').split(/:(.*)/s, 2);
  } catch { return null; }
  const [rows] = await pool.execute("SELECT * FROM applications WHERE client_id=? AND status='active' AND provisioning_enabled=1", [clientId]);
  const application = rows[0];
  if (!application?.client_secret_hash || !(await verifyPassword(application.client_secret_hash, secret ?? ''))) return null;
  return application;
}

router.post('/api/v1/registrations', provisioningLimit, json, async (req, res) => {
  const application = await client(req);
  if (!application) return res.status(401).json({ error: 'invalid_client' });
  const userId = String(req.body.user_id ?? '').trim();
  const displayName = String(req.body.display_name ?? '').trim();
  if (!USER_ID_PATTERN.test(userId) || !displayName || displayName.length > 160) return res.status(400).json({ error: 'invalid_request' });
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 15 * 60_000);
  await pool.execute(
    `INSERT INTO quick_registration_tokens(id,application_id,token_hash,user_id,display_name,expires_at,created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [id, application.id, sha256(token), userId, displayName, expires, now],
  );
  res.status(201).json({
    registration_id: id,
    user_id: userId,
    registration_url: `${config.issuer}/register/${token}`,
    expires_at: expires.toISOString(),
  });
});

router.get('/register/:token', async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT q.user_id,q.display_name,a.name application_name FROM quick_registration_tokens q
     JOIN applications a ON a.id=q.application_id
     WHERE q.token_hash=? AND q.consumed_at IS NULL AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [sha256(req.params.token)],
  );
  const record = rows[0];
  if (!record) return res.status(410).send(messagePage('注册链接已失效', '请返回业务系统重新发起注册。'));
  res.send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>开通统一认证</title><link rel="stylesheet" href="${publicUrl('/assets/login.css')}"></head><body><main class="shell"><section class="intro"><h1>开通统一认证</h1><p>由 ${escapeHtml(record.application_name)} 发起。UserID 将作为唯一身份主键。</p></section><section class="panel"><h2>${escapeHtml(record.display_name)}</h2><p class="hint">UserID：${escapeHtml(record.user_id)}</p><form method="post"><label>设置密码<input type="password" name="password" minlength="12" maxlength="200" autocomplete="new-password" required></label><button class="btn primary">完成注册</button></form></section></main></body></html>`);
});

router.post('/register/:token', registrationLimit, form, async (req, res, next) => {
  try {
    const passwordHash = await hashPassword(req.body.password);
    await withTransaction(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT * FROM quick_registration_tokens WHERE token_hash=? AND consumed_at IS NULL
         AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        [sha256(req.params.token)],
      );
      const record = rows[0];
      if (!record) throw new Error('expired');
      const [existing] = await connection.execute('SELECT id FROM people WHERE id=?', [record.user_id]);
      if (!existing[0]) {
        await connection.execute(
          `INSERT INTO people(id,employee_no,display_name,status,source_system,created_at,updated_at)
           VALUES (?,?,?,'probation','quick_registration',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
          [record.user_id, record.user_id, record.display_name],
        );
      }
      const [accounts] = await connection.execute('SELECT id FROM accounts WHERE person_id=?', [record.user_id]);
      const accountId = accounts[0]?.id ?? randomUUID();
      if (accounts[0]) {
        const [credentials] = await connection.execute('SELECT 1 FROM password_credentials WHERE account_id=?', [accountId]);
        if (credentials[0]) throw new Error('already_registered');
      }
      if (!accounts[0]) await connection.execute(
        `INSERT INTO accounts(id,person_id,username,status,created_at,updated_at)
         VALUES (?,?,?,'active',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        [accountId, record.user_id, record.user_id.toLowerCase()],
      );
      await connection.execute(
        `INSERT INTO password_credentials(account_id,password_hash,changed_at) VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(account_id) DO UPDATE SET password_hash=excluded.password_hash,password_version=password_version+1,changed_at=excluded.changed_at`,
        [accountId, passwordHash],
      );
      if (config.wecom.corpId) await connection.execute(
        `INSERT OR IGNORE INTO wecom_identities(person_id,corp_id,wecom_userid,status,bound_at)
         VALUES (?,?,?,'active',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        [record.user_id, config.wecom.corpId, record.user_id],
      );
      await connection.execute("UPDATE quick_registration_tokens SET consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [record.id]);
    });
    res.send(messagePage('统一认证已开通', '现在可以返回业务系统，使用密码或企业微信扫码登录。'));
  } catch (error) {
    if (error.message === 'expired') return res.status(410).send(messagePage('注册链接已失效', '请返回业务系统重新发起注册。'));
    if (error.message === 'already_registered') return res.status(409).send(messagePage('账号已经开通', '请直接登录；如忘记密码，请联系管理员重置。'));
    next(error);
  }
});

export const provisioningRouter = router;
