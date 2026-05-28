#!/usr/bin/env python3
"""
gemma-direct.py - multica direct-ollama adapter (v2.4: 注入 agent instructions)
模拟 opencode CLI 接口,跳过 agent loop 直调 Ollama,流式收 + batched emit stream-json

multica daemon 调用方式 (实测):
  gemma-direct.py run --format json --dangerously-skip-permissions --dir <workdir> --model <provider/model> <PROMPT>

v2.5 (2026-05-28):
- 切到 Ollama 原生 /api/chat 端点(NDJSON 流) 替代 /v1/chat/completions,以便传 options.num_ctx
- 默认 num_ctx=32768 (32K, Gemma 4 E4B 支持到 128K 但 32K 平衡 VRAM/速度)
- 修隐藏严重 bug: 之前 Ollama 默认 num_ctx=2048 直接砍长输入到 2K, agent.instructions 也被砍
- DEFAULT_GUARDRAIL 重写为反映 Gemma 4 真实能力上限 (128K context / 多模态 / 中等推理 OK)

v2.4 (2026-05-28):
- 拿 issue.assignee_id → multica agent get → instructions 注入 Ollama system message,
  让 multica web 改 agent instructions 即时生效
- 没拿到 agent instructions 时 fallback DEFAULT_GUARDRAIL (基础范式 + refuse 模板)

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
# v2.5: 切到 Ollama 原生 /api/chat 端点 (NDJSON 流),OpenAI 兼容 /v1/chat/completions 不接 options.num_ctx
OLLAMA_CHAT_URL = OLLAMA_BASE + "/api/chat"
OLLAMA_TAGS_URL = OLLAMA_BASE + "/api/tags"

# Retry 策略: 总尝试次数 = MAX_ATTEMPTS, 失败间隔取 RETRY_DELAYS[attempt-1]
MAX_ATTEMPTS = 3
RETRY_DELAYS = [5, 15]  # 第 1 次失败后等 5s,第 2 次后 15s
HEALTH_TIMEOUT = 5
OLLAMA_TIMEOUT = 600  # 单次 stream 调用上限 (Gemma 4 E4B prefill 长 prompt 可能需要)

# Gemma 4 E4B 模型本身支持 131072 (128K) context, 但 Ollama 默认 num_ctx=2048 直接砍输入。
# 32768 (32K) 平衡 VRAM/速度: ~32K input + ~32K output 足够 multica 长任务,VRAM 占用可控。
# 可被 env GEMMA_NUM_CTX override,极少数 100K+ 长文档场景设 131072。
DEFAULT_NUM_CTX = int(os.environ.get("GEMMA_NUM_CTX", "32768"))
DEFAULT_NUM_PREDICT = int(os.environ.get("GEMMA_NUM_PREDICT", "8192"))  # 输出 token 上限

# 可重试的网络/瞬时错误
RETRYABLE_EXCEPTIONS = (URLError, HTTPError, ConnectionError, TimeoutError, OSError)

# 当 multica agent instructions 拿不到时的兜底 system prompt
# 反映 Gemma 4 E4B 真实能力 (基于官方模型卡 + benchmark, 2026-05-28 更新)
DEFAULT_GUARDRAIL = """你是 multica 部署的 Gemma 4 E4B (本地 Ollama, Studio M2 Max, 47 TPS, 不走云端 API)。

# 真实能力 (基于官方模型卡 + benchmark)

✅ **强项**:
- 中文/英文写作: 周报/邮件/技术文档/翻译/摘要 (输入 <32K, 输出 <8K)
- 中等推理: MMLU Pro 69.4% / GPQA Diamond 58.6% — 多步思考 OK, 但**复杂数学/竞赛级** (AIME 42.5%) 不稳
- 代码: LiveCodeBench 52% / Codeforces ELO 940 — 小脚本/单文件 bug fix/补全 OK, 50-200 行可控
- 结构化输出: JSON / Markdown 表格 / 列表 — 原生 system role + function calling
- 多模态 (官方支持但 multica 当前未传入图像/音频): OCR/图表/PDF/30s 音频/60s 视频
- 长上下文: 128K 模型上限, 当前配 32K — 可塞整篇长文档
- 思维模式: 复杂任务可用 <think>...</think> 先内部推理再答 (Gemma 4 IT 原生支持)

⚠️ **限制 (要主动声明而不是装作万能)**:
- 知识截止 **2026-01**, 之后的事实需要 RAG/搜索, 不知道就说 [不确定]
- 不是知识库, 法律/政策/价格/产品规格不能裸答
- 复杂多步 Agent 流程不稳定, 不要裸跑生产
- 强常识推理/讽刺/隐喻可能漏

❌ **真不能 (硬性 refuse)**:
- 大型代码工程 (>500 行 / 跨多文件 / 复杂算法竞赛)
- 高风险决策 (金融交易 / 数据库写入 / 权限变更 / 安全审计)
- 实时数据 / 精确事实查询 (没接 RAG 时)

# 工作原则

1. **中文回复** (术语保留英文)
2. **直接给结果** (无 throat clearing / 无"作为 AI 助手..."套话)
3. **不确定标 [不确定]**, 拿不准的事实标 <请补充具体值>
4. **复杂任务可用 thinking mode**: 先在 <think>...</think> 内部推理, 再给最终答案
5. **超能力 refuse 模板**:
   > 🤖 此任务超出 Gemma 4 E4B 能力 (<具体原因>)。建议改派:
   > - 复杂决策/战略 → 「爱马仕grok（4.3）」或 cc(Claude)
   > - 多文件代码工程 → codex
   > - 实时数据/精确事实 → 接 RAG 或问 gemini

