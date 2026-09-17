#!/usr/bin/env python3
"""一次只读采集；无变化只写日报，有变化才调用 Codeg Luna。stdlib only."""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from zoneinfo import ZoneInfo

from gate_policy import analyze, decide

HERE = Path(__file__).resolve().parent
TZ = ZoneInfo("Asia/Shanghai")
KEYS = (
    "project_feishu_grok_h_byos",
    "feedback_tenant_capability_drift_mechanism",
    "feedback_identifier_shape_is_not_identity",
    "feedback_concurrent_sessions_shared_checkout",
)
PURPOSES = ("H平台情况", "租户差异", "Bot身份", "共享工作区")
TERMINAL = {"succeeded", "failed", "cancelled", "skipped"}


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(value: dt.datetime | None = None) -> str:
    return (value or now()).isoformat().replace("+00:00", "Z")


def stamp(value: str | None) -> dt.datetime | None:
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else None
    except (TypeError, ValueError):
        return None


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def atomic(path: Path, value) -> None:
    """只替换本组件明确拥有的文件；私有权限、同目录 rename。"""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    content = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    fd, name = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def tail_excerpt(text: str, budget: int) -> dict:
    lines = text.splitlines()
    picked: list[str] = []
    used = 0
    for line in reversed(lines):
        if used + len(line) + 1 > budget:
            if not picked:
                return {"text": line[:budget], "lineStart": len(lines), "lineEnd": len(lines), "truncated": True}
            break
        picked.append(line)
        used += len(line) + 1
    return {"text": "\n".join(reversed(picked)), "lineStart": len(lines) - len(picked) + 1,
            "lineEnd": len(lines), "truncated": len(picked) < len(lines)}


def memory_bundle(directory: Path, previous_sources: list[dict] | None = None) -> tuple[list[dict], str, list[str]]:
    """Bounded excerpts with honest change coverage, never imply full recall.

    Comparing full-content hashes detects changes outside the tail as well.
    A changed truncated document always has unknown change coverage: a changed
    tail cannot prove that the omitted beginning stayed unchanged. The caller
    saves the source metadata only after a successful explanation, so failed
    runs retain this warning on retry without caching full memory documents.
    """
    sources, errors = [], []
    previous = {s.get("key"): s for s in (previous_sources or [])
                if isinstance(s, dict) and isinstance(s.get("key"), str)} if isinstance(previous_sources, list) else {}
    for key, purpose in zip(KEYS, PURPOSES):
        path = directory / (key + ".md")
        try:
            raw = path.read_text(encoding="utf-8")
            source_hash = digest(raw)
            excerpt = tail_excerpt(raw, 3800 if key == KEYS[0] else 1600)
            excerpt_hash = digest(excerpt["text"])
            prior = previous.get(key)
            changed = source_hash != prior.get("sha256") if prior is not None else None
            excerpt_changed = excerpt_hash != prior.get("excerptSha256") if prior is not None else None
            partial = excerpt["truncated"]
            if changed and partial:
                errors.append("记忆源已变化但摘录未完整覆盖：" + key + "；变更覆盖未确认，需人工定向复核，不据此声称已读全量变更")
            # For a single oversized line, part of line 1 is omitted; do not
            # manufacture an empty range just because the excerpt starts there.
            omitted = {"lineStart": 1, "lineEnd": max(1, excerpt["lineStart"] - 1)} if partial else None
            sources.append({"key": key, "purpose": purpose, "source": str(path),
                            "sha256": source_hash, "mtime": iso(dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc)),
                            "excerpt": excerpt, "excerptSha256": excerpt_hash,
                            "coverage": "tail_only" if partial else "full",
                            "omittedLineRange": omitted, "sourceChanged": changed,
                            "excerptChanged": excerpt_changed,
                            "changedContentCovered": None if partial else True})
        except (OSError, UnicodeError):
            errors.append("记忆源缺失或不可读：" + key)
            sources.append({"key": key, "purpose": purpose, "source": str(path), "missing": True})
    signature = digest(json.dumps([(s["key"], s.get("sha256")) for s in sources]))
    return sources, signature, errors


