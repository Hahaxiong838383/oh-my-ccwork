/**
 * Worker 通行证签发（brain_token 分发取消后的唯一签发口，2026-08-20）。
 *
 * 用途：rust worker 调 device brain（/v1/chat/completions?token=…）的进程级通行证。
 * 语义：只需通过 verifyAuthToken——设备房（sn-）身份由 SN 反查覆盖，非设备房 role=device
 * 直接匿名（resolveDeviceIdentity 收紧），故 token 里的 accountId 永远不会成为记忆归属。
 *
 * 何时用：worker env 里 LLM_URL_QUERY 的 token 到期前续签（365d；上一枚 2026-08-17 签，
 * 2027-08-17 前后过期——过期后 worker 调大脑静默降级为匿名纯人设，记忆全失但不报错，
 * 提前续）。签出后更新 64.90 /root/rust-worker/rust-worker.env 的 LLM_URL_QUERY 并纪律重启。
 *
 * 跑法（服务器上）：cd /opt/p003/server && set -a; . ./.env.local; set +a; npx tsx scripts/sign-worker-token.ts
 * 输出即 token——管道接走，禁回显进聊天/git。
 */
import { SignJWT } from 'jose';

const secret = process.env.AUTH_JWT_SECRET;
if (!secret) {
  console.error('AUTH_JWT_SECRET 未配置（先 source .env.local）');
  process.exit(1);
}

const token = await new SignJWT({ accountId: 'worker-service', role: 'device' })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setIssuer('p003')
  .setAudience('kidshub')
  .setExpirationTime('365d')
  .sign(new TextEncoder().encode(secret));
process.stdout.write(token + '\n');
