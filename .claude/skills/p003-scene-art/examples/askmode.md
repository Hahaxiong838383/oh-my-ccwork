# AskMode 实施案例（V1.0 · 2026-05-14 D3.5）

## 特殊点

- **PNG 自带按钮文案**（出航 / 静思），代码做透明 hit area 即可
- **星点仅左舷窗**：图里右侧是金属舱壁不是星空，clipPath 椭圆中心偏左 (16%, 28%)
- **倒计时小尺寸**：30s 兜底逻辑保留，但视觉移到右下角 opacity 0.6 不抢镜
- **复用组件双场景**：boot askMode（新美术）+ reward askMode（旧 UI 继续出航/返舱）共存，`if (isBootAsk) return <new>; else return <old>;`

## 关键参数（800×480 画布）

```ts
// 星点：5 颗仅放左舷窗
const STARS: readonly StarSpec[] = [
  { id: 'a1', left: '4cqw', top: '12cqh', size: '0.9cqw', delay: '-0.4s', duration: '3.4s', drift: '2.5cqw' },
  { id: 'a2', left: '12cqw', top: '24cqh', size: '0.6cqw', delay: '-1.8s', duration: '3.0s', drift: '-2.0cqw' },
  { id: 'a3', left: '20cqw', top: '8cqh', size: '0.8cqw', delay: '-2.6s', duration: '3.6s', drift: '1.8cqw' },
  { id: 'a4', left: '6cqw', top: '38cqh', size: '0.7cqw', delay: '-1.0s', duration: '3.2s', drift: '2.2cqw' },
  { id: 'a5', left: '24cqw', top: '20cqh', size: '0.6cqw', delay: '-3.0s', duration: '3.8s', drift: '-1.6cqw' },
];

// clipPath: 偏左舷窗 中心 (16%, 28%) 半径 (28%, 42%)
clipPath: 'ellipse(28% 42% at 16% 28%)'

// 表情屏绿光：中心 (54cqw, 33cqh)
left: '47cqw', top: '28cqh', width: '14cqw', height: '11cqh'

// 出航按钮 hit area
left: '4cqw', top: '75cqh', width: '40cqw', height: '18cqh'

// 静思按钮 hit area
left: '46cqw', top: '75cqh', width: '41cqw', height: '18cqh'

// 倒计时小圆环
right: '3cqw', bottom: '4cqh', size: 36, opacity: 0.6
```

## TTS 文案

`'指挥官，今天想出航，还是静思呢？'`

## 状态机集成

```ts
// 出航 → explore mode（进入 focusMachine 流程）
dispatchBoot({ type: 'ASK_MODE_PICK', mode: 'explore' });
dispatchFocus({ type: 'LAUNCH', mode: 'explore' });

// 静思 → companion mode
dispatchBoot({ type: 'ASK_MODE_PICK', mode: 'companion' });
dispatchFocus({ type: 'LAUNCH', mode: 'companion' });

// 30s 超时默认陪伴
onTimeout: () => pickBootMode('companion');
```

## 双场景共存技巧

```tsx
const isBootAsk = bootState === 'askMode';
const isRewardAsk = rewardMachine === 'askMode';

// 所有 hook 在 early return 前：useEffect / useCallback × 3
// hook 顺序锁定 = 防黑屏 bug（D2 真机踩坑沉淀）

if (!isBootAsk && !isRewardAsk) return null;

if (isBootAsk) {
  return <新美术版（PNG + 透明 hit area + TTS）/>;
}

// 否则 reward askMode：旧 UI
return <旧 CSS 版（CountdownRing + 两按钮文案 "继续出航/返舱"）/>;
```

## 代码

[apps/web/src/scenes/AskMode.tsx](../../../../2-Projects/P003GameDemo20260513/apps/web/src/scenes/AskMode.tsx)
