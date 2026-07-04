import type { NextConfig } from 'next'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  // output: 'standalone' 移除：与 `next start`（PM2 启动方式）不兼容，
  // 会导致 middleware 静默失效（访问统计 + admin 路由保护都不工作）。
  // VPS 部署不需要 standalone 包压缩（node_modules 直接装在 /var/www/chenchuan-site）。
  outputFileTracingRoot: projectRoot,
  outputFileTracingIncludes: {
    '/media/[...path]': ['./media/**/*', './public/media/**/*'],
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },
  env: {
    DIRECTUS_URL: process.env.DIRECTUS_URL || 'http://localhost:8055',
  },
}

export default nextConfig
