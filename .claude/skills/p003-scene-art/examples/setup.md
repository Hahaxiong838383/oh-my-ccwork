# SetupGuide 实施案例（V1.0 · 2026-05-14 D3.5）

## 特殊点

- **没有 boot-machine 集成的按钮**：完成配网走 DebugBar 调试条触发（demo 设计）
- **视频过渡**：点完成配网后播 `setup-success.mp4`，视频 `onEnded` 派发 `SETUP_DONE`
- **字幕条注释**：第一版有 PNG + 代码双字幕，川哥决定只保留 PNG 字幕（代码字幕注释保留以备恢复）
- **无表情屏绿光**：PNG 里小可没有表情屏特写，省略此层

## 状态机集成

```ts
// store/app-store.ts 加 flag
setupVideoRequested: boolean;
setSetupVideoRequested: (b: boolean) => void;

// DebugBar 完成配网按钮 onClick：
const client = getSharedVoiceClient();
void client.unlockAudio();              // ⚠️ 用户手势栈内解锁 AudioContext
void client.connect(getVoiceWsUrl());   // 预连 ws
if (bootState === 'unconfigured') {
  store.setSetupVideoRequested(true);   // 触发 SetupGuide 切到 video phase
} else {
  store.setSetupComplete(true);
  dispatchBoot({ type: 'SETUP_DONE' });
}

// SetupGuide 内部：
if (videoRequested) {
  return <video src={SETUP_SUCCESS_VIDEO} autoPlay muted playsInline onEnded={handleVideoDone} />;
}
return <img src={SETUP_BG} />;  // PNG 配网界面

// handleVideoDone：
store.setSetupComplete(true);
store.setSetupVideoRequested(false);  // reset
dispatchBoot({ type: 'SETUP_DONE' });
```

## 资产

- `apps/web/public/assets/setup-bg.png` (800×480，小可在飞船驾驶舱"正在连接设备"画面)
- `apps/web/public/assets/setup-success.mp4` (~590KB，配网成功过渡动画)

## 代码

[apps/web/src/scenes/SetupGuide.tsx](../../../../2-Projects/P003GameDemo20260513/apps/web/src/scenes/SetupGuide.tsx)
