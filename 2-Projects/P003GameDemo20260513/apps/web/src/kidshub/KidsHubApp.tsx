import { useEffect, useState } from 'react';
import { useKidsHubStore } from './store/kidshub-store';
import { LoginPage } from './LoginPage';
import { InviteLoginPage } from './InviteLoginPage';
import { StudioPage } from './StudioPage';
import { getSharedVoiceClient } from '../services/voice-client';

/**
 * KidsHub-AI · 小可 Prompt 体验工作台 入口
 *
 * 路由：/kidshub-ai（main.tsx 按 pathname 分流，原 demo 在 / 不受影响）
 * 登录后进入三栏工作台：场景导航 / 设备画布+调试流 / Prompt 工作区
 */
// 个人站公开部署（VITE_KIDSHUB_PUBLIC=1）：作品展示模式，无登录门，
// 滥用防护在 server 侧 per-IP 日限额兜底（guard.ts）
const isPublicMode = import.meta.env.VITE_KIDSHUB_PUBLIC === '1';
const INVITE_LOGIN = import.meta.env.VITE_ENABLE_INVITE_LOGIN === '1';

export function KidsHubApp() {
  const token = useKidsHubStore((s) => s.token);
  const setToken = useKidsHubStore((s) => s.setToken);
  const [checking, setChecking] = useState(true);
  const [publicStarted, setPublicStarted] = useState(!isPublicMode);

  // 启动时校验已有 token（公开模式跳过）
  useEffect(() => {
    if (isPublicMode) {
      setChecking(false);
      return;
    }
    const t = token;
    if (!t) {
      setChecking(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/auth/check?token=${encodeURIComponent(t)}`);
        const data = await res.json().catch(() => ({}));
        if (!cancelled) {
          if (!res.ok || !data?.ok) {
            // token 失效
            setToken(null);
          }
        }
      } catch {
        // 网络问题时保守保留（下次操作会再失败）
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, setToken]);

  if (checking) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-400">
        正在校验登录状态…
      </div>
    );
  }

  if (!isPublicMode && !token) {
    const LoginComponent = INVITE_LOGIN ? InviteLoginPage : LoginPage;
    return <LoginComponent />;
  }

  const handlePublicStart = () => {
    // 公开版没有登录按钮，必须在这个真实点击栈里同步解锁 AudioContext。不 await。
    void getSharedVoiceClient().unlockAudio();
    setPublicStarted(true);
  };

  return (
    <div className="relative min-h-screen">
      <StudioPage autoStartTutorial={publicStarted} />
      {isPublicMode && !publicStarted ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/90 px-6 backdrop-blur-sm">
          <div className="max-w-sm text-center">
            <div className="text-sm font-medium tracking-[0.2em] text-sky-200/80">KIDSHUB-AI</div>
            <h1 className="mt-4 text-2xl font-semibold text-white">和小可开始对话</h1>
            <button
              type="button"
              onClick={handlePublicStart}
              className="mt-7 inline-flex items-center gap-3 rounded-full bg-sky-400 px-6 py-3 text-base font-semibold text-neutral-950 shadow-lg shadow-sky-500/20 transition hover:bg-sky-300 focus:outline-none focus:ring-2 focus:ring-sky-200 focus:ring-offset-2 focus:ring-offset-neutral-950"
            >
              <span aria-hidden="true">▶</span>
              <span>开始和小可对话</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
