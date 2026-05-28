#!/usr/bin/env python3
"""
gemma-direct.py - multica direct-ollama adapter (v2.3: 加 retry + health check)
模拟 opencode CLI 接口,跳过 agent loop 直调 Ollama,流式收 + batched emit stream-json

multica daemon 调用方式 (实测):
  gemma-direct.py run --format json --dangerously-skip-permissions --dir <workdir> --model <provider/model> <PROMPT>

v2.3 (2026-05-28):
- Ollama 启动前健康探测 (GET /api/tags, 5s),不可达直接 emit clear 错误 + 0 exit (让 daemon 写 comment)
- Ollama 调用失败 2 次 retry (5s/15s 间隔),区分网络瞬时 vs 永久错误
- 内部 stream=true 收 (TTFB 快),仍只在最后 emit 一次 (避免 v2.0 624KB comment 重蹈)
- TODO: 真 streaming 体感需调研 multica daemon stream-json 是否支持 same-part-id delta merge

设计要点:
- prompt 含 --output / --recent 等子串会被 argparse 当 flag 吃掉,直接 sys.argv[-1] 拿 prompt
- 提取 issue UUID + multica issue get 拿 description,跳过 multica 长 system prompt
- multica daemon 自动从 stream-json text events 提取写 comment,本脚本不自己写 comment
"""
import argparse
import json
import os
import re
import sys
import time
import uuid
import subprocess
from urllib import request as urlrequest
from urllib.error import URLError, HTTPError

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
MULTICA_BIN = os.path.expanduser("~/bin/multica")
OLLAMA_BASE = "http://127.0.0.1:11434"
OLLAMA_CHAT_URL = OLLAMA_BASE + "/v1/chat/completions"
OLLAMA_TAGS_URL = OLLAMA_BASE + "/api/tags"

# Retry 策略: 总尝试次数 = MAX_ATTEMPTS, 失败间隔取 RETRY_DELAYS[attempt-1]
MAX_ATTEMPTS = 3
RETRY_DELAYS = [5, 15]  # 第 1 次失败后等 5s,第 2 次后 15s
HEALTH_TIMEOUT = 5
OLLAMA_TIMEOUT = 600  # 单次 stream 调用上限 (Gemma 4 E4B prefill 长 prompt 可能需要)

# 可重试的网络/瞬时错误
RETRYABLE_EXCEPTIONS = (URLError, HTTPError, ConnectionError, TimeoutError, OSError)


def short_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


def now_ms():
    return int(time.time() * 1000)


def emit(ev):
    sys.stdout.write(json.dumps(ev, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def probe_ollama_health(timeout=HEALTH_TIMEOUT):
    """探 Ollama /api/tags,返回 (ok: bool, detail: str). 不抛异常."""
    try:
        req = urlrequest.Request(OLLAMA_TAGS_URL, method="GET")
        with urlrequest.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                return False, f"Ollama /api/tags HTTP {resp.status}"
            # 读 body 但不强校验内容 — 200 + 能 GET 已说明 Ollama 在
            _ = resp.read(1024)
            return True, "ok"
    except (URLError, HTTPError) as e:
        return False, f"Ollama 不可达 ({type(e).__name__}): {e}"
    except TimeoutError as e:
        return False, f"Ollama 健康探测超时 ({timeout}s)"
    except Exception as e:
        return False, f"Ollama 健康探测异常 ({type(e).__name__}): {e}"


def call_ollama_stream(model, user_prompt, timeout=OLLAMA_TIMEOUT):
    """流式调 Ollama,yield 文本 chunk。抛 RETRYABLE_EXCEPTIONS 由外层 retry。"""
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": user_prompt}],
        "stream": True,
    }
    req = urlrequest.Request(
        OLLAMA_CHAT_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=timeout) as resp:
        for line in resp:
            line = line.strip()
            if not line:
                continue
            if line.startswith(b"data: "):
                line = line[6:]
            if line == b"[DONE]":
                break
            try:
                chunk = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError:
                # 单 chunk 解码失败不应 abort 整个 stream
                continue
            choices = chunk.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            content = delta.get("content")
            if content:
                yield content


def call_ollama_with_retry(model, user_prompt):
    """
    包 call_ollama_stream + retry. 返回 (full_text: str, attempts_used: int, error: str | None).
    - 成功: (text, attempt, None)
    - 全部 attempts 失败: ("", MAX_ATTEMPTS, "最后错误描述")
    """
    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            full_text = ""
            for chunk in call_ollama_stream(model, user_prompt):
                full_text += chunk
            # 空响应 (Ollama 返回但 0 token) 算失败,触发 retry
            if not full_text.strip():
                last_error = "Ollama 返回空响应"
                if attempt < MAX_ATTEMPTS:
                    time.sleep(RETRY_DELAYS[attempt - 1])
                    continue
                return "", attempt, last_error
            return full_text, attempt, None
        except RETRYABLE_EXCEPTIONS as e:
            last_error = f"{type(e).__name__}: {e}"
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_DELAYS[attempt - 1])
                continue
            return "", attempt, last_error
        except Exception as e:
            # 不可重试: 编程错误 / KeyError 等,立即返回
            return "", attempt, f"{type(e).__name__}: {e} (不重试)"
    return "", MAX_ATTEMPTS, last_error or "unknown error"


