# Welcome 实施案例（V1.0 · 2026-05-14 D3.5）

## 特殊点

- **3 轻动效全部启用**：星点 + 表情屏绿光 + 字幕光晕（最完整模板）
- **舷窗范围广**：图里舷窗占画布上半 60-70%，6 颗星点 + clipPath 大椭圆
- **字幕条必要**：图里没烧文案，代码渲染"你好，指挥官！欢迎回到方舟"+ 暖白光晕呼吸
- **4 秒窗口**：boot-machine `WELCOME_ANIM_MS = 4000`，4s 后跳 nightReport

## 关键参数（800×480 画布）

```ts
// 星点：6 颗散布在左右舷窗
const STARS: readonly StarSpec[] = [
  { id: 's1', left: '14cqw', top: '14cqh', size: '1.1cqw', delay: '-1.2s', duration: '3.4s', drift: '4cqw' },
  { id: 's2', left: '22cqw', top: '24cqh', size: '0.8cqw', delay: '-0.3s', duration: '3.8s', drift: '-3.2cqw' },
  { id: 's3', left: '26cqw', top: '9cqh', size: '1cqw', delay: '-2.0s', duration: '3.1s', drift: '3.5cqw' },
  { id: 's4', left: '72cqw', top: '13cqh', size: '1cqw', delay: '-0.7s', duration: '3.3s', drift: '-3.8cqw' },
  { id: 's5', left: '80cqw', top: '23cqh', size: '0.8cqw', delay: '-2.4s', duration: '3.6s', drift: '3cqw' },
  { id: 's6', left: '86cqw', top: '10cqh', size: '1.1cqw', delay: '-1.5s', duration: '3.0s', drift: '-4cqw' },
];

// clipPath: 中心 (50%, 32%) 半径 (42%, 36%)
clipPath: 'ellipse(42% 36% at 50% 32%)'

// 表情屏绿光：中心 (53cqw, 41cqh)
left: '46cqw', top: '34cqh', width: '15cqw', height: '13cqh'

// 字幕条：bottom 6cqh / 暖白光晕
text-shadow: 0 0 10px rgba(255,255,255,0.55), 0 0 22px rgba(255,240,210,0.32);
```

## TTS 文案

`'你好，指挥官！欢迎回到方舟'`

## 状态机集成

```ts
const isActive = useAppStore((s) => s.bootState === 'welcome');
// 进入：boot-machine 收到 SETUP_DONE → state='welcome' + startTimer welcome(4000ms)
// 离开：4s 后 timer-router 派发 WELCOME_END → state='nightReport'
```

## 代码

[apps/web/src/scenes/Welcome.tsx](../../../../2-Projects/P003GameDemo20260513/apps/web/src/scenes/Welcome.tsx)
