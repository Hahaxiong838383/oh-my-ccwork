import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { childProfile, homeStats, kidsHub, menuItems, weeklyReport, type SuggestionStatus } from './mock/data';
import { StatusBar } from './components/chrome';
import PairingFlow from './pages/PairingFlow';
import ProfileSetupFlow from './pages/ProfileSetupFlow';
import InviteLoginPage from './pages/InviteLoginPage';
import PairBindPage, { parsePairHash, type PairParams } from './pages/PairBindPage';
import { calcAge } from './pages/ProfileSheet';
import { getDevice, getProfile, type DeviceInfo, type Profile } from './api';

type TabKey = 'home' | 'report' | 'kidshub' | 'mine';
type FlowKey = 'pairing' | 'profile';

type CardProps = {
  children: ReactNode;
  className?: string;
};

const tabs: Array<{ key: TabKey; label: string; icon: string; title: string }> = [
  { key: 'home', label: '首页', icon: '🏠', title: '家长端' },
  { key: 'report', label: '周报', icon: '📊', title: '价值周报' },
  { key: 'kidshub', label: 'KidsHub', icon: '💡', title: 'KidsHub' },
  { key: 'mine', label: '我的', icon: '👤', title: '我的' },
];

const statusStyles: Record<SuggestionStatus, string> = {
  已收到: 'bg-orange-50 text-brand-orange',
  评估中: 'bg-blue-50 text-blue-500',
  已采纳: 'bg-green-50 text-green-600',
  进了金点子库: 'bg-purple-50 text-purple-600',
};

function Card({ children, className = '' }: CardProps) {
  return <section className={`rounded-2xl bg-white p-4 shadow-card ${className}`}>{children}</section>;
}

function MiniProgramNav({ title }: { title: string }) {
  return (
    <header className="sticky top-0 z-20 bg-page-bg/95 pb-2 backdrop-blur">
      <StatusBar />
      <div className="relative flex h-11 items-center justify-center px-4">
        <h1 className="text-base font-semibold text-text-main">{title}</h1>
        <div className="absolute right-4 flex h-8 w-[86px] items-center justify-around rounded-full bg-black/5 text-lg text-text-main">
          <span className="tracking-[-2px]">···</span>
          <span className="text-base">⊙</span>
        </div>
      </div>
    </header>
  );
}

