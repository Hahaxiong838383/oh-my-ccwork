/**
 * hot-patch.ts — JSONL 热补丁读写
 *
 * 存储在 data/hot-patches.jsonl，active 状态的规则注入 system prompt。
 * 用途：快速注入/撤回事实，无需改 memory-items.md。
 */

import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export interface HotPatch {
  id: string;
  rule: string;
  active: boolean;
  created: string;
}

function getPatchPath(brainRoot: string): string {
  return join(brainRoot, "data", "hot-patches.jsonl");
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readAllPatches(brainRoot: string): HotPatch[] {
  const p = getPatchPath(brainRoot);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
  const patches: HotPatch[] = [];
  for (const line of lines) {
    try { patches.push(JSON.parse(line)); } catch { /* skip bad lines */ }
  }
  return patches;
}

export function loadActivePatches(brainRoot: string): string[] {
  return readAllPatches(brainRoot)
    .filter((p) => p.active)
    .map((p) => p.rule);
}

export function addPatch(brainRoot: string, rule: string): HotPatch {
  const p = getPatchPath(brainRoot);
  ensureDir(p);
  const patch: HotPatch = {
    id: `hp-${Date.now().toString(36)}`,
    rule,
    active: true,
    created: new Date().toISOString(),
  };
  appendFileSync(p, JSON.stringify(patch) + "\n");
  return patch;
}

export function togglePatch(brainRoot: string, id: string, active: boolean): boolean {
  const patches = readAllPatches(brainRoot);
  const target = patches.find((p) => p.id === id);
  if (!target) return false;
  target.active = active;
  const p = getPatchPath(brainRoot);
  writeFileSync(p, patches.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return true;
}

export function deletePatch(brainRoot: string, id: string): boolean {
  const patches = readAllPatches(brainRoot);
  const filtered = patches.filter((p) => p.id !== id);
  if (filtered.length === patches.length) return false;
  const p = getPatchPath(brainRoot);
  writeFileSync(p, filtered.map((x) => JSON.stringify(x)).join("\n") + (filtered.length ? "\n" : ""));
  return true;
}

export function listPatches(brainRoot: string): HotPatch[] {
  return readAllPatches(brainRoot);
}
