import { pool } from '../db.js';
import { config } from '../config.js';
import { decryptJson, encryptJson } from '../security/crypto.js';

function expiryDate(expiresIn) {
  if (typeof expiresIn !== 'number') return null;
  return new Date(Date.now() + expiresIn * 1000);
}

function hydrate(row) {
  if (!row) return undefined;
  const envelope = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  return decryptJson(envelope);
}

export class SqliteOidcAdapter {
  constructor(model) {
    this.model = model;
  }

  async upsert(id, payload, expiresIn) {
    const now = new Date();
    await pool.execute(
      `INSERT INTO oidc_objects
        (model,id,payload,grant_id,user_code,uid,expires_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload,grant_id=excluded.grant_id,
         user_code=excluded.user_code,uid=excluded.uid,expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
      [this.model, id, JSON.stringify(encryptJson(payload)), payload.grantId ?? null, payload.userCode ?? null, payload.uid ?? null, expiryDate(expiresIn), now, now],
    );
  }

  async find(id) {
    if (this.model === 'Session') return this.findSession('id', id);
    const [rows] = await pool.execute(
      "SELECT payload FROM oidc_objects WHERE model=? AND id=? AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) LIMIT 1",
      [this.model, id],
    );
    return hydrate(rows[0]);
  }

  async findByUid(uid) {
    return this.findSession('uid', uid);
  }

  async findSession(column, value) {
    if (!['id', 'uid'].includes(column)) throw new Error('Invalid session lookup');
    const absoluteCutoff = new Date(Date.now() - config.ttl.session * 1000);
    const idleCutoff = new Date(Date.now() - config.ttl.sessionIdle * 1000);
    const [rows] = await pool.execute(
      `SELECT id,payload FROM oidc_objects
       WHERE model='Session' AND ${column}=?
         AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         AND created_at > ?
         AND updated_at > ?
       LIMIT 1`,
      [value, absoluteCutoff, idleCutoff],
    );
    if (!rows[0]) return undefined;
    await pool.execute(
      "UPDATE oidc_objects SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE model='Session' AND id=?",
      [rows[0].id],
    );
    return hydrate(rows[0]);
  }

  async findByUserCode(userCode) {
    const [rows] = await pool.execute(
      "SELECT payload FROM oidc_objects WHERE model=? AND user_code=? AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) LIMIT 1",
      [this.model, userCode],
    );
    return hydrate(rows[0]);
  }

  async consume(id) {
    const payload = await this.find(id);
    if (!payload) return;
    payload.consumed = Math.floor(Date.now() / 1000);
    await pool.execute(
      "UPDATE oidc_objects SET payload=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE model=? AND id=?",
      [JSON.stringify(encryptJson(payload)), this.model, id],
    );
  }

  async destroy(id) {
    await pool.execute('DELETE FROM oidc_objects WHERE model=? AND id=?', [this.model, id]);
  }

  async revokeByGrantId(grantId) {
    await pool.execute('DELETE FROM oidc_objects WHERE grant_id=?', [grantId]);
  }
}
