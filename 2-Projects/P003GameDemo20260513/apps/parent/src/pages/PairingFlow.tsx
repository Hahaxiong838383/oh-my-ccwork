// 设备配网流程（模拟微信小程序 BLE + WiFi 配网旅程）
// 还原原型设计稿《小程序配网&设备绑定》：添加设备 → 搜索 → 连接设备 → 选 Wi-Fi → 连接网络 → 成功
// loading 态自动流转（setTimeout），交互态手动推进。纯前端 mock，无真实蓝牙/网络。

import { useEffect, useRef, useState } from 'react';
import { FlowNav } from '../components/chrome';
import { pairingDevice } from '../mock/data';
import ProfileSheet, { type ProfileData } from './ProfileSheet';
import { bindDevice, saveProfile } from '../api';

type Step =
  | 'entry'
  | 'searching'
  | 'found'
  | 'connecting'
  | 'connected'
  | 'wifi'
  | 'netConnecting'
  | 'netDone';

const titleMap: Partial<Record<Step, string>> = {
  searching: '添加设备',
  found: '添加设备',
  connecting: '添加设备',
  connected: '添加设备',
  wifi: '网络连接',
  netConnecting: '连接WiFi',
  netDone: '连接WiFi',
};

const autoNext: Partial<Record<Step, Step>> = {
  searching: 'found',
  connecting: 'connected',
  connected: 'wifi',
  netConnecting: 'netDone',
};

const autoDelay: Partial<Record<Step, number>> = {
  searching: 2000,
  connecting: 1600,
  connected: 1100,
  netConnecting: 5000,
};

const backMap: Partial<Record<Step, Step>> = {
  searching: 'entry',
  found: 'entry',
  connecting: 'found',
  connected: 'found',
  wifi: 'found',
  netConnecting: 'wifi',
  netDone: 'wifi',
};

