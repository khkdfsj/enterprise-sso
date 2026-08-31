import { pool } from '../db.js';
import { startTurnover } from '../services/turnover.js';

const termId = String(process.env.TERM_ID ?? '').trim();
const actor = String(process.env.APPROVER_PERSON_ID ?? '').trim();
if (!termId || !actor) throw new Error('TERM_ID and APPROVER_PERSON_ID are required');
console.log(JSON.stringify(await startTurnover(termId, actor), null, 2));
await pool.end();
