import { useState } from 'react';
import { useKidsHubStore } from './store/kidshub-store';

export function LoginPage() {
  const setToken = useKidsHubStore((s) => s.setToken);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doLogin = async () => {
    if (!username.trim() || !password.trim()) {
      setError('请输入账号和密码');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok && data?.token) {
        setToken(data.token as string);
      } else if (res.status === 429) {
        setError('请求太频繁，请稍后再试');
      } else {
        setError((data && (data.error || data.message)) || '登录失败');
      }
    } catch (e) {
      setError('网络错误，请检查连接');
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      void doLogin();
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-950 p-6">
      <div className="w-full max-w-[360px] rounded-2xl border border-white/10 bg-neutral-900 p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="text-2xl font-semibold tracking-tight text-white">KidsHub-AI</div>
          <div className="mt-1 text-sm text-neutral-400">小可 Prompt 体验工作台</div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs text-neutral-400">账号</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={onKeyDown}
              className="w-full rounded-lg border border-white/10 bg-neutral-950 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-sky-500 focus:outline-none"
              placeholder="输入用户名"
              autoComplete="username"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-400">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={onKeyDown}
              className="w-full rounded-lg border border-white/10 bg-neutral-950 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-sky-500 focus:outline-none"
              placeholder="输入密码"
              autoComplete="current-password"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}

          <button
            onClick={() => void doLogin()}
            disabled={loading}
            className="mt-2 w-full rounded-lg bg-sky-500 py-2.5 text-sm font-medium text-white transition active:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? '登录中…' : '登录'}
          </button>

          <div className="text-center text-[10px] text-neutral-500">
            仅用于内部 Prompt 调试 · 凭证由服务端校验
          </div>
        </div>
      </div>
    </div>
  );
}
