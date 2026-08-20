// 家长端登录门（小程序暖橙风）：
//  - 手机号 + 短信验证码（默认主路径，2026-08-20，阿里云托管核验）→ /api/auth/sms/send + /sms/verify
//  - 邀请码登录（内测通道保留，两步：输码 → 仿微信授权）→ /api/auth/invite
// 两种方式发的 JWT 同 secret 同姿势，成功都存 sessionStorage 'parent.token' → 进主界面。

import { useEffect, useRef, useState } from 'react';
import { StatusBar } from '../components/chrome';

const TOKEN_KEY = 'parent.token';
const CODE_KEY = 'parent.invite_code'; // 记住上次邀请码(localStorage),内测免反复输
const PHONE_KEY = 'parent.phone'; // 记住上次手机号,回访免重输

function BrandHeader() {
  return (
    <div className="mb-8 text-center">
      <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-brand-orange text-3xl font-bold text-white">
        小
      </div>
      <h1 className="text-2xl font-black text-text-main">KidsHub 家长端</h1>
      <p className="mt-1.5 text-sm text-text-muted">小可 · 孩子的阅读伙伴</p>
    </div>
  );
}

function PhoneLogin({ onLogin }: { onLogin: () => void }) {
  const [phone, setPhone] = useState(() => localStorage.getItem(PHONE_KEY) ?? '');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, []);

  const phoneOk = /^1[3-9]\d{9}$/.test(phone.trim());
  const codeOk = /^\d{4,8}$/.test(code.trim());

  const startCountdown = (seconds: number) => {
    setCountdown(seconds);
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setCountdown((s) => {
        if (s <= 1 && timerRef.current !== null) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return s <= 1 ? 0 : s - 1;
      });
    }, 1000);
  };

  const sendCode = async () => {
    if (!phoneOk) {
      setError('请输入正确的手机号');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/sms/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; retry_after_s?: number };
      if (res.ok && data.ok) {
        startCountdown(60);
      } else if (res.status === 429) {
        setError(data.message ?? '发送太频繁，请稍后再试');
        startCountdown(Math.min(data.retry_after_s ?? 60, 60));
      } else {
        setError(data.message ?? '发送失败，请稍后再试');
      }
    } catch {
      setError('网络错误，请检查连接');
    } finally {
      setSending(false);
    }
  };

  const verify = async () => {
    if (!phoneOk || !codeOk) {
      setError(!phoneOk ? '请输入正确的手机号' : '请输入短信验证码');
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/sms/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), code: code.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; token?: string; message?: string };
      if (res.ok && data.ok && data.token) {
        sessionStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(PHONE_KEY, phone.trim());
        onLogin();
      } else {
        setError(data.message ?? '验证码错误或已过期');
      }
    } catch {
      setError('网络错误，请检查连接');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-4 rounded-2xl bg-white p-5 shadow-card">
        <div>
          <label className="mb-2 block text-sm font-semibold text-text-main">手机号</label>
          <input
            autoComplete="tel"
            className="h-12 w-full rounded-xl bg-page-bg px-4 text-sm text-text-main outline-none placeholder:text-text-muted"
            inputMode="numeric"
            maxLength={11}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
            placeholder="请输入手机号"
            value={phone}
          />
        </div>
        <div>
          <label className="mb-2 block text-sm font-semibold text-text-main">短信验证码</label>
          <div className="flex gap-2.5">
            <input
              autoComplete="one-time-code"
              className="h-12 min-w-0 flex-1 rounded-xl bg-page-bg px-4 text-sm text-text-main outline-none placeholder:text-text-muted"
              inputMode="numeric"
              maxLength={8}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && void verify()}
              placeholder="6 位验证码"
              value={code}
            />
            <button
              className="h-12 shrink-0 rounded-xl bg-brand-orange px-4 text-sm font-bold text-white disabled:bg-page-bg disabled:text-text-muted"
              disabled={sending || countdown > 0 || !phoneOk}
              onClick={() => void sendCode()}
              type="button"
            >
              {countdown > 0 ? `${countdown}s 后重发` : sending ? '发送中…' : '获取验证码'}
            </button>
          </div>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
      <button
        className="h-12 w-full rounded-full bg-brand-orange font-bold text-white shadow-card disabled:opacity-60"
        disabled={verifying}
        onClick={() => void verify()}
        type="button"
      >
        {verifying ? '登录中…' : '登录 / 注册'}
      </button>
      <p className="text-center text-xs text-text-muted">未注册的手机号验证后自动创建账号</p>
    </div>
  );
}

function InviteLogin({ onLogin }: { onLogin: () => void }) {
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

  if (step === 'code') {
    return (
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
    );
  }

  return (
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
  );
}

export default function InviteLoginPage({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<'phone' | 'invite'>('phone');

  return (
    <div className="flex h-full flex-col bg-page-bg">
      <StatusBar />
      <div className="flex flex-1 flex-col justify-center px-7 pb-24">
        <BrandHeader />
        {mode === 'phone' ? <PhoneLogin onLogin={onLogin} /> : <InviteLogin onLogin={onLogin} />}
        <button
          className="mt-6 text-center text-xs font-semibold text-brand-orange"
          onClick={() => setMode((m) => (m === 'phone' ? 'invite' : 'phone'))}
          type="button"
        >
          {mode === 'phone' ? '使用邀请码登录' : '使用手机号登录'}
        </button>
      </div>
    </div>
  );
}
