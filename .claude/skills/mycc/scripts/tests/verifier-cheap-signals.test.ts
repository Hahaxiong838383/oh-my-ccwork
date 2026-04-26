/**
 * Verifier cheap-signals 单测
 *
 * 验证 0-token 短路逻辑：exit code / stderr / 历史成功率 / 振荡 / churn
 */

import { describe, it, expect } from "vitest";
import { checkCheapSignals } from "../src/services/verifier/cheap-signals";

describe("verifier · cheap-signals", () => {
  const cwd = process.cwd();

  it("exit code 非 0 → 立即拒绝", () => {
    const r = checkCheapSignals({ exitCode: 1 }, cwd);
    expect(r.decisive).toBe(true);
    expect(r.accepted).toBe(false);
    expect(r.confidence).toBe(1.0);
    expect(r.hits).toContain("exit-code-nonzero");
  });

  it("exit code 0 + 无其他信号 → 不决断", () => {
    const r = checkCheapSignals({ exitCode: 0 }, cwd);
    expect(r.decisive).toBe(false);
  });

  it("stderr 含 Error → 拒绝", () => {
    const r = checkCheapSignals({ stderr: "Error: something failed" }, cwd);
    expect(r.decisive).toBe(true);
    expect(r.accepted).toBe(false);
    expect(r.hits).toContain("stderr-error-marker");
  });

  it("stderr 含 Traceback → 拒绝", () => {
    const r = checkCheapSignals({ stderr: "Traceback (most recent call last):" }, cwd);
    expect(r.decisive).toBe(true);
    expect(r.accepted).toBe(false);
  });

  it("stderr 仅 warning → 不决断", () => {
    const r = checkCheapSignals({ stderr: "warning: deprecated API" }, cwd);
    expect(r.decisive).toBe(false);
  });

  it("空 evidence → 不决断", () => {
    const r = checkCheapSignals({}, cwd);
    expect(r.decisive).toBe(false);
    expect(r.hits).toEqual([]);
  });

  it("命令注入字符在 file 名里不应崩溃", () => {
    const r = checkCheapSignals({ files: ['evil"; rm -rf /;.ts'] }, cwd);
    expect(r.decisive).toBe(false);
  });

  it("不存在的 skillTag → 不决断（避免冤枉新 skill）", () => {
    const r = checkCheapSignals({ skillTag: "totally-new-skill-xyz-123" }, cwd);
    expect(r.decisive).toBe(false);
  });

  it("stderr 含 Segmentation fault → 拒绝", () => {
    const r = checkCheapSignals({ stderr: "Segmentation fault (core dumped)" }, cwd);
    expect(r.decisive).toBe(true);
    expect(r.accepted).toBe(false);
  });
});
