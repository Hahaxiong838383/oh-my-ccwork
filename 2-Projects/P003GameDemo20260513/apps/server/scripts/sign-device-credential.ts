/**
 * 签发 P003 设备凭据（device credential JWT）——服务器上跑，读生产 AUTH_JWT_SECRET。
 *
 * 用法（在 /opt/p003/server 下）：
 *   npx tsx scripts/sign-device-credential.ts <MCU_SN> [有效天数=30]
 *
 * 输出：凭据 JWT 打到 stdout（仅此一行，便于管道直送目标文件，不落中间盘）。
 * ⚠️ 输出即凭据本体：禁止进 git / 聊天 / 日志，管道接走后立即离开屏幕。
 */
import { SignJWT } from 'jose';
import { validateDeviceSn } from '../src/device-sn.js';

const sn = process.argv[2];
const days = Number(process.argv[3] || 30);
const secret = process.env.AUTH_JWT_SECRET;

if (!secret) {
  console.error('AUTH_JWT_SECRET 未设置（用 env $(grep AUTH_JWT_SECRET .env.local) 方式注入）');
  process.exit(1);
}
const check = validateDeviceSn(sn);
if (!check.ok) {
  console.error(`SN 不合法: ${'reason' in check ? check.reason : ''}`);
  process.exit(1);
}

const jwt = await new SignJWT({ kind: 'p003-device' })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(sn!)
  .setIssuedAt()
  .setExpirationTime(`${days}d`)
  .sign(new TextEncoder().encode(secret));

process.stdout.write(jwt + '\n');
