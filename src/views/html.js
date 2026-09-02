import { publicUrl } from '../public-url.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function icon(type) {
  const paths = {
    login: '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M13 8l4 4-4 4M7 12h10"/>',
    success: '<path d="M20 6 9 17l-5-5"/>',
    warning: '<path d="M12 9v4m0 4h.01"/><path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/>',
    error: '<path d="m15 9-6 6m0-6 6 6"/><circle cx="12" cy="12" r="9"/>',
    logout: '<path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M14 8l4 4-4 4m4-4H9"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[type] ?? paths.warning}</svg>`;
}

function statusTone(title) {
  if (/成功|通过|已开通|已退出|安全退出/.test(title)) return 'success';
  if (/失败|错误|不可用|无权/.test(title)) return 'error';
  return 'warning';
}

function layout({ title, appName, content, mode = 'login' }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · ESSO-DFSJ</title><link rel="stylesheet" href="${publicUrl('/assets/login.css')}"></head><body class="auth-page auth-${escapeHtml(mode)}"><div class="auth-shell"><aside class="auth-visual"><div class="visual-brand"><span class="brand-mark">ID</span><div><strong>ESSO-DFSJ</strong><small>部门统一身份认证</small></div></div><div class="visual-copy"><span class="visual-kicker">ESSO-DFSJ</span><h2>部门统一<br>身份认证</h2><div class="visual-notes" aria-label="编程知识点"><p class="visual-note note-one">清晰胜过聪明，简单胜过复杂。</p><p class="visual-note note-two">先让代码正确，再让它易于理解。</p><p class="visual-note note-three">可读性，是写给未来的一份文档。</p></div></div><div class="visual-foot">ESSO-DFSJ</div></aside><main class="auth-main"><div class="mobile-brand"><span class="brand-mark">ID</span><div><strong>ESSO-DFSJ</strong><small>部门统一身份认证</small></div></div><section class="auth-card ${mode === 'qr' ? 'qr-card' : ''}"><div class="app-context"><span class="app-dot"></span><span>访问</span><strong>${escapeHtml(appName)}</strong></div>${content}</section><footer>ESSO-DFSJ · 部门统一身份认证</footer></main></div></body></html>`;
}

function methodTabs({ uid, csrf = '', active, wecomEnabled = true }) {
  if (!wecomEnabled) return '';
  const password = active === 'password'
    ? '<button class="method-tab active" type="button" aria-current="page">账号密码</button>'
    : `<a class="method-tab" href="${publicUrl(`/interaction/${encodeURIComponent(uid)}`)}">账号密码</a>`;
  const wecom = active === 'wecom'
    ? '<button class="method-tab active" type="button" aria-current="page">企业微信扫码</button>'
    : `<form method="post" action="${publicUrl(`/interaction/${encodeURIComponent(uid)}/wecom/start`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="method-tab" type="submit">企业微信扫码</button></form>`;
  return `<nav class="auth-method-tabs ${active === 'wecom' ? 'show-wecom' : 'show-password'}" aria-label="登录方式"><span class="method-slider" aria-hidden="true"></span>${password}${wecom}</nav>`;
}

function statusContent(title, message, { tone = statusTone(title), actions = '' } = {}) {
  const iconType = tone === 'logout' ? 'logout' : tone;
  return `<div class="status-hero ${escapeHtml(tone)}"><div class="status-icon">${icon(iconType)}</div><span class="status-kicker">${tone === 'success' ? '已完成' : tone === 'error' ? '未完成' : tone === 'logout' ? '退出登录' : '提示'}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${actions ? `<div class="status-actions">${actions}</div>` : ''}</div>`;
}

export function loginPage({ uid, appName, csrf, username = '', error = '', wecomEnabled = true }) {
  return layout({ title: '统一登录', appName, content: `
    ${methodTabs({ uid, csrf, active: 'password', wecomEnabled })}
    <div class="method-panel password-panel">
    <header class="auth-heading"><span class="heading-kicker">ESSO-DFSJ</span><h1>登录</h1><p>${wecomEnabled ? '请选择账号密码或企业微信扫码登录' : '请输入账号和密码'}</p></header>
    ${error ? `<div class="alert error"><span>${icon('error')}</span><div>${escapeHtml(error)}</div></div>` : ''}
    <form class="login-form" method="post" action="${publicUrl(`/interaction/${encodeURIComponent(uid)}/password`)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="field"><label for="username">UserID</label><div class="input-wrap"><span class="input-icon">${icon('login')}</span><input id="username" name="username" autocomplete="username" inputmode="numeric" maxlength="120" placeholder="请输入学号或工号" value="${escapeHtml(username)}" required></div></div>
      <div class="field"><label for="password">密码</label><div class="input-wrap"><span class="input-icon lock-icon"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></span><input id="password" name="password" type="password" autocomplete="current-password" maxlength="200" placeholder="请输入密码" required></div></div>
      <button class="btn primary" type="submit">登录<span class="btn-arrow">→</span></button>
    </form>
    </div>` });
}

export function qrPage({ uid, appName, csrf, transaction, qrSvg }) {
  return layout({ title: '企业微信扫码登录', appName, mode: 'qr', content: `
    ${methodTabs({ uid, csrf, active: 'wecom' })}
    <div class="method-panel qr-panel">
    <header class="auth-heading compact"><span class="heading-kicker">企业微信</span><h1>扫码确认身份</h1><p>打开企业微信扫一扫，并在手机上确认登录</p></header>
    <div class="qr-frame"><div class="qr">${qrSvg}</div><span class="qr-corner c1"></span><span class="qr-corner c2"></span><span class="qr-corner c3"></span><span class="qr-corner c4"></span></div><div id="status" class="status"><span class="pulse"></span>等待扫码，二维码两分钟内有效</div>
    <form id="complete" method="post" action="${publicUrl(`/interaction/${encodeURIComponent(uid)}/wecom/complete`)}" data-status-url="${publicUrl(`/interaction/${encodeURIComponent(uid)}/wecom/status`)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="transaction_id" value="${escapeHtml(transaction.id)}"><input type="hidden" name="browser_secret" value="${escapeHtml(transaction.browserSecret)}">
    </form>
    <script src="${publicUrl('/assets/wecom-qr.js')}" defer></script>
    </div>` });
}

export function messagePage(title, message) {
  return layout({ title, appName: '部门统一身份认证', mode: 'status', content: statusContent(title, message) });
}

export function oidcLogoutPage({ appName, form }) {
  const actions = `${form}<button class="btn primary" autofocus type="submit" form="op.logoutForm" value="yes" name="logout">确认退出</button><button class="btn secondary no-margin" type="submit" form="op.logoutForm">取消</button>`;
  return layout({ title: '确认退出', appName: appName || '部门统一身份认证', mode: 'status', content: statusContent('确认退出？', '退出后，再次使用时需要重新登录。', { tone: 'logout', actions }) });
}

export function oidcPostLogoutPage(appName) {
  return layout({ title: '已退出', appName: appName || '部门统一身份认证', mode: 'status', content: statusContent('已退出', '你可以关闭此页面。', { tone: 'success' }) });
}

export function oidcErrorPage(out = {}, error = {}) {
  const title = out.error === 'access_denied' ? '无权访问此应用' : '认证请求未完成';
  const message = out.error_description || '请返回原页面后重试。';
  return layout({ title, appName: '部门统一身份认证', mode: 'status', content: statusContent(title, message, { tone: out.error === 'access_denied' ? 'warning' : 'error' }) });
}
