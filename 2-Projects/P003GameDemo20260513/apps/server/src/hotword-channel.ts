/**
 * aliyun-hk → 64.90 热词发布通道（第二把 forced-command key，与 worker-stats 只读通道分离）。
 * authorized_keys 的 command= 锁死 /root/rust-worker/apply_hotwords.py，本侧传什么命令都被忽略，
 * 载荷只走 stdin 单行 JSON。apply 含重启+健康自检+可能的自动回滚，全程可达 ~70s，超时给 150s。
 */
import { spawn } from 'node:child_process';

const KEY_PATH = process.env.HOTWORD_APPLY_KEY || '/root/.ssh/hotword-apply-key';
const TARGET = process.env.HOTWORD_APPLY_TARGET || 'root@64.90.13.117';

export interface ChannelResult {
  ok: boolean;
  [k: string]: unknown;
}

export async function callHotwordChannel(payload: object, timeoutMs: number): Promise<ChannelResult> {
  // 测试注入点：单测不真连 64.90（生产不设此 env 即走真实通道）。
  // 值为 JSON：{"<action>": <回执>}，按请求 action 取；无对应键回 ok:false。
  const mock = process.env.HOTWORD_CHANNEL_MOCK;
  if (mock) {
    try {
      const table = JSON.parse(mock) as Record<string, ChannelResult>;
      const action = (payload as { action?: string }).action ?? '';
      return table[action] ?? { ok: false, error: `mock 无 ${action} 回执` };
    } catch {
      return { ok: false, error: 'HOTWORD_CHANNEL_MOCK 不是合法 JSON' };
    }
  }
  return new Promise((resolve) => {
    const child = spawn(
      'ssh',
      ['-i', KEY_PATH, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', TARGET, 'apply'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: `通道超时(${timeoutMs}ms)` });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `ssh 启动失败: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!out.trim()) {
        resolve({ ok: false, error: `通道无回执(exit=${code}) ${err.slice(0, 200)}` });
        return;
      }
      try {
        resolve(JSON.parse(out.trim()) as ChannelResult);
      } catch {
        resolve({ ok: false, error: `回执不是 JSON: ${out.slice(0, 200)}` });
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}