export default function PairingFlow({ onExit }: { onExit: () => void }) {
  const [step, setStep] = useState<Step>('entry');
  const [ssid, setSsid] = useState('BRO');
  const [pwd, setPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [remember, setRemember] = useState(true);
  const [sheetClosed, setSheetClosed] = useState(false);

  useEffect(() => {
    const target = autoNext[step];
    if (!target) return;
    const t = window.setTimeout(() => setStep(target), autoDelay[step]);
    return () => window.clearTimeout(t);
  }, [step]);

  // 建档浮层保存/跳过后，待配网成功（netDone）才回首页——不早于配网完成，不打断主流程
  useEffect(() => {
    if (step === 'netDone' && sheetClosed) {
      const t = window.setTimeout(onExit, 500);
      return () => window.clearTimeout(t);
    }
  }, [step, sheetClosed, onExit]);

  // 配网成功即把设备绑定到当前账号（一次）——打通配网链路
  const deviceBoundRef = useRef(false);
  useEffect(() => {
    if (step === 'netDone' && !deviceBoundRef.current) {
      deviceBoundRef.current = true;
      void bindDevice({ model: pairingDevice.model, name: pairingDevice.name }).catch((e) =>
        console.error('bindDevice failed', e),
      );
    }
  }, [step]);

  // 建档：保存→写孩子档案；跳过→用兜底昵称建档（都不阻断配网，失败仅记日志）
  const handleSave = (data: ProfileData) => {
    void saveProfile(data).catch((e) => console.error('saveProfile failed', e));
    setSheetClosed(true);
  };
  const handleSkip = (fallbackName: string) => {
    void saveProfile({ nickname: fallbackName, birthday: '', gender: '' }).catch((e) =>
      console.error('saveProfile(skip) failed', e),
    );
    setSheetClosed(true);
  };

  function back() {
    const target = backMap[step];
    if (target) setStep(target);
    else onExit();
  }

  return (
    <div className="flex h-full flex-col bg-page-bg">
      <FlowNav title={titleMap[step]} onBack={back} />
      <div className="no-scrollbar flex-1 overflow-y-auto px-4 pb-6 pt-1">
        {step === 'entry' && <EntryView onAdd={() => setStep('searching')} />}
        {(step === 'searching' || step === 'found') && (
          <SearchView found={step === 'found'} onAdd={() => setStep('connecting')} />
        )}
        {(step === 'connecting' || step === 'connected') && (
          <ConnectDeviceView connected={step === 'connected'} />
        )}
        {step === 'wifi' && (
          <WifiView
            ssid={ssid}
            onCycleSsid={() => setSsid((s) => (s === 'BRO' ? 'Futurus-2.4G' : 'BRO'))}
            pwd={pwd}
            onPwd={setPwd}
            showPwd={showPwd}
            onTogglePwd={() => setShowPwd((v) => !v)}
            remember={remember}
            onToggleRemember={() => setRemember((v) => !v)}
            onNext={() => setStep('netConnecting')}
          />
        )}
        {(step === 'netConnecting' || step === 'netDone') && <NetConnectView done={step === 'netDone'} />}
      </div>
      {/* 异步建档浮层：连接中弹出，连接成功后切成功态。填完/跳过都不打断配网 */}
      {(step === 'netConnecting' || step === 'netDone') && !sheetClosed && (
        <ProfileSheet success={step === 'netDone'} onSave={handleSave} onSkip={handleSkip} />
      )}
    </div>
  );
}

function EntryView({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-[20px] bg-white p-6 pb-8 shadow-card">
      <MonitorIcon className="mx-auto mt-6 h-36 w-44" />
      <p className="mt-3 text-center text-text-muted">连接你的爱视可空间光学读写台</p>
      <button
        className="mx-auto mt-7 flex h-12 w-[78%] items-center justify-center gap-1 rounded-full bg-brand-orange font-bold text-white shadow-card"
        onClick={onAdd}
        type="button"
      >
        <span className="text-lg">＋</span> 添加设备
      </button>
    </div>
  );
}

function SearchView({ found, onAdd }: { found: boolean; onAdd: () => void }) {
  return (
    <div className="min-h-[600px] rounded-[20px] bg-white p-6 shadow-card">
      <div className="flex flex-col items-center pt-10">
        <Spinner />
        <h2 className="mt-8 text-xl font-bold text-text-main">正在寻找附近的读写台…</h2>
        <p className="mt-2 text-sm text-text-muted">请确保靠近设备并保持蓝牙开启</p>
      </div>
      {found && (
        <div className="mt-8">
          <div className="border-t border-black/5" />
          <div className="mt-5 flex items-center gap-3">
            <DeviceThumb />
            <div className="flex-1">
              <p className="font-bold text-text-main">{pairingDevice.name}</p>
              <p className="text-sm text-text-muted">{pairingDevice.model}</p>
            </div>
            <button
              className="rounded-full bg-brand-orange px-5 py-2 text-sm font-bold text-white"
              onClick={onAdd}
              type="button"
            >
              添加
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectDeviceView({ connected }: { connected: boolean }) {
  return (
    <div className="min-h-[600px] rounded-[20px] bg-white p-6 shadow-card">
      <div className="flex flex-col items-center pt-16">
        <div className="grid h-40 w-40 place-items-center rounded-3xl bg-gradient-to-br from-neutral-50 to-neutral-100 shadow-sm">
          <DeskLampIcon className="h-28 w-28" />
        </div>
        <h2 className="mt-7 text-xl font-bold text-text-main">正在连接设备…</h2>
        <p className="mt-2 text-sm text-text-muted">{pairingDevice.name}</p>
        {connected && (
          <div className="mt-10">
            <CheckRow label="设备连接成功" />
          </div>
        )}
      </div>
    </div>
  );
}

type WifiViewProps = {
  ssid: string;
  onCycleSsid: () => void;
  pwd: string;
  onPwd: (v: string) => void;
  showPwd: boolean;
  onTogglePwd: () => void;
  remember: boolean;
  onToggleRemember: () => void;
  onNext: () => void;
};

function WifiView({
  ssid,
  onCycleSsid,
  pwd,
  onPwd,
  showPwd,
  onTogglePwd,
  remember,
  onToggleRemember,
  onNext,
}: WifiViewProps) {
  return (
    <div className="flex min-h-[600px] flex-col rounded-[20px] bg-white p-6 shadow-card">
      <div className="flex items-start justify-between">
        <h2 className="text-2xl font-black text-text-main">选择Wi-Fi</h2>
        <button className="text-sm font-semibold text-blue-500" type="button">
          配网指南
        </button>
      </div>
      <p className="mt-3 text-sm leading-6 text-text-muted">
        设备只支持使用2.4GHz的Wi-Fi连接使用，不支持需要认证的Wi-Fi。
      </p>

      <button
        className="mt-5 flex h-14 w-full items-center justify-between rounded-2xl bg-page-bg px-4 font-semibold text-text-main"
        onClick={onCycleSsid}
        type="button"
      >
        {ssid}
        <span className="text-text-muted">▾</span>
      </button>

      <div className="mt-3 flex h-14 items-center gap-2 rounded-2xl bg-page-bg px-4">
        <input
          className="flex-1 bg-transparent text-text-main outline-none placeholder:text-text-muted"
          onChange={(e) => onPwd(e.target.value)}
          placeholder="输入密码"
          type={showPwd ? 'text' : 'password'}
          value={pwd}
        />
        <button onClick={onTogglePwd} type="button" aria-label="显示密码">
          <EyeIcon off={!showPwd} />
        </button>
      </div>

      <div className="mt-3 flex items-center justify-between text-sm">
        <span className="text-text-muted">请注意区分大小写</span>
        <button className="flex items-center gap-1.5" onClick={onToggleRemember} type="button">
          <span
            className={`grid h-4 w-4 place-items-center rounded-full text-[10px] text-white ${
              remember ? 'bg-green-500' : 'bg-gray-300'
            }`}
          >
            ✓
          </span>
          <span className="text-text-muted">记住密码</span>
        </button>
      </div>

      <button
        className="mt-auto h-14 w-full rounded-full bg-brand-orange font-bold text-white shadow-card"
        onClick={onNext}
        type="button"
      >
        下一步
      </button>
    </div>
  );
}

// 配网「连接网络」背景页（画板简洁版：显示器 + loading 环/绿勾）。建档 sheet 浮在其上。
function NetConnectView({ done }: { done: boolean }) {
  return (
    <div className="flex flex-col items-center pt-14">
      <div className="relative h-[84px] w-[120px] rounded-xl border-2 border-[#D8E0E8] bg-white">
        <div className="absolute left-[15px] top-[14px] h-11 w-[90px] rounded-md bg-[#EAF2F8]" />
      </div>
      <div className="mt-2 h-2 w-10 rounded-full bg-[#D8E0E8]" />
      <div className="mt-12">
        {done ? (
          <span className="grid h-11 w-11 place-items-center rounded-full bg-[#52C41A] text-xl font-bold text-white">✓</span>
        ) : (
          <div className="h-11 w-11 animate-spin rounded-full border-[5px] border-[#E8EDF2] border-t-brand-orange" />
        )}
      </div>
      <p className="mt-6 text-base font-semibold text-[#1F2933]">{done ? '设备已连接' : '正在连接网络…'}</p>
      {!done && <p className="mt-1.5 text-xs text-[#8C94A3]">预计需要 10-30 秒</p>}
    </div>
  );
}

/* ---------- 共享小组件 / 图标 ---------- */

function Spinner() {
  return (
    <div className="h-[72px] w-[72px] animate-spin rounded-full border-[6px] border-orange-100 border-t-brand-orange" />
  );
}

function CheckRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2">
      <span className="grid h-6 w-6 place-items-center rounded-full bg-green-500 text-sm font-bold text-white">
        ✓
      </span>
      <span className="font-bold text-text-main">{label}</span>
    </div>
  );
}

function DeviceThumb() {
  return (
    <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-neutral-50 to-neutral-100">
      <DeskLampIcon className="h-9 w-9" />
    </div>
  );
}

function MonitorIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 110" className={className} fill="none" aria-hidden="true">
      <rect x="16" y="8" width="88" height="68" rx="12" fill="#E2E6EE" />
      <rect x="27" y="19" width="66" height="46" rx="7" fill="#F1F3F7" />
      <rect x="52" y="76" width="16" height="13" fill="#D5DAE4" />
      <rect x="36" y="89" width="48" height="8" rx="4" fill="#D5DAE4" />
      <circle cx="80" cy="60" r="1.6" fill="#C2C8D4" />
      <circle cx="86" cy="60" r="1.6" fill="#C2C8D4" />
    </svg>
  );
}

function DeskLampIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} fill="none" aria-hidden="true">
      <path d="M9 17 L47 9 L52 21 L15 30 Z" fill="#3A3A3C" />
      <path d="M15 30 L52 21 L50 25 L19 34 Z" fill="#2A2A2C" />
      <path d="M19 28 L31 45 M45 22 L33 45" stroke="#5A5A5C" strokeWidth="2" strokeLinecap="round" />
      <rect x="30" y="33" width="4" height="17" rx="1" fill="#4A4A4C" />
      <rect x="20" y="50" width="24" height="5" rx="2.5" fill="#3A3A3C" />
    </svg>
  );
}

function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5 text-text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" strokeLinecap="round" />}
    </svg>
  );
}
