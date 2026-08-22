#!/usr/bin/env node
/**
 * mycc MCP Hub — 连通性探针 server
 * 用途：验证某个 agent 运行时（claude / codex / grok / …）能否真正走通 MCP 通道。
 * 判据设计：返回一个客户端无法猜测的 magic，调用方必须原样带回，
 *          同时服务端独立记账（日志），双向印证，避免"模型自述调用了"的假阳性。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAGIC = process.env.MYCC_PROBE_MAGIC
  || `MYCC-PROBE-${process.pid}-${Math.floor(Date.now() / 1000).toString(16).toUpperCase()}`;
const LOGDIR = path.join(os.homedir(), '.mycc-mcp');
const LOG = path.join(LOGDIR, 'probe-calls.log');
try { fs.mkdirSync(LOGDIR, { recursive: true }); } catch {}

const stamp = () => new Date().toISOString();
const audit = m => { try { fs.appendFileSync(LOG, `${stamp()} ${m}\n`); } catch {} };
const send = o => process.stdout.write(JSON.stringify(o) + '\n');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    audit(`initialize client=${params?.clientInfo?.name || '?'} proto=${params?.protocolVersion || '?'}`);
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'mycc-probe', version: '0.1.0' }
    }});
  } else if (method === 'tools/list') {
    audit('tools/list');
    send({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'mycc_probe',
      description: 'Connectivity probe for the mycc MCP Hub. Returns a magic token that CANNOT be guessed — it only comes from actually calling this tool.',
      inputSchema: { type: 'object', properties: { note: { type: 'string', description: 'caller identity' } }, required: [] }
    }]}});
  } else if (method === 'tools/call') {
    const note = params?.arguments?.note ?? '';
    audit(`tools/call name=${params?.name} note=${note}`);
    send({ jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: `MAGIC=${MAGIC} note=${note} pid=${process.pid}` }]
    }});
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` }});
  }
}
