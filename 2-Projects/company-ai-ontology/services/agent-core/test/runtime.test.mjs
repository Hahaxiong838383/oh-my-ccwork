import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHmac } from 'node:crypto'

import { createHEngineRuntime } from '../src/runtime.mjs'

test('Company Front-door 提示词将用户身份操作转交私人 Bot', async () => {
  const promptPath = new URL('../prompts/company-front-door.md', import.meta.url)
  const prompt = await fs.readFile(promptPath, 'utf8')

  assert.match(prompt, /不得索取、保存或使用员工的 user_access_token/)
  assert.match(prompt, /改用自己的私人 Bot 完成/)
  assert.match(prompt, /群聊 \+ 发起员工/)
  assert.match(prompt, /多人同时 @ 你时分别处理/)
})

test('H 引擎 CLI 超时后中止并返回 runtime_timeout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'h-engine-timeout-'))
  const bin = path.join(root, 'engine.sh')
  const promptFile = path.join(root, 'prompt.md')
  await fs.writeFile(bin, '#!/bin/sh\nsleep 1\necho late\n')
  await fs.chmod(bin, 0o700)
  await fs.writeFile(promptFile, 'system prompt')
  const runtime = createHEngineRuntime({
    config: {
      provider: 'h-engine', mode: 'cli', bin, home: root, grokHome: path.join(root, '.grok'),
      workspace: root, proxyUrl: '', apiKey: 'demo-key', promptFile, timeoutMs: 20,
      maxOutputBytes: 4096, demoDelayMs: 0, governance: { maxRetries: 0 },
    },
  })
  await assert.rejects(
    runtime.run({ intent: 'query', conversationId: 'timeout-test', evidence: [], message: 'test' }),
    (error) => error.code === 'runtime_timeout',
  )
})

test('H 引擎 remote 模式签名调用临时 H Worker', async (t) => {
  const secret = 'r'.repeat(48)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'h-engine-remote-'))
  const promptFile = path.join(root, 'prompt.md')
  await fs.writeFile(promptFile, '只根据权限化证据回答。')
  const worker = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/readyz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ready: true,
        credentialMode: 'cpa-api-key',
        provider: 'cpa-openai-compatible',
        model: 'grok-4.5',
      }))
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    const expected = createHmac('sha256', secret).update(`${request.headers['x-h-engine-timestamp']}.${body}`).digest('hex')
    assert.equal(request.headers['x-h-engine-signature'], expected)
    assert.match(JSON.parse(body).prompt, /权限化证据/)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      ok: true,
      reply: '远程 H 已回答',
      runtime: {
        credentialMode: 'cpa-api-key',
        provider: 'cpa-openai-compatible',
        model: 'grok-4.5',
        workerVersion: 'test',
        usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150, estimatedCostMicros: 80 },
      },
    }))
  })
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => worker.close(resolve)))
  const runtime = createHEngineRuntime({
    config: {
      provider: 'h-engine',
      mode: 'remote',
      remoteUrl: `http://127.0.0.1:${worker.address().port}/v1/infer`,
      remoteSecret: secret,
      promptFile,
      timeoutMs: 1000,
      maxOutputBytes: 4096,
    },
  })
  const readiness = await runtime.ready()
  assert.equal(readiness.productionReady, true)
  assert.equal(readiness.engineProvider, 'cpa-openai-compatible')
  assert.equal(readiness.model, 'grok-4.5')
  assert.equal(readiness.governance.routeB.enabled, false)
  const result = await runtime.run({ intent: 'query', conversationId: 'remote-test', evidence: [{ title: '制度' }], message: '请回答' })
  assert.equal(result.reply, '远程 H 已回答')
  assert.equal(result.runtime.mode, 'remote')
  assert.equal(result.runtime.engineProvider, 'cpa-openai-compatible')
  assert.equal(result.runtime.model, 'grok-4.5')
  assert.equal(result.runtime.usage.totalTokens, 150)
  assert.equal(result.runtime.governance.credentialModeTag, 'temporary_personal_credential')
  assert.equal(result.runtime.governance.routeBEnabled, false)
})
