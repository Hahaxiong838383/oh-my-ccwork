/**
 * 会话归属管理
 *
 * 维护 sessionId → channelId 的映射关系，实现飞书通道级会话隔离。
 * 数据存储在 ~/.claude/projects/{encodedPath}/channel-sessions.json
 *
 * 设计原则：
 * - 内存缓存：首次 load 后走缓存，避免频繁磁盘读取
 * - 原子写入：temp + rename，并发安全
 * - 向后兼容：无归属记录的老会话对所有通道可见
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "fs";
import { join, dirname } from "path";
import { getHistoryDir } from "./history.js";

interface OwnershipData {
  version: 1;
  sessions: Record<string, string>; // sessionId → channelId
}

export class SessionOwnership {
  private filePath: string;
  private cache: Map<string, string> | null = null;

  constructor(cwd: string) {
    this.filePath = join(getHistoryDir(cwd), "channel-sessions.json");
  }

  /**
   * 从磁盘加载归属数据（仅首次调用时读盘，之后走缓存）
   */
  private load(): Map<string, string> {
    if (this.cache) return this.cache;

    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data: OwnershipData = JSON.parse(raw);
        if (data.version === 1 && data.sessions) {
          this.cache = new Map(Object.entries(data.sessions));
          return this.cache;
        }
        console.warn("[SessionOwnership] 文件格式不匹配:", { version: data.version, hasSessions: !!data.sessions });
      }
    } catch (err) {
      console.error("[SessionOwnership] 加载失败，回退为空映射:", err);
    }

    this.cache = new Map();
    return this.cache;
  }

  /**
   * 原子写入归属数据到磁盘（temp + rename）
   */
  private save(): void {
    const map = this.load();
    const data: OwnershipData = {
      version: 1,
      sessions: Object.fromEntries(map),
    };

    // temp 文件写在目标同目录，保证同一文件系统，rename 不会 EXDEV
    const dir = dirname(this.filePath);
    const tmpPath = join(dir, `.channel-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* ignore orphan cleanup failure */ }
      console.error("[SessionOwnership] 保存失败:", err);
    }
  }

  /**
   * 注册会话归属（幂等，不抢占已被其他通道占用的会话）
   * 返回 true 表示成功，false 表示被其他通道占用
   */
  claim(sessionId: string, channelId: string): boolean {
    const map = this.load();
    const existing = map.get(sessionId);
    if (existing === channelId) return true; // 幂等
    if (existing && existing !== channelId) {
      console.warn(`[SessionOwnership] claim 被拒绝: ${sessionId} 已属于 ${existing}，${channelId} 不能抢占`);
      return false;
    }
    map.set(sessionId, channelId);
    this.save();
    console.log(`[SessionOwnership] claim: ${sessionId} → ${channelId}`);
    return true;
  }

  /**
   * 查询会话归属，null 表示无标记（老会话）
   */
  getOwner(sessionId: string): string | null {
    return this.load().get(sessionId) ?? null;
  }

  /**
   * 判断某会话对某通道是否可见
   * - 无归属记录 → 对所有通道可见
   * - 归属匹配 → 可见
   * - 归属不匹配 → 不可见
   */
  isVisibleTo(sessionId: string, channelId: string): boolean {
    const owner = this.getOwner(sessionId);
    return owner === null || owner === channelId;
  }

  /**
   * 过滤列表，只保留对指定通道可见的条目
   * 泛型兼容 ConversationSummary 和 SearchResult（都有 sessionId 字段）
   */
  filterForChannel<T extends { sessionId: string }>(list: T[], channelId: string): T[] {
    return list.filter(item => this.isVisibleTo(item.sessionId, channelId));
  }
}
