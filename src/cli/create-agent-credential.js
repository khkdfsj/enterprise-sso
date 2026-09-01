import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { randomToken, sha256 } from '../security/crypto.js';

const identity = String(process.env.AGENT_IDENTITY ?? '').trim();
const displayName = String(process.env.AGENT_DISPLAY_NAME ?? '').trim();
const createdBy = String(process.env.AGENT_CREATED_BY ?? '').trim();
const validDays = Number(process.env.AGENT_VALID_DAYS ?? 30);

async function run() {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._@/-]{2,159}$/.test(identity)) throw new Error('AGENT_IDENTITY is invalid');
  if (!displayName || displayName.length > 120) throw new Error('AGENT_DISPLAY_NAME is required');
  if (!createdBy) throw new Error('AGENT_CREATED_BY is required');
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) throw new Error('AGENT_VALID_DAYS must be 1..365');
  const [people] = await pool.execute("SELECT id FROM people WHERE id=? AND status IN ('active','probation')", [createdBy]);
  if (!people[0]) throw new Error('AGENT_CREATED_BY must be an active person');
  const token = randomToken(48);
  const now = new Date();
  const expires = new Date(now.getTime() + validDays * 86400_000).toISOString();
  await pool.execute(
    "INSERT INTO agent_api_credentials(id,agent_identity,display_name,token_hash,status,expires_at,created_by,created_at) VALUES (?,?,?,?,'active',?,?,?)",
    [randomUUID(), identity, displayName, sha256(token), expires, createdBy, now.toISOString()],
  );
  console.log(JSON.stringify({ agent_identity: identity, agent_token: token, expires_at: expires }, null, 2));
  await pool.end();
}

run().catch(async (error) => { console.error(error.message); await pool.end(); process.exitCode = 1; });
