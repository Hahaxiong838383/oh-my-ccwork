/**
 * Liepin (猎聘) job apply — submit application via official MCP API.
 *
 * Requires LIEPIN_MCP_TOKEN env var.
 * Get token at https://www.liepin.com/mcp/server (valid 90 days).
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { callMcpTool, extractJobId, LIEPIN_DOMAIN } from './utils.js';

cli({
  site: 'liepin',
  name: 'apply',
  access: 'write',
  description: '猎聘投递简历（官方 MCP API）',
  domain: LIEPIN_DOMAIN,
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'job-id', positional: true, required: true, help: '职位 ID 或完整 URL（如 1980660479）' },
    { name: 'job-kind', type: 'int', default: 1, help: '职位类型（默认 1=猎头职位，0=直招）' },
  ],
  columns: ['job_id', 'status', 'message'],
  func: async (_page, kwargs) => {
    const jobId = extractJobId(kwargs['job-id']);
    const jobKind = kwargs['job-kind'] ?? 0;

    const result = await callMcpTool('user-apply-job', {
      jobId: jobId,
      jobKind: jobKind,
    });

    // Parse MCP tool result — typically { content: [{ type: 'text', text: '...' }] }
    const text = extractMcpText(result);
    return [{
      job_id: jobId,
      status: 'submitted',
      message: text,
    }];
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
