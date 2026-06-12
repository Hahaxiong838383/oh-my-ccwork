import { useEffect, useState } from 'react';
import { useKidsHubStore } from './store/kidshub-store';
import { LoginPage } from './LoginPage';
import { StudioPage } from './StudioPage';

/**
 * KidsHub-AI · 小可 Prompt 体验工作台 入口
 *
 * 路由：/kidshub-ai（main.tsx 按 pathname 分流，原 demo 在 / 不受影响）
 * 登录后进入三栏工作台：场景导航 / 设备画布+调试流 / Prompt 工作区
 */
// 个人站公开部署（VITE_KIDSHUB_PUBLIC=1）：作品展示模式，无登录门，
// 滥用防护在 server 侧 per-IP 日限额兜底（guard.ts）
const isPublicMode = import.meta.env.VITE_KIDSHUB_PUBLIC === '1';

export function KidsHubApp() {
  const token = useKidsHubStore((s) => s.token);
  const setToken = useKidsHubStore((s) => s.setToken);
  const [checking, setChecking] = useState(true);

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
    return <LoginPage />;
  }

  return <StudioPage />;
}
