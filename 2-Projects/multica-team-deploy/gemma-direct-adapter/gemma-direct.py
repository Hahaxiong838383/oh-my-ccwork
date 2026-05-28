#!/usr/bin/env python3
"""
gemma-direct.py - multica direct-ollama adapter (v2: streaming)
模拟 opencode CLI 接口,跳过 agent loop 直调 Ollama,流式吐 stream-json
multica daemon 调用方式 (实测):
  gemma-direct.py run --format json --dangerously-skip-permissions --dir <workdir> --model <provider/model> <PROMPT>

设计要点:
- prompt 含 `--output` / `--recent` 等子串会被 argparse 当成 flag 吃掉, 直接 sys.argv[-1] 拿 prompt
- Ollama stream=true → 一边收 SSE chunk, 一边 emit text events, 体感首字 < 2s
- 提取 issue UUID + multica issue get 拿 description, 跳过 multica 长 system prompt
- 把 LLM response 写回 multica issue comment
"""
import argparse, json, os, re, sys, time, uuid, subprocess
from urllib import request as urlrequest
from urllib.error import URLError, HTTPError

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
MULTICA_BIN = os.path.expanduser("~/bin/multica")
OLLAMA_URL = "http://127.0.0.1:11434/v1/chat/completions"


def short_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


def now_ms():
    return int(time.time() * 1000)


def emit(ev):
    sys.stdout.write(json.dumps(ev, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def call_ollama_stream(model, user_prompt, timeout=600):
    """流式调 Ollama, yield 文本 chunk."""
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": user_prompt}],
        "stream": True,
    }
    req = urlrequest.Request(
        OLLAMA_URL,
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
                continue
            choices = chunk.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            content = delta.get("content")
            if content:
                yield content


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


def multica_comment_add(issue_id, content):
    try:
        subprocess.run(
            [MULTICA_BIN, "issue", "comment", "add", issue_id, "--content", content],
            capture_output=True, text=True, timeout=30, check=True,
        )
        return True
    except Exception:
        return False


def strip_model_prefix(model):
    return model.split("/", 1)[1] if "/" in model else model


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("subcommand", nargs="?", default="run")
    parser.add_argument("--model", default="gemma4:e4b-it-q4_K_M")
    parser.add_argument("--format", default="json")
    parser.add_argument("--dangerously-skip-permissions", action="store_true")
    parser.add_argument("--dir", default=None)
    parser.add_argument("prompt", nargs="*")
    args, _unknown = parser.parse_known_args()

    # prompt 含 --output / --recent / --before-id 等子串会被 argparse 当 flag 吃掉。
    # 直接拿 sys.argv[-1] (multica 把整段 prompt 当一个 arg 传)
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

    # 解析 issue UUID + 拿 description
    m = UUID_RE.search(raw_prompt)
    issue_id = m.group(0) if m else None

    if issue_id:
        issue = multica_issue_get(issue_id)
        if issue is None:
            user_prompt = raw_prompt
        else:
            title = issue.get("title", "")
            description = issue.get("description", "")
            user_prompt = (
                "请完成以下任务,直接给出结果,不需要工具调用。\n\n"
                f"标题: {title}\n\n详情:\n{description}"
            )
    else:
        user_prompt = raw_prompt

    # 内部 stream=true 收 (TTFB 快), 但 multica daemon 把每个 text event 当独立 message,
    # 累积 full_text 多次 emit 会导致 comment 巨大. 故只在 stream 完成后 emit 一次最终 text.
    full_text = ""
    text_part_id = short_id("prt")
    try:
        for chunk in call_ollama_stream(model, user_prompt):
            full_text += chunk
    except (URLError, HTTPError, KeyError, json.JSONDecodeError, TimeoutError) as e:
        full_text = f"❌ Ollama 调用失败: {type(e).__name__}: {e}"

    emit({
        "type": "text",
        "timestamp": now_ms(),
        "sessionID": session_id,
        "part": {"id": text_part_id, "messageID": message_id,
                 "sessionID": session_id, "type": "text",
                 "text": full_text,
                 "time": {"start": start_ts, "end": now_ms()}},
    })

    # multica daemon 会从 stream-json text events 自动提取写 comment, 不重复写
    # (v2.1 修: 之前 v2 fake adapter + daemon 各写一次导致 comment 重复)


if __name__ == "__main__":
    main()
