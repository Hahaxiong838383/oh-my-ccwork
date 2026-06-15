import { useState } from 'react';
import { useKidsHubStore } from './store/kidshub-store';
import { getSharedVoiceClient } from '../services/voice-client';

type InviteStep = 'code' | 'authorize' | 'profile';
type ProfileGender = '男孩' | '女孩';
type VariableGender = '男' | '女';

interface ChildProfile {
  nickname: string;
  birthday: string;
  gender: ProfileGender;
}

export function calcAge(ym: string): number {
  const [yearText, monthText] = ym.split('-');
  const birthYear = Number(yearText);
  const birthMonth = Number(monthText);
  if (!Number.isFinite(birthYear) || !Number.isFinite(birthMonth)) return 0;

  const now = new Date();
  let age = now.getFullYear() - birthYear;
  if (now.getMonth() + 1 < birthMonth) age -= 1;
  return Math.max(0, age);
}

function toVariableGender(gender: string): VariableGender {
  return gender === '女孩' ? '女' : '男';
}

function toProfileGender(gender: VariableGender): ProfileGender {
  return gender === '女' ? '女孩' : '男孩';
}

function applyProfileToVariables(profile: ChildProfile, setVariable: (key: string, value: string) => void) {
  setVariable('nickname', profile.nickname);
  setVariable('gender', toVariableGender(profile.gender));
  setVariable('age', String(calcAge(profile.birthday)));
}

function normalizeProfile(value: unknown): ChildProfile | null {
  if (!value || typeof value !== 'object') return null;
  const profile = value as Partial<ChildProfile>;
  if (typeof profile.nickname !== 'string' || typeof profile.birthday !== 'string') return null;
  if (profile.gender !== '男孩' && profile.gender !== '女孩') return null;
  return {
    nickname: profile.nickname,
    birthday: profile.birthday,
    gender: profile.gender,
  };
}

export function InviteLoginPage() {
  const setToken = useKidsHubStore((s) => s.setToken);
  const setVariable = useKidsHubStore((s) => s.setVariable);

  const [step, setStep] = useState<InviteStep>('code');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorizedToken, setAuthorizedToken] = useState<string | null>(null);
  const [profileNickname, setProfileNickname] = useState('');
  const [profileGender, setProfileGender] = useState<VariableGender>('男');
  const [profileBirthday, setProfileBirthday] = useState('');

  const trimmedCode = code.trim();
  const trimmedProfileNickname = profileNickname.trim();

  const goNext = () => {
    if (!trimmedCode) {
      setError('请输入邀请码');
      return;
    }
    setError(null);
    setStep('authorize');
  };

  const fetchProfile = async (token: string): Promise<ChildProfile | null> => {
    const res = await fetch('/api/profile', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('profile_failed');

    const data = await res.json().catch(() => ({}));
    return normalizeProfile(data?.profile);
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
      if (!res.ok || typeof data?.token !== 'string') {
        setError('邀请码无效');
        setStep('code');
        return;
      }

      const token = data.token;
      const profile = await fetchProfile(token);
      if (profile) {
        applyProfileToVariables(profile, setVariable);
        setToken(token);
        return;
      }

      setAuthorizedToken(token);
      setStep('profile');
    } catch {
      setError('网络错误，请检查连接');
      setStep('code');
    } finally {
      setLoading(false);
    }
  };

  const submitProfile = async () => {
    if (!authorizedToken) {
      setError('登录已失效，请重新输入邀请码');
      setStep('code');
      return;
    }
    if (!trimmedProfileNickname) {
      setError('请输入孩子昵称');
      return;
    }
    if (!profileBirthday) {
      setError('请选择孩子出生年月');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const profile: ChildProfile = {
        nickname: trimmedProfileNickname,
        birthday: profileBirthday,
        gender: toProfileGender(profileGender),
      };
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authorizedToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(profile),
      });
      if (!res.ok) {
        setError('保存失败，请稍后重试');
        return;
      }

      applyProfileToVariables(profile, setVariable);
      setToken(authorizedToken);
    } catch {
      setError('网络错误，请检查连接');
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      if (step === 'code') {
        goNext();
      } else if (step === 'authorize') {
        void authorize();
      } else {
        void submitProfile();
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
        ) : step === 'authorize' ? (
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
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border border-sky-400/20 bg-neutral-950 p-5 shadow-xl shadow-sky-950/20">
              <div className="text-center">
                <div className="text-lg font-semibold text-white">完善孩子信息</div>
                <div className="mt-2 text-xs leading-5 text-neutral-400">这份档案会同步到家长端和 KidsHub-AI。</div>
              </div>

              <div className="mt-5 space-y-4">
                <div>
                  <label className="mb-1 block text-xs text-neutral-400">孩子昵称</label>
                  <input
                    type="text"
                    value={profileNickname}
                    onChange={(e) => setProfileNickname(e.target.value)}
                    onKeyDown={onKeyDown}
                    className="w-full rounded-lg border border-white/10 bg-neutral-900 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-sky-500 focus:outline-none"
                    placeholder="例如：小可"
                    autoComplete="off"
                  />
                </div>

                <div>
                  <div className="mb-2 block text-xs text-neutral-400">性别</div>
                  <div className="grid grid-cols-2 gap-3">
                    {(['男', '女'] as const).map((gender) => (
                      <button
                        key={gender}
                        type="button"
                        onClick={() => setProfileGender(gender)}
                        disabled={loading}
                        className={
                          profileGender === gender
                            ? 'rounded-lg bg-sky-500 py-2.5 text-sm font-medium text-white transition active:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60'
                            : 'rounded-lg border border-white/10 bg-neutral-900 py-2.5 text-sm font-medium text-neutral-300 transition active:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60'
                        }
                      >
                        {gender}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs text-neutral-400">出生年月</label>
                  <input
                    type="month"
                    value={profileBirthday}
                    onChange={(e) => setProfileBirthday(e.target.value)}
                    onKeyDown={onKeyDown}
                    className="w-full rounded-lg border border-white/10 bg-neutral-900 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-sky-500 focus:outline-none"
                  />
                </div>
              </div>

              {error && (
                <div className="mt-5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                  {error}
                </div>
              )}

              <button
                type="button"
                onClick={() => void submitProfile()}
                disabled={loading}
                className="mt-6 w-full rounded-lg bg-sky-500 py-2.5 text-sm font-medium text-white transition active:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? '保存中…' : '确认'}
              </button>
            </div>

            <div className="text-center text-[10px] text-neutral-500">当前邀请码：{trimmedCode}</div>
          </div>
        )}
      </div>
    </div>
  );
}