def validate_capture(report, started: dt.datetime, ended: dt.datetime, returncode: int) -> dict:
    if not isinstance(report, dict):
        return failure_report("采集未返回 JSON 对象", ended)
    report = dict(report)
    checked = stamp(report.get("checkedAt"))
    problems = []
    if checked is None or not (started - dt.timedelta(seconds=2) <= checked <= ended + dt.timedelta(seconds=5)):
        problems.append("报告时间不属于本次采集窗口，禁止复用旧状态")
    if report.get("schemaVersion") != 2:
        problems.append("探针 schemaVersion 非2")
    # --systemd WARNING exit0; CRITICAL can yield systemctl exit1.
    if returncode and report.get("status") != "CRITICAL":
        problems.append("采集进程非零退出且不是新鲜CRITICAL结果")
    if report.get("reportError"):
        problems.append("探针报告读取失败")
    if problems:
        report["reportError"] = "；".join(problems)
    return report


def failure_report(message: str, when: dt.datetime | None = None) -> dict:
    return {"schemaVersion": 2, "checkedAt": iso(when), "status": "UNKNOWN", "reportError": message,
            "issues": [], "levels": {"critical": 0, "warning": 0, "info": 0}, "summary": {}}


def collect(wrapper: str) -> dict:
    started = now()
    env = {k: v for k, v in os.environ.items() if not k.startswith("H_PLATFORM_DAILY_")}
    try:
        proc = subprocess.run([wrapper], capture_output=True, text=True, env=env, timeout=330, check=False)
        report = json.loads(proc.stdout.strip())
        return validate_capture(report, started, now(), proc.returncode)
    except subprocess.TimeoutExpired:
        # Never re-run the collector on timeout. The underlying oneshot may still be finishing.
        return failure_report("固定采集入口超过330秒，未重跑；底层采集是否完成未确认")
    except (OSError, ValueError):
        return failure_report("固定采集入口失败或输出不是完整JSON，未重跑")


class Codeg:
    def __init__(self, config: dict):
        self.config = config
        self.base = config["api_url"].rstrip("/") + "/api/"
        if self.base != "http://127.0.0.1:3080/api/":
            raise ValueError("Codeg API 必须是批准的本机入口")

    def call(self, method: str, payload: dict):
        token = Path(self.config["token_file"]).read_text().strip()
        request = urllib.request.Request(self.base + method, json.dumps(payload).encode(),
                                         {"Content-Type": "application/json", "Authorization": "Bearer " + token})
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"Codeg {method}: HTTP {exc.code}（响应正文未输出）") from None
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"Codeg {method}: {type(exc).__name__}（未输出凭据）") from None

    def runs(self):
        return self.call("automation_runs", {"automationId": self.config["automation_id"], "limit": 30})

    def check_config(self):
        a = self.call("automation_get", {"id": self.config["automation_id"]})
        fields = {"trigger_kind": "manual", "cron": None, "next_run_at": None, "enabled": True,
                  "agent_type": "codex", "root_folder_id": self.config["root_folder_id"],
                  "isolation": "shared_in_root", "branch": None}
        for key, value in fields.items():
            if a.get(key) != value:
                raise RuntimeError("Codeg 配置漂移，未覆盖用户改动：" + key)
        c = a.get("config") or {}
        if c.get("config_values", {}).get("model") != "gpt-5.6-luna":
            raise RuntimeError("任务模型不是Luna，拒绝自动改回")
        blocks = c.get("prompt_blocks") or []
        if len(blocks) != 1 or digest(blocks[0].get("text", "")) != self.config["expected_prompt_sha256"]:
            raise RuntimeError("任务prompt已变化，拒绝覆盖")
        return a


def wait_run(api: Codeg, run_id: int, seconds: int = 600, *, owned: bool = True):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        item = next((r for r in api.runs() if r["id"] == run_id), None)
        if item and item.get("status") in TERMINAL:
            return item
        time.sleep(5)
    if not owned:
        raise RuntimeError(f"Luna run {run_id} 超过{seconds}秒；启动回执不确定、归属未确认，未取消也未重发，请人工核对")
    # Exact run acknowledged by run_now only; never kill Codeg or another session.
    api.call("automation_cancel_run", {"runId": run_id})
    raise RuntimeError(f"Luna run {run_id} 超过{seconds}秒；已请求取消本次运行，日报仍保留采集结果")


