import { useState } from 'react';
import { useKidsHubStore } from './store/kidshub-store';
import { getSharedVoiceClient } from '../services/voice-client';

type InviteStep = 'code' | 'authorize';

export function InviteLoginPage() {
  const setToken = useKidsHubStore((s) => s.setToken);
  const setVariable = useKidsHubStore((s) => s.setVariable);

  const [step, setStep] = useState<InviteStep>('code');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedCode = code.trim();

  const goNext = () => {
    if (!trimmedCode) {
      setError('请输入邀请码');
      return;
    }
    setError(null);
    setStep('authorize');
  };

  const authorize = async () => {
    if (!trimmedCode) {
      setStep('code');
      setError('请输入邀请码');
      return;
    }

    void getSharedVoiceClient().unlockAudio();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: trimmedCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.token) {
        const nickname = typeof data?.account?.nickname === 'string' ? data.account.nickname.trim() : '';
        if (nickname) {
          setVariable('nickname', nickname);
        }
        setToken(data.token as string);
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      if (step === 'code') {
        goNext();
      } else {
        void authorize();
      }
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-950 p-6">
      <div className="w-full max-w-[380px] rounded-2xl border border-white/10 bg-neutral-900 p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="text-2xl font-semibold tracking-tight text-white">KidsHub-AI</div>
          <div className="mt-1 text-sm text-neutral-400">小可 Prompt 体验工作台</div>
        </div>

        {step === 'code' ? (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs text-neutral-400">邀请码</label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={onKeyDown}
                className="w-full rounded-lg border border-white/10 bg-neutral-950 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-sky-500 focus:outline-none"
                placeholder="输入邀请码"
                autoComplete="one-time-code"
              />
            </div>

            {error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={goNext}
              disabled={loading}
              className="mt-2 w-full rounded-lg bg-sky-500 py-2.5 text-sm font-medium text-white transition active:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              下一步
            </button>

            <div className="text-center text-[10px] text-neutral-500">纯前端 mock 微信授权 · 邀请码由服务端校验</div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border border-emerald-400/20 bg-neutral-950 p-5 shadow-xl shadow-emerald-950/20">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-400 text-xl font-semibold text-neutral-950">
                  小
                </div>
                <div>
                  <div className="text-base font-semibold text-white">小可</div>
                  <div className="mt-0.5 text-xs text-neutral-500">微信授权登录</div>
                </div>
              </div>

              <div className="mt-6 text-center">
                <div className="text-lg font-semibold text-white">小可 想获取你的昵称头像</div>
                <div className="mt-2 text-xs leading-5 text-neutral-400">用于创建你的体验身份，进入 KidsHub-AI 工作台。</div>
              </div>

              {error && (
                <div className="mt-5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                  {error}
                </div>
              )}

              <div className="mt-6 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setStep('code')}
                  disabled={loading}
                  className="rounded-lg border border-white/10 bg-neutral-900 py-2.5 text-sm font-medium text-neutral-300 transition active:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void authorize()}
                  disabled={loading}
                  className="rounded-lg bg-emerald-500 py-2.5 text-sm font-medium text-white transition active:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading ? '授权中…' : '授权登录'}
                </button>
              </div>
            </div>

            <div className="text-center text-[10px] text-neutral-500">当前邀请码：{trimmedCode}</div>
          </div>
        )}
      </div>
    </div>
  );
}
