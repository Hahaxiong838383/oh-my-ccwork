import { useEffect, useState } from 'react';
import type { SceneCard } from '../prompts';

/**
 * CardScene —— kidshub 专属场景层（与原 demo 场景组件完全解耦）
 *
 * 每张卡一张 800×480 背景图（/kidshub/scenes/cardN.v2.png）：
 * card1/7/8 复制自原 demo 美术；card2-6 为 AI 生图占位，川哥后续替换美术资源
 * （直接覆盖同名文件即可，零代码改动）。图加载失败自动降级为星空渐变占位。
 */
export function CardScene({ card }: { card: SceneCard | null }) {
  const [imgFailed, setImgFailed] = useState(false);

  // 换卡重置图片失败状态
  useEffect(() => {
    setImgFailed(false);
  }, [card?.id]);

  if (!card) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-[#0a1929] to-[#0d2238]">
        <div className="text-[6cqw] opacity-40">🛸</div>
        <div className="mt-[2cqh] text-[2.4cqw] text-white/35">从左侧选择一张场景卡开始</div>
      </div>
    );
  }

  if (imgFailed) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-[#0a1929] via-[#11294a] to-[#0d2238]">
        {/* 星点装饰 */}
        <div className="pointer-events-none absolute inset-0 opacity-50">
          {[
            { left: '12%', top: '18%' },
            { left: '78%', top: '12%' },
            { left: '88%', top: '42%' },
            { left: '8%', top: '62%' },
            { left: '64%', top: '74%' },
            { left: '36%', top: '8%' },
          ].map((p, i) => (
            <div
              key={i}
              className="absolute h-[0.8cqw] w-[0.8cqw] rounded-full bg-white/60"
              style={p}
            />
          ))}
        </div>
        <div className="text-[10cqw]">{card.emoji}</div>
        <div className="mt-[1.5cqh] text-[3cqw] font-medium text-white/80">
          卡 {card.cardNo} · {card.title}
        </div>
        <div className="mt-[1cqh] rounded-full bg-white/10 px-[2cqw] py-[0.6cqh] text-[1.8cqw] text-white/50">
          场景图占位 · 待美术资源
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 bg-[#0a1929]">
      <img
        src={card.sceneImage}
        alt={`卡 ${card.cardNo} ${card.title} 场景`}
        className="h-full w-full object-cover"
        onError={() => setImgFailed(true)}
        draggable={false}
      />
    </div>
  );
}
