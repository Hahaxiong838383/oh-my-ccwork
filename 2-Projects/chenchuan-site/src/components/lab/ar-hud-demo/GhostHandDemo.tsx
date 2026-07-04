'use client'

import { MONO_FONT } from './phud/types'

// G2 Ghost Hand 引导（v2，对齐实际识别）：
// 实际识别 = gaze（眼动跟头）+ pinch（食指拇指捏合）。原 v1 演示"拖动"
// 和 实际不匹配，川哥指出会误解。v2 改 3 阶段教学：
// 1. 晃晃头 看光标移动（gaze 光圈左右晃）
// 2. 抬起手 看到光点（手部 cursor 出现）
// 3. 重点：捏一下 → 食指拇指捏合（脉冲强调，关键动作）
//
// 顶部加大 CTA 卡片"先开启右下角摄像头 ↘"，箭头脉冲指向，因为
// 授权是流失关键点 — 必须最显眼。
//
// 显示条件：page.tsx 通过 hands.length===0 挂载。pointer-events-none 不干涉。
export function GhostHandDemo() {
  return (
    <div className="pointer-events-none fixed inset-0 z-[44] flex items-center justify-center px-6">
      <div className="ghost-demo-fade flex flex-col items-center gap-7">
        {/* 顶部大 CTA：指向右下角摄像头按钮 — 流失关键点必须最显眼 */}
        <div className="ghost-cta flex flex-col items-center gap-2 rounded-2xl border border-[#7FE5FF]/55 bg-[#7FE5FF]/[0.08] px-7 py-4 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono uppercase tracking-[0.22em] text-[#7FE5FF]/85">
              第一步
            </span>
            <span className="text-[15px] font-semibold text-white">先开启右下角摄像头</span>
            <span className="ghost-arrow text-[26px] text-[#7FE5FF]">↘</span>
          </div>
          <div
            className="text-[10.5px] tracking-wide text-[#7FE5FF]/75"
            style={{ fontFamily: MONO_FONT }}
          >
            授权后才能识别头部 / 手势 · 100% 本地推理 零上传
          </div>
        </div>

        {/* 中央三阶段教学动画（8 秒循环） */}
        <div className="ghost-stage relative flex h-48 w-80 items-center justify-center">
          {/* 阶段 1: 晃头看光标 (0-22% 显示) */}
          <div className="ghost-stage-1 absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div className="relative h-24 w-24">
              <div className="absolute inset-0 flex items-center justify-center text-[58px] leading-none">
                🙂
              </div>
              {/* gaze 光圈：左右晃模拟头部转动 */}
              <div className="ghost-gaze absolute -top-3 left-1/2 h-7 w-7 rounded-full border-2 border-[#7FE5FF] bg-[#7FE5FF]/20 shadow-[0_0_22px_rgba(127,229,255,0.75)]" />
            </div>
            <div className="text-[14px] text-white/90">
              <span className="font-mono text-[#7FE5FF]">2.</span>{' '}
              <span className="font-medium">晃晃头</span> 看光标跟随
            </div>
          </div>

          {/* 阶段 2: 抬起手 (28-50% 显示) */}
          <div className="ghost-stage-2 absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div className="relative h-24 w-24">
              <div className="absolute inset-0 flex items-center justify-center text-[58px] leading-none">
                🖐️
              </div>
              {/* 手部 cursor 光点 */}
              <div className="absolute -top-2 left-1/2 h-5 w-5 -translate-x-1/2 rounded-full bg-white/85 shadow-[0_0_18px_rgba(255,255,255,0.7)]" />
            </div>
            <div className="text-[14px] text-white/90">
              <span className="font-mono text-[#7FE5FF]">3.</span>{' '}
              <span className="font-medium">抬起手</span> 看到光点出现
            </div>
          </div>

          {/* 阶段 3: 关键 — 食指拇指捏合（脉冲强调） (56-88% 显示) */}
          <div className="ghost-stage-3 absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div className="ghost-pinch-pulse relative h-24 w-24">
              <div className="absolute inset-0 flex items-center justify-center text-[64px] leading-none">
                🤏
              </div>
              {/* pinched cursor：缩小变青色 */}
              <div className="absolute -top-1 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-[#93C5FD] shadow-[0_0_24px_rgba(147,197,253,0.95)]" />
            </div>
            <div className="flex flex-col items-center gap-0.5">
              <div className="text-[20px] font-bold text-[#7FE5FF] drop-shadow-[0_0_12px_rgba(127,229,255,0.6)]">
                捏一下！
              </div>
              <div className="text-[12px] text-white/85">食指 + 拇指 → 抓起卡片</div>
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        /* 8 秒循环 3 阶段教学：晃头(0-22%) → 抬手(28-50%) → 捏合(56-88%) → 淡出(92-100%) */
        @keyframes stage1Show {
          0%,
          22% {
            opacity: 1;
          }
          28%,
          100% {
            opacity: 0;
          }
        }
        @keyframes stage2Show {
          0%,
          28% {
            opacity: 0;
          }
          32%,
          50% {
            opacity: 1;
          }
          56%,
          100% {
            opacity: 0;
          }
        }
        @keyframes stage3Show {
          0%,
          56% {
            opacity: 0;
          }
          60%,
          88% {
            opacity: 1;
          }
          92%,
          100% {
            opacity: 0;
          }
        }

        /* gaze 光圈左右晃动模拟头部转动（阶段 1） */
        @keyframes gazeWobble {
          0%,
          100% {
            transform: translateX(-50%) translateX(0);
          }
          25% {
            transform: translateX(-50%) translateX(-20px);
          }
          75% {
            transform: translateX(-50%) translateX(20px);
          }
        }

        /* 捏合脉冲（阶段 3 重点强调） */
        @keyframes pinchPulse {
          0%,
          100% {
            transform: scale(1);
          }
          50% {
            transform: scale(0.85);
          }
        }

        /* 顶部 CTA 持续脉冲（吸引视线） */
        @keyframes ctaPulse {
          0%,
          100% {
            box-shadow: 0 0 42px rgba(127, 229, 255, 0.32);
            border-color: rgba(127, 229, 255, 0.55);
          }
          50% {
            box-shadow: 0 0 70px rgba(127, 229, 255, 0.75);
            border-color: rgba(127, 229, 255, 1);
          }
        }

        /* 右下箭头反复指向 */
        @keyframes arrowBounce {
          0%,
          100% {
            transform: translate(0, 0) scale(1);
          }
          50% {
            transform: translate(7px, 7px) scale(1.18);
          }
        }

        @keyframes ghostDemoFadeIn {
          0% {
            opacity: 0;
            transform: translateY(10px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .ghost-stage-1 {
          animation: stage1Show 8s ease-in-out infinite;
        }
        .ghost-stage-2 {
          animation: stage2Show 8s ease-in-out infinite;
        }
        .ghost-stage-3 {
          animation: stage3Show 8s ease-in-out infinite;
        }
        .ghost-gaze {
          animation: gazeWobble 2.2s ease-in-out infinite;
        }
        .ghost-pinch-pulse {
          animation: pinchPulse 0.85s ease-in-out infinite;
        }
        .ghost-cta {
          animation: ctaPulse 1.8s ease-in-out infinite;
        }
        .ghost-arrow {
          animation: arrowBounce 1.2s ease-in-out infinite;
          display: inline-block;
        }
        .ghost-demo-fade {
          animation: ghostDemoFadeIn 600ms ease-out both;
        }
      `}</style>
    </div>
  )
}
