# State Machine (XState v5)

详细图见 [`docs/03-state-machine.md`](../../../../docs/03-state-machine.md)。

## 4 个机器

- `boot-machine.ts`：开机/欢迎/夜航/开箱/解锁/状态询问
- `focus-machine.ts`：专注/暂离/二次确认
- `reward-machine.ts`：开箱队列 + 生态缸解锁动画
- `voice-machine.ts`：唤醒/listening/parsing/confirm

## root-machine.ts（顶层编排）

将 4 个机器组合，处理跨机器事件、持久化 + hydrate。

**实现节奏**：M1 加机器骨架（仅 state + event 定义），M3-M6 各自填业务。
