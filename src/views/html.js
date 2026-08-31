import { publicUrl } from '../public-url.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function layout({ title, appName, content, mode = 'login' }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${publicUrl('/assets/login.css')}"></head><body><main class="auth-wrap"><div class="brand"><span class="brand-mark">ID</span><span>企业统一身份认证</span></div><section class="auth-card ${mode === 'qr' ? 'qr-card' : ''}"><div class="app-context"><span class="app-dot"></span><span>登录到</span><strong>${escapeHtml(appName)}</strong></div>${content}</section><footer>统一身份 · 一次登录 · 按权访问</footer></main></body></html>`;
}

export function loginPage({ uid, appName, csrf, username = '', error = '', wecomEnabled = true }) {
  return layout({ title: '统一登录', appName, content: `
    <header class="auth-heading"><h1>登录</h1><p>${wecomEnabled ? '使用账号密码，或通过企业微信安全登录' : '请输入统一认证账号和密码'}</p></header>
    ${error ? `<div class="alert error">${escapeHtml(error)}</div>` : ''}
    <form class="login-form" method="post" action="${publicUrl(`/interaction/${encodeURIComponent(uid)}/password`)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="field"><label for="username">UserID</label><input id="username" name="username" autocomplete="username" inputmode="numeric" maxlength="120" placeholder="请输入学号或工号" value="${escapeHtml(username)}" required></div>
      <div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="200" placeholder="请输入密码" required></div>
      <button class="btn primary" type="submit">登录</button>
    </form>
    ${wecomEnabled ? `<div class="divider"><span>其他方式</span></div>
    <form method="post" action="${publicUrl(`/interaction/${encodeURIComponent(uid)}/wecom/start`)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button class="btn wecom" type="submit"><span class="wecom-icon">企</span>企业微信扫码登录</button>
    </form>` : ''}
    <p class="security-note">登录信息仅由统一认证中心处理，业务系统不会获取你的密码。</p>` });
}

export function qrPage({ uid, appName, csrf, transaction, qrSvg }) {
  return layout({ title: '企业微信扫码登录', appName, mode: 'qr', content: `
    <header class="auth-heading compact"><h1>企业微信扫码</h1><p>使用企业微信扫一扫完成身份确认</p></header>
    <div class="qr">${qrSvg}</div><div id="status" class="status"><span class="pulse"></span>等待扫码，二维码两分钟内有效</div>
    <form id="complete" method="post" action="${publicUrl(`/interaction/${encodeURIComponent(uid)}/wecom/complete`)}" data-status-url="${publicUrl(`/interaction/${encodeURIComponent(uid)}/wecom/status`)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="transaction_id" value="${escapeHtml(transaction.id)}"><input type="hidden" name="browser_secret" value="${escapeHtml(transaction.browserSecret)}">
    </form>
    <a class="btn secondary" href="${publicUrl(`/interaction/${encodeURIComponent(uid)}`)}">返回账号登录</a>
    <script src="${publicUrl('/assets/wecom-qr.js')}" defer></script>` });
}

export function messagePage(title, message) {
  return layout({ title, appName: '统一身份认证', content: `<header class="auth-heading"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></header>` });
}
