import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { createZip } from './zip-archive.js';

const phpSdkSource = readFileSync(new URL('../../sdk/php74/SsoClient.php', import.meta.url), 'utf8');

export function deriveIntegrationUrls(projectRootValue) {
  const projectRoot = new URL(projectRootValue);
  if (!projectRoot.pathname.endsWith('/')) projectRoot.pathname += '/';
  projectRoot.search = '';
  projectRoot.hash = '';
  const packageBase = new URL('ESSO-DFSJ/', projectRoot);
  return {
    projectRoot: projectRoot.toString(),
    redirectUri: new URL('callback.php', packageBase).toString(),
    logoutUri: projectRoot.toString(),
    healthUri: new URL('health.php', packageBase).toString(),
    loginTestUri: new URL('test-login.php', packageBase).toString(),
    logoutTestUri: new URL('test-logout.php', packageBase).toString(),
  };
}

export function buildIntegrationPackage(app, secret, urls) {
  const verifyLoginUrl = `${config.issuer}/api/v1/integration-tests/${encodeURIComponent(app.id)}/login`;
  const verifyLogoutUrl = `${config.issuer}/api/v1/integration-tests/${encodeURIComponent(app.id)}/logout`;
  const rootPath = new URL(urls.projectRoot).pathname;
  const logoutPath = new URL('ESSO-DFSJ/logout.php', urls.projectRoot).pathname;
  const configCode = `<?php\nreturn array(\n  'issuer' => '${config.issuer}',\n  'client_id' => '${app.client_id}',\n  'client_secret' => '${secret}',\n  'redirect_uri' => '${urls.redirectUri}',\n  'post_logout_redirect_uri' => '${urls.logoutUri}',\n  'allow_insecure_http' => true,\n  'local_cookie_secure' => false,\n  'session_name' => '${app.client_id.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 48).toUpperCase()}_SID',\n  'session_path' => '${rootPath}',\n  'local_idle_seconds' => 7200,\n  'local_absolute_seconds' => 28800,\n);`;
  const login = `<?php\n// 在业务页面输出任何内容前引入本文件。\nrequire_once __DIR__ . '/SsoClient.php';\n$enterpriseSso = new EnterpriseSsoClient(require __DIR__ . '/config.php');\n$ssoUser = $enterpriseSso->requireLogin();\n$essoLogoutUrl = '${logoutPath}';\n// $ssoUser['sub'] 是唯一 UserID；还可读取 name、department、position。`;
  const callback = `<?php\nrequire_once __DIR__ . '/SsoClient.php';\n$client = new EnterpriseSsoClient(require __DIR__ . '/config.php');\n$client->handleCallback();`;
  const logout = `<?php\nrequire_once __DIR__ . '/SsoClient.php';\n$client = new EnterpriseSsoClient(require __DIR__ . '/config.php');\n$client->logout('/'); // 同时退出本应用和统一认证`;
  const health = `<?php\n$config = require __DIR__ . '/config.php';\nheader('Content-Type: application/json; charset=UTF-8');\necho json_encode([\n  'ok' => true,\n  'client_id' => $config['client_id'],\n  'signature' => hash_hmac('sha256', 'enterprise-sso-connectivity-v1', $config['client_secret']),\n]);\n// 检测地址：${urls.healthUri}`;
  const testLogin = `<?php\n$config = require __DIR__ . '/config.php';\nrequire __DIR__ . '/login.php';\n$ts = time();\n$payload = 'login|' . $ssoUser['sub'] . '|' . $ts;\n$proof = hash_hmac('sha256', $payload, $config['client_secret']);\nheader('Location: ${verifyLoginUrl}?' . http_build_query([\n  'sub' => $ssoUser['sub'], 'ts' => $ts, 'proof' => $proof,\n]));\nexit;`;
  const testLogout = `<?php\n$config = require __DIR__ . '/config.php';\nif (!isset($_GET['armed']) || $_GET['armed'] !== '1') {\n  $ts = time();\n  $proof = hash_hmac('sha256', 'logout|' . $ts, $config['client_secret']);\n  header('Location: ${verifyLogoutUrl}/start?' . http_build_query(['ts' => $ts, 'proof' => $proof]));\n  exit;\n}\nrequire_once __DIR__ . '/SsoClient.php';\n$client = new EnterpriseSsoClient($config);\n$client->logout('/', '${verifyLogoutUrl}');`;
  const readme = `ESSO-DFSJ 统一认证接入包\n\n部署：把整个 ESSO-DFSJ 文件夹放到项目根目录，禁止改名。\n\n文件：\nconfig.php       基础配置和一次性 Client Secret，不得提交 Git 或公开下载。\nSsoClient.php    OIDC 协议客户端，负责 state、PKCE、令牌交换、用户信息和会话。\nlogin.php        登录入口及身份读取；业务页面引入后可使用 $ssoUser。\ncallback.php     统一认证回调，不能删除、不能直接访问。\nlogout.php       同时清理业务会话和统一认证会话。\nhealth.php       签名连通检测，验收后保留用于持续监控。\ntest-login.php   真实登录验收，全部测试通过后可删除。\ntest-logout.php  真实注销验收，全部测试通过后可删除。\n\n保护业务页面（文件第一行）：\nrequire_once __DIR__ . '/ESSO-DFSJ/login.php';\n$userId = $ssoUser['sub'];\n$name = $ssoUser['name'];\n\n退出链接（根页面或子目录都适用）：\n<a href=\"<?= htmlspecialchars($essoLogoutUrl, ENT_QUOTES, 'UTF-8') ?>\">退出登录</a>\n\n项目根地址：${urls.projectRoot}\n`;
  return createZip({
    'ESSO-DFSJ/config.php': configCode,
    'ESSO-DFSJ/SsoClient.php': phpSdkSource,
    'ESSO-DFSJ/login.php': login,
    'ESSO-DFSJ/callback.php': callback,
    'ESSO-DFSJ/logout.php': logout,
    'ESSO-DFSJ/health.php': health,
    'ESSO-DFSJ/test-login.php': testLogin,
    'ESSO-DFSJ/test-logout.php': testLogout,
    'ESSO-DFSJ/README.txt': readme,
  });
}
