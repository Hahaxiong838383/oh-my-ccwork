"""
agent_outbox 消费者
- 使用 FOR UPDATE SKIP LOCKED 避免并发问题
- 领取时标记 processing，发送后标记 sent
- 失败重试 3 次后进入 dead_letter
- 通过 cc2wechat CLI 发送微信消息
"""

import asyncio
import asyncpg
import subprocess
import json
import os

PG_URL = os.environ.get("PG_URL", "postgresql://cc:ccagent2026@127.0.0.1:5433/cc_agent")


async def claim_one(pool) -> dict | None:
    """原子领取一条 pending 消息（FOR UPDATE SKIP LOCKED 保证幂等）"""
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            UPDATE agent_outbox
            SET status = 'processing', updated_at = now()
            WHERE id = (
                SELECT id FROM agent_outbox
                WHERE status = 'pending'
                   OR (status = 'processing' AND updated_at < now() - interval '5 minutes')
                ORDER BY created_at
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *
        """)
    return dict(row) if row else None


async def mark_sent(pool, msg_id: int):
    """标记消息为已发送"""
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE agent_outbox SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1",
            msg_id
        )


async def mark_retry(pool, msg_id: int, retry_count: int):
    """失败处理：3 次以内回 pending，超出进 dead_letter"""
    async with pool.acquire() as conn:
        if retry_count >= 3:
            await conn.execute(
                "UPDATE agent_outbox SET status = 'dead_letter', updated_at = now() WHERE id = $1",
                msg_id
            )
            print(f"[outbox] #{msg_id} 超过重试上限，已进入 dead_letter")
        else:
            await conn.execute(
                "UPDATE agent_outbox SET status = 'pending', retry_count = $2, updated_at = now() WHERE id = $1",
                msg_id, retry_count + 1
            )


def send_wechat(text: str) -> bool:
    """通过 cc2wechat CLI 发送微信消息"""
    try:
        # 查找 cc2wechat 上下文文件（由 cc2wechat 写入，记录当前微信登录用户）
        ctx_dir = os.path.expanduser("~/.cc2wechat")
        if not os.path.isdir(ctx_dir):
            print("[outbox] ~/.cc2wechat 目录不存在，跳过发送")
            return False

        ctx_files = [
            f for f in os.listdir(ctx_dir)
            if f.startswith("cc2wechat-ctx-") and f.endswith(".json")
        ]
        if not ctx_files:
            print("[outbox] 无微信上下文文件，跳过发送")
            return False

        result = subprocess.run(
            ["npx", "cc2wechat", "--text", text],
            capture_output=True,
            text=True,
            timeout=15,
            cwd=os.path.expanduser("~/mycc")
        )
        if result.returncode != 0:
            print(f"[outbox] cc2wechat 退出码={result.returncode} stderr={result.stderr[:200]}")
        return result.returncode == 0

    except subprocess.TimeoutExpired:
        print("[outbox] 发送超时（15s）")
        return False
    except Exception as e:
        print(f"[outbox] 发送异常: {e}")
        return False


def format_message(payload: dict) -> str:
    """把 outbox payload 格式化为微信消息文本"""
    event_type = payload.get("type", "unknown")

    if event_type == "skill_draft_generated":
        slug = payload.get("slug", "?")
        path = payload.get("path", "?")
        scan = payload.get("scan_status", "?")
        return f"[cc-agent] Skill 草稿已生成\n标题: {slug}\n路径: {path}\n扫描: {scan}"

    elif event_type == "daily_ingest_completed":
        count = payload.get("count", 0)
        return f"[cc-agent] 今日采集完成，共 {count} 条"

    else:
        # 兜底：序列化前 200 字符
        body = json.dumps(payload, ensure_ascii=False)[:200]
        return f"[cc-agent] {event_type}: {body}"


async def process_once(pool) -> bool:
    """领取并处理一条消息，返回 True 表示有消息被处理"""
    msg = await claim_one(pool)
    if not msg:
        return False

    msg_id = msg["id"]
    retry_count = msg.get("retry_count") or 0
    # payload 已经是 dict（asyncpg 自动解析 jsonb）
    payload = msg["payload"] if isinstance(msg["payload"], dict) else json.loads(msg["payload"])

    print(f"[outbox] 处理 #{msg_id} event={msg['event_type']} retry={retry_count}")

    text = format_message(payload)
    ok = send_wechat(text)

    if ok:
        await mark_sent(pool, msg_id)
        print(f"[outbox] #{msg_id} 发送成功")
    else:
        await mark_retry(pool, msg_id, retry_count)
        next_retry = retry_count + 1
        if next_retry <= 3:
            print(f"[outbox] #{msg_id} 发送失败，排队重试（{next_retry}/3）")

    return True


async def main():
    """单次运行：排空所有 pending 消息后退出"""
    pool = await asyncpg.create_pool(PG_URL, min_size=1, max_size=3)
    try:
        processed = 0
        while True:
            has_more = await process_once(pool)
            if not has_more:
                break
            processed += 1

        if processed:
            print(f"[outbox] 本次处理 {processed} 条")
        else:
            print("[outbox] 无待处理消息")
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
