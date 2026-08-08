import test from 'node:test'
import assert from 'node:assert/strict'

import { loadConfig } from '../src/config.mjs'

function baseEnv() {
  return {
    KNOWLEDGE_CONNECTOR_CONTROL_TOKEN: 'a'.repeat(32),
    FUTURUS_TENANT_ID: '11111111-1111-4111-8111-111111111111',
    PGPASSWORD: 'database-password',
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'b'.repeat(16),
  }
}

test('Base64 资源配置优先于旧 JSON 配置', () => {
  const resources = [{ type: 'docx', token: 'docx-test', title: '测试文档' }]
  const config = loadConfig({
    ...baseEnv(),
    FEISHU_KNOWLEDGE_RESOURCES_B64: Buffer.from(JSON.stringify(resources)).toString('base64'),
    FEISHU_KNOWLEDGE_RESOURCES_JSON: 'not-json',
  })
  assert.deepEqual(config.feishu.resources, resources)
})

test('空 Base64 配置兼容旧 JSON 配置', () => {
  const resources = [{ type: 'sheet', token: 'sheet-test' }]
  const config = loadConfig({
    ...baseEnv(),
    FEISHU_KNOWLEDGE_RESOURCES_B64: '',
    FEISHU_KNOWLEDGE_RESOURCES_JSON: JSON.stringify(resources),
  })
  assert.deepEqual(config.feishu.resources, resources)
})

test('非法 Base64 JSON 配置拒绝启动', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv(), FEISHU_KNOWLEDGE_RESOURCES_B64: Buffer.from('{}').toString('base64') }),
    /Base64-encoded JSON array/,
  )
})
