#!/usr/bin/env python3
"""Expose canonical storage policy through Cursor global sessionStart/workspaceOpen hooks."""
import json
import os
from pathlib import Path
import sys
import tempfile

POLICY = Path("/home/hahaxiong83/mycc/docs/rules/HOME-STUDIO-STORAGE.md")
PLUGIN = Path(__file__).resolve().parent / "cursor-storage-policy"
HEADER = "---\ndescription: home-studio shared storage policy\nalwaysApply: true\n---\n\n"

def main():
    workspace = "--workspace-open" in sys.argv[1:]
    try:
        text = POLICY.read_text(encoding="utf-8")
        if not text.strip():
            raise ValueError("empty storage policy")
        if workspace:
            rule = PLUGIN / "rules" / "home-studio-storage.mdc"
            content = HEADER + text
            if not rule.exists() or rule.read_text(encoding="utf-8") != content:
                fd, temporary = tempfile.mkstemp(prefix=".storage-rule-", dir=rule.parent)
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as output:
                        output.write(content)
                        output.flush()
                        os.fsync(output.fileno())
                    os.chmod(temporary, 0o644)
                    os.replace(temporary, rule)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
            result = {"pluginPaths": [str(PLUGIN)]}
        else:
            git_note = ("\n\n本机 Git 同步规则（多机共享仓）：开工先 `git pull --rebase --autostash`；一个任务一个提交、当日 push；禁止 force push / 改写远端；发现分叉按 /home/hahaxiong83/mycc/docs/rules/GIT-SYNC.md 处理。完整宪法：/home/hahaxiong83/AGENTS.md")
            result = {"additional_context": "本机共享存储规则（从唯一真源实时读取）：\n" + text + git_note}
    except (OSError, ValueError):
        if workspace:
            print("Storage policy plugin could not be prepared; inspect " + str(POLICY), file=sys.stderr)
            result = {}
        else:
            result = {"additional_context": "home-studio 存储规则暂不可读。生成或下载独立数据前，先读取 "
                      + str(POLICY) + " 和 /home/hahaxiong83/AGENTS.md，确认 data 挂载与输出路径。Git 规则见 "
                      + "/home/hahaxiong83/mycc/docs/rules/GIT-SYNC.md。"}
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
