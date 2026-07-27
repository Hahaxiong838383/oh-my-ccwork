"""控制面(console):租户自助凭据写入 + 会话签发 + SDK 分发。

同事(租户)不经川哥之手把讯飞/大脑 key 写进来:
POST /v1/credentials → 活性校验 → AES-GCM 加密落盘 → 永不回显。
worker 每 job 用 security.TenantStore 读取,改 key 热生效。
"""
