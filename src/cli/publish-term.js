import { pool } from '../db.js';
import { publishTerm } from '../services/terms.js';

const termId = String(process.env.TERM_ID ?? '').trim();
const approverPersonId = String(process.env.APPROVER_PERSON_ID ?? '').trim();
if (!termId || !approverPersonId) throw new Error('TERM_ID and APPROVER_PERSON_ID are required');

try {
  console.log(JSON.stringify(await publishTerm(termId, approverPersonId), null, 2));
} finally {
  await pool.end();
}
