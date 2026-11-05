# 会话 93：hk2 只读调用路径已复验

结论：此前成功调用与 `transport.py` 不同。已恢复并定向验证可用入口；本回执只确认 transport，不宣告 v386 验收通过。请主 13 将以下入口交原 39 执行历史窗口核验，无需再调用旧 `transport.py`。

## 差异与原因

| 封装 | 谁发起 hk2 SSH 认证 | home 的作用 | 本次证据 |
| --- | --- | --- | --- |
| `p003-worker-monitor-20261105/transport.py` | home-studio 的 SSH 客户端/既有身份 | 运行最终 SSH | 13/39 留证 exit 255、Permission denied |
| `p003-sn-search-canary-20261021/r23/remote_r23.py` | Air 的 SSH 客户端/既有身份 | 仅 TCP `-W` 转发 | 本会话 `true` exit 0 |

两者虽经过相同机器，认证位置不同。最终实际发布/验证使用的是第二条；不需要取出、复制或新增密钥。所有 SSH 跳均沿用已有信任并使用 `StrictHostKeyChecking=yes`、`BatchMode=yes`，目标固定现役 `.177`，不涉及已销毁 `.117`。

## 本次定向验证

- 2026-11-05 18:11:40 CST：原 `remote_r23.command('worker', 'true')`，exit 0，stdout 0 字节，stderr 空，3.35 秒。
- 2026-11-05 18:13:25 CST：交付封装执行 `hostname`，exit 0，输出 `voice-worker-hk2`，stderr 空，2.88 秒。
- 已本地核对交付封装的 SSH argv 与原成功封装完全相同。非白名单命令、不同 SHA 的 Python payload 均在连接前拒绝。
- 证据：本目录 `TRANSPORT-93.json`；入口与来源 SHA 清单：`EVIDENCE-93.json`。这次没有执行历史 journal 或 binary 读取。

## 原 39 可直接执行

可执行封装：本目录 `transport93_readonly.py`（0700）。探针：

```sh
python3 /Users/fu-121/.local/state/p003-v386-closeout-20261105/worker-supplement/transport93_readonly.py true --timeout 35
```

39 的采集代码可用以下调用替代旧 transport；读取结果按原 `collect.py` 的处理逻辑保存，不覆盖旧失败回执：

```python
import sys
from pathlib import Path
sys.dont_write_bytecode = True
D = Path('/Users/fu-121/.local/state/p003-v386-closeout-20261105/worker-supplement')
sys.path.insert(0, str(D))
from transport93_readonly import worker
r = worker('python3 -', (D / 'read-worker.py').read_bytes(), timeout=90)
# 先检查 r.returncode，再处理 stdout；不要把空/失败结果记为验收通过。
```

封装仅放行 `true`、`hostname` 和已核 SHA 的现有 `read-worker.py`：`ba626c6982f774d5d18d621b3ce0940eb36d7bfbaaa337942adccb1549f0b9b1`。该脚本为原 39 提供，限定单 unit `p003-listening-worker`、UTC 08:03–08:13（CST 16:03–16:13）、当前进程/磁盘 binary hash；日志在远端脱敏后才返回。本会话未修改或执行该采集脚本。若 39 后续修改脚本，不得直接去掉 SHA 检查，应重新审查并核对只读范围。

若只需要确切原始调用指针：

```python
sys.path.insert(0, '/Users/fu-121/.local/state/p003-sn-search-canary-20261021/r23')
from remote_r23 import command
# subprocess.run(command('worker', 'python3 -'), input=只读脚本字节, ...)
```

## 权限与验收边界

本入口当前能执行 `true` / `hostname` 并返回命令对应结果，不是只会返回监控 JSON 的 forced-command 统计入口。此前部署回执还记录了 root 路径备份、采集脚本替换和 timer 启用；这些属于已有历史证据，不是本轮重新执行。本轮未读取 authorized_keys 或证明所有 root 操作均可用，日志和 binary 读取仍由 39 单独执行并判断。

已读 COORDINATION.md、附件全文并核 SHA `44fc7582348fe2b534970cccc29d5c3fb984a4631b00c4d32fbdbecf05533342`。监控修复树 HEAD `e630fbb855bd952fdba5b59127c4197bde0b98c5` 干净；原小程序树 HEAD `6c2cc932713199968337d45641c3286d66c1fbfe` 的 34 条 dirty 记录未修改。只新增本私有目录中的交付与回执，不重启、不部署、不改 SSH/公钥、不读取或输出凭据、不重跑全套测试。

署名：codex（OpenAI）| 2026-11-05 18:14（北京时间）
