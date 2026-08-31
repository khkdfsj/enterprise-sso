import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const productionSecrets = {
  COOKIE_KEYS: `${'a'.repeat(32)},${'b'.repeat(32)}`,
  PASSWORD_PEPPER: 'p'.repeat(32),
  OIDC_STORAGE_KEY: 'o'.repeat(32),
};

test('approved production HTTP issuer exposes its path prefix', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { config } = await import('./src/config.js');
    const { publicUrl } = await import('./src/public-url.js');
    process.stdout.write(JSON.stringify({ base: config.publicBasePath, secure: config.secureCookies, admin: publicUrl('/admin') }));
  `], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...productionSecrets,
      NODE_ENV: 'production',
      ISSUER: 'http://210.47.163.114/enterprise-sso',
      ALLOW_INSECURE_HTTP_ISSUER: '1',
      INTERNAL_HTTP_REDIRECT_HOSTS: '210.47.163.114',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { base: '/enterprise-sso', secure: false, admin: '/enterprise-sso/admin' });
});

test('production HTTP issuer is rejected without the explicit host approval', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config.js')"], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...productionSecrets,
      NODE_ENV: 'production',
      ISSUER: 'http://210.47.163.114/enterprise-sso',
      ALLOW_INSECURE_HTTP_ISSUER: '1',
      INTERNAL_HTTP_REDIRECT_HOSTS: '127.0.0.1',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approved internal host/);
});