function TabBar({ activeTab, onChange }: { activeTab: TabKey; onChange: (tab: TabKey) => void }) {
  return (
    <nav className="absolute bottom-0 left-0 right-0 z-30 grid h-[76px] grid-cols-4 border-t border-black/5 bg-white/95 px-2 pb-3 pt-2 backdrop-blur">
      {tabs.map((tab) => {
        const active = activeTab === tab.key;
        return (
          <button
            key={tab.key}
            className={`flex flex-col items-center justify-center gap-0.5 rounded-2xl text-xs transition ${active ? 'text-brand-orange' : 'text-text-muted'}`}
            onClick={() => onChange(tab.key)}
            type="button"
          >
            <span className="text-xl leading-none">{tab.icon}</span>
            <span className="font-medium">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function ChildBadge({ profile }: { profile: Profile | null }) {
  const name = profile?.nickname || '未建档';
  const age = profile?.birthday ? `${calcAge(profile.birthday)} 周岁` : '待完善';
  return (
    <div className="flex items-center gap-3">
      <div className="grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-orange-200 to-brand-orange text-xl font-bold text-white">
        {name.slice(0, 1)}
      </div>
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-bold text-text-main">{name}</h2>
          <span className="rounded-full bg-orange-50 px-2.5 py-1 text-xs font-semibold text-brand-orange">
            {profile?.gender || age}
          </span>
        </div>
        <p className="mt-1 text-sm text-text-muted">
          {profile ? `${profile.gender} · ${age}` : '完善信息后，小可更懂 TA'}
        </p>
      </div>
    </div>
  );
}

function HomePage({ onStartFlow }: { onStartFlow: (flow: FlowKey) => void }) {
  const maxBar = Math.max(...homeStats.weeklyBars);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getProfile()
      .then((r) => setProfile(r.profile))
      .catch(() => {})
      .finally(() => setLoaded(true));
    getDevice()
      .then((r) => setDevice(r.device))
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      {/* 未建档才显「补全孩子信息」提示条 */}
      {loaded && !profile && (
        <button
          className="flex w-full items-center gap-3 rounded-2xl bg-gradient-to-r from-brand-orange to-orange-400 p-3 text-left shadow-card"
          onClick={() => onStartFlow('profile')}
          type="button"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/25 text-lg">👧</span>
          <span className="flex-1 text-sm font-semibold leading-5 text-white">补全孩子信息，让小可叫出 TA 的名字</span>
          <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-brand-orange">去补全</span>
        </button>
      )}

      {/* 未绑定设备才显配网引导 */}
      {loaded && !device && (
        <button
          className="flex w-full items-center gap-3 rounded-2xl bg-white p-3 text-left shadow-card"
          onClick={() => onStartFlow('pairing')}
          type="button"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-orange-50 text-lg text-brand-orange">＋</span>
          <span className="flex-1 text-sm font-semibold text-text-main">配网添加你的读写台设备</span>
          <span className="text-text-muted">›</span>
        </button>
      )}

      <Card>
        <ChildBadge profile={profile} />
      </Card>

      <Card>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-text-main">读写台状态</h3>
            <p className="text-sm text-text-muted">{device ? `${device.name} · 在线` : '未绑定设备'}</p>
          </div>
          <div className="grid h-20 w-24 place-items-center rounded-2xl bg-gradient-to-br from-orange-100 via-white to-slate-100 text-3xl">📚</div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <DeviceMetric label="亮度" value={homeStats.device.brightness} />
          <DeviceMetric label="色温" value={homeStats.device.colorTemperature} />
          <DeviceMetric label="距离" value={homeStats.device.distance} />
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <MetricCard label="今日专注" value={homeStats.focusToday} unit="分钟" />
        <MetricCard label="本周平均" value={homeStats.weeklyAverage} unit="分钟" />
      </div>

      <Card>
        <div className="flex items-end justify-between">
          <div>
            <p className="text-sm text-text-muted">本周总时长</p>
            <p className="mt-1 text-3xl font-black text-brand-orange">{homeStats.weeklyTotal}<span className="ml-1 text-sm font-semibold">分钟</span></p>
          </div>
          <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-brand-orange">持续进步</span>
        </div>
        <div className="mt-5 flex h-32 items-end justify-between gap-2 rounded-2xl bg-page-bg px-3 pb-3 pt-4">
          {homeStats.weeklyBars.map((value, index) => (
            <div key={index} className="flex flex-1 flex-col items-center gap-2">
              <div className="w-full rounded-t-xl bg-brand-orange/85" style={{ height: `${Math.max(18, (value / maxBar) * 88)}px` }} />
              <span className="text-[11px] text-text-muted">{'一二三四五六日'[index]}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3">
        <Card className="bg-gradient-to-br from-orange-50 to-white">
          <p className="text-sm text-text-muted">夜航收益</p>
          <p className="mt-2 text-xl font-bold text-text-main">昨晚获得 <span className="text-3xl text-brand-orange">{homeStats.nightReward}</span> 家族币</p>
        </Card>
        <Card>
          <p className="text-sm text-text-muted">生态缸</p>
          <p className="mt-2 text-lg font-bold text-text-main">孩子的生态缸有了一点小变化</p>
          <div className="mt-3 flex h-20 items-end justify-around rounded-2xl bg-gradient-to-b from-cyan-50 to-emerald-100 px-6 pb-3 text-2xl">
            <span>🌿</span><span>🐠</span><span>🫧</span><span>🐚</span>
          </div>
        </Card>
      </div>
    </div>
  );
}

function DeviceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-page-bg px-2 py-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="mt-1 font-bold text-text-main">{value}</p>
    </div>
  );
}

function MetricCard({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <Card>
      <p className="text-sm text-text-muted">{label}</p>
      <p className="mt-2 text-3xl font-black text-brand-orange">{value}<span className="ml-1 text-sm font-semibold">{unit}</span></p>
    </Card>
  );
}

function ReportPage() {
  return (
    <div className="space-y-4">
      <div className="px-1">
        <p className="text-sm font-semibold text-brand-orange">VALUE REPORT</p>
        <h2 className="mt-1 text-2xl font-black text-text-main">本周价值报告</h2>
      </div>

      <Card>
        <h3 className="font-bold text-text-main">本周高光</h3>
        <div className="mt-3 space-y-3">
          {weeklyReport.highlights.map((item) => (
            <div key={item} className="flex gap-3 rounded-2xl bg-orange-50 p-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-orange text-white">✓</span>
              <p className="text-sm font-semibold leading-8 text-text-main">{item}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <h3 className="font-bold text-text-main">用眼健康硬数字</h3>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <ReportMetric label="护眼达标率" value={`${weeklyReport.eyeHealthRate}%`} />
          <ReportMetric label="控制风险时长" value={`${weeklyReport.guardedMinutes}分钟`} />
        </div>
      </Card>

      <Card className="bg-gradient-to-br from-orange-50 to-white">
        <p className="text-sm text-text-muted">同龄百分位</p>
        <p className="mt-2 text-xl font-bold text-text-main">超过 <span className="text-4xl text-brand-orange">{weeklyReport.percentile}%</span> 同龄孩子</p>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-bold text-text-main">视力趋势</h3>
            <p className="mt-1 text-sm text-text-muted">近阶段记录占位</p>
          </div>
          <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-brand-orange">稳定</span>
        </div>
        <div className="mt-5 h-32 rounded-2xl bg-page-bg p-4">
          <svg viewBox="0 0 280 96" className="h-full w-full" aria-hidden="true">
            <path d="M8 70 C50 58 70 62 104 48 S162 35 198 43 244 50 272 28" fill="none" stroke="#FF7A33" strokeWidth="6" strokeLinecap="round" />
            <path d="M8 82 H272" stroke="#E5E7EB" strokeWidth="2" strokeDasharray="6 8" />
          </svg>
        </div>
      </Card>
    </div>
  );
}

function ReportMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-page-bg p-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="mt-2 text-2xl font-black text-brand-orange">{value}</p>
    </div>
  );
}

function KidsHubPage() {
  return (
    <div className="space-y-4">
      <Card className="bg-gradient-to-br from-orange-50 via-white to-white">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-bold text-brand-orange">{kidsHub.level}</p>
            <h2 className="mt-1 text-2xl font-black text-text-main">{kidsHub.title}</h2>
            <p className="mt-2 text-sm text-text-muted">已采纳 {kidsHub.acceptedCount} 条 · {kidsHub.signature} 署名</p>
          </div>
          <div className="grid h-16 w-16 place-items-center rounded-full bg-brand-orange text-3xl text-white">💡</div>
        </div>
      </Card>

      <Card>
        <h3 className="font-bold text-text-main">孩子语音建议</h3>
        <div className="mt-4 space-y-3">
          {kidsHub.suggestions.map((item) => (
            <div key={item.summary} className="rounded-2xl border border-black/5 bg-white p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-xs text-text-muted">{item.date}</span>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[item.status]}`}>{item.status}</span>
              </div>
              <p className="text-sm font-semibold leading-6 text-text-main">{item.summary}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card className="bg-gradient-to-br from-purple-50 to-orange-50">
        <p className="text-sm font-semibold text-purple-600">高光时刻</p>
        <h3 className="mt-2 text-xl font-black text-text-main">因为 小明 的建议，小可又进化了</h3>
        <p className="mt-3 text-sm leading-6 text-text-muted">生态缸新增了“贝壳点亮”反馈，孩子完成阅读后能看到自己的灵感被实现。</p>
      </Card>
    </div>
  );
}

function MinePage({ onStartFlow }: { onStartFlow: (flow: FlowKey) => void }) {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-3">
          <div className="grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br from-orange-200 to-brand-orange text-2xl font-bold text-white">家</div>
          <div>
            <h2 className="text-xl font-black text-text-main">川哥家长</h2>
            <p className="mt-1 text-sm text-text-muted">{childProfile.phone}</p>
          </div>
        </div>
      </Card>

      <Card className="p-0">
        <button
          className="flex h-14 w-full items-center justify-between px-4 text-left"
          onClick={() => onStartFlow('pairing')}
          type="button"
        >
          <span className="font-semibold text-text-main">设备配网 / 添加读写台</span>
          <span className="text-text-muted">›</span>
        </button>
      </Card>

      <Card className="p-0">
        {menuItems.map((item, index) => (
          <button
            key={item.label}
            className={`flex h-14 w-full items-center justify-between px-4 text-left ${index === 0 ? '' : 'border-t border-black/5'}`}
            onClick={() => item.label === '孩子管理' && onStartFlow('profile')}
            type="button"
          >
            <span className="flex items-center gap-2 font-semibold text-text-main">
              {item.label}
              {item.badge && <i className="h-2 w-2 rounded-full bg-red-500" />}
            </span>
            <span className="text-text-muted">›</span>
          </button>
        ))}
      </Card>

      <button className="h-12 w-full rounded-2xl bg-white font-bold text-red-500 shadow-card" type="button">退出登录</button>
    </div>
  );
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState(() => Boolean(sessionStorage.getItem('parent.token')));
  const [activeTab, setActiveTab] = useState<TabKey>('home');
  const [flow, setFlow] = useState<FlowKey | null>(null);
  // 配网绑定深链（设备屏二维码 → #/pair?v=2&sn=…&nonce=…&pk=…）：启动时解析一次；
  // 未登录先走登录（onLogin 后 pairParams 仍在，自然落入绑定页）。
  const [pairParams, setPairParams] = useState<PairParams | null>(() => parsePairHash(window.location.hash));
  const activeTitle = useMemo(() => tabs.find((tab) => tab.key === activeTab)?.title ?? '家长端', [activeTab]);

  return (
    <div className="flex min-h-[100dvh] justify-center bg-slate-100 md:items-center md:px-3 md:py-6">
      <div className="relative h-[100dvh] w-full max-w-[440px] overflow-hidden bg-page-bg md:h-[844px] md:w-[390px] md:max-w-none md:rounded-[42px] md:border-[10px] md:border-slate-950 md:shadow-phone">
        {!loggedIn ? (
          <InviteLoginPage onLogin={() => { setLoggedIn(true); if (!parsePairHash(window.location.hash)) setFlow('pairing'); }} />
        ) : pairParams ? (
          <PairBindPage params={pairParams} onDone={() => { window.location.hash = ''; setPairParams(null); setFlow(null); }} />
        ) : flow === 'pairing' ? (
          <PairingFlow onExit={() => setFlow(null)} />
        ) : flow === 'profile' ? (
          <ProfileSetupFlow onExit={() => setFlow(null)} />
        ) : (
          <>
            <MiniProgramNav title={activeTitle} />
            <main className="no-scrollbar h-[calc(100%-129px)] overflow-y-auto px-4 pb-6 pt-2">
              {activeTab === 'home' && <HomePage onStartFlow={setFlow} />}
              {activeTab === 'report' && <ReportPage />}
              {activeTab === 'kidshub' && <KidsHubPage />}
              {activeTab === 'mine' && <MinePage onStartFlow={setFlow} />}
            </main>
            <TabBar activeTab={activeTab} onChange={setActiveTab} />
          </>
        )}
      </div>
    </div>
  );
}
