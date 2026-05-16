/**
 * Liepin (猎聘) API search — search jobs via official MCP API.
 *
 * No browser needed. Requires LIEPIN_MCP_TOKEN env var.
 * Get token at https://www.liepin.com/mcp/server (valid 90 days).
 *
 * Compare with `search` command:
 *   - api-search: no browser, needs token, faster, official API
 *   - search: needs browser login, no token, DOM scraping, richer company info
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { callMcpTool, LIEPIN_DOMAIN } from './utils.js';

cli({
  site: 'liepin',
  name: 'api-search',
  access: 'read',
  description: '猎聘 API 搜索职位（官方 MCP，无需浏览器）',
  domain: LIEPIN_DOMAIN,
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'query', positional: true, required: true, help: '搜索关键词' },
    { name: 'address', type: 'str', default: '', help: '工作地点（如"北京""上海"）' },
    { name: 'salary', type: 'str', default: '', help: '薪资范围（如"20-30万"）' },
    { name: 'education', type: 'str', default: '', help: '学历要求（如"本科""硕士"）' },
    { name: 'experience', type: 'str', default: '', help: '工作经验（如"3-5年"）' },
    { name: 'company-type', type: 'str', default: '', help: '公司性质（如"民企""国企""外企"）' },
    { name: 'company-name', type: 'str', default: '', help: '公司名称' },
  ],
  columns: ['jobName', 'salary', 'company', 'location', 'education', 'workYears', 'industry', 'companySize', 'financingStage', 'companyTags', 'url'],
  func: async (_page, kwargs) => {
    const args = { jobName: kwargs.query };
    if (kwargs.address) args.address = kwargs.address;
    if (kwargs.salary) args.salary = kwargs.salary;
    if (kwargs.education) args.education = kwargs.education;
    if (kwargs.experience) args.experience = kwargs.experience;
    if (kwargs['company-type']) args.companyType = kwargs['company-type'];
    if (kwargs['company-name']) args.companyName = kwargs['company-name'];

    const result = await callMcpTool('user-search-job', args);
    const text = extractMcpText(result);

    try {
      const parsed = JSON.parse(text);
      const list = parsed.data?.list || parsed.list || (Array.isArray(parsed) ? parsed : []);
      return list.map(job => ({
        jobName: job.jobName || '',
        salary: job.salary || '',
        company: job.company || '',
        location: job.location || '',
        education: job.education || '',
        workYears: job.workYears || '',
        industry: job.industry || '',
        companySize: job.companySize || '',
        financingStage: job.financingStage || '',
        companyTags: Array.isArray(job.companyTags) ? job.companyTags.join(', ') : '',
        url: job.jobDetailUrl || '',
      }));
    } catch {
      return [{ jobName: text }];
    }
  },
});

function extractMcpText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (result.content && Array.isArray(result.content)) {
    return result.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return JSON.stringify(result);
}
