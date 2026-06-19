import { useEffect, useState } from 'react';
import { useKidsHubStore } from '../kidshub/store/kidshub-store';
import { applyProfileToVariables, normalizeProfile } from '../kidshub/InviteLoginPage';
import { MobileLogin } from './MobileLogin';
import { MobileMain } from './MobileMain';

/**
 * 移动端 App 入口（/m 路由）—— 复刻 KidsHubApp 的登录门控：
 * 无 token → 邀请码登录；有 token → 校验 + 回源 profile → 主界面。
 * 公开模式（VITE_KIDSHUB_PUBLIC=1）跳过登录门（与体验台一致）。
 */
const isPublicMode = import.meta.env.VITE_KIDSHUB_PUBLIC === '1';

export function MobileApp() {
  const token = useKidsHubStore((s) => s.token);
  const setToken = useKidsHubStore((s) => s.setToken);
  const setVariable = useKidsHubStore((s) => s.setVariable);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (isPublicMode || !token) {
      setChecking(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/profile', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!cancelled) {
          if (!res.ok) {
            setToken(null); // JWT 失效 → 回登录
          } else {
            const data = await res.json().catch(() => ({}));
            const profile = normalizeProfile(data?.profile);
            if (profile) applyProfileToVariables(profile, setVariable);
          }
        }
      } catch {
        // 网络问题保守保留 token（下次操作再失败）
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, setToken, setVariable]);

  if (checking) {
    return (
      <div
        className="flex min-h-[100dvh] items-center justify-center text-[15px] tracking-tight text-slate-400"
        style={{ background: 'linear-gradient(180deg, #f8fafc 0%, #eff6ff 100%)' }}
      >
        正在唤醒小可…
      </div>
    );
  }

  if (!isPublicMode && !token) return <MobileLogin />;
  return <MobileMain />;
}
