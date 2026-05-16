/**
 * Liepin (猎聘) job detail — scrape full job posting from detail page.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { requirePage, navigateTo, checkAuth, extractJobId, LIEPIN_DOMAIN } from './utils.js';

cli({
  site: 'liepin',
  name: 'detail',
  access: 'read',
  description: '猎聘职位详情',
  domain: LIEPIN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'job-id', positional: true, required: true, help: '职位 ID 或完整 URL（如 1980660479）' },
  ],
  columns: [
    'title', 'salary', 'location', 'experience', 'degree',
    'mark', 'description', 'requirements',
    'recruiter', 'recruiter_title', 'company', 'industry',
    'scale', 'stage', 'address', 'url',
  ],
  func: async (page, kwargs) => {
    requirePage(page);

    const jobId = extractJobId(kwargs['job-id']);
    const detailUrl = `https://www.liepin.com/job/${jobId}.shtml`;
    await navigateTo(page, detailUrl, 3);
    await checkAuth(page);

    const detail = await page.evaluate(`
      (function() {
        var r = {};
        // Title
        var titleEl = document.querySelector('.job-title, .name .ellipsis-2');
        r.title = titleEl ? titleEl.textContent.trim() : document.title.split('招聘')[0].replace(/【.*】/, '').trim();

        // Salary
        var salaryEl = document.querySelector('.salary, span[class*=salary]');
        r.salary = salaryEl ? salaryEl.textContent.trim() : '';

        // Properties: location, experience, degree
        var props = document.querySelectorAll('.job-properties > span:not(.split)');
        var propTexts = [];
        props.forEach(function(p) { var t = p.textContent.trim(); if (t) propTexts.push(t); });
        r.location = propTexts[0] || '';
        r.experience = propTexts[1] || '';
        r.degree = propTexts[2] || '';

        // Mark (急聘, etc.)
        var markEl = document.querySelector('.mark');
        r.mark = markEl ? markEl.textContent.trim() : '';

        // Job description
        var descContainer = document.querySelector('.job-intro-container, [class*=job-intro]');
        if (descContainer) {
          var fullText = descContainer.textContent.trim();
          // Split into description and requirements
          var reqIdx = fullText.indexOf('任职要求');
          if (reqIdx === -1) reqIdx = fullText.indexOf('岗位要求');
          if (reqIdx === -1) reqIdx = fullText.indexOf('职位要求');

          var descStart = fullText.indexOf('岗位职责');
          if (descStart === -1) descStart = fullText.indexOf('职位描述');
          if (descStart === -1) descStart = fullText.indexOf('职位介绍');
          if (descStart === -1) descStart = 0;
          else descStart = fullText.indexOf('\\n', descStart) > -1 ? fullText.indexOf('\\n', descStart) : descStart;

          if (reqIdx > -1) {
            r.description = fullText.substring(descStart, reqIdx).trim();
            r.requirements = fullText.substring(reqIdx).trim();
          } else {
            r.description = fullText.substring(descStart).trim();
            r.requirements = '';
          }
          // Clean up header text
          r.description = r.description.replace(/^职位介绍\\s*/, '').replace(/^岗位职责[：:]?\\s*/, '').trim();
          r.requirements = r.requirements.replace(/^任职要求[：:]?\\s*/, '').replace(/^岗位要求[：:]?\\s*/, '').trim();
        } else {
          r.description = '';
          r.requirements = '';
        }

        // Clean extra whitespace
        r.description = r.description.replace(/\\s{2,}/g, '\\n').trim();
        r.requirements = r.requirements.replace(/\\s{2,}/g, '\\n').trim();

        // Recruiter info
        var recruiterBox = document.querySelector('.recruiter-info, [class*=recruiter]');
        if (recruiterBox) {
          var nameEl = recruiterBox.querySelector('.name, span:first-child');
          r.recruiter = nameEl ? nameEl.textContent.trim() : '';
          var titleParts = recruiterBox.textContent.trim().split('\\n').map(function(s) { return s.trim(); }).filter(Boolean);
          r.recruiter_title = titleParts.length > 1 ? titleParts[1] : '';
        } else {
          r.recruiter = '';
          r.recruiter_title = '';
        }

        // Company info
        var compLink = document.querySelector('a[href*="/company/"]');
        r.company = compLink ? compLink.textContent.trim().replace(/^\\s*·\\s*/, '') : '';
        if (!r.company) {
          var compEl = document.querySelector('.company-name');
          r.company = compEl ? compEl.textContent.trim().replace(/^\\s*·\\s*/, '') : '';
        }

        // Company details from .company-tags-box spans (industry, stage, scale)
        r.industry = '';
        r.scale = '';
        r.stage = '';
        r.address = '';
        var tagsBox = document.querySelector('.company-tags-box');
        if (tagsBox) {
          var tagSpans = tagsBox.querySelectorAll('span');
          tagSpans.forEach(function(s) {
            var txt = s.textContent.trim();
            if (txt.match(/人$/)) r.scale = txt;
            else if (txt.match(/轮|融资|上市|不需要|天使|Pre-|A轮|B轮|C轮|D轮|战略/)) r.stage = txt;
            else if (txt && !r.industry) r.industry = txt;
          });
        }
        // Fallback: try older li-based structure
        if (!r.industry) {
          var infoItems = document.querySelectorAll('.comp-detail li, .company-info li');
          infoItems.forEach(function(li) {
            var txt = li.textContent.trim();
            if (txt.indexOf('行业') > -1) r.industry = txt.replace(/企业行业[：:]?/, '').trim();
            else if (txt.indexOf('规模') > -1) r.scale = txt.replace(/人数规模[：:]?/, '').trim();
            else if (txt.indexOf('融资') > -1) r.stage = txt.replace(/融资阶段[：:]?/, '').trim();
            else if (txt.indexOf('地址') > -1) r.address = txt.replace(/职位地址[：:]?/, '').trim();
          });
        }

        r.url = location.href.split('?')[0];
        return JSON.stringify(r);
      })()
    `);

    return [JSON.parse(detail)];
  },
});