def dispatch(api: Codeg, workspace: Path, packet: dict, state_path: Path, state: dict) -> dict:
    api.check_config()
    before = api.runs()
    if any(r.get("status") in ("running", "queued", "pending") for r in before):
        raise RuntimeError("同一巡检任务已有运行，未覆盖CURRENT快照；本次留待重试")
    atomic(workspace / "CURRENT.json", packet)
    known_ids = {r["id"] for r in before}
    state["dispatchStartedAt"] = iso()
    state["retryNeeded"] = True
    atomic(state_path, state)
    owned = True
    try:
        run_id = api.call("automation_run_now", {"automationId": api.config["automation_id"]})
    except RuntimeError:
        # POST timeout is ambiguous: observe, never replay it.
        candidates = [r for r in api.runs() if r["id"] not in known_ids and r.get("status") != "skipped"]
        if len(candidates) != 1:
            raise RuntimeError("Codeg启动回执不确定，未重发run_now；请核对自动化运行记录") from None
        run_id = candidates[0]["id"]
        owned = False
    if type(run_id) is not int or run_id <= 0:
        raise RuntimeError("Codeg未给整数runId，未重复触发")
    state["pendingRunId"] = run_id
    atomic(state_path, state)
    run = wait_run(api, run_id, owned=owned)
    if run.get("status") != "succeeded" or not run.get("summary"):
        raise RuntimeError(f"Luna run {run_id} 未完成报告：{run.get('status', 'unknown')}")
    conv = api.call("get_folder_conversation", {"conversationId": run["conversation_id"], "tailTurns": 1})
    if conv.get("summary", {}).get("model") != "gpt-5.6-luna":
        raise RuntimeError("实际会话模型不是Luna，未将其计为验收成功")
    return {"runId": run_id, "conversationId": run["conversation_id"], "status": run["status"],
            "model": conv["summary"]["model"], "externalId": conv["summary"].get("external_id"),
            "endedAt": run["ended_at"], "report": run["summary"], "usage": conv.get("session_stats")}


