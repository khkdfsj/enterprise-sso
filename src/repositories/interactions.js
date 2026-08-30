import { pool } from '../db.js';
import { randomToken, safeEqualHex, sha256 } from '../security/crypto.js';

export async function issueCsrf(interactionUid, ttlSeconds = 600) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await pool.execute(
    `INSERT INTO interaction_csrf_tokens(interaction_uid,token_hash,expires_at,created_at)
     VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(interaction_uid) DO UPDATE SET
       token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=excluded.created_at`,
    [interactionUid, sha256(token), expiresAt],
  );
  return token;
}

export async function consumeCsrf(interactionUid, token) {
  const [rows] = await pool.execute(
    "SELECT token_hash FROM interaction_csrf_tokens WHERE interaction_uid=? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1",
    [interactionUid],
  );
  const valid = rows[0] && safeEqualHex(rows[0].token_hash, sha256(token ?? ''));
  if (valid) await pool.execute('DELETE FROM interaction_csrf_tokens WHERE interaction_uid=?', [interactionUid]);
  return Boolean(valid);
}
