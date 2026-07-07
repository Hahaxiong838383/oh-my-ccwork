(function () {
  function injectOpsDashboard() {
    if (document.getElementById('ai-ops-summary-shortcut')) return;
    const main = document.querySelector('main') || document.body;
    if (!main) return;
    const card = document.createElement('a');
    card.id = 'ai-ops-summary-shortcut';
    card.href = '/ops-dashboard/';
    card.textContent = 'AI Ops 总览：正常/异常、备份、磁盘、容器、日报一屏看完';
    card.style.cssText = 'display:block;margin:16px 0;padding:16px 18px;border:1px solid #334155;border-radius:16px;background:#111827;color:#e5e7eb;text-decoration:none;font-weight:700;box-shadow:0 12px 40px #0004;';
    main.prepend(card);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectOpsDashboard);
  } else {
    injectOpsDashboard();
  }
  setTimeout(injectOpsDashboard, 1000);
})();
