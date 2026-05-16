/**
 * Liepin (猎聘) resume — view current resume via official MCP API.
 *
 * Requires LIEPIN_MCP_TOKEN env var.
 * Get token at https://www.liepin.com/mcp/server (valid 90 days).
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { callMcpTool, LIEPIN_DOMAIN } from './utils.js';

cli({
  site: 'liepin',
  name: 'resume',
  access: 'read',
  description: '猎聘查看我的简历（官方 MCP API）',
  domain: LIEPIN_DOMAIN,
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [],
  columns: ['content'],
  func: async (_page, _kwargs) => {
    const result = await callMcpTool('my-resume');
    const text = extractMcpText(result);

    // Try to parse structured resume data
    try {
      const parsed = JSON.parse(text);
      return [parsed];
    } catch {
      return [{ content: text }];
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
