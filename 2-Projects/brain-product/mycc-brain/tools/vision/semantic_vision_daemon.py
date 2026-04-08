#!/usr/bin/env python3
"""
semantic_vision_daemon.py — mycc-brain 低频语义视觉通道

读取 vision_daemon 产出的 latest.jpg / latest.json，
用 Ollama minicpm-v（主）/ mlx_vlm（降级）生成场景语义快照，
写入 semantic-latest.json。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import signal
import sys
import tempfile
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# mlx_vlm 降级（import 失败不退出）
_mlx_vlm_available = False
try:
    from mlx_vlm import generate as mlx_generate, load as mlx_load
    from mlx_vlm.prompt_utils import apply_chat_template as mlx_apply_chat_template
    from mlx_vlm.utils import load_config as mlx_load_config
    _mlx_vlm_available = True
except Exception:
    pass

VERSION = "semantic-vision-v3"
MLX_FALLBACK_MODEL = "mlx-community/Qwen2-VL-2B-Instruct-4bit"
OLLAMA_URL = "http://localhost:11434"
OLLAMA_MODEL = "minicpm-v"
SEMANTIC_STALE_SECONDS = 120


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    tmp_fd, tmp_path = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp", prefix=path.stem)
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_path, str(path))
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def extract_json_object(text: str) -> dict[str, Any] | None:
    """从文本中提取 JSON 对象（mlx_vlm 降级路径使用）"""
    text = text.strip()
    if not text:
        return None
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except Exception:
        pass
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def clamp_confidence(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return max(0.0, min(1.0, float(value)))
    return None


def normalize_nearby_objects(value: Any) -> list[str]:
    """规范化附近物体列表（mlx_vlm 降级路径使用）"""
    if not isinstance(value, list):
        return []
    normalized: list[str] = []
    for item in value:
        label: str | None = None
        if isinstance(item, str):
            label = item.strip()
        elif isinstance(item, dict):
            object_type = str(item.get("object_type", "")).strip()
            position = str(item.get("position", "")).strip()
            if object_type and position and position.lower() != "unknown":
                label = f"{object_type}（{position}）"
            elif object_type:
                label = object_type
        elif isinstance(item, (int, float)):
            label = str(item)
        if label and label not in normalized:
            normalized.append(label[:40])
    return normalized[:6]


def detect_change(
    prev_raw: str, cur_raw: str, prev_present: bool | None, cur_present: bool | None,
) -> tuple[str | None, str]:
    """
    对比前后两次扫描，返回 (event_name, detail)。
    event_name: "person_arrived" | "person_left" | "scene_changed" | None
    detail: rawText 前 60 字
    """
    detail = cur_raw[:60]

    # 人物到达 / 离开
    if prev_present is False and cur_present is True:
        return ("person_arrived", detail)
    if prev_present is True and cur_present is False:
        return ("person_left", detail)

    # 场景变化（首次扫描不触发）
    if prev_raw:
        prev_set = set(prev_raw)
        cur_set = set(cur_raw)
        denom = max(len(prev_set), len(cur_set), 1)
        overlap = len(prev_set & cur_set) / denom
        if overlap < 0.5:
            return ("scene_changed", detail)

    return (None, detail)


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    """追加一行 JSONL，超过 200 行时截断保留最后 200 行。"""
    line = json.dumps(record, ensure_ascii=False) + "\n"
    with open(path, "a", encoding="utf-8") as f:
        f.write(line)
    # 截断检查
    try:
        lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
        if len(lines) > 200:
            path.write_text("".join(lines[-200:]), encoding="utf-8")
    except OSError:
        pass


def load_prompt_config(data_dir: Path) -> dict[str, Any] | None:
    """从 vision-prompt-config.json 加载 prompt 配置，失败返回 None（降级到硬编码）"""
    config_path = data_dir.parent / "patterns" / "vision-prompt-config.json"
    try:
        if not config_path.exists():
            return None
        data = json.loads(config_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or "templates" not in data:
            return None
        return data
    except Exception:
        return None


class SemanticScanner:
    """场景语义扫描器 — Ollama minicpm-v（主）/ mlx_vlm（降级）"""

    def __init__(self, ollama_url: str = OLLAMA_URL, mlx_model_id: str = MLX_FALLBACK_MODEL):
        self.ollama_url = ollama_url
        self.mlx_model_id = mlx_model_id
        self._mlx_model = None
        self._mlx_processor = None
        self._mlx_config = None

    def _call_ollama(self, image_path: str, prompt: str) -> str:
        """调用 Ollama minicpm-v 视觉 API"""
        with open(image_path, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode("utf-8")

        payload = json.dumps({
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "images": [img_b64],
            "stream": False,
            "options": {"num_predict": 300},
        }).encode("utf-8")

        req = urllib.request.Request(
            f"{self.ollama_url}/api/generate",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=90) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result.get("response", "").strip()

    def _ensure_mlx_loaded(self) -> None:
        """懒加载 mlx_vlm 模型"""
        if not _mlx_vlm_available:
            raise RuntimeError("mlx_vlm 不可用")
        if self._mlx_model is not None:
            return
        print(f"[semantic-vision] 降级加载 mlx_vlm: {self.mlx_model_id}")
        self._mlx_model, self._mlx_processor = mlx_load(self.mlx_model_id)
        self._mlx_config = mlx_load_config(self.mlx_model_id)

    def _call_mlx(self, image_path: str) -> dict[str, Any]:
        """mlx_vlm 降级路径（JSON 输出）"""
        self._ensure_mlx_loaded()
        prompt = (
            "你是工位场景观察器。只根据画面可见内容回答。"
            '请输出严格 JSON：'
            '{"person_appearance":"...","nearby_objects":["..."],"scene_summary":"..."}'
        )
        formatted = mlx_apply_chat_template(self._mlx_processor, self._mlx_config, prompt, num_images=1)
        output = mlx_generate(
            self._mlx_model, self._mlx_processor, formatted,
            [image_path], max_tokens=180, verbose=False,
        )
        text = output.text if hasattr(output, "text") else str(output)
        parsed = extract_json_object(text or "")
        if parsed is None:
            return {
                "person_appearance": "unknown",
                "nearby_objects": [],
                "person_action": "unknown",
                "scene_summary": (text or "").strip()[:120] or "unknown",
                "confidence": 0.2,
                "raw_text": (text or "").strip(),
            }
        return {
            "person_appearance": str(parsed.get("person_appearance", "unknown"))[:80],
            "nearby_objects": normalize_nearby_objects(parsed.get("nearby_objects")),
            "person_action": str(parsed.get("person_action", "unknown"))[:80],
            "scene_summary": str(parsed.get("scene_summary", "unknown"))[:120],
            "confidence": clamp_confidence(parsed.get("confidence")) or 0.5,
            "raw_text": (text or "").strip()[:240],
        }

    @staticmethod
    def _build_prompt(present: bool | None, config: dict[str, Any] | None = None) -> str:
        """构建 prompt，优先读 config，降级到硬编码"""
        templates = config.get("templates", {}) if config else {}
        emphasis = config.get("emphasis", {}) if config else {}

        # 选择模板
        if present is False:
            prompt = templates.get("present_false", "")
        elif present is True:
            prompt = templates.get("present_true", "")
        else:
            prompt = templates.get("present_unknown", "")

        # 如果配置为空，降级到硬编码
        if not prompt:
            if present is False:
                return "描述这个工位场景：桌上有什么物品，环境怎样。1-2句话。"
            base = (
                "简洁描述这个场景：\n"
                "1) 有谁在，在做什么\n"
                "2) 桌上/房间里的重要物品\n"
                "3) 有什么变化或异常。\n"
                "2-3句话。"
            )
            if present is True:
                return (
                    "[重要提示：画面中的人是川哥（我的老板）。"
                    "描述时请直接称呼他的名字，不要说'一名男子'。]\n" + base
                )
            return base

        # 追加 emphasis（如果有）
        suffix_parts = []
        if emphasis.get("objects"):
            suffix_parts.append(emphasis["objects"])
        if emphasis.get("actions"):
            suffix_parts.append(emphasis["actions"])
        if emphasis.get("environment"):
            suffix_parts.append(emphasis["environment"])
        if suffix_parts:
            prompt += "\n" + "\n".join(suffix_parts)

        return prompt

    @staticmethod
    def _extract_from_natural_language(raw_text: str) -> dict[str, Any]:
        """从自然语言描述中尽力提取结构化字段"""
        sentences = [s.strip() for s in raw_text.replace("。", "。\n").split("\n") if s.strip()]
        scene_summary = sentences[0][:120] if sentences else raw_text[:120]

        # 人物外观
        appearance_kw = ["穿", "戴", "衣", "裤", "帽", "眼镜", "T恤", "衬衫", "外套", "短袖", "黑色", "白色", "灰色"]
        person_appearance = "unknown"
        for s in sentences:
            if any(kw in s for kw in appearance_kw):
                person_appearance = s.rstrip("。，,")[:80]
                break

        # 附近物体
        obj_kw = [
            "电脑", "显示器", "键盘", "鼠标", "杯", "手机", "笔", "书", "纸", "水杯",
            "咖啡", "耳机", "台灯", "笔记本", "iPad", "充电器", "文件", "音箱", "摄像头",
            "瓶", "盒", "包", "椅", "桌",
        ]
        nearby: list[str] = []
        for kw in obj_kw:
            if kw in raw_text and kw not in nearby:
                nearby.append(kw)

        # 人物动作
        action_kw = ["打字", "看", "使用", "操作", "坐", "站", "走", "写", "读", "敲", "工作", "注视"]
        person_action = "unknown"
        for s in sentences:
            if any(kw in s for kw in action_kw):
                person_action = s.rstrip("。，,")[:80]
                break

        return {
            "person_appearance": person_appearance,
            "nearby_objects": nearby[:6],
            "person_action": person_action,
            "scene_summary": scene_summary,
            "confidence": 0.7,
            "raw_text": raw_text[:500],
        }

    def describe(self, image_path: str, present: bool | None = None, prompt_config: dict[str, Any] | None = None) -> dict[str, Any]:
        """
        描述场景。主路径: Ollama minicpm-v，降级: mlx_vlm。
        无论 present 真假都调模型描述画面。
        """
        prompt = self._build_prompt(present, config=prompt_config)

        # 主路径: Ollama minicpm-v
        try:
            raw_text = self._call_ollama(image_path, prompt)
            if raw_text:
                result = self._extract_from_natural_language(raw_text)
                result["method"] = f"ollama/{OLLAMA_MODEL}"
                return result
            print("[semantic-vision] Ollama 返回空文本")
        except Exception as exc:
            print(f"[semantic-vision] Ollama 调用失败: {exc}")

        # 降级: mlx_vlm
        if _mlx_vlm_available:
            try:
                result = self._call_mlx(image_path)
                result["method"] = f"mlx/{self.mlx_model_id}"
                return result
            except Exception as exc:
                print(f"[semantic-vision] mlx_vlm 降级失败: {exc}")

        return {
            "person_appearance": "unknown",
            "nearby_objects": [],
            "person_action": "unknown",
            "scene_summary": "模型不可用",
            "confidence": 0.0,
            "raw_text": "模型不可用",
            "method": "none",
        }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="mycc-brain semantic vision daemon")
    p.add_argument("--data-dir", type=str, default=None, help="activity 输出目录")
    p.add_argument("--interval", type=int, default=15, help="语义快扫间隔（秒）")
    p.add_argument("--debug", action="store_true")
    p.add_argument("--once", action="store_true")
    p.add_argument("--model", type=str, default=MLX_FALLBACK_MODEL, help="mlx_vlm 降级模型")
    p.add_argument("--ollama-url", type=str, default=OLLAMA_URL, help="Ollama API 地址")
    args = p.parse_args()
    if args.interval <= 0:
        print("[semantic-vision] ERROR: --interval 必须 > 0")
        sys.exit(1)
    return args


def main() -> None:
    args = parse_args()
    if args.data_dir:
        data_dir = Path(args.data_dir)
    else:
        data_dir = Path(__file__).resolve().parent.parent.parent / "data" / "activity"
    data_dir.mkdir(parents=True, exist_ok=True)

    latest_frame_path = data_dir / "latest.jpg"
    latest_state_path = data_dir / "latest.json"
    semantic_latest_path = data_dir / "semantic-latest.json"
    semantic_status_path = data_dir / "semantic-status.json"

    visual_changes_path = data_dir / "visual-changes.jsonl"

    running = True
    started_at = now_iso()
    last_run_at = None
    last_error = None
    scanner = SemanticScanner(ollama_url=args.ollama_url, mlx_model_id=args.model)
    active_method = f"ollama/{OLLAMA_MODEL}"

    # 变化检测状态
    prev_raw_text: str = ""
    prev_present: bool | None = None
    # 自适应 interval 状态
    current_interval: float = float(args.interval)
    # prompt 配置版本（每轮更新）
    prompt_version: int | None = None

    def handle_signal(_sig, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    def write_status() -> None:
        atomic_write_json(semantic_status_path, {
            "running": running,
            "startedAt": started_at,
            "lastRunAt": last_run_at,
            "lastError": last_error,
            "model": active_method,
            "version": VERSION,
            "currentInterval": current_interval,
            "promptVersion": prompt_version,
        })

    write_status()
    mlx_label = f"mlx/{args.model}" if _mlx_vlm_available else "none"
    if args.debug:
        print(f"[semantic-vision] 启动: interval={args.interval}s primary=ollama/{OLLAMA_MODEL} fallback={mlx_label}")
        print(f"[semantic-vision] 输出: {data_dir}")

    while running:
        loop_started = time.time()
        timestamp = now_iso()
        last_error = None
        change_event: str | None = None
        present: bool | None = None

        # --- 每轮热加载 prompt 配置 ---
        prompt_config = load_prompt_config(data_dir)
        new_version = prompt_config.get("version") if prompt_config else None
        if new_version != prompt_version:
            prompt_version = new_version
            if args.debug and prompt_config is not None:
                print(f"[semantic-vision] prompt config loaded: version={prompt_version}")

        try:
            if not latest_frame_path.exists() or not latest_state_path.exists():
                raise FileNotFoundError("latest.jpg or latest.json missing")

            state = json.loads(latest_state_path.read_text())
            present = state.get("present")
            image_age = time.time() - latest_frame_path.stat().st_mtime

            if image_age > SEMANTIC_STALE_SECONDS:
                raise RuntimeError(f"latest.jpg stale: {image_age:.1f}s")

            result = scanner.describe(str(latest_frame_path), present=present, prompt_config=prompt_config)
            active_method = result.get("method", "unknown")
            raw_text: str = result.get("raw_text", "")

            # --- 变化检测 ---
            change_event, change_detail = detect_change(
                prev_raw_text, raw_text, prev_present, present,
            )

            # 构建 lastChange
            last_change: dict[str, Any] | None = None
            if change_event:
                last_change = {"event": change_event, "ts": timestamp, "detail": change_detail}
                if args.debug:
                    print(f"[semantic-vision] CHANGE: {change_event} detail={change_detail}")

            semantic = {
                "timestamp": timestamp,
                "semanticAvailable": True,
                "semanticMethod": active_method,
                "sceneSummary": result["scene_summary"],
                "personAppearance": result["person_appearance"],
                "personAction": result["person_action"],
                "nearbyObjects": result["nearby_objects"],
                "semanticConfidence": result["confidence"],
                "rawText": raw_text,
                "sourceImage": str(latest_frame_path),
                "lastChange": last_change,
                "prevRawText": prev_raw_text[:200] if prev_raw_text else None,
            }

            atomic_write_json(semantic_latest_path, semantic)

            # --- 写入 visual-changes.jsonl ---
            if change_event:
                append_jsonl(visual_changes_path, {
                    "ts": timestamp,
                    "event": change_event,
                    "detail": raw_text[:60],
                    "rawText": raw_text,
                })

            # --- 写入 semantic-history JSONL ---
            date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            history_path = data_dir / f"semantic-history-{date_str}.jsonl"
            append_jsonl(history_path, {
                "ts": timestamp,
                "present": present,
                "rawText": raw_text,
                "method": active_method,
                "change": change_event,
            })

            # 更新前一次状态
            prev_raw_text = raw_text
            prev_present = present

            last_run_at = timestamp
            if args.debug:
                print(f"[semantic-vision] [{active_method}] rawText={raw_text[:80]}...")
        except Exception as exc:
            last_error = str(exc)
            if args.debug:
                print(f"[semantic-vision] 失败: {exc}")

        # --- 自适应 interval 计算 ---
        old_interval = current_interval
        if change_event:
            # 检测到变化事件 → 3s 立即重扫确认
            current_interval = 3.0
            interval_reason = f"change_event={change_event}"
        elif present is True:
            # 有人 → 使用 --interval 基准值
            current_interval = float(args.interval)
            interval_reason = "present=True"
        else:
            # 无人 → 60s 省 GPU
            current_interval = 60.0
            interval_reason = "present=False"

        if args.debug and old_interval != current_interval:
            print(f"[semantic-vision] interval: {old_interval:.0f}s → {current_interval:.0f}s ({interval_reason})")

        write_status()

        if args.once:
            if semantic_latest_path.exists():
                print(semantic_latest_path.read_text())
            break

        sleep_time = max(0.0, current_interval - (time.time() - loop_started))
        if sleep_time > 0:
            time.sleep(sleep_time)


if __name__ == "__main__":
    main()
