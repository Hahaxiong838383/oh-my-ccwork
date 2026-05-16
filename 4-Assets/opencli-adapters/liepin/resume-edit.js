/**
 * Liepin (猎聘) resume edit — update resume modules via official MCP API.
 *
 * Modules: basic (基本信息), experience (工作经历),
 *          expectations (求职期望), self-assessment (自我评价)
 *
 * Requires LIEPIN_MCP_TOKEN env var.
 * Get token at https://www.liepin.com/mcp/server (valid 90 days).
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { callMcpTool, LIEPIN_DOMAIN } from './utils.js';
import { CommandExecutionError } from '@jackwener/opencli/errors';

const VALID_MODULES = ['basic', 'experience', 'expectations', 'self-assessment'];

cli({
  site: 'liepin',
  name: 'resume-edit',
  access: 'write',
  description: '猎聘编辑简历模块（官方 MCP API）',
  domain: LIEPIN_DOMAIN,
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: 'module',
      positional: true,
      required: true,
      help: '简历模块：basic(基本信息)/experience(工作经历)/expectations(求职期望)/self-assessment(自我评价)',
    },
    {
      name: 'data',
      positional: true,
      required: true,
      help: '更新数据（JSON 字符串）',
    },
  ],
  columns: ['module', 'status', 'message'],
  func: async (_page, kwargs) => {
    const moduleName = kwargs.module;
    const dataStr = kwargs.data;

    if (!VALID_MODULES.includes(moduleName)) {
      throw new CommandExecutionError(
        `无效模块 "${moduleName}"，可选：${VALID_MODULES.join(', ')}`
      );
    }

    let data;
    try {
      data = JSON.parse(dataStr);
    } catch {
      throw new CommandExecutionError('data 参数必须是合法 JSON 字符串');
    }

    const result = await callMcpTool('resume', {
      module: moduleName,
      data: data,
    });

    const text = extractMcpText(result);
    return [{
      module: moduleName,
      status: 'updated',
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
