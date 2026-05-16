/**
 * Liepin (猎聘) user profile — get current logged-in user info.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { requirePage, navigateTo, checkAuth, LIEPIN_DOMAIN } from './utils.js';

cli({
  site: 'liepin',
  name: 'me',
  access: 'read',
  description: '猎聘个人信息',
  domain: LIEPIN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [],
  columns: ['name', 'title', 'resume_views', 'unread_messages', 'invitations', 'url'],
  func: async (page, kwargs) => {
    requirePage(page);

    await navigateTo(page, 'https://c.liepin.com/', 3);
    await checkAuth(page);

    const profile = await page.evaluate(`
      (function() {
        var r = {};
        // User name from header
        var nameEl = document.querySelector('#header-quick-menu-user-info span:nth-child(2), [class*=user-name]');
        r.name = nameEl ? nameEl.textContent.trim() : '';

        // Try to find dashboard info
        var cards = document.querySelectorAll('[class*=card], [class*=Card], .panel, .module');
        cards.forEach(function(card) {
          var txt = card.textContent;
          if (txt.indexOf('简历被查看') > -1 || txt.indexOf('被查看') > -1) {
            var num = txt.match(/(\\d+)\\s*次/);
            if (num) r.resume_views = num[1];
          }
          if (txt.indexOf('未读消息') > -1 || txt.indexOf('未读') > -1) {
            var num2 = txt.match(/(\\d+)/);
            if (num2) r.unread_messages = num2[1];
          }
          if (txt.indexOf('邀请') > -1) {
            var num3 = txt.match(/(\\d+)/);
            if (num3) r.invitations = num3[1];
          }
        });

        r.title = document.title || '';
        r.url = location.href;
        return JSON.stringify(r);
      })()
    `);

    return [JSON.parse(profile)];
  },
});
