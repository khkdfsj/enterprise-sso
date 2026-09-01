(() => {
  document.addEventListener('click', async (event) => {
    const tabButton = event.target.closest('[data-tabs] [data-tab]');
    if (tabButton) {
      const root = tabButton.closest('[data-tabs]');
      root.querySelectorAll('[data-tab]').forEach((button) => button.classList.toggle('active', button === tabButton));
      root.querySelectorAll('[data-tab-panel]').forEach((panel) => { panel.hidden = panel.dataset.tabPanel !== tabButton.dataset.tab; });
      return;
    }
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const target = document.querySelector(button.dataset.copy);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      const original = button.textContent;
      button.textContent = '已复制';
      setTimeout(() => { button.textContent = original; }, 1500);
    } catch {
      button.textContent = '请手动复制';
    }
  });
})();