def markdown(packet: dict, outcome: dict | None, error: str | None = None) -> str:
    report, decision = packet["report"], packet["decision"]
    summary = report.get("summary") if isinstance(report.get("summary"), dict) else {}
    checked = stamp(report.get("checkedAt"))
    checked_label = checked.astimezone(TZ).strftime("%Y-%m-%d %H:%M:%S") if checked else "未确认"
    levels = report.get("levels") if isinstance(report.get("levels"), dict) else {}
    lines = ["# H 平台每日巡检", "", f"采集时间：{checked_label}（北京时间）", ""]
    if error:
        lines += ["**采集结果已保存，但 AI 解读/调度未完成，需要人工关注。**", "", error, ""]
    elif report.get("reportError"):
        lines += ["**巡检未完成，平台状态未获确认。**", "", str(report["reportError"]), ""]
    elif outcome:
        lines += [f"本次由 Luna 解读：[Codeg 会话 {outcome['conversationId']}](codeg://session/{outcome['conversationId']})", "", outcome["report"], ""]
    else:
        pending = len(packet["interpretation"].get("actionable") or [])
        lines += ["**与上次相比无需要新增解读的变化；本次未调用模型、未新建会话。**", "",
                  (f"仍有 {pending} 类记录待关注，详见下面既有项；这不等于全平台无待办。" if pending else "已知测试差异与合法个性化保留，不自动追平。"), ""]
    if not outcome:
        release = summary.get("controlRelease") if isinstance(summary.get("controlRelease"), dict) else {}
        egress = "受测出口正常" if summary.get("egressOk") is True else ("受测出口不通" if summary.get("egressOk") is False else "未确认")
        lines += ["## 运行概况与已知项", "", "| 检查项 | 人话结果 | 技术对应 |", "|---|---|---|",
                  f"| 机器人连接 | {summary.get('connected', '未知')}/{summary.get('apps', '未知')} 已连接 | connected/apps |",
                  f"| 模型出口 | {egress} | egressOk |",
                  f"| 发布文件 | {release.get('state', '未确认')}，差异 {release.get('mismatchCount', '未知')} | controlRelease |",
                  f"| 记忆检查 | 检查 {summary.get('memoryChecked', '未知')}，不达标 {summary.get('memoryBad', '未知')} | memory |", ""]
        issues = report.get("issues") if isinstance(report.get("issues"), list) else []
        for issue in issues:
            if not isinstance(issue, dict):
                lines.append("- 探针条目结构未知，需人工核实，未当作正常。")
                continue
            code = issue.get("code", "unknown")
            if code == "orphan_recovery_pending":
                d = issue.get("details") if isinstance(issue.get("details"), dict) else {}
                values = [d.get(k) for k in ("total", "live", "liveUnknown")]
                valid = all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in values) and values[0] >= sum(values[1:])
                text = f"恢复记录共{values[0]}条，其中运行中{values[1]}、状态未知{values[2]}，确认未运行{values[0]-values[1]-values[2]}。" if valid else "恢复记录的存活信息不完整，待处置数未确认。"
            elif code == "tenant_parity_notes":
                text = "合法个人增量，保留。"
            elif code == "tenant_parity_lag" and any(
                item.get("code") == code for item in packet["interpretation"].get("known", [])
            ):
                text = "已知测试差异，保留，不覆盖。"
            else:
                text = str(issue.get("message") or "待核对").replace("\n", " ")[:240]
            lines.append(f"- {text}（`{code}`，{issue.get('level', '未知')}）")
        lines += ["", "## 技术依据", "", f"原始分级 `{report.get('status','UNKNOWN')}`：critical={levels.get('critical','未知')}、warning={levels.get('warning','未知')}、info={levels.get('info','未知')}。", ""]
    lines += ["本次分流原因：" + "、".join(decision.get("reasons") or ["无变化"]), "",
              "记忆依据：脚本核对四源指纹并生成定向摘录，不代表模型逐日重读全文。", ""]
    for source in packet["memory"]:
        lines.append(f"- {source['purpose']}：`{source['key']}`，" + ("未命中" if source.get("missing") else f"SHA `{source['sha256'][:12]}`"))
    lines += ["", "只读采集；无自动修复、租户覆盖、重启或外发。", "", f"记录时间：{now().astimezone(TZ).strftime('%Y-%m-%d %H:%M:%S')}（北京时间）", ""]
    return "\n".join(lines)


def publish(workspace: Path, run_dir: Path, content: str, day: str) -> None:
    atomic(run_dir / "report.md", content)
    daily = workspace / "daily" / day[:7] / (day + ".md")
    atomic(daily, content)
    atomic(workspace / "latest.md", content)
    files = sorted((workspace / "daily").glob("*/*.md"), reverse=True)
    lines = ["# H 平台巡检报告索引", "", "每天07:00（北京时间）采集。平稳日只落盘；变化、严重、未知或失败时由Luna解释。", "",
             "[最新日报](latest.md)｜[按月历史](daily/)", "", "## 最近30次日报", ""]
    lines += [f"- [{p.stem}]({p.relative_to(workspace).as_posix()})" for p in files[:30]]
    lines += ["", "更早报告保留在 daily/ 月目录，不自动删除旧会话或日志。", ""]
    atomic(workspace / "index.md", "\n".join(lines))


