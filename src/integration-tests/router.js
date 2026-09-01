import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { pool } from '../db.js';
import { decryptJson } from '../security/crypto.js';
import { messagePage } from '../views/html.js';

const router = express.Router();

async function clientSecret(applicationId) {
  const [rows] = await pool.execute(
    `SELECT o.payload FROM applications a JOIN oidc_objects o ON o.model='Client' AND o.id=a.client_id
     WHERE a.id=? AND a.status='active' LIMIT 1`,
    [applicationId],
  );
  if (!rows[0]) return null;
  return decryptJson(JSON.parse(rows[0].payload)).client_secret ?? null;
}

function validTimestamp(value) {
  const timestamp = Number(value);
  return Number.isInteger(timestamp) && Math.abs(Date.now() / 1000 - timestamp) <= 300 ? timestamp : null;
}

function matchesProof(actual, expected) {
  return typeof actual === 'string' && actual.length === expected.length
    && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

router.get('/api/v1/integration-tests/:id/login', async (req, res) => {
  const sub = String(req.query.sub ?? '').trim();
  const timestamp = validTimestamp(req.query.ts);
  const secret = await clientSecret(req.params.id);
  if (!sub || !timestamp || !secret) return res.status(400).type('html').send(messagePage('登录验收失败', '验收凭据无效或已经超过五分钟。'));
  const expected = createHmac('sha256', secret).update(`login|${sub}|${timestamp}`).digest('hex');
  if (!matchesProof(String(req.query.proof ?? ''), expected)) return res.status(403).type('html').send(messagePage('登录验收失败', '客户端签名不正确。'));
  const [people] = await pool.execute("SELECT id FROM people WHERE id=? AND status IN ('active','probation')", [sub]);
  if (!people[0]) return res.status(403).type('html').send(messagePage('登录验收失败', '登录身份不是有效人员。'));
  await pool.execute("UPDATE applications SET auth_test_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [req.params.id]);
  return res.type('html').send(messagePage('登录验收通过', `已验证 UserID ${sub}，Agent 可继续执行注销验收。`));
});

router.get('/api/v1/integration-tests/:id/logout', async (req, res) => {
  const timestamp = validTimestamp(req.query.ts);
  const secret = await clientSecret(req.params.id);
  if (!timestamp || !secret) return res.status(400).type('html').send(messagePage('注销验收失败', '验收凭据无效或已经超过五分钟。'));
  const expected = createHmac('sha256', secret).update(`logout|${timestamp}`).digest('hex');
  if (!matchesProof(String(req.query.proof ?? ''), expected)) return res.status(403).type('html').send(messagePage('注销验收失败', '客户端签名不正确。'));
  await pool.execute("UPDATE applications SET logout_test_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [req.params.id]);
  return res.type('html').send(messagePage('注销验收通过', '业务 Session 与统一认证注销流程已经完成。'));
});

export const integrationTestsRouter = router;
