/**
 * Liepin (猎聘) shared utilities.
 *
 * Two data paths:
 *   1. Browser DOM scraping (Strategy.COOKIE) — search/detail/me
 *   2. Official MCP API (Strategy.PUBLIC)     — apply/resume/resume-edit
 */
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const LIEPIN_DOMAIN = 'www.liepin.com';
const LOGIN_CHECK_MSG = '登录已失效，请在 Chrome 中重新登录猎聘。';

// ── Official MCP API ────────────────────────────────────────────────
export const MCP_ENDPOINT = 'https://open-agent.liepin.com/mcp/user';
const TOKEN_ENV_KEY = 'LIEPIN_MCP_TOKEN';

/**
 * Read MCP token: process.env → ~/.opencli/.env fallback
 */
export function getMcpToken() {
  let token = process.env[TOKEN_ENV_KEY] || '';
  if (!token) {
    // Fallback: read from ~/.opencli/.env
    try {
      const envPath = join(homedir(), '.opencli', '.env');
      const envContent = readFileSync(envPath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith(`${TOKEN_ENV_KEY}=`)) {
          token = trimmed.slice(TOKEN_ENV_KEY.length + 1).trim().replace(/^["']|["']$/g, '');
          break;
        }
      }
    } catch { /* file not found — expected */ }
  }
  if (!token) {
    throw new CommandExecutionError(
      `猎聘 MCP token 未配置。请设置环境变量 ${TOKEN_ENV_KEY}，或在 ~/.opencli/.env 中添加。\n` +
      '获取方式：登录 https://www.liepin.com/mcp/server → 点击「生成凭证」（90 天有效）'
    );
  }
  return token;
}

/**
 * Call Liepin official MCP API via node:https (bypasses HTTP_PROXY).
 * Uses MCP Streamable HTTP protocol — POST with JSON-RPC 2.0 body.
 */
export async function callMcpTool(toolName, args = {}) {
  const token = getMcpToken();
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });

  // Use node:https directly to bypass undici's EnvHttpProxyAgent
  // which picks up HTTP_PROXY and causes 406.
  const { request } = await import('node:https');
  const url = new URL(MCP_ENDPOINT);

  const resp = await new Promise((resolve, reject) => {
    const req = request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-user-token': token,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode, text });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (resp.status < 200 || resp.status >= 300) {
    throw new CommandExecutionError(
      `猎聘 MCP API ${resp.status}: ${resp.text.substring(0, 200)}`
    );
  }

  const data = JSON.parse(resp.text);
  if (data.error) {
    throw new CommandExecutionError(`猎聘 MCP API error: ${JSON.stringify(data.error)}`);
  }
  return data.result;
}

// ── Salary / Experience code mappings (from mcp-jobs crawlerConfig) ──
export const SALARY_CODE = {
  '10万以下': '1',
  '10-15万': '2',
  '16-20万': '3',
  '21-30万': '4',
  '31-50万': '5',
  '51-100万': '6',
  '100万以上': '7',
};

export const WORK_YEAR_CODE = {
  '应届生': '1',
  '实习生': '2',
  '1年以下': '0$1',
  '1-3年': '1$3',
  '3-5年': '3$5',
  '5-10年': '5$10',
  '10年以上': '10$999',
};

// ── Browser helpers ─────────────────────────────────────────────────
export function requirePage(page) {
  if (!page) throw new CommandExecutionError('Browser page required');
}

export async function navigateTo(page, url, waitSeconds = 2) {
  await page.goto(url);
  await page.wait({ time: waitSeconds });
}

/**
 * Check if the page has a valid login session.
 */
export async function checkAuth(page) {
  const isLoggedIn = await page.evaluate(`
    (function() {
      var userEl = document.querySelector('#header-quick-menu-user-info, [class*=user-info]');
      return !!userEl;
    })()
  `);
  if (!isLoggedIn) {
    throw new AuthRequiredError(LIEPIN_DOMAIN, LOGIN_CHECK_MSG);
  }
}

/**
 * Extract job ID from a liepin job URL.
 * e.g. "https://www.liepin.com/job/1980660479.shtml" => "1980660479"
 */
export function extractJobId(urlOrId) {
  if (!urlOrId) return null;
  const match = String(urlOrId).match(/(\d{7,})/);
  return match ? match[1] : urlOrId;
}
