import { config } from '../config.js';
import { database, pool } from '../db.js';

if (!config.wecom.corpId) throw new Error('WECOM_CORP_ID must be configured');

const now = new Date().toISOString();
database.exec('BEGIN IMMEDIATE');
try {
  database.prepare(`INSERT OR IGNORE INTO wecom_identities(person_id,corp_id,wecom_userid,status,bound_at)
    SELECT id, ?, id, 'active', ? FROM people`).run(config.wecom.corpId, now);
  database.prepare(`UPDATE wecom_identities
    SET wecom_userid=person_id,status='active'
    WHERE corp_id=?`).run(config.wecom.corpId);
  database.exec('COMMIT');
} catch (error) {
  database.exec('ROLLBACK');
  throw error;
}

const counts = database.prepare(`SELECT
  (SELECT COUNT(*) FROM people) AS people,
  (SELECT COUNT(*) FROM wecom_identities WHERE corp_id=?) AS identities,
  (SELECT COUNT(*) FROM wecom_identities WHERE corp_id=? AND person_id<>wecom_userid) AS mismatches`).get(
  config.wecom.corpId,
  config.wecom.corpId,
);

if (counts.identities !== counts.people || counts.mismatches !== 0) {
  throw new Error(`WeCom identity synchronization failed: ${JSON.stringify(counts)}`);
}
console.log(JSON.stringify({ corp_id: config.wecom.corpId, ...counts }, null, 2));
await pool.end();
