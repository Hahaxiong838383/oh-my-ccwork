/**
 * Scene Plugin 清单
 *
 * 设计动机：V1.60+ 要加入 AI AVG / AI 编程 / AI 故事等全新 scene 类型（来自 3.10/3.11/3.14）。
 * 不能让 `Screen.tsx` 走 hardcoded switch case，否则每加一个 scene 改一处路由 = 架构腐烂。
 *
 * 改为 plugin 模式：每个 scene 自带 manifest 注册到这里，路由器消费 manifest。
 *
 * V1.0 demo 只用静态 5 个 scene，但 plugin 模式就位 = V1.60 加 AVG 不返工。
 */

import type { ReactNode } from 'react';

export interface SceneManifest {
  /** 唯一 ID */
  id: string;
  /** 由哪些顶层状态触发挂载 */
  enterStates: string[];
  /** 渲染入口 */
  render: () => ReactNode;
  /** 版本号（plugin 升级用） */
  version: string;
  /** 是否核心 scene（核心 scene 不可被 disable） */
  core: boolean;
}

const registry = new Map<string, SceneManifest>();

export function registerScene(m: SceneManifest): void {
  if (registry.has(m.id)) {
    console.warn(`scene ${m.id} already registered, overriding`);
  }
  registry.set(m.id, m);
}

export function getSceneForState(state: string): SceneManifest | null {
  for (const m of registry.values()) {
    if (m.enterStates.includes(state)) return m;
  }
  return null;
}

export function listScenes(): SceneManifest[] {
  return Array.from(registry.values());
}
