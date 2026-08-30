import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import { randomToken, safeEqualHex, sha256 } from '../security/crypto.js';

export async function createWecomTransaction(interactionUid) {
  const id = randomUUID();
  const browserSecret = randomToken();
  const oauthState = randomToken();
  const expiresAt = new Date(Date.now() + config.ttl.wecomTransaction * 1000);
  await pool.execute(
    `INSERT INTO wecom_login_transactions
      (id,interaction_uid,browser_secret_hash,oauth_state_hash,status,expires_at,created_at)
     VALUES (?,?,?,?, 'pending', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    [id, interactionUid, sha256(browserSecret), sha256(oauthState), expiresAt],
  );
  return { id, browserSecret, oauthState, expiresAt };
}

export async function validateMobileTransaction(id, oauthState) {
  const [rows] = await pool.execute(
    `SELECT * FROM wecom_login_transactions
     WHERE id=? AND status='pending' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1`,
    [id],
  );
  return Boolean(rows[0] && safeEqualHex(rows[0].oauth_state_hash, sha256(oauthState ?? '')));
}

export async function findTransactionByState(oauthState) {
  const [rows] = await pool.execute(
    `SELECT * FROM wecom_login_transactions
     WHERE oauth_state_hash=? AND status IN ('pending','scanned') AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1`,
    [sha256(oauthState ?? '')],
  );
  return rows[0];
}

export async function approveTransaction(id, personId) {
  const [result] = await pool.execute(
    `UPDATE wecom_login_transactions SET status='approved',person_id=?,approved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=? AND status IN ('pending','scanned') AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [personId, id],
  );
  return result.changes === 1;
}

export async function denyTransaction(id) {
  await pool.execute(
    `UPDATE wecom_login_transactions SET status='denied'
     WHERE id=? AND status IN ('pending','scanned')`,
    [id],
  );
}

export async function readTransactionStatus(id, browserSecret, interactionUid) {
  const [rows] = await pool.execute(
    'SELECT status,browser_secret_hash,expires_at FROM wecom_login_transactions WHERE id=? AND interaction_uid=? LIMIT 1',
    [id, interactionUid],
  );
  const row = rows[0];
  if (!row || !safeEqualHex(row.browser_secret_hash, sha256(browserSecret ?? ''))) return undefined;
  if (new Date(row.expires_at).getTime() <= Date.now() && row.status === 'pending') return { status: 'expired' };
  return { status: row.status };
}

export async function consumeApprovedTransaction(id, browserSecret, interactionUid) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute(
      `SELECT * FROM wecom_login_transactions
       WHERE id=? AND interaction_uid=?`,
      [id, interactionUid],
    );
    const row = rows[0];
    if (!row || !safeEqualHex(row.browser_secret_hash, sha256(browserSecret ?? ''))) return undefined;
    if (row.status !== 'approved' || new Date(row.expires_at).getTime() <= Date.now()) return undefined;
    await connection.execute(
      "UPDATE wecom_login_transactions SET status='consumed',consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      [id],
    );
    return row.person_id;
  });
}
