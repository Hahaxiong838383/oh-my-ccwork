"""控制面 FastAPI:租户自助凭据 + 会话签发 + SDK 分发。

审计纪律:日志只记 tenant/provider/指纹/来源 IP,永不记凭据明文;
响应永不回显明文(list 走 fingerprint)。
"""

from __future__ import annotations

import logging
import os
import secrets
import time
from datetime import timedelta
from pathlib import Path

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from .security import PROVIDER_SCHEMAS, TenantStore, fingerprint, load_master_key
from .verify import VERIFIERS, Verifier

logger = logging.getLogger("voice_agent.console")

SESSION_TTL_SECONDS = 2 * 3600


class CredentialsIn(BaseModel):
    provider: str
    credentials: dict[str, str]


class SessionIn(BaseModel):
    participant_name: str = "user"


class TtsIn(BaseModel):
    text: str
    format: str = "mp3"


class TtsPrewarmIn(BaseModel):
    texts: list[str]


def create_app(
    store: TenantStore | None = None,
    verifiers: dict[str, Verifier] | None = None,
    sdk_path: Path | None = None,
) -> FastAPI:
    """依赖显式注入,测试传 tmp store + mock verifier;生产走 env 默认。"""
    if store is None:
        store = TenantStore(
            Path(os.environ.get("TENANT_STORE", "/opt/voice-agent/tenants")),
            load_master_key(),
        )
    active_verifiers = VERIFIERS if verifiers is None else verifiers
    sdk_file = sdk_path or Path(os.environ.get("SDK_DIST", "web/sdk/dist/v1.js"))

    app = FastAPI(title="javis-voice-console", docs_url=None, redoc_url=None)
    # CORS 全放(demo 级):同事从自己域名的页面直调;鉴权走 Bearer header 非 cookie,
    # 无 CSRF 面;正式多租户再收紧 per-tenant origin 白名单
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )

    # 注意:本文件有 `from __future__ import annotations`,注解全是字符串——
    # 路由参数一律用"默认值风格"(= Depends(...)/Header(...)),不用 Annotated 局部别名
    # (FastAPI eval 字符串注解时看不到 create_app 的局部名,会误判成 query 参数)。
    def tenant_of(authorization: str = Header("")) -> str:
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "invalid_token")
        tenant_id = store.authenticate(authorization.removeprefix("Bearer ").strip())
        if tenant_id is None:
            raise HTTPException(401, "invalid_token")
        return tenant_id

    @app.get("/healthz")
    async def healthz() -> dict:
        # ws_url 供 SDK prewarm() 预热信令域 TLS(公开信息:会话创建本就下发)
        out = {"ok": True, "service": "javis-voice-console"}
        ws_url = os.environ.get("LIVEKIT_WS_URL", "")
        if ws_url:
            out["ws_url"] = ws_url
        return out

    @app.post("/v1/credentials")
    async def put_credentials(
        body: CredentialsIn, request: Request, tenant_id: str = Depends(tenant_of)
    ) -> dict:
        if body.provider not in PROVIDER_SCHEMAS:
            raise HTTPException(422, f"未知 provider: {body.provider},支持 {sorted(PROVIDER_SCHEMAS)}")
        # 字段 schema 先行校验(fail fast,不打真服务)
        try:
            required, optional = PROVIDER_SCHEMAS[body.provider]
            missing = [k for k in required if not body.credentials.get(k)]
            if missing:
                raise ValueError(f"缺少必填字段: {missing}")
            unknown = [k for k in body.credentials if k not in required + optional]
            if unknown:
                raise ValueError(f"不认识的字段: {unknown}(支持 {list(required + optional)})")
        except ValueError as e:
            raise HTTPException(422, str(e)) from None
        # 活性校验:真调一次目标服务,无效不落盘
        verifier = active_verifiers.get(body.provider)
        warning = ""
        if verifier is not None:
            ok, detail = await verifier(body.credentials)
            if not ok:
                logger.warning(
                    "credentials rejected tenant=%s provider=%s ip=%s reason=%s",
                    tenant_id, body.provider, request.client.host if request.client else "?", detail,
                )
                raise HTTPException(422, f"活性校验失败: {detail}")
            if detail and "warning" not in detail.lower() and "未开通" in detail:
                warning = detail
        store.put_credentials(tenant_id, body.provider, body.credentials)
        logger.info(
            "credentials stored tenant=%s provider=%s ip=%s fp=%s",
            tenant_id, body.provider,
            request.client.host if request.client else "?",
            fingerprint(body.credentials),
        )
        out = {
            "provider": body.provider,
            "fingerprint": fingerprint(body.credentials),
            "verified": verifier is not None,
        }
        if warning:
            out["warning"] = warning
        return out

    @app.get("/v1/credentials")
    async def get_credentials(tenant_id: str = Depends(tenant_of)) -> list[dict]:
        return store.list_credentials(tenant_id)

    @app.post("/v1/sessions")
    async def create_session(body: SessionIn, tenant_id: str = Depends(tenant_of)) -> dict:
        ws_url = os.environ.get("LIVEKIT_WS_URL", "")
        api_key = os.environ.get("LIVEKIT_API_KEY", "")
        api_secret = os.environ.get("LIVEKIT_API_SECRET", "")
        if not (ws_url and api_key and api_secret):
            raise HTTPException(503, "LiveKit 配置缺失(LIVEKIT_WS_URL/API_KEY/API_SECRET)")
        from livekit import api as lk_api  # 延迟导入:测试无需 livekit

        room = f"t-{tenant_id}-{secrets.token_hex(4)}"
        agent_name = os.environ.get("AGENT_NAME_PREFIX", "javis") + f"-{tenant_id}"
        token = (
            lk_api.AccessToken(api_key, api_secret)
            .with_identity(body.participant_name)
            .with_ttl(timedelta(seconds=SESSION_TTL_SECONDS))
            .with_grants(
                lk_api.VideoGrants(
                    room_join=True, room=room, can_publish=True, can_subscribe=True
                )
            )
            .with_room_config(
                lk_api.RoomConfiguration(
                    agents=[lk_api.RoomAgentDispatch(agent_name=agent_name)]
                )
            )
            .to_jwt()
        )
        # 未配齐 provider 只提示不拦路(联调期少堵路)
        configured = {c["provider"] for c in store.list_credentials(tenant_id)}
        missing = sorted(set(PROVIDER_SCHEMAS) - configured)
        out = {
            "url": ws_url,
            "token": token,
            "room": room,
            "expires_at": time.time() + SESSION_TTL_SECONDS,
        }
        if missing:
            out["warning"] = f"尚未配置 provider: {missing},语音链路可能不完整"
        return out

    @app.post("/v1/tts")
    async def tts_synthesize(body: TtsIn, tenant_id: str = Depends(tenant_of)):
        """TTS-only 场景语音(§四方案 A):文本 → 流式 mp3。

        不开房间不占 worker;按 音色+文本 落盘缓存,命中直接回文件
        (预热过的台词首次播放也近零延迟)。
        """
        from . import tts_service

        text = body.text.strip()
        if not text:
            raise HTTPException(400, "text 不能为空")
        if len(text) > tts_service.MAX_TEXT_LEN:
            raise HTTPException(400, f"text 超长(上限 {tts_service.MAX_TEXT_LEN} 字)")
        if body.format != "mp3":
            raise HTTPException(400, "format 目前仅支持 mp3")
        creds = store.get_credentials(tenant_id, "xfyun_tts")
        if creds is None:
            raise HTTPException(409, "尚未配置 provider: xfyun_tts,先写入 TTS 凭据")

        cache_root = Path(os.environ.get("TTS_CACHE_DIR", "/opt/voice-agent/tts-cache"))
        vcn = creds.get("vcn") or tts_service.DEFAULT_VCN
        target = tts_service.cache_path(cache_root, tenant_id, vcn, text)
        if target.exists():
            logger.info("tts cache hit: tenant=%s len=%d", tenant_id, len(text))
            return FileResponse(target, media_type="audio/mpeg")

        logger.info("tts synthesize: tenant=%s len=%d", tenant_id, len(text))

        async def _stream():
            async with tts_service.tenant_lock(tenant_id):
                async for chunk in tts_service.synthesize_to_cache(creds, text, target):
                    yield chunk

        return StreamingResponse(_stream(), media_type="audio/mpeg")

    @app.post("/v1/tts/prewarm")
    async def tts_prewarm(
        body: TtsPrewarmIn,
        background: BackgroundTasks,
        tenant_id: str = Depends(tenant_of),
    ) -> dict:
        """批量预热(9.8):设备空闲时推台词表,后台逐条预合成入缓存。

        立即返回受理结果;进度看服务日志(tts prewarm done 行)。
        """
        from . import tts_service

        texts = [t.strip() for t in body.texts if t and t.strip()]
        if not texts:
            raise HTTPException(400, "texts 不能为空")
        if len(texts) > 200:
            raise HTTPException(400, "texts 上限 200 条/次")
        too_long = [t for t in texts if len(t) > tts_service.MAX_TEXT_LEN]
        if too_long:
            raise HTTPException(400, f"{len(too_long)} 条超长(上限 {tts_service.MAX_TEXT_LEN} 字)")
        creds = store.get_credentials(tenant_id, "xfyun_tts")
        if creds is None:
            raise HTTPException(409, "尚未配置 provider: xfyun_tts,先写入 TTS 凭据")

        cache_root = Path(os.environ.get("TTS_CACHE_DIR", "/opt/voice-agent/tts-cache"))
        vcn = creds.get("vcn") or tts_service.DEFAULT_VCN
        pending = [
            t for t in texts
            if not tts_service.cache_path(cache_root, tenant_id, vcn, t).exists()
        ]
        if pending:
            background.add_task(
                tts_service.prewarm_texts, creds, pending, cache_root, tenant_id
            )
        logger.info(
            "tts prewarm accepted: tenant=%s total=%d pending=%d",
            tenant_id, len(texts), len(pending),
        )
        return {
            "accepted": len(pending),
            "already_cached": len(texts) - len(pending),
        }

    @app.get("/sdk/v1.js")
    async def sdk() -> FileResponse:
        if not sdk_file.exists():
            raise HTTPException(404, "SDK 尚未构建")
        return FileResponse(
            sdk_file,
            media_type="application/javascript",
            headers={"Cache-Control": "public, max-age=300"},
        )

    @app.exception_handler(HTTPException)
    async def http_exc(request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    return app


__all__ = ["create_app"]
