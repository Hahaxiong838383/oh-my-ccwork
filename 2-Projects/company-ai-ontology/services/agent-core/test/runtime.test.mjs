import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
      maxOutputBytes: 4096, demoDelayMs: 0,
    },
  })
  await assert.rejects(
    runtime.run({ intent: 'query', conversationId: 'timeout-test', evidence: [], message: 'test' }),
    (error) => error.code === 'runtime_timeout',
  )
})