def multica_issue_get(issue_id):
    try:
        out = subprocess.run(
            [MULTICA_BIN, "issue", "get", issue_id, "--output", "json"],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout
        idx = out.find("{")
        return json.loads(out[idx:]) if idx >= 0 else None
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
            json.JSONDecodeError, FileNotFoundError):
        return None


def strip_model_prefix(model):
    return model.split("/", 1)[1] if "/" in model else model


def build_user_prompt(raw_prompt):
    """从 raw_prompt 抽 issue UUID + 取 multica issue description, 失败则返回 raw_prompt."""
    m = UUID_RE.search(raw_prompt)
    if not m:
        return raw_prompt
    issue = multica_issue_get(m.group(0))
    if issue is None:
        return raw_prompt
    title = issue.get("title", "")
    description = issue.get("description", "")
    return (
        "请完成以下任务,直接给出结果,不需要工具调用。\n\n"
        f"标题: {title}\n\n详情:\n{description}"
    )


def parse_args_safely(argv):
    """
    argparse 在含 --output/--recent 子串的 prompt 上会乱解析,只用它解 model 等已知 flag,
    prompt 始终走 sys.argv[-1] fallback.
    """
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("subcommand", nargs="?", default="run")
    parser.add_argument("--model", default="gemma4:e4b-it-q4_K_M")
    parser.add_argument("--format", default="json")
    parser.add_argument("--dangerously-skip-permissions", action="store_true")
    parser.add_argument("--dir", default=None)
    parser.add_argument("prompt", nargs="*")
    args, _unknown = parser.parse_known_args(argv)
    return args


def main():
    args = parse_args_safely(sys.argv[1:])

    raw_prompt = sys.argv[-1].strip() if len(sys.argv) > 1 else ""
    if not raw_prompt or raw_prompt.startswith("--"):
        raw_prompt = sys.stdin.read().strip()

    model = strip_model_prefix(args.model)

    session_id = short_id("ses")
    message_id = short_id("msg")
    start_ts = now_ms()

    emit({
        "type": "step_start",
        "timestamp": start_ts,
        "sessionID": session_id,
        "part": {"id": short_id("prt"), "messageID": message_id,
                 "sessionID": session_id, "type": "step-start"},
    })

    # 健康探测 — 失败直接 short-circuit,不进 retry 浪费时间
    healthy, health_detail = probe_ollama_health()
    if not healthy:
        err_text = (
            f"❌ Ollama 后端不可达,无法调 Gemma 4 E4B。\n\n"
            f"探测错误: {health_detail}\n"
            f"探测地址: {OLLAMA_TAGS_URL}\n\n"
            f"自查建议:\n"
            f"1. mini 上 `launchctl list | grep cc.studio-ollama-tunnel` 看 SSH 隧道在不在\n"
            f"2. studio 上 `pgrep -f \"ollama serve\"` 看 Ollama 进程\n"
            f"3. 雷电网桥 ping `192.168.100.3`(studio) 测网络\n"
        )
        emit({
            "type": "text",
            "timestamp": now_ms(),
            "sessionID": session_id,
            "part": {"id": short_id("prt"), "messageID": message_id,
                     "sessionID": session_id, "type": "text",
                     "text": err_text,
                     "time": {"start": start_ts, "end": now_ms()}},
        })
        return

    user_prompt = build_user_prompt(raw_prompt)

    # 内部 stream=true 收 (TTFB 快); 仍单次 emit 避免 v2.0 624KB comment 重蹈.
    # 真 streaming 体感待调研 multica daemon 是否支持 same-part-id delta merge.
    full_text, attempts_used, error = call_ollama_with_retry(model, user_prompt)

    text_part_id = short_id("prt")
    if error:
        # retry 全失败 — 写明哪一步失败 + 用户可看的建议
        err_msg = (
            f"❌ Gemma 4 E4B 调用失败 (重试 {attempts_used}/{MAX_ATTEMPTS} 次后放弃)\n\n"
            f"最后错误: {error}\n\n"
            f"建议: 等 1-2 分钟后 rerun 此 issue;若持续失败联系川哥检查 Studio Ollama 服务."
        )
        emit({
            "type": "text",
            "timestamp": now_ms(),
            "sessionID": session_id,
            "part": {"id": text_part_id, "messageID": message_id,
                     "sessionID": session_id, "type": "text",
                     "text": err_msg,
                     "time": {"start": start_ts, "end": now_ms()}},
        })
        return

    # 成功路径: 多于 1 次 attempt 时附带 retry 标记便于观测
    out_text = full_text
    if attempts_used > 1:
        out_text = full_text + f"\n\n---\n*(注: 此结果在第 {attempts_used}/{MAX_ATTEMPTS} 次尝试时成功)*"

    emit({
        "type": "text",
        "timestamp": now_ms(),
        "sessionID": session_id,
        "part": {"id": text_part_id, "messageID": message_id,
                 "sessionID": session_id, "type": "text",
                 "text": out_text,
                 "time": {"start": start_ts, "end": now_ms()}},
    })


if __name__ == "__main__":
    main()
