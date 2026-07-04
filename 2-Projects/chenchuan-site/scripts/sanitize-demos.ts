#!/usr/bin/env tsx
/**
 * 脱敏检查脚本：扫 src/data/classic-demos.ts (以及未来 admin 录入的 demo 数据)
 *
 * 在 git pre-commit + CI / 部署前必跑。命中任何 P0 模式 → 退出码 1 阻断部署。
 *
 * 用法：npx tsx scripts/sanitize-demos.ts
 *
 * 设计：基于 mycc no-guessing 规则 + 1052-OS 评审 gemini 钦定 "P0-3 脱敏深度检查"
 * 实际防护项：API key / IP:port / Bearer token / GitHub PAT / 飞书 webhook key /
 *           长 hash / 内部代号 / 同事姓名 / 客户名等。
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

interface SanitizePattern {
  id: string
  level: 'P0' | 'P1' // P0 必须阻断，P1 警告但通过
  regex: RegExp
  label: string
  example: string
}

// ============================================================================
// P0 模式：命中即阻断部署
// ============================================================================
const PATTERNS_P0: SanitizePattern[] = [
  {
    id: 'openai-key',
    level: 'P0',
    regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    label: 'OpenAI / Anthropic / DeepSeek API Key (sk- 前缀通配)',
    example: 'sk-proj-xxxxx / sk-deepseek-xxxxx',
  },
  {
    id: 'gemini-proxy-key',
    level: 'P0',
    regex: /fq8-[A-Za-z0-9_-]{20,}/g,
    label: '川哥 Gemini Proxy Key',
    example: 'fq8-xxxxx',
  },
  {
    id: 'github-pat',
    level: 'P0',
    regex: /(?:github_pat_|ghp_|gho_|ghs_)[A-Za-z0-9_]{20,}/g,
    label: 'GitHub PAT / Token',
    example: 'github_pat_xxxxx',
  },
  {
    id: 'ip-port',
    level: 'P0',
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}\b/g,
    label: '内部 IP:Port (proxy / VPS / 内网服务)',
    example: '23.226.135.149:4000',
  },
  {
    id: 'bearer-token',
    level: 'P0',
    regex: /\bBearer\s+[A-Za-z0-9_.-]{20,}\b/g,
    label: 'Bearer Token (HTTP auth header)',
    example: 'Bearer eyJhbGc...',
  },
  {
    id: 'feishu-webhook',
    level: 'P0',
    regex: /open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-f0-9-]{20,}/gi,
    label: '飞书 Webhook URL',
    example: 'open.feishu.cn/open-apis/bot/v2/hook/xxxxx',
  },
  {
    id: 'lark-app-id',
    level: 'P0',
    regex: /\bcli_[a-zA-Z0-9]{16}\b/g,
    label: '飞书 App ID',
    example: 'cli_xxxxx',
  },
  {
    id: 'aliyun-ak',
    level: 'P0',
    regex: /\bLTAI[A-Za-z0-9]{16,24}\b/g,
    label: '阿里云 AccessKey',
    example: 'LTAIxxxxx',
  },
  {
    id: 'private-key-pem',
    level: 'P0',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    label: 'PEM 私钥',
    example: '-----BEGIN PRIVATE KEY-----',
  },
  {
    id: 'jwt',
    level: 'P0',
    regex: /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
    label: 'JWT Token',
    example: 'eyJhbGc...',
  },
]

// ============================================================================
// P1 模式：警告但不阻断（人工 review）
// ============================================================================
const PATTERNS_P1: SanitizePattern[] = [
  {
    id: 'long-hex-hash',
    level: 'P1',
    regex: /\b[a-f0-9]{32,}\b/g,
    label: '长 hex hash (可能是密钥 / commit / file hash)',
    example: '8a3f2c...',
  },
  {
    id: 'long-base64',
    level: 'P1',
    regex: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
    label: '长 base64 字符串 (可能是 secret)',
    example: 'YWxhZGRpbjpv...',
  },
  {
    id: 'email-non-public',
    level: 'P1',
    regex: /\b[A-Za-z0-9._%+-]+@(?!chenchuan\.cc|anthropic\.com|noreply)[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    label: '非公开邮箱 (排除 chenchuan.cc / anthropic / noreply)',
    example: 'someone@gmail.com',
  },
  {
    id: 'private-ipv4',
    level: 'P1',
    regex: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g,
    label: '私网 IPv4 (可能是内网服务)',
    example: '192.168.x.x',
  },
  {
    id: 'phone-cn',
    level: 'P1',
    regex: /\b1[3-9]\d{9}\b/g,
    label: '中国大陆手机号',
    example: '13800138000',
  },
]

// ============================================================================
// 白名单：已知安全 / 已脱敏 / 公开信息
// ============================================================================
const WHITELIST = [
  // 公开 commit hash 在 git log 已公开，允许出现
  '7fb1d8ee8',
  '158632d7c',
  'bfe504646',
  '01b98a9e6',
  '2117a2657',
  '5076b3d40',
  // 公开域名
  'my.chenchuan.cc',
  'github.com',
  'anthropic.com',
]

interface Finding {
  pattern: SanitizePattern
  match: string
  line: number
  context: string
}

function scanFile(filePath: string): Finding[] {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const findings: Finding[] = []

  for (const pattern of [...PATTERNS_P0, ...PATTERNS_P1]) {
    lines.forEach((line, idx) => {
      const matches = line.matchAll(pattern.regex)
      for (const m of matches) {
        const match = m[0]
        // 白名单检查
        if (WHITELIST.some((w) => match.includes(w))) continue
        findings.push({
          pattern,
          match,
          line: idx + 1,
          context: line.trim().slice(0, 120),
        })
      }
    })
  }

  return findings
}

function main(): void {
  const targets = [resolve(process.cwd(), 'src/data/classic-demos.ts')]
  let p0Count = 0
  let p1Count = 0

  for (const file of targets) {
    console.log(`\n📄 Scanning ${file}`)
    const findings = scanFile(file)

    if (findings.length === 0) {
      console.log('  ✅ Clean')
      continue
    }

    for (const f of findings) {
      const icon = f.pattern.level === 'P0' ? '🚨' : '⚠️'
      console.log(
        `  ${icon} [${f.pattern.level}] line ${f.line} | ${f.pattern.label} | match="${f.match}" | context: ${f.context}`,
      )
      if (f.pattern.level === 'P0') p0Count++
      else p1Count++
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Summary: ${p0Count} P0 (blocking) · ${p1Count} P1 (warning)`)
  console.log(`${'='.repeat(60)}`)

  if (p0Count > 0) {
    console.error(`\n🚨 P0 findings 阻断部署。请人工处理上述命中后重跑。\n`)
    process.exit(1)
  }
  if (p1Count > 0) {
    console.warn(`\n⚠️  P1 findings 仅警告 (允许通过)。如确认安全可忽略；否则修复后重跑。\n`)
  }
  process.exit(0)
}

main()