# 角色边界
- worker, 不是 coordinator: 不派单, 不调度
- 1 次完整产出, 无 multi-turn"""


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


def call_ollama_stream(model, user_prompt, system_prompt=None, timeout=OLLAMA_TIMEOUT,
                       num_ctx=None, num_predict=None):
    """流式调 Ollama 原生 /api/chat (NDJSON), yield 文本 chunk。抛 RETRYABLE_EXCEPTIONS 由外层 retry。

    切到原生 API (v2.5) 是为了能传 options.num_ctx — OpenAI 兼容 /v1/chat/completions 不接 options,
    会让 Ollama 用默认 num_ctx=2048 (致命: 把 128K 模型砍成 2K)。

    system_prompt: 注入到 messages[0] role=system, 用于灌 agent instructions。
    num_ctx: context 窗口 (默认 DEFAULT_NUM_CTX=32K), Gemma 4 E4B 模型支持到 131072。
    num_predict: 输出 token 上限 (默认 DEFAULT_NUM_PREDICT=8K), -1 = 无限制。
    """
    messages = []
    if system_prompt and system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})
    options = {
        "num_ctx": num_ctx if num_ctx is not None else DEFAULT_NUM_CTX,
        "num_predict": num_predict if num_predict is not None else DEFAULT_NUM_PREDICT,
    }
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": options,
    }
    req = urlrequest.Request(
        OLLAMA_CHAT_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # 原生 /api/chat 流式格式: NDJSON 每行一个 JSON 对象
    # {"model":"...","created_at":"...","message":{"role":"assistant","content":"..."},"done":false}
    # 最后一行 done=true 带 metadata (eval_count / total_duration 等)
    with urlrequest.urlopen(req, timeout=timeout) as resp:
        for line in resp:
            line = line.strip()
            if not line:
                continue
            try:
                chunk = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError:
                # 单 chunk 解码失败不应 abort 整个 stream
                continue
            # Ollama 错误情况: {"error":"..."} 立即抛
            if "error" in chunk and chunk["error"]:
                raise URLError(f"Ollama API error: {chunk['error']}")
            message = chunk.get("message") or {}
            content = message.get("content")
            if content:
                yield content
            if chunk.get("done"):
                break


def call_ollama_with_retry(model, user_prompt, system_prompt=None):
    """
    包 call_ollama_stream + retry. 返回 (full_text: str, attempts_used: int, error: str | None).
    - 成功: (text, attempt, None)
    - 全部 attempts 失败: ("", MAX_ATTEMPTS, "最后错误描述")
    """
    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            full_text = ""
            for chunk in call_ollama_stream(model, user_prompt, system_prompt=system_prompt):
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


def multica_agent_get(agent_id):
    """拿 agent 详情 (含 instructions). 失败返回 None, 不抛异常."""
    if not agent_id:
        return None
    try:
        out = subprocess.run(
            [MULTICA_BIN, "agent", "get", agent_id, "--output", "json"],
            capture_output=True, text=True, timeout=15, check=True,
        ).stdout
        idx = out.find("{")
        return json.loads(out[idx:]) if idx >= 0 else None
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
            json.JSONDecodeError, FileNotFoundError):
        return None


def resolve_system_prompt(issue):
    """
    从 issue.assignee 取 agent instructions 作为 system prompt.
    - issue.assignee_type == "agent" 时拉 agent instructions
    - 拿不到或为空 → 返回 DEFAULT_GUARDRAIL (确保最低能力边界)
    """
    if not issue:
        return DEFAULT_GUARDRAIL
    if issue.get("assignee_type") != "agent":
        return DEFAULT_GUARDRAIL
    agent_id = issue.get("assignee_id")
    agent = multica_agent_get(agent_id)
    if not agent:
        return DEFAULT_GUARDRAIL
    instructions = (agent.get("instructions") or "").strip()
    return instructions if instructions else DEFAULT_GUARDRAIL


def strip_model_prefix(model):
    return model.split("/", 1)[1] if "/" in model else model


def build_user_prompt_and_system(raw_prompt):
    """
    从 raw_prompt 抽 issue UUID, 拉 issue + agent, 返回 (user_prompt, system_prompt).
    抽不到 issue 时回退 raw_prompt + DEFAULT_GUARDRAIL.
    """
    m = UUID_RE.search(raw_prompt)
    if not m:
        return raw_prompt, DEFAULT_GUARDRAIL
    issue = multica_issue_get(m.group(0))
    if issue is None:
        return raw_prompt, DEFAULT_GUARDRAIL
    title = issue.get("title", "")
    description = issue.get("description", "")
    user_prompt = (
        "请完成以下任务,直接给出结果,不需要工具调用。\n\n"
        f"标题: {title}\n\n详情:\n{description}"
    )
    system_prompt = resolve_system_prompt(issue)
    return user_prompt, system_prompt


# 保留旧函数签名供 test_gemma_direct.py 已写的单测用 (向后兼容)
def build_user_prompt(raw_prompt):
    user_prompt, _ = build_user_prompt_and_system(raw_prompt)
    return user_prompt


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

    user_prompt, system_prompt = build_user_prompt_and_system(raw_prompt)

    # 内部 stream=true 收 (TTFB 快); 仍单次 emit 避免 v2.0 624KB comment 重蹈.
    # 真 streaming 体感待调研 multica daemon 是否支持 same-part-id delta merge.
    full_text, attempts_used, error = call_ollama_with_retry(model, user_prompt, system_prompt=system_prompt)

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
