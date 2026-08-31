# Mac Studio → 公司 PR NAS 备份与空间释放归档

- 日期：2026-08-31
- 执行引擎：codex（OpenAI）
- 源设备：`fu-121` 的 Mac Studio（`192.168.61.177`）
- 目标设备：公司 QNAP `PRNas / TS-X65 / 192.168.61.18`
- SSH 账号：`Rayman.chen`（`uid=1000 / gid=100`）
- 目标共享目录：`/share/产品研究部重要文件备份`

## 1. SSH 接入

QTS Home Folder 启用后，Studio ED25519 公钥安装到：

```text
/share/homes/Rayman.chen/.ssh/authorized_keys
```

免密验证：

```text
hostname=PRNas
model=TS-X65
BatchMode=yes PASS
```

## 2. 设计文件备份与本地删除

目标目录：

```text
/share/产品研究部重要文件备份/Macstudio 设计文件备份
```

结果：

- Studio `~/Documents` 中确认的 A1–A8、B1–B9，共 17 个文件。
- 数据量：`7,497,986,763` bytes（约 `6.983 GiB`）。
- 保留源相对目录结构和两组重复素材的原始路径。
- NAS 逐文件大小与 SHA-256：`17/17 PASS`。
- 删除前再次完成 Studio/NAS 双侧 SHA-256：`17/17 PASS`。
- 本地只永久删除清单内 17 个精确文件，未删除目录或其他文件。
- `Documents`：约 `11G → 4.2G`。
- 数据卷可用空间：`7.6GiB → 13GiB`。

NAS 证据文件：

```text
备份清单_SHA256.tsv
备份说明.txt
校验结果.txt
删除记录.txt
```

## 3. AI 模型备份与本地删除

目标目录：

```text
/share/产品研究部重要文件备份/Macstudio AI模型备份
```

备份模型：

| 编号 | 模型 |
|---|---|
| L1 | LM Studio `Qwen3-30B-A3B-Q4_K_M.gguf` |
| O1 | Ollama `gemma4:31b` |
| O2 | Ollama `qwen3:30b` |
| O3 | Ollama `gemma4:26b` |

完整性范围：

- Ollama 备份 3 个 manifest 及其引用的全部 config/model/template/license/params blobs。
- Ollama 共 3 个 manifest、11 个唯一 blobs；LM Studio 共 1 个 GGUF。
- 数据及依赖文件共 15 个。
- 总量：`75,045,437,011` bytes（约 `69.892 GiB`）。
- 传输后 Studio/NAS 双侧逐文件 SHA-256：`15/15 PASS`。
- 删除前再次完成 Studio/NAS 双侧逐文件 SHA-256：`15/15 PASS`。

删除方式：

- O1/O2/O3 使用 `ollama rm`，未直接破坏 Ollama 的 manifest/blob 管理结构。
- L1 在大小与 SHA-256 最终复核后精确删除。
- 其他 7 个 Ollama 模型继续保留。
- Studio 可用空间：`12GiB → 82GiB`。
- 数据盘使用率：`98% → 81%`。
- Ollama models 目录删除后约 `25G`；LM Studio models 约 `36K`。

NAS 证据文件：

```text
AI模型备份清单_SHA256.tsv
AI模型备份说明.txt
校验结果.txt
AI模型本地删除记录.txt
```

## 4. 生产影响与恢复边界

- 未重启 PR NAS、容器或生产服务。
- 删除前 Ollama 无加载中模型，LM Studio GGUF 无进程占用。
- NAS 目标卷为 `CACHEDEV3_DATA`，完成时约 `1.9T` 可用、使用率 `37%`。
- Ollama 恢复时先停止 Ollama，将备份的 `ollama/models/` 合并回 `~/.ollama/models/`，再执行 `ollama list` 验证。
- LM Studio 恢复时将备份的 `lmstudio/models/` 合并回 `~/.lmstudio/models/`，再由 LM Studio 扫描模型。
- 恢复前必须备份目标端现有模型目录，禁止无验证覆盖冲突文件。

## 5. 终态

```text
公司 PR NAS 备份：完整
设计文件校验：17/17 PASS
AI 模型校验：15/15 PASS
Studio 可用空间：82 GiB
NAS 服务重启：0
本地未授权额外删除：0
```
