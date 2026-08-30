(() => {
  const form = document.getElementById('complete');
  const statusElement = document.getElementById('status');
  if (!form || !statusElement) return;
  const transactionId = form.elements.transaction_id.value;
  const browserSecret = form.elements.browser_secret.value;
  let stopped = false;

  async function poll() {
    if (stopped) return;
    try {
      const response = await fetch(form.dataset.statusUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: transactionId, browser_secret: browserSecret }),
        cache: 'no-store',
      });
      const data = await response.json();
      if (data.status === 'approved') {
        stopped = true;
        statusElement.textContent = '验证成功，正在登录…';
        form.submit();
        return;
      }
      if (['denied', 'expired', 'consumed'].includes(data.status)) {
        stopped = true;
        statusElement.textContent = data.status === 'denied'
          ? '当前企业微信账号未获授权'
          : '二维码已失效，请返回重试';
        return;
      }
    } catch {
      // A transient network failure is retried without exposing internal details.
    }
    setTimeout(poll, 1500);
  }
  poll();
})();
