# 飞牛个人语音数据备份

在 home-studio 运行 `python3 -B backup.py`。飞牛以服务主人的权限对后台三库和个人大脑三库依次执行 SQLite 在线备份，包括已提交的 WAL 数据。每库独立一致，六库采样时间可有差异。源库只读。签票设备登记库、证书、供应商配置与密钥另行保管。

本机以 AES-256-GCM 加密 SSH 返回的数据流，在内存盘解密、逐库恢复和完整性检查，成功才发布到 `/data/home-studio/archives/realtime-voice-agent/`。恢复验证命令为 `python3 -B backup.py --verify <备份文件>`。密钥在密码库「小可个人语音数据库备份密钥」。该命令用于验证或从单份备份取证，线上数据库保持原样。
