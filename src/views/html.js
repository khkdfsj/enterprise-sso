function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function layout({ title, appName, content }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/assets/login.css"></head><body><main class="shell"><section class="intro"><div><h1>企业统一身份认证</h1><p>一次认证，安全访问已获授权的内部应用。密码和企业微信扫码均由统一认证中心处理。</p></div><div class="target"><small>正在登录</small><strong>${escapeHtml(appName)}</strong></div></section><section class="panel">${content}</section></main></body></html>`;
}

export function loginPage({ uid, appName, csrf, username = '', error = '', wecomEnabled = true }) {
  return layout({ title: '统一登录', appName, content: `
    <h2>欢迎登录</h2><p class="hint">${wecomEnabled ? '请选择账号密码或企业微信扫码登录。' : '请输入统一认证账号和密码。'}</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/interaction/${encodeURIComponent(uid)}/password">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="field"><label for="username">账号</label><input id="username" name="username" autocomplete="username" maxlength="120" value="${escapeHtml(username)}" required></div>
      <div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="200" required></div>
      <button class="btn primary" type="submit">登录</button>
    </form>
    ${wecomEnabled ? `<div class="divider">或者</div>
    <form method="post" action="/interaction/${encodeURIComponent(uid)}/wecom/start">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button class="btn wecom" type="submit">使用企业微信扫码</button>
    </form>` : ''}` });
}

export function qrPage({ uid, appName, csrf, transaction, qrSvg }) {
  return layout({ title: '企业微信扫码登录', appName, content: `
    <h2>企业微信扫码登录</h2><p class="hint">请使用企业微信扫一扫，并在手机上确认登录。</p>
    <div class="qr">${qrSvg}</div><div id="status" class="status">等待扫码，二维码将在两分钟后失效</div>
    <form id="complete" method="post" action="/interaction/${encodeURIComponent(uid)}/wecom/complete" data-status-url="/interaction/${encodeURIComponent(uid)}/wecom/status">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="transaction_id" value="${escapeHtml(transaction.id)}"><input type="hidden" name="browser_secret" value="${escapeHtml(transaction.browserSecret)}">
    </form>
    <div class="actions"><a class="btn secondary" href="/interaction/${encodeURIComponent(uid)}">返回其他登录方式</a></div>
    <script src="/assets/wecom-qr.js" defer></script>` });
}

export function messagePage(title, message) {
  return layout({ title, appName: '统一身份认证', content: `<h2>${escapeHtml(title)}</h2><p class="hint">${escapeHtml(message)}</p>` });
}
