import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createReviewerRoleAccessBundle } from './fixtures/readiness-fixtures.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPILER = path.join(ROOT, 'scripts/compile-reviewer-role-access-acceptance.mjs')
const VALIDATOR = path.join(ROOT, 'scripts/validate-reviewer-role-access-acceptance.mjs')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

test('四角色 UAT 验收由四份真实会话和一份安全负责人接受记录编译', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-role-evidence-'))
  const { acceptanceFile } = await createReviewerRoleAccessBundle(outputRoot)
  await fs.rm(acceptanceFile)
  const compiled = spawnSync(process.execPath, [COMPILER, outputRoot, acceptanceFile], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  assert.equal(JSON.parse(compiled.stdout).rawEvidenceFileCount, 5)

  const validated = spawnSync(process.execPath, [VALIDATOR, acceptanceFile], { encoding: 'utf8' })
  assert.equal(validated.status, 0, validated.stderr)
  const output = JSON.parse(validated.stdout)
  assert.equal(output.scopedRoleCount, 4)
  assert.equal(output.rawEvidenceFileCount, 5)
  assert.doesNotMatch(validated.stdout, /company-directory:|displayName|evidenceRef/)
})

test('手改最终 UAT 验收文件不能绕过原始证据编译', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-role-final-tamper-'))
  const { acceptanceFile, acceptance } = await createReviewerRoleAccessBundle(outputRoot)
  await fs.writeFile(acceptanceFile, JSON.stringify({ ...acceptance, allFiltersValid: false }))
  const result = spawnSync(process.execPath, [VALIDATOR, acceptanceFile], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not compiler-derived/)
})

test('成员会话未拒绝越权编辑时编译失败关闭', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-role-session-fail-'))
  const { acceptanceFile } = await createReviewerRoleAccessBundle(outputRoot)
  const sessionFile = path.join(outputRoot, 'reviewer-role-session-ai-rd.json')
  const session = JSON.parse(await fs.readFile(sessionFile, 'utf8'))
  session.results.unassignedCategoryEditDenied = false
  await fs.writeFile(sessionFile, JSON.stringify(session))
  const result = spawnSync(process.execPath, [VALIDATOR, acceptanceFile], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unassignedCategoryEditDenied must be true/)
})

test('安全负责人必须接受四份实际 Session Hash 且时间晚于会话', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-role-owner-fail-'))
  const { acceptanceFile } = await createReviewerRoleAccessBundle(outputRoot)
  const ownerFile = path.join(outputRoot, 'reviewer-role-security-owner-acceptance.json')
  const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'))
  owner.roleSessionHashes.brand = '0'.repeat(64)
  await fs.writeFile(ownerFile, JSON.stringify(owner))
  const hashMismatch = spawnSync(process.execPath, [VALIDATOR, acceptanceFile], { encoding: 'utf8' })
  assert.notEqual(hashMismatch.status, 0)
  assert.match(hashMismatch.stderr, /brand session hash was not accepted/)

  await createReviewerRoleAccessBundle(outputRoot)
  const earlyOwner = JSON.parse(await fs.readFile(ownerFile, 'utf8'))
  earlyOwner.acceptedAt = '2026-08-11T08:00:00Z'
  await fs.writeFile(ownerFile, JSON.stringify(earlyOwner))
  const early = spawnSync(process.execPath, [VALIDATOR, acceptanceFile], { encoding: 'utf8' })
  assert.notEqual(early.status, 0)
  assert.match(early.stderr, /predates member session/)
})

test('四个角色必须由四个不同真实成员完成', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-role-duplicate-member-'))
  const { acceptanceFile } = await createReviewerRoleAccessBundle(outputRoot)
  const productFile = path.join(outputRoot, 'reviewer-role-session-product-user.json')
  const brandFile = path.join(outputRoot, 'reviewer-role-session-brand.json')
  const product = JSON.parse(await fs.readFile(productFile, 'utf8'))
  const brand = JSON.parse(await fs.readFile(brandFile, 'utf8'))
  brand.memberPrincipal = product.memberPrincipal
  const brandBytes = Buffer.from(JSON.stringify(brand))
  await fs.writeFile(brandFile, brandBytes)
  const ownerFile = path.join(outputRoot, 'reviewer-role-security-owner-acceptance.json')
  const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'))
  owner.roleSessionHashes.brand = sha256(brandBytes)
  await fs.writeFile(ownerFile, JSON.stringify(owner))
  const result = spawnSync(process.execPath, [VALIDATOR, acceptanceFile], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /four distinct members/)
})
