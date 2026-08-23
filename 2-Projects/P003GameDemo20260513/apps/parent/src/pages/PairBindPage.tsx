// 配网绑定页（SoftAP 两阶段的阶段 B 落点，联调合同 v4 + codex 开工 prompt 2026-08-22）。
// 入口：设备屏 URL 二维码 → #/pair?v=2&sn=<SN>&nonce=<b64url>&pk=<b64url>。
// 职责：校验参数 → 确认绑定（confirm 固定三元组）→ 轮询设备 claim 进度。
// 红线：本页不读取/不上传/不保存家庭 WiFi；不调用 Web Bluetooth。
import { useEffect, useRef, useState } from 'react';
import { confirmPairing, getPairingStatus, type PairingState } from '../api';

export type PairParams = { v: string; sn: string; nonce: string; pk: string };

/** 从 hash 解析配网参数；形状不符返回 null（页面显示「二维码无效」）。 */
export function parsePairHash(hash: string): PairParams | null {
  const m = /^#\/pair\?(.+)$/.exec(hash);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const p = { v: q.get('v') ?? '', sn: (q.get('sn') ?? '').toUpperCase(), nonce: q.get('nonce') ?? '', pk: q.get('pk') ?? '' };
  if (!p.sn || !p.nonce || !p.pk) return null;
  return p;
}

const maskSn = (sn: string) => (sn.length >= 8 ? `${sn.slice(0, 6)}****${sn.slice(-4)}` : sn);

type Phase = 'confirm' | 'waiting' | 'bound' | 'initializing' | 'expired' | 'error';

export default function PairBindPage({ params, onDone }: { params: PairParams; onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>('confirm');
  const [errMsg, setErrMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const versionOk = params.v === '2';

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  async function poll() {
    const sid = sessionRef.current;
    if (!sid) return;
    try {
      const r = await getPairingStatus(sid);
      const state: PairingState | undefined = r.state;
      if (state === 'bound') { setPhase('bound'); return; }
      if (state === 'initializing') { setPhase('initializing'); timerRef.current = setTimeout(poll, 3000); return; }
      if (state === 'expired') { setPhase('expired'); return; }
    } catch {
      /* 网络抖动继续轮询 */
    }
    timerRef.current = setTimeout(poll, 2000);
  }

  async function onConfirm() {
    if (busy) return;
    setBusy(true);
    setErrMsg('');
    try {
      const r = await confirmPairing(params.sn, params.nonce, params.pk);
      if (r.ok && r.session_id) {
        sessionRef.current = r.session_id;
        setPhase('waiting');
        timerRef.current = setTimeout(poll, 2000);
      } else if (r.error === 'invalid_pk' || r.error === 'bad_request') {
        setPhase('error');
        setErrMsg('二维码无效或已损坏，请在设备上点「重新生成」后再扫一次');
      } else {
        setErrMsg('绑定请求失败，请重试');
      }
    } catch {
      setErrMsg('网络异常，请检查手机网络后重试');
    }
    setBusy(false);
  }

  return (
    <div className="flex h-full flex-col bg-page-bg px-5 pt-14">
      <div className="mb-6 text-center text-xl font-bold text-text-main">绑定设备</div>

      {!versionOk || phase === 'error' ? (
        <CenterCard emoji="⚠️" title={!versionOk ? '二维码版本不支持' : '二维码无效'}
          desc={!versionOk ? '请先在设备上完成系统更新，再重新生成二维码' : errMsg || '请在设备上重新生成二维码后再试'} />
      ) : phase === 'confirm' ? (
        <div className="rounded-2xl bg-white p-5 shadow-card">
          <div className="mb-1 text-sm text-text-muted">即将绑定的设备</div>
          <div className="mb-4 font-mono text-lg font-bold text-text-main">{maskSn(params.sn)}</div>
          <div className="mb-5 text-sm leading-6 text-text-muted">
            确认后，这台设备将绑定到你当前登录的账号，孩子的档案与记忆将随设备使用逐步建立。
          </div>
          {errMsg && <div className="mb-3 text-sm text-red-500">{errMsg}</div>}
          <button type="button" disabled={busy} onClick={onConfirm}
            className="h-12 w-full rounded-2xl bg-brand-orange font-bold text-white shadow-card disabled:opacity-50">
            {busy ? '提交中…' : '确认绑定'}
          </button>
        </div>
      ) : phase === 'waiting' ? (
        <CenterCard emoji="📶" title="等待设备连接…"
          desc="设备正在完成绑定，请保持设备开机联网。此过程通常在几秒内完成" spinning />
      ) : phase === 'initializing' ? (
        <CenterCard emoji="🧠" title="设备已连接" desc="个性化服务初始化中，稍等片刻即可使用" spinning />
      ) : phase === 'expired' ? (
        <CenterCard emoji="⏰" title="二维码已过期" desc="请在设备上点「重新生成」，然后重新扫码" />
      ) : (
        <div className="flex flex-col items-center pt-8">
          <div className="mb-3 text-5xl">🎉</div>
          <div className="mb-1 text-lg font-bold text-text-main">绑定成功</div>
          <div className="mb-8 text-sm text-text-muted">设备 {maskSn(params.sn)} 已加入你的账号</div>
          <button type="button" onClick={onDone}
            className="h-12 w-full rounded-2xl bg-brand-orange font-bold text-white shadow-card">开始使用</button>
        </div>
      )}
    </div>
  );
}

function CenterCard({ emoji, title, desc, spinning }: { emoji: string; title: string; desc: string; spinning?: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-2xl bg-white px-6 py-10 shadow-card">
      <div className={`mb-3 text-5xl ${spinning ? 'animate-pulse' : ''}`}>{emoji}</div>
      <div className="mb-2 text-lg font-bold text-text-main">{title}</div>
      <div className="text-center text-sm leading-6 text-text-muted">{desc}</div>
    </div>
  );
}
