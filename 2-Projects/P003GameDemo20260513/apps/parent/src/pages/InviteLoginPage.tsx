// 家长端邀请码登录门（小程序暖橙风，两步：输码 → 仿微信授权）
// 校验走后端 /api/auth/invite，成功存 token 到 sessionStorage 'parent.token' → 进主界面。

import { useState } from 'react';
import { StatusBar } from '../components/chrome';

const TOKEN_KEY = 'parent.token';
const CODE_KEY = 'parent.invite_code'; // 记住上次邀请码(localStorage),内测免反复输

export default function InviteLoginPage({ onLogin }: { onLogin: () => void }) {
  const [step, setStep] = useState<'code' | 'authorize'>('code');
  const [code, setCode] = useState(() => localStorage.getItem(CODE_KEY) ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = code.trim();

  const goNext = () => {
    if (!trimmed) {
      setError('请输入邀请码');
      return;
    }
    setError(null);
    setStep('authorize');
  };

  const authorize = async () => {
    if (!trimmed) {
      setStep('code');
      setError('请输入邀请码');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as { token?: string };
      if (res.ok && data.token) {
        sessionStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(CODE_KEY, trimmed); // 记住邀请码,下次自动填充
        onLogin();
      } else {
        setError('邀请码无效');
        setStep('code');
      }
    } catch {
      setError('网络错误，请检查连接');
      setStep('code');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-page-bg">
      <StatusBar />
      <div className="flex flex-1 flex-col justify-center px-7 pb-24">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-brand-orange text-3xl font-bold text-white">
            小
          </div>
          <h1 className="text-2xl font-black text-text-main">KidsHub 家长端</h1>
          <p className="mt-1.5 text-sm text-text-muted">小可 · 孩子的阅读伙伴</p>
        </div>

        {step === 'code' ? (
          <div className="space-y-4">
            <div className="rounded-2xl bg-white p-5 shadow-card">
              <label className="mb-2 block text-sm font-semibold text-text-main">邀请码</label>
              <input
                autoComplete="one-time-code"
                className="h-12 w-full rounded-xl bg-page-bg px-4 text-sm text-text-main outline-none placeholder:text-text-muted"
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && goNext()}
                placeholder="输入邀请码（如 KH-9K2M）"
                value={code}
              />
              {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
            </div>
            <button
              className="h-12 w-full rounded-full bg-brand-orange font-bold text-white shadow-card"
              onClick={goNext}
              type="button"
            >
              下一步
            </button>
            <p className="text-center text-xs text-text-muted">邀请码由服务端校验 · 模拟微信授权</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl bg-white p-5 shadow-card">
              <div className="flex items-center gap-3">
                <div className="grid h-12 w-12 place-items-center rounded-xl bg-brand-orange text-xl font-bold text-white">
                  小
                </div>
                <div>
                  <div className="font-bold text-text-main">小可</div>
                  <div className="text-xs text-text-muted">微信授权登录</div>
                </div>
              </div>
              <div className="mt-5 text-center">
                <p className="font-bold text-text-main">「小可」想获取你的昵称头像</p>
                <p className="mt-2 text-xs leading-5 text-text-muted">用于创建你的家长身份，进入 KidsHub 家长端。</p>
              </div>
              {error && <p className="mt-4 text-center text-xs text-red-500">{error}</p>}
              <div className="mt-6 grid grid-cols-2 gap-3">
                <button
                  className="h-11 rounded-full bg-page-bg font-semibold text-text-muted disabled:opacity-60"
                  disabled={loading}
                  onClick={() => setStep('code')}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="h-11 rounded-full bg-brand-orange font-bold text-white disabled:opacity-60"
                  disabled={loading}
                  onClick={() => void authorize()}
                  type="button"
                >
                  {loading ? '授权中…' : '授权登录'}
                </button>
              </div>
            </div>
            <p className="text-center text-xs text-text-muted">当前邀请码：{trimmed}</p>
          </div>
        )}
      </div>
    </div>
  );
}
