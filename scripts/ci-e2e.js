import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const runtime = path.join(root, 'runtime');
const database = path.join(runtime, 'ci-e2e.sqlite3');
const jwks = path.join(runtime, 'ci-e2e-jwks.json');
fs.mkdirSync(runtime, { recursive: true });
for (const file of [database, `${database}-wal`, `${database}-shm`, jwks]) fs.rmSync(file, { force: true });

const password = 'CI-only-password-2026';
const clientSecret = 'ci-only-client-secret-not-for-production';
const publicPrefix = String(process.env.CI_PUBLIC_PREFIX ?? '').replace(/\/$/, '');
const issuer = `http://127.0.0.1:3000${publicPrefix}`;
const env = {
  ...process.env,
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: '3000',
  ISSUER: issuer,
  DB_FILE: database,
  COOKIE_KEYS: 'ci-cookie-key-one-at-least-thirty-two-characters,ci-cookie-key-two-at-least-thirty-two-characters',
  OIDC_JWKS_FILE: jwks,
  OIDC_STORAGE_KEY: 'ci-storage-key-at-least-thirty-two-characters',
  PASSWORD_PEPPER: 'ci-password-pepper-at-least-thirty-two-characters',
  DEV_CLIENT_ID: 'demo-app',
  DEV_CLIENT_SECRET: clientSecret,
  DEV_ADMIN_USERNAME: 'admin',
  DEV_ADMIN_PASSWORD: password,
  E2E_CLIENT_ID: 'demo-app',
  E2E_CLIENT_SECRET: clientSecret,
  E2E_USERNAME: 'admin',
  E2E_PASSWORD: password,
  E2E_DB_FILE: database,
  E2E_ISSUER: issuer,
};

function run(script) {
  const result = spawnSync(process.execPath, [script], { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${script} exited with ${result.status}`);
}

let server;
try {
  run('src/cli/migrate.js');
  run('src/cli/seed-dev.js');
  server = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: 'inherit' });

  let healthy = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Test server exited with ${server.exitCode}`);
    try {
      const response = await fetch(`${issuer}/healthz`);
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!healthy) throw new Error('Test server did not become healthy');

  run('scripts/e2e-login.js');
  run('scripts/e2e-admin.js');
  run('scripts/e2e-provisioning.js');
  run('scripts/e2e-agent.js');
  run('scripts/e2e-turnover.js');
  run('scripts/e2e-turnover-workflow.js');
} finally {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  for (const file of [database, `${database}-wal`, `${database}-shm`, jwks]) fs.rmSync(file, { force: true });
}
