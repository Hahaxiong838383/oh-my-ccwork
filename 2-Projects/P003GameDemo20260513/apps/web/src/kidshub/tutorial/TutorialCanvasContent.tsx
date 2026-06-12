import { useTutorialStore, currentStep } from './tutorial-store';
import type { TutorialTarget } from './tutorial-types';
import { MockSettingsPanel } from './MockSettingsPanel';
import { TutorialOverlay } from './TutorialOverlay';

/**
 * TutorialCanvasContent — 设置引导画布根组件（800×480 等比容器内使用）
 * - 深蓝太空舱背景 + 大圆角舷窗（内含星点）
 * - 顶部状态条：左金币/钻石胶囊，右 wifi + 六边形设置按钮（open-panel 目标）
 * - step '4' 显示底部「高度调节」哑示意区
 * - panelOpen 时渲染 MockSettingsPanel（内含 5 控件）
 * - 始终渲染 TutorialOverlay（蒙版 + 画布级小手 + 手势热区）
 * - lightOn=false 时画布额外压暗层（在面板/状态条下方）
 * - 全部使用 cqw/cqh + absolute inset-0，遵循 CardScene 容器查询规范
 * - 控件操作统一走 advanceOnAction（store 内部幂等过滤）
 */
export function TutorialCanvasContent(): JSX.Element {
  const stepIndex = useTutorialStore((s) => s.stepIndex);
  const panelOpen = useTutorialStore((s) => s.panelOpen);
  const lightOn = useTutorialStore((s) => s.lightOn);
  const advanceOnAction = useTutorialStore((s) => s.advanceOnAction);

  // 本组件只服务单元1（设置引导）；登舰等剧情单元有各自的画布组件
  const step = currentStep({ unitId: 'settings', stepIndex });
  const activeTarget = (step?.target ?? null) as TutorialTarget | null;
  const isStep4 = step?.id === '4' || step?.specStep?.startsWith('4');

  // 右上六边形设置按钮高亮（仅 open-panel 且未开面板时）
  const hexActive = activeTarget === 'open-panel' && !panelOpen;

  return (
    <div className="absolute inset-0 overflow-hidden text-white" style={{ fontSize: 'inherit' }}>
      {/* 背景层：太空舱深蓝渐变 + 舷窗 + 星点 */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#0a1929] via-[#11294a] to-[#0d2238]">
        {/* 大圆角舷窗（模拟观察窗） */}
        <div
          className="absolute left-1/2 top-[13%] -translate-x-1/2 rounded-[17cqw] border-[1.1cqw] border-white/10 bg-[#081628]/55 overflow-hidden"
          style={{ width: '79cqw', height: '63cqh' }}
        >
          {/* 窗内星空点缀 */}
          <div className="pointer-events-none absolute inset-0 opacity-60">
            {[
              { left: '14%', top: '16%' }, { left: '81%', top: '11%' },
              { left: '23%', top: '29%' }, { left: '67%', top: '24%' },
              { left: '9%', top: '51%' }, { left: '88%', top: '47%' },
              { left: '31%', top: '68%' }, { left: '72%', top: '71%' },
              { left: '48%', top: '8%' }, { left: '55%', top: '42%' },
            ].map((p, i) => (
              <div
                key={i}
                className="absolute h-[0.75cqw] w-[0.75cqw] rounded-full bg-white/70"
                style={p}
              />
            ))}
            {/* 稍大一点的星星 */}
            <div className="absolute left-[39%] top-[19%] h-[1.1cqw] w-[1.1cqw] rounded-full bg-white/55" />
            <div className="absolute left-[62%] top-[58%] h-[0.95cqw] w-[0.95cqw] rounded-full bg-white/50" />
          </div>
        </div>

        {/* 舱内零星装饰星点（窗外） */}
        <div className="pointer-events-none absolute inset-0 opacity-35">
          {[
            { left: '6%', top: '7%' }, { left: '93%', top: '6%' },
            { left: '4%', top: '41%' }, { left: '95%', top: '33%' },
          ].map((p, i) => (
            <div key={i} className="absolute h-[0.55cqw] w-[0.55cqw] rounded-full bg-white/60" style={p} />
          ))}
        </div>
      </div>

      {/* 关灯压暗层（在状态条与面板下方，面板仍可读） */}
      {!lightOn && <div className="absolute inset-0 z-[42] bg-black/55 pointer-events-none" />}

      {/* 顶部状态条（胶囊 + 设置按钮） */}
      <div className="absolute top-0 left-0 right-0 h-[8.8cqh] z-[58] flex items-center justify-between px-[2.4cqw] bg-gradient-to-b from-black/30 to-transparent">
        {/* 左侧计数胶囊 */}
        <div className="flex items-center gap-[1.1cqw]">
          <div className="flex items-center gap-[0.45cqw] rounded-full bg-white/90 px-[1.35cqw] py-[0.25cqh] text-neutral-900 text-[1.65cqw] shadow-sm">
            <span>🪙</span>
            <span className="font-medium tracking-tight">123456</span>
          </div>
          <div className="flex items-center gap-[0.45cqw] rounded-full bg-white/90 px-[1.35cqw] py-[0.25cqh] text-neutral-900 text-[1.65cqw] shadow-sm">
            <span>💎</span>
            <span className="font-medium tracking-tight">123456</span>
          </div>
        </div>

        {/* 右侧 wifi + 六边形设置按钮（step2 目标） */}
        <div className="flex items-center gap-[1.3cqw]">
          <div className="text-[2.1cqw] opacity-80" aria-hidden>🛜</div>

          <button
            type="button"
            onClick={() => advanceOnAction('open-panel')}
            className={`flex h-[5.6cqw] w-[5.6cqw] items-center justify-center text-[2.05cqw] select-none transition-all active:scale-[0.94] ${hexActive ? 'animate-pulse ring-2 ring-yellow-400 ring-offset-1 ring-offset-[#0a1929]' : 'ring-1 ring-white/25'} `}
            style={{
              background: '#1f2937',
              clipPath: 'polygon(50% 3%, 95% 23%, 95% 77%, 50% 97%, 5% 77%, 5% 23%)',
            }}
            aria-label="打开设置面板"
          >
            <span className="text-white/90">⚙</span>
          </button>
        </div>
      </div>

      {/* 底部「高度调节」示意区（仅 step 4 出现，哑控件） */}
      {isStep4 && (
        <div className="absolute bottom-[3.4cqh] left-1/2 z-30 -translate-x-1/2 flex items-center gap-[1.2cqw] rounded-2xl bg-black/35 px-[2.1cqw] py-[0.55cqh] text-white/70">
          <div className="flex flex-col items-center text-[2.6cqw] leading-[0.82] select-none">
            <div>▲</div>
            <div className="-mt-[0.1cqh]">▼</div>
          </div>
          <div className="text-[1.55cqw] tracking-[0.06em]">高度调节</div>
        </div>
      )}

      {/* 设置面板（从顶部滑入） */}
      {panelOpen && <MockSettingsPanel activeTarget={activeTarget} />}

      {/* 蒙版 + 画布级小手 + 手势热区 */}
      <TutorialOverlay />
    </div>
  );
}
