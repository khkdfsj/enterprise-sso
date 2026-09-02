import assert from 'node:assert/strict';
import test from 'node:test';
import { loginPage, messagePage, oidcErrorPage, oidcLogoutPage, oidcPostLogoutPage, qrPage } from '../src/views/html.js';
import { publicUrl } from '../src/public-url.js';

test('hosted login escapes application, username, and CSRF values', () => {
  const html = loginPage({
    uid: 'interaction/one',
    appName: '<img src=x onerror=alert(1)>',
    csrf: '" autofocus onfocus="alert(1)',
    username: '<script>alert(1)</script>',
    error: '<b>bad</b>',
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /interaction%2Fone/);
  assert.match(html, /&lt;b&gt;bad&lt;\/b&gt;/);
  assert.match(html, /assets\/login\.css\?v=0\.5\.5/);
});

test('QR page keeps browser secret in a POST body, not the status URL', () => {
  const html = qrPage({
    uid: 'uid-1',
    appName: 'Demo',
    csrf: 'csrf',
    transaction: { id: 'tx-1', browserSecret: 'secret-1' },
    qrSvg: '<svg aria-label="qr"></svg>',
  });
  assert.match(html, /name="browser_secret" value="secret-1"/);
  assert.match(html, new RegExp(`data-status-url="${publicUrl('/interaction/uid-1/wecom/status').replaceAll('/', '\\/')}"`));
  assert.doesNotMatch(html, /wecom\/status\?[^\"]*secret-1/);
});

test('message page escapes API error text', () => {
  assert.doesNotMatch(messagePage('Error', '<script>x</script>'), /<script>x<\/script>/);
});

test('hosted login hides QR entry until WeCom credentials are complete', () => {
  const html = loginPage({ uid: 'uid', appName: 'Demo', csrf: 'csrf', wecomEnabled: false });
  assert.doesNotMatch(html, /wecom\/start/);
  assert.match(html, /请输入账号和密码/);
});

test('OIDC logout, logged-out, and warning pages use the branded modern shell', () => {
  const logout = oidcLogoutPage({ appName: 'Demo', form: '<form id="op.logoutForm"></form>' });
  assert.match(logout, /确认退出？/);
  assert.match(logout, /form="op.logoutForm"/);
  assert.match(logout, /auth-visual/);
  assert.match(oidcPostLogoutPage('Demo'), /已退出/);
  assert.match(oidcErrorPage({ error: 'access_denied', error_description: 'No <script>x<\/script>' }), /无权访问此应用/);
  assert.doesNotMatch(oidcErrorPage({ error_description: '<script>x<\/script>' }), /<script>x<\/script>/);
});
