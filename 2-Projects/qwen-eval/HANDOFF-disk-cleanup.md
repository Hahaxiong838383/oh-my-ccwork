# Studio 磁盘清理交接

SSH: `ssh -o IdentitiesOnly=yes -o PubkeyAuthentication=no fu-121@10.9.1.155` 密码 `1234`

## 可清理文件完整清单（总计 ~116GB）

### 1. ~/Downloads/ = 66GB（全部是安装包和旧工程文件，建议全删）

| 文件 | 大小 | 日期 | 建议 |
|------|------|------|------|
| Adobe Photoshop 2025 v26.5.zip | 5.0G | 2024-11-28 | 删 |
| Adobe After Effects 2025 v25.2.zip | 4.0G | 2024-11-28 | 删 |
| Adobe Illustrator 28.2.dmg | 3.4G | 2024-11-28 | 删 |
| Adobe After Effects 2022 v22.3.dmg | 2.7G | 2024-12-02 | 删 |
| 归档(3).zip | 2.3G | 2025-01-14 | 问用户 |
| Photoshop 2022 v23.5.2.dmg | 2.1G | 2024-11-28 | 删 |
| Illustrator 2022 v26.3.1.dmg | 1.5G | 2024-11-28 | 删 |
| Red Giant 2025.4.0.dmg | 1.5G | 2025-05-21 | 删 |
| 剪映 beta dmg | 1.1G | 2025-01-06 | 删 |
| C4D 2025.3 zip | 917M | 2024-11-28 | 删 |
| 3dm/stp/c4d 工程文件多个 | ~3G | 各种 | 问用户 |
| mp4/MOV 视频多个 | ~1.3G | 各种 | 问用户 |

### 2. ~/.ollama/models/ = 34GB（5个模型）

| 模型 | 建议 |
|------|------|
| qwen2.5 | 删（旧版本） |
| qwen3 | 问用户 |
| minicpm-v | 问用户 |
| moondream | 问用户 |
| qwen3-embedding | 问用户 |

命令: `ollama rm qwen2.5 qwen3 minicpm-v moondream qwen3-embedding`

### 3. ~/Library/Containers/ = 11GB

| 应用 | 大小 | 建议 |
|------|------|------|
| Docker | 8.9G | 问用户是否在用 |
| 企业微信 | 1.2G | 缓存可清 |
| QQ | 326M | 缓存可清 |

### 4. ~/Library/Caches/ = 5.8GB

| 缓存 | 大小 | 建议 |
|------|------|------|
| JetBrains | 2.2G | 可删 |
| ms-playwright | 987M | 可删 |
| Cursor ShipIt | 868M | 可删 |
| Trae | 501M | 可删 |
| Jedi | 255M | 可删 |
| cherrystudio-updater | 218M | 可删 |
| pip | 188M | 可删 |
| EpicGames | 172M | 可删 |
| Homebrew | 172M | 可删 |

命令: `rm -rf ~/Library/Caches/JetBrains ~/Library/Caches/ms-playwright ~/Library/Caches/com.todesktop.* ~/Library/Caches/Trae ~/Library/Caches/Jedi ~/Library/Caches/cherrystudio-updater ~/Library/Caches/pip ~/Library/Caches/com.epicgames.*`

### 5. 未探明的 ~275GB

Data 卷 410GB 已用，以上只占 ~135GB。需要 sudo 深挖：
```bash
echo '1234' | sudo -S du -sh /System/Volumes/Data/* 2>/dev/null | sort -rh | head -20
```

## 不能删的

- ~/.cache/huggingface/ (15GB) — 当前在用的 Qwen3.5-27B-4bit 模型
- /opt/homebrew (2.3GB) — Python 3.11 + MLX 等