def notify_failure(message: str):
    # Local desktop only, never Feishu or another external notification.
    try:
        subprocess.run(["notify-send", "-u", "critical", "H巡检调度未完成", message[:250]],
                       capture_output=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        pass


def run(config: dict, force: bool = False) -> dict:
    state_dir, workspace = Path(config["state_dir"]), Path(config["workspace"])
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state_dir / "gate.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("另一轮门控尚在运行；本轮未采集、未创建会话") from None
        state_path = state_dir / "state.json"
        try:
            state = read_json(state_path, {})
        except (ValueError, OSError):
            state = {"retryNeeded": True, "stateReadError": "门控状态不可读，按首次/未知处理"}
        if not isinstance(state, dict):
            state = {"retryNeeded": True}
        for key in ("report", "analysis"):
            if key in state and not isinstance(state[key], dict):
                state[key] = {}
                state["retryNeeded"] = True
        report = collect(config["wrapper"])
        current = analyze(report)
        sources, source_sig, source_errors = memory_bundle(Path(config["memory_dir"]), state.get("memorySources"))
        try:
            rule_text = (HERE / "lean" / "rules.md").read_text()
        except (OSError, UnicodeError):
            rule_text = "判读规则文件不可读：只报告采集事实与未知，不执行命令、不修复、不写文件、不外发；请人工恢复判读规则。"
            source_errors.append("判读规则文件不可读，当前判读能力未确认")
        # Changes in rules or canonical sources must never silently inherit old conclusions.
        source_sig = digest(source_sig + digest(rule_text))
        decision = decide(current, state.get("analysis"), state.get("lastAiAt"), now(),
                          sources_changed=source_sig != state.get("sourceSignature"),
                          force=force or bool(state.get("retryNeeded")) or bool(source_errors))
        if source_errors:
            decision["invoke"] = True
            decision["reasons"].extend(source_errors)
        rid = now().astimezone(TZ).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
        packet = {"schemaVersion": 1, "runKey": rid, "collectedAt": report.get("checkedAt"),
                  "report": report, "interpretation": {k: current.get(k) for k in ("effectiveCritical", "unknown", "actionable", "known", "recovery")},
                  "decision": decision, "memory": sources, "memoryErrors": source_errors, "rules": rule_text,
                  "previousCheckedAt": (state.get("report") or {}).get("checkedAt"),
                  "previousSignature": (state.get("analysis") or {}).get("signature")}
        run_dir = workspace / "runs" / rid
        atomic(run_dir / "input.json", packet)
        day = now().astimezone(TZ).date().isoformat()
        outcome, error = None, None
        # Save an honest preliminary report even if dispatch blocks or the process later dies.
        preliminary = "模型解读等待中（尚未完成）" if decision["invoke"] else None
        publish(workspace, run_dir, markdown(packet, None, preliminary), day)
        try:
            api = Codeg(config)
            api.check_config()  # Even quiet days detect unexpected schedule/model changes.
            if decision["invoke"]:
                outcome = dispatch(api, workspace, packet, state_path, state)
                atomic(run_dir / "ai-result.json", outcome)
                state["lastAiAt"] = outcome["endedAt"]
                state["pendingRunId"] = None
            state.update({"analysis": current, "report": {"checkedAt": report.get("checkedAt"), "status": report.get("status")},
                          "sourceSignature": source_sig, "memorySources": sources,
                          "retryNeeded": False, "lastRunKey": rid, "lastSuccessAt": iso()})
            state.pop("lastError", None)
        except Exception as exc:
            error = str(exc) if isinstance(exc, RuntimeError) else f"门控失败：{type(exc).__name__}（敏感细节未输出）"
            state["retryNeeded"] = True
            state["lastError"] = error
            notify_failure(error)
        atomic(state_path, state)
        content = markdown(packet, outcome, error)
        publish(workspace, run_dir, content, day)
        result = {"runKey": rid, "checkedAt": report.get("checkedAt"), "invoke": decision["invoke"],
                  "reasons": decision["reasons"], "error": error, "report": str(workspace / "latest.md"),
                  "inputBytes": (run_dir / "input.json").stat().st_size,
                  "ai": {k: outcome.get(k) for k in ("runId", "conversationId", "model", "usage")} if outcome else None}
        atomic(state_dir / "last-result.json", result)
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path.home() / ".config/h-platform-daily-gate.json")
    parser.add_argument("--run", action="store_true", help="一次真实采集及条件解读")
    parser.add_argument("--force-ai", action="store_true", help="验收用，强制本轮解读；不额外采集")
    parser.add_argument("--check", action="store_true", help="只读检查正式API配置，不采集/触发")
    args = parser.parse_args()
    try:
        config = read_json(args.config)
        if args.check:
            a = Codeg(config).check_config()
            print(json.dumps({"ok": True, "automationId": a["id"], "model": a["config"]["config_values"]["model"]}))
            return 0
        if not args.run:
            parser.error("明确选择 --run 或 --check")
        result = run(config, force=args.force_ai)
        print(json.dumps(result, ensure_ascii=False))
        return 1 if result["error"] else 0
    except Exception as exc:
        message = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        notify_failure("门控未完成：" + message)
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
