/**
 * Liepin (猎聘) job search — DOM scraping via browser cookie session.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { requirePage, navigateTo, checkAuth, LIEPIN_DOMAIN, SALARY_CODE, WORK_YEAR_CODE } from './utils.js';

cli({
  site: 'liepin',
  name: 'search',
  access: 'read',
  description: '猎聘职位搜索',
  domain: LIEPIN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'query', positional: true, required: true, help: '搜索关键词' },
    { name: 'city', type: 'str', default: '', help: '城市名称（默认全国）' },
    { name: 'salary', type: 'str', default: '', help: '薪资范围：10万以下/10-15万/16-20万/21-30万/31-50万/51-100万/100万以上' },
    { name: 'experience', type: 'str', default: '', help: '工作经验：应届生/实习生/1年以下/1-3年/3-5年/5-10年/10年以上' },
    { name: 'page', type: 'int', default: 0, help: '页码（从 0 开始）' },
    { name: 'limit', type: 'int', default: 20, help: '返回数量' },
  ],
  columns: ['title', 'salary', 'company', 'company_info', 'location', 'experience', 'degree', 'tags', 'job_id', 'url'],
  func: async (page, kwargs) => {
    requirePage(page);

    const query = kwargs.query;
    const city = kwargs.city || '';
    const salary = kwargs.salary || '';
    const experience = kwargs.experience || '';
    const currentPage = kwargs.page || 0;
    const limit = kwargs.limit || 20;
    const pageSize = Math.min(limit, 40);

    const params = new URLSearchParams({
      dq: '000',
      key: query,
      currentPage: String(currentPage),
      pageSize: String(pageSize),
    });
    if (city) params.set('city', city);
    // Salary/experience code mappings from mcp-jobs crawlerConfig
    const salaryCode = SALARY_CODE[salary] || '';
    if (salaryCode) params.set('salaryCode', salaryCode);
    const workYearCode = WORK_YEAR_CODE[experience] || '';
    if (workYearCode) params.set('workYearCode', workYearCode);

    const searchUrl = `https://www.liepin.com/zhaopin/?${params.toString()}`;
    await navigateTo(page, searchUrl, 3);
    await checkAuth(page);

    const jobs = await page.evaluate(`
      (function() {
        var cards = document.querySelectorAll('.job-detail-box');
        var results = [];
        for (var i = 0; i < cards.length && i < ${limit}; i++) {
          var card = cards[i];
          var linkEl = card.querySelector('a[data-nick="job-detail-job-info"]');
          if (!linkEl) continue;

          var href = linkEl.href || '';
          var jobIdMatch = href.match(/(\\d{7,})/);
          var jobId = jobIdMatch ? jobIdMatch[1] : '';

          // Title: first .ellipsis-1 inside the link
          var titleEl = linkEl.querySelector('.ellipsis-1');
          var title = titleEl ? titleEl.textContent.trim() : '';

          // Salary: span with salary pattern (contains k/K/薪)
          var allSpans = linkEl.querySelectorAll('span');
          var salary = '';
          var tags = '';
          for (var j = 0; j < allSpans.length; j++) {
            var t = allSpans[j].textContent.trim();
            if (t.match(/\\d+[\\-~]\\d+k/i) || t.match(/\\d+k/i) || t.match(/元\\/天/)) {
              salary = t;
            } else if (t === '急聘' || t === '新' || t === '名企') {
              tags = tags ? tags + ',' + t : t;
            }
          }

          // Experience + Degree: inside the link's last div (class contains KeJJy)
          var labelRow = linkEl.querySelector('[class*=KeJJy]');
          var experience = '';
          var degree = '';
          if (!labelRow) {
            // Fallback: last div inside link, or sibling
            var innerDivs = linkEl.querySelectorAll('div');
            labelRow = innerDivs.length > 1 ? innerDivs[innerDivs.length - 1] : linkEl.nextElementSibling;
          }
          if (labelRow) {
            var labelSpans = labelRow.querySelectorAll ? labelRow.querySelectorAll('span') : [];
            for (var k = 0; k < labelSpans.length; k++) {
              var lt = labelSpans[k].textContent.trim();
              if (lt.match(/年|经验|应届|在校/)) experience = lt;
              else if (lt.match(/本科|硕士|博士|大专|高中|不限|统招/)) degree = lt;
            }
          }

          // Location: from the 【city】 text in the link
          var location = '';
          var titleFull = linkEl.textContent || '';
          var locMatch = titleFull.match(/【(.+?)】/);
          if (locMatch) location = locMatch[1];

          // Company: from company-info section
          var compBox = card.querySelector('[data-nick="job-detail-company-info"]');
          var company = '';
          var compInfo = '';
          if (compBox) {
            var compNameEl = compBox.querySelector('[class*=K6Y1c], .ellipsis-1');
            company = compNameEl ? compNameEl.textContent.trim() : '';
            // Industry/scale/stage from the info row
            var infoRow = compBox.querySelector('[class*=hFeAm]');
            if (infoRow) {
              var infoParts = [];
              infoRow.querySelectorAll('span').forEach(function(s) {
                var st = s.textContent.trim();
                if (st) infoParts.push(st);
              });
              compInfo = infoParts.join(' | ');
            }
          }

          results.push({
            title: title,
            salary: salary,
            company: company,
            company_info: compInfo,
            location: location,
            experience: experience,
            degree: degree,
            tags: tags,
            job_id: jobId,
            url: 'https://www.liepin.com/job/' + jobId + '.shtml'
          });
        }
        return JSON.stringify(results);
      })()
    `);

    return JSON.parse(jobs);
  },
});
