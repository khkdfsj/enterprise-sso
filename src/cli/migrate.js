import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { database, pool } from '../db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../migrations');

async function run() {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT`);
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const row = database.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(file);
    if (row) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(sql);
      database.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(file);
      database.exec('COMMIT');
      console.log(`applied ${file}`);
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  await pool.end();
}

run().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
