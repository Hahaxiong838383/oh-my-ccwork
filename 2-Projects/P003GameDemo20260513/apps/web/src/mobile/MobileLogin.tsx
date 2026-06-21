import { useState } from 'react';
import { useKidsHubStore } from '../kidshub/store/kidshub-store';
import { getSharedVoiceClient } from '../services/voice-client';
import { applyProfileToVariables, normalizeProfile } from '../kidshub/InviteLoginPage';

/**
 * 移动端邀请码登录 —— 复用体验台登录 API（POST /api/auth/invite、/api/profile）。
 * docs/36：登录后【不再让用户手填档案】——已建档则回源 profile 让小可认得；没建档直接进小可界面，
 * 由小可在实时对话里主动引导采集昵称/性别/生日（onboarding，对话为主；家长端 parent 保留表单作兜底）。
 * 登录点击在手势栈内解锁 AudioContext（首次 TTS 不哑，见记忆 audiocontext_gesture_unlock）。
 */
const inputClass =
  'w-full rounded-xl border border-slate-200 bg-white/80 px-4 py-3 text-[16px] text-slate-800 placeholder:text-slate-400 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100';

export function MobileLogin() {
  const setToken = useKidsHubStore((s) => s.setToken);
  const setVariable = useKidsHubStore((s) => s.setVariable);

  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProfile = async (token: string) => {
    const res = await fetch('/api/profile', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('profile_failed');
    const data = await res.json().catch(() => ({}));
    return normalizeProfile(data?.profile);
  };

  const authorize = async () => {
    const c = code.trim();
    if (!c) {
      setError('请输入邀请码');
      return;
    }
    // 手势栈内同步解锁音频（不 await，await 会脱离手势栈）
    void getSharedVoiceClient().unlockAudio();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: c }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data?.token !== 'string') {
        setError('邀请码不太对，再确认一下～');
        return;
      }
      const token = data.token;
      // 已建档 → 回源 profile 让小可认得；没建档 → 直接进小可界面，由小可对话引导采集（onboarding，不再手填）。
      const profile = await fetchProfile(token).catch(() => null);
      if (profile) applyProfileToVariables(profile, setVariable);
      setToken(token);
    } catch {
      setError('网络好像不太好，待会再试试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 flex flex-col justify-center overflow-y-auto px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2rem,env(safe-area-inset-top))]"
      style={{ background: 'linear-gradient(180deg, #f8fafc 0%, #ffffff 45%, #eff6ff 100%)' }}
    >
      <div className="mx-auto w-full max-w-[380px]">
        <div className="mb-8 text-center">
          <div className="text-[13px] font-semibold uppercase tracking-[0.22em] text-sky-500/80">
            KidsHub-AI
          </div>
          <h1 className="mt-3 text-[26px] font-semibold tracking-tight text-slate-800">
            和小可见个面
          </h1>
        </div>

        {/* liquid glass 卡片：内高光边 + 扩散阴影（taste 禁 neon glow） */}
        <div className="rounded-[2rem] border border-white/60 bg-white/70 p-6 shadow-[0_20px_40px_-15px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.7)] backdrop-blur-xl">
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <label htmlFor="invite-code" className="text-[13px] font-medium text-slate-500">
                邀请码
              </label>
              <input
                id="invite-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !loading && void authorize()}
                className={inputClass}
                placeholder="输入你的邀请码"
                autoComplete="one-time-code"
                inputMode="text"
              />
              {error && <p className="text-[13px] text-rose-500">{error}</p>}
            </div>
            <PrimaryButton loading={loading} onClick={() => void authorize()}>
              {loading ? '正在进入…' : '开始'}
            </PrimaryButton>
            <p className="text-center text-[12px] text-slate-400">邀请码由小可团队发放</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function PrimaryButton({
  loading,
  onClick,
  children,
}: {
  loading: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="w-full rounded-xl bg-sky-500 py-3.5 text-[16px] font-semibold text-white shadow-[0_12px_28px_-10px_rgba(14,165,233,0.55)] transition active:scale-[0.98] disabled:opacity-60"
    >
      {children}
    </button>
  );
}
