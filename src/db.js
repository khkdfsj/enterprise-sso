import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.db.file), { recursive: true, mode: 0o700 });
export const database = new DatabaseSync(config.db.file, {
  enableForeignKeyConstraints: true,
  timeout: 5000,
});
database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');

function values(params) {
  return params.map((value) => (value instanceof Date ? value.toISOString() : value));
}

function directExecute(sql, params = []) {
  const statement = database.prepare(sql);
  const normalized = values(params);
  if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) return [statement.all(...normalized)];
  return [statement.run(...normalized)];
}

const directConnection = Object.freeze({
  execute: async (sql, params = []) => directExecute(sql, params),
  query: async (sql, params = []) => directExecute(sql, params),
});

let operationTail = Promise.resolve();

async function exclusive(operation) {
  const previous = operationTail;
  let release;
  operationTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export const pool = Object.freeze({
  execute(sql, params = []) {
    return exclusive(() => directExecute(sql, params));
  },
  query(sql, params = []) {
    return exclusive(() => directExecute(sql, params));
  },
  async end() {
    await exclusive(() => database.close());
  },
});

export async function withTransaction(fn) {
  return exclusive(async () => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(directConnection);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
}

export async function checkDatabase() {
  const [rows] = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}
