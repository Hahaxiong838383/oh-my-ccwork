import { useEffect, useState } from 'react';
import { useKidsHubStore } from '../kidshub/store/kidshub-store';
import { applyProfileToVariables, normalizeProfile } from '../kidshub/InviteLoginPage';
import { MobileLogin } from './MobileLogin';
import { MobileMain } from './MobileMain';

/**
 * 移动端 App 入口（/m 路由）—— 始终走邀请码登录门（需求3）：
 * 无 token → 邀请码登录；有 token → 校验 + 回源 profile → 主界面。
 * 注意：/m 不跟体验台的 VITE_KIDSHUB_PUBLIC 公开模式——孩子端 App 始终要登录，
 * 解耦后体验台公开与否都不影响 /m 的登录门。
 */
export function MobileApp() {
  const token = useKidsHubStore((s) => s.token);
  const setToken = useKidsHubStore((s) => s.setToken);
  const setVariable = useKidsHubStore((s) => s.setVariable);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!token) {
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
        className="fixed inset-0 flex items-center justify-center text-[15px] tracking-tight text-slate-400"
        style={{ background: 'linear-gradient(180deg, #f8fafc 0%, #eff6ff 100%)' }}
      >
        正在唤醒小可…
      </div>
    );
  }

  if (!token) return <MobileLogin />;
  return <MobileMain />;
}
