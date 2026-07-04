// 记忆面板数据层：/api/memory 系列 fetch 封装（Bearer token 鉴权）+ useMemoryData 轮询 hook。
// hook 职责：首拉 + 10s 轮询 + 手动 refresh；diff 检测新记忆 → pushDebug 调试流事件 + newIds 高亮 3s；卸载即停。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useKidsHubStore } from '../../store/kidshub-store';
import { TYPE_META } from './types';
import type { MemoryApiResponse, MemoryTypeKey } from './types';

/** POST /api/memory 请求体（手动添加，演示预埋） */
export interface AddMemoryBody {
  type: MemoryTypeKey;
  content: string;
  subject?: string;
  due_text?: string;
}

/** 统一请求封装：带 token 鉴权 + JSON 解析 + 非 2xx 抛错（范式对齐 KidsHubApp 的 /api/profile） */
async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchMemory(token: string): Promise<MemoryApiResponse> {
  return request<MemoryApiResponse>('/api/memory', token);
}

export function addMemory(token: string, body: AddMemoryBody): Promise<{ ok: boolean; added: number }> {
  return request('/api/memory', token, { method: 'POST', body: JSON.stringify(body) });
}

export function deleteMemory(token: string, id: string): Promise<{ ok: boolean; deleted: boolean }> {
  return request(`/api/memory/${encodeURIComponent(id)}`, token, { method: 'DELETE' });
}

export function resolveMemory(token: string, id: string): Promise<{ ok: boolean; resolved: boolean }> {
  return request(`/api/memory/${encodeURIComponent(id)}/resolve`, token, { method: 'POST' });
}

export function deleteInterest(token: string, value: string): Promise<{ ok: boolean; removed: boolean }> {
  return request(`/api/memory/interest/${encodeURIComponent(value)}`, token, { method: 'DELETE' });
}

/** 轮询间隔（tab 激活期间才 mount，离开即卸载停轮询） */
const POLL_MS = 10_000;
/** 新记忆条目在列表里的高亮时长 */
const NEW_HIGHLIGHT_MS = 3_000;

export interface MemoryDataState {
  data: MemoryApiResponse | null;
  loading: boolean;
  error: string | null;
  /** 手动刷新（添加/删除/标记兑现后调用） */
  refresh: () => Promise<void>;
  /** 本轮 diff 出的新条目 id（高亮 3s 后自动清空） */
  newIds: Set<string>;
}

export function useMemoryData(): MemoryDataState {
  const token = useKidsHubStore((s) => s.token);
  const pushDebug = useKidsHubStore((s) => s.pushDebug);
  const [data, setData] = useState<MemoryApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set());
  // 上次见过的 id 集合（null = 尚未完成首拉；首拉不算「新记忆」，不推调试流）
  const seenIdsRef = useRef<Set<string> | null>(null);
  // 卸载守卫：避免请求归来后 setState 到已卸载组件
  const aliveRef = useRef(true);
  const highlightTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      // 公开模式/未登录：不发请求，面板显示不可用提示
      setLoading(false);
      setError('未登录，记忆面板不可用');
      return;
    }
    try {
      const resp = await fetchMemory(token);
      if (!aliveRef.current) return;

      // diff 检测：非首拉时出现的新 id → 调试流「🧠 新记忆」事件 + 高亮集合
      const prev = seenIdsRef.current;
      if (prev) {
        const fresh = resp.items.filter((it) => !prev.has(it.id));
        if (fresh.length > 0) {
          for (const it of fresh) {
            pushDebug({
              kind: 'memory',
              title: `🧠 新记忆:${TYPE_META[it.type].label}`,
              detail: it.content,
            });
          }
          setNewIds(new Set(fresh.map((it) => it.id)));
          if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
          highlightTimerRef.current = window.setTimeout(() => {
            if (aliveRef.current) setNewIds(new Set());
          }, NEW_HIGHLIGHT_MS);
        }
      }
      seenIdsRef.current = new Set(resp.items.map((it) => it.id));

      setData(resp);
      setError(null);
    } catch (e) {
      if (!aliveRef.current) return;
      // 轮询偶发失败不清旧数据，只挂错误提示
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [token, pushDebug]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, POLL_MS);
    return () => {
      // 组件卸载（tab 切走）：停轮询 + 清高亮定时器
      aliveRef.current = false;
      window.clearInterval(timer);
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    };
  }, [load]);

  return { data, loading, error, refresh: load, newIds };
}
